use bridge_command::{
    CommandDispatcher, CommandExecutionObserver, CommandReconciler, CommandWorker,
    ExecutionReconciliationWorker,
};
use bridge_contract::{
    CommandResultMessage, DataRequestMessage, HelloMessage, QuoteRequestMessage,
    SERVER_DATA_QUEUE_CAPACITY, SERVER_PROTOCOL_VERSION, SERVER_TRADE_QUEUE_CAPACITY,
    TerminalDescriptor, TerminalStreamFreshness,
};
use bridge_foundation::{
    BridgeProfilePaths, DEFAULT_PROFILE_ID, MT5_WORKER_RELATIVE_PATH, PYTHON_RELATIVE_PATH,
    resolve_profile_paths, validate_profile_id,
};
use bridge_mt4::{EaIdentity, EaRegistrationHub, EaRegistrationHubHandle};
use bridge_runtime_win::RestartPolicy;
use bridge_security_win::CredentialStore;
use bridge_store::{OutboxStore, TerminalBinding};
use bridge_terminal_data::CollectorPolicy;
use bridge_terminal_session::{
    Mt4SessionHandle, Mt4SessionManager, Mt4SessionSpec, Mt5SessionManager, Mt5SessionSpec,
    TerminalSessionHandle, TerminalSessionStatus,
};
use bridge_transport::{
    CredentialSource, HelloProvider, InboundDataHandler, InboundEventSink, InboundQuoteHandler,
    InboundQuoteResult, NativeCommandAdmission, NativeInboundRouter, OutboxPump,
    PriorityMessageQueue, ReleaseAvailableNotification, ServerEndpoints, SessionCancellation,
    SessionConnector, SessionIntervals, SessionRuntime, SessionSupervisor, SessionTransition,
    SupervisorStateSink, TerminalFreshnessProvider, TransportError, V3SessionConnector,
};
use bridge_worker_host::{
    RegistryCommandWorker, RegistryReconciliationWorker, WorkerProgram, WorkerRegistry, WorkerRoute,
};
use futures_util::{FutureExt, future::BoxFuture};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::Write as _;
use std::fmt::{Display, Formatter};
use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::time::sleep;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};

const WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MT4_ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);
const RECONCILIATION_QUERY_TIMEOUT: Duration = Duration::from_secs(12);
const RECONCILIATION_SETTLE_AFTER: Duration = Duration::from_secs(30);
const RECONCILIATION_INTERVAL: Duration = Duration::from_secs(5);
const RECONCILIATION_BATCH_LIMIT: usize = 100;
const CREDENTIAL_POLL_INTERVAL: Duration = Duration::from_millis(500);
const TERMINAL_BINDING_POLL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_CREDENTIAL_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialState {
    Missing,
    Present,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoreBootstrapError {
    code: String,
}

impl CoreBootstrapError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl Display for CoreBootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for CoreBootstrapError {}

#[derive(Clone)]
pub struct PreparedMt5Session {
    pub binding: TerminalBinding,
    pub spec: Mt5SessionSpec,
}

pub struct NativeProfileBootstrap {
    pub profile_id: String,
    pub paths: BridgeProfilePaths,
    pub credential_state: CredentialState,
    pub credential_store: CredentialStore,
    pub mt5_sessions: Vec<PreparedMt5Session>,
    pub mt4_bindings: Vec<TerminalBinding>,
    pub store: Arc<OutboxStore>,
}

impl NativeProfileBootstrap {
    pub fn load(
        application_directory: impl AsRef<Path>,
        root_data_directory: impl AsRef<Path>,
        profile_id: &str,
    ) -> Result<Self, CoreBootstrapError> {
        let application_directory = require_absolute_directory(application_directory.as_ref())?;
        let profile_id = validate_profile_id(Some(profile_id)).map_err(CoreBootstrapError::new)?;
        let paths = resolve_profile_paths(root_data_directory, &profile_id)
            .map_err(CoreBootstrapError::new)?;
        let credential_store =
            CredentialStore::new(&paths.credential_path).map_err(security_error)?;
        let credential_state = match credential_store.load().map_err(security_error)? {
            Some(_) => CredentialState::Present,
            None => CredentialState::Missing,
        };
        let store =
            Arc::new(OutboxStore::open_or_create(&paths.database_path).map_err(store_error)?);
        let bindings = store.terminal_bindings().map_err(store_error)?;
        let mut mt5_bindings = Vec::new();
        let mut mt4_bindings = Vec::new();
        for binding in bindings {
            match binding.platform.as_str() {
                "mt5" => mt5_bindings.push(binding),
                "mt4" => mt4_bindings.push(binding),
                _ => return Err(CoreBootstrapError::new("bridge_store_binding_invalid")),
            }
        }
        let mt5_sessions = prepare_mt5_sessions(&application_directory, mt5_bindings)?;
        Ok(Self {
            profile_id,
            paths,
            credential_state,
            credential_store,
            mt5_sessions,
            mt4_bindings,
            store,
        })
    }
}

struct ActiveMt5Session {
    manager: Arc<Mt5SessionManager>,
    handle: TerminalSessionHandle,
    data_cache_gate: tokio::sync::Mutex<()>,
}

struct ActiveMt4Session {
    manager: Arc<Mt4SessionManager>,
    handle: Mt4SessionHandle,
    data_cache_gate: tokio::sync::Mutex<()>,
}

#[derive(Clone, Copy)]
enum PreparedDataSession<'a> {
    Mt4(&'a ActiveMt4Session),
    Mt5(&'a ActiveMt5Session),
}

pub struct ActiveMt5Sessions {
    sessions: BTreeMap<String, ActiveMt5Session>,
    mt4_sessions: BTreeMap<String, ActiveMt4Session>,
    mt4_registration: Option<EaRegistrationHubHandle>,
    mt4_registration_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    registry: Arc<WorkerRegistry<NamedPipeServer>>,
    store: Arc<OutboxStore>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    latest_release: Mutex<Option<ReleaseAvailableNotification>>,
}

impl ActiveMt5Sessions {
    pub async fn start(
        prepared: Vec<PreparedMt5Session>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Arc<Self>, CoreBootstrapError> {
        Self::start_all(prepared, Vec::new(), false, store, clock).await
    }

    pub async fn start_all(
        prepared: Vec<PreparedMt5Session>,
        mt4_bindings: Vec<TerminalBinding>,
        accept_mt4_registrations: bool,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Arc<Self>, CoreBootstrapError> {
        let registry = Arc::new(WorkerRegistry::<NamedPipeServer>::new());
        let mut sessions = BTreeMap::new();
        for prepared_session in prepared {
            let terminal_instance_id = prepared_session.spec.route.terminal_instance_id.clone();
            if sessions.contains_key(&terminal_instance_id) {
                stop_started_sessions(&sessions).await;
                return Err(CoreBootstrapError::new("bridge_terminal_duplicate"));
            }
            let manager = Arc::new(
                match Mt5SessionManager::new(
                    terminal_instance_id.clone(),
                    Arc::clone(&registry),
                    Arc::clone(&store),
                    Arc::clone(&clock),
                ) {
                    Ok(manager) => manager,
                    Err(error) => {
                        stop_started_sessions(&sessions).await;
                        return Err(terminal_session_error(error));
                    }
                },
            );
            let handle = match manager.replace(prepared_session.spec).await {
                Ok(handle) => handle,
                Err(error) => {
                    stop_started_sessions(&sessions).await;
                    return Err(terminal_session_error(error));
                }
            };
            sessions.insert(
                terminal_instance_id,
                ActiveMt5Session {
                    manager,
                    handle,
                    data_cache_gate: tokio::sync::Mutex::new(()),
                },
            );
        }
        let mut mt4_sessions = BTreeMap::new();
        let (mt4_registration, mt4_registration_task) = if mt4_bindings.is_empty() {
            (None, None)
        } else {
            let hub_registration = if accept_mt4_registrations {
                match EaRegistrationHub::bind(WORKER_REQUEST_TIMEOUT) {
                    Ok(result) => Some(result),
                    Err(error) => {
                        stop_started_sessions(&sessions).await;
                        return Err(CoreBootstrapError::new(error.code()));
                    }
                }
            } else {
                None
            };
            for binding in mt4_bindings {
                let terminal_instance_id = binding.terminal_instance_id.clone();
                if sessions.contains_key(&terminal_instance_id)
                    || mt4_sessions.contains_key(&terminal_instance_id)
                {
                    stop_started_sessions(&sessions).await;
                    stop_started_mt4_sessions(&mt4_sessions).await;
                    return Err(CoreBootstrapError::new("bridge_terminal_duplicate"));
                }
                let route = WorkerRoute {
                    terminal_instance_id: terminal_instance_id.clone(),
                    platform: "mt4".to_owned(),
                    account_ref: binding.account_ref.clone(),
                    connection_epoch: binding.connection_epoch,
                };
                let registration_rx = if let Some((_, registration)) = &hub_registration {
                    let identity = match EaIdentity::new(
                        &binding.terminal_path,
                        binding.account_ref.broker_server.clone(),
                        binding.account_ref.login.clone(),
                    ) {
                        Ok(identity) => identity,
                        Err(error) => {
                            stop_started_sessions(&sessions).await;
                            stop_started_mt4_sessions(&mt4_sessions).await;
                            return Err(CoreBootstrapError::new(error.code()));
                        }
                    };
                    match registration.subscribe(identity) {
                        Ok(receiver) => receiver,
                        Err(error) => {
                            stop_started_sessions(&sessions).await;
                            stop_started_mt4_sessions(&mt4_sessions).await;
                            return Err(CoreBootstrapError::new(error.code()));
                        }
                    }
                } else {
                    let (sender, receiver) = tokio::sync::mpsc::channel(1);
                    drop(sender);
                    receiver
                };
                let manager = Arc::new(
                    match Mt4SessionManager::new(
                        terminal_instance_id.clone(),
                        Arc::clone(&store),
                        Arc::clone(&clock),
                    ) {
                        Ok(manager) => manager,
                        Err(error) => {
                            stop_started_sessions(&sessions).await;
                            stop_started_mt4_sessions(&mt4_sessions).await;
                            return Err(terminal_session_error(error));
                        }
                    },
                );
                let handle = match manager
                    .replace(
                        Mt4SessionSpec {
                            route,
                            terminal_data_path: binding.terminal_path,
                            accept_timeout: MT4_ACCEPT_TIMEOUT,
                            request_timeout: WORKER_REQUEST_TIMEOUT,
                            collector_policy: CollectorPolicy::default(),
                        },
                        registration_rx,
                    )
                    .await
                {
                    Ok(handle) => handle,
                    Err(error) => {
                        stop_started_sessions(&sessions).await;
                        stop_started_mt4_sessions(&mt4_sessions).await;
                        return Err(terminal_session_error(error));
                    }
                };
                mt4_sessions.insert(
                    terminal_instance_id,
                    ActiveMt4Session {
                        manager,
                        handle,
                        data_cache_gate: tokio::sync::Mutex::new(()),
                    },
                );
            }
            match hub_registration {
                Some((hub, registration)) => {
                    let task = tokio::spawn(hub.run());
                    (Some(registration), Some(task))
                }
                None => (None, None),
            }
        };
        Ok(Arc::new(Self {
            sessions,
            mt4_sessions,
            mt4_registration,
            mt4_registration_task: Mutex::new(mt4_registration_task),
            registry,
            store,
            clock,
            latest_release: Mutex::new(None),
        }))
    }

    pub fn len(&self) -> usize {
        self.sessions.len() + self.mt4_sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.mt4_sessions.is_empty()
    }

    pub fn terminal_descriptors(&self) -> Vec<TerminalDescriptor> {
        self.sessions
            .values()
            .map(|session| TerminalDescriptor {
                terminal_instance_id: session.handle.route().terminal_instance_id.clone(),
                platform: session.handle.route().platform.clone(),
                account_ref: session.handle.route().account_ref.clone(),
                connection_epoch: session.handle.route().connection_epoch,
                worker_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            })
            .chain(
                self.mt4_sessions
                    .values()
                    .map(|session| TerminalDescriptor {
                        terminal_instance_id: session.handle.route().terminal_instance_id.clone(),
                        platform: session.handle.route().platform.clone(),
                        account_ref: session.handle.route().account_ref.clone(),
                        connection_epoch: session.handle.route().connection_epoch,
                        worker_version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                    }),
            )
            .collect()
    }

    pub fn statuses(&self) -> Vec<TerminalSessionStatus> {
        self.sessions
            .values()
            .map(|session| session.handle.status())
            .chain(
                self.mt4_sessions
                    .values()
                    .map(|session| session.handle.status()),
            )
            .collect()
    }

    fn worker_registry(&self) -> Arc<WorkerRegistry<NamedPipeServer>> {
        Arc::clone(&self.registry)
    }

    pub fn latest_release(
        &self,
    ) -> Result<Option<ReleaseAvailableNotification>, CoreBootstrapError> {
        self.latest_release
            .lock()
            .map(|notification| notification.clone())
            .map_err(|_| CoreBootstrapError::new("bridge_release_state_failed"))
    }

    pub async fn stop(&self) -> Result<(), CoreBootstrapError> {
        let mut first_error = None;
        for session in self.sessions.values().rev() {
            if let Err(error) = session.manager.stop().await
                && first_error.is_none()
            {
                first_error = Some(terminal_session_error(error));
            }
        }
        for session in self.mt4_sessions.values().rev() {
            if let Err(error) = session.manager.stop().await
                && first_error.is_none()
            {
                first_error = Some(terminal_session_error(error));
            }
        }
        if let Some(registration) = &self.mt4_registration {
            registration.stop();
        }
        let registration_task = self
            .mt4_registration_task
            .lock()
            .map_err(|_| CoreBootstrapError::new("mt4_registration_state_failed"))?
            .take();
        if let Some(task) = registration_task
            && task.await.is_err()
            && first_error.is_none()
        {
            first_error = Some(CoreBootstrapError::new("mt4_registration_stop_failed"));
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn session_for_route(
        &self,
        terminal_instance_id: &str,
        connection_epoch: i64,
    ) -> Result<&ActiveMt5Session, TransportError> {
        let Some(session) = self.sessions.get(terminal_instance_id) else {
            return Err(TransportError::from_static_code("terminal_not_found"));
        };
        if session.handle.route().connection_epoch != connection_epoch {
            return Err(TransportError::from_static_code(
                "bridge_message_route_mismatch",
            ));
        }
        Ok(session)
    }
}

impl TerminalFreshnessProvider for ActiveMt5Sessions {
    fn snapshot(&self) -> Result<Vec<TerminalStreamFreshness>, TransportError> {
        Ok(self
            .sessions
            .values()
            .map(|session| session.handle.freshness())
            .chain(
                self.mt4_sessions
                    .values()
                    .map(|session| session.handle.freshness()),
            )
            .collect())
    }
}

impl InboundEventSink for ActiveMt5Sessions {
    fn full_snapshot_required(
        &self,
        terminal_instance_id: &str,
        connection_epoch: i64,
        stream: &str,
        _expected_revision: i64,
    ) -> Result<(), TransportError> {
        if let Some(session) = self.mt4_sessions.get(terminal_instance_id) {
            if session.handle.route().connection_epoch != connection_epoch {
                return Err(TransportError::from_static_code(
                    "bridge_message_route_mismatch",
                ));
            }
            session
                .handle
                .request_full_snapshot(stream)
                .map_err(|_| TransportError::from_static_code("terminal_reconciliation_failed"))
        } else {
            self.session_for_route(terminal_instance_id, connection_epoch)?
                .handle
                .request_full_snapshot(stream)
                .map_err(|_| TransportError::from_static_code("terminal_reconciliation_failed"))
        }
    }

    fn release_available(
        &self,
        notification: ReleaseAvailableNotification,
    ) -> Result<(), TransportError> {
        *self
            .latest_release
            .lock()
            .map_err(|_| TransportError::from_static_code("bridge_release_state_failed"))? =
            Some(notification);
        Ok(())
    }
}

impl InboundDataHandler for ActiveMt5Sessions {
    fn handle<'a>(
        &'a self,
        request: &'a DataRequestMessage,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<serde_json::Value, TransportError>> + Send + 'a,
        >,
    > {
        let prepared = (|| {
            if !matches!(
                request.action.as_str(),
                "history"
                    | "rates"
                    | "symbols"
                    | "chart_data"
                    | "symbol_snapshot"
                    | "risk_snapshot"
                    | "performance_daily"
                    | "pending_order_state"
                    | "diagnostics"
            ) {
                return Err(TransportError::from_static_code(
                    "terminal_data_action_unavailable",
                ));
            }
            if let Some(session) = self.mt4_sessions.get(&request.terminal_instance_id) {
                let route = session.handle.route();
                if route.connection_epoch != request.connection_epoch
                    || route.account_ref.login != request.account_ref.login
                    || !route
                        .account_ref
                        .broker_server
                        .eq_ignore_ascii_case(&request.account_ref.broker_server)
                {
                    return Err(TransportError::from_static_code(
                        "bridge_message_route_mismatch",
                    ));
                }
                if matches!(request.action.as_str(), "history" | "chart_data")
                    && request
                        .params
                        .get("force_refresh")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                {
                    session.handle.request_history_refresh();
                }
                return Ok((
                    Arc::clone(&self.store),
                    TerminalDescriptor {
                        terminal_instance_id: route.terminal_instance_id.clone(),
                        platform: route.platform.clone(),
                        account_ref: route.account_ref.clone(),
                        connection_epoch: route.connection_epoch,
                        worker_version: None,
                    },
                    request.params.clone(),
                    request.request_id.clone(),
                    request.action.clone(),
                    PreparedDataSession::Mt4(session),
                ));
            }
            let session =
                self.session_for_route(&request.terminal_instance_id, request.connection_epoch)?;
            let route = session.handle.route();
            if route.account_ref.login != request.account_ref.login
                || !route
                    .account_ref
                    .broker_server
                    .eq_ignore_ascii_case(&request.account_ref.broker_server)
            {
                return Err(TransportError::from_static_code(
                    "bridge_message_route_mismatch",
                ));
            }
            if matches!(request.action.as_str(), "history" | "chart_data")
                && request
                    .params
                    .get("force_refresh")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
            {
                session.handle.request_history_refresh();
            }
            Ok((
                Arc::clone(&self.store),
                TerminalDescriptor {
                    terminal_instance_id: route.terminal_instance_id.clone(),
                    platform: route.platform.clone(),
                    account_ref: route.account_ref.clone(),
                    connection_epoch: route.connection_epoch,
                    worker_version: None,
                },
                request.params.clone(),
                request.request_id.clone(),
                request.action.clone(),
                PreparedDataSession::Mt5(session),
            ))
        })();
        Box::pin(async move {
            let (store, terminal, parameters, request_id, action, session) = prepared?;
            if action == "history" {
                return tokio::task::spawn_blocking(move || {
                    store.read_history_archive_page(&terminal, &parameters)
                })
                .await
                .map_err(|_| TransportError::from_static_code("terminal_data_request_failed"))?
                .map_err(|error| TransportError::from_static_code(error.code()));
            }
            if action == "chart_data" {
                return tokio::task::spawn_blocking(move || {
                    store.read_history_chart_data(&terminal, &parameters)
                })
                .await
                .map_err(|_| TransportError::from_static_code("terminal_data_request_failed"))?
                .map_err(|error| TransportError::from_static_code(error.code()));
            }

            let _gate = match session {
                PreparedDataSession::Mt4(session) => session.data_cache_gate.lock().await,
                PreparedDataSession::Mt5(session) => session.data_cache_gate.lock().await,
            };
            if !data_action_is_cacheable(&action) {
                let result = match session {
                    PreparedDataSession::Mt4(session) => {
                        session
                            .handle
                            .request_data(request_id, action, parameters)
                            .await
                    }
                    PreparedDataSession::Mt5(session) => {
                        session
                            .handle
                            .request_data(request_id, action, parameters)
                            .await
                    }
                };
                return result
                    .map(|result| result.payload)
                    .map_err(|error| TransportError::from_code(error.code().to_owned()));
            }
            let now_utc_msc = (self.clock)();
            if now_utc_msc <= 0 {
                return Err(TransportError::from_static_code(
                    "terminal_data_clock_invalid",
                ));
            }
            let cached_after = now_utc_msc.saturating_sub(data_cache_max_age_msc(&action));
            let cached = {
                let store = Arc::clone(&store);
                let terminal = terminal.clone();
                let action = action.clone();
                let parameters = parameters.clone();
                tokio::task::spawn_blocking(move || {
                    store.read_terminal_data_cache(&terminal, &action, &parameters, cached_after)
                })
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
            };
            if let Some(cached) = cached {
                return Ok(cached.payload);
            }

            let result = match session {
                PreparedDataSession::Mt4(session) => {
                    session
                        .handle
                        .request_data(request_id, action.clone(), parameters.clone())
                        .await
                }
                PreparedDataSession::Mt5(session) => {
                    session
                        .handle
                        .request_data(request_id, action.clone(), parameters.clone())
                        .await
                }
            }
            .map_err(|error| TransportError::from_code(error.code().to_owned()))?;
            let payload = result.payload;
            let persisted_payload = payload.clone();
            let _ = tokio::task::spawn_blocking(move || {
                store.persist_terminal_data_cache(
                    &terminal,
                    &action,
                    &parameters,
                    result.observed_at_utc_msc,
                    now_utc_msc,
                    &persisted_payload,
                )
            })
            .await;
            Ok(payload)
        })
    }
}

impl InboundQuoteHandler for ActiveMt5Sessions {
    fn handle<'a>(
        &'a self,
        request: &'a QuoteRequestMessage,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<InboundQuoteResult, TransportError>>
                + Send
                + 'a,
        >,
    > {
        let prepared = (|| {
            if let Some(session) = self.mt4_sessions.get(&request.terminal_instance_id) {
                let route = session.handle.route();
                validate_quote_route(route, request)?;
                return Ok(PreparedDataSession::Mt4(session));
            }
            let session =
                self.session_for_route(&request.terminal_instance_id, request.connection_epoch)?;
            validate_quote_route(session.handle.route(), request)?;
            Ok(PreparedDataSession::Mt5(session))
        })();
        Box::pin(async move {
            match prepared? {
                PreparedDataSession::Mt4(session) => {
                    let quote = session
                        .handle
                        .request_quote(request.request_id.clone(), request.symbol.clone())
                        .await
                        .map_err(|error| TransportError::from_code(error.code().to_owned()))?;
                    if let Some(error) = quote.error_code {
                        return Err(TransportError::from_code(error));
                    }
                    Ok(InboundQuoteResult {
                        observed_at_utc_msc: quote.observed_at_utc_msc,
                        bid: quote
                            .bid
                            .ok_or_else(|| TransportError::from_static_code("mt4_quote_invalid"))?,
                        ask: quote
                            .ask
                            .ok_or_else(|| TransportError::from_static_code("mt4_quote_invalid"))?,
                        last: None,
                        symbol_trade_mode: quote.symbol_trade_mode,
                        terminal_connected: Some(true),
                        digits: quote.digits,
                        point: quote.point,
                        timezone_offset_minutes: quote.timezone_offset_minutes,
                        clock_status: quote.clock_status,
                    })
                }
                PreparedDataSession::Mt5(session) => {
                    let quote = session
                        .handle
                        .request_quote(request.request_id.clone(), request.symbol.clone())
                        .await
                        .map_err(|error| TransportError::from_code(error.code().to_owned()))?;
                    Ok(InboundQuoteResult {
                        observed_at_utc_msc: quote.observed_at_utc_msc,
                        bid: quote.bid,
                        ask: quote.ask,
                        last: Some(quote.last),
                        symbol_trade_mode: i32::try_from(quote.symbol_trade_mode).ok(),
                        terminal_connected: Some(quote.terminal_connected),
                        digits: Some(i32::from(quote.digits)),
                        point: Some(quote.point),
                        timezone_offset_minutes: Some(i32::from(quote.timezone_offset_minutes)),
                        clock_status: Some(quote.clock_status),
                    })
                }
            }
        })
    }
}

fn validate_quote_route(
    route: &WorkerRoute,
    request: &QuoteRequestMessage,
) -> Result<(), TransportError> {
    if route.connection_epoch != request.connection_epoch
        || route.account_ref.login != request.account_ref.login
        || !route
            .account_ref
            .broker_server
            .eq_ignore_ascii_case(&request.account_ref.broker_server)
    {
        return Err(TransportError::from_static_code(
            "bridge_message_route_mismatch",
        ));
    }
    Ok(())
}

fn data_action_is_cacheable(action: &str) -> bool {
    matches!(action, "rates" | "symbols" | "performance_daily")
}

fn data_cache_max_age_msc(action: &str) -> i64 {
    match action {
        "symbols" => 5 * 60 * 1_000,
        "rates" => 2 * 1_000,
        "performance_daily" => 30 * 1_000,
        _ => 0,
    }
}

impl CommandExecutionObserver for ActiveMt5Sessions {
    fn command_succeeded(&self, result: &CommandResultMessage) {
        if let Ok(session) =
            self.session_for_route(&result.terminal_instance_id, result.connection_epoch)
        {
            let _ = session.handle.wake_after_command();
        }
    }
}

async fn stop_started_sessions(sessions: &BTreeMap<String, ActiveMt5Session>) {
    for session in sessions.values().rev() {
        let _ = session.manager.stop().await;
    }
}

async fn stop_started_mt4_sessions(sessions: &BTreeMap<String, ActiveMt4Session>) {
    for session in sessions.values().rev() {
        let _ = session.manager.stop().await;
    }
}

pub struct ProfileCredentialSource {
    store: CredentialStore,
    fingerprint: Mutex<Option<[u8; 32]>>,
    poll_interval: Duration,
}

impl ProfileCredentialSource {
    pub fn new(store: CredentialStore) -> Result<Self, CoreBootstrapError> {
        let fingerprint = credential_fingerprint(store.credential_path())?;
        Ok(Self {
            store,
            fingerprint: Mutex::new(fingerprint),
            poll_interval: CREDENTIAL_POLL_INTERVAL,
        })
    }

    #[cfg(test)]
    fn with_poll_interval(
        store: CredentialStore,
        poll_interval: Duration,
    ) -> Result<Self, CoreBootstrapError> {
        if poll_interval.is_zero() {
            return Err(CoreBootstrapError::new(
                "bridge_credential_poll_interval_invalid",
            ));
        }
        let mut source = Self::new(store)?;
        source.poll_interval = poll_interval;
        Ok(source)
    }

    fn refresh_fingerprint(&self) -> Result<(), TransportError> {
        let current = credential_fingerprint(self.store.credential_path())
            .map_err(|_| TransportError::from_static_code("bridge_credential_read_failed"))?;
        *self
            .fingerprint
            .lock()
            .map_err(|_| TransportError::from_static_code("bridge_credential_watch_failed"))? =
            current;
        Ok(())
    }
}

pub struct ProfileTerminalBindingSource {
    store: Arc<OutboxStore>,
    fingerprint: Mutex<[u8; 32]>,
    poll_interval: Duration,
}

impl ProfileTerminalBindingSource {
    pub fn new(store: Arc<OutboxStore>) -> Result<Self, CoreBootstrapError> {
        Self::with_poll_interval(store, TERMINAL_BINDING_POLL_INTERVAL)
    }

    fn with_poll_interval(
        store: Arc<OutboxStore>,
        poll_interval: Duration,
    ) -> Result<Self, CoreBootstrapError> {
        if poll_interval.is_zero() {
            return Err(CoreBootstrapError::new(
                "bridge_terminal_binding_watch_invalid",
            ));
        }
        let fingerprint = terminal_binding_fingerprint(&store)?;
        Ok(Self {
            store,
            fingerprint: Mutex::new(fingerprint),
            poll_interval,
        })
    }

    pub async fn changed(&self) -> Result<(), CoreBootstrapError> {
        loop {
            sleep(self.poll_interval).await;
            let current = terminal_binding_fingerprint(&self.store)?;
            let mut observed = self
                .fingerprint
                .lock()
                .map_err(|_| CoreBootstrapError::new("bridge_terminal_binding_watch_failed"))?;
            if *observed != current {
                *observed = current;
                return Ok(());
            }
        }
    }
}

fn terminal_binding_fingerprint(store: &OutboxStore) -> Result<[u8; 32], CoreBootstrapError> {
    let bindings = store.terminal_bindings().map_err(store_error)?;
    let mut digest = Sha256::new();
    for binding in bindings {
        update_binding_fingerprint(&mut digest, &binding.terminal_instance_id);
        update_binding_fingerprint(&mut digest, &binding.platform);
        update_binding_fingerprint(&mut digest, &binding.terminal_path.to_string_lossy());
        update_binding_fingerprint(&mut digest, &binding.account_ref.broker_server);
        update_binding_fingerprint(&mut digest, &binding.account_ref.login);
        digest.update(binding.connection_epoch.to_le_bytes());
        digest.update(binding.updated_at_utc_msc.to_le_bytes());
    }
    Ok(digest.finalize().into())
}

fn update_binding_fingerprint(digest: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    digest.update(bytes.len().to_le_bytes());
    digest.update(bytes);
}

impl CredentialSource for ProfileCredentialSource {
    fn current(&self) -> Result<Option<String>, TransportError> {
        let credential = self
            .store
            .load()
            .map_err(|error| TransportError::from_static_code(error.code()))?;
        self.refresh_fingerprint()?;
        Ok(credential.map(|credential| credential.refresh_token))
    }

    fn changed(&self) -> BoxFuture<'_, Result<(), TransportError>> {
        Box::pin(async move {
            loop {
                sleep(self.poll_interval).await;
                let current =
                    credential_fingerprint(self.store.credential_path()).map_err(|_| {
                        TransportError::from_static_code("bridge_credential_read_failed")
                    })?;
                let mut observed = self.fingerprint.lock().map_err(|_| {
                    TransportError::from_static_code("bridge_credential_watch_failed")
                })?;
                if *observed != current {
                    *observed = current;
                    return Ok(());
                }
            }
        })
    }
}

struct CoreHelloProvider {
    terminals: Vec<TerminalDescriptor>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl HelloProvider for CoreHelloProvider {
    fn hello(&self) -> Result<HelloMessage, TransportError> {
        let now = (self.clock)();
        if now <= 0 {
            return Err(TransportError::from_static_code(
                "bridge_message_timestamp_invalid",
            ));
        }
        let hello = HelloMessage {
            v: SERVER_PROTOCOL_VERSION,
            message_type: "hello".to_owned(),
            message_id: random_id("hello_")?,
            sent_at_utc_msc: now,
            session_id: random_id("session_")?,
            bridge_version: env!("CARGO_PKG_VERSION").to_owned(),
            installation_id: None,
            update_report: None,
            terminals: self.terminals.clone(),
        };
        hello.validate().map_err(TransportError::from_static_code)?;
        Ok(hello)
    }
}

#[derive(Default)]
pub struct CoreConnectionState {
    snapshot: Mutex<Option<(SessionTransition, Option<String>)>>,
}

impl CoreConnectionState {
    pub fn current(&self) -> Result<Option<SessionTransition>, CoreBootstrapError> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.as_ref().map(|value| value.0))
            .map_err(|_| CoreBootstrapError::new("bridge_connection_state_failed"))
    }

    pub fn current_error_code(&self) -> Result<Option<String>, CoreBootstrapError> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.as_ref().and_then(|value| value.1.clone()))
            .map_err(|_| CoreBootstrapError::new("bridge_connection_state_failed"))
    }
}

impl SupervisorStateSink for CoreConnectionState {
    fn transition(&self, transition: SessionTransition) {
        if let Ok(mut current) = self.snapshot.lock() {
            *current = Some((transition, None));
        }
    }

    fn transition_with_error(&self, transition: SessionTransition, error_code: &str) {
        if let Ok(mut current) = self.snapshot.lock() {
            *current = Some((
                transition,
                Some(sanitized_status_code(
                    error_code,
                    "bridge_connection_failed",
                )),
            ));
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ReconciliationStateSnapshot {
    last_run_at_utc_msc: Option<i64>,
    inspected: usize,
    resolved: usize,
    pending: usize,
    error_codes: Vec<String>,
    consecutive_failures: u32,
    fatal_error_code: Option<String>,
}

#[derive(Default)]
struct CoreReconciliationState {
    snapshot: Mutex<ReconciliationStateSnapshot>,
}

impl CoreReconciliationState {
    fn current(&self) -> Result<ReconciliationStateSnapshot, CoreBootstrapError> {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| CoreBootstrapError::new("bridge_reconciliation_state_failed"))
    }

    fn record_run(&self, run: bridge_command::ReconciliationRun, observed_at_utc_msc: i64) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            *snapshot = ReconciliationStateSnapshot {
                last_run_at_utc_msc: Some(observed_at_utc_msc),
                inspected: run.inspected,
                resolved: run.resolved,
                pending: run.pending,
                error_codes: run
                    .error_codes
                    .into_iter()
                    .map(|code| sanitized_status_code(&code, "bridge_reconciliation_failed"))
                    .collect(),
                consecutive_failures: 0,
                fatal_error_code: None,
            };
        }
    }

    fn record_failure(&self, error_code: &str, observed_at_utc_msc: i64) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            snapshot.last_run_at_utc_msc = Some(observed_at_utc_msc);
            snapshot.consecutive_failures = snapshot.consecutive_failures.saturating_add(1);
            snapshot.fatal_error_code = Some(sanitized_status_code(
                error_code,
                "bridge_reconciliation_failed",
            ));
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NativeTerminalRuntimeStatus {
    pub terminal_instance_id: String,
    pub platform: String,
    pub connection_epoch: i64,
    pub state: String,
    pub worker_state: String,
    pub collector_state: String,
    pub data_ready: bool,
    pub worker_consecutive_failures: u32,
    pub collector_consecutive_failures: u32,
    pub last_success_at_utc_msc: Option<i64>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NativeReconciliationRuntimeStatus {
    pub last_run_at_utc_msc: Option<i64>,
    pub inspected: usize,
    pub resolved: usize,
    pub pending: usize,
    pub error_codes: Vec<String>,
    pub consecutive_failures: u32,
    pub fatal_error_code: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NativeRuntimeStatusSnapshot {
    pub schema_version: u32,
    pub bridge_version: String,
    pub profile_id: String,
    pub observed_at_utc_msc: i64,
    pub phase: String,
    pub server_state: String,
    pub server_error_code: Option<String>,
    pub terminals: Vec<NativeTerminalRuntimeStatus>,
    pub reconciliation: NativeReconciliationRuntimeStatus,
}

impl NativeRuntimeStatusSnapshot {
    pub fn inactive(
        profile_id: &str,
        bridge_version: &str,
        observed_at_utc_msc: i64,
        phase: &str,
        server_state: &str,
        error_code: Option<&str>,
    ) -> Result<Self, CoreBootstrapError> {
        if profile_id.is_empty()
            || bridge_version.is_empty()
            || observed_at_utc_msc <= 0
            || !matches!(
                phase,
                "starting" | "pairing_required" | "connecting" | "degraded" | "stopped"
            )
            || !matches!(
                server_state,
                "stopped" | "pairing_required" | "connecting" | "reconnecting"
            )
            || error_code.is_some_and(|code| !valid_status_code(code))
        {
            return Err(CoreBootstrapError::new("bridge_runtime_status_invalid"));
        }
        Ok(Self {
            schema_version: 1,
            bridge_version: bridge_version.to_owned(),
            profile_id: profile_id.to_owned(),
            observed_at_utc_msc,
            phase: phase.to_owned(),
            server_state: server_state.to_owned(),
            server_error_code: error_code.map(str::to_owned),
            terminals: Vec::new(),
            reconciliation: NativeReconciliationRuntimeStatus {
                last_run_at_utc_msc: None,
                inspected: 0,
                resolved: 0,
                pending: 0,
                error_codes: Vec::new(),
                consecutive_failures: 0,
                fatal_error_code: None,
            },
        })
    }
}

fn valid_status_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn sanitized_status_code(value: &str, fallback: &'static str) -> String {
    if valid_status_code(value) {
        value.to_owned()
    } else {
        fallback.to_owned()
    }
}

#[derive(Clone)]
pub struct NativeRuntimeStatusHandle {
    active_sessions: Arc<ActiveMt5Sessions>,
    connection_state: Arc<CoreConnectionState>,
    reconciliation_state: Arc<CoreReconciliationState>,
}

impl NativeRuntimeStatusHandle {
    pub fn snapshot(
        &self,
        profile_id: &str,
        bridge_version: &str,
        observed_at_utc_msc: i64,
    ) -> Result<NativeRuntimeStatusSnapshot, CoreBootstrapError> {
        if profile_id.is_empty() || bridge_version.is_empty() || observed_at_utc_msc <= 0 {
            return Err(CoreBootstrapError::new("bridge_runtime_status_invalid"));
        }
        let connection = self.connection_state.current()?;
        let server_error_code = self.connection_state.current_error_code()?;
        let server_state = connection
            .map(|value| connection_state_name(value.state))
            .unwrap_or("starting")
            .to_owned();
        let terminals = self
            .active_sessions
            .statuses()
            .into_iter()
            .map(|status| NativeTerminalRuntimeStatus {
                terminal_instance_id: status.route.terminal_instance_id,
                platform: status.route.platform,
                connection_epoch: status.route.connection_epoch,
                state: terminal_state_name(status.state).to_owned(),
                worker_state: worker_state_name(status.worker_state).to_owned(),
                collector_state: collector_state_name(status.collector_state).to_owned(),
                data_ready: status.data_ready,
                worker_consecutive_failures: status.worker_consecutive_failures,
                collector_consecutive_failures: status.collector_consecutive_failures,
                last_success_at_utc_msc: status.last_success_at_utc_msc,
                error_code: status
                    .error_code
                    .map(|code| sanitized_status_code(&code, "terminal_runtime_failed")),
            })
            .collect::<Vec<_>>();
        let all_ready = !terminals.is_empty() && terminals.iter().all(|status| status.data_ready);
        let any_degraded = terminals
            .iter()
            .any(|status| matches!(status.state.as_str(), "degraded" | "superseded" | "stopped"));
        let phase = if server_state == "connected" && all_ready {
            "online"
        } else if server_state == "reconnecting" || any_degraded {
            "degraded"
        } else if server_state == "pairing_required" {
            "pairing_required"
        } else if server_state == "stopped"
            && terminals.iter().all(|status| status.state == "stopped")
        {
            "stopped"
        } else {
            "connecting"
        };
        let reconciliation = self.reconciliation_state.current()?;
        Ok(NativeRuntimeStatusSnapshot {
            schema_version: 1,
            bridge_version: bridge_version.to_owned(),
            profile_id: profile_id.to_owned(),
            observed_at_utc_msc,
            phase: phase.to_owned(),
            server_state,
            server_error_code,
            terminals,
            reconciliation: NativeReconciliationRuntimeStatus {
                last_run_at_utc_msc: reconciliation.last_run_at_utc_msc,
                inspected: reconciliation.inspected,
                resolved: reconciliation.resolved,
                pending: reconciliation.pending,
                error_codes: reconciliation.error_codes,
                consecutive_failures: reconciliation.consecutive_failures,
                fatal_error_code: reconciliation.fatal_error_code,
            },
        })
    }
}

fn connection_state_name(state: bridge_transport::ConnectionState) -> &'static str {
    match state {
        bridge_transport::ConnectionState::Stopped => "stopped",
        bridge_transport::ConnectionState::PairingRequired => "pairing_required",
        bridge_transport::ConnectionState::Connecting => "connecting",
        bridge_transport::ConnectionState::Connected => "connected",
        bridge_transport::ConnectionState::Reconnecting => "reconnecting",
    }
}

fn terminal_state_name(state: bridge_terminal_session::TerminalSessionState) -> &'static str {
    match state {
        bridge_terminal_session::TerminalSessionState::Starting => "starting",
        bridge_terminal_session::TerminalSessionState::Ready => "ready",
        bridge_terminal_session::TerminalSessionState::Degraded => "degraded",
        bridge_terminal_session::TerminalSessionState::Superseded => "superseded",
        bridge_terminal_session::TerminalSessionState::Stopped => "stopped",
    }
}

fn worker_state_name(state: bridge_worker_host::WorkerLifecycleState) -> &'static str {
    match state {
        bridge_worker_host::WorkerLifecycleState::Starting => "starting",
        bridge_worker_host::WorkerLifecycleState::Ready => "ready",
        bridge_worker_host::WorkerLifecycleState::Restarting => "restarting",
        bridge_worker_host::WorkerLifecycleState::Superseded => "superseded",
        bridge_worker_host::WorkerLifecycleState::Stopped => "stopped",
    }
}

fn collector_state_name(state: bridge_terminal_data::CollectorLifecycleState) -> &'static str {
    match state {
        bridge_terminal_data::CollectorLifecycleState::Starting => "starting",
        bridge_terminal_data::CollectorLifecycleState::Ready => "ready",
        bridge_terminal_data::CollectorLifecycleState::Retrying => "retrying",
        bridge_terminal_data::CollectorLifecycleState::Stopped => "stopped",
    }
}

pub struct NativeConnectedRuntime {
    active_sessions: Arc<ActiveMt5Sessions>,
    supervisor: SessionSupervisor,
    command_reconciler: Arc<CommandReconciler>,
    reconciliation_state: Arc<CoreReconciliationState>,
    connection_state: Arc<CoreConnectionState>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl NativeConnectedRuntime {
    pub async fn start(
        bootstrap: NativeProfileBootstrap,
        endpoints: ServerEndpoints,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, CoreBootstrapError> {
        let NativeProfileBootstrap {
            profile_id,
            credential_store,
            mt5_sessions,
            mt4_bindings,
            store,
            ..
        } = bootstrap;
        if mt5_sessions.is_empty() && mt4_bindings.is_empty() {
            return Err(CoreBootstrapError::new("bridge_terminals_invalid"));
        }
        let active_sessions = ActiveMt5Sessions::start_all(
            mt5_sessions,
            mt4_bindings,
            profile_id == DEFAULT_PROFILE_ID,
            Arc::clone(&store),
            Arc::clone(&clock),
        )
        .await?;
        match Self::build(active_sessions, credential_store, store, endpoints, clock) {
            Ok(runtime) => Ok(runtime),
            Err((active_sessions, error)) => {
                let _ = active_sessions.stop().await;
                Err(error)
            }
        }
    }

    fn build(
        active_sessions: Arc<ActiveMt5Sessions>,
        credential_store: CredentialStore,
        store: Arc<OutboxStore>,
        endpoints: ServerEndpoints,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, (Arc<ActiveMt5Sessions>, CoreBootstrapError)> {
        let result = (|| {
            let terminal_ids = active_sessions
                .terminal_descriptors()
                .into_iter()
                .map(|terminal| terminal.terminal_instance_id)
                .collect::<Vec<_>>();
            let queue =
                PriorityMessageQueue::new(SERVER_TRADE_QUEUE_CAPACITY, SERVER_DATA_QUEUE_CAPACITY)
                    .map_err(transport_error)?;
            let command_admission = Arc::new(NativeCommandAdmission::default());
            let command_worker: Arc<dyn CommandWorker> = Arc::new(
                RegistryCommandWorker::new(
                    active_sessions.worker_registry(),
                    Arc::clone(&clock),
                    WORKER_REQUEST_TIMEOUT,
                )
                .map_err(|error| CoreBootstrapError::new(error.code()))?,
            );
            let command_dispatcher = Arc::new(
                CommandDispatcher::new(
                    Arc::clone(&store),
                    command_admission.clone(),
                    command_worker,
                    Arc::clone(&clock),
                    WORKER_REQUEST_TIMEOUT,
                )
                .map_err(|error| CoreBootstrapError::new(error.code()))?
                .with_execution_observer(active_sessions.clone()),
            );
            let reconciliation_worker: Arc<dyn ExecutionReconciliationWorker> = Arc::new(
                RegistryReconciliationWorker::new(
                    active_sessions.worker_registry(),
                    Arc::clone(&clock),
                    WORKER_REQUEST_TIMEOUT,
                    RECONCILIATION_SETTLE_AFTER,
                )
                .map_err(|error| CoreBootstrapError::new(error.code()))?,
            );
            let command_reconciler = Arc::new(
                CommandReconciler::new(
                    Arc::clone(&store),
                    reconciliation_worker,
                    RECONCILIATION_QUERY_TIMEOUT,
                )
                .map_err(|error| CoreBootstrapError::new(error.code()))?,
            );
            let reconciliation_state = Arc::new(CoreReconciliationState::default());
            let outbox = Arc::new(OutboxPump::new(store, queue.clone(), Some(terminal_ids)));
            let events: Arc<dyn InboundEventSink> = active_sessions.clone();
            let inbound = Arc::new(
                NativeInboundRouter::new(Arc::clone(&outbox), events)
                    .with_command_admission(command_admission, Arc::clone(&clock))
                    .with_command_dispatcher(command_dispatcher)
                    .with_data_handler(active_sessions.clone())
                    .with_quote_handler(active_sessions.clone()),
            );
            let freshness: Arc<dyn TerminalFreshnessProvider> = active_sessions.clone();
            let session_runtime = Arc::new(
                SessionRuntime::new(
                    queue,
                    outbox,
                    inbound,
                    freshness,
                    Arc::clone(&clock),
                    SessionIntervals::default(),
                )
                .map_err(transport_error)?,
            );
            let hello: Arc<dyn HelloProvider> = Arc::new(CoreHelloProvider {
                terminals: active_sessions.terminal_descriptors(),
                clock: Arc::clone(&clock),
            });
            let connector: Arc<dyn SessionConnector> = Arc::new(
                V3SessionConnector::new(
                    endpoints,
                    concat!("LiangJianBridge/", env!("CARGO_PKG_VERSION")),
                    hello,
                )
                .map_err(transport_error)?,
            );
            let credentials: Arc<dyn CredentialSource> =
                Arc::new(ProfileCredentialSource::new(credential_store)?);
            let connection_state = Arc::new(CoreConnectionState::default());
            let states: Arc<dyn SupervisorStateSink> = connection_state.clone();
            let supervisor =
                SessionSupervisor::new(credentials, connector, session_runtime, states);
            Ok(Self {
                active_sessions: active_sessions.clone(),
                supervisor,
                command_reconciler,
                reconciliation_state,
                connection_state,
                clock,
            })
        })();
        result.map_err(|error| (active_sessions, error))
    }

    pub fn active_sessions(&self) -> Arc<ActiveMt5Sessions> {
        Arc::clone(&self.active_sessions)
    }

    pub fn connection_state(&self) -> Arc<CoreConnectionState> {
        Arc::clone(&self.connection_state)
    }

    pub fn status_handle(&self) -> NativeRuntimeStatusHandle {
        NativeRuntimeStatusHandle {
            active_sessions: Arc::clone(&self.active_sessions),
            connection_state: Arc::clone(&self.connection_state),
            reconciliation_state: Arc::clone(&self.reconciliation_state),
        }
    }

    pub async fn run(self, stop: SessionCancellation) -> Result<(), CoreBootstrapError> {
        let NativeConnectedRuntime {
            active_sessions,
            supervisor,
            command_reconciler,
            reconciliation_state,
            clock,
            ..
        } = self;
        let server_stop = stop.clone();
        let server = async move {
            let result = AssertUnwindSafe(supervisor.run(server_stop.clone()))
                .catch_unwind()
                .await;
            server_stop.cancel();
            result
        };
        let reconciliation_stop = stop.clone();
        let reconciliation = async move {
            let result = AssertUnwindSafe(run_command_reconciliation(
                command_reconciler,
                reconciliation_state,
                clock,
                reconciliation_stop.clone(),
            ))
            .catch_unwind()
            .await;
            reconciliation_stop.cancel();
            result
        };
        let (server_result, reconciliation_result) = tokio::join!(server, reconciliation);
        stop.cancel();
        let terminal_result = active_sessions.stop().await;
        match (server_result, reconciliation_result, terminal_result) {
            (Err(_), _, _) => Err(CoreBootstrapError::new("bridge_server_runtime_failed")),
            (_, Err(_), _) => Err(CoreBootstrapError::new(
                "bridge_command_reconciliation_failed",
            )),
            (Ok(Err(error)), _, _) => Err(transport_error(error)),
            (_, Ok(Err(error)), _) => Err(error),
            (Ok(Ok(())), Ok(Ok(())), Err(error)) => Err(error),
            (Ok(Ok(())), Ok(Ok(())), Ok(())) => Ok(()),
        }
    }
}

async fn run_command_reconciliation(
    reconciler: Arc<CommandReconciler>,
    state: Arc<CoreReconciliationState>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    stop: SessionCancellation,
) -> Result<(), CoreBootstrapError> {
    loop {
        if stop.is_cancelled() {
            return Ok(());
        }
        let run = tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            result = reconciler.reconcile_once(RECONCILIATION_BATCH_LIMIT) => result,
        };
        match run {
            Ok(run) => state.record_run(run, (clock)()),
            Err(error) => {
                state.record_failure(error.code(), (clock)());
                return Err(CoreBootstrapError::new(error.code()));
            }
        }
        tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            _ = sleep(RECONCILIATION_INTERVAL) => {}
        }
    }
}

fn prepare_mt5_sessions(
    application_directory: &Path,
    bindings: Vec<TerminalBinding>,
) -> Result<Vec<PreparedMt5Session>, CoreBootstrapError> {
    if bindings.is_empty() {
        return Ok(Vec::new());
    }
    let python = require_file(
        &application_directory.join(PYTHON_RELATIVE_PATH),
        "mt5_python_runtime_not_found",
    )?;
    let worker = require_file(
        &application_directory.join(MT5_WORKER_RELATIVE_PATH),
        "mt5_worker_script_not_found",
    )?;
    let worker_directory = worker
        .parent()
        .ok_or_else(|| CoreBootstrapError::new("mt5_worker_script_not_found"))?;
    bindings
        .into_iter()
        .map(|binding| {
            let route = WorkerRoute {
                terminal_instance_id: binding.terminal_instance_id.clone(),
                platform: binding.platform.clone(),
                account_ref: binding.account_ref.clone(),
                connection_epoch: binding.connection_epoch,
            };
            route.validate().map_err(worker_error)?;
            let program = WorkerProgram::new(&python, worker_directory)
                .map_err(worker_error)?
                .arg(worker.as_os_str())
                .show_window(false)
                .terminal_path(&binding.terminal_path)
                .map_err(worker_error)?;
            Ok(PreparedMt5Session {
                binding,
                spec: Mt5SessionSpec {
                    route,
                    program,
                    startup_timeout: WORKER_STARTUP_TIMEOUT,
                    request_timeout: WORKER_REQUEST_TIMEOUT,
                    worker_restart_policy: RestartPolicy::default(),
                    collector_policy: CollectorPolicy::default(),
                },
            })
        })
        .collect()
}

fn require_absolute_directory(path: &Path) -> Result<PathBuf, CoreBootstrapError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(CoreBootstrapError::new(
            "bridge_application_directory_invalid",
        ));
    }
    Ok(path.to_path_buf())
}

fn require_file(path: &Path, code: &'static str) -> Result<PathBuf, CoreBootstrapError> {
    if !path.is_absolute() || !path.is_file() {
        return Err(CoreBootstrapError::new(code));
    }
    Ok(path.to_path_buf())
}

fn security_error(error: bridge_security_win::SecurityError) -> CoreBootstrapError {
    CoreBootstrapError::new(error.code())
}

fn store_error(error: bridge_store::StoreError) -> CoreBootstrapError {
    CoreBootstrapError::new(error.code())
}

fn worker_error(error: bridge_worker_host::WorkerHostError) -> CoreBootstrapError {
    CoreBootstrapError::new(error.code())
}

fn terminal_session_error(
    error: bridge_terminal_session::TerminalSessionError,
) -> CoreBootstrapError {
    CoreBootstrapError::new(error.code())
}

fn transport_error(error: TransportError) -> CoreBootstrapError {
    CoreBootstrapError::new(error.code())
}

fn credential_fingerprint(path: &Path) -> Result<Option<[u8; 32]>, CoreBootstrapError> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(path).map_err(|_| CoreBootstrapError::new("bridge_credential_read_failed"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(CoreBootstrapError::new("bridge_credential_read_failed"));
    }
    let bytes =
        fs::read(path).map_err(|_| CoreBootstrapError::new("bridge_credential_read_failed"))?;
    Ok(Some(Sha256::digest(bytes).into()))
}

fn random_id(prefix: &str) -> Result<String, TransportError> {
    let mut bytes = [0_u8; 16];
    // SAFETY: BCryptGenRandom writes exactly the supplied mutable buffer length.
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(TransportError::from_static_code("bridge_random_failed"));
    }
    let mut identifier = String::from(prefix);
    for byte in bytes {
        write!(&mut identifier, "{byte:02x}")
            .map_err(|_| TransportError::from_static_code("bridge_random_failed"))?;
    }
    Ok(identifier)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::{AccountRef, ExecutionEvidence};
    use bridge_security_win::BridgeCredential;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn connection_failure_preserves_only_the_stable_error_code_until_the_next_transition() {
        let state = CoreConnectionState::default();
        SupervisorStateSink::transition_with_error(
            &state,
            SessionTransition {
                state: bridge_transport::ConnectionState::Reconnecting,
                retry_after: Some(Duration::from_secs(2)),
            },
            "bridge_server_unreachable",
        );
        assert_eq!(
            state.current().expect("connection state"),
            Some(SessionTransition {
                state: bridge_transport::ConnectionState::Reconnecting,
                retry_after: Some(Duration::from_secs(2)),
            })
        );
        assert_eq!(
            state.current_error_code().expect("error code").as_deref(),
            Some("bridge_server_unreachable")
        );

        SupervisorStateSink::transition(
            &state,
            SessionTransition {
                state: bridge_transport::ConnectionState::Connecting,
                retry_after: None,
            },
        );
        assert_eq!(state.current_error_code().expect("cleared error"), None);
    }

    #[test]
    fn inactive_runtime_status_is_versioned_and_rejects_unstructured_errors() {
        let status = NativeRuntimeStatusSnapshot::inactive(
            "default",
            "3.0.0",
            1_800_000_000_000,
            "pairing_required",
            "pairing_required",
            None,
        )
        .expect("pairing status");
        let payload = serde_json::to_value(status).expect("status json");
        assert_eq!(payload["schema_version"], 1);
        assert_eq!(payload["phase"], "pairing_required");
        assert_eq!(payload["terminals"].as_array().map(Vec::len), Some(0));
        assert_eq!(
            NativeRuntimeStatusSnapshot::inactive(
                "default",
                "3.0.0",
                1_800_000_000_000,
                "degraded",
                "stopped",
                Some("password=secret")
            )
            .expect_err("unstructured errors are not persisted")
            .code(),
            "bridge_runtime_status_invalid"
        );
    }

    #[test]
    fn fresh_profile_opens_without_requiring_an_mt5_runtime() {
        let root = unique_test_directory("fresh");
        let application = root.join("application");
        let data = root.join("data");
        fs::create_dir_all(&application).expect("application directory");

        let bootstrap =
            NativeProfileBootstrap::load(&application, &data, "default").expect("fresh bootstrap");
        assert_eq!(bootstrap.credential_state, CredentialState::Missing);
        assert!(bootstrap.mt5_sessions.is_empty());
        assert!(bootstrap.mt4_bindings.is_empty());
        assert!(bootstrap.paths.database_path.is_file());
        drop(bootstrap);
        fs::remove_dir_all(root).expect("remove fresh bootstrap fixture");
    }

    #[test]
    fn mt5_bindings_require_packaged_runtime_and_prepare_an_exact_route() {
        let root = unique_test_directory("mt5");
        let application = root.join("application");
        let data = root.join("data");
        let paths = resolve_profile_paths(&data, "default").expect("profile paths");
        let terminal = root.join("terminal64.exe");
        fs::create_dir_all(&application).expect("application directory");
        fs::write(&terminal, b"terminal").expect("terminal fixture");
        let store = OutboxStore::open_or_create(&paths.database_path).expect("seed store");
        let account_ref = AccountRef {
            broker_server: "Broker-Demo".to_owned(),
            login: "123456".to_owned(),
        };
        store
            .activate_terminal_binding(
                "mt5_terminal_01",
                "mt5",
                &terminal,
                &account_ref,
                1_700_000_000_000,
            )
            .expect("seed binding");
        drop(store);

        assert_eq!(
            NativeProfileBootstrap::load(&application, &data, "default")
                .err()
                .expect("missing packaged runtime")
                .code(),
            "mt5_python_runtime_not_found"
        );
        let python = application.join(PYTHON_RELATIVE_PATH);
        let worker = application.join(MT5_WORKER_RELATIVE_PATH);
        fs::create_dir_all(python.parent().expect("python parent")).expect("python directory");
        fs::create_dir_all(worker.parent().expect("worker parent")).expect("worker directory");
        fs::write(&python, b"python").expect("python fixture");
        fs::write(&worker, b"worker").expect("worker fixture");

        let bootstrap = NativeProfileBootstrap::load(&application, &data, "default")
            .expect("configured bootstrap");
        assert_eq!(bootstrap.mt5_sessions.len(), 1);
        let prepared = &bootstrap.mt5_sessions[0];
        assert_eq!(prepared.binding.account_ref, account_ref);
        assert_eq!(prepared.spec.route.terminal_instance_id, "mt5_terminal_01");
        assert_eq!(prepared.spec.route.connection_epoch, 1);
        assert!(bootstrap.mt4_bindings.is_empty());
        drop(bootstrap);
        fs::remove_dir_all(root).expect("remove mt5 bootstrap fixture");
    }

    #[test]
    fn mt4_only_profile_does_not_require_the_mt5_runtime() {
        let root = unique_test_directory("mt4");
        let application = root.join("application");
        let data = root.join("data");
        let paths = resolve_profile_paths(&data, "default").expect("profile paths");
        let terminal = root.join("terminal.exe");
        fs::create_dir_all(&application).expect("application directory");
        fs::write(&terminal, b"terminal").expect("terminal fixture");
        let store = OutboxStore::open_or_create(&paths.database_path).expect("seed store");
        store
            .activate_terminal_binding(
                "mt4_terminal_01",
                "mt4",
                &terminal,
                &AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "654321".to_owned(),
                },
                1_700_000_000_000,
            )
            .expect("seed binding");
        drop(store);

        let bootstrap = NativeProfileBootstrap::load(&application, &data, "default")
            .expect("mt4-only bootstrap");
        assert!(bootstrap.mt5_sessions.is_empty());
        assert_eq!(bootstrap.mt4_bindings.len(), 1);
        assert_eq!(
            bootstrap.mt4_bindings[0].terminal_instance_id,
            "mt4_terminal_01"
        );
        drop(bootstrap);
        fs::remove_dir_all(root).expect("remove mt4 bootstrap fixture");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn active_sessions_route_reconciliation_freshness_release_and_shutdown() {
        let root = unique_test_directory("active");
        let application = root.join("application");
        let data = root.join("data");
        let paths = resolve_profile_paths(&data, "default").expect("profile paths");
        let terminal = root.join("terminal64.exe");
        let python = application.join(PYTHON_RELATIVE_PATH);
        let worker = application.join(MT5_WORKER_RELATIVE_PATH);
        fs::create_dir_all(python.parent().expect("python parent")).expect("python directory");
        fs::create_dir_all(worker.parent().expect("worker parent")).expect("worker directory");
        fs::write(&terminal, b"terminal").expect("terminal fixture");
        fs::write(&python, b"not-an-executable").expect("python fixture");
        fs::write(&worker, b"worker").expect("worker fixture");
        let store = OutboxStore::open_or_create(&paths.database_path).expect("seed store");
        store
            .activate_terminal_binding(
                "mt5_terminal_active_01",
                "mt5",
                &terminal,
                &AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "123456".to_owned(),
                },
                1_700_000_000_000,
            )
            .expect("seed binding");
        drop(store);
        let bootstrap = NativeProfileBootstrap::load(&application, &data, "default")
            .expect("configured bootstrap");
        let NativeProfileBootstrap {
            mt5_sessions,
            store,
            ..
        } = bootstrap;
        let active = ActiveMt5Sessions::start(mt5_sessions, store, Arc::new(|| 1_700_000_000_100))
            .await
            .expect("active sessions");

        assert_eq!(active.len(), 1);
        let descriptors = active.terminal_descriptors();
        assert_eq!(descriptors.len(), 1);
        assert_eq!(
            descriptors[0].terminal_instance_id,
            "mt5_terminal_active_01"
        );
        assert_eq!(
            TerminalFreshnessProvider::snapshot(active.as_ref())
                .expect("freshness")
                .len(),
            1
        );
        assert_eq!(
            InboundEventSink::full_snapshot_required(
                active.as_ref(),
                "mt5_terminal_active_01",
                2,
                "account",
                1,
            )
            .expect_err("epoch mismatch")
            .code(),
            "bridge_message_route_mismatch"
        );
        InboundEventSink::full_snapshot_required(
            active.as_ref(),
            "mt5_terminal_active_01",
            1,
            "orders",
            1,
        )
        .expect("route reconciliation");
        let release = ReleaseAvailableNotification {
            release_id: Some("release_01JACTIVE".to_owned()),
            release_version: "3.0.1".to_owned(),
            rollout_channel: "stable".to_owned(),
            reason: "published".to_owned(),
        };
        InboundEventSink::release_available(active.as_ref(), release.clone())
            .expect("release event");
        assert_eq!(
            active.latest_release().expect("latest release"),
            Some(release)
        );

        let route = &descriptors[0];
        CommandExecutionObserver::command_succeeded(
            active.as_ref(),
            &CommandResultMessage {
                v: 3,
                message_type: "command_result".to_owned(),
                message_id: "result_01JACTIVE01".to_owned(),
                sent_at_utc_msc: 1_700_000_000_101,
                command_id: "command_01JACTIVE01".to_owned(),
                terminal_instance_id: route.terminal_instance_id.clone(),
                account_ref: route.account_ref.clone(),
                connection_epoch: route.connection_epoch,
                status: "succeeded".to_owned(),
                completed_at_utc_msc: 1_700_000_000_101,
                error_code: None,
                error_message: None,
                raw_result: Some(serde_json::json!({})),
                evidence: ExecutionEvidence {
                    observed_at_utc_msc: 1_700_000_000_101,
                    order_tickets: Vec::new(),
                    position_tickets: Vec::new(),
                    deal_tickets: Vec::new(),
                    broker_retcode: Some(10009),
                },
            },
        );

        let connection = Arc::new(CoreConnectionState::default());
        SupervisorStateSink::transition(
            connection.as_ref(),
            SessionTransition {
                state: bridge_transport::ConnectionState::Connected,
                retry_after: None,
            },
        );
        let reconciliation = Arc::new(CoreReconciliationState::default());
        reconciliation.record_run(
            bridge_command::ReconciliationRun {
                inspected: 2,
                resolved: 1,
                pending: 1,
                error_codes: vec!["reconciliation_settlement_pending".to_owned()],
            },
            1_700_000_000_102,
        );
        let runtime_status = NativeRuntimeStatusHandle {
            active_sessions: Arc::clone(&active),
            connection_state: connection,
            reconciliation_state: reconciliation,
        }
        .snapshot("default", "3.0.0", 1_700_000_000_103)
        .expect("runtime status");
        assert_eq!(runtime_status.server_state, "connected");
        assert_eq!(runtime_status.reconciliation.pending, 1);
        assert_eq!(runtime_status.terminals.len(), 1);
        let serialized = serde_json::to_string(&runtime_status).expect("status json");
        assert!(!serialized.contains("Broker-Demo"));
        assert!(!serialized.contains("123456"));

        active.stop().await.expect("stop active sessions");
        assert!(
            active.statuses().iter().all(
                |status| status.state == bridge_terminal_session::TerminalSessionState::Stopped
            )
        );
        assert_eq!(
            InboundEventSink::full_snapshot_required(
                active.as_ref(),
                "mt5_terminal_active_01",
                1,
                "account",
                1,
            )
            .expect_err("stopped collector")
            .code(),
            "terminal_reconciliation_failed"
        );
        drop(active);
        fs::remove_dir_all(root).expect("remove active sessions fixture");
    }

    #[tokio::test]
    async fn mt4_only_profile_advertises_the_bound_terminal_without_claiming_registration() {
        let root = unique_test_directory("mt4-active");
        let terminal_data_path = root.join("terminal-data");
        fs::create_dir_all(&terminal_data_path).expect("terminal data directory");
        let store = Arc::new(
            OutboxStore::open_or_create(root.join("bridge.db")).expect("MT4 active store"),
        );
        let binding = TerminalBinding {
            terminal_instance_id: "mt4_terminal_active_01".to_owned(),
            platform: "mt4".to_owned(),
            terminal_path: terminal_data_path,
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "654321".to_owned(),
            },
            connection_epoch: 4,
            updated_at_utc_msc: 1_700_000_000_000,
        };
        let active = ActiveMt5Sessions::start_all(
            Vec::new(),
            vec![binding],
            false,
            Arc::clone(&store),
            Arc::new(|| 1_700_000_000_100),
        )
        .await
        .expect("MT4-only active sessions");
        assert_eq!(active.len(), 1);
        let descriptors = active.terminal_descriptors();
        assert_eq!(descriptors.len(), 1);
        assert_eq!(
            descriptors[0].terminal_instance_id,
            "mt4_terminal_active_01"
        );
        assert_eq!(descriptors[0].platform, "mt4");
        assert_eq!(descriptors[0].connection_epoch, 4);
        assert_eq!(active.statuses()[0].route.account_ref.login, "654321");
        assert_eq!(
            TerminalFreshnessProvider::snapshot(active.as_ref())
                .expect("freshness")
                .len(),
            1
        );
        active.stop().await.expect("stop MT4-only sessions");
        assert_eq!(
            active.statuses()[0].state,
            bridge_terminal_session::TerminalSessionState::Stopped
        );
        drop(active);
        drop(store);
        fs::remove_dir_all(root).expect("remove MT4 active fixture");
    }

    #[tokio::test]
    async fn credential_source_detects_explicit_pairing_and_logout_changes() {
        let root = unique_test_directory("credential-watch");
        let path = root.join("credential.dat");
        let store = CredentialStore::new(&path).expect("credential store");
        let source =
            ProfileCredentialSource::with_poll_interval(store.clone(), Duration::from_millis(10))
                .expect("credential source");
        assert_eq!(CredentialSource::current(&source).expect("missing"), None);

        let credential = BridgeCredential {
            refresh_token: "r".repeat(64),
            expires_at_utc_msc: 1_900_000_000_000,
        };
        let (_, saved) = tokio::join!(
            async {
                tokio::time::timeout(Duration::from_secs(2), CredentialSource::changed(&source))
                    .await
                    .expect("pairing change timeout")
                    .expect("pairing change")
            },
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                store.save(&credential)
            }
        );
        saved.expect("save credential");
        assert_eq!(
            CredentialSource::current(&source)
                .expect("paired credential")
                .as_deref(),
            Some(credential.refresh_token.as_str())
        );

        let (_, cleared) = tokio::join!(
            async {
                tokio::time::timeout(Duration::from_secs(2), CredentialSource::changed(&source))
                    .await
                    .expect("logout change timeout")
                    .expect("logout change")
            },
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                store.clear()
            }
        );
        cleared.expect("clear credential");
        assert_eq!(
            CredentialSource::current(&source).expect("logged out"),
            None
        );
        fs::remove_dir_all(root).expect("remove credential fixture");
    }

    #[tokio::test]
    async fn terminal_binding_source_detects_account_path_and_epoch_changes() {
        let root = unique_test_directory("binding-watch");
        fs::create_dir_all(&root).expect("binding watch fixture root");
        let paths = resolve_profile_paths(&root, "default").expect("profile paths");
        let first_terminal = root.join("terminal-first64.exe");
        let replacement_terminal = root.join("terminal-replacement64.exe");
        fs::write(&first_terminal, b"first").expect("first terminal");
        fs::write(&replacement_terminal, b"replacement").expect("replacement terminal");
        let store = Arc::new(
            OutboxStore::open_or_create(&paths.database_path).expect("binding watch store"),
        );
        store
            .activate_terminal_binding(
                "mt5_binding_watch_01",
                "mt5",
                &first_terminal,
                &AccountRef {
                    broker_server: "Broker-First".to_owned(),
                    login: "111111".to_owned(),
                },
                1_700_000_000_000,
            )
            .expect("first binding");
        let source = ProfileTerminalBindingSource::with_poll_interval(
            Arc::clone(&store),
            Duration::from_millis(10),
        )
        .expect("binding source");
        assert!(
            tokio::time::timeout(Duration::from_millis(40), source.changed())
                .await
                .is_err(),
            "an unchanged binding must not request a runtime reload"
        );

        let (_, replacement) = tokio::join!(
            async {
                tokio::time::timeout(Duration::from_secs(2), source.changed())
                    .await
                    .expect("binding change timeout")
                    .expect("binding change")
            },
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                store.activate_terminal_binding(
                    "mt5_binding_watch_01",
                    "mt5",
                    &replacement_terminal,
                    &AccountRef {
                        broker_server: "Broker-Replacement".to_owned(),
                        login: "222222".to_owned(),
                    },
                    1_700_000_000_100,
                )
            }
        );
        assert_eq!(
            replacement.expect("replacement binding").connection_epoch,
            2
        );
        drop(source);
        drop(store);
        fs::remove_dir_all(root).expect("remove binding watch fixture");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn connected_runtime_cancellation_stops_server_and_every_terminal_session() {
        let root = unique_test_directory("connected-stop");
        let bootstrap = configured_mt5_bootstrap(&root, "connected");
        let runtime = NativeConnectedRuntime::start(
            bootstrap,
            ServerEndpoints::from_server_url("http://127.0.0.1:9").expect("loopback endpoints"),
            Arc::new(|| 1_700_000_000_100),
        )
        .await
        .expect("connected runtime");
        let active = runtime.active_sessions();
        let state = runtime.connection_state();
        let stop = SessionCancellation::default();
        stop.cancel();
        runtime.run(stop).await.expect("coordinated stop");
        assert!(
            active.statuses().iter().all(
                |status| status.state == bridge_terminal_session::TerminalSessionState::Stopped
            )
        );
        assert_eq!(
            state
                .current()
                .expect("connection state")
                .map(|value| value.state),
            Some(bridge_transport::ConnectionState::Stopped)
        );
        drop(active);
        drop(state);
        fs::remove_dir_all(root).expect("remove connected runtime fixture");
    }

    fn configured_mt5_bootstrap(root: &Path, suffix: &str) -> NativeProfileBootstrap {
        let application = root.join("application");
        let data = root.join("data");
        let paths = resolve_profile_paths(&data, "default").expect("profile paths");
        let terminal = root.join("terminal64.exe");
        let python = application.join(PYTHON_RELATIVE_PATH);
        let worker = application.join(MT5_WORKER_RELATIVE_PATH);
        fs::create_dir_all(python.parent().expect("python parent")).expect("python directory");
        fs::create_dir_all(worker.parent().expect("worker parent")).expect("worker directory");
        fs::write(&terminal, b"terminal").expect("terminal fixture");
        fs::write(&python, b"not-an-executable").expect("python fixture");
        fs::write(&worker, b"worker").expect("worker fixture");
        let store = OutboxStore::open_or_create(&paths.database_path).expect("seed store");
        store
            .activate_terminal_binding(
                &format!("mt5_terminal_{suffix}_01"),
                "mt5",
                &terminal,
                &AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "123456".to_owned(),
                },
                1_700_000_000_000,
            )
            .expect("seed binding");
        drop(store);
        NativeProfileBootstrap::load(&application, &data, "default").expect("configured bootstrap")
    }

    fn unique_test_directory(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-core-{label}-{}-{stamp}",
            std::process::id()
        ))
    }
}
