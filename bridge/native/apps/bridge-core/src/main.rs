use bridge_foundation::{
    CliMode, DEFAULT_PROFILE_ID, HealthCheckOptions, StartupReadyOptions, default_data_directory,
    default_root_data_directory, parse_cli, profile_instance_id, resolve_installed_root,
    resolve_profile_paths, run_health_check, write_runtime_status_snapshot,
    write_startup_ready_signal,
};
use bridge_local_control::{
    EndpointSettingsSelection, LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction,
    LocalControlPipeServer, LocalControlResponse, LocalControlResult, UiObserverSource,
    UiStateSnapshot, UiStateStore, UiTerminalCandidate,
};
use bridge_observability::{BridgeLogger, LoggerConfig};
use bridge_preferences::{BridgePreferencesStore, BridgeUserPreferences};
use bridge_runtime_win::{
    AutoStartRegistration, InstanceAcquireResult, InstanceSignal, SingleInstanceGuard,
    default_lock_directory,
};
use bridge_security_win::CredentialStore;
use bridge_terminal_session::TerminalSessionState;
use bridge_transport::{
    BridgeAuthClient, ConnectionState, CredentialSource, ENDPOINT_SETTINGS_FILE_NAME,
    ServerEndpoints, SessionCancellation, clear_endpoint_settings, load_packaged_server_endpoints,
    resolve_server_endpoints, save_endpoint_settings, test_server_endpoints,
};
use liangjian_bridge_core::{
    ActiveMt5Sessions, CoreConnectionState, CredentialState, NativeConnectedRuntime,
    NativeProfileBootstrap, NativeRuntimeStatusHandle, NativeRuntimeStatusSnapshot,
    ProfileCredentialSource, ProfileTerminalBindingSource,
};
use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::time::Instant;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const ADMINISTRATOR_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

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
    stop: SessionCancellation,
    logger: BridgeLogger,
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

struct RuntimeStatusMonitorContext {
    status_path: PathBuf,
    profile_id: String,
    root_data_directory: PathBuf,
    ui_state: UiStateStore,
    preferences_store: BridgePreferencesStore,
    logger: BridgeLogger,
}

#[derive(Default)]
struct AdministratorCache {
    is_administrator: bool,
    observer_sources: Vec<UiObserverSource>,
    last_refresh: Option<Instant>,
    last_error_code: Option<String>,
    refresh_in_progress: bool,
    generation: u64,
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
        result: Result<(bool, Vec<UiObserverSource>), String>,
        logger: &BridgeLogger,
    ) {
        if generation != self.generation {
            return;
        }
        self.refresh_in_progress = false;
        match result {
            Ok((is_administrator, observer_sources)) => {
                self.is_administrator = is_administrator;
                self.observer_sources = observer_sources;
                self.last_error_code = None;
            }
            Err(code) => self.log_refresh_error(logger, &code),
        }
    }

    fn decorate(&self, profile_id: &str, state: &mut UiStateSnapshot) {
        if profile_id != DEFAULT_PROFILE_ID {
            return;
        }
        state.is_administrator = self.is_administrator;
        state.observer_sources = if self.is_administrator {
            self.observer_sources.clone()
        } else {
            Vec::new()
        };
        // Keep the existing .NET observer-management surface hidden until every original
        // dialog action has a real native backend. A partially wired replacement is not shown.
        state.can_manage_observer_sources = false;
    }

    fn clear(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.is_administrator = false;
        self.observer_sources.clear();
        self.last_refresh = None;
        self.last_error_code = None;
        self.refresh_in_progress = false;
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
) -> Result<(bool, Vec<UiObserverSource>), String> {
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
        access
            .sources
            .into_iter()
            .map(|source| UiObserverSource {
                bridge_user_id: source.bridge_user_id,
                display_name: source.display_name().to_owned(),
                account_summary: source.account_summary(),
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok((is_administrator, observer_sources))
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
            stop: control_stop,
            logger: logger.clone(),
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
        ready_file,
        expected_terminal_instance_ids,
        stop.clone(),
        ui_state.clone(),
        preferences_store.clone(),
        preference_change_receiver,
    )
    .await;
    stop.cancel();
    control_task
        .await
        .map_err(|_| "bridge_local_control_task_failed")?;
    signal_waiter
        .await
        .map_err(|_| "bridge_instance_wait_failed")??;
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
        stop,
        logger,
    } = context;
    logger.info(
        "native_local_control_started",
        Some(&format!("profile={}", server.endpoint().profile_id())),
    );
    let administrator_cache = Arc::new(AsyncMutex::new(AdministratorCache::default()));
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
                        let refresh_generation = {
                            let mut cache = administrator_cache.lock().await;
                            let refresh_generation =
                                cache.schedule_refresh(server.endpoint().profile_id());
                            cache.decorate(server.endpoint().profile_id(), &mut state);
                            refresh_generation
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
                LocalControlAction::BridgeExit => LocalControlResult::Accepted,
                _ => LocalControlResult::Rejected {
                    code: "bridge_local_control_action_unavailable".to_owned(),
                },
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

async fn run_profile_lifecycle(
    context: ProfileLifecycleContext<'_>,
    ready_file: Option<PathBuf>,
    expected_terminal_instance_ids: Vec<String>,
    stop: SessionCancellation,
    ui_state: UiStateStore,
    preferences_store: BridgePreferencesStore,
    mut preference_change_receiver: watch::Receiver<u64>,
) -> Result<(), Box<dyn Error>> {
    let ProfileLifecycleContext {
        application_directory,
        root_data_directory,
        profile_id,
        logger,
    } = context;
    loop {
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
                    "mt5_terminal_not_found"
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
        let ready_waiter = tokio::spawn(async move {
            wait_and_write_ready(
                runtime_ready_file,
                runtime_expected_terminal_instance_ids,
                connection_state,
                active_sessions,
                ready_stop,
                ready_logger,
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
    logger: BridgeLogger,
) -> Result<(), String> {
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
    fn administrator_cache_only_decorates_the_default_profile_without_exposing_dead_actions() {
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
            observer_sources: vec![UiObserverSource {
                bridge_user_id: 9,
                display_name: "一号观摩源".to_owned(),
                account_summary: "596520 · DooTechnology-Demo".to_owned(),
            }],
            ..AdministratorCache::default()
        };
        cache.decorate(DEFAULT_PROFILE_ID, &mut state);
        assert!(state.is_administrator);
        assert_eq!(state.observer_sources.len(), 1);
        assert!(!state.can_manage_observer_sources);
        state
            .validate(DEFAULT_PROFILE_ID)
            .expect("decorated default state");

        let mut observer_state = state.clone();
        observer_state.profile_id = "source-1".to_owned();
        observer_state.is_administrator = false;
        observer_state.observer_sources.clear();
        cache.decorate("source-1", &mut observer_state);
        assert!(!observer_state.is_administrator);
        assert!(observer_state.observer_sources.is_empty());
        assert!(!observer_state.can_manage_observer_sources);
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
}
