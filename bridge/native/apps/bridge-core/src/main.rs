mod mt4_expert_installer;
mod mt5_terminal_discovery;
mod observer_terminal;

use bridge_foundation::{
    CliMode, DEFAULT_PROFILE_ID, HealthCheckOptions, MT5_WORKER_RELATIVE_PATH,
    PYTHON_RELATIVE_PATH, StartupReadyOptions, default_data_directory, default_root_data_directory,
    list_observer_profiles, parse_cli, profile_instance_id, read_runtime_status_snapshot,
    resolve_installed_root, resolve_profile_paths, run_health_check, write_runtime_status_snapshot,
    write_startup_ready_signal,
};
use bridge_local_control::{
    EndpointSettingsSelection, LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction,
    LocalControlPipeServer, LocalControlResponse, LocalControlResult, ObserverProfileMutation,
    UiObserverProfile, UiObserverSource, UiStateSnapshot, UiStateStore, UiTerminalCandidate,
    UiTerminalStatus, UiUpdateNotice,
};
use bridge_observability::{BridgeLogger, LoggerConfig};
use bridge_preferences::{
    BridgePreferencesStore, BridgeUserPreferences, ObserverProfilePreferences,
};
use bridge_runtime_win::{
    AutoStartRegistration, InstanceAcquireResult, InstanceSignal, ProcessSpec, ProcessSupervisor,
    ProcessSupervisorHandle, RestartPolicy, SingleInstanceGuard, default_lock_directory,
};
use bridge_security_win::{BridgeCredential, CredentialStore};
use bridge_store::{OutboxStore, TerminalBinding};
use bridge_terminal_session::TerminalSessionState;
use bridge_transport::{
    BridgeAuthClient, ConnectionState, CredentialSource, ENDPOINT_SETTINGS_FILE_NAME,
    MaintenanceLeaseRequest, ManagedObserverSource, ServerEndpoints, SessionCancellation,
    clear_endpoint_settings, load_packaged_server_endpoints, resolve_server_endpoints,
    save_endpoint_settings, test_server_endpoints,
};
use bridge_update::{
    BridgeUpdateCoordinator, BridgeUpdateStateStore, STATE_ACQUIRING_LEASE, STATE_ACTIVATING,
    STATE_DRAINING, STATE_ROLLED_BACK, STATE_VERIFYING, STATE_WAITING_WINDOW, StagedRelease,
    UPDATE_CHECK_INTERVAL, UPDATE_STATE_FILE_NAME,
};
use liangjian_bridge_core::{
    ActiveMt5Sessions, CoreConnectionState, CredentialState, NativeConnectedRuntime,
    NativeProfileBootstrap, NativeRuntimeStatusHandle, NativeRuntimeStatusSnapshot,
    ProfileCredentialSource, ProfileTerminalBindingSource, TerminalPermissionQuery,
    project_terminal_trading_permissions,
};
use std::collections::{BTreeSet, HashMap};
use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::time::Instant;

use mt4_expert_installer::{deploy_expert, resolve_expert_source};
use mt5_terminal_discovery::{
    Mt5Installation, Mt5ProbeResult, probe_terminal, selected_or_discovered,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const ADMINISTRATOR_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const OBSERVER_UI_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const MT5_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

enum ProfileRuntimeTrigger {
    Completed(Result<(), liangjian_bridge_core::CoreBootstrapError>),
    BindingChanged,
    PreferenceChanged,
    BindingWatchFailed(liangjian_bridge_core::CoreBootstrapError),
    Stopped,
}

struct ProfileLifecycleContext<'a> {
    application_directory: &'a std::path::Path,
    root_data_directory: &'a std::path::Path,
    profile_id: &'a str,
    logger: &'a BridgeLogger,
}

struct LocalControlContext {
    ui_state: UiStateStore,
    credential_store: CredentialStore,
    preferences_store: BridgePreferencesStore,
    preference_change_sender: watch::Sender<u64>,
    application_directory: PathBuf,
    root_data_directory: PathBuf,
    update_state_store: Option<BridgeUpdateStateStore>,
    update_wake_sender: watch::Sender<u64>,
    stop: SessionCancellation,
    logger: BridgeLogger,
    observer_runtimes: Option<Arc<ObserverRuntimeManager>>,
}

struct InactiveStatus<'a> {
    status_path: &'a std::path::Path,
    root_data_directory: &'a std::path::Path,
    profile_id: &'a str,
    phase: &'a str,
    server_state: &'a str,
    error_code: Option<&'a str>,
    preferences: Option<&'a BridgeUserPreferences>,
}

struct SelectionUiContext<'a> {
    logger: &'a BridgeLogger,
    ui_state: &'a UiStateStore,
    profile_id: &'a str,
    root_data_directory: &'a std::path::Path,
    preferences: &'a BridgeUserPreferences,
}

struct ObserverProfileActionContext<'a> {
    application_directory: &'a std::path::Path,
    root_data_directory: &'a std::path::Path,
    administrator_credential_store: &'a CredentialStore,
    administrator_cache: &'a AsyncMutex<AdministratorCache>,
    observer_runtimes: Option<&'a ObserverRuntimeManager>,
    logger: &'a BridgeLogger,
}

struct RuntimeStatusMonitorContext {
    status_path: PathBuf,
    profile_id: String,
    root_data_directory: PathBuf,
    ui_state: UiStateStore,
    preferences_store: BridgePreferencesStore,
    logger: BridgeLogger,
}

struct UpdateCoordinatorContext {
    application_directory: PathBuf,
    root_data_directory: PathBuf,
    credential_store: CredentialStore,
    ui_state: UiStateStore,
    stop: SessionCancellation,
    logger: BridgeLogger,
}

struct ProfileLifecycleRuntime {
    ready_file: Option<PathBuf>,
    expected_terminal_instance_ids: Vec<String>,
    update_state_store: Option<BridgeUpdateStateStore>,
    stop: SessionCancellation,
    ui_state: UiStateStore,
    preferences_store: BridgePreferencesStore,
    preference_change_receiver: watch::Receiver<u64>,
}

struct StartupReadyContext {
    application_directory: PathBuf,
    root_data_directory: PathBuf,
    credential_store: CredentialStore,
    update_state_store: Option<BridgeUpdateStateStore>,
    logger: BridgeLogger,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct UpdateRuntimeScope {
    terminal_instance_ids: Vec<String>,
    observer_bridge_user_ids: Vec<i64>,
    primary_ready: bool,
}

struct ObserverRuntimeEntry {
    stop: ProcessSupervisorHandle,
    task: tokio::task::JoinHandle<Result<(), bridge_runtime_win::RuntimeError>>,
}

struct ObserverRuntimeManager {
    executable: PathBuf,
    application_directory: PathBuf,
    root_data_directory: PathBuf,
    entries: AsyncMutex<HashMap<String, ObserverRuntimeEntry>>,
    logger: BridgeLogger,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ObserverUiProjection {
    profiles: Vec<UiObserverProfile>,
    terminals: Vec<UiTerminalStatus>,
}

impl ObserverRuntimeManager {
    fn new(
        executable: PathBuf,
        application_directory: PathBuf,
        root_data_directory: PathBuf,
        logger: BridgeLogger,
    ) -> Self {
        Self {
            executable,
            application_directory,
            root_data_directory,
            entries: AsyncMutex::new(HashMap::new()),
            logger,
        }
    }

    async fn start_configured(&self) {
        let profiles = match list_observer_profiles(&self.root_data_directory) {
            Ok(profiles) => profiles,
            Err(code) => {
                self.logger
                    .warning("native_observer_profiles_read_failed", Some(code));
                return;
            }
        };
        for profile_id in profiles {
            let paths = match resolve_profile_paths(&self.root_data_directory, &profile_id) {
                Ok(paths) => paths,
                Err(code) => {
                    self.logger
                        .warning("native_observer_profile_path_failed", Some(code));
                    continue;
                }
            };
            let preferences =
                match BridgePreferencesStore::new(paths.data_directory.join("preferences.json")) {
                    Ok(store) => store.load(),
                    Err(error) => {
                        self.logger
                            .warning("native_observer_preferences_failed", Some(error.code()));
                        continue;
                    }
                };
            if preferences.observer_enabled
                && observer_preferences_configured(&preferences)
                && let Err(code) = self.start(&profile_id).await
            {
                self.logger
                    .warning("native_observer_runtime_start_failed", Some(&code));
            }
        }
    }

    async fn start(&self, profile_id: &str) -> Result<(), String> {
        self.stop(profile_id).await?;
        stop_external_observer_runtime(profile_id).await?;
        let spec = ProcessSpec::new(&self.executable, &self.application_directory)
            .map_err(|error| error.code().to_owned())?
            .arg("--profile")
            .arg(profile_id)
            .arg("--background");
        let supervisor = ProcessSupervisor::new(spec, RestartPolicy::default())
            .map_err(|error| error.code().to_owned())?;
        let stop = supervisor.handle();
        let task = tokio::task::spawn_blocking(move || supervisor.run(None));
        self.entries
            .lock()
            .await
            .insert(profile_id.to_owned(), ObserverRuntimeEntry { stop, task });
        self.logger.info(
            "native_observer_runtime_started",
            Some(&format!("profile={profile_id}")),
        );
        Ok(())
    }

    async fn stop(&self, profile_id: &str) -> Result<(), String> {
        let entry = self.entries.lock().await.remove(profile_id);
        let Some(entry) = entry else {
            return Ok(());
        };
        entry.stop.request_stop();
        entry
            .task
            .await
            .map_err(|_| "bridge_observer_runtime_join_failed".to_owned())?
            .map_err(|error| error.code().to_owned())?;
        self.logger.info(
            "native_observer_runtime_stopped",
            Some(&format!("profile={profile_id}")),
        );
        Ok(())
    }

    async fn stop_all(&self) {
        let profile_ids = self
            .entries
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for profile_id in profile_ids {
            if let Err(code) = self.stop(&profile_id).await {
                self.logger
                    .warning("native_observer_runtime_stop_failed", Some(&code));
            }
        }
    }
}

#[derive(Default)]
struct AdministratorCache {
    is_administrator: bool,
    observer_sources: Vec<ManagedObserverSource>,
    last_refresh: Option<Instant>,
    last_error_code: Option<String>,
    refresh_in_progress: bool,
    generation: u64,
    observer_projection: ObserverUiProjection,
    observer_last_refresh: Option<Instant>,
    observer_refresh_in_progress: bool,
    observer_generation: u64,
    observer_last_error_code: Option<String>,
}

impl AdministratorCache {
    fn schedule_refresh(&mut self, profile_id: &str) -> Option<u64> {
        if profile_id != DEFAULT_PROFILE_ID
            || self.refresh_in_progress
            || self
                .last_refresh
                .is_some_and(|value| value.elapsed() < ADMINISTRATOR_REFRESH_INTERVAL)
        {
            return None;
        }
        self.refresh_in_progress = true;
        self.last_refresh = Some(Instant::now());
        Some(self.generation)
    }

    fn complete_refresh(
        &mut self,
        generation: u64,
        result: Result<(bool, Vec<ManagedObserverSource>), String>,
        logger: &BridgeLogger,
    ) {
        if generation != self.generation {
            return;
        }
        self.refresh_in_progress = false;
        match result {
            Ok((is_administrator, observer_sources)) => {
                if self.is_administrator != is_administrator {
                    self.invalidate_observers();
                }
                self.is_administrator = is_administrator;
                self.observer_sources = observer_sources;
                if !is_administrator {
                    self.observer_projection = ObserverUiProjection::default();
                }
                self.last_error_code = None;
            }
            Err(code) => {
                self.is_administrator = false;
                self.observer_sources.clear();
                self.observer_projection = ObserverUiProjection::default();
                self.invalidate_observers();
                self.log_refresh_error(logger, &code);
            }
        }
    }

    fn decorate(&self, profile_id: &str, state: &mut UiStateSnapshot) {
        if profile_id != DEFAULT_PROFILE_ID {
            return;
        }
        state.is_administrator = self.is_administrator;
        state.observer_sources = if self.is_administrator {
            self.observer_sources
                .iter()
                .map(|source| UiObserverSource {
                    bridge_user_id: source.bridge_user_id,
                    display_name: source.display_name().to_owned(),
                    account_summary: source.account_summary(),
                })
                .collect()
        } else {
            Vec::new()
        };
        state
            .terminals
            .retain(|terminal| terminal.observer_profile_id.is_none());
        state.can_manage_observer_sources = self.is_administrator;
        state.observer_profiles = if self.is_administrator {
            self.observer_projection.profiles.clone()
        } else {
            Vec::new()
        };
        if self.is_administrator {
            let mut terminal_ids = state
                .terminals
                .iter()
                .map(|terminal| terminal.terminal_instance_id.clone())
                .collect::<BTreeSet<_>>();
            state.terminals.extend(
                self.observer_projection
                    .terminals
                    .iter()
                    .filter(|terminal| terminal_ids.insert(terminal.terminal_instance_id.clone()))
                    .cloned(),
            );
        }
    }

    fn schedule_observer_refresh(&mut self, profile_id: &str) -> Option<u64> {
        if profile_id != DEFAULT_PROFILE_ID
            || !self.is_administrator
            || self.observer_refresh_in_progress
            || self
                .observer_last_refresh
                .is_some_and(|value| value.elapsed() < OBSERVER_UI_REFRESH_INTERVAL)
        {
            return None;
        }
        self.observer_refresh_in_progress = true;
        self.observer_last_refresh = Some(Instant::now());
        Some(self.observer_generation)
    }

    fn complete_observer_refresh(
        &mut self,
        generation: u64,
        result: Result<ObserverUiProjection, String>,
        logger: &BridgeLogger,
    ) {
        if generation != self.observer_generation {
            return;
        }
        self.observer_refresh_in_progress = false;
        if !self.is_administrator {
            self.observer_projection = ObserverUiProjection::default();
            return;
        }
        match result {
            Ok(projection) => {
                self.observer_projection = projection;
                self.observer_last_error_code = None;
            }
            Err(code) => {
                if self.observer_last_error_code.as_deref() != Some(&code) {
                    logger.warning("native_observer_projection_failed", Some(&code));
                    self.observer_last_error_code = Some(code);
                }
            }
        }
    }

    fn invalidate_observers(&mut self) {
        self.observer_generation = self.observer_generation.saturating_add(1);
        self.observer_last_refresh = None;
        self.observer_refresh_in_progress = false;
        self.observer_last_error_code = None;
    }

    fn clear(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.is_administrator = false;
        self.observer_sources.clear();
        self.last_refresh = None;
        self.last_error_code = None;
        self.refresh_in_progress = false;
        self.observer_projection = ObserverUiProjection::default();
        self.invalidate_observers();
    }

    fn log_refresh_error(&mut self, logger: &BridgeLogger, code: &str) {
        if self.last_error_code.as_deref() != Some(code) {
            logger.warning("native_administrator_refresh_failed", Some(code));
            self.last_error_code = Some(code.to_owned());
        }
    }
}

async fn refresh_administrator_access(
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    credential_store: &CredentialStore,
) -> Result<(bool, Vec<ManagedObserverSource>), String> {
    let Some(credential) = credential_store
        .load()
        .map_err(|error| error.code().to_owned())?
    else {
        return Ok((false, Vec::new()));
    };
    let endpoints = resolve_server_endpoints(application_directory, root_data_directory)
        .map_err(|error| error.code().to_owned())?;
    let client = BridgeAuthClient::new(endpoints, &format!("LiangJianBridge/{VERSION}"))
        .map_err(|error| error.code().to_owned())?;
    let access = client
        .managed_observer_access(&credential.refresh_token)
        .await
        .map_err(|error| error.code().to_owned())?;
    let is_administrator = access.bridge_role == "admin";
    let observer_sources = if is_administrator {
        access.sources
    } else {
        Vec::new()
    };
    Ok((is_administrator, observer_sources))
}

fn load_observer_ui_projection(
    root_data_directory: &std::path::Path,
    observed_at_utc_msc: i64,
) -> Result<ObserverUiProjection, String> {
    let mut projection = ObserverUiProjection::default();
    for profile_id in list_observer_profiles(root_data_directory).map_err(str::to_owned)? {
        let paths =
            resolve_profile_paths(root_data_directory, &profile_id).map_err(str::to_owned)?;
        let preferences =
            BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
                .map_err(|error| error.code().to_owned())?
                .load();
        let runtime_result = read_runtime_status_snapshot(
            &paths.runtime_status_path,
            &profile_id,
            observed_at_utc_msc,
        );
        let runtime_is_fresh = runtime_result
            .as_ref()
            .is_ok_and(|runtime| !runtime.is_stale(observed_at_utc_msc, 5_000));
        let (runtime_phase, runtime_detail_code) = match &runtime_result {
            Ok(runtime) if runtime_is_fresh => (
                Some(runtime.phase.clone()),
                runtime
                    .server_error_code
                    .clone()
                    .or_else(|| runtime.reconciliation.fatal_error_code.clone())
                    .or_else(|| {
                        runtime
                            .terminals
                            .iter()
                            .find_map(|terminal| terminal.error_code.clone())
                    }),
            ),
            Ok(_) => (
                Some("degraded".to_owned()),
                Some("bridge_runtime_status_stale".to_owned()),
            ),
            Err(code) if paths.runtime_status_path.is_file() => {
                (Some("degraded".to_owned()), Some((*code).to_owned()))
            }
            Err(_) => (None, None),
        };
        projection.profiles.push(UiObserverProfile {
            observer_profile_id: profile_id.clone(),
            platform: preferences.platform.clone(),
            terminal_directory: observer_terminal_directory(&preferences),
            configured: observer_terminal_configured(&preferences),
            enabled: preferences.observer_enabled,
            terminal_instance_id: preferences
                .selected_terminal_instance_id()
                .map(str::to_owned),
            bridge_user_id: preferences.observer_bridge_user_id,
            observer_account_label: preferences.observer_account_label.clone(),
            trading_account_label: preferences.observer_trading_account_label.clone(),
            runtime_phase,
            runtime_detail_code,
        });
        if preferences.observer_enabled
            && runtime_is_fresh
            && let Ok(runtime) = runtime_result
        {
            projection.terminals.extend(load_observer_terminal_statuses(
                &profile_id,
                &preferences,
                &paths.database_path,
                &runtime,
                observed_at_utc_msc,
            ));
        }
    }
    Ok(projection)
}

fn load_observer_terminal_statuses(
    profile_id: &str,
    preferences: &BridgeUserPreferences,
    database_path: &std::path::Path,
    runtime: &bridge_foundation::RuntimeStatusDocument,
    observed_at_utc_msc: i64,
) -> Vec<UiTerminalStatus> {
    let Some(expected_terminal_id) = preferences.selected_terminal_instance_id() else {
        return Vec::new();
    };
    let Ok(store) = OutboxStore::open_existing(database_path) else {
        return Vec::new();
    };
    let Ok(bindings) = store.terminal_bindings() else {
        return Vec::new();
    };
    runtime
        .terminals
        .iter()
        .filter(|terminal| terminal.terminal_instance_id == expected_terminal_id)
        .filter_map(|terminal| {
            let binding = bindings.iter().find(|binding| {
                binding.terminal_instance_id == terminal.terminal_instance_id
                    && binding.platform == terminal.platform
                    && binding.connection_epoch == terminal.connection_epoch
            })?;
            let permissions = project_terminal_trading_permissions(
                &store,
                TerminalPermissionQuery {
                    platform: &terminal.platform,
                    terminal_instance_id: &terminal.terminal_instance_id,
                    account_ref: &binding.account_ref,
                    connection_epoch: terminal.connection_epoch,
                    runtime_ready: terminal.state == "ready",
                    last_success_at_utc_msc: terminal.last_success_at_utc_msc,
                    observed_at_utc_msc,
                },
            );
            Some(UiTerminalStatus {
                terminal_instance_id: terminal.terminal_instance_id.clone(),
                platform: terminal.platform.clone(),
                broker_server: binding.account_ref.broker_server.clone(),
                login: binding.account_ref.login.clone(),
                runtime_state: match terminal.state.as_str() {
                    "ready" => "running",
                    "degraded" => "restarting",
                    "starting" => "starting",
                    _ => "stopped",
                }
                .to_owned(),
                error_code: terminal.error_code.clone(),
                observer_profile_id: Some(profile_id.to_owned()),
                terminal_trading_allowed: permissions.terminal_trading_allowed,
                program_trading_allowed: permissions.program_trading_allowed,
                account_trading_allowed: permissions.account_trading_allowed,
                account_expert_trading_allowed: permissions.account_expert_trading_allowed,
                mt4_expert_restart_required: false,
            })
        })
        .collect()
}

fn observer_terminal_directory(preferences: &BridgeUserPreferences) -> Option<String> {
    let value = match preferences.platform.as_deref() {
        Some("mt5") => preferences.mt5_terminal_path.as_deref().and_then(|path| {
            std::path::Path::new(path)
                .parent()
                .map(|directory| directory.display().to_string())
        }),
        Some("mt4") => preferences.mt4_terminal_path.clone(),
        _ => None,
    }?;
    (!value.trim().is_empty() && value.len() <= 1_024).then_some(value)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--version" {
        println!("{VERSION}");
        return Ok(());
    }

    match parse_cli(args)? {
        CliMode::HealthCheck { health_file } => {
            let executable = env::current_exe()?;
            let application_directory = executable
                .parent()
                .ok_or("bridge_application_directory_invalid")?
                .to_path_buf();
            let install_root = resolve_installed_root(&application_directory)?;
            run_health_check(&HealthCheckOptions {
                application_directory,
                install_root,
                data_directory: default_data_directory("default")?,
                health_file,
                version: VERSION.to_owned(),
            })?;
            Ok(())
        }
        CliMode::Run {
            profile_id,
            start_minimized,
            ready_file,
            expected_terminal_instance_ids,
            ..
        } => run_native_foundation(
            profile_id,
            start_minimized,
            ready_file,
            expected_terminal_instance_ids,
        ),
    }
}

fn run_native_foundation(
    profile_id: String,
    start_minimized: bool,
    ready_file: Option<PathBuf>,
    expected_terminal_instance_ids: Vec<String>,
) -> Result<(), Box<dyn Error>> {
    let root_data_directory = default_root_data_directory()?;
    let profile_paths = resolve_profile_paths(&root_data_directory, &profile_id)?;
    let data_directory = profile_paths.data_directory.clone();
    let logger = BridgeLogger::new(LoggerConfig::new(data_directory.join("logs"))?);
    logger.install_panic_hook("bridge-core", VERSION);
    let instance_id = profile_instance_id(&profile_id)?;
    let single_instance = SingleInstanceGuard::try_acquire(
        &instance_id,
        default_lock_directory()?,
        !start_minimized,
    )?;
    let InstanceAcquireResult::Acquired(single_instance) = single_instance else {
        return Ok(());
    };
    let _run_marker = logger.begin_run_marker(&data_directory, "bridge-core", VERSION)?;
    logger.info(
        "native_runtime_foundation_started",
        Some(&format!("profile={profile_id}")),
    );
    let application_directory = env::current_exe()?
        .parent()
        .ok_or("bridge_application_directory_invalid")?
        .to_path_buf();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(run_connected_profile(
        application_directory,
        root_data_directory,
        profile_id,
        ready_file,
        expected_terminal_instance_ids,
        Arc::new(single_instance),
        logger,
    ))
}

async fn run_connected_profile(
    application_directory: PathBuf,
    root_data_directory: PathBuf,
    profile_id: String,
    ready_file: Option<PathBuf>,
    expected_terminal_instance_ids: Vec<String>,
    single_instance: Arc<SingleInstanceGuard>,
    logger: BridgeLogger,
) -> Result<(), Box<dyn Error>> {
    let stop = SessionCancellation::default();
    let profile_paths = resolve_profile_paths(&root_data_directory, &profile_id)?;
    let initial_runtime_status = NativeRuntimeStatusSnapshot::inactive(
        &profile_id,
        VERSION,
        now_utc_msc(),
        "starting",
        "stopped",
        None,
    )?;
    let ui_state = UiStateStore::new(initial_runtime_status.to_ui_state(1)?)?;
    let local_control_server = LocalControlPipeServer::bind(&profile_id)?;
    let credential_store = CredentialStore::new(&profile_paths.credential_path)?;
    let preferences_store =
        BridgePreferencesStore::new(profile_paths.data_directory.join("preferences.json"))?;
    let update_state_store = resolve_update_state_store(&application_directory, &profile_id)?;
    let update_coordinator = match update_state_store.as_ref() {
        Some(store) => match BridgeUpdateCoordinator::create_if_installed(
            &application_directory,
            store.clone(),
        ) {
            Ok(coordinator) => coordinator,
            Err(error) => {
                logger.warning("native_update_coordinator_unavailable", Some(error.code()));
                None
            }
        },
        None => None,
    };
    let observer_runtimes = if profile_id == DEFAULT_PROFILE_ID {
        let manager = Arc::new(ObserverRuntimeManager::new(
            env::current_exe()?,
            application_directory.clone(),
            root_data_directory.clone(),
            logger.clone(),
        ));
        manager.start_configured().await;
        Some(manager)
    } else {
        None
    };
    if profile_id == DEFAULT_PROFILE_ID {
        let enabled = preferences_store.load().auto_start_enabled;
        match AutoStartRegistration::ensure_for_installed_application(
            &application_directory,
            enabled,
        ) {
            Ok(true) => logger.info(
                if enabled {
                    "autostart_registered"
                } else {
                    "autostart_removed"
                },
                None,
            ),
            Ok(false) => {}
            Err(error) => logger.warning("autostart_registration_failed", Some(error.code())),
        }
    }
    let (preference_change_sender, preference_change_receiver) = watch::channel(0_u64);
    let (update_wake_sender, update_wake_receiver) = watch::channel(0_u64);
    let lifecycle_update_state_store = update_state_store.clone();
    let update_task = update_coordinator.map(|coordinator| {
        tokio::spawn(run_periodic_update_checks(
            coordinator,
            UpdateCoordinatorContext {
                application_directory: application_directory.clone(),
                root_data_directory: root_data_directory.clone(),
                credential_store: credential_store.clone(),
                ui_state: ui_state.clone(),
                stop: stop.clone(),
                logger: logger.clone(),
            },
            update_wake_receiver,
        ))
    });
    let control_stop = stop.clone();
    let control_task = tokio::spawn(run_local_control_server(
        local_control_server,
        LocalControlContext {
            ui_state: ui_state.clone(),
            credential_store,
            preferences_store: preferences_store.clone(),
            preference_change_sender,
            application_directory: application_directory.clone(),
            root_data_directory: root_data_directory.clone(),
            update_state_store,
            update_wake_sender,
            stop: control_stop,
            logger: logger.clone(),
            observer_runtimes: observer_runtimes.clone(),
        },
    ));
    let signal_stop = stop.clone();
    let signal_waiter = tokio::task::spawn_blocking(move || {
        loop {
            if signal_stop.is_cancelled() {
                return Ok::<(), bridge_runtime_win::RuntimeError>(());
            }
            match single_instance.wait_for_signal(Duration::from_millis(250))? {
                InstanceSignal::Shutdown => {
                    signal_stop.cancel();
                    return Ok::<(), bridge_runtime_win::RuntimeError>(());
                }
                InstanceSignal::Activation | InstanceSignal::Timeout => {}
            }
        }
    });

    let profile_result = run_profile_lifecycle(
        ProfileLifecycleContext {
            application_directory: &application_directory,
            root_data_directory: &root_data_directory,
            profile_id: &profile_id,
            logger: &logger,
        },
        ProfileLifecycleRuntime {
            ready_file,
            expected_terminal_instance_ids,
            update_state_store: lifecycle_update_state_store,
            stop: stop.clone(),
            ui_state: ui_state.clone(),
            preferences_store: preferences_store.clone(),
            preference_change_receiver,
        },
    )
    .await;
    stop.cancel();
    if let Some(manager) = observer_runtimes {
        manager.stop_all().await;
    }
    control_task
        .await
        .map_err(|_| "bridge_local_control_task_failed")?;
    signal_waiter
        .await
        .map_err(|_| "bridge_instance_wait_failed")??;
    if let Some(update_task) = update_task {
        update_task.await.map_err(|_| "bridge_update_task_failed")?;
    }
    let status_path = profile_paths.runtime_status_path;
    let final_preferences = preferences_store.load();
    match &profile_result {
        Ok(()) => {
            publish_inactive_status(
                &logger,
                &ui_state,
                InactiveStatus {
                    status_path: &status_path,
                    root_data_directory: &root_data_directory,
                    profile_id: &profile_id,
                    phase: "stopped",
                    server_state: "stopped",
                    error_code: None,
                    preferences: Some(&final_preferences),
                },
            );
            logger.info(
                "native_runtime_stopped",
                Some(&format!("profile={profile_id}")),
            )
        }
        Err(error) => {
            let error_code = stable_runtime_error_code(&error.to_string());
            publish_inactive_status(
                &logger,
                &ui_state,
                InactiveStatus {
                    status_path: &status_path,
                    root_data_directory: &root_data_directory,
                    profile_id: &profile_id,
                    phase: "degraded",
                    server_state: "stopped",
                    error_code: Some(&error_code),
                    preferences: Some(&final_preferences),
                },
            );
            logger.error("native_runtime_failed", Some(&error_code));
        }
    }
    profile_result
}

async fn run_periodic_update_checks(
    mut coordinator: BridgeUpdateCoordinator,
    context: UpdateCoordinatorContext,
    mut update_wake_receiver: watch::Receiver<u64>,
) {
    let UpdateCoordinatorContext {
        application_directory,
        root_data_directory,
        credential_store,
        ui_state,
        stop,
        logger,
    } = context;
    recover_interrupted_update(
        &coordinator,
        &application_directory,
        &root_data_directory,
        &credential_store,
        &logger,
    )
    .await;
    let mut next_check_at = Instant::now();
    loop {
        if stop.is_cancelled() {
            return;
        }
        let state = match coordinator.load_state() {
            Ok(state) => state,
            Err(error) => {
                logger.warning("native_update_state_read_failed", Some(error.code()));
                None
            }
        };
        let activation_in_progress = state.as_ref().is_some_and(|state| {
            matches!(
                state.state.as_str(),
                STATE_ACQUIRING_LEASE | STATE_DRAINING | STATE_ACTIVATING | STATE_VERIFYING
            )
        });
        if !activation_in_progress && Instant::now() >= next_check_at {
            match resolve_server_endpoints(&application_directory, &root_data_directory) {
                Ok(endpoints) => {
                    let check = coordinator.check_and_stage(endpoints.control_base().clone());
                    let result = tokio::select! {
                        _ = stop.cancelled() => return,
                        result = check => result,
                    };
                    let check_succeeded = result.is_ok();
                    match result {
                        Ok(Some(staged)) => logger.info(
                            "native_update_staged",
                            Some(&format!(
                                "version={};priority={}",
                                staged.version, staged.priority
                            )),
                        ),
                        Ok(None) => {}
                        Err(error) => {
                            logger.warning("native_update_check_failed", Some(error.code()))
                        }
                    }
                    next_check_at = Instant::now()
                        + if check_succeeded {
                            UPDATE_CHECK_INTERVAL
                        } else {
                            Duration::from_secs(30)
                        };
                }
                Err(error) => {
                    logger.warning("native_update_endpoint_unavailable", Some(error.code()));
                    next_check_at = Instant::now() + Duration::from_secs(30);
                }
            }
        }
        let state = coordinator.load_state().ok().flatten();
        if state.as_ref().is_some_and(|state| {
            state.state == STATE_WAITING_WINDOW
                && state
                    .next_retry_at_utc_msc
                    .is_none_or(|retry| retry <= now_utc_msc())
        }) {
            let activation = try_apply_staged_update(
                &coordinator,
                &application_directory,
                &root_data_directory,
                &credential_store,
                &ui_state,
                &stop,
                &logger,
            );
            match tokio::select! {
                _ = stop.cancelled() => return,
                result = activation => result,
            } {
                Ok(true) => return,
                Ok(false) => {}
                Err(code) => logger.warning("native_update_activation_failed", Some(&code)),
            }
        }
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            changed = update_wake_receiver.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

async fn recover_interrupted_update(
    coordinator: &BridgeUpdateCoordinator,
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    credential_store: &CredentialStore,
    logger: &BridgeLogger,
) {
    let Ok(Some(state)) = coordinator.load_state() else {
        return;
    };
    if !matches!(
        state.state.as_str(),
        STATE_ACQUIRING_LEASE | STATE_DRAINING | STATE_ACTIVATING
    ) {
        return;
    }
    if let Some(lease_id) = state.maintenance_lease_id.as_deref() {
        release_maintenance_lease_best_effort(
            application_directory,
            root_data_directory,
            credential_store,
            lease_id,
            logger,
        )
        .await;
    }
    match coordinator.restore_staged_release() {
        Ok(Some(staged)) => {
            if let Err(error) = coordinator.save_activation_phase(
                &staged,
                STATE_WAITING_WINDOW,
                state.manual_activation_requested,
                None,
                None,
                Some(now_utc_msc().saturating_add(15_000)),
                Some("update_recovered_after_restart".to_owned()),
            ) {
                logger.warning("native_update_recovery_failed", Some(error.code()));
            } else {
                logger.info(
                    "native_update_recovered_after_restart",
                    Some(&format!("version={}", staged.version)),
                );
            }
        }
        Ok(None) => {}
        Err(error) => logger.warning("native_update_recovery_failed", Some(error.code())),
    }
}

#[allow(clippy::too_many_arguments)]
async fn try_apply_staged_update(
    coordinator: &BridgeUpdateCoordinator,
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    credential_store: &CredentialStore,
    ui_state: &UiStateStore,
    stop: &SessionCancellation,
    logger: &BridgeLogger,
) -> Result<bool, String> {
    let Some(state) = coordinator
        .load_state()
        .map_err(|error| error.code().to_owned())?
    else {
        return Ok(false);
    };
    if state.state != STATE_WAITING_WINDOW {
        return Ok(false);
    }
    let Some(staged) = coordinator
        .restore_staged_release()
        .map_err(|error| error.code().to_owned())?
    else {
        return Ok(false);
    };
    let scope = match capture_update_runtime_scope(root_data_directory, ui_state) {
        Ok(scope) => scope,
        Err(code) => {
            return defer_staged_update(
                coordinator,
                &staged,
                state.manual_activation_requested,
                15,
                code,
            );
        }
    };
    if !scope.primary_ready || scope.terminal_instance_ids.is_empty() {
        coordinator
            .save_activation_phase(
                &staged,
                STATE_WAITING_WINDOW,
                state.manual_activation_requested,
                None,
                None,
                Some(now_utc_msc().saturating_add(15_000)),
                Some(if scope.primary_ready {
                    "bridge_update_no_connected_terminal".to_owned()
                } else {
                    "bridge_update_primary_not_ready".to_owned()
                }),
            )
            .map_err(|error| error.code().to_owned())?;
        return Ok(false);
    }
    let credential = match credential_store.load() {
        Ok(Some(credential)) => credential,
        Ok(None) => {
            return defer_staged_update(
                coordinator,
                &staged,
                state.manual_activation_requested,
                30,
                "bridge_not_paired".to_owned(),
            );
        }
        Err(error) => {
            return defer_staged_update(
                coordinator,
                &staged,
                state.manual_activation_requested,
                30,
                error.code().to_owned(),
            );
        }
    };
    let endpoints = match resolve_server_endpoints(application_directory, root_data_directory) {
        Ok(endpoints) => endpoints,
        Err(error) => {
            return defer_staged_update(
                coordinator,
                &staged,
                state.manual_activation_requested,
                30,
                error.code().to_owned(),
            );
        }
    };
    let client = match BridgeAuthClient::new(endpoints, &format!("LiangJianBridge/{VERSION}")) {
        Ok(client) => client,
        Err(error) => {
            return defer_staged_update(
                coordinator,
                &staged,
                state.manual_activation_requested,
                30,
                error.code().to_owned(),
            );
        }
    };
    coordinator
        .save_activation_phase(
            &staged,
            STATE_ACQUIRING_LEASE,
            state.manual_activation_requested,
            None,
            None,
            None,
            None,
        )
        .map_err(|error| error.code().to_owned())?;
    let decision = match client
        .acquire_maintenance_lease(
            &credential.refresh_token,
            &MaintenanceLeaseRequest {
                installation_id: coordinator.installation_id().to_owned(),
                target_version: staged.version.clone(),
                priority: staged.priority.clone(),
                manual_request: state.manual_activation_requested,
                terminal_instance_ids: scope.terminal_instance_ids.clone(),
                observer_bridge_user_ids: scope.observer_bridge_user_ids,
                expected_downtime_seconds: staged.minimum_idle_seconds.clamp(30, 300),
            },
        )
        .await
    {
        Ok(decision) => decision,
        Err(error) => {
            let code = error.code().to_owned();
            coordinator
                .save_activation_phase(
                    &staged,
                    STATE_WAITING_WINDOW,
                    state.manual_activation_requested,
                    None,
                    None,
                    Some(now_utc_msc().saturating_add(30_000)),
                    Some(code.clone()),
                )
                .map_err(|error| error.code().to_owned())?;
            return Err(code);
        }
    };
    if !decision.acquired {
        let retry_seconds = decision.retry_after_seconds.clamp(1, 300);
        coordinator
            .save_activation_phase(
                &staged,
                STATE_WAITING_WINDOW,
                state.manual_activation_requested,
                None,
                None,
                Some(now_utc_msc().saturating_add(i64::from(retry_seconds).saturating_mul(1_000))),
                decision
                    .reason_code
                    .or_else(|| Some("bridge_maintenance_denied".to_owned())),
            )
            .map_err(|error| error.code().to_owned())?;
        return Ok(false);
    }
    let lease_id = decision
        .lease_id
        .ok_or_else(|| "bridge_maintenance_lease_response_invalid".to_owned())?;
    let lease_expiry = decision
        .expires_at_utc_msc
        .ok_or_else(|| "bridge_maintenance_lease_response_invalid".to_owned())?;
    let activation = async {
        coordinator
            .save_activation_phase(
                &staged,
                STATE_DRAINING,
                state.manual_activation_requested,
                Some(lease_id.clone()),
                Some(lease_expiry),
                None,
                None,
            )
            .map_err(|error| error.code().to_owned())?;
        logger.info(
            "native_update_drain_started",
            Some(&format!(
                "version={};terminals={}",
                staged.version,
                scope.terminal_instance_ids.len()
            )),
        );
        let renewed_expiry = client
            .renew_maintenance_lease(&credential.refresh_token, &lease_id)
            .await
            .map_err(|error| error.code().to_owned())?;
        coordinator
            .save_activation_phase(
                &staged,
                STATE_ACTIVATING,
                state.manual_activation_requested,
                Some(lease_id.clone()),
                Some(renewed_expiry),
                None,
                None,
            )
            .map_err(|error| error.code().to_owned())?;
        coordinator
            .prepare_activation(&staged, &scope.terminal_instance_ids)
            .map_err(|error| error.code().to_owned())?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(code) = activation {
        release_maintenance_lease_best_effort(
            application_directory,
            root_data_directory,
            credential_store,
            &lease_id,
            logger,
        )
        .await;
        coordinator
            .save_activation_phase(
                &staged,
                STATE_WAITING_WINDOW,
                state.manual_activation_requested,
                None,
                None,
                Some(now_utc_msc().saturating_add(15_000)),
                Some(code.clone()),
            )
            .map_err(|error| error.code().to_owned())?;
        return Err(code);
    }
    logger.info(
        "native_update_activation_prepared",
        Some(&format!("version={};lease={lease_id}", staged.version)),
    );
    stop.cancel();
    Ok(true)
}

fn defer_staged_update(
    coordinator: &BridgeUpdateCoordinator,
    staged: &StagedRelease,
    manual_activation_requested: bool,
    retry_after_seconds: u32,
    error_code: String,
) -> Result<bool, String> {
    coordinator
        .save_activation_phase(
            staged,
            STATE_WAITING_WINDOW,
            manual_activation_requested,
            None,
            None,
            Some(
                now_utc_msc().saturating_add(i64::from(retry_after_seconds.clamp(1, 300)) * 1_000),
            ),
            Some(error_code.clone()),
        )
        .map_err(|error| error.code().to_owned())?;
    Err(error_code)
}

fn capture_update_runtime_scope(
    root_data_directory: &std::path::Path,
    ui_state: &UiStateStore,
) -> Result<UpdateRuntimeScope, String> {
    let state = ui_state.snapshot().map_err(str::to_owned)?;
    let now = now_utc_msc();
    let mut terminal_ids = std::collections::BTreeSet::new();
    let mut primary_terminal_count = 0usize;
    let primary_ready = state.phase == "online"
        && state.server_connected
        && now.saturating_sub(state.observed_at_utc_msc) <= 5_000;
    if primary_ready {
        for terminal in state.terminals.iter().filter(|terminal| {
            terminal.observer_profile_id.is_none() && terminal.runtime_state == "running"
        }) {
            if !terminal_ids.insert(terminal.terminal_instance_id.clone()) {
                return Err("bridge_update_terminal_scope_conflict".to_owned());
            }
            primary_terminal_count = primary_terminal_count.saturating_add(1);
        }
    }
    let mut observer_user_ids = std::collections::BTreeSet::new();
    for profile_id in list_observer_profiles(root_data_directory).map_err(str::to_owned)? {
        let paths =
            resolve_profile_paths(root_data_directory, &profile_id).map_err(str::to_owned)?;
        let preferences =
            BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
                .map_err(|error| error.code().to_owned())?
                .load();
        if !preferences.observer_enabled {
            continue;
        }
        let Some(observer_user_id) = preferences.observer_bridge_user_id else {
            continue;
        };
        let Ok(runtime) =
            read_runtime_status_snapshot(&paths.runtime_status_path, &profile_id, now)
        else {
            continue;
        };
        if runtime.server_state != "connected" || runtime.is_stale(now, 5_000) {
            continue;
        }
        let mut included = false;
        for terminal in runtime
            .terminals
            .iter()
            .filter(|terminal| terminal.state == "ready")
        {
            if !terminal_ids.insert(terminal.terminal_instance_id.clone()) {
                return Err("bridge_update_terminal_scope_conflict".to_owned());
            }
            included = true;
        }
        if included {
            observer_user_ids.insert(observer_user_id);
        }
    }
    Ok(UpdateRuntimeScope {
        terminal_instance_ids: terminal_ids.into_iter().collect(),
        observer_bridge_user_ids: observer_user_ids.into_iter().collect(),
        primary_ready: primary_ready && primary_terminal_count > 0,
    })
}

async fn release_maintenance_lease_best_effort(
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    credential_store: &CredentialStore,
    lease_id: &str,
    logger: &BridgeLogger,
) {
    let result = async {
        let credential = credential_store
            .load()
            .map_err(|error| error.code().to_owned())?
            .ok_or_else(|| "bridge_not_paired".to_owned())?;
        let endpoints = resolve_server_endpoints(application_directory, root_data_directory)
            .map_err(|error| error.code().to_owned())?;
        let client = BridgeAuthClient::new(endpoints, &format!("LiangJianBridge/{VERSION}"))
            .map_err(|error| error.code().to_owned())?;
        client
            .release_maintenance_lease(&credential.refresh_token, lease_id)
            .await
            .map_err(|error| error.code().to_owned())
    }
    .await;
    match result {
        Ok(()) => logger.info(
            "native_update_maintenance_released",
            Some(&format!("lease={lease_id}")),
        ),
        Err(code) => logger.warning("native_update_maintenance_release_failed", Some(&code)),
    }
}

async fn release_startup_maintenance_lease(
    update_state_store: Option<&BridgeUpdateStateStore>,
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    credential_store: &CredentialStore,
    logger: &BridgeLogger,
) {
    let Some(update_state_store) = update_state_store else {
        return;
    };
    let Ok(Some(state)) = update_state_store.load() else {
        return;
    };
    if !matches!(
        state.state.as_str(),
        STATE_VERIFYING | STATE_ACTIVATING | STATE_ROLLED_BACK
    ) {
        return;
    }
    let Some(lease_id) = state.maintenance_lease_id.as_deref() else {
        return;
    };
    release_maintenance_lease_best_effort(
        application_directory,
        root_data_directory,
        credential_store,
        lease_id,
        logger,
    )
    .await;
}

async fn run_local_control_server(
    mut server: LocalControlPipeServer,
    context: LocalControlContext,
) {
    let LocalControlContext {
        ui_state,
        credential_store,
        preferences_store,
        preference_change_sender,
        application_directory,
        root_data_directory,
        update_state_store,
        update_wake_sender,
        stop,
        logger,
        observer_runtimes,
    } = context;
    logger.info(
        "native_local_control_started",
        Some(&format!("profile={}", server.endpoint().profile_id())),
    );
    let administrator_cache = Arc::new(AsyncMutex::new(AdministratorCache::default()));
    let mut last_update_state_error = None;
    loop {
        let accepted = tokio::select! {
            result = server.accept() => result,
            _ = stop.cancelled() => return,
        };
        if let Err(error) = accepted {
            logger.warning("native_local_control_accept_failed", Some(error.code()));
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            continue;
        }

        loop {
            let request = tokio::select! {
                result = server.receive() => match result {
                    Ok(request) => request,
                    Err(error) => {
                        if error.code() != "bridge_local_control_pipe_closed" {
                            logger.warning("native_local_control_request_failed", Some(error.code()));
                        }
                        break;
                    }
                },
                _ = stop.cancelled() => {
                    let _ = server.disconnect();
                    return;
                }
            };
            let exit_requested = matches!(&request.action, LocalControlAction::BridgeExit);
            let result = match request.action {
                LocalControlAction::GetState => match ui_state.snapshot() {
                    Ok(mut state) => {
                        let (refresh_generation, observer_refresh_generation) = {
                            let mut cache = administrator_cache.lock().await;
                            let refresh_generation =
                                cache.schedule_refresh(server.endpoint().profile_id());
                            let observer_refresh_generation =
                                cache.schedule_observer_refresh(server.endpoint().profile_id());
                            cache.decorate(server.endpoint().profile_id(), &mut state);
                            (refresh_generation, observer_refresh_generation)
                        };
                        if let Some(refresh_generation) = refresh_generation {
                            let cache = Arc::clone(&administrator_cache);
                            let application_directory = application_directory.clone();
                            let root_data_directory = root_data_directory.clone();
                            let credential_store = credential_store.clone();
                            let logger = logger.clone();
                            tokio::spawn(async move {
                                let result = refresh_administrator_access(
                                    &application_directory,
                                    &root_data_directory,
                                    &credential_store,
                                )
                                .await;
                                cache.lock().await.complete_refresh(
                                    refresh_generation,
                                    result,
                                    &logger,
                                );
                            });
                        }
                        if let Some(observer_refresh_generation) = observer_refresh_generation {
                            let cache = Arc::clone(&administrator_cache);
                            let root_data_directory = root_data_directory.clone();
                            let logger = logger.clone();
                            tokio::spawn(async move {
                                let result = tokio::task::spawn_blocking(move || {
                                    load_observer_ui_projection(&root_data_directory, now_utc_msc())
                                })
                                .await
                                .map_err(|_| "bridge_observer_projection_join_failed".to_owned())
                                .and_then(std::convert::identity);
                                cache.lock().await.complete_observer_refresh(
                                    observer_refresh_generation,
                                    result,
                                    &logger,
                                );
                            });
                        }
                        match project_update_notice(update_state_store.as_ref()) {
                            Ok(notice) => {
                                state.update_notice = notice;
                                last_update_state_error = None;
                            }
                            Err(code) => {
                                state.update_notice = None;
                                if last_update_state_error != Some(code) {
                                    logger.warning("native_update_state_read_failed", Some(code));
                                    last_update_state_error = Some(code);
                                }
                            }
                        }
                        LocalControlResult::State {
                            state: Box::new(state),
                        }
                    }
                    Err(code) => LocalControlResult::Rejected {
                        code: code.to_owned(),
                    },
                },
                LocalControlAction::Pair => {
                    match resolve_server_endpoints(&application_directory, &root_data_directory)
                        .and_then(|endpoints| endpoints.api_url("/bridge/pair"))
                    {
                        Ok(url) => LocalControlResult::PairingUrl {
                            url: url.to_string(),
                        },
                        Err(error) => LocalControlResult::Rejected {
                            code: error.code().to_owned(),
                        },
                    }
                }
                LocalControlAction::Logout => match credential_store.clear() {
                    Ok(()) => {
                        administrator_cache.lock().await.clear();
                        LocalControlResult::Accepted
                    }
                    Err(error) => LocalControlResult::Rejected {
                        code: error.code().to_owned(),
                    },
                },
                LocalControlAction::SelectPlatform { platform } => {
                    match preferences_store.save_platform(&platform) {
                        Ok(()) => {
                            signal_preference_change(&preference_change_sender);
                            LocalControlResult::Accepted
                        }
                        Err(error) => LocalControlResult::Rejected {
                            code: error.code().to_owned(),
                        },
                    }
                }
                LocalControlAction::SelectTerminal {
                    terminal_instance_id,
                } => {
                    let state = ui_state.snapshot();
                    match state.and_then(|state| {
                        let platform = state
                            .selected_platform
                            .ok_or("bridge_terminal_selection_platform_missing")?;
                        let valid = state.terminal_candidates.iter().any(|candidate| {
                            candidate.terminal_instance_id == terminal_instance_id
                                && candidate.platform == platform
                        });
                        if !valid {
                            return Err("bridge_terminal_selection_invalid");
                        }
                        preferences_store
                            .save_terminal(&platform, &terminal_instance_id)
                            .map_err(|error| error.code())
                    }) {
                        Ok(()) => {
                            signal_preference_change(&preference_change_sender);
                            LocalControlResult::Accepted
                        }
                        Err(code) => LocalControlResult::Rejected {
                            code: code.to_owned(),
                        },
                    }
                }
                LocalControlAction::Redetect => {
                    signal_preference_change(&preference_change_sender);
                    LocalControlResult::Accepted
                }
                LocalControlAction::InstallMt4Ea => {
                    install_selected_mt4_expert(
                        &ui_state,
                        &application_directory,
                        &root_data_directory,
                        server.endpoint().profile_id(),
                        &logger,
                    )
                    .await
                }
                LocalControlAction::UpdateActivate => request_manual_update_activation(
                    update_state_store.as_ref(),
                    &update_wake_sender,
                    &logger,
                ),
                LocalControlAction::SettingsTest { settings } => {
                    let is_administrator = administrator_cache.lock().await.is_administrator;
                    if !endpoint_settings_allowed(
                        &ui_state,
                        server.endpoint().profile_id(),
                        is_administrator,
                    ) {
                        LocalControlResult::Rejected {
                            code: "bridge_endpoint_settings_forbidden".to_owned(),
                        }
                    } else {
                        match resolve_endpoint_selection(&application_directory, &settings) {
                            Ok(endpoints) => {
                                let connectivity =
                                    test_server_endpoints(&endpoints, Duration::from_secs(8)).await;
                                LocalControlResult::ConnectivityTest {
                                    success: connectivity.control_reachable
                                        && connectivity.realtime_reachable,
                                    description: endpoint_connectivity_description(
                                        connectivity.control_reachable,
                                        connectivity.realtime_reachable,
                                    )
                                    .to_owned(),
                                }
                            }
                            Err(code) => LocalControlResult::Rejected {
                                code: code.to_owned(),
                            },
                        }
                    }
                }
                LocalControlAction::SettingsSave { settings } => {
                    let is_administrator = administrator_cache.lock().await.is_administrator;
                    if !endpoint_settings_allowed(
                        &ui_state,
                        server.endpoint().profile_id(),
                        is_administrator,
                    ) {
                        LocalControlResult::Rejected {
                            code: "bridge_endpoint_settings_forbidden".to_owned(),
                        }
                    } else {
                        match apply_endpoint_selection(
                            &application_directory,
                            &root_data_directory,
                            &credential_store,
                            &settings,
                        ) {
                            Ok(control_changed) => {
                                if control_changed {
                                    administrator_cache.lock().await.clear();
                                }
                                signal_preference_change(&preference_change_sender);
                                logger.info(
                                    "native_endpoint_settings_saved",
                                    Some(&format!(
                                        "mode={};control_changed={control_changed}",
                                        if settings.follow_official {
                                            "official"
                                        } else {
                                            "custom"
                                        }
                                    )),
                                );
                                LocalControlResult::Accepted
                            }
                            Err(code) => LocalControlResult::Rejected {
                                code: code.to_owned(),
                            },
                        }
                    }
                }
                LocalControlAction::SettingsRestoreOfficial => {
                    let is_administrator = administrator_cache.lock().await.is_administrator;
                    if !endpoint_settings_allowed(
                        &ui_state,
                        server.endpoint().profile_id(),
                        is_administrator,
                    ) {
                        LocalControlResult::Rejected {
                            code: "bridge_endpoint_settings_forbidden".to_owned(),
                        }
                    } else {
                        let official = resolve_official_endpoint_selection(&application_directory);
                        match official.and_then(|settings| {
                            apply_endpoint_selection(
                                &application_directory,
                                &root_data_directory,
                                &credential_store,
                                &settings,
                            )
                        }) {
                            Ok(control_changed) => {
                                if control_changed {
                                    administrator_cache.lock().await.clear();
                                }
                                signal_preference_change(&preference_change_sender);
                                logger.info(
                                    "native_endpoint_settings_restored",
                                    Some(&format!("control_changed={control_changed}")),
                                );
                                LocalControlResult::Accepted
                            }
                            Err(code) => LocalControlResult::Rejected {
                                code: code.to_owned(),
                            },
                        }
                    }
                }
                LocalControlAction::AutostartSet { enabled } => {
                    if server.endpoint().profile_id() != DEFAULT_PROFILE_ID {
                        LocalControlResult::Rejected {
                            code: "bridge_autostart_forbidden".to_owned(),
                        }
                    } else {
                        match apply_autostart_selection(
                            &application_directory,
                            &preferences_store,
                            enabled,
                        ) {
                            Ok(()) => {
                                signal_preference_change(&preference_change_sender);
                                logger.info(
                                    if enabled {
                                        "autostart_enabled_by_user"
                                    } else {
                                        "autostart_disabled_by_user"
                                    },
                                    None,
                                );
                                LocalControlResult::Accepted
                            }
                            Err(code) => LocalControlResult::Rejected {
                                code: code.to_owned(),
                            },
                        }
                    }
                }
                LocalControlAction::ObserverCreate { observer } => {
                    configure_observer_profile(
                        true,
                        observer,
                        ObserverProfileActionContext {
                            application_directory: &application_directory,
                            root_data_directory: &root_data_directory,
                            administrator_credential_store: &credential_store,
                            administrator_cache: &administrator_cache,
                            observer_runtimes: observer_runtimes.as_deref(),
                            logger: &logger,
                        },
                    )
                    .await
                }
                LocalControlAction::ObserverUpdate { observer } => {
                    configure_observer_profile(
                        false,
                        observer,
                        ObserverProfileActionContext {
                            application_directory: &application_directory,
                            root_data_directory: &root_data_directory,
                            administrator_credential_store: &credential_store,
                            administrator_cache: &administrator_cache,
                            observer_runtimes: observer_runtimes.as_deref(),
                            logger: &logger,
                        },
                    )
                    .await
                }
                LocalControlAction::ObserverBind {
                    observer_profile_id,
                    bridge_user_id,
                } => {
                    bind_observer_profile(
                        &observer_profile_id,
                        bridge_user_id,
                        ObserverProfileActionContext {
                            application_directory: &application_directory,
                            root_data_directory: &root_data_directory,
                            administrator_credential_store: &credential_store,
                            administrator_cache: &administrator_cache,
                            observer_runtimes: observer_runtimes.as_deref(),
                            logger: &logger,
                        },
                    )
                    .await
                }
                LocalControlAction::ObserverStart {
                    observer_profile_id,
                }
                | LocalControlAction::ObserverRetry {
                    observer_profile_id,
                } => {
                    observer_runtime_enabled_action(
                        &observer_profile_id,
                        true,
                        &root_data_directory,
                        &administrator_cache,
                        observer_runtimes.as_deref(),
                    )
                    .await
                }
                LocalControlAction::ObserverPause {
                    observer_profile_id,
                } => {
                    observer_runtime_enabled_action(
                        &observer_profile_id,
                        false,
                        &root_data_directory,
                        &administrator_cache,
                        observer_runtimes.as_deref(),
                    )
                    .await
                }
                LocalControlAction::BridgeExit => LocalControlResult::Accepted,
            };
            let response = LocalControlResponse {
                schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                request_id: request.request_id,
                result,
            };
            if let Err(error) = server.send(&response).await {
                logger.warning("native_local_control_response_failed", Some(error.code()));
                break;
            }
            if exit_requested {
                stop.cancel();
                let _ = server.disconnect();
                return;
            }
        }
        if let Err(error) = server.disconnect() {
            logger.warning("native_local_control_disconnect_failed", Some(error.code()));
        }
    }
}

fn resolve_update_state_store(
    application_directory: &std::path::Path,
    profile_id: &str,
) -> Result<Option<BridgeUpdateStateStore>, &'static str> {
    #[cfg(debug_assertions)]
    if let Some(configured) = env::var_os("AURUM_BRIDGE_UPDATE_STATE_PATH") {
        let configured = PathBuf::from(configured);
        if !configured.is_absolute() {
            return Err("update_state_path_invalid");
        }
        return BridgeUpdateStateStore::new(configured)
            .map(Some)
            .map_err(|error| error.code());
    }
    if profile_id != DEFAULT_PROFILE_ID {
        return Ok(None);
    }
    let Ok(install_root) = resolve_installed_root(application_directory) else {
        return Ok(None);
    };
    if [
        "AURUMBridge.Launcher.exe",
        "release-public-key.pem",
        "current.json",
    ]
    .iter()
    .any(|name| !install_root.join(name).is_file())
    {
        return Ok(None);
    }
    BridgeUpdateStateStore::new(install_root.join(UPDATE_STATE_FILE_NAME))
        .map(Some)
        .map_err(|error| error.code())
}

fn project_update_notice(
    store: Option<&BridgeUpdateStateStore>,
) -> Result<Option<UiUpdateNotice>, &'static str> {
    let Some(store) = store else {
        return Ok(None);
    };
    let state = store.load().map_err(|error| error.code())?;
    Ok(state.and_then(|state| {
        state.notice().map(|notice| UiUpdateNotice {
            version: notice.version,
            urgent: notice.urgent,
            phase: notice.phase.to_owned(),
            manual_activation_requested: notice.manual_activation_requested,
        })
    }))
}

fn request_manual_update_activation(
    store: Option<&BridgeUpdateStateStore>,
    update_wake_sender: &watch::Sender<u64>,
    logger: &BridgeLogger,
) -> LocalControlResult {
    let Some(store) = store else {
        return rejected("bridge_update_runtime_unavailable");
    };
    match store.request_manual_activation() {
        Ok(Some(state)) => {
            signal_preference_change(update_wake_sender);
            logger.info(
                "native_update_manual_activation_requested",
                state
                    .target_version
                    .as_deref()
                    .map(|version| {
                        format!(
                            "version={version};priority={}",
                            state.priority.as_deref().unwrap_or("normal")
                        )
                    })
                    .as_deref(),
            );
            LocalControlResult::Accepted
        }
        Ok(None) => rejected("bridge_update_not_ready"),
        Err(error) => {
            let code = error.code();
            logger.warning("native_update_manual_activation_failed", Some(code));
            rejected(code)
        }
    }
}

async fn install_selected_mt4_expert(
    ui_state: &UiStateStore,
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    profile_id: &str,
    logger: &BridgeLogger,
) -> LocalControlResult {
    let binding = (|| {
        let state = ui_state.snapshot()?;
        let paths = resolve_profile_paths(root_data_directory, profile_id)?;
        let store =
            OutboxStore::open_or_create(&paths.database_path).map_err(|error| error.code())?;
        let bindings = store.terminal_bindings().map_err(|error| error.code())?;
        resolve_selected_mt4_binding(&state, &bindings).cloned()
    })();
    let binding = match binding {
        Ok(binding) => binding,
        Err(code) => {
            logger.warning("native_mt4_ea_manual_deployment_failed", Some(code));
            return LocalControlResult::Rejected {
                code: code.to_owned(),
            };
        }
    };
    let terminal_instance_id = binding.terminal_instance_id.clone();
    let deployment = deploy_mt4_expert_for_binding(application_directory, &binding).await;
    match deployment {
        Ok(status) => {
            logger.info(
                "native_mt4_ea_manual_deployment_completed",
                Some(&format!(
                    "terminal_id={terminal_instance_id};status={}",
                    status.as_str()
                )),
            );
            LocalControlResult::Mt4EaDeployment {
                status: status.as_str().to_owned(),
            }
        }
        Err(code) => {
            logger.warning("native_mt4_ea_manual_deployment_failed", Some(code));
            LocalControlResult::Rejected {
                code: code.to_owned(),
            }
        }
    }
}

async fn deploy_mt4_expert_for_binding(
    application_directory: &std::path::Path,
    binding: &TerminalBinding,
) -> Result<mt4_expert_installer::Mt4ExpertDeploymentStatus, &'static str> {
    let source = resolve_expert_source(application_directory, env::var_os("AURUM_BRIDGE_MT4_EA"))?;
    let terminal_data_path = binding.terminal_path.clone();
    tokio::task::spawn_blocking(move || deploy_expert(&source, &terminal_data_path))
        .await
        .map_err(|_| "mt4_ea_install_failed")?
}

fn resolve_selected_mt4_binding<'a>(
    state: &UiStateSnapshot,
    bindings: &'a [TerminalBinding],
) -> Result<&'a TerminalBinding, &'static str> {
    if state.selected_platform.as_deref() != Some("mt4") {
        return Err("mt4_platform_not_selected");
    }
    let mt4_bindings = bindings
        .iter()
        .filter(|binding| binding.platform == "mt4")
        .collect::<Vec<_>>();
    if mt4_bindings.is_empty() {
        return Err("mt4_terminal_not_found");
    }
    if mt4_bindings.len() == 1 {
        return Ok(mt4_bindings[0]);
    }
    let selected = state
        .selected_terminal_instance_id
        .as_deref()
        .ok_or("mt4_terminal_selection_required")?;
    mt4_bindings
        .into_iter()
        .find(|binding| binding.terminal_instance_id == selected)
        .ok_or("mt4_terminal_selection_required")
}

async fn configure_observer_profile(
    create: bool,
    observer: ObserverProfileMutation,
    context: ObserverProfileActionContext<'_>,
) -> LocalControlResult {
    let ObserverProfileActionContext {
        application_directory,
        root_data_directory,
        administrator_credential_store,
        administrator_cache,
        observer_runtimes,
        logger,
    } = context;
    let Some(observer_runtimes) = observer_runtimes else {
        return rejected("bridge_observer_management_forbidden");
    };
    let source = {
        let cache = administrator_cache.lock().await;
        if !cache.is_administrator {
            return rejected("bridge_observer_management_forbidden");
        }
        cache
            .observer_sources
            .iter()
            .find(|source| source.bridge_user_id == observer.bridge_user_id)
            .cloned()
    };
    let Some(source) = source else {
        return rejected("bridge_pair_source_invalid");
    };
    let profiles = match list_observer_profiles(root_data_directory) {
        Ok(profiles) => profiles,
        Err(code) => return rejected(code),
    };
    let exists = profiles.contains(&observer.observer_profile_id);
    if create == exists {
        return rejected(if create {
            "bridge_observer_profile_exists"
        } else {
            "bridge_observer_profile_not_found"
        });
    }
    let resolved = match observer_terminal::resolve_observer_terminal(
        &observer.platform,
        std::path::Path::new(&observer.terminal_directory),
    ) {
        Ok(resolved) => resolved,
        Err(code) => return rejected(code),
    };
    if let Err(code) = ensure_observer_terminal_available(
        root_data_directory,
        &observer.observer_profile_id,
        &resolved.terminal_instance_id,
    ) {
        return rejected(code);
    }
    if let Err(code) = observer_runtimes.stop(&observer.observer_profile_id).await {
        return rejected(&code);
    }
    let administrator_credential = match administrator_credential_store.load() {
        Ok(Some(credential)) => credential,
        Ok(None) => return rejected("bridge_not_paired"),
        Err(error) => return rejected(error.code()),
    };
    let endpoints = match resolve_server_endpoints(application_directory, root_data_directory) {
        Ok(endpoints) => endpoints,
        Err(error) => return rejected(error.code()),
    };
    let client = match BridgeAuthClient::new(endpoints, &format!("LiangJianBridge/{VERSION}")) {
        Ok(client) => client,
        Err(error) => return rejected(error.code()),
    };
    let managed = match client
        .managed_observer_credential(
            &administrator_credential.refresh_token,
            source.bridge_user_id,
            &resolved.terminal_instance_id,
        )
        .await
    {
        Ok(credential) => credential,
        Err(error) => return rejected(error.code()),
    };
    let expires_delta = match i64::try_from(managed.refresh_expires_in_seconds)
        .ok()
        .and_then(|seconds| seconds.checked_mul(1_000))
    {
        Some(value) => value,
        None => return rejected("bridge_observer_session_response_invalid"),
    };
    let paths = match resolve_profile_paths(root_data_directory, &observer.observer_profile_id) {
        Ok(paths) => paths,
        Err(code) => return rejected(code),
    };
    let credential_store = match CredentialStore::new(&paths.credential_path) {
        Ok(store) => store,
        Err(error) => return rejected(error.code()),
    };
    if let Err(error) = credential_store.save(&BridgeCredential {
        refresh_token: managed.refresh_token,
        expires_at_utc_msc: now_utc_msc().saturating_add(expires_delta),
    }) {
        return rejected(error.code());
    }
    let preferences_store =
        match BridgePreferencesStore::new(paths.data_directory.join("preferences.json")) {
            Ok(store) => store,
            Err(error) => return rejected(error.code()),
        };
    let account_label = if source.email.trim().is_empty() {
        source.display_name().to_owned()
    } else {
        format!("{} · {}", source.display_name(), source.email)
    };
    if let Err(error) = preferences_store.save_observer_profile(&ObserverProfilePreferences {
        platform: resolved.platform,
        terminal_instance_id: resolved.terminal_instance_id,
        terminal_path: resolved.preference_path.display().to_string(),
        bridge_user_id: source.bridge_user_id,
        observer_account_label: Some(account_label),
        trading_account_id: source.trading_account_id,
        trading_account_label: Some(source.account_summary()),
    }) {
        let _ = credential_store.clear();
        return rejected(error.code());
    }
    if preferences_store.load().observer_enabled
        && let Err(code) = observer_runtimes.start(&observer.observer_profile_id).await
    {
        return rejected(&code);
    }
    administrator_cache.lock().await.invalidate_observers();
    logger.info(
        if create {
            "native_observer_profile_created"
        } else {
            "native_observer_profile_updated"
        },
        Some(&format!("profile={}", observer.observer_profile_id)),
    );
    LocalControlResult::Accepted
}

async fn bind_observer_profile(
    profile_id: &str,
    bridge_user_id: i64,
    context: ObserverProfileActionContext<'_>,
) -> LocalControlResult {
    let paths = match resolve_profile_paths(context.root_data_directory, profile_id) {
        Ok(paths) if paths.data_directory.is_dir() => paths,
        Ok(_) => return rejected("bridge_observer_profile_not_found"),
        Err(code) => return rejected(code),
    };
    let preferences =
        match BridgePreferencesStore::new(paths.data_directory.join("preferences.json")) {
            Ok(store) => store.load(),
            Err(error) => return rejected(error.code()),
        };
    let Some(platform) = preferences.platform.clone() else {
        return rejected("bridge_observer_profile_not_configured");
    };
    let terminal_directory = match platform.as_str() {
        "mt5" => preferences.mt5_terminal_path.clone(),
        "mt4" => preferences.mt4_terminal_path.clone(),
        _ => None,
    };
    let Some(terminal_directory) = terminal_directory else {
        return rejected("bridge_observer_profile_not_configured");
    };
    configure_observer_profile(
        false,
        ObserverProfileMutation {
            observer_profile_id: profile_id.to_owned(),
            bridge_user_id,
            platform,
            terminal_directory,
        },
        context,
    )
    .await
}

async fn observer_runtime_enabled_action(
    profile_id: &str,
    enabled: bool,
    root_data_directory: &std::path::Path,
    administrator_cache: &AsyncMutex<AdministratorCache>,
    observer_runtimes: Option<&ObserverRuntimeManager>,
) -> LocalControlResult {
    let Some(observer_runtimes) = observer_runtimes else {
        return rejected("bridge_observer_management_forbidden");
    };
    if !administrator_cache.lock().await.is_administrator {
        return rejected("bridge_observer_management_forbidden");
    }
    let paths = match resolve_profile_paths(root_data_directory, profile_id) {
        Ok(paths) if paths.data_directory.is_dir() => paths,
        Ok(_) => return rejected("bridge_observer_profile_not_found"),
        Err(code) => return rejected(code),
    };
    let store = match BridgePreferencesStore::new(paths.data_directory.join("preferences.json")) {
        Ok(store) => store,
        Err(error) => return rejected(error.code()),
    };
    if enabled && !observer_preferences_configured(&store.load()) {
        return rejected("bridge_observer_profile_not_configured");
    }
    if let Err(error) = store.save_observer_enabled(enabled) {
        return rejected(error.code());
    }
    let result = if enabled {
        observer_runtimes.start(profile_id).await
    } else {
        observer_runtimes.stop(profile_id).await
    };
    match result {
        Ok(()) => {
            administrator_cache.lock().await.invalidate_observers();
            LocalControlResult::Accepted
        }
        Err(code) => rejected(&code),
    }
}

fn observer_preferences_configured(preferences: &BridgeUserPreferences) -> bool {
    preferences.observer_bridge_user_id.is_some() && observer_terminal_configured(preferences)
}

fn observer_terminal_configured(preferences: &BridgeUserPreferences) -> bool {
    if preferences.selected_terminal_instance_id().is_none() {
        return false;
    }
    match preferences.platform.as_deref() {
        Some("mt5") => preferences
            .mt5_terminal_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).is_file()),
        Some("mt4") => preferences
            .mt4_terminal_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).join("MQL4").is_dir()),
        _ => false,
    }
}

async fn stop_external_observer_runtime(profile_id: &str) -> Result<(), String> {
    let instance_id = profile_instance_id(profile_id).map_err(str::to_owned)?;
    let lock_directory = default_lock_directory().map_err(|error| error.code().to_owned())?;
    let running = SingleInstanceGuard::is_running(&instance_id, &lock_directory)
        .map_err(|error| error.code().to_owned())?;
    if !running {
        return Ok(());
    }
    SingleInstanceGuard::request_shutdown(&instance_id).map_err(|error| error.code().to_owned())?;
    let released = tokio::task::spawn_blocking(move || {
        SingleInstanceGuard::wait_for_release(&instance_id, lock_directory, Duration::from_secs(10))
    })
    .await
    .map_err(|_| "bridge_observer_runtime_join_failed".to_owned())?
    .map_err(|error| error.code().to_owned())?;
    if released {
        Ok(())
    } else {
        Err("bridge_observer_runtime_stop_timeout".to_owned())
    }
}

fn ensure_observer_terminal_available(
    root_data_directory: &std::path::Path,
    profile_id: &str,
    terminal_instance_id: &str,
) -> Result<(), &'static str> {
    let main_paths = resolve_profile_paths(root_data_directory, DEFAULT_PROFILE_ID)?;
    let main = BridgePreferencesStore::new(main_paths.data_directory.join("preferences.json"))
        .map_err(|error| error.code())?
        .load();
    if main.selected_terminal_instance_id() == Some(terminal_instance_id) {
        return Err("observer_terminal_already_assigned");
    }
    for other_profile_id in list_observer_profiles(root_data_directory)? {
        if other_profile_id == profile_id {
            continue;
        }
        let paths = resolve_profile_paths(root_data_directory, &other_profile_id)?;
        let preferences =
            BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
                .map_err(|error| error.code())?
                .load();
        if preferences.selected_terminal_instance_id() == Some(terminal_instance_id) {
            return Err("observer_terminal_already_assigned");
        }
    }
    Ok(())
}

fn rejected(code: &str) -> LocalControlResult {
    LocalControlResult::Rejected {
        code: code.to_owned(),
    }
}

async fn run_profile_lifecycle(
    context: ProfileLifecycleContext<'_>,
    runtime: ProfileLifecycleRuntime,
) -> Result<(), Box<dyn Error>> {
    let ProfileLifecycleContext {
        application_directory,
        root_data_directory,
        profile_id,
        logger,
    } = context;
    let ProfileLifecycleRuntime {
        ready_file,
        expected_terminal_instance_ids,
        update_state_store,
        stop,
        ui_state,
        preferences_store,
        mut preference_change_receiver,
    } = runtime;
    loop {
        let preferences_before_bootstrap = preferences_store.load();
        let mt5_provision_error = if preferences_before_bootstrap.platform.as_deref() == Some("mt5")
        {
            provision_mt5_bindings_if_missing(
                application_directory,
                root_data_directory,
                profile_id,
                &preferences_store,
                &preferences_before_bootstrap,
                logger,
            )
            .await
            .err()
        } else {
            None
        };
        let mut bootstrap =
            NativeProfileBootstrap::load(application_directory, root_data_directory, profile_id)?;
        let preferences = preferences_store.load();
        let status_path = bootstrap.paths.runtime_status_path.clone();
        logger.info(
            "native_runtime_profile_loaded",
            Some(&format!(
                "credential={} mt5_bindings={} mt4_bindings={}",
                match bootstrap.credential_state {
                    CredentialState::Missing => "missing",
                    CredentialState::Present => "present",
                },
                bootstrap.mt5_sessions.len(),
                bootstrap.mt4_bindings.len()
            )),
        );
        let platform = match preferences.platform.as_deref() {
            Some(platform) => platform,
            None => {
                let candidates = bootstrap_terminal_candidates(&bootstrap, None);
                publish_selection_ui_state(
                    SelectionUiContext {
                        logger,
                        ui_state: &ui_state,
                        profile_id,
                        root_data_directory,
                        preferences: &preferences,
                    },
                    "platform_selection_required",
                    None,
                    candidates,
                );
                if !wait_for_preference_change(&mut preference_change_receiver, &stop).await? {
                    return Ok(());
                }
                continue;
            }
        };
        let candidates = bootstrap_terminal_candidates(&bootstrap, Some(platform));
        if candidates.is_empty() {
            publish_selection_ui_state(
                SelectionUiContext {
                    logger,
                    ui_state: &ui_state,
                    profile_id,
                    root_data_directory,
                    preferences: &preferences,
                },
                "terminal_not_found",
                Some(if platform == "mt4" {
                    "mt4_terminal_not_found"
                } else {
                    mt5_provision_error.unwrap_or("mt5_terminal_not_found")
                }),
                candidates,
            );
            if !wait_for_preference_change(&mut preference_change_receiver, &stop).await? {
                return Ok(());
            }
            continue;
        }
        let preferred_terminal = preferences.selected_terminal_instance_id();
        let selected_terminal = if candidates.len() == 1 {
            Some(candidates[0].terminal_instance_id.as_str())
        } else {
            preferred_terminal.filter(|preferred| {
                candidates
                    .iter()
                    .any(|candidate| candidate.terminal_instance_id == *preferred)
            })
        };
        let Some(selected_terminal) = selected_terminal else {
            publish_selection_ui_state(
                SelectionUiContext {
                    logger,
                    ui_state: &ui_state,
                    profile_id,
                    root_data_directory,
                    preferences: &preferences,
                },
                "terminal_selection_required",
                None,
                candidates,
            );
            if !wait_for_preference_change(&mut preference_change_receiver, &stop).await? {
                return Ok(());
            }
            continue;
        };
        retain_selected_terminal(&mut bootstrap, platform, selected_terminal);
        if platform == "mt4"
            && let Some(binding) = bootstrap.mt4_bindings.first()
        {
            match deploy_mt4_expert_for_binding(application_directory, binding).await {
                Ok(status) => logger.info(
                    "native_mt4_ea_automatic_deployment_completed",
                    Some(&format!(
                        "terminal_id={};status={}",
                        binding.terminal_instance_id,
                        status.as_str()
                    )),
                ),
                Err(code) => {
                    logger.warning("native_mt4_ea_automatic_deployment_failed", Some(code))
                }
            }
        }
        if bootstrap.credential_state == CredentialState::Missing {
            publish_inactive_status(
                logger,
                &ui_state,
                InactiveStatus {
                    status_path: &status_path,
                    root_data_directory,
                    profile_id,
                    phase: "pairing_required",
                    server_state: "pairing_required",
                    error_code: None,
                    preferences: Some(&preferences),
                },
            );
            logger.info("native_runtime_pairing_required", None);
            let credentials = ProfileCredentialSource::new(bootstrap.credential_store)?;
            loop {
                tokio::select! {
                    changed = credentials.changed() => {
                        changed?;
                        break;
                    }
                    _ = stop.cancelled() => return Ok(()),
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {
                        publish_inactive_status(
                            logger,
                            &ui_state,
                            InactiveStatus {
                                status_path: &status_path,
                                root_data_directory,
                                profile_id,
                                phase: "pairing_required",
                                server_state: "pairing_required",
                                error_code: None,
                                preferences: Some(&preferences),
                            },
                        );
                    }
                }
            }
            continue;
        }
        if bootstrap.mt5_sessions.is_empty() && bootstrap.mt4_bindings.is_empty() {
            return Err("bridge_terminals_invalid".into());
        }
        let configured_terminal_ids = bootstrap
            .mt5_sessions
            .iter()
            .map(|session| session.binding.terminal_instance_id.as_str())
            .chain(
                bootstrap
                    .mt4_bindings
                    .iter()
                    .map(|binding| binding.terminal_instance_id.as_str()),
            )
            .collect::<std::collections::BTreeSet<_>>();
        if expected_terminal_instance_ids
            .iter()
            .any(|terminal_id| !configured_terminal_ids.contains(terminal_id.as_str()))
        {
            return Err("bridge_expected_terminal_missing".into());
        }
        let endpoints = resolve_server_endpoints(application_directory, root_data_directory)?;
        let startup_credential_store = CredentialStore::new(&bootstrap.paths.credential_path)?;
        let binding_source = ProfileTerminalBindingSource::new(Arc::clone(&bootstrap.store))?;
        publish_inactive_status(
            logger,
            &ui_state,
            InactiveStatus {
                status_path: &status_path,
                root_data_directory,
                profile_id,
                phase: "connecting",
                server_state: "connecting",
                error_code: None,
                preferences: Some(&preferences),
            },
        );
        let clock: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(now_utc_msc);
        let connected =
            NativeConnectedRuntime::start(bootstrap, endpoints, Arc::clone(&clock)).await?;
        let connection_state = connected.connection_state();
        let active_sessions = connected.active_sessions();
        let runtime_status = connected.status_handle();
        let runtime_stop = SessionCancellation::default();
        let ready_stop = runtime_stop.clone();
        let ready_logger = logger.clone();
        let runtime_ready_file = ready_file.clone();
        let runtime_expected_terminal_instance_ids = expected_terminal_instance_ids.clone();
        let ready_application_directory = application_directory.to_path_buf();
        let ready_root_data_directory = root_data_directory.to_path_buf();
        let ready_update_state_store = update_state_store.clone();
        let ready_waiter = tokio::spawn(async move {
            wait_and_write_ready(
                runtime_ready_file,
                runtime_expected_terminal_instance_ids,
                connection_state,
                active_sessions,
                ready_stop,
                StartupReadyContext {
                    application_directory: ready_application_directory,
                    root_data_directory: ready_root_data_directory,
                    credential_store: startup_credential_store,
                    update_state_store: ready_update_state_store,
                    logger: ready_logger,
                },
            )
            .await
        });
        logger.info("native_runtime_connections_started", None);
        let status_stop = SessionCancellation::default();
        let status_monitor = tokio::spawn(monitor_runtime_status(
            runtime_status.clone(),
            status_stop.clone(),
            RuntimeStatusMonitorContext {
                status_path: status_path.clone(),
                profile_id: profile_id.to_owned(),
                root_data_directory: root_data_directory.to_path_buf(),
                ui_state: ui_state.clone(),
                preferences_store: preferences_store.clone(),
                logger: logger.clone(),
            },
        ));
        let runtime = connected.run(runtime_stop.clone());
        tokio::pin!(runtime);
        let trigger = tokio::select! {
            result = &mut runtime => ProfileRuntimeTrigger::Completed(result),
            changed = binding_source.changed() => match changed {
                Ok(()) => ProfileRuntimeTrigger::BindingChanged,
                Err(error) => ProfileRuntimeTrigger::BindingWatchFailed(error),
            },
            changed = preference_change_receiver.changed() => match changed {
                Ok(()) => ProfileRuntimeTrigger::PreferenceChanged,
                Err(_) => ProfileRuntimeTrigger::Stopped,
            },
            _ = stop.cancelled() => ProfileRuntimeTrigger::Stopped,
        };
        runtime_stop.cancel();
        let (runtime_result, reload_bindings, binding_watch_error) = match trigger {
            ProfileRuntimeTrigger::Completed(result) => (result, false, None),
            ProfileRuntimeTrigger::BindingChanged => (runtime.await, true, None),
            ProfileRuntimeTrigger::PreferenceChanged => (runtime.await, true, None),
            ProfileRuntimeTrigger::BindingWatchFailed(error) => (runtime.await, false, Some(error)),
            ProfileRuntimeTrigger::Stopped => (runtime.await, false, None),
        };
        match runtime_status.snapshot(profile_id, VERSION, now_utc_msc()) {
            Ok(snapshot) => publish_runtime_status_or_warn(logger, &status_path, &snapshot),
            Err(error) => logger.warning("native_runtime_status_failed", Some(error.code())),
        }
        publish_active_ui_state_or_warn(
            logger,
            &runtime_status,
            profile_id,
            root_data_directory,
            &ui_state,
            &preferences_store,
        );
        status_stop.cancel();
        status_monitor
            .await
            .map_err(|_| "bridge_runtime_status_task_failed")?;
        ready_waiter
            .await
            .map_err(|_| "bridge_startup_signal_task_failed")?
            .map_err(|error| -> Box<dyn Error> { error.into() })?;
        if let Some(error) = binding_watch_error {
            return Err(error.into());
        }
        runtime_result.map_err(|error| -> Box<dyn Error> { error.into() })?;
        if reload_bindings && !stop.is_cancelled() {
            logger.info("native_runtime_binding_changed", None);
            continue;
        }
        stop.cancel();
        return Ok(());
    }
}

async fn provision_mt5_bindings_if_missing(
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    profile_id: &str,
    preferences_store: &BridgePreferencesStore,
    preferences: &BridgeUserPreferences,
    logger: &BridgeLogger,
) -> Result<(), &'static str> {
    let paths = resolve_profile_paths(root_data_directory, profile_id)?;
    let store = OutboxStore::open_or_create(&paths.database_path).map_err(|error| error.code())?;
    if store
        .terminal_bindings()
        .map_err(|error| error.code())?
        .iter()
        .any(|binding| binding.platform == "mt5")
    {
        return Ok(());
    }
    let installations = selected_or_discovered(preferences.mt5_terminal_path.as_deref());
    if installations.is_empty() {
        return Err("mt5_terminal_not_found");
    }
    let python = application_directory.join(PYTHON_RELATIVE_PATH);
    let worker = application_directory.join(MT5_WORKER_RELATIVE_PATH);
    if !python.is_file() {
        return Err("mt5_python_runtime_not_found");
    }
    if !worker.is_file() {
        return Err("mt5_worker_script_not_found");
    }
    let preferred = preferences.mt5_terminal_instance_id.as_deref();
    let mut accepted = Vec::new();
    let mut last_error = "mt5_probe_failed";
    for installation in installations {
        if preferred.is_some_and(|value| value != installation.terminal_instance_id) {
            continue;
        }
        let python = python.clone();
        let worker = worker.clone();
        let terminal = installation.executable_path.clone();
        let result = tokio::task::spawn_blocking(move || {
            probe_terminal(&python, &worker, &terminal, MT5_PROBE_TIMEOUT)
        })
        .await
        .map_err(|_| "mt5_probe_join_failed")?;
        let probe = match result {
            Ok(probe) => probe,
            Err(code) => {
                last_error = code;
                logger.warning(
                    "native_mt5_terminal_probe_failed",
                    Some(&format!(
                        "terminal_id={};code={code}",
                        installation.terminal_instance_id
                    )),
                );
                continue;
            }
        };
        if let Err(code) = persist_mt5_probe(&store, &installation, &probe, now_utc_msc()) {
            last_error = code;
            continue;
        }
        logger.info(
            "native_mt5_terminal_provisioned",
            Some(&format!(
                "profile={profile_id};terminal_id={}",
                installation.terminal_instance_id
            )),
        );
        accepted.push(installation.terminal_instance_id);
    }
    if accepted.is_empty() {
        return Err(if preferred.is_some() {
            "mt5_probe_identity_mismatch"
        } else {
            last_error
        });
    }
    if accepted.len() == 1 && preferred.is_none() {
        preferences_store
            .save_terminal("mt5", &accepted[0])
            .map_err(|error| error.code())?;
    }
    Ok(())
}

fn persist_mt5_probe(
    store: &OutboxStore,
    installation: &Mt5Installation,
    probe: &Mt5ProbeResult,
    observed_at_utc_msc: i64,
) -> Result<(), &'static str> {
    if observer_terminal::mt5_terminal_instance_id(&probe.executable_path)?
        != installation.terminal_instance_id
        || probe.executable_path != installation.executable_path
    {
        return Err("mt5_probe_identity_mismatch");
    }
    store
        .activate_terminal_binding(
            &installation.terminal_instance_id,
            "mt5",
            &probe.executable_path,
            &probe.account_ref,
            observed_at_utc_msc,
        )
        .map(|_| ())
        .map_err(|error| error.code())
}

fn signal_preference_change(sender: &watch::Sender<u64>) {
    sender.send_modify(|revision| *revision = revision.saturating_add(1));
}

fn apply_autostart_selection(
    application_directory: &std::path::Path,
    preferences_store: &BridgePreferencesStore,
    enabled: bool,
) -> Result<(), &'static str> {
    let previous = preferences_store.load().auto_start_enabled;
    AutoStartRegistration::set_enabled_for_installed_application(application_directory, enabled)
        .map_err(|error| error.code())?;
    if let Err(error) = preferences_store.save_autostart_enabled(enabled) {
        let _ = AutoStartRegistration::set_enabled_for_installed_application(
            application_directory,
            previous,
        );
        return Err(error.code());
    }
    Ok(())
}

fn endpoint_settings_allowed(
    ui_state: &UiStateStore,
    profile_id: &str,
    cached_administrator: bool,
) -> bool {
    ui_state.snapshot().is_ok_and(|state| {
        endpoint_settings_allowed_for_state(profile_id, &state, cached_administrator)
    })
}

fn endpoint_settings_allowed_for_state(
    profile_id: &str,
    state: &UiStateSnapshot,
    cached_administrator: bool,
) -> bool {
    profile_id == DEFAULT_PROFILE_ID
        && (state.is_administrator || cached_administrator || !state.server_connected)
}

fn resolve_endpoint_selection(
    application_directory: &std::path::Path,
    settings: &EndpointSettingsSelection,
) -> Result<ServerEndpoints, &'static str> {
    if settings.follow_official {
        load_packaged_server_endpoints(application_directory.join("server-endpoints.json"))
            .map_err(|error| stable_endpoint_error(error.code()))
    } else {
        ServerEndpoints::from_server_url(&settings.server_url)
            .map_err(|error| stable_endpoint_error(error.code()))
    }
}

fn resolve_official_endpoint_selection(
    application_directory: &std::path::Path,
) -> Result<EndpointSettingsSelection, &'static str> {
    let official =
        load_packaged_server_endpoints(application_directory.join("server-endpoints.json"))
            .map_err(|error| stable_endpoint_error(error.code()))?;
    Ok(EndpointSettingsSelection {
        follow_official: true,
        server_url: official.control_base().as_str().to_owned(),
    })
}

fn apply_endpoint_selection(
    application_directory: &std::path::Path,
    root_data_directory: &std::path::Path,
    credential_store: &CredentialStore,
    settings: &EndpointSettingsSelection,
) -> Result<bool, &'static str> {
    let selected = resolve_endpoint_selection(application_directory, settings)?;
    let current = resolve_server_endpoints(application_directory, root_data_directory).ok();
    let control_changed = current
        .as_ref()
        .is_none_or(|value| value.control_base() != selected.control_base());
    if control_changed {
        credential_store
            .clear()
            .map_err(|error| stable_endpoint_error(error.code()))?;
    }
    if settings.follow_official {
        clear_endpoint_settings(root_data_directory)
            .map_err(|error| stable_endpoint_error(error.code()))?;
    } else {
        save_endpoint_settings(root_data_directory, &selected)
            .map_err(|error| stable_endpoint_error(error.code()))?;
    }
    Ok(control_changed)
}

fn stable_endpoint_error(code: &str) -> &'static str {
    match code {
        "bridge_control_url_invalid"
        | "bridge_server_url_invalid"
        | "bridge_realtime_url_invalid"
        | "bridge_server_endpoints_invalid"
        | "bridge_server_endpoints_missing"
        | "bridge_endpoint_settings_invalid"
        | "bridge_endpoint_settings_write_failed"
        | "bridge_endpoint_settings_encode_failed"
        | "bridge_endpoint_settings_replace_failed"
        | "bridge_endpoint_settings_clear_failed"
        | "bridge_endpoint_settings_path_invalid"
        | "bridge_endpoint_directory_invalid" => "bridge_endpoint_settings_invalid",
        "bridge_credential_clear_failed" => "bridge_credential_clear_failed",
        _ => "bridge_endpoint_settings_failed",
    }
}

fn endpoint_connectivity_description(
    control_reachable: bool,
    realtime_reachable: bool,
) -> &'static str {
    match (control_reachable, realtime_reachable) {
        (true, true) => "控制服务正常，实时通道端口可达。",
        (false, false) => "控制服务和实时通道端口均无法连接，请检查地址或网络。",
        (true, false) => "控制服务正常，但实时通道端口无法连接。",
        (false, true) => "实时通道端口可达，但控制服务健康检查失败。",
    }
}

async fn wait_for_preference_change(
    receiver: &mut watch::Receiver<u64>,
    stop: &SessionCancellation,
) -> Result<bool, &'static str> {
    tokio::select! {
        changed = receiver.changed() => changed
            .map(|()| true)
            .map_err(|_| "bridge_preference_watch_failed"),
        _ = stop.cancelled() => Ok(false),
    }
}

fn bootstrap_terminal_candidates(
    bootstrap: &NativeProfileBootstrap,
    platform: Option<&str>,
) -> Vec<UiTerminalCandidate> {
    let mut candidates = bootstrap
        .mt5_sessions
        .iter()
        .map(|session| &session.binding)
        .chain(bootstrap.mt4_bindings.iter())
        .filter(|binding| platform.is_none_or(|value| binding.platform == value))
        .map(|binding| UiTerminalCandidate {
            terminal_instance_id: binding.terminal_instance_id.clone(),
            platform: binding.platform.clone(),
            broker_server: binding.account_ref.broker_server.clone(),
            login: binding.account_ref.login.clone(),
            display_name: Some(format!(
                "{} · {}",
                binding.account_ref.login, binding.account_ref.broker_server
            )),
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.platform
            .cmp(&right.platform)
            .then_with(|| left.login.cmp(&right.login))
            .then_with(|| left.broker_server.cmp(&right.broker_server))
            .then_with(|| left.terminal_instance_id.cmp(&right.terminal_instance_id))
    });
    candidates
}

fn retain_selected_terminal(
    bootstrap: &mut NativeProfileBootstrap,
    platform: &str,
    terminal_instance_id: &str,
) {
    if platform == "mt4" {
        bootstrap.mt5_sessions.clear();
        bootstrap
            .mt4_bindings
            .retain(|binding| binding.terminal_instance_id == terminal_instance_id);
    } else {
        bootstrap.mt4_bindings.clear();
        bootstrap
            .mt5_sessions
            .retain(|session| session.binding.terminal_instance_id == terminal_instance_id);
    }
}

fn apply_preferences_to_ui_state(
    state: &mut UiStateSnapshot,
    preferences: &BridgeUserPreferences,
    root_data_directory: &std::path::Path,
) {
    state.autostart_enabled = preferences.auto_start_enabled;
    state.custom_endpoint_active = root_data_directory
        .join(ENDPOINT_SETTINGS_FILE_NAME)
        .is_file();
    if state.selected_platform.is_none() {
        state.selected_platform = preferences.platform.clone();
    }
    if state.selected_terminal_instance_id.is_none() {
        state.selected_terminal_instance_id = preferences
            .selected_terminal_instance_id()
            .map(str::to_owned);
    }
}

fn publish_selection_ui_state(
    context: SelectionUiContext<'_>,
    phase: &str,
    detail_code: Option<&str>,
    terminal_candidates: Vec<UiTerminalCandidate>,
) {
    let SelectionUiContext {
        logger,
        ui_state,
        profile_id,
        root_data_directory,
        preferences,
    } = context;
    let selected_terminal_instance_id = preferences
        .selected_terminal_instance_id()
        .filter(|selected| {
            terminal_candidates
                .iter()
                .any(|candidate| candidate.terminal_instance_id == *selected)
        })
        .map(str::to_owned);
    let state = UiStateSnapshot {
        schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
        revision: 1,
        profile_id: profile_id.to_owned(),
        observed_at_utc_msc: now_utc_msc(),
        phase: phase.to_owned(),
        detail_code: detail_code.map(str::to_owned),
        selected_platform: preferences.platform.clone(),
        selected_terminal_instance_id,
        terminal_candidates,
        terminals: Vec::new(),
        server_connected: false,
        last_data_sync_utc_msc: None,
        bridge_version: VERSION.to_owned(),
        can_manage_observer_sources: false,
        is_administrator: false,
        observer_sources: Vec::new(),
        observer_profiles: Vec::new(),
        update_notice: None,
        autostart_enabled: preferences.auto_start_enabled,
        custom_endpoint_active: root_data_directory
            .join(ENDPOINT_SETTINGS_FILE_NAME)
            .is_file(),
    };
    if let Err(error_code) = ui_state.publish(state) {
        logger.warning("native_ui_state_publish_failed", Some(error_code));
    }
}

async fn monitor_runtime_status(
    handle: NativeRuntimeStatusHandle,
    stop: SessionCancellation,
    context: RuntimeStatusMonitorContext,
) {
    let RuntimeStatusMonitorContext {
        status_path,
        profile_id,
        root_data_directory,
        ui_state,
        preferences_store,
        logger,
    } = context;
    let mut last_fingerprint = None;
    let mut last_publish = Instant::now() - Duration::from_secs(10);
    loop {
        let snapshot = match handle.snapshot(&profile_id, VERSION, now_utc_msc()) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                logger.warning("native_runtime_status_failed", Some(error.code()));
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                }
                continue;
            }
        };
        let fingerprint = runtime_status_fingerprint(&snapshot);
        let changed = last_fingerprint.as_ref() != Some(&fingerprint);
        if changed || last_publish.elapsed() >= Duration::from_secs(5) {
            publish_runtime_status_or_warn(&logger, &status_path, &snapshot);
            publish_active_ui_state_or_warn(
                &logger,
                &handle,
                &profile_id,
                &root_data_directory,
                &ui_state,
                &preferences_store,
            );
            last_publish = Instant::now();
        }
        if changed {
            log_runtime_status(&logger, &snapshot);
            last_fingerprint = Some(fingerprint);
        }
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

fn publish_inactive_status(
    logger: &BridgeLogger,
    ui_state: &UiStateStore,
    status: InactiveStatus<'_>,
) {
    let InactiveStatus {
        status_path,
        root_data_directory,
        profile_id,
        phase,
        server_state,
        error_code,
        preferences,
    } = status;
    let snapshot = match NativeRuntimeStatusSnapshot::inactive(
        profile_id,
        VERSION,
        now_utc_msc(),
        phase,
        server_state,
        error_code,
    ) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            logger.warning("native_runtime_status_failed", Some(error.code()));
            return;
        }
    };
    publish_runtime_status_or_warn(logger, status_path, &snapshot);
    match snapshot.to_ui_state(1) {
        Ok(mut state) => {
            if let Some(preferences) = preferences {
                apply_preferences_to_ui_state(&mut state, preferences, root_data_directory);
            }
            if let Err(error_code) = ui_state.publish(state) {
                logger.warning("native_ui_state_publish_failed", Some(error_code));
            }
        }
        Err(error) => logger.warning("native_ui_state_publish_failed", Some(error.code())),
    }
}

fn publish_runtime_status(
    status_path: &std::path::Path,
    snapshot: &NativeRuntimeStatusSnapshot,
) -> Result<(), String> {
    let payload =
        serde_json::to_vec(snapshot).map_err(|_| "bridge_runtime_status_serialize_failed")?;
    write_runtime_status_snapshot(status_path, &payload)
        .map_err(|_| "bridge_runtime_status_write_failed".to_owned())
}

fn publish_runtime_status_or_warn(
    logger: &BridgeLogger,
    status_path: &std::path::Path,
    snapshot: &NativeRuntimeStatusSnapshot,
) {
    if let Err(error_code) = publish_runtime_status(status_path, snapshot) {
        logger.warning("native_runtime_status_failed", Some(&error_code));
    }
}

fn publish_active_ui_state_or_warn(
    logger: &BridgeLogger,
    handle: &NativeRuntimeStatusHandle,
    profile_id: &str,
    root_data_directory: &std::path::Path,
    ui_state: &UiStateStore,
    preferences_store: &BridgePreferencesStore,
) {
    match handle.ui_snapshot(profile_id, VERSION, now_utc_msc(), 1) {
        Ok(mut state) => {
            apply_preferences_to_ui_state(
                &mut state,
                &preferences_store.load(),
                root_data_directory,
            );
            if let Err(error_code) = ui_state.publish(state) {
                logger.warning("native_ui_state_publish_failed", Some(error_code));
            }
        }
        Err(error) => logger.warning("native_ui_state_publish_failed", Some(error.code())),
    }
}

fn runtime_status_fingerprint(snapshot: &NativeRuntimeStatusSnapshot) -> String {
    let terminals = snapshot
        .terminals
        .iter()
        .map(|terminal| {
            format!(
                "{}:{}:{}:{}:{}:{}:{}",
                terminal.terminal_instance_id,
                terminal.state,
                terminal.worker_state,
                terminal.collector_state,
                terminal.data_ready,
                terminal.worker_consecutive_failures,
                terminal.error_code.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        snapshot.phase,
        snapshot.server_state,
        snapshot.server_error_code.as_deref().unwrap_or(""),
        terminals,
        snapshot.reconciliation.pending,
        snapshot.reconciliation.error_codes.join(","),
        snapshot.reconciliation.consecutive_failures,
        snapshot
            .reconciliation
            .fatal_error_code
            .as_deref()
            .unwrap_or("")
    )
}

fn log_runtime_status(logger: &BridgeLogger, snapshot: &NativeRuntimeStatusSnapshot) {
    let ready = snapshot
        .terminals
        .iter()
        .filter(|terminal| terminal.data_ready)
        .count();
    let message = format!(
        "phase={} server={} terminals={} ready={} reconciliation_pending={} server_error={} reconciliation_errors={}",
        snapshot.phase,
        snapshot.server_state,
        snapshot.terminals.len(),
        ready,
        snapshot.reconciliation.pending,
        snapshot.server_error_code.as_deref().unwrap_or("none"),
        if snapshot.reconciliation.error_codes.is_empty() {
            "none".to_owned()
        } else {
            snapshot.reconciliation.error_codes.join(",")
        }
    );
    if snapshot.phase == "online" {
        logger.info("native_runtime_status_changed", Some(&message));
    } else if snapshot.phase == "degraded" {
        logger.warning("native_runtime_status_changed", Some(&message));
    } else {
        logger.info("native_runtime_status_changed", Some(&message));
    }
}

fn stable_runtime_error_code(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        value.to_owned()
    } else {
        "native_runtime_failed".to_owned()
    }
}

async fn wait_and_write_ready(
    ready_file: Option<PathBuf>,
    expected_terminal_instance_ids: Vec<String>,
    connection_state: Arc<CoreConnectionState>,
    active_sessions: Arc<ActiveMt5Sessions>,
    stop: SessionCancellation,
    context: StartupReadyContext,
) -> Result<(), String> {
    let StartupReadyContext {
        application_directory,
        root_data_directory,
        credential_store,
        update_state_store,
        logger,
    } = context;
    let Some(output) = ready_file else {
        return Ok(());
    };
    loop {
        if stop.is_cancelled() {
            return Ok(());
        }
        let connected = connection_state
            .current()
            .map_err(|error| error.to_string())?
            .is_some_and(|transition| transition.state == ConnectionState::Connected);
        let running_terminal_ids = active_sessions
            .statuses()
            .into_iter()
            .filter(|status| status.state == TerminalSessionState::Ready && status.data_ready)
            .map(|status| status.route.terminal_instance_id)
            .collect::<std::collections::BTreeSet<_>>();
        if connected
            && expected_terminal_instance_ids
                .iter()
                .all(|terminal_id| running_terminal_ids.contains(terminal_id))
        {
            release_startup_maintenance_lease(
                update_state_store.as_ref(),
                &application_directory,
                &root_data_directory,
                &credential_store,
                &logger,
            )
            .await;
            let write_result = write_startup_ready_signal(&StartupReadyOptions {
                output: output.clone(),
                version: VERSION.split('-').next().unwrap_or(VERSION).to_owned(),
                server_connected: true,
                running_terminal_instance_ids: running_terminal_ids.into_iter().collect(),
                ready_at_utc_msc: now_utc_msc(),
            });
            match write_result {
                Ok(()) => {
                    logger.info(
                        "startup_ready_confirmed",
                        Some(&format!("version={VERSION}")),
                    );
                    return Ok(());
                }
                Err(_) => logger.error("startup_ready_signal_failed", None),
            }
        }
        tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::{AccountRef, DataDeltaMessage};
    use bridge_security_win::BridgeCredential;
    use bridge_transport::load_endpoint_settings;

    #[test]
    fn endpoint_settings_permission_matches_the_dotnet_recovery_rule() {
        let mut state = NativeRuntimeStatusSnapshot::inactive(
            DEFAULT_PROFILE_ID,
            VERSION,
            now_utc_msc(),
            "starting",
            "stopped",
            None,
        )
        .expect("runtime status")
        .to_ui_state(1)
        .expect("UI state");
        assert!(endpoint_settings_allowed_for_state(
            DEFAULT_PROFILE_ID,
            &state,
            false,
        ));
        assert!(!endpoint_settings_allowed_for_state(
            "source-1", &state, true,
        ));
        state.server_connected = true;
        assert!(!endpoint_settings_allowed_for_state(
            DEFAULT_PROFILE_ID,
            &state,
            false,
        ));
        assert!(endpoint_settings_allowed_for_state(
            DEFAULT_PROFILE_ID,
            &state,
            true,
        ));
        state.is_administrator = true;
        assert!(endpoint_settings_allowed_for_state(
            DEFAULT_PROFILE_ID,
            &state,
            false,
        ));
    }

    #[test]
    fn observer_profiles_never_own_the_global_update_state_or_coordinator() {
        let application = unique_test_directory("observer-update-isolation");
        std::fs::create_dir_all(&application).expect("application directory");
        assert!(
            resolve_update_state_store(&application, "source-1")
                .expect("observer update resolution")
                .is_none()
        );
        std::fs::remove_dir_all(application).expect("cleanup");
    }

    #[test]
    fn mt4_expert_repair_uses_the_only_binding_or_the_explicit_selection() {
        let mut state = NativeRuntimeStatusSnapshot::inactive(
            DEFAULT_PROFILE_ID,
            VERSION,
            now_utc_msc(),
            "starting",
            "stopped",
            None,
        )
        .expect("runtime status")
        .to_ui_state(1)
        .expect("UI state");
        let first = mt4_binding("mt4_0123456789abcdef01234567", "one");
        let second = mt4_binding("mt4_89abcdef0123456789abcdef", "two");

        assert_eq!(
            resolve_selected_mt4_binding(&state, std::slice::from_ref(&first)),
            Err("mt4_platform_not_selected")
        );
        state.selected_platform = Some("mt4".to_owned());
        assert_eq!(
            resolve_selected_mt4_binding(&state, &[]),
            Err("mt4_terminal_not_found")
        );
        assert_eq!(
            resolve_selected_mt4_binding(&state, std::slice::from_ref(&first))
                .map(|binding| binding.terminal_instance_id.as_str()),
            Ok(first.terminal_instance_id.as_str())
        );
        assert_eq!(
            resolve_selected_mt4_binding(&state, &[first.clone(), second.clone()]),
            Err("mt4_terminal_selection_required")
        );
        state.selected_terminal_instance_id = Some(second.terminal_instance_id.clone());
        assert_eq!(
            resolve_selected_mt4_binding(&state, &[first, second.clone()])
                .map(|binding| binding.terminal_instance_id.as_str()),
            Ok(second.terminal_instance_id.as_str())
        );
    }

    #[test]
    fn administrator_cache_decorates_only_the_default_profile_with_live_observer_controls() {
        let mut state = NativeRuntimeStatusSnapshot::inactive(
            DEFAULT_PROFILE_ID,
            VERSION,
            now_utc_msc(),
            "starting",
            "stopped",
            None,
        )
        .expect("runtime status")
        .to_ui_state(1)
        .expect("UI state");
        let cache = AdministratorCache {
            is_administrator: true,
            observer_sources: vec![ManagedObserverSource {
                bridge_user_id: 9,
                email: "source@example.com".to_owned(),
                nickname: None,
                source_id: Some(1),
                source_name: Some("一号观摩源".to_owned()),
                source_status: Some("active".to_owned()),
                trading_account_id: Some(2),
                login_account: Some("596520".to_owned()),
                broker_server: Some("DooTechnology-Demo".to_owned()),
            }],
            observer_projection: ObserverUiProjection {
                profiles: vec![UiObserverProfile {
                    observer_profile_id: "source-1".to_owned(),
                    platform: Some("mt5".to_owned()),
                    terminal_directory: Some(r"C:\Broker MT5".to_owned()),
                    configured: true,
                    enabled: true,
                    terminal_instance_id: Some("mt5_0123456789abcdef01234567".to_owned()),
                    bridge_user_id: Some(9),
                    observer_account_label: Some("一号观摩源".to_owned()),
                    trading_account_label: Some("596520 · DooTechnology-Demo".to_owned()),
                    runtime_phase: Some("online".to_owned()),
                    runtime_detail_code: None,
                }],
                terminals: vec![UiTerminalStatus {
                    terminal_instance_id: "mt5_0123456789abcdef01234567".to_owned(),
                    platform: "mt5".to_owned(),
                    broker_server: "DooTechnology-Demo".to_owned(),
                    login: "596520".to_owned(),
                    runtime_state: "running".to_owned(),
                    error_code: None,
                    observer_profile_id: Some("source-1".to_owned()),
                    terminal_trading_allowed: Some(true),
                    program_trading_allowed: None,
                    account_trading_allowed: Some(true),
                    account_expert_trading_allowed: Some(true),
                    mt4_expert_restart_required: false,
                }],
            },
            ..AdministratorCache::default()
        };
        cache.decorate(DEFAULT_PROFILE_ID, &mut state);
        assert!(state.is_administrator);
        assert_eq!(state.observer_sources.len(), 1);
        assert!(state.can_manage_observer_sources);
        assert_eq!(state.observer_profiles.len(), 1);
        assert_eq!(state.terminals.len(), 1);
        state
            .validate(DEFAULT_PROFILE_ID)
            .expect("decorated default state");

        let mut observer_state = NativeRuntimeStatusSnapshot::inactive(
            "source-1",
            VERSION,
            now_utc_msc(),
            "starting",
            "stopped",
            None,
        )
        .expect("observer runtime status")
        .to_ui_state(1)
        .expect("observer UI state");
        cache.decorate("source-1", &mut observer_state);
        assert!(!observer_state.is_administrator);
        assert!(observer_state.observer_sources.is_empty());
        assert!(!observer_state.can_manage_observer_sources);
        assert!(observer_state.observer_profiles.is_empty());
    }

    #[test]
    fn endpoint_selection_uses_dotnet_storage_and_clears_old_authorization() {
        let root = unique_test_directory("endpoint-selection");
        let application = root.join("application");
        let data = root.join("data");
        std::fs::create_dir_all(&application).expect("application directory");
        std::fs::create_dir_all(&data).expect("data directory");
        std::fs::write(
            application.join("server-endpoints.json"),
            br#"{"schema_version":1,"server_url":"https://official.example"}"#,
        )
        .expect("official endpoints");
        let credential_store =
            CredentialStore::new(data.join("credential.dat")).expect("credential store");
        credential_store
            .save(&BridgeCredential {
                refresh_token: "r".repeat(48),
                expires_at_utc_msc: 1_900_000_000_000,
            })
            .expect("credential");
        let custom = EndpointSettingsSelection {
            follow_official: false,
            server_url: "http://127.0.0.1:3000/".to_owned(),
        };
        assert_eq!(
            apply_endpoint_selection(&application, &data, &credential_store, &custom),
            Ok(true)
        );
        assert_eq!(
            load_endpoint_settings(data.join(ENDPOINT_SETTINGS_FILE_NAME))
                .expect("custom endpoints")
                .control_base()
                .as_str(),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(credential_store.load().expect("cleared credential"), None);
        let official =
            resolve_official_endpoint_selection(&application).expect("official endpoint selection");
        assert_eq!(
            apply_endpoint_selection(&application, &data, &credential_store, &official),
            Ok(true)
        );
        assert!(!data.join(ENDPOINT_SETTINGS_FILE_NAME).exists());
        std::fs::remove_dir_all(root).expect("remove endpoint selection fixture");
    }

    #[test]
    fn observer_runtime_starts_only_for_a_complete_dotnet_compatible_profile() {
        let root = unique_test_directory("observer-configured");
        let mt5 = root.join("terminal64.exe");
        std::fs::create_dir_all(&root).expect("observer fixture directory");
        std::fs::write(&mt5, b"fixture").expect("observer terminal fixture");
        let mut preferences = BridgeUserPreferences {
            platform: Some("mt5".to_owned()),
            mt5_terminal_instance_id: Some("mt5_0123456789abcdef01234567".to_owned()),
            mt5_terminal_path: Some(mt5.display().to_string()),
            observer_bridge_user_id: Some(29),
            ..BridgeUserPreferences::default()
        };
        assert!(observer_preferences_configured(&preferences));
        preferences.observer_bridge_user_id = None;
        assert!(!observer_preferences_configured(&preferences));
        assert!(observer_terminal_configured(&preferences));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn observer_ui_projection_combines_preferences_runtime_route_and_permissions() {
        let root = unique_test_directory("observer-ui-projection");
        std::fs::create_dir_all(&root).expect("observer projection root");
        let now = now_utc_msc();
        let paths = resolve_profile_paths(&root, "source-1").expect("observer paths");
        let terminal = root.join("Broker MT5").join("terminal64.exe");
        std::fs::create_dir_all(terminal.parent().expect("terminal parent"))
            .expect("terminal directory");
        std::fs::write(&terminal, b"terminal").expect("terminal fixture");
        let terminal_instance_id = "mt5_cccccccccccccccccccccccc";
        BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
            .expect("observer preferences")
            .save_observer_profile(&ObserverProfilePreferences {
                platform: "mt5".to_owned(),
                terminal_instance_id: terminal_instance_id.to_owned(),
                terminal_path: terminal.display().to_string(),
                bridge_user_id: 42,
                observer_account_label: Some("一号观摩源".to_owned()),
                trading_account_id: Some(9),
                trading_account_label: Some("596520 · Broker-Demo".to_owned()),
            })
            .expect("save observer profile");
        let account_ref = AccountRef {
            broker_server: "Broker-Demo".to_owned(),
            login: "596520".to_owned(),
        };
        let store = OutboxStore::open_or_create(&paths.database_path).expect("observer store");
        let binding = store
            .activate_terminal_binding(terminal_instance_id, "mt5", &terminal, &account_ref, now)
            .expect("observer binding");
        store
            .persist_data_delta(&DataDeltaMessage {
                v: 3,
                message_type: "data_delta".to_owned(),
                message_id: "msg_observer_permission_000001".to_owned(),
                sent_at_utc_msc: now,
                terminal_instance_id: terminal_instance_id.to_owned(),
                account_ref: account_ref.clone(),
                connection_epoch: binding.connection_epoch,
                stream: "account".to_owned(),
                revision: 1,
                base_revision: 0,
                observed_at_utc_msc: now,
                source_time_msc: Some(now),
                full_snapshot: true,
                upserts: vec![serde_json::json!({
                    "login": 596520,
                    "server": "Broker-Demo",
                    "terminal_trade_allowed": true,
                    "trade_allowed": true,
                    "trade_expert": false,
                })],
                deletes: Vec::new(),
            })
            .expect("observer account snapshot");
        drop(store);
        let runtime = serde_json::json!({
            "schema_version": 1,
            "bridge_version": VERSION,
            "profile_id": "source-1",
            "observed_at_utc_msc": now,
            "phase": "online",
            "server_state": "connected",
            "server_error_code": null,
            "terminals": [{
                "terminal_instance_id": terminal_instance_id,
                "platform": "mt5",
                "connection_epoch": binding.connection_epoch,
                "state": "ready",
                "worker_state": "ready",
                "collector_state": "ready",
                "data_ready": true,
                "worker_consecutive_failures": 0,
                "collector_consecutive_failures": 0,
                "last_success_at_utc_msc": now,
                "error_code": null
            }],
            "reconciliation": {
                "last_run_at_utc_msc": now,
                "inspected": 0,
                "resolved": 0,
                "pending": 0,
                "error_codes": [],
                "consecutive_failures": 0,
                "fatal_error_code": null
            }
        });
        write_runtime_status_snapshot(
            &paths.runtime_status_path,
            &serde_json::to_vec(&runtime).expect("runtime payload"),
        )
        .expect("observer runtime status");

        let projection = load_observer_ui_projection(&root, now).expect("observer projection");
        assert_eq!(projection.profiles.len(), 1);
        assert_eq!(projection.profiles[0].observer_profile_id, "source-1");
        assert_eq!(
            projection.profiles[0].terminal_directory.as_deref(),
            terminal
                .parent()
                .map(|value| value.to_string_lossy())
                .as_deref()
        );
        assert!(projection.profiles[0].configured);
        assert_eq!(projection.terminals.len(), 1);
        assert_eq!(projection.terminals[0].login, "596520");
        assert_eq!(projection.terminals[0].terminal_trading_allowed, Some(true));
        assert_eq!(projection.terminals[0].account_trading_allowed, Some(true));
        assert_eq!(
            projection.terminals[0].account_expert_trading_allowed,
            Some(false)
        );

        let stale =
            load_observer_ui_projection(&root, now + 5_001).expect("stale observer projection");
        assert_eq!(stale.profiles[0].runtime_phase.as_deref(), Some("degraded"));
        assert_eq!(
            stale.profiles[0].runtime_detail_code.as_deref(),
            Some("bridge_runtime_status_stale")
        );
        assert!(stale.terminals.is_empty());
        std::fs::remove_dir_all(root).expect("remove observer projection fixture");
    }

    #[test]
    fn mt5_probe_persists_the_exact_discovered_account_route() {
        let root = unique_test_directory("mt5-probe-binding");
        std::fs::create_dir_all(&root).expect("probe binding root");
        let terminal = std::path::absolute(root.join("terminal64.exe")).unwrap();
        std::fs::write(&terminal, b"terminal").expect("probe terminal");
        let terminal_instance_id =
            observer_terminal::mt5_terminal_instance_id(&terminal).expect("terminal identity");
        let installation = Mt5Installation {
            executable_path: terminal.clone(),
            terminal_instance_id: terminal_instance_id.clone(),
            is_running: true,
        };
        let probe = Mt5ProbeResult {
            executable_path: terminal.clone(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
        };
        let store = OutboxStore::open_or_create(root.join("bridge.db")).expect("probe store");
        persist_mt5_probe(&store, &installation, &probe, now_utc_msc())
            .expect("persist probe binding");
        let bindings = store.terminal_bindings().expect("probe bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].terminal_instance_id, terminal_instance_id);
        assert_eq!(bindings[0].account_ref, probe.account_ref);
        assert_eq!(bindings[0].terminal_path, terminal);

        let mismatched = Mt5ProbeResult {
            executable_path: root.join("other").join("terminal64.exe"),
            account_ref: probe.account_ref,
        };
        assert_eq!(
            persist_mt5_probe(&store, &installation, &mismatched, now_utc_msc()),
            Err("mt5_probe_identity_mismatch")
        );
        drop(store);
        std::fs::remove_dir_all(root).expect("remove probe binding fixture");
    }

    #[test]
    fn update_scope_combines_the_ready_primary_and_connected_observer_without_leaking_accounts() {
        let root = unique_test_directory("update-scope");
        std::fs::create_dir_all(&root).expect("root");
        let now = now_utc_msc();
        let mut state = NativeRuntimeStatusSnapshot::inactive(
            DEFAULT_PROFILE_ID,
            VERSION,
            now,
            "starting",
            "connecting",
            None,
        )
        .expect("runtime status")
        .to_ui_state(1)
        .expect("UI state");
        state.phase = "online".to_owned();
        state.server_connected = true;
        state
            .terminals
            .push(bridge_local_control::UiTerminalStatus {
                terminal_instance_id: "mt5_aaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                platform: "mt5".to_owned(),
                broker_server: "Broker-Demo".to_owned(),
                login: "100001".to_owned(),
                runtime_state: "running".to_owned(),
                error_code: None,
                observer_profile_id: None,
                terminal_trading_allowed: Some(true),
                program_trading_allowed: None,
                account_trading_allowed: Some(true),
                account_expert_trading_allowed: Some(true),
                mt4_expert_restart_required: false,
            });
        let ui_state = UiStateStore::new(state).expect("UI store");

        let observer_paths = resolve_profile_paths(&root, "source-1").expect("observer paths");
        let terminal = root.join("terminal64.exe");
        std::fs::write(&terminal, b"terminal").expect("terminal executable");
        BridgePreferencesStore::new(observer_paths.data_directory.join("preferences.json"))
            .expect("observer preferences")
            .save_observer_profile(&ObserverProfilePreferences {
                platform: "mt5".to_owned(),
                terminal_instance_id: "mt5_bbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
                terminal_path: terminal.display().to_string(),
                bridge_user_id: 42,
                observer_account_label: Some("一号观摩源".to_owned()),
                trading_account_id: Some(9),
                trading_account_label: Some("观摩账户".to_owned()),
            })
            .expect("save observer");
        std::fs::create_dir_all(&observer_paths.data_directory).expect("observer directory");
        let runtime = serde_json::json!({
            "schema_version": 1,
            "bridge_version": VERSION,
            "profile_id": "source-1",
            "observed_at_utc_msc": now,
            "phase": "online",
            "server_state": "connected",
            "server_error_code": null,
            "terminals": [{
                "terminal_instance_id": "mt5_bbbbbbbbbbbbbbbbbbbbbbbb",
                "platform": "mt5",
                "connection_epoch": 1,
                "state": "ready",
                "worker_state": "ready",
                "collector_state": "ready",
                "data_ready": true,
                "worker_consecutive_failures": 0,
                "collector_consecutive_failures": 0,
                "last_success_at_utc_msc": now,
                "error_code": null
            }],
            "reconciliation": {
                "last_run_at_utc_msc": now,
                "inspected": 0,
                "resolved": 0,
                "pending": 0,
                "error_codes": [],
                "consecutive_failures": 0,
                "fatal_error_code": null
            }
        });
        write_runtime_status_snapshot(
            &observer_paths.runtime_status_path,
            &serde_json::to_vec(&runtime).expect("runtime payload"),
        )
        .expect("write observer runtime");

        assert_eq!(
            capture_update_runtime_scope(&root, &ui_state).expect("update scope"),
            UpdateRuntimeScope {
                terminal_instance_ids: vec![
                    "mt5_aaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    "mt5_bbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
                ],
                observer_bridge_user_ids: vec![42],
                primary_ready: true,
            }
        );
        let mut observer_only_state = ui_state.snapshot().expect("observer-only UI state");
        observer_only_state.terminals.clear();
        ui_state
            .publish(observer_only_state)
            .expect("publish observer-only UI state");
        assert_eq!(
            capture_update_runtime_scope(&root, &ui_state).expect("observer-only scope"),
            UpdateRuntimeScope {
                terminal_instance_ids: vec!["mt5_bbbbbbbbbbbbbbbbbbbbbbbb".to_owned()],
                observer_bridge_user_ids: vec![42],
                primary_ready: false,
            }
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn autostart_selection_fails_without_an_installed_launcher_and_preserves_preferences() {
        let root = unique_test_directory("autostart-selection");
        let application = root.join("application");
        let preferences_path = root.join("preferences.json");
        std::fs::create_dir_all(&application).expect("application directory");
        let preferences =
            BridgePreferencesStore::new(&preferences_path).expect("preferences store");
        assert!(preferences.load().auto_start_enabled);
        assert_eq!(
            apply_autostart_selection(&application, &preferences, true),
            Err("bridge_autostart_launcher_unavailable")
        );
        assert!(preferences.load().auto_start_enabled);
        assert!(!preferences_path.exists());
        std::fs::remove_dir_all(root).expect("remove autostart selection fixture");
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-core-main-{}-{stamp}-{suffix}",
            std::process::id()
        ))
    }

    fn mt4_binding(terminal_instance_id: &str, directory: &str) -> TerminalBinding {
        TerminalBinding {
            terminal_instance_id: terminal_instance_id.to_owned(),
            platform: "mt4".to_owned(),
            terminal_path: std::env::temp_dir().join(directory),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 1,
            updated_at_utc_msc: 1_800_000_000_000,
        }
    }
}
