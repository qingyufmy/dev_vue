#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gui;

use liangjian_bridge_installer::{
    InstallOutcome, InstallerConfiguration, InstallerError, OfflineInstaller, OnlineInstaller,
    default_install_root,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

const PUBLIC_KEY: &str = include_str!(concat!(env!("OUT_DIR"), "/release-public-key.pem"));
const SERVER_URL: &str = env!("AURUM_BOOTSTRAPPER_SERVER_URL");
const LAUNCHER_VERSION: &str = env!("AURUM_BOOTSTRAPPER_LAUNCHER_VERSION");
const TARGET_ENVIRONMENT: &str = env!("AURUM_BOOTSTRAPPER_TARGET_ENVIRONMENT");

#[derive(Serialize)]
struct CommandResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_types: Option<[String; 1]>,
}

struct RehearsalRequest {
    install_root: PathBuf,
    result_path: PathBuf,
    offline_bundle_root: Option<PathBuf>,
}

fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.is_empty() {
        let configuration = match embedded_configuration(default_install_root(), false) {
            Ok(configuration) => configuration,
            Err(error) => {
                liangjian_bridge_installer::write_failure_log(error);
                return;
            }
        };
        if let Err(error) = gui::run(configuration, SERVER_URL) {
            liangjian_bridge_installer::write_failure_log(error);
        }
        return;
    }

    let request = match parse_rehearsal_request(&arguments) {
        Ok(request) => request,
        Err(_) => std::process::exit(2),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => std::process::exit(1),
    };
    let result = runtime.block_on(run_rehearsal(&request));
    let (exit_code, document) = match result {
        Ok(outcome) => (
            0,
            CommandResult {
                ok: true,
                operation: Some("bootstrap-install-rehearsal".to_owned()),
                version: Some(outcome.version),
                install_root: Some(outcome.install_root.to_string_lossy().into_owned()),
                source: Some(
                    if request.offline_bundle_root.is_some() {
                        "offline"
                    } else {
                        "online"
                    }
                    .to_owned(),
                ),
                error: None,
                error_types: None,
            },
        ),
        Err(error) => (
            1,
            CommandResult {
                ok: false,
                operation: None,
                version: None,
                install_root: None,
                source: None,
                error: Some(error.code().to_owned()),
                error_types: Some(["InstallerError".to_owned()]),
            },
        ),
    };
    if write_result(&request.result_path, &document).is_err() {
        std::process::exit(1);
    }
    std::process::exit(exit_code);
}

async fn run_rehearsal(request: &RehearsalRequest) -> Result<InstallOutcome, InstallerError> {
    let configuration = embedded_configuration(Ok(request.install_root.clone()), true)?;
    if let Some(bundle) = request.offline_bundle_root.as_ref() {
        OfflineInstaller::new(configuration)?.install(bundle).await
    } else {
        OnlineInstaller::new(configuration, SERVER_URL)?
            .install(&|_| {})
            .await
    }
}

fn embedded_configuration(
    install_root: Result<PathBuf, InstallerError>,
    rehearsal: bool,
) -> Result<InstallerConfiguration, InstallerError> {
    let configuration = InstallerConfiguration {
        public_key_pem: PUBLIC_KEY.to_owned(),
        launcher_version: LAUNCHER_VERSION.to_owned(),
        target_environment: TARGET_ENVIRONMENT.to_owned(),
        install_root: install_root?,
        rehearsal,
    };
    configuration.validate()?;
    Ok(configuration)
}

fn parse_rehearsal_request(arguments: &[OsString]) -> Result<RehearsalRequest, InstallerError> {
    if TARGET_ENVIRONMENT != "test"
        || (arguments.len() != 4 && arguments.len() != 6)
        || !arguments.len().is_multiple_of(2)
    {
        return Err(InstallerError::new("bootstrap_arguments_invalid"));
    }
    let mut values = BTreeMap::new();
    for pair in arguments.chunks_exact(2) {
        let key = pair[0]
            .to_str()
            .and_then(|value| value.strip_prefix("--"))
            .filter(|value| !value.is_empty())
            .ok_or_else(|| InstallerError::new("bootstrap_arguments_invalid"))?;
        let value = pair[1]
            .to_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| InstallerError::new("bootstrap_arguments_invalid"))?;
        if values.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(InstallerError::new("bootstrap_arguments_invalid"));
        }
    }
    let install_root = values
        .remove("rehearsal-install-root")
        .map(PathBuf::from)
        .ok_or_else(|| InstallerError::new("bootstrap_arguments_invalid"))?;
    let result_path = values
        .remove("rehearsal-result")
        .map(PathBuf::from)
        .ok_or_else(|| InstallerError::new("bootstrap_arguments_invalid"))?;
    let offline_bundle_root = values.remove("offline-bundle-root").map(PathBuf::from);
    if !values.is_empty() {
        return Err(InstallerError::new("bootstrap_arguments_invalid"));
    }
    Ok(RehearsalRequest {
        install_root: std::path::absolute(install_root)
            .map_err(|_| InstallerError::new("bootstrap_arguments_invalid"))?,
        result_path: std::path::absolute(result_path)
            .map_err(|_| InstallerError::new("bootstrap_arguments_invalid"))?,
        offline_bundle_root,
    })
}

fn write_result(path: &Path, value: &CommandResult) -> Result<(), InstallerError> {
    let parent = path
        .parent()
        .ok_or_else(|| InstallerError::new("bootstrap_result_path_invalid"))?;
    fs::create_dir_all(parent).map_err(|_| InstallerError::new("bootstrap_result_write_failed"))?;
    let payload = serde_json::to_vec(value)
        .map_err(|_| InstallerError::new("bootstrap_result_write_failed"))?;
    fs::write(path, payload).map_err(|_| InstallerError::new("bootstrap_result_write_failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_test_bootstrapper_is_loopback_only() {
        assert_eq!(TARGET_ENVIRONMENT, "test");
        assert_eq!(SERVER_URL, "http://127.0.0.1:3000");
    }
}
