use bridge_foundation::{
    CliMode, HealthCheckOptions, StartupReadyOptions, default_data_directory,
    default_root_data_directory, parse_cli, profile_instance_id, resolve_installed_root,
    resolve_profile_paths, run_health_check, write_runtime_status_snapshot,
    write_startup_ready_signal,
};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeServer, LocalControlResponse,
    LocalControlResult, UiStateSnapshot, UiStateStore, UiTerminalCandidate,
};
use bridge_observability::{BridgeLogger, LoggerConfig};
use bridge_preferences::{BridgePreferencesStore, BridgeUserPreferences};
use bridge_runtime_win::{
    InstanceAcquireResult, InstanceSignal, SingleInstanceGuard, default_lock_directory,
};
use bridge_security_win::CredentialStore;
use bridge_terminal_session::TerminalSessionState;
use bridge_transport::{
    ConnectionState, CredentialSource, SessionCancellation, resolve_server_endpoints,
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
use tokio::sync::watch;
use tokio::time::Instant;

const VERSION: &str = env!("CARGO_PKG_VERSION");

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
    profile_id: &'a str,
    phase: &'a str,
    server_state: &'a str,
    error_code: Option<&'a str>,
    preferences: Option<&'a BridgeUserPreferences>,
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
                    Ok(state) => LocalControlResult::State {
                        state: Box::new(state),
                    },
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
                    Ok(()) => LocalControlResult::Accepted,
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
                    logger,
                    &ui_state,
                    profile_id,
                    &preferences,
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
                logger,
                &ui_state,
                profile_id,
                &preferences,
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
                logger,
                &ui_state,
                profile_id,
                &preferences,
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
            status_path.clone(),
            profile_id.to_owned(),
            status_stop.clone(),
            ui_state.clone(),
            preferences_store.clone(),
            logger.clone(),
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

fn apply_preferences_to_ui_state(state: &mut UiStateSnapshot, preferences: &BridgeUserPreferences) {
    state.autostart_enabled = preferences.auto_start_enabled;
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
    logger: &BridgeLogger,
    ui_state: &UiStateStore,
    profile_id: &str,
    preferences: &BridgeUserPreferences,
    phase: &str,
    detail_code: Option<&str>,
    terminal_candidates: Vec<UiTerminalCandidate>,
) {
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
        observer_profiles: Vec::new(),
        update_notice: None,
        autostart_enabled: preferences.auto_start_enabled,
        custom_endpoint_active: false,
    };
    if let Err(error_code) = ui_state.publish(state) {
        logger.warning("native_ui_state_publish_failed", Some(error_code));
    }
}

async fn monitor_runtime_status(
    handle: NativeRuntimeStatusHandle,
    status_path: PathBuf,
    profile_id: String,
    stop: SessionCancellation,
    ui_state: UiStateStore,
    preferences_store: BridgePreferencesStore,
    logger: BridgeLogger,
) {
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
                apply_preferences_to_ui_state(&mut state, preferences);
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
    ui_state: &UiStateStore,
    preferences_store: &BridgePreferencesStore,
) {
    match handle.ui_snapshot(profile_id, VERSION, now_utc_msc(), 1) {
        Ok(mut state) => {
            apply_preferences_to_ui_state(&mut state, &preferences_store.load());
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
