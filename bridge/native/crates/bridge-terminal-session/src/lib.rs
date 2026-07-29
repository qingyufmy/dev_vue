use bridge_contract::TerminalStreamFreshness;
use bridge_runtime_win::RestartPolicy;
use bridge_store::OutboxStore;
use bridge_terminal_data::{
    CollectorHandle, CollectorLifecycleState, CollectorPolicy, SnapshotCollector, SnapshotProjector,
};
use bridge_worker_host::{
    WorkerCapability, WorkerDataRouter, WorkerHostError, WorkerLifecycleState, WorkerProgram,
    WorkerRegistry, WorkerRoute, WorkerSupervisor, WorkerSupervisorHandle,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

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
    collector: CollectorHandle,
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
                [WorkerCapability::Snapshot, WorkerCapability::Quote].into(),
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
        let projector =
            SnapshotProjector::restore(store, spec.route.clone()).map_err(projection_error)?;
        let (collector, collector_handle) =
            SnapshotCollector::new(router, projector, clock, spec.collector_policy)
                .map_err(projection_error)?;
        let worker_task = tokio::spawn({
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.run().await }
        });
        let collector_task = tokio::spawn(collector.run());
        Ok(Self {
            handle: TerminalSessionHandle {
                route: spec.route,
                worker,
                collector: collector_handle,
            },
            worker_task,
            collector_task,
        })
    }

    async fn stop(mut self) -> Result<(), TerminalSessionError> {
        self.handle.collector.stop();
        await_task(&mut self.collector_task, "terminal_collector_stop_timeout").await?;
        self.handle.worker.request_stop();
        let worker_result =
            await_task(&mut self.worker_task, "terminal_worker_stop_timeout").await?;
        worker_result.map_err(worker_error)
    }
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

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
