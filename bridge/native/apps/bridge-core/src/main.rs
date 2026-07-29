use bridge_foundation::{
    CliMode, HealthCheckOptions, StartupReadyOptions, default_data_directory,
    default_root_data_directory, parse_cli, profile_instance_id, resolve_installed_root,
    resolve_profile_paths, run_health_check, write_runtime_status_snapshot,
    write_startup_ready_signal,
};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeServer, LocalControlResponse,
    LocalControlResult, UiStateStore,
};
use bridge_observability::{BridgeLogger, LoggerConfig};
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
use tokio::time::Instant;

const VERSION: &str = env!("CARGO_PKG_VERSION");

enum ProfileRuntimeTrigger {
    Completed(Result<(), liangjian_bridge_core::CoreBootstrapError>),
    BindingChanged,
    BindingWatchFailed(liangjian_bridge_core::CoreBootstrapError),
    Stopped,
}

struct ProfileLifecycleContext<'a> {
    application_directory: &'a std::path::Path,
    root_data_directory: &'a std::path::Path,
    profile_id: &'a str,
    logger: &'a BridgeLogger,
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
    let control_stop = stop.clone();
    let control_task = tokio::spawn(run_local_control_server(
        local_control_server,
        ui_state.clone(),
        credential_store,
        application_directory.clone(),
        root_data_directory.clone(),
        control_stop,
        logger.clone(),
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
    match &profile_result {
        Ok(()) => {
            publish_inactive_status(
                &logger,
                &status_path,
                &profile_id,
                "stopped",
                "stopped",
                None,
                &ui_state,
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
                &status_path,
                &profile_id,
                "degraded",
                "stopped",
                Some(&error_code),
                &ui_state,
            );
            logger.error("native_runtime_failed", Some(&error_code));
        }
    }
    profile_result
}

async fn run_local_control_server(
    mut server: LocalControlPipeServer,
    ui_state: UiStateStore,
    credential_store: CredentialStore,
    application_directory: PathBuf,
    root_data_directory: PathBuf,
    stop: SessionCancellation,
    logger: BridgeLogger,
) {
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
) -> Result<(), Box<dyn Error>> {
    let ProfileLifecycleContext {
        application_directory,
        root_data_directory,
        profile_id,
        logger,
    } = context;
    loop {
        let bootstrap =
            NativeProfileBootstrap::load(application_directory, root_data_directory, profile_id)?;
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
        if bootstrap.credential_state == CredentialState::Missing {
            publish_inactive_status(
                logger,
                &status_path,
                profile_id,
                "pairing_required",
                "pairing_required",
                None,
                &ui_state,
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
                            &status_path,
                            profile_id,
                            "pairing_required",
                            "pairing_required",
                            None,
                            &ui_state,
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
            &status_path,
            profile_id,
            "connecting",
            "connecting",
            None,
            &ui_state,
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
            _ = stop.cancelled() => ProfileRuntimeTrigger::Stopped,
        };
        runtime_stop.cancel();
        let (runtime_result, reload_bindings, binding_watch_error) = match trigger {
            ProfileRuntimeTrigger::Completed(result) => (result, false, None),
            ProfileRuntimeTrigger::BindingChanged => (runtime.await, true, None),
            ProfileRuntimeTrigger::BindingWatchFailed(error) => (runtime.await, false, Some(error)),
            ProfileRuntimeTrigger::Stopped => (runtime.await, false, None),
        };
        match runtime_status.snapshot(profile_id, VERSION, now_utc_msc()) {
            Ok(snapshot) => publish_runtime_status_or_warn(logger, &status_path, &snapshot),
            Err(error) => logger.warning("native_runtime_status_failed", Some(error.code())),
        }
        publish_active_ui_state_or_warn(logger, &runtime_status, profile_id, &ui_state);
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

async fn monitor_runtime_status(
    handle: NativeRuntimeStatusHandle,
    status_path: PathBuf,
    profile_id: String,
    stop: SessionCancellation,
    ui_state: UiStateStore,
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
            publish_active_ui_state_or_warn(&logger, &handle, &profile_id, &ui_state);
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
    status_path: &std::path::Path,
    profile_id: &str,
    phase: &str,
    server_state: &str,
    error_code: Option<&str>,
    ui_state: &UiStateStore,
) {
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
        Ok(state) => {
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
) {
    match handle.ui_snapshot(profile_id, VERSION, now_utc_msc(), 1) {
        Ok(state) => {
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
