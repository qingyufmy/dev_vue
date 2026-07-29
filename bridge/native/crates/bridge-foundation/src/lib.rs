use rusqlite::Connection;
use serde::Serialize;
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_PROFILE_ID: &str = "default";
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
        data_directory,
    })
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
