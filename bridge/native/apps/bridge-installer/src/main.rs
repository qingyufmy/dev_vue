#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use liangjian_bridge_installer::{
    InstallerConfiguration, InstallerError, OfflineInstaller, default_install_root,
    write_failure_log,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const PUBLIC_KEY: &str = include_str!(concat!(env!("OUT_DIR"), "/release-public-key.pem"));
const LAUNCHER_VERSION: &str = env!("AURUM_INSTALLER_LAUNCHER_VERSION");
const TARGET_ENVIRONMENT: &str = env!("AURUM_INSTALLER_TARGET_ENVIRONMENT");

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

struct InstallRequest {
    offline_bundle_root: PathBuf,
    install_root: PathBuf,
    result_path: PathBuf,
    rehearsal: bool,
}

#[tokio::main]
async fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let request = match parse_request(&arguments) {
        Ok(request) => request,
        Err(_) => std::process::exit(2),
    };
    let configuration = InstallerConfiguration {
        public_key_pem: PUBLIC_KEY.to_owned(),
        launcher_version: LAUNCHER_VERSION.to_owned(),
        target_environment: TARGET_ENVIRONMENT.to_owned(),
        install_root: request.install_root.clone(),
        rehearsal: request.rehearsal,
    };
    let result = match OfflineInstaller::new(configuration) {
        Ok(installer) => installer.install(&request.offline_bundle_root).await,
        Err(error) => Err(error),
    };
    let (exit_code, document) = match result {
        Ok(outcome) => (
            0,
            CommandResult {
                ok: true,
                operation: Some(
                    if request.rehearsal {
                        "bootstrap-install-rehearsal"
                    } else {
                        "bootstrap-offline-install"
                    }
                    .to_owned(),
                ),
                version: Some(outcome.version),
                install_root: Some(outcome.install_root.to_string_lossy().into_owned()),
                source: Some("offline".to_owned()),
                error: None,
                error_types: None,
            },
        ),
        Err(error) => {
            if !request.rehearsal {
                write_failure_log(error);
            }
            (
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
            )
        }
    };
    if write_result(&request.result_path, &document).is_err() {
        std::process::exit(1);
    }
    std::process::exit(exit_code);
}

fn parse_request(arguments: &[std::ffi::OsString]) -> Result<InstallRequest, InstallerError> {
    if arguments.len() != 4 && arguments.len() != 6 || !arguments.len().is_multiple_of(2) {
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
    let bundle = values
        .remove("offline-bundle-root")
        .map(PathBuf::from)
        .ok_or_else(|| InstallerError::new("bootstrap_arguments_invalid"))?;
    let (install_root, result_path, rehearsal) = match (
        values.remove("install-result"),
        values.remove("rehearsal-install-root"),
        values.remove("rehearsal-result"),
    ) {
        (Some(result), None, None) if values.is_empty() => {
            let result = std::path::absolute(result)
                .map_err(|_| InstallerError::new("bootstrap_arguments_invalid"))?;
            let expected = std::path::absolute(&bundle)
                .map_err(|_| InstallerError::new("bootstrap_arguments_invalid"))?
                .join("install-result.json");
            if !paths_equal(&result, &expected) {
                return Err(InstallerError::new("bootstrap_arguments_invalid"));
            }
            (default_install_root()?, result, false)
        }
        (None, Some(root), Some(result)) if values.is_empty() && TARGET_ENVIRONMENT == "test" => (
            std::path::absolute(root)
                .map_err(|_| InstallerError::new("bootstrap_arguments_invalid"))?,
            std::path::absolute(result)
                .map_err(|_| InstallerError::new("bootstrap_arguments_invalid"))?,
            true,
        ),
        _ => return Err(InstallerError::new("bootstrap_arguments_invalid")),
    };
    Ok(InstallRequest {
        offline_bundle_root: bundle,
        install_root,
        result_path,
        rehearsal,
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

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}
