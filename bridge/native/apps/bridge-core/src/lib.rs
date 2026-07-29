use bridge_command::{CommandDispatcher, CommandExecutionObserver, CommandWorker};
use bridge_contract::{
    CommandResultMessage, HelloMessage, SERVER_DATA_QUEUE_CAPACITY, SERVER_PROTOCOL_VERSION,
    SERVER_TRADE_QUEUE_CAPACITY, TerminalDescriptor, TerminalStreamFreshness,
};
use bridge_foundation::{
    BridgeProfilePaths, MT5_WORKER_RELATIVE_PATH, PYTHON_RELATIVE_PATH, resolve_profile_paths,
};
use bridge_runtime_win::RestartPolicy;
use bridge_security_win::CredentialStore;
use bridge_store::{OutboxStore, TerminalBinding};
use bridge_terminal_data::CollectorPolicy;
use bridge_terminal_session::{
    Mt5SessionManager, Mt5SessionSpec, TerminalSessionHandle, TerminalSessionStatus,
};
use bridge_transport::{
    CredentialSource, HelloProvider, InboundEventSink, NativeCommandAdmission, NativeInboundRouter,
    OutboxPump, PriorityMessageQueue, ReleaseAvailableNotification, ServerEndpoints,
    SessionCancellation, SessionConnector, SessionIntervals, SessionRuntime, SessionSupervisor,
    SessionTransition, SupervisorStateSink, TerminalFreshnessProvider, TransportError,
    V3SessionConnector,
};
use bridge_worker_host::{RegistryCommandWorker, WorkerProgram, WorkerRegistry, WorkerRoute};
use futures_util::{FutureExt, future::BoxFuture};
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
const CREDENTIAL_POLL_INTERVAL: Duration = Duration::from_millis(500);
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
        let paths = resolve_profile_paths(root_data_directory, profile_id)
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
}

pub struct ActiveMt5Sessions {
    sessions: BTreeMap<String, ActiveMt5Session>,
    registry: Arc<WorkerRegistry<NamedPipeServer>>,
    latest_release: Mutex<Option<ReleaseAvailableNotification>>,
}

impl ActiveMt5Sessions {
    pub async fn start(
        prepared: Vec<PreparedMt5Session>,
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
                Mt5SessionManager::new(
                    terminal_instance_id.clone(),
                    Arc::clone(&registry),
                    Arc::clone(&store),
                    Arc::clone(&clock),
                )
                .map_err(terminal_session_error)?,
            );
            let handle = match manager.replace(prepared_session.spec).await {
                Ok(handle) => handle,
                Err(error) => {
                    stop_started_sessions(&sessions).await;
                    return Err(terminal_session_error(error));
                }
            };
            sessions.insert(terminal_instance_id, ActiveMt5Session { manager, handle });
        }
        Ok(Arc::new(Self {
            sessions,
            registry,
            latest_release: Mutex::new(None),
        }))
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
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
            .collect()
    }

    pub fn statuses(&self) -> Vec<TerminalSessionStatus> {
        self.sessions
            .values()
            .map(|session| session.handle.status())
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
        self.session_for_route(terminal_instance_id, connection_epoch)?
            .handle
            .request_full_snapshot(stream)
            .map_err(|_| TransportError::from_static_code("terminal_reconciliation_failed"))
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
    transition: Mutex<Option<SessionTransition>>,
}

impl CoreConnectionState {
    pub fn current(&self) -> Result<Option<SessionTransition>, CoreBootstrapError> {
        self.transition
            .lock()
            .map(|transition| *transition)
            .map_err(|_| CoreBootstrapError::new("bridge_connection_state_failed"))
    }
}

impl SupervisorStateSink for CoreConnectionState {
    fn transition(&self, transition: SessionTransition) {
        if let Ok(mut current) = self.transition.lock() {
            *current = Some(transition);
        }
    }
}

pub struct NativeConnectedRuntime {
    active_sessions: Arc<ActiveMt5Sessions>,
    supervisor: SessionSupervisor,
    connection_state: Arc<CoreConnectionState>,
}

impl NativeConnectedRuntime {
    pub async fn start(
        bootstrap: NativeProfileBootstrap,
        endpoints: ServerEndpoints,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, CoreBootstrapError> {
        let NativeProfileBootstrap {
            credential_store,
            mt5_sessions,
            store,
            ..
        } = bootstrap;
        if mt5_sessions.is_empty() {
            return Err(CoreBootstrapError::new("bridge_terminals_invalid"));
        }
        let active_sessions =
            ActiveMt5Sessions::start(mt5_sessions, Arc::clone(&store), Arc::clone(&clock)).await?;
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
            let outbox = Arc::new(OutboxPump::new(store, queue.clone(), Some(terminal_ids)));
            let events: Arc<dyn InboundEventSink> = active_sessions.clone();
            let inbound = Arc::new(
                NativeInboundRouter::new(Arc::clone(&outbox), events)
                    .with_command_admission(command_admission, Arc::clone(&clock))
                    .with_command_dispatcher(command_dispatcher),
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
                clock,
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
                connection_state,
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

    pub async fn run(self, stop: SessionCancellation) -> Result<(), CoreBootstrapError> {
        let server_result = AssertUnwindSafe(self.supervisor.run(stop.clone()))
            .catch_unwind()
            .await;
        stop.cancel();
        let terminal_result = self.active_sessions.stop().await;
        match (server_result, terminal_result) {
            (Err(_), _) => Err(CoreBootstrapError::new("bridge_server_runtime_failed")),
            (Ok(Err(error)), _) => Err(transport_error(error)),
            (Ok(Ok(())), Err(error)) => Err(error),
            (Ok(Ok(())), Ok(())) => Ok(()),
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
