use crate::{
    WorkerCapability, WorkerHostError, WorkerProcessSession, WorkerProgram, WorkerRegistry,
    WorkerRoute,
};
use bridge_runtime_win::RestartPolicy;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::net::windows::named_pipe::NamedPipeServer;
use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerLifecycleState {
    Starting,
    Ready,
    Restarting,
    Superseded,
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLifecycleSnapshot {
    pub state: WorkerLifecycleState,
    pub route: WorkerRoute,
    pub consecutive_failures: u32,
    pub client_generation: Option<u64>,
    pub process_id: Option<u32>,
    pub error_code: Option<String>,
}

#[derive(Clone)]
pub struct WorkerSupervisorHandle {
    stop: watch::Sender<bool>,
    status: watch::Receiver<WorkerLifecycleSnapshot>,
}

impl WorkerSupervisorHandle {
    pub fn request_stop(&self) {
        self.stop.send_replace(true);
    }

    pub fn status(&self) -> WorkerLifecycleSnapshot {
        self.status.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<WorkerLifecycleSnapshot> {
        self.status.clone()
    }
}

pub struct WorkerSupervisor {
    program: WorkerProgram,
    route: WorkerRoute,
    required_capabilities: BTreeSet<WorkerCapability>,
    startup_timeout: Duration,
    policy: RestartPolicy,
    registry: Arc<WorkerRegistry<NamedPipeServer>>,
    stop: watch::Sender<bool>,
    status: watch::Sender<WorkerLifecycleSnapshot>,
    started: AtomicBool,
}

impl WorkerSupervisor {
    pub fn new(
        program: WorkerProgram,
        route: WorkerRoute,
        required_capabilities: BTreeSet<WorkerCapability>,
        startup_timeout: Duration,
        policy: RestartPolicy,
        registry: Arc<WorkerRegistry<NamedPipeServer>>,
    ) -> Result<Self, WorkerHostError> {
        route.validate()?;
        if required_capabilities.is_empty() {
            return Err(WorkerHostError::new(
                "worker_supervisor_capabilities_invalid",
            ));
        }
        if startup_timeout.is_zero() {
            return Err(WorkerHostError::new("worker_supervisor_timeout_invalid"));
        }
        policy
            .validate()
            .map_err(|error| WorkerHostError::new(error.code()))?;
        let (stop, _) = watch::channel(false);
        let (status, _) = watch::channel(WorkerLifecycleSnapshot {
            state: WorkerLifecycleState::Stopped,
            route: route.clone(),
            consecutive_failures: 0,
            client_generation: None,
            process_id: None,
            error_code: None,
        });
        Ok(Self {
            program,
            route,
            required_capabilities,
            startup_timeout,
            policy,
            registry,
            stop,
            status,
            started: AtomicBool::new(false),
        })
    }

    pub fn handle(&self) -> WorkerSupervisorHandle {
        WorkerSupervisorHandle {
            stop: self.stop.clone(),
            status: self.status.subscribe(),
        }
    }

    pub async fn run(&self) -> Result<(), WorkerHostError> {
        if self.started.swap(true, Ordering::AcqRel) {
            return Err(WorkerHostError::new("worker_supervisor_already_running"));
        }
        let claim = self.registry.claim(self.route.clone()).await?;
        let mut stop = self.stop.subscribe();
        let mut failures = 0_u32;
        let mut superseded = false;
        let mut terminal_error = None;

        while !*stop.borrow() {
            if !self.registry.is_claim_current(&claim).await {
                superseded = true;
                break;
            }
            self.publish(
                if failures == 0 {
                    WorkerLifecycleState::Starting
                } else {
                    WorkerLifecycleState::Restarting
                },
                failures,
                None,
                None,
                None,
            );
            let launch = WorkerProcessSession::launch(
                self.program.clone(),
                self.route.clone(),
                self.required_capabilities.clone(),
                self.startup_timeout,
            );
            let launched = tokio::select! {
                changed = stop.changed() => {
                    let _ = changed;
                    None
                }
                result = launch => Some(result)
            };
            let Some(launched) = launched else {
                break;
            };
            let mut session = match launched {
                Ok(session) => session,
                Err(error) => {
                    if !self.registry.is_claim_current(&claim).await {
                        superseded = true;
                        break;
                    }
                    failures = increment_failures(failures, self.policy.maximum_failure_counter);
                    self.publish(
                        WorkerLifecycleState::Restarting,
                        failures,
                        None,
                        None,
                        Some(error.code()),
                    );
                    match self.wait_before_restart(&claim, &mut stop, failures).await {
                        WaitOutcome::Continue => continue,
                        WaitOutcome::Stopped => break,
                        WaitOutcome::Superseded => {
                            superseded = true;
                            break;
                        }
                    }
                }
            };
            let process_id = session.process_id();
            let lease = match self
                .registry
                .install_claimed(&claim, session.client())
                .await
            {
                Ok(lease) => lease,
                Err(error) if error.code() == "worker_supervisor_superseded" => {
                    if let Err(error) = session.terminate() {
                        terminal_error = Some(error);
                    }
                    superseded = true;
                    break;
                }
                Err(error) => {
                    let _ = session.terminate();
                    terminal_error = Some(error);
                    break;
                }
            };
            self.publish(
                WorkerLifecycleState::Ready,
                failures,
                Some(lease.generation()),
                Some(process_id),
                None,
            );
            let started_at = Instant::now();
            let mut stable_reset = false;
            let active = loop {
                tokio::select! {
                    changed = stop.changed() => {
                        let _ = changed;
                        break ActiveOutcome::Stopped;
                    }
                    () = tokio::time::sleep(self.policy.poll_interval) => {}
                }
                if !self.registry.is_claim_current(&claim).await {
                    break ActiveOutcome::Superseded;
                }
                if !session.client().is_healthy() {
                    break ActiveOutcome::Failed("worker_channel_unavailable");
                }
                match session.is_running() {
                    Ok(true) => {}
                    Ok(false) => break ActiveOutcome::Failed("bridge_worker_process_exited"),
                    Err(error) => break ActiveOutcome::OwnedFailure(error),
                }
                if !stable_reset && started_at.elapsed() >= self.policy.stable_run_threshold {
                    failures = 0;
                    stable_reset = true;
                    self.publish(
                        WorkerLifecycleState::Ready,
                        failures,
                        Some(lease.generation()),
                        Some(process_id),
                        None,
                    );
                }
            };
            self.registry
                .remove_if_generation(&self.route.terminal_instance_id, lease.generation())
                .await;
            if let Err(error) = session.terminate() {
                terminal_error = Some(error);
                break;
            }
            match active {
                ActiveOutcome::Stopped => break,
                ActiveOutcome::Superseded => {
                    superseded = true;
                    break;
                }
                ActiveOutcome::Failed(error_code) => {
                    failures = increment_failures(failures, self.policy.maximum_failure_counter);
                    self.publish(
                        WorkerLifecycleState::Restarting,
                        failures,
                        None,
                        None,
                        Some(error_code),
                    );
                }
                ActiveOutcome::OwnedFailure(error) => {
                    terminal_error = Some(error);
                    break;
                }
            }
            match self.wait_before_restart(&claim, &mut stop, failures).await {
                WaitOutcome::Continue => {}
                WaitOutcome::Stopped => break,
                WaitOutcome::Superseded => {
                    superseded = true;
                    break;
                }
            }
        }

        self.registry.release_claim(&claim).await;
        self.publish(
            if superseded {
                WorkerLifecycleState::Superseded
            } else {
                WorkerLifecycleState::Stopped
            },
            failures,
            None,
            None,
            terminal_error.as_ref().map(|error| error.code()),
        );
        if let Some(error) = terminal_error {
            Err(error)
        } else {
            Ok(())
        }
    }

    async fn wait_before_restart(
        &self,
        claim: &crate::WorkerClaim,
        stop: &mut watch::Receiver<bool>,
        failures: u32,
    ) -> WaitOutcome {
        let deadline = Instant::now() + self.policy.restart_delay(failures);
        loop {
            if *stop.borrow() {
                return WaitOutcome::Stopped;
            }
            if !self.registry.is_claim_current(claim).await {
                return WaitOutcome::Superseded;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return WaitOutcome::Continue;
            }
            tokio::select! {
                changed = stop.changed() => {
                    let _ = changed;
                }
                () = tokio::time::sleep(remaining.min(self.policy.poll_interval)) => {}
            }
        }
    }

    fn publish(
        &self,
        state: WorkerLifecycleState,
        consecutive_failures: u32,
        client_generation: Option<u64>,
        process_id: Option<u32>,
        error_code: Option<&str>,
    ) {
        self.status.send_replace(WorkerLifecycleSnapshot {
            state,
            route: self.route.clone(),
            consecutive_failures,
            client_generation,
            process_id,
            error_code: error_code.map(str::to_owned),
        });
    }
}

enum ActiveOutcome {
    Stopped,
    Superseded,
    Failed(&'static str),
    OwnedFailure(WorkerHostError),
}

enum WaitOutcome {
    Continue,
    Stopped,
    Superseded,
}

fn increment_failures(current: u32, maximum: u32) -> u32 {
    current.saturating_add(1).min(maximum)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::AccountRef;
    use std::env;

    fn route(epoch: i64) -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_supervisor_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: if epoch == 1 { "111111" } else { "222222" }.to_owned(),
            },
            connection_epoch: epoch,
        }
    }

    fn program(lifetime_msc: u64) -> WorkerProgram {
        let executable = env::current_exe().expect("test executable");
        let working_directory = executable.parent().expect("test directory");
        WorkerProgram::new(&executable, working_directory)
            .expect("program")
            .arg("process_session::tests::worker_process_helper_entry")
            .arg("--exact")
            .arg("--nocapture")
            .env("AURUM_TEST_WORKER_HELPER", "1")
            .expect("helper env")
            .env("AURUM_TEST_WORKER_LIFETIME_MSC", lifetime_msc.to_string())
            .expect("lifetime env")
    }

    fn policy() -> RestartPolicy {
        RestartPolicy {
            stable_run_threshold: Duration::from_secs(5),
            poll_interval: Duration::from_millis(10),
            restart_delays: [Duration::from_millis(20); 5],
            maximum_failure_counter: 8,
        }
    }

    async fn wait_for_ready_generation(
        status: &mut watch::Receiver<WorkerLifecycleSnapshot>,
        after: Option<u64>,
    ) -> u64 {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = status.borrow().clone();
                if snapshot.state == WorkerLifecycleState::Ready
                    && snapshot
                        .client_generation
                        .is_some_and(|generation| after.is_none_or(|old| generation > old))
                {
                    return snapshot.client_generation.expect("generation");
                }
                status.changed().await.expect("status change");
            }
        })
        .await
        .expect("ready timeout")
    }

    #[tokio::test]
    async fn crashed_worker_restarts_with_a_new_fenced_generation_and_stops_cleanly() {
        let registry = Arc::new(WorkerRegistry::new());
        let supervisor = Arc::new(
            WorkerSupervisor::new(
                program(60),
                route(1),
                BTreeSet::from([WorkerCapability::QueryExecution]),
                Duration::from_secs(2),
                policy(),
                Arc::clone(&registry),
            )
            .expect("supervisor"),
        );
        let handle = supervisor.handle();
        let mut status = handle.subscribe();
        let running = tokio::spawn({
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.run().await }
        });
        let first = wait_for_ready_generation(&mut status, None).await;
        let second = wait_for_ready_generation(&mut status, Some(first)).await;
        assert!(second > first);
        handle.request_stop();
        running.await.expect("run task").expect("run");
        assert!(registry.is_empty().await);
        assert_eq!(handle.status().state, WorkerLifecycleState::Stopped);
    }

    #[tokio::test]
    async fn a_new_account_claim_supersedes_the_old_supervisor_without_route_fighting() {
        let registry = Arc::new(WorkerRegistry::new());
        let old = Arc::new(
            WorkerSupervisor::new(
                program(30_000),
                route(1),
                BTreeSet::from([WorkerCapability::QueryExecution]),
                Duration::from_secs(2),
                policy(),
                Arc::clone(&registry),
            )
            .expect("old supervisor"),
        );
        let old_handle = old.handle();
        let mut old_status = old_handle.subscribe();
        let old_run = tokio::spawn({
            let old = Arc::clone(&old);
            async move { old.run().await }
        });
        wait_for_ready_generation(&mut old_status, None).await;

        let new = Arc::new(
            WorkerSupervisor::new(
                program(30_000),
                route(2),
                BTreeSet::from([WorkerCapability::QueryExecution]),
                Duration::from_secs(2),
                policy(),
                Arc::clone(&registry),
            )
            .expect("new supervisor"),
        );
        let new_handle = new.handle();
        let mut new_status = new_handle.subscribe();
        let new_run = tokio::spawn({
            let new = Arc::clone(&new);
            async move { new.run().await }
        });
        wait_for_ready_generation(&mut new_status, None).await;
        old_run.await.expect("old task").expect("old run");
        assert_eq!(old_handle.status().state, WorkerLifecycleState::Superseded);
        assert_eq!(
            registry
                .resolve(&route(1))
                .await
                .err()
                .expect("old route rejected")
                .code(),
            "worker_registry_route_mismatch"
        );
        assert!(registry.resolve(&route(2)).await.is_ok());
        new_handle.request_stop();
        new_run.await.expect("new task").expect("new run");
        assert!(registry.is_empty().await);
    }

    #[tokio::test]
    async fn handshake_failure_retries_without_publishing_a_client_and_stops_cleanly() {
        let registry = Arc::new(WorkerRegistry::new());
        let failing_program = program(30_000)
            .env("AURUM_TEST_WORKER_BAD_NONCE", "1")
            .expect("bad nonce env");
        let supervisor = Arc::new(
            WorkerSupervisor::new(
                failing_program,
                route(1),
                BTreeSet::from([WorkerCapability::QueryExecution]),
                Duration::from_secs(2),
                policy(),
                Arc::clone(&registry),
            )
            .expect("supervisor"),
        );
        let handle = supervisor.handle();
        let mut status = handle.subscribe();
        let running = tokio::spawn({
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.run().await }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = status.borrow().clone();
                if snapshot.state == WorkerLifecycleState::Restarting
                    && snapshot.consecutive_failures >= 2
                    && snapshot.error_code.as_deref() == Some("worker_hello_nonce_mismatch")
                {
                    break;
                }
                status.changed().await.expect("status change");
            }
        })
        .await
        .expect("retry timeout");
        assert!(registry.is_empty().await);
        handle.request_stop();
        running.await.expect("run task").expect("run");
        assert_eq!(handle.status().state, WorkerLifecycleState::Stopped);
    }
}
