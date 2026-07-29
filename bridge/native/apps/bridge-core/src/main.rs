use bridge_foundation::{
    CliMode, HealthCheckOptions, default_data_directory, default_root_data_directory, parse_cli,
    profile_instance_id, resolve_installed_root, resolve_profile_paths, run_health_check,
};
use bridge_observability::{BridgeLogger, LoggerConfig};
use bridge_runtime_win::{InstanceAcquireResult, SingleInstanceGuard, default_lock_directory};
use liangjian_bridge_core::{CredentialState, NativeProfileBootstrap};
use std::env;
use std::error::Error;

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
            ..
        } => run_native_foundation(profile_id, start_minimized),
    }
}

fn run_native_foundation(profile_id: String, start_minimized: bool) -> Result<(), Box<dyn Error>> {
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
    let InstanceAcquireResult::Acquired(_single_instance) = single_instance else {
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
    let bootstrap =
        NativeProfileBootstrap::load(application_directory, root_data_directory, &profile_id)?;
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
    logger.warning(
        "native_runtime_not_ready",
        Some("server_and_terminal_connections_disabled"),
    );
    Err("native_bridge_runtime_not_ready".into())
}
