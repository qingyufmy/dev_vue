use bridge_foundation::{
    BridgeProfilePaths, MT5_WORKER_RELATIVE_PATH, PYTHON_RELATIVE_PATH, resolve_profile_paths,
};
use bridge_runtime_win::RestartPolicy;
use bridge_security_win::CredentialStore;
use bridge_store::{OutboxStore, TerminalBinding};
use bridge_terminal_data::CollectorPolicy;
use bridge_terminal_session::Mt5SessionSpec;
use bridge_worker_host::{WorkerProgram, WorkerRoute};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const WORKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

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

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::AccountRef;
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
