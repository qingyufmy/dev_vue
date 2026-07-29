use bridge_foundation::{
    CliMode, HealthCheckOptions, StartupReadyOptions, default_data_directory,
    default_root_data_directory, parse_cli, profile_instance_id, resolve_installed_root,
    resolve_profile_paths, run_health_check, write_startup_ready_signal,
};
use bridge_observability::{BridgeLogger, LoggerConfig};
use bridge_runtime_win::{
    InstanceAcquireResult, InstanceSignal, SingleInstanceGuard, default_lock_directory,
};
use bridge_terminal_session::TerminalSessionState;
use bridge_transport::{
    ConnectionState, CredentialSource, SessionCancellation, resolve_server_endpoints,
};
use liangjian_bridge_core::{
    ActiveMt5Sessions, CoreConnectionState, CredentialState, NativeConnectedRuntime,
    NativeProfileBootstrap, ProfileCredentialSource,
};
use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");

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
        &application_directory,
        &root_data_directory,
        &profile_id,
        ready_file,
        expected_terminal_instance_ids,
        stop.clone(),
        &logger,
    )
    .await;
    stop.cancel();
    signal_waiter
        .await
        .map_err(|_| "bridge_instance_wait_failed")??;
    match &profile_result {
        Ok(()) => logger.info(
            "native_runtime_stopped",
            Some(&format!("profile={profile_id}")),
        ),
        Err(error) => logger.error("native_runtime_failed", Some(&error.to_string())),
    }
    profile_result
}

async fn run_profile_lifecycle(
    application_directory: &PathBuf,
    root_data_directory: &PathBuf,
    profile_id: &str,
    ready_file: Option<PathBuf>,
    expected_terminal_instance_ids: Vec<String>,
    stop: SessionCancellation,
    logger: &BridgeLogger,
) -> Result<(), Box<dyn Error>> {
    loop {
        let bootstrap =
            NativeProfileBootstrap::load(application_directory, root_data_directory, profile_id)?;
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
            logger.info("native_runtime_pairing_required", None);
            let credentials = ProfileCredentialSource::new(bootstrap.credential_store)?;
            tokio::select! {
                changed = credentials.changed() => changed?,
                _ = stop.cancelled() => return Ok(()),
            }
            continue;
        }
        if bootstrap.mt5_sessions.is_empty() {
            return Err(if bootstrap.mt4_bindings.is_empty() {
                "bridge_terminals_invalid"
            } else {
                "bridge_mt4_runtime_not_ready"
            }
            .into());
        }
        let configured_terminal_ids = bootstrap
            .mt5_sessions
            .iter()
            .map(|session| session.binding.terminal_instance_id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        if expected_terminal_instance_ids
            .iter()
            .any(|terminal_id| !configured_terminal_ids.contains(terminal_id.as_str()))
        {
            return Err("bridge_expected_terminal_missing".into());
        }
        let endpoints = resolve_server_endpoints(application_directory, root_data_directory)?;
        let clock: Arc<dyn Fn() -> i64 + Send + Sync> = Arc::new(now_utc_msc);
        let connected =
            NativeConnectedRuntime::start(bootstrap, endpoints, Arc::clone(&clock)).await?;
        let connection_state = connected.connection_state();
        let active_sessions = connected.active_sessions();
        let ready_stop = stop.clone();
        let ready_logger = logger.clone();
        let ready_waiter = tokio::spawn(async move {
            wait_and_write_ready(
                ready_file,
                expected_terminal_instance_ids,
                connection_state,
                active_sessions,
                ready_stop,
                ready_logger,
            )
            .await
        });
        logger.info("native_runtime_connections_started", None);
        let runtime_result = connected.run(stop.clone()).await;
        stop.cancel();
        ready_waiter
            .await
            .map_err(|_| "bridge_startup_signal_task_failed")?
            .map_err(|error| -> Box<dyn Error> { error.into() })?;
        return runtime_result.map_err(Into::into);
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
