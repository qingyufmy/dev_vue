use bridge_contract::AccountRef;
use bridge_foundation::{profile_instance_id, resolve_profile_paths};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeClient, LocalControlRequest,
    LocalControlResult, UiStateSnapshot,
};
use bridge_mt4::reconnect_pipe_name;
use bridge_preferences::{BridgePreferencesStore, ObserverProfilePreferences};
use bridge_runtime_win::SingleInstanceGuard;
use bridge_security_win::{BridgeCredential, CredentialStore};
use bridge_store::OutboxStore;
use bridge_update::{
    BridgeUpdateState, BridgeUpdateStateStore, STATE_WAITING_WINDOW, UPDATE_STATE_FILE_NAME,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[test]
fn missing_authorization_waits_without_a_browser_and_honors_shutdown() {
    let root = unique_test_directory();
    fs::create_dir_all(&root).expect("fixture root");
    let profile_id = unique_profile_id();
    let paths = resolve_profile_paths(&root, &profile_id).expect("profile paths");
    let terminal_id = "mt4_0123456789abcdef01234567";
    let terminal_path = root.join("mt4-terminal-data");
    fs::write(&terminal_path, b"terminal fixture").expect("terminal fixture");
    OutboxStore::open_or_create(&paths.database_path)
        .expect("store")
        .activate_terminal_binding(
            terminal_id,
            "mt4",
            &terminal_path,
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            1_800_000_000_000,
        )
        .expect("terminal binding");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("preferences store");
    preferences.save_platform("mt4").expect("save platform");
    preferences
        .save_terminal("mt4", terminal_id)
        .expect("save terminal");
    let mut child = spawn_core(&root, &profile_id);
    wait_for_log_event(
        &mut child,
        &paths.data_directory,
        "native_runtime_pairing_required",
    );
    let pairing: Value = serde_json::from_slice(
        &fs::read(&paths.runtime_status_path).expect("pairing runtime status"),
    )
    .expect("pairing runtime json");
    assert_eq!(pairing["phase"], "pairing_required");
    assert_eq!(pairing["server_state"], "pairing_required");
    let local_state = tokio::runtime::Runtime::new()
        .expect("local control runtime")
        .block_on(async {
            let mut client = LocalControlPipeClient::connect(&profile_id, Duration::from_secs(2))
                .await
                .expect("local control client");
            client
                .request(&LocalControlRequest {
                    schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                    request_id: "request-pairing-state".to_owned(),
                    profile_id: profile_id.clone(),
                    action: LocalControlAction::GetState,
                })
                .await
                .expect("local control state")
        });
    let LocalControlResult::State { state } = local_state.result else {
        panic!("expected local control state");
    };
    assert_eq!(state.phase, "pairing_required");
    assert!(!state.server_connected);
    let reconnect_pipe = reconnect_pipe_name(terminal_id).expect("MT4 reconnect pipe");
    let reconnect_path = format!(r"\\.\pipe\{reconnect_pipe}");
    let local_ea_connected_without_server_authorization = tokio::runtime::Runtime::new()
        .expect("MT4 pipe runtime")
        .block_on(async {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match tokio::net::windows::named_pipe::ClientOptions::new().open(&reconnect_path) {
                    Ok(stream) => break Some(stream),
                    Err(_) if Instant::now() < deadline => {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    Err(_) => break None,
                }
            }
        });
    assert!(
        local_ea_connected_without_server_authorization.is_some(),
        "MT4 EA local pipe must be available before website authorization"
    );
    drop(local_ea_connected_without_server_authorization);

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
    let stopped: Value = serde_json::from_slice(
        &fs::read(&paths.runtime_status_path).expect("stopped runtime status"),
    )
    .expect("stopped runtime json");
    assert_eq!(stopped["phase"], "stopped");

    fs::remove_dir_all(root).expect("remove native pairing fixture");
}

#[test]
fn platform_selection_action_persists_dotnet_preferences_and_restarts_the_cycle() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = resolve_profile_paths(&root, &profile_id).expect("profile paths");
    let terminal_id = "mt4_89abcdef0123456701234567";
    let terminal_path = root.join("mt4-terminal-data");
    fs::create_dir_all(&terminal_path).expect("terminal fixture");
    OutboxStore::open_or_create(&paths.database_path)
        .expect("store")
        .activate_terminal_binding(
            terminal_id,
            "mt4",
            &terminal_path,
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            1_800_000_000_000,
        )
        .expect("terminal binding");
    let child = spawn_core(&root, &profile_id);
    let initial = wait_for_ui_phase(&profile_id, "platform_selection_required");
    assert_eq!(initial.selected_platform, None);
    let selected = local_control_request(
        &profile_id,
        "request-select-platform",
        LocalControlAction::SelectPlatform {
            platform: "mt4".to_owned(),
        },
    );
    assert_eq!(selected, LocalControlResult::Accepted);
    let pairing = wait_for_ui_phase(&profile_id, "pairing_required");
    assert_eq!(pairing.selected_platform.as_deref(), Some("mt4"));
    assert_eq!(
        BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
            .expect("preferences store")
            .load()
            .platform
            .as_deref(),
        Some("mt4")
    );
    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    fs::remove_dir_all(root).expect("remove platform selection fixture");
}

#[test]
fn terminal_selection_action_persists_dotnet_preferences_and_restarts_the_cycle() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = resolve_profile_paths(&root, &profile_id).expect("profile paths");
    let first_terminal_id = "mt4_111111111111111111111111";
    let selected_terminal_id = "mt4_222222222222222222222222";
    let store = OutboxStore::open_or_create(&paths.database_path).expect("store");
    for (terminal_id, login) in [
        (first_terminal_id, "111111"),
        (selected_terminal_id, "222222"),
    ] {
        let terminal_path = root.join(format!("mt4-terminal-{login}"));
        fs::create_dir_all(&terminal_path).expect("terminal fixture");
        store
            .activate_terminal_binding(
                terminal_id,
                "mt4",
                &terminal_path,
                &AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: login.to_owned(),
                },
                1_800_000_000_000,
            )
            .expect("terminal binding");
    }
    drop(store);
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("preferences store");
    preferences.save_platform("mt4").expect("save platform");
    let child = spawn_core(&root, &profile_id);
    let selecting = wait_for_ui_phase(&profile_id, "terminal_selection_required");
    assert_eq!(selecting.selected_platform.as_deref(), Some("mt4"));
    assert_eq!(selecting.terminal_candidates.len(), 2);
    assert_eq!(selecting.selected_terminal_instance_id, None);
    let selected = local_control_request(
        &profile_id,
        "request-select-terminal",
        LocalControlAction::SelectTerminal {
            terminal_instance_id: selected_terminal_id.to_owned(),
        },
    );
    assert_eq!(selected, LocalControlResult::Accepted);
    let pairing = wait_for_ui_phase(&profile_id, "pairing_required");
    assert_eq!(
        pairing.selected_terminal_instance_id.as_deref(),
        Some(selected_terminal_id)
    );
    assert_eq!(
        preferences.load().mt4_terminal_instance_id.as_deref(),
        Some(selected_terminal_id)
    );
    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    fs::remove_dir_all(root).expect("remove terminal selection fixture");
}

#[test]
fn mt4_expert_action_installs_and_rechecks_the_selected_terminal_over_local_control() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let paths = resolve_profile_paths(&root, &profile_id).expect("profile paths");
    let terminal_id = "mt4_333333333333333333333333";
    let terminal_path = root.join("mt4-terminal-data");
    fs::create_dir_all(terminal_path.join("MQL4")).expect("terminal MQL4");
    OutboxStore::open_or_create(&paths.database_path)
        .expect("store")
        .activate_terminal_binding(
            terminal_id,
            "mt4",
            &terminal_path,
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "333333".to_owned(),
            },
            1_800_000_000_000,
        )
        .expect("terminal binding");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("preferences store");
    preferences.save_platform("mt4").expect("save platform");
    preferences
        .save_terminal("mt4", terminal_id)
        .expect("save terminal");
    let source = root.join("AURUMBridgeEA.ex4");
    fs::write(&source, b"compiled-ea-fixture").expect("EA source fixture");
    let child = Command::new(env!("CARGO_BIN_EXE_liangjian-bridge-core"))
        .args(["--profile", &profile_id, "--background"])
        .env("AURUM_BRIDGE_DATA_DIR", &root)
        .env("AURUM_BRIDGE_MT4_EA", &source)
        .env("LOCALAPPDATA", root.join("local"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn native core");
    let pairing = wait_for_ui_phase(&profile_id, "pairing_required");
    assert_eq!(pairing.selected_platform.as_deref(), Some("mt4"));
    assert_eq!(
        pairing.selected_terminal_instance_id.as_deref(),
        Some(terminal_id)
    );
    let destination = terminal_path
        .join("MQL4")
        .join("Experts")
        .join("AURUMBridgeEA.ex4");
    assert_eq!(
        fs::read(&destination).expect("automatically installed EA"),
        b"compiled-ea-fixture"
    );
    fs::remove_file(&destination).expect("simulate a deleted EA");
    assert_eq!(
        local_control_request(
            &profile_id,
            "request-install-mt4-ea",
            LocalControlAction::InstallMt4Ea,
        ),
        LocalControlResult::Mt4EaDeployment {
            status: "installed".to_owned()
        }
    );
    assert_eq!(
        fs::read(&destination).expect("installed EA"),
        b"compiled-ea-fixture"
    );
    assert_eq!(
        local_control_request(
            &profile_id,
            "request-recheck-mt4-ea",
            LocalControlAction::InstallMt4Ea,
        ),
        LocalControlResult::Mt4EaDeployment {
            status: "current".to_owned()
        }
    );

    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    assert!(
        log_events(&paths.data_directory)
            .iter()
            .filter(|event| **event == "native_mt4_ea_manual_deployment_completed")
            .count()
            >= 2
    );
    assert!(
        log_events(&paths.data_directory).contains(&"native_mt4_ea_automatic_deployment_completed")
    );
    fs::remove_dir_all(root).expect("remove MT4 EA action fixture");
}

#[test]
fn signed_update_state_is_projected_and_manual_activation_is_persisted_over_local_control() {
    let root = unique_test_directory();
    fs::create_dir_all(&root).expect("fixture root");
    let update_path = root.join(UPDATE_STATE_FILE_NAME);
    let update_store = BridgeUpdateStateStore::with_clock(&update_path, || 1_800_000_000_123)
        .expect("update state store");
    update_store
        .save(BridgeUpdateState {
            schema_version: 1,
            state: STATE_WAITING_WINDOW.to_owned(),
            target_version: Some("3.0.1".to_owned()),
            release_id: Some("release-3.0.1".to_owned()),
            priority: Some("urgent".to_owned()),
            manual_activation_requested: false,
            staged_at_utc_msc: Some(1_800_000_000_000),
            activation_started_at_utc_msc: None,
            minimum_idle_seconds: 120,
            activation_deadline_utc_msc: None,
            maintenance_lease_id: None,
            maintenance_lease_expires_at_utc_msc: None,
            next_retry_at_utc_msc: None,
            last_error_code: None,
            updated_at_utc_msc: 1,
        })
        .expect("waiting update state");
    let child = Command::new(env!("CARGO_BIN_EXE_liangjian-bridge-core"))
        .env("AURUM_BRIDGE_DATA_DIR", &root)
        .env("AURUM_BRIDGE_UPDATE_STATE_PATH", &update_path)
        .env("LOCALAPPDATA", root.join("local"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn default native core");
    let state = wait_for_ui_phase("default", "platform_selection_required");
    let notice = state.update_notice.expect("ready update notice");
    assert_eq!(notice.version, "3.0.1");
    assert!(notice.urgent);
    assert_eq!(notice.phase, "ready");
    assert!(!notice.manual_activation_requested);

    assert_eq!(
        local_control_request(
            "default",
            "request-update-activate",
            LocalControlAction::UpdateActivate,
        ),
        LocalControlResult::Accepted
    );
    let persisted = update_store
        .load()
        .expect("load update state")
        .expect("persisted update state");
    assert!(persisted.manual_activation_requested);
    let LocalControlResult::State { state } = local_control_request(
        "default",
        "request-updated-state",
        LocalControlAction::GetState,
    ) else {
        panic!("expected updated UI state");
    };
    assert!(
        state
            .update_notice
            .expect("updated notice")
            .manual_activation_requested
    );

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id("default").expect("default instance id"),
    )
    .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    let paths = resolve_profile_paths(&root, "default").expect("default profile paths");
    assert!(
        log_events(&paths.data_directory).contains(&"native_update_manual_activation_requested")
    );
    fs::remove_dir_all(root).expect("remove update state fixture");
}

#[test]
fn observer_profile_cannot_change_global_endpoint_settings() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let child = spawn_core(&root, &profile_id);
    let initial = wait_for_ui_phase(&profile_id, "platform_selection_required");
    assert!(!initial.server_connected);
    let save_result = local_control_request(
        &profile_id,
        "request-save-endpoint",
        LocalControlAction::SettingsSave {
            settings: bridge_local_control::EndpointSettingsSelection {
                follow_official: false,
                server_url: "http://127.0.0.1:3000/".to_owned(),
            },
        },
    );
    assert_eq!(
        save_result,
        LocalControlResult::Rejected {
            code: "bridge_endpoint_settings_forbidden".to_owned()
        }
    );
    assert_eq!(
        local_control_request(
            &profile_id,
            "request-observer-update-activate",
            LocalControlAction::UpdateActivate,
        ),
        LocalControlResult::Rejected {
            code: "bridge_update_runtime_unavailable".to_owned()
        }
    );
    assert!(!root.join("endpoint-settings.json").exists());
    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    fs::remove_dir_all(root).expect("remove observer endpoint fixture");
}

#[test]
fn authorized_profile_without_a_terminal_waits_for_redetection() {
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
    BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("preferences store")
        .save_observer_profile(&ObserverProfilePreferences {
            platform: "mt5".to_owned(),
            terminal_instance_id: "mt5_0123456789abcdef01234567".to_owned(),
            terminal_path: root
                .join("missing-mt5")
                .join("terminal64.exe")
                .display()
                .to_string(),
            bridge_user_id: 7,
            observer_account_label: Some("测试观摩源".to_owned()),
            trading_account_id: None,
            trading_account_label: None,
        })
        .expect("save selected missing terminal");
    let child = spawn_core(&root, &profile_id);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let state = tokio::runtime::Runtime::new()
            .expect("local control runtime")
            .block_on(async {
                let mut client =
                    LocalControlPipeClient::connect(&profile_id, Duration::from_millis(250))
                        .await
                        .ok()?;
                client
                    .request(&LocalControlRequest {
                        schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                        request_id: "request-terminal-not-found".to_owned(),
                        profile_id: profile_id.clone(),
                        action: LocalControlAction::GetState,
                    })
                    .await
                    .ok()
            });
        if let Some(response) = state
            && let LocalControlResult::State { state } = response.result
            && state.phase == "terminal_not_found"
        {
            assert_eq!(state.selected_platform.as_deref(), Some("mt5"));
            assert_eq!(state.detail_code.as_deref(), Some("mt5_terminal_not_found"));
            break;
        }
        assert!(
            Instant::now() < deadline,
            "terminal-not-found state timed out"
        );
        thread::sleep(Duration::from_millis(50));
    }
    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output().expect("wait native core");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
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

fn wait_for_ui_phase(profile_id: &str, phase: &str) -> UiStateSnapshot {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(LocalControlResult::State { state }) = try_local_control_request(
            profile_id,
            &format!("request-wait-{phase}"),
            LocalControlAction::GetState,
        ) && state.phase == phase
        {
            return *state;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for UI phase {phase}"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn local_control_request(
    profile_id: &str,
    request_id: &str,
    action: LocalControlAction,
) -> LocalControlResult {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(result) = try_local_control_request(profile_id, request_id, action.clone()) {
            return result;
        }
        assert!(Instant::now() < deadline, "local control request timed out");
        thread::sleep(Duration::from_millis(25));
    }
}

fn try_local_control_request(
    profile_id: &str,
    request_id: &str,
    action: LocalControlAction,
) -> Option<LocalControlResult> {
    tokio::runtime::Runtime::new()
        .expect("local control runtime")
        .block_on(async {
            let mut client =
                LocalControlPipeClient::connect(profile_id, Duration::from_millis(250))
                    .await
                    .ok()?;
            client
                .request(&LocalControlRequest {
                    schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                    request_id: request_id.to_owned(),
                    profile_id: profile_id.to_owned(),
                    action,
                })
                .await
                .ok()
                .map(|response| response.result)
        })
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
            "mt5_89abcdef0123456701234567",
            "mt5",
            &terminal_path,
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            1_800_000_000_000,
        )
        .expect("terminal binding");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("preferences store");
    preferences.save_platform("mt5").expect("save platform");
    preferences
        .save_terminal("mt5", "mt5_89abcdef0123456701234567")
        .expect("save terminal");
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
        "native_mt4_ea_manual_deployment_completed" => {
            Some("native_mt4_ea_manual_deployment_completed")
        }
        "native_mt4_ea_automatic_deployment_completed" => {
            Some("native_mt4_ea_automatic_deployment_completed")
        }
        "native_update_manual_activation_requested" => {
            Some("native_update_manual_activation_requested")
        }
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
