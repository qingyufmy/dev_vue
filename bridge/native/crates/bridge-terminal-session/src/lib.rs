use bridge_contract::TerminalStreamFreshness;
use bridge_mt4::{Mt4EaSnapshotSource, Mt4SnapshotSourceSpec};
use bridge_runtime_win::RestartPolicy;
use bridge_store::{HistoryArchiveBatch, HistoryCursor, OutboxStore};
use bridge_terminal_data::{
    CollectorHandle, CollectorLifecycleState, CollectorPolicy, SnapshotCollector, SnapshotProjector,
};
use bridge_worker_host::{
    WorkerCapability, WorkerDataResult, WorkerDataRouter, WorkerHistoryCursor, WorkerHostError,
    WorkerLifecycleState, WorkerProgram, WorkerRegistry, WorkerRoute, WorkerSupervisor,
    WorkerSupervisorHandle,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::{Mutex, Notify, mpsc, watch};
use tokio::task::JoinHandle;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const HISTORY_ARCHIVE_START_MSC: i64 = 946_684_800_000;
const HISTORY_BATCH_LIMIT: u16 = 250;
const HISTORY_COMPLETE_INTERVAL: Duration = Duration::from_secs(30);
const HISTORY_RETRY_MINIMUM: Duration = Duration::from_secs(2);
const HISTORY_RETRY_MAXIMUM: Duration = Duration::from_secs(30);

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
}

#[derive(Clone)]
pub struct TerminalSessionHandle {
    route: WorkerRoute,
    worker: WorkerSupervisorHandle,
    data: Arc<WorkerDataRouter<NamedPipeServer>>,
    collector: CollectorHandle,
    history: HistorySyncHandle,
}

#[derive(Clone)]
pub struct Mt4SessionHandle {
    route: WorkerRoute,
    source: Arc<Mt4EaSnapshotSource>,
    collector: CollectorHandle,
    history: HistorySyncHandle,
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
            error_code: collector.error_code.or(worker.error_code),
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
    registry: Arc<WorkerRegistry<NamedPipeServer>>,
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
    pub fn new(
        terminal_instance_id: String,
        registry: Arc<WorkerRegistry<NamedPipeServer>>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        if terminal_instance_id.trim() != terminal_instance_id || terminal_instance_id.is_empty() {
            return Err(TerminalSessionError::new("terminal_session_id_invalid"));
        }
        Ok(Self {
            terminal_instance_id,
            registry,
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
        }
        if let Some(active) = current.take() {
            active.stop().await?;
        }
        let active = RunningSession::start(
            spec,
            Arc::clone(&self.registry),
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
}

impl RunningSession {
    fn start(
        spec: Mt5SessionSpec,
        registry: Arc<WorkerRegistry<NamedPipeServer>>,
        store: Arc<OutboxStore>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Self, TerminalSessionError> {
        let supervisor = Arc::new(
            WorkerSupervisor::new(
                spec.program,
                spec.route.clone(),
                [
                    WorkerCapability::Snapshot,
                    WorkerCapability::Quote,
                    WorkerCapability::Data,
                    WorkerCapability::HistorySync,
                ]
                .into(),
                spec.startup_timeout,
                spec.worker_restart_policy,
                Arc::clone(&registry),
            )
            .map_err(worker_error)?,
        );
        let worker = supervisor.handle();
        let router = Arc::new(
            WorkerDataRouter::new(registry, Arc::clone(&clock), spec.request_timeout)
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
        let history_state = store
            .history_archive_state(&terminal.terminal_instance_id, &terminal.account_ref)
            .map_err(|error| TerminalSessionError::new(error.code()))?;
        let initial_cursor = if history_state.cursor == HistoryCursor::default() {
            HistoryCursor {
                time_msc: HISTORY_ARCHIVE_START_MSC,
                ticket: "0".to_owned(),
            }
        } else {
            history_state.cursor
        };
        let (history, history_task) = start_history_sync(
            Arc::clone(&router),
            Arc::clone(&store),
            terminal,
            initial_cursor,
            history_state.is_complete,
            clock,
        );
        let worker_task = tokio::spawn({
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.run().await }
        });
        let collector_task = tokio::spawn(collector.run());
        Ok(Self {
            handle: TerminalSessionHandle {
                route: spec.route,
                worker,
                data: router,
                collector: collector_handle,
                history,
            },
            worker_task,
            collector_task,
            history_task,
        })
    }

    async fn stop(mut self) -> Result<(), TerminalSessionError> {
        self.handle.collector.stop();
        await_task(&mut self.collector_task, "terminal_collector_stop_timeout").await?;
        self.handle.history.stop();
        await_task(&mut self.history_task, "terminal_history_stop_timeout").await?;
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
                time_msc: HISTORY_ARCHIVE_START_MSC,
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
        let (collector, collector_handle) =
            SnapshotCollector::new(Arc::clone(&source), projector, clock, spec.collector_policy)
                .map_err(projection_error)?;
        let collector_task = tokio::spawn(collector.run());
        Ok(Self {
            handle: Mt4SessionHandle {
                route: spec.route,
                source,
                collector: collector_handle,
                history,
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
}

impl HistorySyncHandle {
    fn stop(&self) {
        self.stop_tx.send_replace(true);
        self.wake.notify_one();
    }

    fn wake(&self) {
        self.wake.notify_one();
    }
}

fn start_history_sync<S>(
    router: Arc<WorkerDataRouter<S>>,
    store: Arc<OutboxStore>,
    terminal: bridge_contract::TerminalDescriptor,
    initial_cursor: HistoryCursor,
    initially_complete: bool,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> (HistorySyncHandle, JoinHandle<()>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let wake = Arc::new(Notify::new());
    let handle = HistorySyncHandle {
        stop_tx,
        wake: Arc::clone(&wake),
    };
    let task = tokio::spawn(async move {
        let mut cursor = initial_cursor;
        let mut complete = initially_complete;
        let mut failures = 0_u32;
        let mut sequence = 0_u64;
        loop {
            if *stop_rx.borrow() {
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
                    if changed.is_err() || *stop_rx.borrow() { return; }
                    continue;
                }
                _ = wake.notified() => {}
                _ = tokio::time::sleep(delay) => {}
            }
            if *stop_rx.borrow() {
                return;
            }
            sequence = sequence.wrapping_add(1);
            let now = clock();
            if now <= 0 {
                failures = failures.saturating_add(1);
                continue;
            }
            let request_cursor = WorkerHistoryCursor {
                time_msc: cursor.time_msc,
                ticket: cursor.ticket.clone(),
            };
            let result = router
                .history_sync(
                    WorkerRoute::from_terminal(&terminal).expect("validated history terminal"),
                    format!("history_sync_{now:x}_{sequence:x}"),
                    request_cursor,
                    HISTORY_BATCH_LIMIT,
                )
                .await;
            let Ok(batch) = result else {
                failures = failures.saturating_add(1);
                continue;
            };
            let stored = HistoryArchiveBatch {
                deals: batch.deals,
                history_orders: batch.history_orders,
                trades: batch.trades,
                next_cursor: HistoryCursor {
                    time_msc: batch.next_cursor.time_msc,
                    ticket: batch.next_cursor.ticket,
                },
                has_more: batch.has_more,
                observed_at_utc_msc: batch.observed_at_utc_msc,
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
                }
                _ => failures = failures.saturating_add(1),
            }
        }
    });
    (handle, task)
}

fn start_mt4_history_sync(
    source: Arc<Mt4EaSnapshotSource>,
    store: Arc<OutboxStore>,
    terminal: bridge_contract::TerminalDescriptor,
    initial_cursor: HistoryCursor,
    initially_complete: bool,
) -> (HistorySyncHandle, JoinHandle<()>) {
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let wake = Arc::new(Notify::new());
    let handle = HistorySyncHandle {
        stop_tx,
        wake: Arc::clone(&wake),
    };
    let task = tokio::spawn(async move {
        let mut cursor = initial_cursor;
        let mut complete = initially_complete;
        let mut failures = 0_u32;
        loop {
            if *stop_rx.borrow() {
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
                    if changed.is_err() || *stop_rx.borrow() { return; }
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
                    continue;
                }
            };
            let batch = source
                .collect_deals(
                    cursor.time_msc,
                    cursor_ticket,
                    i32::from(HISTORY_BATCH_LIMIT),
                    30 * 24 * 60 * 60 * 1_000,
                )
                .await;
            let Ok(batch) = batch else {
                failures = failures.saturating_add(1);
                continue;
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
                deals: batch.items.clone(),
                history_orders: batch.items,
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
                }
                _ => failures = failures.saturating_add(1),
            }
        }
    });
    (handle, task)
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

fn projection_error(error: bridge_terminal_data::ProjectionError) -> TerminalSessionError {
    TerminalSessionError::new(error.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::AccountRef;
    use bridge_mt4::{
        CURRENT_PROTOCOL_VERSION, CollectionStreams, DealsBatch, Hello, MessageType, Snapshot,
        decode_collect, decode_message_type, decode_welcome, encode_deals, encode_hello,
        encode_message_type, encode_snapshot, read_frame, reconnect_pipe_name, write_frame,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};
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
                    adapter_version: "3.2.4-test".to_owned(),
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
