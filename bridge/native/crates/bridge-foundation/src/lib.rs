use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

pub const DEFAULT_PROFILE_ID: &str = "default";
pub const MAX_OBSERVER_PROFILES: usize = 16;
pub const MT5_WORKER_RELATIVE_PATH: &str = "modules/adapter.mt5.python/worker.py";
pub const PYTHON_RELATIVE_PATH: &str = "runtime/python/python.exe";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CliMode {
    HealthCheck {
        health_file: PathBuf,
    },
    Run {
        profile_id: String,
        background: bool,
        start_minimized: bool,
        ready_file: Option<PathBuf>,
        expected_terminal_instance_ids: Vec<String>,
    },
}

pub fn parse_cli<I>(args: I) -> Result<CliMode, &'static str>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args: Vec<OsString> = args.into_iter().collect();
    let mut profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut profile_seen = false;
    extract_value_flag(&mut args, "--profile", |value| {
        if profile_seen {
            return Err("bridge_arguments_invalid");
        }
        profile_seen = true;
        profile_id = validate_profile_id(value.to_str())?;
        Ok(())
    })?;

    let background = extract_boolean_flag(&mut args, "--background")?;
    let start_minimized = extract_boolean_flag(&mut args, "--start-minimized")?;
    if (background && profile_id == DEFAULT_PROFILE_ID)
        || (start_minimized && (profile_id != DEFAULT_PROFILE_ID || background))
    {
        return Err("bridge_arguments_invalid");
    }

    if args.first().is_some_and(|value| value == "--health-check") {
        if start_minimized || args.len() != 3 || args[1] != "--health-file" || args[2].is_empty() {
            return Err("bridge_arguments_invalid");
        }
        return Ok(CliMode::HealthCheck {
            health_file: PathBuf::from(&args[2]),
        });
    }

    if args.is_empty() {
        return Ok(CliMode::Run {
            profile_id,
            background,
            start_minimized,
            ready_file: None,
            expected_terminal_instance_ids: Vec::new(),
        });
    }
    if args.len() < 2 || !args.len().is_multiple_of(2) || args[0] != "--ready-file" {
        return Err("bridge_arguments_invalid");
    }
    let ready_file = PathBuf::from(&args[1]);
    if !ready_file.is_absolute() {
        return Err("bridge_arguments_invalid");
    }
    let mut expected = Vec::new();
    for pair in args[2..].chunks_exact(2) {
        if pair[0] != "--expected-terminal" {
            return Err("bridge_arguments_invalid");
        }
        let value = pair[1]
            .to_str()
            .ok_or("bridge_arguments_invalid")?
            .to_owned();
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || expected.contains(&value)
            || expected.len() >= 64
        {
            return Err("bridge_arguments_invalid");
        }
        expected.push(value);
    }
    Ok(CliMode::Run {
        profile_id,
        background,
        start_minimized,
        ready_file: Some(ready_file),
        expected_terminal_instance_ids: expected,
    })
}

fn extract_boolean_flag(args: &mut Vec<OsString>, flag: &str) -> Result<bool, &'static str> {
    let indexes: Vec<usize> = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (value == flag).then_some(index))
        .collect();
    if indexes.len() > 1 {
        return Err("bridge_arguments_invalid");
    }
    if let Some(index) = indexes.first().copied() {
        args.remove(index);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn extract_value_flag<F>(
    args: &mut Vec<OsString>,
    flag: &str,
    mut apply: F,
) -> Result<(), &'static str>
where
    F: FnMut(&OsString) -> Result<(), &'static str>,
{
    let mut index = 0;
    while index < args.len() {
        if args[index] != flag {
            index += 1;
            continue;
        }
        if index + 1 >= args.len() {
            return Err("bridge_arguments_invalid");
        }
        let value = args.remove(index + 1);
        args.remove(index);
        apply(&value)?;
    }
    Ok(())
}

pub fn validate_profile_id(value: Option<&str>) -> Result<String, &'static str> {
    let profile = value.unwrap_or_default().trim().to_ascii_lowercase();
    let profile = if profile.is_empty() {
        DEFAULT_PROFILE_ID.to_owned()
    } else {
        profile
    };
    if profile.len() > 40
        || !profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("bridge_profile_id_invalid");
    }
    Ok(profile)
}

pub fn profile_instance_id(profile_id: &str) -> Result<String, &'static str> {
    let profile_id = validate_profile_id(Some(profile_id))?;
    if profile_id == DEFAULT_PROFILE_ID {
        Ok("AURUMBridge.v3".to_owned())
    } else {
        Ok(format!("AURUMBridge.v3.profile.{profile_id}"))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeProfilePaths {
    pub root_data_directory: PathBuf,
    pub data_directory: PathBuf,
    pub credential_path: PathBuf,
    pub database_path: PathBuf,
    pub runtime_status_path: PathBuf,
}

pub fn resolve_profile_paths(
    root_data_directory: impl AsRef<Path>,
    profile_id: &str,
) -> Result<BridgeProfilePaths, &'static str> {
    let root = absolute_directory(root_data_directory.as_ref())?;
    let profile_id = validate_profile_id(Some(profile_id))?;
    let data_directory = if profile_id == DEFAULT_PROFILE_ID {
        root.clone()
    } else {
        root.join("profiles").join(profile_id)
    };
    Ok(BridgeProfilePaths {
        root_data_directory: root,
        credential_path: data_directory.join("credential.dat"),
        database_path: data_directory.join("bridge.db"),
        runtime_status_path: data_directory.join("runtime-status.json"),
        data_directory,
    })
}

pub const MAX_RUNTIME_STATUS_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeTerminalStatus {
    pub terminal_instance_id: String,
    pub platform: String,
    pub connection_epoch: i64,
    pub state: String,
    pub worker_state: String,
    pub collector_state: String,
    pub data_ready: bool,
    pub worker_consecutive_failures: u32,
    pub collector_consecutive_failures: u32,
    pub last_success_at_utc_msc: Option<i64>,
    pub error_code: Option<String>,
    #[serde(default)]
    pub history_state: String,
    #[serde(default)]
    pub history_consecutive_failures: u32,
    #[serde(default)]
    pub history_last_success_at_utc_msc: Option<i64>,
    #[serde(default)]
    pub history_error_code: Option<String>,
    #[serde(default)]
    pub mt4_expert_restart_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeReconciliationStatus {
    pub last_run_at_utc_msc: Option<i64>,
    pub inspected: usize,
    pub resolved: usize,
    pub pending: usize,
    pub error_codes: Vec<String>,
    pub consecutive_failures: u32,
    pub fatal_error_code: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStatusDocument {
    pub schema_version: u32,
    pub bridge_version: String,
    pub profile_id: String,
    pub observed_at_utc_msc: i64,
    pub phase: String,
    pub server_state: String,
    pub server_error_code: Option<String>,
    pub terminals: Vec<RuntimeTerminalStatus>,
    pub reconciliation: RuntimeReconciliationStatus,
}

impl RuntimeStatusDocument {
    pub fn validate(
        &self,
        expected_profile_id: &str,
        now_utc_msc: i64,
    ) -> Result<(), &'static str> {
        let expected_profile_id = validate_profile_id(Some(expected_profile_id))?;
        if self.schema_version != 1
            || self.profile_id != expected_profile_id
            || self.bridge_version.is_empty()
            || self.bridge_version.len() > 64
            || self.observed_at_utc_msc <= 0
            || now_utc_msc <= 0
            || self.observed_at_utc_msc > now_utc_msc.saturating_add(60_000)
            || !matches!(
                self.phase.as_str(),
                "starting"
                    | "pairing_required"
                    | "paused"
                    | "connecting"
                    | "online"
                    | "degraded"
                    | "stopped"
            )
            || !matches!(
                self.server_state.as_str(),
                "starting"
                    | "stopped"
                    | "pairing_required"
                    | "paused"
                    | "connecting"
                    | "connected"
                    | "reconnecting"
            )
            || self
                .server_error_code
                .as_deref()
                .is_some_and(|code| !valid_runtime_status_code(code))
            || self.terminals.len() > 64
            || self.reconciliation.error_codes.len() > 64
            || self
                .reconciliation
                .error_codes
                .iter()
                .any(|code| !valid_runtime_status_code(code))
            || self
                .reconciliation
                .fatal_error_code
                .as_deref()
                .is_some_and(|code| !valid_runtime_status_code(code))
        {
            return Err("bridge_runtime_status_invalid");
        }
        let mut terminal_ids = std::collections::BTreeSet::new();
        for terminal in &self.terminals {
            if terminal.terminal_instance_id.is_empty()
                || terminal.terminal_instance_id.len() > 128
                || !terminal
                    .terminal_instance_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || !terminal_ids.insert(&terminal.terminal_instance_id)
                || !matches!(terminal.platform.as_str(), "mt4" | "mt5")
                || terminal.connection_epoch <= 0
                || !matches!(
                    terminal.state.as_str(),
                    "starting" | "ready" | "degraded" | "superseded" | "stopped"
                )
                || !matches!(
                    terminal.worker_state.as_str(),
                    "starting" | "ready" | "restarting" | "superseded" | "stopped"
                )
                || !matches!(
                    terminal.collector_state.as_str(),
                    "starting" | "ready" | "retrying" | "stopped"
                )
                || (!terminal.history_state.is_empty()
                    && !matches!(
                        terminal.history_state.as_str(),
                        "starting" | "ready" | "retrying" | "stopped"
                    ))
                || terminal
                    .last_success_at_utc_msc
                    .is_some_and(|value| value <= 0 || value > now_utc_msc.saturating_add(60_000))
                || terminal
                    .history_last_success_at_utc_msc
                    .is_some_and(|value| value <= 0 || value > now_utc_msc.saturating_add(60_000))
                || terminal
                    .error_code
                    .as_deref()
                    .is_some_and(|code| !valid_runtime_status_code(code))
                || terminal
                    .history_error_code
                    .as_deref()
                    .is_some_and(|code| !valid_runtime_status_code(code))
            {
                return Err("bridge_runtime_status_invalid");
            }
        }
        if self
            .reconciliation
            .last_run_at_utc_msc
            .is_some_and(|value| value <= 0 || value > now_utc_msc.saturating_add(60_000))
        {
            return Err("bridge_runtime_status_invalid");
        }
        Ok(())
    }

    pub fn is_stale(&self, now_utc_msc: i64, max_age_msc: i64) -> bool {
        now_utc_msc <= 0
            || max_age_msc <= 0
            || now_utc_msc.saturating_sub(self.observed_at_utc_msc) > max_age_msc
    }
}

pub fn read_runtime_status_snapshot(
    input: &Path,
    expected_profile_id: &str,
    now_utc_msc: i64,
) -> Result<RuntimeStatusDocument, &'static str> {
    if !input.is_absolute()
        || input.file_name().and_then(|value| value.to_str()) != Some("runtime-status.json")
    {
        return Err("bridge_runtime_status_invalid");
    }
    let metadata = fs::metadata(input).map_err(|_| "bridge_runtime_status_unavailable")?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_RUNTIME_STATUS_BYTES as u64
    {
        return Err("bridge_runtime_status_invalid");
    }
    let payload = fs::read(input).map_err(|_| "bridge_runtime_status_unavailable")?;
    let document: RuntimeStatusDocument =
        serde_json::from_slice(&payload).map_err(|_| "bridge_runtime_status_invalid")?;
    document.validate(expected_profile_id, now_utc_msc)?;
    Ok(document)
}

fn valid_runtime_status_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

pub fn write_runtime_status_snapshot(output: &Path, payload: &[u8]) -> Result<(), Box<dyn Error>> {
    if !output.is_absolute()
        || output.file_name().and_then(|value| value.to_str()) != Some("runtime-status.json")
        || payload.is_empty()
        || payload.len() > MAX_RUNTIME_STATUS_BYTES
        || !serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(payload).is_ok()
    {
        return Err("bridge_runtime_status_invalid".into());
    }
    write_atomic_replace(output, payload)
        .map_err(|_| -> Box<dyn Error> { "bridge_runtime_status_write_failed".into() })
}

pub fn list_observer_profiles(
    root_data_directory: impl AsRef<Path>,
) -> Result<Vec<String>, &'static str> {
    let profiles_directory = absolute_directory(root_data_directory.as_ref())?.join("profiles");
    if !profiles_directory.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(profiles_directory).map_err(|_| "bridge_profiles_read_failed")?;
    let mut profiles = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "bridge_profiles_read_failed")?;
        if !entry
            .file_type()
            .map_err(|_| "bridge_profiles_read_failed")?
            .is_dir()
        {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "bridge_profile_id_invalid")?;
        let profile = validate_profile_id(Some(&name))?;
        if profile == DEFAULT_PROFILE_ID {
            return Err("bridge_profile_id_reserved");
        }
        profiles.push(profile);
    }
    profiles.sort();
    profiles.dedup();
    if profiles.len() > MAX_OBSERVER_PROFILES {
        return Err("bridge_observer_profile_limit_exceeded");
    }
    Ok(profiles)
}

fn absolute_directory(path: &Path) -> Result<PathBuf, &'static str> {
    if path.as_os_str().is_empty() {
        return Err("bridge_data_directory_invalid");
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|_| "bridge_data_directory_invalid")
    }
}

#[derive(Clone, Debug)]
pub struct HealthCheckOptions {
    pub application_directory: PathBuf,
    pub install_root: PathBuf,
    pub data_directory: PathBuf,
    pub health_file: PathBuf,
    pub version: String,
}

#[derive(Serialize)]
struct HealthPayload<'a> {
    ok: bool,
    version: &'a str,
    implementation: &'static str,
    checked_at_utc_msc: i64,
    checks: [&'static str; 3],
}

#[derive(Clone, Debug)]
pub struct StartupReadyOptions {
    pub output: PathBuf,
    pub version: String,
    pub server_connected: bool,
    pub running_terminal_instance_ids: Vec<String>,
    pub ready_at_utc_msc: i64,
}

#[derive(Serialize)]
struct StartupReadyPayload<'a> {
    ready: bool,
    version: &'a str,
    server_connected: bool,
    running_terminal_instance_ids: &'a [String],
    ready_at_utc_msc: i64,
}

pub fn write_startup_ready_signal(options: &StartupReadyOptions) -> Result<(), Box<dyn Error>> {
    if !options.output.is_absolute()
        || !is_numeric_version(&options.version)
        || !options.server_connected
        || options.ready_at_utc_msc <= 0
    {
        return Err("bridge_startup_signal_invalid".into());
    }
    let mut terminal_ids = options.running_terminal_instance_ids.clone();
    if terminal_ids.len() > 64 || terminal_ids.iter().any(|value| !is_terminal_id(value)) {
        return Err("bridge_startup_signal_invalid".into());
    }
    terminal_ids.sort();
    terminal_ids.dedup();
    let payload = serde_json::to_vec(&StartupReadyPayload {
        ready: true,
        version: &options.version,
        server_connected: true,
        running_terminal_instance_ids: &terminal_ids,
        ready_at_utc_msc: options.ready_at_utc_msc,
    })?;
    write_atomic_replace(&options.output, &payload)
}

pub fn run_health_check(options: &HealthCheckOptions) -> Result<(), Box<dyn Error>> {
    require_file(
        &options.application_directory.join(PYTHON_RELATIVE_PATH),
        "mt5_python_runtime_not_found",
    )?;
    require_file(
        &options.application_directory.join(MT5_WORKER_RELATIVE_PATH),
        "mt5_worker_script_not_found",
    )?;

    let health_root = options.install_root.join("health");
    fs::create_dir_all(&health_root)?;
    let health_root = health_root.canonicalize()?;
    let output = validate_health_output(&health_root, &options.health_file)?;

    fs::create_dir_all(&options.data_directory)?;
    verify_sqlite(&options.data_directory.join("bridge.db"))?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
    let payload = serde_json::to_vec(&HealthPayload {
        ok: true,
        version: &options.version,
        implementation: "rust-native-foundation",
        checked_at_utc_msc: now,
        checks: ["runtime_files", "sqlite_wal", "data_directory_write"],
    })?;
    write_atomic_new(&output, &payload)?;
    Ok(())
}

fn require_file(path: &Path, code: &'static str) -> Result<(), Box<dyn Error>> {
    if !path.is_file() {
        return Err(code.into());
    }
    Ok(())
}

fn validate_health_output(health_root: &Path, requested: &Path) -> Result<PathBuf, Box<dyn Error>> {
    if !requested.is_absolute() {
        return Err("bridge_health_path_invalid".into());
    }
    let file_name = requested
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("bridge_health_path_invalid")?;
    if !file_name.starts_with("health-") || !file_name.ends_with(".json") {
        return Err("bridge_health_path_invalid".into());
    }
    let parent = requested
        .parent()
        .ok_or("bridge_health_path_invalid")?
        .canonicalize()?;
    if parent != health_root {
        return Err("bridge_health_path_invalid".into());
    }
    Ok(parent.join(file_name))
}

fn verify_sqlite(path: &Path) -> Result<(), Box<dyn Error>> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode;", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err("bridge_health_sqlite_wal_required".into());
    }
    connection.execute_batch(
        "BEGIN IMMEDIATE;\n\
         CREATE TEMP TABLE IF NOT EXISTS native_health_probe(value INTEGER NOT NULL);\n\
         DELETE FROM native_health_probe;\n\
         INSERT INTO native_health_probe(value) VALUES (1);\n\
         COMMIT;",
    )?;
    Ok(())
}

fn write_atomic_new(output: &Path, payload: &[u8]) -> Result<(), Box<dyn Error>> {
    if output.exists() {
        return Err("bridge_health_output_exists".into());
    }
    let parent = output.parent().ok_or("bridge_health_path_invalid")?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("bridge_health_path_invalid")?,
        std::process::id(),
        stamp
    ));
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(payload)?;
        file.sync_all()?;
        fs::rename(&temporary, output)?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_atomic_replace(output: &Path, payload: &[u8]) -> Result<(), Box<dyn Error>> {
    let parent = output.parent().ok_or("bridge_startup_signal_invalid")?;
    fs::create_dir_all(parent)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let file_name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("bridge_startup_signal_invalid")?;
    let temporary = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), stamp));
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(payload)?;
        file.sync_all()?;
        let source = wide_null(temporary.as_os_str());
        let destination = wide_null(output.as_os_str());
        // SAFETY: both paths are valid, null-terminated UTF-16 strings. The temporary file is in
        // the destination directory, and MoveFileExW performs the replace before this function
        // releases ownership of either path buffer.
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("bridge_startup_signal_write_failed".into());
        }
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn wide_null(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn is_terminal_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn resolve_installed_root(application_directory: &Path) -> Result<PathBuf, &'static str> {
    let version_name = application_directory
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("bridge_install_root_invalid")?;
    if !is_numeric_version(version_name) {
        return Err("bridge_install_root_invalid");
    }
    let versions = application_directory
        .parent()
        .ok_or("bridge_install_root_invalid")?;
    if !versions
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("versions"))
    {
        return Err("bridge_install_root_invalid");
    }
    versions
        .parent()
        .map(Path::to_path_buf)
        .ok_or("bridge_install_root_invalid")
}

fn is_numeric_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub fn default_data_directory(profile_id: &str) -> Result<PathBuf, &'static str> {
    resolve_profile_paths(default_root_data_directory()?, profile_id)
        .map(|paths| paths.data_directory)
}

pub fn default_root_data_directory() -> Result<PathBuf, &'static str> {
    if let Some(value) = env::var_os("AURUM_BRIDGE_DATA_DIR") {
        return absolute_directory(&PathBuf::from(value));
    }
    let app_data = env::var_os("APPDATA").ok_or("bridge_appdata_unavailable")?;
    absolute_directory(&PathBuf::from(app_data).join("AURUM").join("BridgeV3"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_launcher_health_contract() {
        let path = PathBuf::from(r"C:\AURUM\health\health-1.json");
        assert_eq!(
            parse_cli(args(&[
                "--health-check",
                "--health-file",
                path.to_str().expect("path")
            ])),
            Ok(CliMode::HealthCheck { health_file: path })
        );
    }

    #[test]
    fn parses_observer_background_profile() {
        assert_eq!(
            parse_cli(args(&["--profile", "Source-A", "--background"])),
            Ok(CliMode::Run {
                profile_id: "source-a".to_owned(),
                background: true,
                start_minimized: false,
                ready_file: None,
                expected_terminal_instance_ids: Vec::new(),
            })
        );
    }

    #[test]
    fn profile_paths_match_v3_default_and_observer_layouts() {
        let root = PathBuf::from(r"C:\Users\fixture\AppData\Roaming\AURUM\BridgeV3");
        let default = resolve_profile_paths(&root, "default").expect("default paths");
        assert_eq!(default.data_directory, root);
        assert_eq!(
            default.credential_path,
            default.data_directory.join("credential.dat")
        );
        assert_eq!(
            default.database_path,
            default.data_directory.join("bridge.db")
        );
        assert_eq!(
            default.runtime_status_path,
            default.data_directory.join("runtime-status.json")
        );

        let observer = resolve_profile_paths(&default.root_data_directory, "Source-A")
            .expect("observer paths");
        assert_eq!(
            observer.data_directory,
            default
                .root_data_directory
                .join("profiles")
                .join("source-a")
        );
        assert_eq!(
            profile_instance_id("source-a").expect("observer instance"),
            "AURUMBridge.v3.profile.source-a"
        );
    }

    #[test]
    fn blank_profile_keeps_v3_default_compatibility() {
        assert_eq!(
            validate_profile_id(Some("  ")).expect("blank profile"),
            DEFAULT_PROFILE_ID
        );
    }

    #[test]
    fn observer_profiles_are_validated_sorted_and_isolated() {
        let root = unique_test_directory("profiles");
        fs::create_dir_all(root.join("profiles").join("source-b")).expect("source b");
        fs::create_dir_all(root.join("profiles").join("Source-A")).expect("source a");
        fs::write(root.join("profiles").join("ignored.txt"), b"fixture").expect("file");

        assert_eq!(
            list_observer_profiles(&root).expect("observer profiles"),
            vec!["source-a".to_owned(), "source-b".to_owned()]
        );
        fs::remove_dir_all(root).expect("remove profiles fixture");
    }

    #[test]
    fn observer_profile_listing_fails_closed_above_the_process_budget() {
        let root = unique_test_directory("profile-limit");
        for index in 0..=MAX_OBSERVER_PROFILES {
            fs::create_dir_all(root.join("profiles").join(format!("source-{index:02}")))
                .expect("observer profile");
        }
        assert_eq!(
            list_observer_profiles(&root),
            Err("bridge_observer_profile_limit_exceeded")
        );
        fs::remove_dir_all(root).expect("remove profiles fixture");
    }

    #[test]
    fn rejects_background_default_profile() {
        assert_eq!(
            parse_cli(args(&["--background"])),
            Err("bridge_arguments_invalid")
        );
    }

    #[test]
    fn parses_launcher_ready_contract() {
        let ready = PathBuf::from(r"C:\AURUM\health\ready-1.json");
        assert_eq!(
            parse_cli(args(&[
                "--start-minimized",
                "--ready-file",
                ready.to_str().expect("path"),
                "--expected-terminal",
                "mt5_abc"
            ])),
            Ok(CliMode::Run {
                profile_id: DEFAULT_PROFILE_ID.to_owned(),
                background: false,
                start_minimized: true,
                ready_file: Some(ready),
                expected_terminal_instance_ids: vec!["mt5_abc".to_owned()],
            })
        );
    }

    #[test]
    fn resolves_only_versioned_install_layout() {
        assert_eq!(
            resolve_installed_root(Path::new(r"C:\AURUM\versions\3.0.0")),
            Ok(PathBuf::from(r"C:\AURUM"))
        );
        assert_eq!(
            resolve_installed_root(Path::new(r"C:\AURUM\debug")),
            Err("bridge_install_root_invalid")
        );
    }

    #[test]
    fn health_check_requires_runtime_and_verifies_sqlite_wal() {
        let root = unique_test_directory("health-ok");
        let application = root.join("versions").join("3.0.0");
        let data = root.join("data");
        let health = root.join("health").join("health-fixture.json");
        fs::create_dir_all(application.join("runtime/python")).expect("python directory");
        fs::create_dir_all(application.join("modules/adapter.mt5.python"))
            .expect("worker directory");
        fs::write(application.join(PYTHON_RELATIVE_PATH), b"fixture").expect("python fixture");
        fs::write(application.join(MT5_WORKER_RELATIVE_PATH), b"fixture").expect("worker fixture");

        run_health_check(&HealthCheckOptions {
            application_directory: application,
            install_root: root.clone(),
            data_directory: data.clone(),
            health_file: health.clone(),
            version: "3.0.0-test".to_owned(),
        })
        .expect("health check");

        let payload: Value = serde_json::from_slice(&fs::read(&health).expect("health payload"))
            .expect("health json");
        assert_eq!(payload["ok"], Value::Bool(true));
        assert_eq!(payload["version"], "3.0.0-test");
        assert_eq!(payload["implementation"], "rust-native-foundation");
        let connection = Connection::open(data.join("bridge.db")).expect("health sqlite");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .expect("journal mode");
        assert!(journal_mode.eq_ignore_ascii_case("wal"));
        drop(connection);

        fs::remove_dir_all(root).expect("remove health fixture");
    }

    #[test]
    fn health_check_rejects_output_outside_install_health_directory() {
        let root = unique_test_directory("health-path");
        let application = root.join("versions").join("3.0.0");
        let data = root.join("data");
        fs::create_dir_all(application.join("runtime/python")).expect("python directory");
        fs::create_dir_all(application.join("modules/adapter.mt5.python"))
            .expect("worker directory");
        fs::write(application.join(PYTHON_RELATIVE_PATH), b"fixture").expect("python fixture");
        fs::write(application.join(MT5_WORKER_RELATIVE_PATH), b"fixture").expect("worker fixture");

        let result = run_health_check(&HealthCheckOptions {
            application_directory: application,
            install_root: root.clone(),
            data_directory: data,
            health_file: root.join("health-escaped.json"),
            version: "3.0.0-test".to_owned(),
        });

        assert_eq!(
            result
                .expect_err("outside health path must fail")
                .to_string(),
            "bridge_health_path_invalid"
        );
        fs::remove_dir_all(root).expect("remove health fixture");
    }

    #[test]
    fn startup_ready_signal_is_atomic_sorted_and_replaceable() {
        let root = unique_test_directory("ready");
        let output = root.join("ready.json");
        write_startup_ready_signal(&StartupReadyOptions {
            output: output.clone(),
            version: "3.0.0".to_owned(),
            server_connected: true,
            running_terminal_instance_ids: vec![
                "mt5_b".to_owned(),
                "mt5_a".to_owned(),
                "mt5_b".to_owned(),
            ],
            ready_at_utc_msc: 1_800_000_000_000,
        })
        .expect("initial ready signal");
        write_startup_ready_signal(&StartupReadyOptions {
            output: output.clone(),
            version: "3.0.1".to_owned(),
            server_connected: true,
            running_terminal_instance_ids: vec!["mt5_c".to_owned()],
            ready_at_utc_msc: 1_800_000_000_001,
        })
        .expect("replacement ready signal");

        let payload: Value =
            serde_json::from_slice(&fs::read(&output).expect("ready payload")).expect("ready json");
        assert_eq!(payload["ready"], true);
        assert_eq!(payload["version"], "3.0.1");
        assert_eq!(payload["server_connected"], true);
        assert_eq!(payload["running_terminal_instance_ids"][0], "mt5_c");
        assert_eq!(payload["ready_at_utc_msc"], 1_800_000_000_001_i64);
        assert_eq!(
            fs::read_dir(&root)
                .expect("ready directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        fs::remove_dir_all(root).expect("remove ready fixture");
    }

    #[test]
    fn runtime_status_snapshot_is_bounded_valid_json_and_atomically_replaceable() {
        let root = unique_test_directory("runtime-status");
        let output = root.join("runtime-status.json");
        write_runtime_status_snapshot(&output, br#"{"schema_version":1,"phase":"starting"}"#)
            .expect("initial runtime status");
        write_runtime_status_snapshot(&output, br#"{"schema_version":1,"phase":"online"}"#)
            .expect("replacement runtime status");

        let payload: Value = serde_json::from_slice(&fs::read(&output).expect("status payload"))
            .expect("status json");
        assert_eq!(payload["phase"], "online");
        assert_eq!(
            write_runtime_status_snapshot(&root.join("other.json"), b"{}")
                .expect_err("fixed filename required")
                .to_string(),
            "bridge_runtime_status_invalid"
        );
        assert_eq!(
            write_runtime_status_snapshot(&output, b"[]")
                .expect_err("object required")
                .to_string(),
            "bridge_runtime_status_invalid"
        );
        assert_eq!(
            fs::read_dir(&root)
                .expect("status directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0
        );
        fs::remove_dir_all(root).expect("remove status fixture");
    }

    #[test]
    fn runtime_status_reader_accepts_current_core_contract_and_classifies_staleness() {
        let root = unique_test_directory("runtime-status-reader");
        let output = root.join("runtime-status.json");
        let now = 1_800_000_000_000_i64;
        let payload = runtime_status_fixture(now - 5_000);
        write_runtime_status_snapshot(
            &output,
            &serde_json::to_vec(&payload).expect("status fixture json"),
        )
        .expect("write status fixture");

        let document =
            read_runtime_status_snapshot(&output, DEFAULT_PROFILE_ID, now).expect("read status");
        assert_eq!(document.phase, "online");
        assert_eq!(document.terminals[0].collector_state, "retrying");
        assert_eq!(document.terminals[0].history_state, "retrying");
        assert_eq!(document.terminals[0].history_consecutive_failures, 2);
        assert_eq!(
            document.terminals[0].history_error_code.as_deref(),
            Some("terminal_history_store_worker_failed")
        );
        assert!(!document.terminals[0].mt4_expert_restart_required);
        assert!(!document.is_stale(now, 15_000));
        assert!(document.is_stale(now + 20_001, 15_000));

        fs::remove_dir_all(root).expect("remove status reader fixture");
    }

    #[test]
    fn runtime_status_reader_rejects_unknown_fields_cross_profile_and_duplicate_terminals() {
        let root = unique_test_directory("runtime-status-invalid");
        fs::create_dir_all(&root).expect("status fixture directory");
        let output = root.join("runtime-status.json");
        let now = 1_800_000_000_000_i64;

        let mut unknown = runtime_status_fixture(now);
        unknown.as_object_mut().expect("status object").insert(
            "secret".to_owned(),
            Value::String("must-not-leak".to_owned()),
        );
        fs::write(
            &output,
            serde_json::to_vec(&unknown).expect("unknown field fixture"),
        )
        .expect("write unknown field fixture");
        assert_eq!(
            read_runtime_status_snapshot(&output, DEFAULT_PROFILE_ID, now),
            Err("bridge_runtime_status_invalid")
        );

        fs::write(
            &output,
            serde_json::to_vec(&runtime_status_fixture(now)).expect("cross profile fixture"),
        )
        .expect("write cross profile fixture");
        assert_eq!(
            read_runtime_status_snapshot(&output, "source-a", now),
            Err("bridge_runtime_status_invalid")
        );

        let mut duplicate = runtime_status_fixture(now);
        let terminals = duplicate["terminals"]
            .as_array_mut()
            .expect("terminal array");
        terminals.push(terminals[0].clone());
        fs::write(
            &output,
            serde_json::to_vec(&duplicate).expect("duplicate terminal fixture"),
        )
        .expect("write duplicate fixture");
        assert_eq!(
            read_runtime_status_snapshot(&output, DEFAULT_PROFILE_ID, now),
            Err("bridge_runtime_status_invalid")
        );

        fs::remove_dir_all(root).expect("remove invalid status fixture");
    }

    fn runtime_status_fixture(observed_at_utc_msc: i64) -> Value {
        serde_json::json!({
            "schema_version": 1,
            "bridge_version": "3.0.0-alpha.1",
            "profile_id": DEFAULT_PROFILE_ID,
            "observed_at_utc_msc": observed_at_utc_msc,
            "phase": "online",
            "server_state": "connected",
            "server_error_code": null,
            "terminals": [{
                "terminal_instance_id": "mt4_demo_4250502",
                "platform": "mt4",
                "connection_epoch": 1,
                "state": "ready",
                "worker_state": "ready",
                "collector_state": "retrying",
                "data_ready": true,
                "worker_consecutive_failures": 0,
                "collector_consecutive_failures": 1,
                "last_success_at_utc_msc": observed_at_utc_msc,
                "error_code": null,
                "history_state": "retrying",
                "history_consecutive_failures": 2,
                "history_last_success_at_utc_msc": observed_at_utc_msc,
                "history_error_code": "terminal_history_store_worker_failed"
            }],
            "reconciliation": {
                "last_run_at_utc_msc": observed_at_utc_msc,
                "inspected": 1,
                "resolved": 1,
                "pending": 0,
                "error_codes": [],
                "consecutive_failures": 0,
                "fatal_error_code": null
            }
        })
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        env::temp_dir().join(format!(
            "liangjian-bridge-native-{}-{}-{suffix}",
            std::process::id(),
            stamp
        ))
    }
}
