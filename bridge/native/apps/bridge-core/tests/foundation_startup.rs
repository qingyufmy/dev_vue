use bridge_contract::AccountRef;
use bridge_foundation::{profile_instance_id, resolve_profile_paths};
use bridge_runtime_win::SingleInstanceGuard;
use bridge_security_win::{BridgeCredential, CredentialStore};
use bridge_store::OutboxStore;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[test]
fn missing_authorization_waits_without_a_browser_and_honors_shutdown() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = resolve_profile_paths(&root, &profile_id).expect("profile paths");
    let mut child = spawn_core(&root, &profile_id);
    wait_for_log_event(
        &mut child,
        &paths.data_directory,
        "native_runtime_pairing_required",
    );

    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    assert_eq!(
        log_events(&paths.data_directory),
        vec![
            "native_runtime_foundation_started",
            "native_runtime_profile_loaded",
            "native_runtime_pairing_required",
            "native_runtime_stopped",
        ]
    );
    assert!(paths.database_path.is_file());
    assert!(
        !paths
            .data_directory
            .join("native-bridge-core.active")
            .exists()
    );
    assert!(!root.join("ready.json").exists());

    fs::remove_dir_all(root).expect("remove native pairing fixture");
}

#[test]
fn authorized_profile_without_a_terminal_fails_closed() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = resolve_profile_paths(&root, &profile_id).expect("profile paths");
    CredentialStore::new(&paths.credential_path)
        .expect("credential store")
        .save(&BridgeCredential {
            refresh_token: "r".repeat(48),
            expires_at_utc_msc: 1_900_000_000_000,
        })
        .expect("credential");

    let output = Command::new(env!("CARGO_BIN_EXE_liangjian-bridge-core"))
        .args(["--profile", &profile_id, "--background"])
        .env("AURUM_BRIDGE_DATA_DIR", &root)
        .env("LOCALAPPDATA", root.join("local"))
        .output()
        .expect("run native core");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stderr)
            .expect("native stderr")
            .trim(),
        "bridge_terminals_invalid"
    );
    assert_eq!(
        log_events(&paths.data_directory),
        vec![
            "native_runtime_foundation_started",
            "native_runtime_profile_loaded",
            "native_runtime_failed",
        ]
    );
    assert!(
        !paths
            .data_directory
            .join("native-bridge-core.active")
            .exists()
    );
    fs::remove_dir_all(root).expect("remove no-terminal fixture");
}

#[test]
fn damaged_packaged_endpoint_fails_before_any_worker_is_started() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = prepare_authorized_mt5_profile(&root, &profile_id);
    let application = root.join("application");
    fs::create_dir_all(application.join("runtime/python")).expect("python directory");
    fs::create_dir_all(application.join("modules/adapter.mt5.python")).expect("worker directory");
    fs::write(
        application.join("runtime/python/python.exe"),
        b"not executed",
    )
    .expect("python fixture");
    fs::write(
        application.join("modules/adapter.mt5.python/worker.py"),
        b"not executed",
    )
    .expect("worker fixture");
    fs::write(
        application.join("server-endpoints.json"),
        br#"{"schema_version":1,"server_url":"http://remote.example"}"#,
    )
    .expect("endpoint fixture");
    let executable = application.join("liangjian-bridge-core.exe");
    fs::copy(env!("CARGO_BIN_EXE_liangjian-bridge-core"), &executable).expect("copy core fixture");

    let output = Command::new(executable)
        .args(["--profile", &profile_id, "--background"])
        .env("AURUM_BRIDGE_DATA_DIR", &root)
        .env("LOCALAPPDATA", root.join("local"))
        .output()
        .expect("run native core");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stderr)
            .expect("native stderr")
            .trim(),
        "bridge_server_endpoints_invalid"
    );
    assert!(paths.database_path.is_file());
    assert!(
        !paths
            .data_directory
            .join("native-bridge-core.active")
            .exists()
    );
    fs::remove_dir_all(root).expect("remove endpoint fixture");
}

#[test]
fn launcher_expected_terminal_is_validated_before_startup() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = prepare_authorized_mt5_profile(&root, &profile_id);
    let application = root.join("application");
    fs::create_dir_all(application.join("runtime/python")).expect("python directory");
    fs::create_dir_all(application.join("modules/adapter.mt5.python")).expect("worker directory");
    fs::write(
        application.join("runtime/python/python.exe"),
        b"not executed",
    )
    .expect("python fixture");
    fs::write(
        application.join("modules/adapter.mt5.python/worker.py"),
        b"not executed",
    )
    .expect("worker fixture");
    fs::write(
        application.join("server-endpoints.json"),
        br#"{"schema_version":1,"server_url":"https://server.example"}"#,
    )
    .expect("endpoint fixture");
    let executable = application.join("liangjian-bridge-core.exe");
    fs::copy(env!("CARGO_BIN_EXE_liangjian-bridge-core"), &executable).expect("copy core fixture");
    let ready = root.join("ready.json");

    let output = Command::new(executable)
        .args([
            "--profile",
            &profile_id,
            "--background",
            "--ready-file",
            ready.to_str().expect("ready path"),
            "--expected-terminal",
            "mt5_missing_fixture",
        ])
        .env("AURUM_BRIDGE_DATA_DIR", &root)
        .env("LOCALAPPDATA", root.join("local"))
        .output()
        .expect("run native core");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stderr)
            .expect("native stderr")
            .trim(),
        "bridge_expected_terminal_missing"
    );
    assert!(!ready.exists());
    assert!(paths.database_path.is_file());
    fs::remove_dir_all(root).expect("remove expected-terminal fixture");
}

fn spawn_core(root: &Path, profile_id: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_liangjian-bridge-core"))
        .args(["--profile", profile_id, "--background"])
        .env("AURUM_BRIDGE_DATA_DIR", root)
        .env("LOCALAPPDATA", root.join("local"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn native core")
}

fn prepare_authorized_mt5_profile(
    root: &Path,
    profile_id: &str,
) -> bridge_foundation::BridgeProfilePaths {
    let paths = resolve_profile_paths(root, profile_id).expect("profile paths");
    CredentialStore::new(&paths.credential_path)
        .expect("credential store")
        .save(&BridgeCredential {
            refresh_token: "r".repeat(48),
            expires_at_utc_msc: 1_900_000_000_000,
        })
        .expect("credential");
    let terminal_path = root.join("terminal64.exe");
    fs::write(&terminal_path, b"terminal fixture").expect("terminal fixture");
    OutboxStore::open_or_create(&paths.database_path)
        .expect("store")
        .activate_terminal_binding(
            "mt5_endpoint_fixture",
            "mt5",
            &terminal_path,
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            1_800_000_000_000,
        )
        .expect("terminal binding");
    paths
}

fn wait_for_log_event(child: &mut Child, data_directory: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert_eq!(child.try_wait().expect("poll native core"), None);
        if log_events(data_directory).contains(&expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {expected}"
        );
        thread::sleep(Duration::from_millis(25));
    }
}

fn log_events(data_directory: &Path) -> Vec<&'static str> {
    let Ok(entries) = fs::read_dir(data_directory.join("logs")) else {
        return Vec::new();
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .flat_map(|path| {
            fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|record| record["event_name"].as_str().and_then(known_event))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn known_event(value: &str) -> Option<&'static str> {
    match value {
        "native_runtime_foundation_started" => Some("native_runtime_foundation_started"),
        "native_runtime_profile_loaded" => Some("native_runtime_profile_loaded"),
        "native_runtime_pairing_required" => Some("native_runtime_pairing_required"),
        "native_runtime_stopped" => Some("native_runtime_stopped"),
        "native_runtime_failed" => Some("native_runtime_failed"),
        _ => None,
    }
}

fn unique_profile_id() -> String {
    format!(
        "test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos()
    )
}

fn unique_test_directory() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "liangjian-bridge-core-foundation-{}-{stamp}",
        std::process::id()
    ))
}
