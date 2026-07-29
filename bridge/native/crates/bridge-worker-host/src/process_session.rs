use crate::{
    ExpectedWorker, WorkerCapability, WorkerClient, WorkerEndpoint, WorkerHostError,
    WorkerPipeListener, WorkerRoute,
};
use bridge_runtime_win::{ManagedProcess, ProcessSpec};
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::windows::named_pipe::NamedPipeServer;

pub const WORKER_PIPE_ENV: &str = "AURUM_BRIDGE_WORKER_PIPE";
pub const WORKER_NONCE_ENV: &str = "AURUM_BRIDGE_WORKER_NONCE";
pub const WORKER_IPC_VERSION_ENV: &str = "AURUM_BRIDGE_WORKER_IPC_VERSION";
pub const WORKER_TERMINAL_ID_ENV: &str = "AURUM_BRIDGE_WORKER_TERMINAL_ID";
pub const WORKER_PLATFORM_ENV: &str = "AURUM_BRIDGE_WORKER_PLATFORM";
pub const WORKER_BROKER_SERVER_ENV: &str = "AURUM_BRIDGE_WORKER_BROKER_SERVER";
pub const WORKER_LOGIN_ENV: &str = "AURUM_BRIDGE_WORKER_LOGIN";
pub const WORKER_CONNECTION_EPOCH_ENV: &str = "AURUM_BRIDGE_WORKER_CONNECTION_EPOCH";

pub struct WorkerProgram {
    process: ProcessSpec,
}

impl WorkerProgram {
    pub fn new(
        executable: impl AsRef<Path>,
        working_directory: impl AsRef<Path>,
    ) -> Result<Self, WorkerHostError> {
        Ok(Self {
            process: ProcessSpec::new(executable, working_directory).map_err(runtime_error)?,
        })
    }

    pub fn arg(mut self, value: impl Into<OsString>) -> Self {
        self.process = self.process.arg(value);
        self
    }

    pub fn env(
        mut self,
        name: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> Result<Self, WorkerHostError> {
        let name = name.into();
        if reserved_environment(&name) {
            return Err(WorkerHostError::new("worker_program_reserved_environment"));
        }
        self.process = self.process.env(name, value).map_err(runtime_error)?;
        Ok(self)
    }

    pub fn show_window(mut self, show_window: bool) -> Self {
        self.process = self.process.show_window(show_window);
        self
    }

    fn into_process_spec(
        mut self,
        endpoint: &WorkerEndpoint,
        route: &WorkerRoute,
    ) -> Result<ProcessSpec, WorkerHostError> {
        for (name, value) in [
            (WORKER_PIPE_ENV, endpoint.pipe_name().to_owned()),
            (WORKER_NONCE_ENV, endpoint.session_nonce().to_owned()),
            (
                WORKER_IPC_VERSION_ENV,
                crate::WORKER_IPC_VERSION.to_string(),
            ),
            (WORKER_TERMINAL_ID_ENV, route.terminal_instance_id.clone()),
            (WORKER_PLATFORM_ENV, route.platform.clone()),
            (
                WORKER_BROKER_SERVER_ENV,
                route.account_ref.broker_server.clone(),
            ),
            (WORKER_LOGIN_ENV, route.account_ref.login.clone()),
            (
                WORKER_CONNECTION_EPOCH_ENV,
                route.connection_epoch.to_string(),
            ),
        ] {
            self.process = self.process.env(name, value).map_err(runtime_error)?;
        }
        Ok(self.process)
    }
}

pub struct WorkerProcessSession {
    process: ManagedProcess,
    client: Arc<WorkerClient<NamedPipeServer>>,
    endpoint: WorkerEndpoint,
}

impl WorkerProcessSession {
    pub async fn launch(
        program: WorkerProgram,
        route: WorkerRoute,
        required_capabilities: BTreeSet<WorkerCapability>,
        startup_timeout: Duration,
    ) -> Result<Self, WorkerHostError> {
        route.validate()?;
        if required_capabilities.is_empty() {
            return Err(WorkerHostError::new("worker_start_capabilities_invalid"));
        }
        if startup_timeout.is_zero() {
            return Err(WorkerHostError::new("worker_start_timeout_invalid"));
        }
        let listener = WorkerPipeListener::bind_new()?;
        let endpoint = listener.endpoint().clone();
        let process_spec = program.into_process_spec(&endpoint, &route)?;
        let process = ManagedProcess::spawn(&process_spec).map_err(runtime_error)?;
        let expected = ExpectedWorker {
            session_nonce: endpoint.session_nonce().to_owned(),
            route,
            required_capabilities,
        };
        let client = listener.accept(expected, startup_timeout).await?;
        Ok(Self {
            process,
            client: Arc::new(client),
            endpoint,
        })
    }

    pub fn client(&self) -> Arc<WorkerClient<NamedPipeServer>> {
        Arc::clone(&self.client)
    }

    pub fn endpoint(&self) -> &WorkerEndpoint {
        &self.endpoint
    }

    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    pub fn is_running(&mut self) -> Result<bool, WorkerHostError> {
        Ok(self.process.try_wait().map_err(runtime_error)?.is_none())
    }

    pub fn terminate(&mut self) -> Result<(), WorkerHostError> {
        self.process.terminate().map_err(runtime_error)
    }
}

fn reserved_environment(name: &OsStr) -> bool {
    name.to_string_lossy()
        .to_ascii_uppercase()
        .starts_with("AURUM_BRIDGE_WORKER_")
}

fn runtime_error(error: bridge_runtime_win::RuntimeError) -> WorkerHostError {
    WorkerHostError::new(error.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{WorkerHello, write_frame};
    use bridge_contract::AccountRef;
    use std::env;
    use tokio::net::windows::named_pipe::ClientOptions;

    const HELPER_FLAG: &str = "AURUM_TEST_WORKER_HELPER";

    fn route() -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_process_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 9,
        }
    }

    #[test]
    fn worker_process_helper_entry() {
        if env::var(HELPER_FLAG).as_deref() != Ok("1") {
            return;
        }
        let pipe_name = env::var(WORKER_PIPE_ENV).expect("pipe env");
        let nonce = env::var(WORKER_NONCE_ENV).expect("nonce env");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("runtime");
        runtime.block_on(async move {
            let path = format!(r"\\.\pipe\{pipe_name}");
            let mut stream = ClientOptions::new().open(path).expect("worker connect");
            write_frame(
                &mut stream,
                &WorkerHello {
                    ipc_v: env::var(WORKER_IPC_VERSION_ENV)
                        .expect("version env")
                        .parse()
                        .expect("version"),
                    message_type: "worker_hello".to_owned(),
                    session_nonce: nonce,
                    worker_version: "3.0.0-alpha.1".to_owned(),
                    route: WorkerRoute {
                        terminal_instance_id: env::var(WORKER_TERMINAL_ID_ENV)
                            .expect("terminal env"),
                        platform: env::var(WORKER_PLATFORM_ENV).expect("platform env"),
                        account_ref: AccountRef {
                            broker_server: env::var(WORKER_BROKER_SERVER_ENV).expect("broker env"),
                            login: env::var(WORKER_LOGIN_ENV).expect("login env"),
                        },
                        connection_epoch: env::var(WORKER_CONNECTION_EPOCH_ENV)
                            .expect("epoch env")
                            .parse()
                            .expect("epoch"),
                    },
                    capabilities: vec![WorkerCapability::QueryExecution],
                },
            )
            .await
            .expect("hello");
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
    }

    #[tokio::test]
    async fn launched_worker_is_handshaken_and_killed_with_its_job() {
        let executable = env::current_exe().expect("test executable");
        let working_directory = executable.parent().expect("test directory");
        let program = WorkerProgram::new(&executable, working_directory)
            .expect("program")
            .arg("process_session::tests::worker_process_helper_entry")
            .arg("--exact")
            .arg("--nocapture")
            .env(HELPER_FLAG, "1")
            .expect("helper env");
        let mut session = WorkerProcessSession::launch(
            program,
            route(),
            BTreeSet::from([WorkerCapability::QueryExecution]),
            Duration::from_secs(5),
        )
        .await
        .expect("worker session");
        assert!(session.client().is_healthy());
        assert!(session.is_running().expect("running"));
        assert_ne!(session.process_id(), 0);
        session.terminate().expect("terminate job");
        assert!(!session.is_running().expect("stopped"));
    }

    #[test]
    fn reserved_worker_environment_cannot_be_overridden() {
        let executable = env::current_exe().expect("test executable");
        let working_directory = executable.parent().expect("test directory");
        let error = WorkerProgram::new(&executable, working_directory)
            .expect("program")
            .env(WORKER_NONCE_ENV, "attacker-controlled")
            .err()
            .expect("reserved env");
        assert_eq!(error.code(), "worker_program_reserved_environment");
    }
}
