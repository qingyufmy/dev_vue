use bridge_contract::{CommandMessage, CommandResultMessage, TerminalStreamFreshness};
use bridge_mt4::{
    Mt4EaSnapshotSource, Mt4SnapshotSourceSpec, command_from_bridge, rejected_bridge_result,
    result_to_bridge,
};
use bridge_runtime_win::RestartPolicy;
use bridge_store::{
    AccountInitializationState, HISTORY_COVERAGE_START_UTC_MSC, HistoryArchiveBatch, HistoryCursor,
    HistoryJobPlanningRequest, HistoryScope, HistorySyncJob, OutboxStore,
};
use bridge_terminal_data::{
    CollectorHandle, CollectorLifecycleState, CollectorPolicy, SnapshotCollector, SnapshotProjector,
};
use bridge_worker_host::{
    WorkerCapability, WorkerDataResult, WorkerDataRouter, WorkerHistoryCursor, WorkerHostError,
    WorkerLifecycleState, WorkerProgram, WorkerRegistry, WorkerRole, WorkerRoute, WorkerSupervisor,
    WorkerSupervisorHandle,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::{Mutex, Notify, Semaphore, mpsc, watch};
use tokio::task::JoinHandle;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const HISTORY_BATCH_LIMIT: u16 = 250;
const HISTORY_LEASE: Duration = Duration::from_secs(30);
const HISTORY_ARCHIVE_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const HISTORY_ARCHIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const HISTORY_EMPTY_RETRY: Duration = Duration::from_secs(1);
const HISTORY_INITIAL_WINDOW_MSC: i64 = 24 * 60 * 60 * 1_000;
const HISTORY_MIN_WINDOW_MSC: i64 = 15 * 60 * 1_000;
const HISTORY_MAX_WINDOW_MSC: i64 = 30 * 24 * 60 * 60 * 1_000;
const HISTORY_DENSE_RETRY_THRESHOLD: u32 = 3;
const HISTORY_CALL_WAIT: Duration = Duration::from_millis(100);
const HISTORY_ACTIVE_DELAY: Duration = Duration::from_millis(50);
const HISTORY_ACTIVE_LEASE_RENEW: Duration = Duration::from_secs(10);
const HISTORY_RETRY_MINIMUM: Duration = Duration::from_secs(2);
const HISTORY_RETRY_MAXIMUM: Duration = Duration::from_secs(30);
const HISTORY_COMPLETE_INTERVAL: Duration = Duration::from_secs(30);
const HISTORY_HOUR_MSC: i64 = 60 * 60 * 1_000;
const HISTORY_RECENT_MSC: i64 = 7 * 24 * HISTORY_HOUR_MSC;
const INITIALIZATION_SCHEMA_VERSION: i64 = 1;

static HISTORY_CALL_BUDGET: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn history_call_budget() -> Arc<Semaphore> {
    Arc::clone(HISTORY_CALL_BUDGET.get_or_init(|| Arc::new(Semaphore::new(1))))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalSessionError {
    code: String,
}

impl TerminalSessionError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl Display for TerminalSessionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for TerminalSessionError {}

#[derive(Clone)]
pub struct Mt5SessionSpec {
    pub route: WorkerRoute,
    pub program: WorkerProgram,
    pub startup_timeout: Duration,
    pub request_timeout: Duration,
    pub worker_restart_policy: RestartPolicy,
    pub collector_policy: CollectorPolicy,
}

pub struct Mt4SessionSpec {
    pub route: WorkerRoute,
    pub terminal_data_path: std::path::PathBuf,
    pub accept_timeout: Duration,
    pub request_timeout: Duration,
    pub collector_policy: CollectorPolicy,
}

impl Mt4SessionSpec {
    fn validate(&self, terminal_instance_id: &str) -> Result<(), TerminalSessionError> {
        self.route.validate().map_err(worker_error)?;
        if self.route.platform != "mt4"
            || self.route.terminal_instance_id != terminal_instance_id
            || self.accept_timeout.is_zero()
            || self.request_timeout.is_zero()
        {
            return Err(TerminalSessionError::new("terminal_session_spec_invalid"));
        }
        self.collector_policy.validate().map_err(projection_error)
    }
}

impl Mt5SessionSpec {
    fn validate(&self, terminal_instance_id: &str) -> Result<(), TerminalSessionError> {
        self.route.validate().map_err(worker_error)?;
        if self.route.platform != "mt5"
            || self.route.terminal_instance_id != terminal_instance_id
            || self.startup_timeout.is_zero()
            || self.request_timeout.is_zero()
        {
            return Err(TerminalSessionError::new("terminal_session_spec_invalid"));
        }
        self.worker_restart_policy
            .validate()
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        self.collector_policy.validate().map_err(projection_error)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalSessionState {
    Starting,
    Ready,
    Degraded,
    Superseded,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistorySyncState {
    NotStarted,
    SyncingRecent,
    Partial,
    Backfilling,
    Starting,
    Ready,
    Retrying,
    Paused,
    Blocked,
    Complete,
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistorySyncStatus {
    pub state: HistorySyncState,
    pub consecutive_failures: u32,
    pub last_success_at_utc_msc: Option<i64>,
    pub error_code: Option<String>,
}

impl Default for HistorySyncStatus {
    fn default() -> Self {
        Self {
            state: HistorySyncState::NotStarted,
            consecutive_failures: 0,
            last_success_at_utc_msc: None,
            error_code: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalSessionStatus {
    pub route: WorkerRoute,
    pub state: TerminalSessionState,
    pub worker_state: WorkerLifecycleState,
    pub collector_state: CollectorLifecycleState,
    pub data_ready: bool,
    pub worker_consecutive_failures: u32,
    pub collector_consecutive_failures: u32,
    pub last_success_at_utc_msc: Option<i64>,
    pub error_code: Option<String>,
    pub history: HistorySyncStatus,
    pub mt4_expert_restart_required: bool,
}

#[derive(Clone)]
pub struct TerminalSessionHandle {
    route: WorkerRoute,
    worker: WorkerSupervisorHandle,
    data: Arc<WorkerDataRouter<NamedPipeServer>>,
    collector: CollectorHandle,
    history: HistorySyncHandle,
    store: Weak<OutboxStore>,
}

#[derive(Clone)]
pub struct Mt4SessionHandle {
    route: WorkerRoute,
    source: Arc<Mt4EaSnapshotSource>,
    collector: CollectorHandle,
    history: HistorySyncHandle,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    command_sequence: Arc<AtomicU64>,
}

impl Mt4SessionHandle {
    pub fn route(&self) -> &WorkerRoute {
        &self.route
    }

    pub fn status(&self) -> TerminalSessionStatus {
        let collector = self.collector.status();
        let data_ready = collector.state == CollectorLifecycleState::Ready;
        let worker_state = match collector.state {
            CollectorLifecycleState::Starting => WorkerLifecycleState::Starting,
            CollectorLifecycleState::Ready => WorkerLifecycleState::Ready,
            CollectorLifecycleState::Retrying => WorkerLifecycleState::Restarting,
            CollectorLifecycleState::Stopped => WorkerLifecycleState::Stopped,
        };
        let state = match collector.state {
            CollectorLifecycleState::Starting => TerminalSessionState::Starting,
            CollectorLifecycleState::Ready => TerminalSessionState::Ready,
            CollectorLifecycleState::Retrying => TerminalSessionState::Degraded,
            CollectorLifecycleState::Stopped => TerminalSessionState::Stopped,
        };
        TerminalSessionStatus {
            route: self.route.clone(),
            state,
            worker_state,
            collector_state: collector.state,
            data_ready,
            worker_consecutive_failures: collector.consecutive_failures,
            collector_consecutive_failures: collector.consecutive_failures,
            last_success_at_utc_msc: collector.last_success_at_utc_msc,
            error_code: collector.error_code,
            history: self.history.status(),
            mt4_expert_restart_required: self.source.adapter_requires_restart(),
        }
    }

    pub fn request_full_snapshot(&self, stream: &str) -> Result<(), TerminalSessionError> {
        self.collector
            .request_full_snapshot(stream)
            .map_err(projection_error)
    }

    pub async fn request_data(
        &self,
        request_id: String,
        action: String,
        params: serde_json::Value,
    ) -> Result<WorkerDataResult, TerminalSessionError> {
        self.source
            .request_data(request_id, action, params)
            .await
            .map_err(worker_error)
    }

    pub async fn request_quote(
        &self,
        request_id: String,
        symbol: String,
    ) -> Result<bridge_mt4::Quote, TerminalSessionError> {
        self.source
            .request_quote(request_id, symbol)
            .await
            .map_err(|error| TerminalSessionError::new(error.code()))
    }

    pub async fn execute_command(
        &self,
        command: CommandMessage,
    ) -> Result<CommandResultMessage, TerminalSessionError> {
        if !self.route.matches(&WorkerRoute {
            terminal_instance_id: command.terminal_instance_id.clone(),
            platform: "mt4".to_owned(),
            account_ref: command.account_ref.clone(),
            connection_epoch: command.connection_epoch,
        }) {
            return Err(TerminalSessionError::new("command_route_mismatch"));
        }
        let now = (self.clock)();
        if now <= 0 {
            return Err(TerminalSessionError::new("terminal_session_clock_invalid"));
        }
        let sequence = self.command_sequence.fetch_add(1, Ordering::Relaxed);
        let message_id = format!("result_mt4_{now:x}_{sequence:x}");
        let local = match command_from_bridge(&command) {
            Ok(local) => local,
            Err(error) => {
                let rejected = rejected_bridge_result(&command, now, message_id, error.code());
                rejected
                    .validate()
                    .map_err(|_| TerminalSessionError::new("mt4_command_result_invalid"))?;
                return Ok(rejected);
            }
        };
        let result = self
            .source
            .execute_trade(local)
            .await
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        result_to_bridge(&command, result, message_id)
            .map_err(|error| TerminalSessionError::new(error.code()))
    }

    pub fn wake_after_command(&self) -> Result<(), TerminalSessionError> {
        self.collector.wake().map_err(projection_error)?;
        self.history.wake();
        Ok(())
    }

    pub fn request_history_refresh(&self) {
        self.history.wake();
    }

    pub fn freshness(&self) -> TerminalStreamFreshness {
        let streams = self
            .collector
            .status()
            .last_success_at_utc_msc
            .filter(|observed| *observed > 0)
            .map(|observed| {
                ["account", "positions", "orders"]
                    .into_iter()
                    .map(|stream| (stream.to_owned(), observed))
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        TerminalStreamFreshness {
            terminal_instance_id: self.route.terminal_instance_id.clone(),
            connection_epoch: self.route.connection_epoch,
            streams,
        }
    }
}

impl TerminalSessionHandle {
    pub fn route(&self) -> &WorkerRoute {
        &self.route
    }

    pub fn status(&self) -> TerminalSessionStatus {
        let worker = self.worker.status();
        let collector = self.collector.status();
        let data_ready = worker.state == WorkerLifecycleState::Ready
            && collector.state == CollectorLifecycleState::Ready;
        let state = if data_ready {
            TerminalSessionState::Ready
        } else if worker.state == WorkerLifecycleState::Superseded {
            TerminalSessionState::Superseded
        } else if worker.state == WorkerLifecycleState::Stopped
            && collector.state == CollectorLifecycleState::Stopped
        {
            TerminalSessionState::Stopped
        } else if worker.state == WorkerLifecycleState::Restarting
            || collector.state == CollectorLifecycleState::Retrying
            || worker.state == WorkerLifecycleState::Stopped
        {
            TerminalSessionState::Degraded
        } else {
            TerminalSessionState::Starting
        };
        TerminalSessionStatus {
            route: self.route.clone(),
            state,
            worker_state: worker.state,
            collector_state: collector.state,
            data_ready,
            worker_consecutive_failures: worker.consecutive_failures,
            collector_consecutive_failures: collector.consecutive_failures,
            last_success_at_utc_msc: collector.last_success_at_utc_msc,
            // Prefer the worker's own lifecycle/error signal. The collector can only observe the
            // resulting registry/channel failure and would otherwise hide the actionable worker
            // code with a generic `worker_registry_not_ready` error. Readiness remains fenced by
            // both states, so this ordering does not make a failed worker usable.
            error_code: preferred_terminal_error(worker.error_code, collector.error_code),
            history: self.history.status(),
            mt4_expert_restart_required: false,
        }
    }

    pub fn wake_after_command(&self) -> Result<(), TerminalSessionError> {
        self.collector.wake().map_err(projection_error)
    }

    pub fn request_full_snapshot(&self, stream: &str) -> Result<(), TerminalSessionError> {
        self.collector
            .request_full_snapshot(stream)
            .map_err(projection_error)
    }

    pub fn request_history_refresh(&self) {
        self.history.wake();
    }

    /// Queue a bounded, high-priority history range without waiting for the native worker.
    /// The scheduler claims it at the next batch boundary, ahead of P2/P3 jobs.
    pub fn request_history_range(
        &self,
        range_start_utc_msc: i64,
        range_end_utc_msc: i64,
        now_utc_msc: i64,
    ) -> Result<(), TerminalSessionError> {
        self.plan_requested_history_range(range_start_utc_msc, range_end_utc_msc, now_utc_msc, "p1")
    }

    /// Explicitly request a lower-priority P3 archive range.  This method is
    /// never called by automatic scheduler paths.
    pub fn request_history_archive_range(
        &self,
        range_start_utc_msc: i64,
        range_end_utc_msc: i64,
        now_utc_msc: i64,
    ) -> Result<(), TerminalSessionError> {
        self.plan_requested_history_range(range_start_utc_msc, range_end_utc_msc, now_utc_msc, "p3")
    }

    fn plan_requested_history_range(
        &self,
        range_start_utc_msc: i64,
        range_end_utc_msc: i64,
        now_utc_msc: i64,
        priority: &str,
    ) -> Result<(), TerminalSessionError> {
        if now_utc_msc <= 0 || range_start_utc_msc <= 0 || range_end_utc_msc <= range_start_utc_msc
        {
            return Err(TerminalSessionError::new("terminal_history_range_invalid"));
        }
        let scope = HistoryScope::new(&self.route.terminal_instance_id, &self.route.account_ref)
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        let request = HistoryJobPlanningRequest {
            scope,
            job_kind: "on_demand".to_owned(),
            priority: priority.to_owned(),
            range_start_utc_msc,
            range_end_utc_msc,
            window_msc: HISTORY_INITIAL_WINDOW_MSC,
            now_utc_msc,
        };
        self.store
            .upgrade()
            .ok_or_else(|| TerminalSessionError::new("terminal_store_unavailable"))?
            .plan_history_jobs(&request)
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        self.history.wake();
        Ok(())
    }

    pub async fn request_data(
        &self,
        request_id: String,
        action: String,
        params: serde_json::Value,
    ) -> Result<WorkerDataResult, TerminalSessionError> {
        self.data
            .data(self.route.clone(), request_id, action, params)
            .await
            .map_err(worker_error)
    }

    pub async fn request_quote(
        &self,
        request_id: String,
        symbol: String,
    ) -> Result<bridge_worker_host::TerminalQuote, TerminalSessionError> {
        self.data
            .quote(self.route.clone(), request_id, symbol)
            .await
            .map_err(worker_error)
    }

    pub fn freshness(&self) -> TerminalStreamFreshness {
        let status = self.collector.status();
        let streams = status
            .last_success_at_utc_msc
            .filter(|observed| *observed > 0)
            .map(|observed| {
                ["account", "positions", "orders"]
                    .into_iter()
                    .map(|stream| (stream.to_owned(), observed))
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        TerminalStreamFreshness {
            terminal_instance_id: self.route.terminal_instance_id.clone(),
            connection_epoch: self.route.connection_epoch,
            streams,
        }
    }
}

pub struct Mt5SessionManager {
    terminal_instance_id: String,
    live_registry: Arc<WorkerRegistry<NamedPipeServer>>,
    archive_registry: Arc<WorkerRegistry<NamedPipeServer>>,
    store: Arc<OutboxStore>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    current: Mutex<Option<RunningSession>>,
}

pub struct Mt4SessionManager {
    terminal_instance_id: String,
    store: Arc<OutboxStore>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    current: Mutex<Option<RunningMt4Session>>,
}

impl Mt4SessionManager {
    pub fn new(
        terminal_instance_id: String,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        if terminal_instance_id.trim() != terminal_instance_id || terminal_instance_id.is_empty() {
            return Err(TerminalSessionError::new("terminal_session_id_invalid"));
        }
        Ok(Self {
            terminal_instance_id,
            store,
            clock,
            current: Mutex::new(None),
        })
    }

    pub async fn replace(
        &self,
        spec: Mt4SessionSpec,
        registration_rx: mpsc::Receiver<bridge_mt4::EaConnection>,
    ) -> Result<Mt4SessionHandle, TerminalSessionError> {
        spec.validate(&self.terminal_instance_id)?;
        let mut current = self.current.lock().await;
        if let Some(active) = current.as_ref() {
            validate_transition(active.handle.route(), &spec.route)?;
        }
        if let Some(active) = current.take() {
            active.stop().await?;
        }
        let active = RunningMt4Session::start(
            spec,
            registration_rx,
            Arc::clone(&self.store),
            Arc::clone(&self.clock),
        )?;
        let handle = active.handle.clone();
        *current = Some(active);
        Ok(handle)
    }

    pub async fn stop(&self) -> Result<(), TerminalSessionError> {
        let mut current = self.current.lock().await;
        if let Some(active) = current.take() {
            active.stop().await?;
        }
        Ok(())
    }
}

impl Mt5SessionManager {
    /// Compatibility constructor for callers that predate the archive worker split.
    /// New runtimes should use [`Mt5SessionManager::with_registries`] so the live and
    /// archive worker namespaces are physically isolated.
    pub fn new(
        terminal_instance_id: String,
        live_registry: Arc<WorkerRegistry<NamedPipeServer>>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        Self::with_registries(
            terminal_instance_id,
            live_registry,
            Arc::new(WorkerRegistry::new()),
            store,
            clock,
        )
    }

    pub fn with_registries(
        terminal_instance_id: String,
        live_registry: Arc<WorkerRegistry<NamedPipeServer>>,
        archive_registry: Arc<WorkerRegistry<NamedPipeServer>>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        if terminal_instance_id.trim() != terminal_instance_id || terminal_instance_id.is_empty() {
            return Err(TerminalSessionError::new("terminal_session_id_invalid"));
        }
        Ok(Self {
            terminal_instance_id,
            live_registry,
            archive_registry,
            store,
            clock,
            current: Mutex::new(None),
        })
    }

    pub async fn replace(
        &self,
        spec: Mt5SessionSpec,
    ) -> Result<TerminalSessionHandle, TerminalSessionError> {
        spec.validate(&self.terminal_instance_id)?;
        let mut current = self.current.lock().await;
        if let Some(active) = current.as_ref() {
            validate_transition(&active.handle.route, &spec.route)?;
            if !same_account(&active.handle.route, &spec.route) {
                supersede_account_scope(&self.store, &active.handle.route, (self.clock)())?;
            }
        }
        if let Some(active) = current.take() {
            active.stop().await?;
        }
        let active = RunningSession::start(
            spec,
            Arc::clone(&self.live_registry),
            Arc::clone(&self.archive_registry),
            Arc::clone(&self.store),
            Arc::clone(&self.clock),
        )?;
        let handle = active.handle.clone();
        *current = Some(active);
        Ok(handle)
    }

    pub async fn stop(&self) -> Result<(), TerminalSessionError> {
        let mut current = self.current.lock().await;
        if let Some(active) = current.take() {
            active.stop().await?;
        }
        Ok(())
    }

    pub async fn current_status(&self) -> Option<TerminalSessionStatus> {
        self.current
            .lock()
            .await
            .as_ref()
            .map(|active| active.handle.status())
    }
}

fn validate_transition(
    current: &WorkerRoute,
    replacement: &WorkerRoute,
) -> Result<(), TerminalSessionError> {
    if current.terminal_instance_id != replacement.terminal_instance_id {
        return Err(TerminalSessionError::new("terminal_session_route_mismatch"));
    }
    if !current.matches(replacement) && replacement.connection_epoch <= current.connection_epoch {
        return Err(TerminalSessionError::new(
            "terminal_session_epoch_not_advanced",
        ));
    }
    Ok(())
}

struct RunningSession {
    handle: TerminalSessionHandle,
    worker_task: JoinHandle<Result<(), WorkerHostError>>,
    collector_task: JoinHandle<()>,
    history_task: JoinHandle<()>,
    initialization_task: JoinHandle<()>,
}

impl RunningSession {
    fn start(
        spec: Mt5SessionSpec,
        live_registry: Arc<WorkerRegistry<NamedPipeServer>>,
        archive_registry: Arc<WorkerRegistry<NamedPipeServer>>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        let supervisor = Arc::new(
            WorkerSupervisor::new(
                spec.program.clone().role(WorkerRole::Live),
                spec.route.clone(),
                [
                    WorkerCapability::Snapshot,
                    WorkerCapability::Quote,
                    WorkerCapability::Data,
                    WorkerCapability::ExecuteCommand,
                    WorkerCapability::QueryExecution,
                ]
                .into(),
                spec.startup_timeout,
                spec.worker_restart_policy.clone(),
                Arc::clone(&live_registry),
            )
            .map_err(worker_error)?,
        );
        let worker = supervisor.handle();
        let router = Arc::new(
            WorkerDataRouter::new(live_registry, Arc::clone(&clock), spec.request_timeout)
                .map_err(worker_error)?,
        );
        let projector = SnapshotProjector::restore(Arc::clone(&store), spec.route.clone())
            .map_err(projection_error)?;
        let (collector, collector_handle) = SnapshotCollector::new(
            Arc::clone(&router),
            projector,
            Arc::clone(&clock),
            spec.collector_policy,
        )
        .map_err(projection_error)?;
        let terminal = bridge_contract::TerminalDescriptor {
            terminal_instance_id: spec.route.terminal_instance_id.clone(),
            platform: spec.route.platform.clone(),
            account_ref: spec.route.account_ref.clone(),
            connection_epoch: spec.route.connection_epoch,
            worker_version: None,
        };
        let scope = HistoryScope::new(&terminal.terminal_instance_id, &terminal.account_ref)
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        let (history, history_task) = start_mt5_history_scheduler(
            spec.program.role(WorkerRole::Archive),
            spec.route.clone(),
            archive_registry,
            Arc::clone(&store),
            Arc::clone(&clock),
            spec.startup_timeout,
            spec.worker_restart_policy,
            collector_handle.clone(),
            worker.clone(),
            scope,
            terminal,
        );
        let worker_task = tokio::spawn({
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.run().await }
        });
        let collector_task = tokio::spawn(collector.run());
        let initialization_task = start_initialization_task(
            Arc::clone(&store),
            spec.route.clone(),
            worker.clone(),
            collector_handle.clone(),
            history.clone(),
            clock,
        );
        Ok(Self {
            handle: TerminalSessionHandle {
                route: spec.route,
                worker,
                data: router,
                collector: collector_handle,
                history,
                store: Arc::downgrade(&store),
            },
            worker_task,
            collector_task,
            history_task,
            initialization_task,
        })
    }

    async fn stop(mut self) -> Result<(), TerminalSessionError> {
        self.handle.history.stop();
        await_task(&mut self.history_task, "terminal_history_stop_timeout").await?;
        self.initialization_task.abort();
        let _ = self.initialization_task.await;
        self.handle.collector.stop();
        await_task(&mut self.collector_task, "terminal_collector_stop_timeout").await?;
        self.handle.worker.request_stop();
        let worker_result =
            await_task(&mut self.worker_task, "terminal_worker_stop_timeout").await?;
        worker_result.map_err(worker_error)
    }
}

struct RunningMt4Session {
    handle: Mt4SessionHandle,
    collector_task: JoinHandle<()>,
    history_task: JoinHandle<()>,
}

impl RunningMt4Session {
    fn start(
        spec: Mt4SessionSpec,
        registration_rx: mpsc::Receiver<bridge_mt4::EaConnection>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        let source = Arc::new(
            Mt4EaSnapshotSource::new(
                Mt4SnapshotSourceSpec {
                    route: spec.route.clone(),
                    terminal_data_path: spec.terminal_data_path,
                    accept_timeout: spec.accept_timeout,
                    request_timeout: spec.request_timeout,
                },
                registration_rx,
            )
            .map_err(|error| TerminalSessionError::new(error.code()))?,
        );
        let terminal = bridge_contract::TerminalDescriptor {
            terminal_instance_id: spec.route.terminal_instance_id.clone(),
            platform: spec.route.platform.clone(),
            account_ref: spec.route.account_ref.clone(),
            connection_epoch: spec.route.connection_epoch,
            worker_version: None,
        };
        let history_state = store
            .history_archive_state(&terminal.terminal_instance_id, &terminal.account_ref)
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        let initial_cursor = if history_state.cursor == HistoryCursor::default() {
            HistoryCursor {
                time_msc: HISTORY_COVERAGE_START_UTC_MSC,
                ticket: "0".to_owned(),
            }
        } else {
            history_state.cursor
        };
        let (history, history_task) = start_mt4_history_sync(
            Arc::clone(&source),
            Arc::clone(&store),
            terminal,
            initial_cursor,
            history_state.is_complete,
        );
        let projector =
            SnapshotProjector::restore(store, spec.route.clone()).map_err(projection_error)?;
        let (collector, collector_handle) = SnapshotCollector::new(
            Arc::clone(&source),
            projector,
            Arc::clone(&clock),
            spec.collector_policy,
        )
        .map_err(projection_error)?;
        let collector_task = tokio::spawn(collector.run());
        Ok(Self {
            handle: Mt4SessionHandle {
                route: spec.route,
                source,
                collector: collector_handle,
                history,
                clock,
                command_sequence: Arc::new(AtomicU64::new(0)),
            },
            collector_task,
            history_task,
        })
    }

    async fn stop(mut self) -> Result<(), TerminalSessionError> {
        self.handle.source.request_stop();
        self.handle.collector.stop();
        await_task(&mut self.collector_task, "terminal_collector_stop_timeout").await?;
        self.handle.history.stop();
        await_task(&mut self.history_task, "terminal_history_stop_timeout").await?;
        self.handle.source.close().await;
        Ok(())
    }
}

#[derive(Clone)]
struct HistorySyncHandle {
    stop_tx: watch::Sender<bool>,
    wake: Arc<Notify>,
    status_rx: watch::Receiver<HistorySyncStatus>,
}

impl HistorySyncHandle {
    fn new(initial: HistorySyncStatus) -> (Self, watch::Sender<HistorySyncStatus>) {
        let (stop_tx, _) = watch::channel(false);
        let wake = Arc::new(Notify::new());
        let (status_tx, status_rx) = watch::channel(initial);
        (
            Self {
                stop_tx,
                wake,
                status_rx,
            },
            status_tx,
        )
    }

    fn stop(&self) {
        self.stop_tx.send_replace(true);
        self.wake.notify_one();
    }

    fn wake(&self) {
        self.wake.notify_one();
    }

    fn status(&self) -> HistorySyncStatus {
        self.status_rx.borrow().clone()
    }
}

#[allow(clippy::too_many_arguments)]
fn start_mt5_history_scheduler(
    archive_program: WorkerProgram,
    route: WorkerRoute,
    archive_registry: Arc<WorkerRegistry<NamedPipeServer>>,
    store: Arc<OutboxStore>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    _live_startup_timeout: Duration,
    worker_restart_policy: RestartPolicy,
    collector: CollectorHandle,
    live_worker: WorkerSupervisorHandle,
    scope: HistoryScope,
    terminal: bridge_contract::TerminalDescriptor,
) -> (HistorySyncHandle, JoinHandle<()>) {
    let (handle, status_tx) = HistorySyncHandle::new(HistorySyncStatus::default());
    let stop_tx = handle.stop_tx.clone();
    let wake = Arc::clone(&handle.wake);
    let task = tokio::spawn(async move {
        let mut stop_rx = stop_tx.subscribe();
        let mut sequence = 0_u64;
        let mut planned_jobs = BTreeMap::<String, String>::new();
        let mut last_ensure_hour = 0_i64;
        loop {
            if *stop_rx.borrow() {
                publish_history_stopped(&status_tx);
                return;
            }
            let now = clock();
            if now <= 0 {
                publish_history_failure(
                    &status_tx,
                    history_consecutive_failures(&status_tx).saturating_add(1),
                    "terminal_session_clock_invalid",
                );
                wait_history_scheduler(&mut stop_rx, &wake, HISTORY_RETRY_MINIMUM).await;
                continue;
            }

            if live_worker.status().state != WorkerLifecycleState::Ready
                || collector.status().state != CollectorLifecycleState::Ready
            {
                wait_history_scheduler(&mut stop_rx, &wake, HISTORY_ACTIVE_DELAY).await;
                continue;
            }

            let boundary = floor_hour(now);
            if boundary != last_ensure_hour {
                if regular_job_planning_allowed(&planned_jobs) {
                    match ensure_history_jobs(&store, &scope, now).await {
                        Ok(jobs) => {
                            for job in jobs {
                                planned_jobs.insert(job.job_id.clone(), job.job_kind.clone());
                            }
                            last_ensure_hour = boundary;
                        }
                        Err(error) => {
                            publish_history_failure(
                                &status_tx,
                                history_consecutive_failures(&status_tx).saturating_add(1),
                                &error,
                            );
                            wait_history_scheduler(&mut stop_rx, &wake, HISTORY_RETRY_MINIMUM)
                                .await;
                            continue;
                        }
                    }
                } else {
                    // A queued/running regular job owns the current coverage
                    // window.  Do not create a shifted overlapping job at an
                    // hourly boundary; refresh_history_status removes it only
                    // after a terminal state is observed.
                    last_ensure_hour = boundary;
                }
            }

            let claimed = match claim_next_history_job(&store, &scope, now).await {
                Ok(job) => job,
                Err(error) => {
                    publish_history_failure(
                        &status_tx,
                        history_consecutive_failures(&status_tx).saturating_add(1),
                        &error,
                    );
                    wait_history_scheduler(&mut stop_rx, &wake, HISTORY_RETRY_MINIMUM).await;
                    continue;
                }
            };
            let Some(mut job) = claimed else {
                if !planned_jobs.is_empty() {
                    match refresh_history_status(&store, &mut planned_jobs, &status_tx, now).await {
                        Ok(HistoryRefreshOutcome::Completed) => last_ensure_hour = 0,
                        Ok(HistoryRefreshOutcome::Blocked) | Ok(HistoryRefreshOutcome::Waiting) => {
                        }
                        Err(error) => publish_history_failure(
                            &status_tx,
                            history_consecutive_failures(&status_tx).saturating_add(1),
                            &error,
                        ),
                    }
                }
                wait_history_scheduler(&mut stop_rx, &wake, HISTORY_EMPTY_RETRY).await;
                continue;
            };
            let priority = job.priority.clone();
            if priority != "p1" {
                match wait_for_regular_history_job(
                    &store,
                    &collector,
                    &clock,
                    &mut stop_rx,
                    &wake,
                    &mut job,
                    &status_tx,
                )
                .await
                {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) if error == "history_scheduler_stopped" => {
                        publish_history_stopped(&status_tx);
                        return;
                    }
                    Err(error) => {
                        let _ = retry_claimed_history_job(&store, &job, &error, &clock).await;
                        publish_history_failure(
                            &status_tx,
                            job.attempt_count.max(1) as u32,
                            &error,
                        );
                        continue;
                    }
                }
            }
            set_history_phase(&status_tx, &job, 0, None);
            sequence = sequence.wrapping_add(1);
            let supervisor = match WorkerSupervisor::new(
                archive_program.clone().role(WorkerRole::Archive),
                route.clone(),
                [WorkerCapability::HistoryRangeSync].into(),
                HISTORY_ARCHIVE_STARTUP_TIMEOUT,
                worker_restart_policy.clone(),
                Arc::clone(&archive_registry),
            ) {
                Ok(supervisor) => Arc::new(supervisor),
                Err(error) => {
                    let _ = retry_claimed_history_job(&store, &job, error.code(), &clock).await;
                    publish_history_failure(
                        &status_tx,
                        job.attempt_count.max(1) as u32,
                        error.code(),
                    );
                    continue;
                }
            };
            let archive_worker = supervisor.handle();
            let worker_task = tokio::spawn({
                let supervisor = Arc::clone(&supervisor);
                async move { supervisor.run().await }
            });
            if let Err(error) = wait_worker_ready(
                &archive_worker,
                HISTORY_ARCHIVE_STARTUP_TIMEOUT,
                &mut stop_rx,
            )
            .await
            {
                archive_worker.request_stop();
                let _ = await_worker_task(worker_task).await;
                let _ = retry_claimed_history_job(&store, &job, &error, &clock).await;
                publish_history_failure(&status_tx, job.attempt_count.max(1) as u32, &error);
                continue;
            }
            let archive_router = match WorkerDataRouter::new(
                Arc::clone(&archive_registry),
                Arc::clone(&clock),
                HISTORY_ARCHIVE_REQUEST_TIMEOUT,
            ) {
                Ok(router) => Arc::new(router),
                Err(error) => {
                    archive_worker.request_stop();
                    let _ = await_worker_task(worker_task).await;
                    let _ = retry_claimed_history_job(&store, &job, error.code(), &clock).await;
                    publish_history_failure(
                        &status_tx,
                        job.attempt_count.max(1) as u32,
                        error.code(),
                    );
                    continue;
                }
            };
            let is_p1 = priority == "p1";
            let result = run_history_job(
                &archive_router,
                &store,
                &terminal,
                &collector,
                &clock,
                &mut stop_rx,
                &wake,
                job,
                priority,
                &status_tx,
                &mut sequence,
            )
            .await;
            let result_ok = result.is_ok();
            archive_worker.request_stop();
            let worker_result = await_worker_task(worker_task).await;
            if let Err(error) = worker_result
                && result_ok
            {
                publish_history_failure(&status_tx, 1, &error);
            }
            if let Err(error) = result {
                if error == "history_scheduler_stopped" {
                    publish_history_stopped(&status_tx);
                    return;
                }
                publish_history_failure(
                    &status_tx,
                    history_consecutive_failures(&status_tx).saturating_add(1),
                    &error,
                );
            }
            if is_p1 && result_ok {
                // A completed on-demand request should promptly resume the regular queues.
                last_ensure_hour = 0;
            }
        }
    });
    (handle, task)
}

async fn wait_history_scheduler(
    stop_rx: &mut watch::Receiver<bool>,
    wake: &Notify,
    delay: Duration,
) {
    tokio::select! {
        biased;
        changed = stop_rx.changed() => {
            let _ = changed;
        }
        _ = wake.notified() => {}
        _ = tokio::time::sleep(delay) => {}
    }
}

fn history_job_should_pause(priority: &str, active_positions_or_orders: bool) -> bool {
    priority != "p1" && active_positions_or_orders
}

/// Keep a claimed regular job leased while trading is active, without starting
/// an archive worker that cannot make progress.  A due P1 request is handed
/// back to the scheduler at this boundary so it can run immediately.
#[allow(clippy::too_many_arguments)]
async fn wait_for_regular_history_job(
    store: &Arc<OutboxStore>,
    collector: &CollectorHandle,
    clock: &Arc<dyn Fn() -> i64 + Send + Sync>,
    stop_rx: &mut watch::Receiver<bool>,
    wake: &Notify,
    job: &mut HistorySyncJob,
    status_tx: &watch::Sender<HistorySyncStatus>,
) -> Result<bool, String> {
    let mut collector_status = collector.subscribe_status();
    let mut next_lease_renewal = tokio::time::Instant::now();
    let mut check_p1 = true;
    status_tx.send_replace(HistorySyncStatus {
        state: HistorySyncState::Paused,
        consecutive_failures: 0,
        last_success_at_utc_msc: history_last_success(status_tx),
        error_code: None,
    });
    loop {
        if *stop_rx.borrow() {
            return Err("history_scheduler_stopped".to_owned());
        }
        if !history_job_should_pause(
            &job.priority,
            collector_status.borrow().active_positions_or_orders,
        ) {
            return Ok(false);
        }
        let now = (clock)();
        if now <= 0 {
            return Err("terminal_session_clock_invalid".to_owned());
        }
        if tokio::time::Instant::now() >= next_lease_renewal {
            *job = renew_history_job(store, job, now, clock).await?;
            next_lease_renewal = tokio::time::Instant::now() + HISTORY_ACTIVE_LEASE_RENEW;
            check_p1 = true;
        }
        if check_p1 {
            if yield_history_job_if_higher_priority_waiting(store, job, now).await? {
                return Ok(true);
            }
            check_p1 = false;
        }
        let sleep = tokio::time::sleep_until(next_lease_renewal);
        tokio::pin!(sleep);
        tokio::select! {
            biased;
            changed = stop_rx.changed() => {
                let _ = changed;
            }
            changed = collector_status.changed() => {
                if changed.is_err() {
                    return Err("terminal_collector_status_closed".to_owned());
                }
            }
            _ = wake.notified() => {
                check_p1 = true;
            }
            _ = &mut sleep => {
                check_p1 = true;
            }
        }
    }
}

async fn wait_worker_ready(
    worker: &WorkerSupervisorHandle,
    timeout: Duration,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let mut status = worker.subscribe();
    tokio::time::timeout(timeout, async {
        loop {
            let snapshot = status.borrow().clone();
            match snapshot.state {
                WorkerLifecycleState::Ready => return Ok(()),
                WorkerLifecycleState::Superseded | WorkerLifecycleState::Stopped
                    if snapshot.error_code.is_some() =>
                {
                    return Err(snapshot
                        .error_code
                        .unwrap_or_else(|| "archive_worker_stopped".to_owned()));
                }
                _ => {}
            }
            tokio::select! {
                changed = status.changed() => {
                    changed.map_err(|_| "archive_worker_status_closed".to_owned())?;
                }
                changed = stop_rx.changed() => {
                    let _ = changed;
                    if *stop_rx.borrow() {
                        return Err("history_scheduler_stopped".to_owned());
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| "archive_worker_start_timeout".to_owned())?
}

async fn await_worker_task(
    mut task: JoinHandle<Result<(), WorkerHostError>>,
) -> Result<(), String> {
    match tokio::time::timeout(HISTORY_ARCHIVE_STARTUP_TIMEOUT, &mut task).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => Err(error.code().to_owned()),
        Ok(Err(_)) => Err("archive_worker_task_failed".to_owned()),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err("archive_worker_stop_timeout".to_owned())
        }
    }
}

async fn ensure_history_jobs(
    store: &Arc<OutboxStore>,
    scope: &HistoryScope,
    now: i64,
) -> Result<Vec<HistorySyncJob>, String> {
    let end = floor_hour(now);
    if end <= HISTORY_COVERAGE_START_UTC_MSC {
        return Ok(Vec::new());
    }
    let recent_start = end.saturating_sub(HISTORY_RECENT_MSC);
    let request = HistoryJobPlanningRequest {
        scope: scope.clone(),
        job_kind: "recent".to_owned(),
        priority: "p2".to_owned(),
        range_start_utc_msc: recent_start,
        range_end_utc_msc: end,
        window_msc: HISTORY_INITIAL_WINDOW_MSC,
        now_utc_msc: now,
    };
    let result = {
        let store = Arc::clone(store);
        tokio::task::spawn_blocking(move || store.plan_history_jobs(&request))
            .await
            .map_err(|_| "history_job_planning_worker_failed".to_owned())?
            .map_err(|error| error.code().to_owned())?
    };
    let mut jobs = result.created_jobs;
    jobs.extend(result.attached_jobs);
    jobs.sort_by(|left, right| left.job_id.cmp(&right.job_id));
    Ok(jobs)
}

async fn claim_next_history_job(
    store: &Arc<OutboxStore>,
    scope: &HistoryScope,
    now: i64,
) -> Result<Option<HistorySyncJob>, String> {
    let store = Arc::clone(store);
    let scope = scope.clone();
    tokio::task::spawn_blocking(move || {
        store.claim_history_job_with_allowed_kinds(
            &scope,
            now,
            HISTORY_LEASE.as_millis() as i64,
            &["recent", "on_demand"],
        )
    })
    .await
    .map_err(|_| "history_job_claim_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

fn floor_hour(now: i64) -> i64 {
    now - now.rem_euclid(HISTORY_HOUR_MSC)
}

fn regular_job_planning_allowed(planned_jobs: &BTreeMap<String, String>) -> bool {
    !planned_jobs.values().any(|kind| kind == "recent")
}

fn set_history_phase(
    status_tx: &watch::Sender<HistorySyncStatus>,
    job: &HistorySyncJob,
    failures: u32,
    error_code: Option<&str>,
) {
    let state = match job.job_kind.as_str() {
        "recent" => HistorySyncState::SyncingRecent,
        "backfill" => HistorySyncState::Backfilling,
        _ => HistorySyncState::Partial,
    };
    status_tx.send_replace(HistorySyncStatus {
        state,
        consecutive_failures: failures,
        last_success_at_utc_msc: history_last_success(status_tx),
        error_code: error_code.map(str::to_owned),
    });
}

fn history_last_success(status_tx: &watch::Sender<HistorySyncStatus>) -> Option<i64> {
    status_tx.borrow().last_success_at_utc_msc
}

fn history_consecutive_failures(status_tx: &watch::Sender<HistorySyncStatus>) -> u32 {
    status_tx.borrow().consecutive_failures
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryRefreshOutcome {
    Waiting,
    Completed,
    Blocked,
}

async fn refresh_history_status(
    store: &Arc<OutboxStore>,
    planned_jobs: &mut BTreeMap<String, String>,
    status_tx: &watch::Sender<HistorySyncStatus>,
    now: i64,
) -> Result<HistoryRefreshOutcome, String> {
    let mut completed = 0_usize;
    let mut blocked = false;
    let mut terminal_jobs = Vec::new();
    for job_id in planned_jobs.keys() {
        let store = Arc::clone(store);
        let job_id = job_id.clone();
        let query_job_id = job_id.clone();
        if let Some(job) =
            tokio::task::spawn_blocking(move || store.history_sync_job(&query_job_id))
                .await
                .map_err(|_| "history_status_worker_failed".to_owned())?
                .map_err(|error| error.code().to_owned())?
        {
            completed += usize::from(job.state == "completed");
            blocked |= job.state == "blocked";
            if matches!(job.state.as_str(), "completed" | "superseded" | "blocked") {
                terminal_jobs.push(job_id.clone());
            }
        }
    }
    for job_id in terminal_jobs {
        planned_jobs.remove(&job_id);
    }
    if blocked {
        status_tx.send_replace(HistorySyncStatus {
            state: HistorySyncState::Blocked,
            consecutive_failures: 0,
            last_success_at_utc_msc: history_last_success(status_tx),
            error_code: Some("blocked_dense_range".to_owned()),
        });
        return Ok(HistoryRefreshOutcome::Blocked);
    }
    if completed > 0 && planned_jobs.is_empty() {
        status_tx.send_replace(HistorySyncStatus {
            state: HistorySyncState::Complete,
            consecutive_failures: 0,
            last_success_at_utc_msc: Some(now),
            error_code: None,
        });
        return Ok(HistoryRefreshOutcome::Completed);
    }
    Ok(HistoryRefreshOutcome::Waiting)
}

async fn retry_claimed_history_job(
    store: &Arc<OutboxStore>,
    job: &HistorySyncJob,
    error_code: &str,
    clock: &Arc<dyn Fn() -> i64 + Send + Sync>,
) -> Result<(), String> {
    let now = (clock)();
    if now <= 0 {
        return Err("terminal_session_clock_invalid".to_owned());
    }
    let delay = HISTORY_RETRY_MINIMUM
        .saturating_mul(1_u32 << (job.attempt_count.max(1) as u32).min(4))
        .min(HISTORY_RETRY_MAXIMUM);
    let store = Arc::clone(store);
    let job_id = job.job_id.clone();
    let lease_generation = job.lease_generation;
    let error_code = normalize_history_error(error_code);
    tokio::task::spawn_blocking(move || {
        store.retry_history_job(
            &job_id,
            lease_generation,
            now.saturating_add(delay.as_millis() as i64),
            &error_code,
            now,
        )
    })
    .await
    .map_err(|_| "history_retry_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

fn normalize_history_error(code: &str) -> String {
    if code.is_empty() {
        "history_sync_failed".to_owned()
    } else {
        code.chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                    character
                } else {
                    '_'
                }
            })
            .take(128)
            .collect()
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_history_job<S>(
    router: &WorkerDataRouter<S>,
    store: &Arc<OutboxStore>,
    terminal: &bridge_contract::TerminalDescriptor,
    collector: &CollectorHandle,
    clock: &Arc<dyn Fn() -> i64 + Send + Sync>,
    stop_rx: &mut watch::Receiver<bool>,
    wake: &Notify,
    mut job: HistorySyncJob,
    priority: String,
    status_tx: &watch::Sender<HistorySyncStatus>,
    sequence: &mut u64,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let mut dense_failures = 0_u32;
    loop {
        if *stop_rx.borrow() {
            return Err("history_scheduler_stopped".to_owned());
        }
        let now = (clock)();
        if now <= 0 {
            return Err("terminal_session_clock_invalid".to_owned());
        }
        let _ = renew_history_job(store, &job, now, clock).await?;
        job = load_history_job(store, &job.job_id).await?;
        if job.state == "completed" {
            status_tx.send_replace(HistorySyncStatus {
                state: HistorySyncState::Complete,
                consecutive_failures: 0,
                last_success_at_utc_msc: Some(now),
                error_code: None,
            });
            return Ok(());
        }
        if history_job_should_pause(&priority, collector.status().active_positions_or_orders) {
            status_tx.send_replace(HistorySyncStatus {
                state: HistorySyncState::Paused,
                consecutive_failures: 0,
                last_success_at_utc_msc: history_last_success(status_tx),
                error_code: None,
            });
            tokio::select! {
                _ = wake.notified() => {},
                changed = stop_rx.changed() => { let _ = changed; },
                _ = tokio::time::sleep(HISTORY_ACTIVE_DELAY) => {},
            }
            continue;
        }
        let child_end = job
            .cursor_time_msc
            .saturating_add(job.window_msc)
            .min(job.range_end_utc_msc);
        if child_end <= job.cursor_time_msc {
            return Err("history_cursor_not_advancing".to_owned());
        }
        let request_cursor = WorkerHistoryCursor {
            time_msc: job.cursor_time_msc,
            ticket: if job.cursor_ticket.is_empty() {
                "0".to_owned()
            } else {
                job.cursor_ticket.clone()
            },
        };
        *sequence = sequence.wrapping_add(1);
        let request_id = format!("history_range_{:x}_{:x}", now, *sequence);
        let started = tokio::time::Instant::now();
        let permit =
            match tokio::time::timeout(HISTORY_CALL_WAIT, history_call_budget().acquire_owned())
                .await
            {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => return Err("history_call_budget_closed".to_owned()),
                Err(_) => {
                    tokio::time::sleep(HISTORY_ACTIVE_DELAY).await;
                    continue;
                }
            };
        let result = tokio::select! {
            changed = stop_rx.changed() => {
                let _ = changed;
                return Err("history_scheduler_stopped".to_owned());
            }
            result = router.history_range_sync(
                terminal_route(terminal),
                request_id,
                job.cursor_time_msc,
                child_end,
                request_cursor,
                HISTORY_BATCH_LIMIT,
            ) => result,
        };
        drop(permit);
        let elapsed = started.elapsed();
        let batch = match result {
            Ok(batch) => batch,
            Err(error) => {
                let code = error.code().to_owned();
                let timeout = is_timeout(&code);
                let next_dense_failures = if !timeout
                    && (job.window_msc / 2).max(HISTORY_MIN_WINDOW_MSC) == HISTORY_MIN_WINDOW_MSC
                {
                    dense_failures.saturating_add(1)
                } else {
                    0
                };
                dense_failures = next_dense_failures;
                let error_kind = history_error_kind(&code, next_dense_failures);
                let decision =
                    history_error_decision(job.window_msc, error_kind, min_timeout_count(&job));
                let now = (clock)();
                match decision {
                    HistoryErrorDecision::Block => {
                        let failures = match error_kind {
                            HistoryErrorKind::TooDense { consecutive_at_min } => consecutive_at_min,
                            HistoryErrorKind::Timeout => min_timeout_count(&job).saturating_add(1),
                            HistoryErrorKind::Other => 0,
                        };
                        block_history_job(store, &job, "blocked_dense_range", now).await?;
                        status_tx.send_replace(HistorySyncStatus {
                            state: HistorySyncState::Blocked,
                            consecutive_failures: failures,
                            last_success_at_utc_msc: history_last_success(status_tx),
                            error_code: Some("blocked_dense_range".to_owned()),
                        });
                        return Ok(());
                    }
                    HistoryErrorDecision::RetrySameProcess { window_msc }
                    | HistoryErrorDecision::RestartArchive { window_msc }
                        if window_msc != job.window_msc =>
                    {
                        checkpoint_history_job(store, &job, window_msc, now).await?;
                        job = load_history_job(store, &job.job_id).await?;
                        if matches!(decision, HistoryErrorDecision::RestartArchive { .. }) {
                            let error_code = if matches!(error_kind, HistoryErrorKind::Timeout)
                                && window_msc == HISTORY_MIN_WINDOW_MSC
                            {
                                format!(
                                    "history_timeout_min_{}",
                                    min_timeout_count(&job).saturating_add(1)
                                )
                            } else {
                                code.clone()
                            };
                            let _ =
                                retry_claimed_history_job(store, &job, &error_code, clock).await;
                            return Ok(());
                        }
                    }
                    HistoryErrorDecision::RetrySameProcess { .. } => {}
                    HistoryErrorDecision::RestartArchive { .. } => {
                        let _ = retry_claimed_history_job(store, &job, &code, clock).await;
                        return Ok(());
                    }
                }
                tokio::select! {
                    _ = wake.notified() => {},
                    changed = stop_rx.changed() => { let _ = changed; },
                    _ = tokio::time::sleep(HISTORY_RETRY_MINIMUM) => {},
                }
                continue;
            }
        };
        let next_window = adjust_history_window(
            job.window_msc,
            batch.deals.len() + batch.history_orders.len() + batch.trades.len(),
            elapsed,
        );
        let stored = HistoryArchiveBatch {
            deals: batch.deals,
            history_orders: batch.history_orders,
            trades: batch.trades,
            next_cursor: HistoryCursor {
                time_msc: batch.next_cursor.time_msc,
                ticket: if batch.next_cursor.ticket.is_empty() {
                    "0".to_owned()
                } else {
                    batch.next_cursor.ticket
                },
            },
            has_more: batch.has_more,
            observed_at_utc_msc: batch.observed_at_utc_msc,
        };
        let now = (clock)();
        let persisted =
            persist_history_job_batch(store, terminal, &job, &stored, next_window, now).await;
        match persisted {
            Ok(updated) => {
                job = updated;
                dense_failures = 0;
                status_tx.send_replace(HistorySyncStatus {
                    state: if job.state == "completed" {
                        HistorySyncState::Complete
                    } else if stored.has_more {
                        HistorySyncState::Partial
                    } else if job.job_kind == "recent" {
                        HistorySyncState::SyncingRecent
                    } else {
                        HistorySyncState::Backfilling
                    },
                    consecutive_failures: 0,
                    last_success_at_utc_msc: Some(now),
                    error_code: None,
                });
                if job.state == "completed" {
                    return Ok(());
                }
                if priority != "p1"
                    && yield_history_job_if_higher_priority_waiting(store, &job, now).await?
                {
                    return Ok(());
                }
            }
            Err(error) => {
                let _ = retry_claimed_history_job(store, &job, &error, clock).await;
                return Ok(());
            }
        }
    }
}

fn terminal_route(terminal: &bridge_contract::TerminalDescriptor) -> WorkerRoute {
    WorkerRoute::from_terminal(terminal).expect("validated MT5 terminal route")
}

fn is_dense_or_timeout(code: &str) -> bool {
    code.contains("timeout") || code.contains("too_dense") || code.contains("dense")
}

fn is_timeout(code: &str) -> bool {
    code.contains("timeout")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryErrorKind {
    TooDense { consecutive_at_min: u32 },
    Timeout,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryErrorDecision {
    RetrySameProcess { window_msc: i64 },
    RestartArchive { window_msc: i64 },
    Block,
}

fn history_error_kind(code: &str, consecutive_at_min: u32) -> HistoryErrorKind {
    if is_timeout(code) {
        HistoryErrorKind::Timeout
    } else if is_dense_or_timeout(code) {
        HistoryErrorKind::TooDense { consecutive_at_min }
    } else {
        HistoryErrorKind::Other
    }
}

/// Selects the next action after a native history request error.  The helper is
/// deliberately pure so retry/block behavior is deterministic across archive
/// worker restarts; the persisted minimum-timeout count is supplied separately
/// from the in-process too-dense counter.
fn history_error_decision(
    window_msc: i64,
    kind: HistoryErrorKind,
    persisted_min_timeout_count: u32,
) -> HistoryErrorDecision {
    let shrunk = (window_msc / 2).max(HISTORY_MIN_WINDOW_MSC);
    match kind {
        HistoryErrorKind::TooDense { consecutive_at_min } => {
            if shrunk == HISTORY_MIN_WINDOW_MSC
                && consecutive_at_min >= HISTORY_DENSE_RETRY_THRESHOLD
            {
                HistoryErrorDecision::Block
            } else {
                HistoryErrorDecision::RetrySameProcess { window_msc: shrunk }
            }
        }
        HistoryErrorKind::Timeout => {
            if shrunk == HISTORY_MIN_WINDOW_MSC
                && persisted_min_timeout_count.saturating_add(1) >= HISTORY_DENSE_RETRY_THRESHOLD
            {
                HistoryErrorDecision::Block
            } else {
                HistoryErrorDecision::RestartArchive { window_msc: shrunk }
            }
        }
        HistoryErrorKind::Other => HistoryErrorDecision::RestartArchive { window_msc },
    }
}

fn min_timeout_count(job: &HistorySyncJob) -> u32 {
    min_timeout_count_from_code(job.last_error_code.as_deref())
}

fn min_timeout_count_from_code(error_code: Option<&str>) -> u32 {
    error_code
        .and_then(|code| code.strip_prefix("history_timeout_min_"))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0)
}

fn adjust_history_window(window: i64, item_count: usize, elapsed: Duration) -> i64 {
    let window = window.clamp(HISTORY_MIN_WINDOW_MSC, HISTORY_MAX_WINDOW_MSC);
    if item_count >= 250 || elapsed >= Duration::from_secs(4) {
        (window / 2).max(HISTORY_MIN_WINDOW_MSC)
    } else if item_count < 250 && elapsed < Duration::from_secs(2) {
        (window.saturating_mul(2)).min(HISTORY_MAX_WINDOW_MSC)
    } else {
        window
    }
}

async fn renew_history_job(
    store: &Arc<OutboxStore>,
    job: &HistorySyncJob,
    now: i64,
    _clock: &Arc<dyn Fn() -> i64 + Send + Sync>,
) -> Result<HistorySyncJob, String> {
    let store = Arc::clone(store);
    let job_id = job.job_id.clone();
    let lease_generation = job.lease_generation;
    tokio::task::spawn_blocking(move || {
        store.renew_history_job(
            &job_id,
            lease_generation,
            now,
            HISTORY_LEASE.as_millis() as i64,
        )
    })
    .await
    .map_err(|_| "history_renew_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

async fn yield_history_job_if_higher_priority_waiting(
    store: &Arc<OutboxStore>,
    job: &HistorySyncJob,
    now: i64,
) -> Result<bool, String> {
    let store = Arc::clone(store);
    let job_id = job.job_id.clone();
    let lease_generation = job.lease_generation;
    tokio::task::spawn_blocking(move || {
        store.yield_history_job_if_higher_priority_waiting(&job_id, lease_generation, now)
    })
    .await
    .map_err(|_| "history_yield_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

async fn load_history_job(
    store: &Arc<OutboxStore>,
    job_id: &str,
) -> Result<HistorySyncJob, String> {
    let store = Arc::clone(store);
    let job_id = job_id.to_owned();
    tokio::task::spawn_blocking(move || store.history_sync_job(&job_id))
        .await
        .map_err(|_| "history_job_query_worker_failed".to_owned())?
        .map_err(|error| error.code().to_owned())?
        .ok_or_else(|| "history_job_missing".to_owned())
}

async fn checkpoint_history_job(
    store: &Arc<OutboxStore>,
    job: &HistorySyncJob,
    window: i64,
    now: i64,
) -> Result<(), String> {
    let store = Arc::clone(store);
    let job_id = job.job_id.clone();
    let cursor_ticket = job.cursor_ticket.clone();
    let lease_generation = job.lease_generation;
    let cursor_time_msc = job.cursor_time_msc;
    tokio::task::spawn_blocking(move || {
        store.checkpoint_history_job(
            &job_id,
            lease_generation,
            cursor_time_msc,
            &cursor_ticket,
            window,
            now,
        )
    })
    .await
    .map_err(|_| "history_checkpoint_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

async fn block_history_job(
    store: &Arc<OutboxStore>,
    job: &HistorySyncJob,
    error_code: &str,
    now: i64,
) -> Result<(), String> {
    let store = Arc::clone(store);
    let job_id = job.job_id.clone();
    let lease_generation = job.lease_generation;
    let error_code = normalize_history_error(error_code);
    tokio::task::spawn_blocking(move || {
        store.block_history_job(&job_id, lease_generation, &error_code, now)
    })
    .await
    .map_err(|_| "history_block_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

async fn persist_history_job_batch(
    store: &Arc<OutboxStore>,
    terminal: &bridge_contract::TerminalDescriptor,
    job: &HistorySyncJob,
    batch: &HistoryArchiveBatch,
    window: i64,
    now: i64,
) -> Result<HistorySyncJob, String> {
    let store = Arc::clone(store);
    let terminal = terminal.clone();
    let job_id = job.job_id.clone();
    let batch = batch.clone();
    let lease_generation = job.lease_generation;
    tokio::task::spawn_blocking(move || {
        store
            .persist_history_job_batch(&terminal, &job_id, lease_generation, &batch, window, now)
            .map(|result| result.job)
    })
    .await
    .map_err(|_| "history_persist_worker_failed".to_owned())?
    .map_err(|error| error.code().to_owned())
}

fn start_mt4_history_sync(
    source: Arc<Mt4EaSnapshotSource>,
    store: Arc<OutboxStore>,
    terminal: bridge_contract::TerminalDescriptor,
    initial_cursor: HistoryCursor,
    initially_complete: bool,
) -> (HistorySyncHandle, JoinHandle<()>) {
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let (status_tx, status_rx) = watch::channel(HistorySyncStatus::default());
    let wake = Arc::new(Notify::new());
    let handle = HistorySyncHandle {
        stop_tx,
        wake: Arc::clone(&wake),
        status_rx,
    };
    let task = tokio::spawn(async move {
        let mut cursor = initial_cursor;
        let mut complete = initially_complete;
        let mut failures = 0_u32;
        loop {
            if *stop_rx.borrow() {
                publish_history_stopped(&status_tx);
                return;
            }
            let delay = if failures > 0 {
                HISTORY_RETRY_MINIMUM
                    .saturating_mul(1_u32 << failures.min(4))
                    .min(HISTORY_RETRY_MAXIMUM)
            } else if complete {
                HISTORY_COMPLETE_INTERVAL
            } else {
                Duration::from_millis(25)
            };
            tokio::select! {
                biased;
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        publish_history_stopped(&status_tx);
                        return;
                    }
                    continue;
                }
                _ = wake.notified() => {}
                _ = tokio::time::sleep(delay) => {}
            }
            if *stop_rx.borrow() {
                return;
            }
            let cursor_ticket = match cursor.ticket.parse::<i64>() {
                Ok(ticket) if ticket >= 0 => ticket,
                _ => {
                    failures = failures.saturating_add(1);
                    publish_history_failure(
                        &status_tx,
                        failures,
                        "terminal_history_cursor_invalid",
                    );
                    continue;
                }
            };
            let batch = source
                .collect_deals(
                    cursor.time_msc,
                    cursor_ticket,
                    i32::from(HISTORY_BATCH_LIMIT),
                    bridge_mt4::MAX_HISTORY_WINDOW_MSC,
                )
                .await;
            let batch = match batch {
                Ok(batch) => batch,
                Err(error) => {
                    failures = failures.saturating_add(1);
                    publish_history_failure(&status_tx, failures, error.code());
                    continue;
                }
            };
            let trades = batch
                .items
                .iter()
                .filter(|item| {
                    item.get("category")
                        .and_then(serde_json::Value::as_str)
                        .is_none_or(|category| category == "trade")
                })
                .map(build_mt4_history_trade)
                .collect::<Vec<_>>();
            let stored = HistoryArchiveBatch {
                deals: batch.items,
                history_orders: Vec::new(),
                trades,
                next_cursor: HistoryCursor {
                    time_msc: batch.next_time_msc,
                    ticket: batch.next_ticket.to_string(),
                },
                has_more: batch.has_more,
                observed_at_utc_msc: batch.source_time_msc,
            };
            let next_cursor = stored.next_cursor.clone();
            let has_more = stored.has_more;
            let persist_store = Arc::clone(&store);
            let persist_terminal = terminal.clone();
            let persisted = tokio::task::spawn_blocking(move || {
                persist_store.persist_history_archive_batch(&persist_terminal, &stored)
            })
            .await;
            match persisted {
                Ok(Ok(())) => {
                    cursor = next_cursor;
                    complete = !has_more;
                    failures = 0;
                    status_tx.send_replace(HistorySyncStatus {
                        state: HistorySyncState::Ready,
                        consecutive_failures: 0,
                        last_success_at_utc_msc: Some(batch.source_time_msc),
                        error_code: None,
                    });
                }
                Ok(Err(error)) => {
                    failures = failures.saturating_add(1);
                    publish_history_failure(&status_tx, failures, error.code());
                }
                Err(_) => {
                    failures = failures.saturating_add(1);
                    publish_history_failure(
                        &status_tx,
                        failures,
                        "terminal_history_store_worker_failed",
                    );
                }
            }
        }
    });
    (handle, task)
}

fn publish_history_failure(
    status_tx: &watch::Sender<HistorySyncStatus>,
    consecutive_failures: u32,
    error_code: &str,
) {
    let last_success_at_utc_msc = status_tx.borrow().last_success_at_utc_msc;
    status_tx.send_replace(HistorySyncStatus {
        state: HistorySyncState::Retrying,
        consecutive_failures,
        last_success_at_utc_msc,
        error_code: Some(error_code.to_owned()),
    });
}

fn publish_history_stopped(status_tx: &watch::Sender<HistorySyncStatus>) {
    let previous = status_tx.borrow().clone();
    status_tx.send_replace(HistorySyncStatus {
        state: HistorySyncState::Stopped,
        ..previous
    });
}

fn same_account(left: &WorkerRoute, right: &WorkerRoute) -> bool {
    left.account_ref.login == right.account_ref.login
        && left
            .account_ref
            .broker_server
            .eq_ignore_ascii_case(&right.account_ref.broker_server)
}

fn supersede_account_scope(
    store: &Arc<OutboxStore>,
    route: &WorkerRoute,
    now: i64,
) -> Result<(), TerminalSessionError> {
    if now <= 0 {
        return Err(TerminalSessionError::new("terminal_session_clock_invalid"));
    }
    let scope = HistoryScope::new(&route.terminal_instance_id, &route.account_ref)
        .map_err(|error| TerminalSessionError::new(error.code()))?;
    store
        .supersede_history_scope(&scope, now)
        .map_err(|error| TerminalSessionError::new(error.code()))?;
    let existing = store
        .account_initialization_state(&scope)
        .map_err(|error| TerminalSessionError::new(error.code()))?;
    let initialized_at = existing
        .as_ref()
        .map_or(now, |state| state.initialized_at_utc_msc);
    store
        .write_account_initialization_state(&AccountInitializationState {
            scope,
            platform: route.platform.clone(),
            schema_version: INITIALIZATION_SCHEMA_VERSION,
            state: "superseded".to_owned(),
            local_operational_ready: false,
            last_error_code: Some("scope_superseded".to_owned()),
            initialized_at_utc_msc: initialized_at,
            updated_at_utc_msc: now.max(initialized_at),
        })
        .map_err(|error| TerminalSessionError::new(error.code()))
}

fn start_initialization_task(
    store: Arc<OutboxStore>,
    route: WorkerRoute,
    worker: WorkerSupervisorHandle,
    collector: CollectorHandle,
    _history: HistorySyncHandle,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Ok(scope) = HistoryScope::new(&route.terminal_instance_id, &route.account_ref) else {
            return;
        };
        let now = clock();
        if now <= 0 {
            return;
        }
        let existing = store.account_initialization_state(&scope).ok().flatten();
        if existing
            .as_ref()
            .is_some_and(|state| state.state == "ready" && state.local_operational_ready)
        {
            return;
        }
        let initialized_at = existing
            .as_ref()
            .map_or(now, |state| state.initialized_at_utc_msc);
        let write_state = |state: &str, ready: bool, error_code: Option<&str>, updated: i64| {
            store
                .write_account_initialization_state(&AccountInitializationState {
                    scope: scope.clone(),
                    platform: route.platform.clone(),
                    schema_version: INITIALIZATION_SCHEMA_VERSION,
                    state: state.to_owned(),
                    local_operational_ready: ready,
                    last_error_code: error_code.map(str::to_owned),
                    initialized_at_utc_msc: initialized_at,
                    updated_at_utc_msc: updated.max(initialized_at),
                })
                .is_ok()
        };
        write_state("detected", false, None, now);
        write_state("verifying_identity", false, None, now);
        write_state("warming_realtime_snapshot", false, None, now);

        let mut worker_status = worker.subscribe();
        let mut collector_status = collector.subscribe_status();
        loop {
            if worker_status.borrow().state == WorkerLifecycleState::Ready
                && collector_status.borrow().state == CollectorLifecycleState::Ready
            {
                let complete = store
                    .load_terminal_projection(
                        &route.terminal_instance_id,
                        &route.account_ref,
                        route.connection_epoch,
                    )
                    .map(|projection| {
                        projection.account.revision > 0
                            && projection.positions.revision > 0
                            && projection.orders.revision > 0
                    })
                    .unwrap_or(false);
                if complete {
                    let updated = clock();
                    write_state("ready", true, None, updated);
                    return;
                }
            }
            tokio::select! {
                changed = worker_status.changed() => {
                    if changed.is_err() { return; }
                }
                changed = collector_status.changed() => {
                    if changed.is_err() { return; }
                }
                _ = tokio::time::sleep(Duration::from_millis(25)) => {}
            }
        }
    })
}

fn build_mt4_history_trade(item: &serde_json::Value) -> serde_json::Value {
    let side = item
        .get("side")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let profit = history_number(item, "profit");
    let commission = history_number(item, "commission");
    let swap = history_number(item, "swap");
    let ticket = history_scalar(item, "ticket");
    serde_json::json!({
        "ticket": ticket,
        "deal_ticket": history_scalar(item, "deal_ticket").or_else(|| ticket.clone()),
        "order": history_scalar(item, "order_ticket").or_else(|| ticket.clone()),
        "position_id": history_scalar(item, "position_id").or_else(|| ticket.clone()),
        "symbol": item.get("symbol").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "type": if side.eq_ignore_ascii_case("buy") { "BUY" } else { "SELL" },
        "volume": history_number(item, "volume"),
        "entry_price": history_number(item, "price_open"),
        "exit_price": history_number(item, "price_close"),
        "price": history_number(item, "price_close"),
        "profit": profit,
        "commission": commission,
        "swap": swap,
        "fee": 0.0,
        "net_profit": profit + commission + swap,
        "entry_time": item.get("entry_time").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "close_time": item.get("close_time").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "time": item.get("close_time").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "time_msc": item.get("time_msc").and_then(serde_json::Value::as_i64).unwrap_or_default(),
        "comment": item.get("comment").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "take_profit": history_number(item, "tp"),
        "stop_loss": history_number(item, "sl")
    })
}

fn history_scalar(item: &serde_json::Value, name: &str) -> Option<String> {
    match item.get(name) {
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(serde_json::Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn history_number(item: &serde_json::Value, name: &str) -> f64 {
    item.get(name)
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or_default()
}

async fn await_task<T>(
    task: &mut JoinHandle<T>,
    timeout_code: &'static str,
) -> Result<T, TerminalSessionError> {
    match tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut *task).await {
        Ok(result) => result.map_err(|_| TerminalSessionError::new("terminal_session_task_failed")),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(TerminalSessionError::new(timeout_code))
        }
    }
}

fn worker_error(error: WorkerHostError) -> TerminalSessionError {
    TerminalSessionError::new(error.code())
}

fn preferred_terminal_error(
    worker_error_code: Option<String>,
    collector_error_code: Option<String>,
) -> Option<String> {
    worker_error_code.or(collector_error_code)
}

fn projection_error(error: bridge_terminal_data::ProjectionError) -> TerminalSessionError {
    TerminalSessionError::new(error.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::AccountRef;
    use bridge_mt4::{
        CURRENT_PROTOCOL_VERSION, CollectionStreams, DealsBatch, Hello, MessageType, Snapshot,
        TradeResult, decode_collect, decode_command, decode_message_type, decode_welcome,
        encode_command_result, encode_deals, encode_hello, encode_message_type, encode_snapshot,
        read_frame, reconnect_pipe_name, write_frame,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn worker_error_code_takes_precedence_over_collector_fallback() {
        assert_eq!(
            preferred_terminal_error(
                Some("worker_process_exit".to_owned()),
                Some("worker_registry_not_ready".to_owned()),
            )
            .as_deref(),
            Some("worker_process_exit")
        );
        assert_eq!(
            preferred_terminal_error(None, Some("collector_retrying".to_owned())).as_deref(),
            Some("collector_retrying")
        );
    }
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    fn route(epoch: i64) -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_session_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: if epoch == 1 { "111111" } else { "222222" }.to_owned(),
            },
            connection_epoch: epoch,
        }
    }

    fn python() -> PathBuf {
        let output = Command::new("where.exe")
            .arg("python.exe")
            .output()
            .expect("locate python");
        assert!(
            output.status.success(),
            "python is required for session tests"
        );
        String::from_utf8(output.stdout)
            .expect("python path utf8")
            .lines()
            .next()
            .map(PathBuf::from)
            .expect("python path")
    }

    fn spec(epoch: i64, root: &Path, terminal_path: &Path) -> Mt5SessionSpec {
        let native_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("native root");
        let worker_directory = native_root.join("workers").join("mt5");
        let worker_entry = worker_directory.join("fake_worker_entry.py");
        let program = WorkerProgram::new(python(), &worker_directory)
            .expect("python worker")
            .arg(worker_entry.into_os_string())
            .env("LOCALAPPDATA", root.as_os_str())
            .expect("isolated worker state")
            .terminal_path(terminal_path)
            .expect("terminal path");
        Mt5SessionSpec {
            route: route(epoch),
            program,
            startup_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(2),
            worker_restart_policy: RestartPolicy {
                stable_run_threshold: Duration::from_secs(2),
                poll_interval: Duration::from_millis(10),
                restart_delays: [Duration::from_millis(20); 5],
                maximum_failure_counter: 8,
            },
            collector_policy: CollectorPolicy {
                active_interval: Duration::from_millis(20),
                idle_interval: Duration::from_millis(50),
                retry_initial: Duration::from_millis(10),
                retry_max: Duration::from_millis(40),
            },
        }
    }

    async fn wait_ready(handle: &TerminalSessionHandle) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while handle.status().state != TerminalSessionState::Ready {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("session ready");
    }

    async fn wait_mt4_ready(handle: &Mt4SessionHandle) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while handle.status().state != TerminalSessionState::Ready {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("MT4 session ready");
    }

    async fn open_pipe_when_ready(path: &str) -> NamedPipeClient {
        for _ in 0..200 {
            match ClientOptions::new().open(path) {
                Ok(client) => return client,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        panic!("pipe did not become ready: {path}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn mt4_snapshot_session_projects_account_positions_and_orders_to_the_outbox() {
        let root = unique_test_directory();
        fs::create_dir_all(&root).expect("session test directory");
        let terminal_data_path = root.join("terminal-data");
        fs::create_dir_all(&terminal_data_path).expect("terminal data directory");
        let store =
            Arc::new(OutboxStore::open_or_create(root.join("bridge.db")).expect("session store"));
        let terminal_id = format!(
            "mt4_{:024x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let route = WorkerRoute {
            terminal_instance_id: terminal_id.clone(),
            platform: "mt4".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 3,
        };
        let manager = Mt4SessionManager::new(
            terminal_id.clone(),
            Arc::clone(&store),
            Arc::new(|| 1_800_000_100_000),
        )
        .expect("MT4 manager");
        let (registration_tx, registration_rx) = mpsc::channel(1);
        let handle = manager
            .replace(
                Mt4SessionSpec {
                    route: route.clone(),
                    terminal_data_path: terminal_data_path.clone(),
                    accept_timeout: Duration::from_secs(3),
                    request_timeout: Duration::from_secs(1),
                    collector_policy: CollectorPolicy {
                        active_interval: Duration::from_millis(100),
                        idle_interval: Duration::from_millis(100),
                        retry_initial: Duration::from_millis(20),
                        retry_max: Duration::from_millis(100),
                    },
                },
                registration_rx,
            )
            .await
            .expect("MT4 session");
        let reconnect = reconnect_pipe_name(&terminal_id).expect("reconnect pipe");
        let ea_terminal_id = terminal_id.clone();
        let ea_terminal_data_path = terminal_data_path.clone();
        let ea = tokio::spawn(async move {
            let pipe_path = format!(r"\\.\pipe\{reconnect}");
            let mut pipe = open_pipe_when_ready(&pipe_path).await;
            write_frame(
                &mut pipe,
                &encode_hello(&Hello {
                    protocol_version: CURRENT_PROTOCOL_VERSION,
                    adapter_version: "3.2.5-test".to_owned(),
                    terminal_data_path: ea_terminal_data_path.to_string_lossy().into_owned(),
                    broker_server: "Broker-Demo".to_owned(),
                    login: "12345678".to_owned(),
                    connected: true,
                    trade_allowed: true,
                })
                .expect("hello"),
            )
            .await
            .expect("write hello");
            let welcome = decode_welcome(&read_frame(&mut pipe).await.expect("welcome"))
                .expect("decode welcome");
            assert_eq!(welcome.terminal_instance_id, ea_terminal_id);
            loop {
                let frame = read_frame(&mut pipe).await.expect("request");
                if decode_message_type(&frame, MessageType::Shutdown).is_ok() {
                    write_frame(&mut pipe, &encode_message_type(MessageType::ShutdownAck))
                        .await
                        .expect("shutdown ack");
                    break;
                }
                let message_type = i32::from_le_bytes(
                    frame
                        .get(..4)
                        .expect("message type")
                        .try_into()
                        .expect("message type bytes"),
                );
                if message_type == MessageType::DealsRequest as i32 {
                    write_frame(
                        &mut pipe,
                        &encode_deals(&DealsBatch {
                            source_time_msc: 1_800_000_000_000,
                            items: vec![serde_json::json!({
                                "category": "trade",
                                "ticket": "77",
                                "deal_ticket": "77",
                                "order_ticket": "77",
                                "position_id": "77",
                                "time_msc": 1_785_333_000_000_i64,
                                "side": "buy",
                                "symbol": "XAUUSD",
                                "volume": 0.01,
                                "price_open": 2000.0,
                                "price_close": 2001.0,
                                "profit": 1.0,
                                "commission": -0.1,
                                "swap": 0.0
                            })],
                            next_time_msc: 1_785_333_000_000,
                            next_ticket: 77,
                            has_more: false,
                        })
                        .expect("deals"),
                    )
                    .await
                    .expect("write deals");
                    continue;
                }
                if message_type == MessageType::Command as i32 {
                    let command = decode_command(&frame).expect("trade command");
                    write_frame(
                        &mut pipe,
                        &encode_command_result(&TradeResult {
                            command_id: command.command_id,
                            status: "succeeded".to_owned(),
                            error_code: None,
                            error_message: None,
                            broker_retcode: 0,
                            ticket: 501,
                            observed_at_utc_msc: 1_800_000_000_050,
                            raw_result: Some(serde_json::json!({ "ticket": "501" })),
                        })
                        .expect("trade result"),
                    )
                    .await
                    .expect("write trade result");
                    continue;
                }
                assert_eq!(
                    decode_collect(&frame).expect("collect"),
                    CollectionStreams::ALL
                );
                write_frame(
                    &mut pipe,
                    &encode_snapshot(&Snapshot {
                        source_time_msc: 1_800_000_000_000,
                        account: serde_json::json!({
                            "login": 12345678,
                            "server": "Broker-Demo",
                            "balance": 10000.0
                        }),
                        positions: vec![serde_json::json!({
                            "ticket": "9007199254740993",
                            "symbol": "XAUUSD"
                        })],
                        orders: vec![serde_json::json!({
                            "ticket": "42",
                            "symbol": "XAUUSD"
                        })],
                    })
                    .expect("snapshot"),
                )
                .await
                .expect("write snapshot");
            }
        });

        wait_mt4_ready(&handle).await;
        assert!(handle.status().mt4_expert_restart_required);
        let trade = handle
            .execute_command(CommandMessage {
                v: 3,
                message_type: "command".to_owned(),
                message_id: "message_01JMT4SESSION01".to_owned(),
                sent_at_utc_msc: 1_800_000_100_000,
                command_id: "command_01JMT4SESSION01".to_owned(),
                terminal_instance_id: terminal_id.clone(),
                account_ref: route.account_ref.clone(),
                connection_epoch: route.connection_epoch,
                issued_at_utc_msc: 1_800_000_100_000,
                deadline_utc_msc: 1_800_000_110_000,
                action: "place_order".to_owned(),
                params: serde_json::json!({
                    "symbol": "XAUUSD",
                    "side": "buy",
                    "order_kind": "market",
                    "volume": 0.01,
                    "comment": "AI-MT4-SESSION"
                }),
            })
            .await
            .expect("execute MT4 command");
        assert_eq!(trade.status, "succeeded");
        assert_eq!(trade.evidence.order_tickets, ["501"]);
        let projection = store
            .load_terminal_projection(&terminal_id, &route.account_ref, route.connection_epoch)
            .expect("projection");
        assert_eq!(projection.account.revision, 1);
        assert_eq!(projection.positions.revision, 1);
        assert_eq!(projection.orders.revision, 1);
        assert_eq!(projection.positions.items[0]["ticket"], "9007199254740993");
        let outbox = store
            .ready_for_terminals(
                1_800_000_100_000,
                Some(std::slice::from_ref(&terminal_id)),
                10,
            )
            .expect("outbox");
        assert_eq!(outbox.len(), 3);
        assert!(outbox.iter().all(|item| item.message_type == "data_delta"));
        assert_eq!(handle.freshness().streams.len(), 3);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = store
                    .history_archive_state(&terminal_id, &route.account_ref)
                    .expect("history state");
                if state.is_complete {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("MT4 history archived");
        assert_eq!(handle.status().history.state, HistorySyncState::Ready);
        assert_eq!(handle.status().history.consecutive_failures, 0);
        assert!(handle.status().history.last_success_at_utc_msc.is_some());
        let history = store
            .read_history_archive_page(
                &bridge_contract::TerminalDescriptor {
                    terminal_instance_id: terminal_id.clone(),
                    platform: "mt4".to_owned(),
                    account_ref: route.account_ref.clone(),
                    connection_epoch: route.connection_epoch,
                    worker_version: None,
                },
                &serde_json::json!({ "page": 1, "page_size": 20, "include_deals": true }),
            )
            .expect("history page");
        assert_eq!(history["orders"].as_array().expect("orders").len(), 1);
        assert_eq!(history["deals"].as_array().expect("deals").len(), 1);
        assert_eq!(history["orders"][0]["net_profit"], 0.9);

        manager.stop().await.expect("stop MT4 manager");
        ea.await.expect("EA task");
        drop(registration_tx);
        drop(manager);
        drop(handle);
        drop(store);
        fs::remove_dir_all(root).expect("remove session test directory");
    }

    #[tokio::test]
    async fn mt4_session_stops_promptly_while_waiting_for_the_ea() {
        let root = unique_test_directory();
        fs::create_dir_all(&root).expect("session test directory");
        let terminal_data_path = root.join("terminal-data");
        fs::create_dir_all(&terminal_data_path).expect("terminal data directory");
        let store =
            Arc::new(OutboxStore::open_or_create(root.join("bridge.db")).expect("session store"));
        let terminal_id = format!(
            "mt4_{:024x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        );
        let route = WorkerRoute {
            terminal_instance_id: terminal_id.clone(),
            platform: "mt4".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 1,
        };
        let manager = Mt4SessionManager::new(
            terminal_id,
            Arc::clone(&store),
            Arc::new(|| 1_800_000_100_000),
        )
        .expect("manager");
        let (_registration_tx, registration_rx) = mpsc::channel(1);
        let handle = manager
            .replace(
                Mt4SessionSpec {
                    route,
                    terminal_data_path,
                    accept_timeout: Duration::from_secs(20),
                    request_timeout: Duration::from_secs(10),
                    collector_policy: CollectorPolicy::default(),
                },
                registration_rx,
            )
            .await
            .expect("session");
        tokio::time::timeout(Duration::from_secs(1), manager.stop())
            .await
            .expect("stop should interrupt pipe accept")
            .expect("stop session");
        assert_eq!(handle.status().state, TerminalSessionState::Stopped);
        drop(handle);
        drop(manager);
        drop(store);
        fs::remove_dir_all(root).expect("remove session test directory");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn account_switch_stops_the_old_session_before_the_new_epoch_becomes_ready() {
        let root = unique_test_directory();
        fs::create_dir_all(&root).expect("session test directory");
        let terminal_path = root.join("terminal64.exe");
        fs::write(&terminal_path, []).expect("fake terminal");
        let store =
            Arc::new(OutboxStore::open_or_create(root.join("bridge.db")).expect("session store"));
        let registry = Arc::new(WorkerRegistry::new());
        let manager = Mt5SessionManager::new(
            "mt5_terminal_session_01".to_owned(),
            Arc::clone(&registry),
            Arc::clone(&store),
            Arc::new(|| 1_800_000_000_000),
        )
        .expect("session manager");

        let old = manager
            .replace(spec(1, &root, &terminal_path))
            .await
            .expect("old session");
        wait_ready(&old).await;
        let replacement = manager
            .replace(spec(2, &root, &terminal_path))
            .await
            .expect("replacement session");
        assert_eq!(old.status().state, TerminalSessionState::Stopped);
        assert_eq!(
            old.wake_after_command()
                .expect_err("old collector closed")
                .code(),
            "terminal_collector_stopped"
        );
        wait_ready(&replacement).await;
        assert_eq!(
            manager
                .current_status()
                .await
                .expect("current status")
                .route,
            route(2)
        );
        assert!(registry.resolve(&route(2)).await.is_ok());
        let freshness = replacement.freshness();
        assert_eq!(
            freshness.terminal_instance_id,
            route(2).terminal_instance_id
        );
        assert_eq!(freshness.connection_epoch, 2);
        assert_eq!(
            freshness
                .streams
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["account", "orders", "positions"]
        );
        assert!(freshness.streams.values().all(|observed| *observed > 0));
        assert_eq!(
            registry
                .resolve(&route(1))
                .await
                .err()
                .expect("old route rejected")
                .code(),
            "worker_registry_route_mismatch"
        );

        let rejected = match manager.replace(spec(1, &root, &terminal_path)).await {
            Ok(_) => panic!("epoch regression was accepted"),
            Err(error) => error,
        };
        assert_eq!(rejected.code(), "terminal_session_epoch_not_advanced");
        assert_eq!(replacement.status().state, TerminalSessionState::Ready);

        let mut invalid_policy = spec(3, &root, &terminal_path);
        invalid_policy.collector_policy.active_interval = Duration::ZERO;
        let rejected = match manager.replace(invalid_policy).await {
            Ok(_) => panic!("invalid collector policy was accepted"),
            Err(error) => error,
        };
        assert_eq!(rejected.code(), "terminal_collector_policy_invalid");
        assert_eq!(replacement.status().state, TerminalSessionState::Ready);

        manager.stop().await.expect("stop manager");
        assert_eq!(replacement.status().state, TerminalSessionState::Stopped);
        assert!(registry.is_empty().await);
        drop(manager);
        drop(store);
        drop(registry);
        fs::remove_dir_all(root).expect("remove session test directory");
    }

    #[test]
    fn transition_requires_the_same_terminal_and_a_monotonic_epoch() {
        assert!(validate_transition(&route(1), &route(1)).is_ok());
        assert!(validate_transition(&route(1), &route(2)).is_ok());
        assert_eq!(
            validate_transition(&route(2), &route(1))
                .expect_err("epoch regression")
                .code(),
            "terminal_session_epoch_not_advanced"
        );
        let mut other_terminal = route(2);
        other_terminal.terminal_instance_id = "mt5_terminal_other_01".to_owned();
        assert_eq!(
            validate_transition(&route(1), &other_terminal)
                .expect_err("terminal mismatch")
                .code(),
            "terminal_session_route_mismatch"
        );
    }

    #[test]
    fn active_regular_history_jobs_pause_before_archive_start() {
        assert!(history_job_should_pause("p2", true));
        assert!(history_job_should_pause("p3", true));
        assert!(!history_job_should_pause("p1", true));
        assert!(!history_job_should_pause("p2", false));
    }

    #[test]
    fn dynamic_history_window_obeys_density_latency_and_bounds() {
        assert_eq!(
            adjust_history_window(HISTORY_INITIAL_WINDOW_MSC, 250, Duration::from_secs(1)),
            HISTORY_INITIAL_WINDOW_MSC / 2
        );
        assert_eq!(
            adjust_history_window(HISTORY_INITIAL_WINDOW_MSC, 10, Duration::from_secs(5)),
            HISTORY_INITIAL_WINDOW_MSC / 2
        );
        assert_eq!(
            adjust_history_window(HISTORY_INITIAL_WINDOW_MSC, 10, Duration::from_secs(1)),
            HISTORY_INITIAL_WINDOW_MSC * 2
        );
        assert_eq!(
            adjust_history_window(HISTORY_MIN_WINDOW_MSC, 250, Duration::from_secs(5)),
            HISTORY_MIN_WINDOW_MSC
        );
        assert_eq!(
            adjust_history_window(HISTORY_MAX_WINDOW_MSC, 1, Duration::from_secs(1)),
            HISTORY_MAX_WINDOW_MSC
        );
    }

    #[test]
    fn dense_shrink_reaches_minimum_and_cross_restart_timeout_blocks() {
        let mut window = HISTORY_INITIAL_WINDOW_MSC;
        while window > HISTORY_MIN_WINDOW_MSC {
            let decision = history_error_decision(
                window,
                HistoryErrorKind::TooDense {
                    consecutive_at_min: 0,
                },
                0,
            );
            window = match decision {
                HistoryErrorDecision::RetrySameProcess { window_msc } => window_msc,
                other => panic!("unexpected density decision: {other:?}"),
            };
        }
        assert_eq!(window, HISTORY_MIN_WINDOW_MSC);
        assert_eq!(
            history_error_decision(
                HISTORY_MIN_WINDOW_MSC,
                HistoryErrorKind::TooDense {
                    consecutive_at_min: HISTORY_DENSE_RETRY_THRESHOLD - 1,
                },
                0,
            ),
            HistoryErrorDecision::RetrySameProcess {
                window_msc: HISTORY_MIN_WINDOW_MSC,
            }
        );
        assert_eq!(
            history_error_decision(
                HISTORY_MIN_WINDOW_MSC,
                HistoryErrorKind::TooDense {
                    consecutive_at_min: HISTORY_DENSE_RETRY_THRESHOLD,
                },
                0,
            ),
            HistoryErrorDecision::Block
        );
        assert_eq!(
            history_error_decision(
                HISTORY_MIN_WINDOW_MSC,
                HistoryErrorKind::Timeout,
                HISTORY_DENSE_RETRY_THRESHOLD - 1,
            ),
            HistoryErrorDecision::Block
        );
        assert_eq!(
            history_error_decision(HISTORY_INITIAL_WINDOW_MSC, HistoryErrorKind::Other, 0,),
            HistoryErrorDecision::RestartArchive {
                window_msc: HISTORY_INITIAL_WINDOW_MSC,
            }
        );
        assert_eq!(
            min_timeout_count_from_code(Some("history_timeout_min_1")),
            1
        );
        assert_eq!(
            min_timeout_count_from_code(Some("history_timeout_min_2")),
            2
        );
        assert_eq!(
            min_timeout_count_from_code(Some("history_timeout_min_3")),
            3
        );
        assert_eq!(
            min_timeout_count_from_code(Some("history_timeout_min_invalid")),
            0
        );
        assert!(
            min_timeout_count_from_code(Some("history_timeout_min_3"))
                >= HISTORY_DENSE_RETRY_THRESHOLD
        );
    }

    #[test]
    fn regular_planning_waits_only_for_an_existing_recent_job() {
        let mut planned = BTreeMap::new();
        planned.insert("p2-retrying".to_owned(), "recent".to_owned());
        assert!(!regular_job_planning_allowed(&planned));
        planned.clear();
        planned.insert("p1-on-demand".to_owned(), "on_demand".to_owned());
        assert!(regular_job_planning_allowed(&planned));
        planned.clear();
        planned.insert("legacy-p3".to_owned(), "backfill".to_owned());
        assert!(regular_job_planning_allowed(&planned));
    }

    #[tokio::test]
    async fn automatic_recent_planning_uses_atomic_store_planner() {
        let root = unique_test_directory();
        fs::create_dir_all(&root).expect("planner test directory");
        let store = Arc::new(
            OutboxStore::open_or_create(root.join("bridge.db")).expect("planner test store"),
        );
        let scope = HistoryScope::new(
            "mt5_terminal_history_01",
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
        )
        .expect("planner test scope");
        let first = ensure_history_jobs(&store, &scope, 1_800_000_000_000)
            .await
            .expect("first automatic plan");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].job_kind, "recent");
        assert_eq!(first[0].priority, "p2");
        let second = ensure_history_jobs(&store, &scope, 1_800_000_000_000)
            .await
            .expect("idempotent automatic plan");
        assert_eq!(
            first.iter().map(|job| &job.job_id).collect::<Vec<_>>(),
            second.iter().map(|job| &job.job_id).collect::<Vec<_>>()
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove planner test directory");
    }

    fn unique_test_directory() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-terminal-session-{}-{stamp}",
            std::process::id()
        ))
    }
}
