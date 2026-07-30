use bridge_update::{
    BridgeUpdateCoordinator, BridgeUpdateStateStore, ReleaseActivationStore, STATE_ACTIVATING,
    STATE_HEALTHY, STATE_ROLLED_BACK, StagedRelease, UpdateError,
};
use liangjian_bridge_launcher::{
    BridgeProcessRunner, LauncherEngine, LauncherError, NativeBridgeProcessRunner,
};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const PUBLISH_PATH: &str = "/api/admin/bridge/v3/releases/publish";
const UPDATE_STATE_FILE_NAME: &str = "update-state.json";
const POINTER_FILE_NAME: &str = "current.json";
const PUBLIC_KEY_FILE_NAME: &str = "release-public-key.pem";
const ROOT_LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
const RELEASE_CHANNEL_FILE_NAME: &str = "release-channel";
const BRIDGE_FILE_NAME: &str = "AURUMBridge.exe";

#[derive(Debug)]
struct RehearsalError(String);

impl RehearsalError {
    fn new(code: &'static str) -> Self {
        Self(code.to_owned())
    }
}

impl Display for RehearsalError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for RehearsalError {}

impl From<UpdateError> for RehearsalError {
    fn from(error: UpdateError) -> Self {
        Self(error.code().to_owned())
    }
}

impl From<LauncherError> for RehearsalError {
    fn from(error: LauncherError) -> Self {
        Self(error.code().to_owned())
    }
}

#[derive(Deserialize)]
struct RehearsalManifest {
    release_version: String,
    priority: String,
    rollout_channel: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ServerEndpointDocument {
    schema_version: u32,
    server_url: String,
}

struct RehearsalProcessRunner {
    health_runner: NativeBridgeProcessRunner,
    unready_version: Option<String>,
}

impl RehearsalProcessRunner {
    fn new(install_root: &Path, unready_version: Option<String>) -> Result<Self, RehearsalError> {
        Ok(Self {
            health_runner: NativeBridgeProcessRunner::new(install_root)?,
            unready_version,
        })
    }
}

impl BridgeProcessRunner for RehearsalProcessRunner {
    fn run_health_check(
        &self,
        executable: &Path,
        timeout: Duration,
    ) -> Result<bool, LauncherError> {
        self.health_runner.run_health_check(executable, timeout)
    }

    fn start_and_wait_ready(
        &self,
        _executable: &Path,
        expected_version: &str,
        _expected_terminal_instance_ids: &[String],
        _start_minimized: bool,
        _timeout: Duration,
    ) -> Result<bool, LauncherError> {
        Ok(self.unready_version.as_deref() != Some(expected_version))
    }

    fn start_bridge(
        &self,
        _executable: &Path,
        _start_minimized: bool,
    ) -> Result<(), LauncherError> {
        Ok(())
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(result) => {
            println!("{result}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", json!({ "ok": false, "error": error.to_string() }));
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<Value, RehearsalError> {
    let arguments = parse_arguments(std::env::args().skip(1))?;
    let server = validate_loopback_server(required(&arguments, "server")?)?;
    let expected_server = validate_loopback_server(required(&arguments, "expected-server-url")?)?;
    let public_key = existing_file(required(&arguments, "public-key")?)?;
    let launcher = existing_file(required(&arguments, "launcher")?)?;
    let first_manifest_path = existing_file(required(&arguments, "first-manifest")?)?;
    let second_manifest_path = existing_file(required(&arguments, "second-manifest")?)?;
    let install_root = prepare_empty_install_root(required(&arguments, "install-root")?)?;
    let initial_version = required(&arguments, "initial-version")?.to_owned();
    if !valid_numeric_version(&initial_version) {
        return Err(RehearsalError::new(
            "update_rehearsal_initial_version_invalid",
        ));
    }
    let release_token = std::env::var("AURUM_BRIDGE_RELEASE_API_TOKEN")
        .ok()
        .filter(|value| value.len() >= 32)
        .ok_or_else(|| RehearsalError::new("update_rehearsal_release_token_invalid"))?;
    let first_manifest = read_manifest(&first_manifest_path)?;
    let second_manifest = read_manifest(&second_manifest_path)?;
    if first_manifest.priority != "normal"
        || second_manifest.priority != "urgent"
        || first_manifest.rollout_channel != second_manifest.rollout_channel
        || !matches!(
            first_manifest.rollout_channel.as_str(),
            "internal" | "stable"
        )
        || !valid_numeric_version(&first_manifest.release_version)
        || !valid_numeric_version(&second_manifest.release_version)
    {
        return Err(RehearsalError::new("update_rehearsal_manifest_invalid"));
    }

    let initial_directory = prepare_initial_installation(
        &install_root,
        &initial_version,
        &first_manifest.rollout_channel,
        &launcher,
        &public_key,
    )?;
    let client = Client::builder()
        .tls_backend_rustls()
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|_| RehearsalError::new("update_rehearsal_http_client_failed"))?;

    publish_manifest(&client, &server, &release_token, &first_manifest_path).await?;
    let mut first_coordinator = coordinator(&initial_directory, &install_root)?;
    let first = first_coordinator
        .check_and_stage(server.clone())
        .await?
        .ok_or_else(|| RehearsalError::new("update_rehearsal_first_stage_missing"))?;
    let first_server = read_server_endpoint(&first.version_directory)?;
    ensure_expected_server(&first_server, &expected_server)?;
    verify_candidate_health(
        &install_root,
        &first,
        "update_rehearsal_first_health_check_failed",
    )?;
    prepare_activation(&first_coordinator, &first)?;
    let first_activated = LauncherEngine::new(
        &install_root,
        RehearsalProcessRunner::new(&install_root, None)?,
    )?
    .launch(false)?;
    let pointer_store = ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))?;
    let state_store = BridgeUpdateStateStore::new(install_root.join(UPDATE_STATE_FILE_NAME))?;
    let first_pointer = pointer_store.load()?;
    let first_state = state_store
        .load()?
        .ok_or_else(|| RehearsalError::new("update_rehearsal_first_activation_invalid"))?;
    if first_activated != first.version
        || first_pointer.active_version != first.version
        || first_pointer.last_known_good_version != first.version
        || first_pointer.status != "healthy"
        || first_state.state != STATE_HEALTHY
        || first_state.target_version.as_deref() != Some(first.version.as_str())
        || first_state.maintenance_lease_id.is_some()
        || first_state.last_error_code.is_some()
    {
        return Err(RehearsalError::new(
            "update_rehearsal_first_activation_invalid",
        ));
    }

    publish_manifest(&client, &server, &release_token, &second_manifest_path).await?;
    let mut second_coordinator = coordinator(&first.version_directory, &install_root)?;
    let second = second_coordinator
        .check_and_stage(server)
        .await?
        .ok_or_else(|| RehearsalError::new("update_rehearsal_second_stage_missing"))?;
    let second_server = read_server_endpoint(&second.version_directory)?;
    ensure_expected_server(&second_server, &expected_server)?;
    verify_candidate_health(
        &install_root,
        &second,
        "update_rehearsal_second_health_check_failed",
    )?;
    prepare_activation(&second_coordinator, &second)?;
    let rollback_version = LauncherEngine::new(
        &install_root,
        RehearsalProcessRunner::new(&install_root, Some(second.version.clone()))?,
    )?
    .launch(false)?;
    let final_pointer = pointer_store.load()?;
    let final_state = state_store
        .load()?
        .ok_or_else(|| RehearsalError::new("update_rehearsal_rollback_invalid"))?;
    if rollback_version != first.version
        || final_pointer.active_version != first.version
        || final_pointer.last_known_good_version != first.version
        || final_pointer.status != "rolled_back"
        || final_state.state != STATE_ROLLED_BACK
        || final_state.target_version.as_deref() != Some(second.version.as_str())
        || final_state.maintenance_lease_id.is_some()
        || final_state.last_error_code.as_deref() != Some("launcher_startup_readiness_failed")
    {
        return Err(RehearsalError::new("update_rehearsal_rollback_invalid"));
    }

    Ok(json!({
        "ok": true,
        "operation": "client-update-rehearsal",
        "implementation": "rust-native",
        "install_root": install_root,
        "first": {
            "release_id": first.release_id,
            "version": first.version,
            "priority": first.priority,
            "server_url": normalized_origin(&first_server),
            "health_check": "passed",
            "activation": "healthy"
        },
        "second": {
            "release_id": second.release_id,
            "version": second.version,
            "priority": second.priority,
            "server_url": normalized_origin(&second_server),
            "health_check": "passed",
            "simulated_startup_readiness": "failed"
        },
        "final_pointer": {
            "active_version": final_pointer.active_version,
            "last_known_good_version": final_pointer.last_known_good_version,
            "status": final_pointer.status
        },
        "final_update_state": {
            "state": final_state.state,
            "target_version": final_state.target_version,
            "last_error_code": final_state.last_error_code,
            "maintenance_lease_cleared": final_state.maintenance_lease_id.is_none()
        }
    }))
}

fn coordinator(
    application_directory: &Path,
    install_root: &Path,
) -> Result<BridgeUpdateCoordinator, RehearsalError> {
    let state_store = BridgeUpdateStateStore::new(install_root.join(UPDATE_STATE_FILE_NAME))?;
    BridgeUpdateCoordinator::create_if_installed(application_directory, state_store)?
        .ok_or_else(|| RehearsalError::new("update_rehearsal_environment_invalid"))
}

fn prepare_activation(
    coordinator: &BridgeUpdateCoordinator,
    staged: &StagedRelease,
) -> Result<(), RehearsalError> {
    let now = now_utc_msc();
    coordinator.save_activation_phase(
        staged,
        STATE_ACTIVATING,
        false,
        Some("lease_local_rehearsal".to_owned()),
        Some(now + 10 * 60 * 1_000),
        None,
        None,
    )?;
    coordinator.prepare_activation(staged, &[])?;
    Ok(())
}

fn verify_candidate_health(
    install_root: &Path,
    staged: &StagedRelease,
    error_code: &'static str,
) -> Result<(), RehearsalError> {
    let runner = NativeBridgeProcessRunner::new(install_root)?;
    let healthy = runner.run_health_check(
        &staged.version_directory.join(BRIDGE_FILE_NAME),
        Duration::from_secs(10),
    )?;
    if healthy {
        Ok(())
    } else {
        Err(RehearsalError::new(error_code))
    }
}

async fn publish_manifest(
    client: &Client,
    server: &Url,
    token: &str,
    manifest_path: &Path,
) -> Result<(), RehearsalError> {
    let manifest = fs::read(manifest_path)
        .ok()
        .and_then(|payload| serde_json::from_slice::<Value>(&payload).ok())
        .ok_or_else(|| RehearsalError::new("update_rehearsal_manifest_invalid"))?;
    let endpoint = server
        .join(PUBLISH_PATH)
        .map_err(|_| RehearsalError::new("update_rehearsal_server_invalid"))?;
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .json(&json!({ "manifest": manifest }))
        .send()
        .await
        .map_err(|_| RehearsalError::new("update_rehearsal_publish_failed"))?;
    if !response.status().is_success() {
        return Err(RehearsalError::new("update_rehearsal_publish_failed"));
    }
    let result = response
        .json::<Value>()
        .await
        .map_err(|_| RehearsalError::new("update_rehearsal_publish_failed"))?;
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(RehearsalError::new("update_rehearsal_publish_failed"))
    }
}

fn prepare_initial_installation(
    install_root: &Path,
    initial_version: &str,
    rollout_channel: &str,
    launcher: &Path,
    public_key: &Path,
) -> Result<PathBuf, RehearsalError> {
    let initial_directory = install_root.join("versions").join(initial_version);
    fs::create_dir_all(&initial_directory)
        .map_err(|_| RehearsalError::new("update_rehearsal_install_root_invalid"))?;
    fs::write(
        initial_directory.join(BRIDGE_FILE_NAME),
        b"local rehearsal initial version; never executed",
    )
    .map_err(|_| RehearsalError::new("update_rehearsal_install_root_invalid"))?;
    fs::copy(launcher, install_root.join(ROOT_LAUNCHER_FILE_NAME))
        .map_err(|_| RehearsalError::new("update_rehearsal_launcher_invalid"))?;
    fs::copy(public_key, install_root.join(PUBLIC_KEY_FILE_NAME))
        .map_err(|_| RehearsalError::new("update_rehearsal_public_key_invalid"))?;
    fs::write(
        install_root.join(RELEASE_CHANNEL_FILE_NAME),
        rollout_channel.as_bytes(),
    )
    .map_err(|_| RehearsalError::new("update_rehearsal_install_root_invalid"))?;
    ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))?
        .initialize_healthy(initial_version, now_utc_msc())?;
    Ok(initial_directory)
}

fn read_manifest(path: &Path) -> Result<RehearsalManifest, RehearsalError> {
    let payload =
        fs::read(path).map_err(|_| RehearsalError::new("update_rehearsal_manifest_invalid"))?;
    serde_json::from_slice(&payload)
        .map_err(|_| RehearsalError::new("update_rehearsal_manifest_invalid"))
}

fn read_server_endpoint(version_directory: &Path) -> Result<Url, RehearsalError> {
    let payload = fs::read(version_directory.join("server-endpoints.json"))
        .map_err(|_| RehearsalError::new("update_rehearsal_server_endpoint_missing"))?;
    let document = serde_json::from_slice::<ServerEndpointDocument>(&payload)
        .map_err(|_| RehearsalError::new("update_rehearsal_server_endpoint_missing"))?;
    if document.schema_version != 1 {
        return Err(RehearsalError::new(
            "update_rehearsal_server_endpoint_missing",
        ));
    }
    validate_loopback_server(&document.server_url)
        .map_err(|_| RehearsalError::new("update_rehearsal_server_endpoint_invalid"))
}

fn ensure_expected_server(actual: &Url, expected: &Url) -> Result<(), RehearsalError> {
    if normalized_origin(actual) == normalized_origin(expected) {
        Ok(())
    } else {
        Err(RehearsalError::new(
            "update_rehearsal_server_endpoint_mismatch",
        ))
    }
}

fn normalized_origin(value: &Url) -> String {
    value.as_str().trim_end_matches('/').to_owned()
}

fn validate_loopback_server(value: &str) -> Result<Url, RehearsalError> {
    let url =
        Url::parse(value).map_err(|_| RehearsalError::new("update_rehearsal_server_invalid"))?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(RehearsalError::new("update_rehearsal_server_invalid"));
    }
    Ok(url)
}

fn prepare_empty_install_root(value: &str) -> Result<PathBuf, RehearsalError> {
    let root = std::path::absolute(value)
        .map_err(|_| RehearsalError::new("update_rehearsal_install_root_invalid"))?;
    fs::create_dir_all(&root)
        .map_err(|_| RehearsalError::new("update_rehearsal_install_root_invalid"))?;
    if fs::read_dir(&root)
        .map_err(|_| RehearsalError::new("update_rehearsal_install_root_invalid"))?
        .next()
        .is_some()
    {
        return Err(RehearsalError::new(
            "update_rehearsal_install_root_not_empty",
        ));
    }
    Ok(root)
}

fn existing_file(value: &str) -> Result<PathBuf, RehearsalError> {
    let file = std::path::absolute(value)
        .map_err(|_| RehearsalError::new("update_rehearsal_file_missing"))?;
    if file.is_file() {
        Ok(file)
    } else {
        Err(RehearsalError::new("update_rehearsal_file_missing"))
    }
}

fn parse_arguments(
    values: impl Iterator<Item = String>,
) -> Result<BTreeMap<String, String>, RehearsalError> {
    let values = values.collect::<Vec<_>>();
    if values.is_empty() || values.len() % 2 != 0 {
        return Err(RehearsalError::new("update_rehearsal_arguments_invalid"));
    }
    let mut result = BTreeMap::new();
    for pair in values.chunks_exact(2) {
        let Some(key) = pair[0].strip_prefix("--") else {
            return Err(RehearsalError::new("update_rehearsal_arguments_invalid"));
        };
        if key.is_empty() || pair[1].trim().is_empty() || result.contains_key(key) {
            return Err(RehearsalError::new("update_rehearsal_arguments_invalid"));
        }
        result.insert(key.to_owned(), pair[1].clone());
    }
    Ok(result)
}

fn required<'a>(
    values: &'a BTreeMap<String, String>,
    key: &'static str,
) -> Result<&'a str, RehearsalError> {
    values
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| RehearsalError(format!("update_rehearsal_{key}_missing").replace('-', "_")))
}

fn valid_numeric_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 10
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rehearsal_server_accepts_only_the_exact_ipv4_loopback_http_origin() {
        assert!(validate_loopback_server("http://127.0.0.1:3000").is_ok());
        for invalid in [
            "https://127.0.0.1:3000",
            "http://localhost:3000",
            "http://127.0.0.1:3000/api",
            "http://example.test",
        ] {
            assert_eq!(
                validate_loopback_server(invalid)
                    .expect_err("remote or non-root URL")
                    .to_string(),
                "update_rehearsal_server_invalid"
            );
        }
    }

    #[test]
    fn rehearsal_arguments_are_pairs_and_reject_duplicate_keys() {
        let parsed = parse_arguments(
            ["--server", "http://127.0.0.1:3000"]
                .into_iter()
                .map(str::to_owned),
        )
        .expect("arguments");
        assert_eq!(
            parsed.get("server").map(String::as_str),
            Some("http://127.0.0.1:3000")
        );
        for invalid in [
            vec!["server", "http://127.0.0.1:3000"],
            vec!["--server"],
            vec!["--server", "one", "--server", "two"],
        ] {
            assert_eq!(
                parse_arguments(invalid.into_iter().map(str::to_owned))
                    .expect_err("invalid arguments")
                    .to_string(),
                "update_rehearsal_arguments_invalid"
            );
        }
    }
}
