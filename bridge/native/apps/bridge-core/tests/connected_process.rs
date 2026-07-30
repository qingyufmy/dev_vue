use bridge_contract::{
    AccountRef, CommandMessage, HelloAcknowledgement, HelloMessage, TerminalDescriptor,
};
use bridge_foundation::{DEFAULT_PROFILE_ID, profile_instance_id, resolve_profile_paths};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeClient, LocalControlRequest,
    LocalControlResult,
};
use bridge_preferences::{BridgePreferencesStore, ObserverProfilePreferences};
use bridge_runtime_win::SingleInstanceGuard;
use bridge_security_win::{BridgeCredential, CredentialStore};
use bridge_store::OutboxStore;
use bridge_update::{BridgeUpdateState, BridgeUpdateStateStore, STATE_VERIFYING};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    TerminateProcess,
};

const RECOVERED_COMMAND_ID: &str = "command_01JRECOVER01";
const CONNECTED_COMMAND_ID: &str = "command_01JCONNECTED1";
const ROUND_TRIP_CLOSE_COMMAND_ID: &str = "command_01JCONNECTED2";
const ROUND_TRIP_CANCEL_COMMAND_ID: &str = "command_01JCONNECTED3";
const ROUND_TRIP_FINAL_COMMAND_ID: &str = "command_01JCONNECTED4";
static LOCAL_CONTROL_REQUEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
struct RoundTripCommand {
    symbol: String,
    side: String,
    order_kind: String,
    volume: f64,
    price: Option<f64>,
    modified_price: Option<f64>,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
    protection_distance: Option<f64>,
    partial_close_volume: Option<f64>,
    magic: i64,
    comment: String,
}

fn round_trip_params(command: &RoundTripCommand) -> Value {
    let mut params = serde_json::json!({
        "symbol": command.symbol,
        "side": command.side,
        "order_kind": command.order_kind,
        "volume": command.volume,
        "magic": command.magic,
        "comment": command.comment,
    });
    if let Some(price) = command.price {
        params["price"] = serde_json::json!(price);
    }
    params
}

#[test]
fn native_core_reaches_ready_reconnects_and_stops_as_one_process_tree() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let terminal_id = "mt5_aabbccddeeffaabbccddeeff";
    let mut server = LoopbackBridgeServer::start();
    let application = prepare_application(&root);
    let paths = prepare_profile(
        &root,
        &profile_id,
        terminal_id,
        &server.control_url,
        &server.realtime_url,
    );
    let ready = root.join("ready.json");
    let update_state_path = root.join("update-state.json");
    prepare_verifying_update_state(&update_state_path);
    let worker_pid_file = root.join("worker.pid");
    let order_send_count_file = root.join("order-send-count.txt");
    let mut child = ChildGuard::spawn(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        terminal_id,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(20), || {
        ready.is_file()
            && server.maintenance_released()
            && worker_pid_file.is_file()
            && server.saw_routed_full_snapshot(terminal_id)
            && server.saw_succeeded_command_result()
            && server.saw_recovered_command_result()
            && server.saw_history_response()
            && server.saw_data_response("chart_data")
            && server.saw_data_response("rates")
            && server.saw_data_response("symbols")
            && server.saw_data_response("symbol_snapshot")
            && server.saw_data_response("risk_snapshot")
            && server.saw_data_response("performance_daily")
            && server.saw_data_response("pending_order_state")
            && server.saw_data_response("diagnostics")
            && command_is_acked(&paths.database_path)
            && command_is_acked_by_id(&paths.database_path, RECOVERED_COMMAND_ID)
    });
    let worker_pid = fs::read_to_string(&worker_pid_file)
        .expect("worker pid")
        .trim()
        .parse::<u32>()
        .expect("worker pid integer");
    assert!(process_is_running(worker_pid), "worker should be running");
    let payload: Value =
        serde_json::from_slice(&fs::read(&ready).expect("ready payload")).expect("ready json");
    assert_eq!(payload["ready"], true);
    assert_eq!(payload["version"], "3.0.0");
    assert_eq!(payload["server_connected"], true);
    assert_eq!(payload["running_terminal_instance_ids"][0], terminal_id);
    assert!(
        server.maintenance_released(),
        "startup ready must release the persisted maintenance lease"
    );
    let runtime_status: Value = serde_json::from_slice(
        &fs::read(&paths.runtime_status_path).expect("runtime status payload"),
    )
    .expect("runtime status json");
    assert_eq!(runtime_status["schema_version"], 1);
    assert_eq!(runtime_status["phase"], "online");
    assert_eq!(runtime_status["server_state"], "connected");
    assert_eq!(
        runtime_status["terminals"][0]["terminal_instance_id"],
        terminal_id
    );
    assert_eq!(runtime_status["terminals"][0]["data_ready"], true);
    let runtime_text = serde_json::to_string(&runtime_status).expect("runtime status text");
    assert!(!runtime_text.contains("Broker-Demo"));
    assert!(!runtime_text.contains("123456"));
    assert_eq!(server.websocket_connections(), 1);
    assert!(
        server.saw_routed_full_snapshot(terminal_id),
        "forwarded full snapshot route missing"
    );
    assert!(
        server.saw_succeeded_command_result(),
        "server command did not complete through the native dispatcher"
    );
    assert!(
        command_is_acked(&paths.database_path),
        "command result acknowledgement was not persisted"
    );
    assert!(
        server.saw_recovered_command_result(),
        "interrupted command was not reconciled from terminal facts"
    );
    assert!(
        server.saw_history_response(),
        "history data request did not complete through SQLite"
    );
    assert!(
        server.saw_data_response("chart_data"),
        "chart data request did not complete through SQLite"
    );
    assert!(
        server.saw_data_response("rates"),
        "rates request did not reach MT5 Worker"
    );
    assert!(
        server.saw_data_response("symbols"),
        "symbols request did not reach MT5 Worker"
    );
    for action in [
        "symbol_snapshot",
        "risk_snapshot",
        "performance_daily",
        "pending_order_state",
        "diagnostics",
    ] {
        assert!(
            server.saw_data_response(action),
            "{action} request did not reach MT5 Worker"
        );
    }
    let cache_store = OutboxStore::open_existing(&paths.database_path).expect("open cache store");
    let cached_rates = cache_store
        .read_terminal_data_cache(
            &bridge_contract::TerminalDescriptor {
                terminal_instance_id: terminal_id.to_owned(),
                platform: "mt5".to_owned(),
                account_ref: AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "123456".to_owned(),
                },
                connection_epoch: 1,
                worker_version: None,
            },
            "rates",
            &serde_json::json!({ "symbol": "XAUUSD", "timeframe": "M5", "count": 20 }),
            0,
        )
        .expect("read rates cache");
    assert!(
        cached_rates.is_some(),
        "successful rates response was not cached"
    );
    drop(cache_store);
    assert_eq!(
        fs::read_to_string(&order_send_count_file)
            .expect("order send count")
            .trim(),
        "1",
        "update/rollback startup reconciliation must query terminal facts without replaying the interrupted order"
    );

    let status_before_lock = runtime_status["observed_at_utc_msc"]
        .as_i64()
        .expect("status timestamp");
    let status_lock = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&paths.runtime_status_path)
        .expect("lock runtime status without delete sharing");
    wait_until(&mut child, Duration::from_secs(8), || {
        log_events(&paths.data_directory)
            .iter()
            .any(|event| event == "native_runtime_status_failed")
    });
    assert!(
        child
            .child_mut()
            .try_wait()
            .expect("poll native core")
            .is_none(),
        "status projection failure must not stop the native core"
    );
    drop(status_lock);
    wait_until(&mut child, Duration::from_secs(8), || {
        runtime_status_json(&paths.runtime_status_path)
            .and_then(|status| status["observed_at_utc_msc"].as_i64())
            .is_some_and(|observed_at| observed_at > status_before_lock)
    });

    server.disconnect_first();
    wait_until(&mut child, Duration::from_secs(8), || {
        runtime_status_json(&paths.runtime_status_path).is_some_and(|status| {
            status["phase"] == "degraded" && status["server_state"] == "reconnecting"
        })
    });
    wait_until(&mut child, Duration::from_secs(15), || {
        server.websocket_connections() >= 2 && server.full_snapshot_count(terminal_id) >= 6
    });
    wait_until(&mut child, Duration::from_secs(8), || {
        runtime_status_json(&paths.runtime_status_path)
            .is_some_and(|status| status["phase"] == "online")
    });

    terminate_process(worker_pid);
    wait_until(&mut child, Duration::from_secs(8), || {
        runtime_status_json(&paths.runtime_status_path).is_some_and(|status| {
            status["phase"] == "degraded"
                && status["terminals"][0]["worker_consecutive_failures"]
                    .as_u64()
                    .is_some_and(|failures| failures >= 1)
        })
    });
    let mut restarted_worker_pid = worker_pid;
    wait_until(&mut child, Duration::from_secs(20), || {
        let Ok(value) = fs::read_to_string(&worker_pid_file) else {
            return false;
        };
        let Ok(process_id) = value.trim().parse::<u32>() else {
            return false;
        };
        if process_id == worker_pid || !process_is_running(process_id) {
            return false;
        }
        restarted_worker_pid = process_id;
        runtime_status_json(&paths.runtime_status_path)
            .is_some_and(|status| status["phase"] == "online")
    });

    let worker_before_binding_change = restarted_worker_pid;
    let replacement_terminal = root.join("terminal-replacement64.exe");
    fs::write(&replacement_terminal, b"replacement terminal fixture")
        .expect("replacement terminal fixture");
    let store =
        OutboxStore::open_or_create(&paths.database_path).expect("binding replacement store");
    let replacement = store
        .activate_terminal_binding(
            terminal_id,
            "mt5",
            &replacement_terminal,
            &AccountRef {
                broker_server: "Broker-Replacement".to_owned(),
                login: "654321".to_owned(),
            },
            now_utc_msc(),
        )
        .expect("activate replacement binding");
    assert_eq!(replacement.connection_epoch, 2);
    drop(store);
    wait_for_process_exit(worker_before_binding_change, Duration::from_secs(10));
    wait_until(&mut child, Duration::from_secs(20), || {
        let Ok(value) = fs::read_to_string(&worker_pid_file) else {
            return false;
        };
        let Ok(process_id) = value.trim().parse::<u32>() else {
            return false;
        };
        if process_id == worker_before_binding_change || !process_is_running(process_id) {
            return false;
        }
        restarted_worker_pid = process_id;
        true
    });
    wait_until(&mut child, Duration::from_secs(20), || {
        server.saw_hello_route(terminal_id, 2, "Broker-Replacement", "654321")
    });
    wait_until(&mut child, Duration::from_secs(20), || {
        runtime_status_json(&paths.runtime_status_path).is_some_and(|status| {
            status["phase"] == "online" && status["terminals"][0]["connection_epoch"] == 2
        })
    });
    assert_eq!(
        fs::read_to_string(&order_send_count_file)
            .expect("order send count after binding change")
            .trim(),
        "1",
        "binding reload must not replay an acknowledged trade"
    );
    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    wait_for_process_exit(restarted_worker_pid, Duration::from_secs(5));
    let events = log_events(&paths.data_directory);
    assert!(
        events
            .iter()
            .any(|event| event == "native_runtime_connections_started"),
        "connected runtime log missing"
    );
    assert!(
        events
            .iter()
            .any(|event| event == "startup_ready_confirmed"),
        "ready log missing"
    );
    assert!(
        events
            .iter()
            .any(|event| event == "native_runtime_binding_changed"),
        "binding reload log missing"
    );
    assert!(
        events.iter().any(|event| event == "native_runtime_stopped"),
        "graceful stop log missing"
    );
    assert!(
        !paths
            .data_directory
            .join("native-bridge-core.active")
            .exists()
    );
    let stopped_status: Value = serde_json::from_slice(
        &fs::read(&paths.runtime_status_path).expect("stopped status payload"),
    )
    .expect("stopped status json");
    assert_eq!(stopped_status["phase"], "stopped");

    server.stop();
    fs::remove_dir_all(root).expect("remove connected process fixture");
}

#[test]
fn native_core_update_drain_times_out_on_an_active_command_and_recovers_admission() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let terminal_id = "mt5_dddddddddddddddddddddddd";
    let mut server = LoopbackBridgeServer::start();
    let application = prepare_application(&root);
    let paths = prepare_profile(
        &root,
        &profile_id,
        terminal_id,
        &server.control_url,
        &server.realtime_url,
    );
    let ready = root.join("drain-ready.json");
    let update_state_path = root.join("drain-update-state.json");
    let order_send_count_file = root.join("order-send-count.txt");
    let mut child = ChildGuard::spawn_with_worker_delay(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        terminal_id,
        &update_state_path,
        750,
    );

    wait_until(&mut child, Duration::from_secs(20), || {
        fs::read_to_string(&order_send_count_file).is_ok_and(|count| count.trim() == "1")
    });
    let rejected = match try_request_local_control(
        &profile_id,
        LocalControlAction::InternalUpdateDrain { timeout_msc: 50 },
    ) {
        Ok(result) => result,
        Err(code) => {
            SingleInstanceGuard::request_shutdown(
                &profile_instance_id(&profile_id).expect("diagnostic instance id"),
            )
            .expect("request diagnostic shutdown");
            let output = child.wait_with_output();
            panic!(
                "drain IPC failed: {code}; status={:?}; stderr={}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    };
    assert_eq!(
        rejected,
        LocalControlResult::Rejected {
            code: "bridge_command_drain_timeout".to_owned(),
        },
        "an active command must prevent update activation"
    );

    wait_until(&mut child, Duration::from_secs(10), || {
        server.saw_succeeded_command_result() && command_is_acked(&paths.database_path)
    });
    assert_eq!(
        request_local_control(
            &profile_id,
            LocalControlAction::InternalUpdateDrain { timeout_msc: 1_000 },
        ),
        LocalControlResult::Accepted,
        "a timed-out drain must restore admission before the next attempt"
    );
    assert_eq!(
        request_local_control(&profile_id, LocalControlAction::InternalUpdateResume),
        LocalControlResult::Accepted
    );

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("drain instance id"),
    )
    .expect("request drain core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove drain process fixture");
}

#[test]
fn default_core_hosts_an_enabled_observer_profile_without_a_second_ui() {
    let root = unique_test_directory();
    let primary_terminal_id = "mt5_111111111111111111111111";
    let observer_terminal_id = "mt5_222222222222222222222222";
    let observer_profile_id = "source-1";
    let mut server = LoopbackBridgeServer::start_read_only_multi();
    let application = prepare_application(&root);
    let primary_paths = prepare_read_only_profile(
        &root,
        DEFAULT_PROFILE_ID,
        primary_terminal_id,
        "primary/terminal64.exe",
        "Primary-Demo",
        "100001",
        &server.control_url,
        &server.realtime_url,
    );
    let observer_paths = prepare_read_only_profile(
        &root,
        observer_profile_id,
        observer_terminal_id,
        "observer/terminal64.exe",
        "Observer-Demo",
        "200002",
        &server.control_url,
        &server.realtime_url,
    );
    let observer_preferences =
        BridgePreferencesStore::new(observer_paths.data_directory.join("preferences.json"))
            .expect("observer preferences store");
    let observer_terminal_path = root.join("observer/terminal64.exe");
    observer_preferences
        .save_observer_profile(&ObserverProfilePreferences {
            platform: "mt5".to_owned(),
            terminal_instance_id: observer_terminal_id.to_owned(),
            terminal_path: observer_terminal_path.to_string_lossy().into_owned(),
            bridge_user_id: 29,
            observer_account_label: Some("一号观摩源".to_owned()),
            trading_account_id: Some(81),
            trading_account_label: Some("观摩账户".to_owned()),
        })
        .expect("save observer profile");
    observer_preferences
        .save_observer_enabled(true)
        .expect("enable observer profile");

    let ready = root.join("multi-profile-ready.json");
    let update_state_path = root.join("multi-profile-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery_with_expected(
        application.join("liangjian-bridge-core.exe"),
        &root,
        DEFAULT_PROFILE_ID,
        &ready,
        &update_state_path,
        &[primary_terminal_id, observer_terminal_id],
    );

    wait_until(&mut child, Duration::from_secs(30), || {
        ready.is_file()
            && server.websocket_connections() == 2
            && server.saw_routed_full_snapshot(primary_terminal_id)
            && server.saw_routed_full_snapshot(observer_terminal_id)
            && runtime_status_json(&primary_paths.runtime_status_path).is_some_and(|status| {
                status["phase"] == "online"
                    && status["terminals"][0]["terminal_instance_id"] == primary_terminal_id
            })
            && runtime_status_json(&observer_paths.runtime_status_path).is_some_and(|status| {
                status["phase"] == "online"
                    && status["terminals"][0]["terminal_instance_id"] == observer_terminal_id
            })
    });
    let primary_status =
        fs::read_to_string(&primary_paths.runtime_status_path).expect("primary runtime status");
    let observer_status =
        fs::read_to_string(&observer_paths.runtime_status_path).expect("observer runtime status");
    assert!(!primary_status.contains("Observer-Demo"));
    assert!(!primary_status.contains("200002"));
    assert!(!observer_status.contains("Primary-Demo"));
    assert!(!observer_status.contains("100001"));
    assert_eq!(server.websocket_connections(), 2);
    let ready_payload: Value =
        serde_json::from_slice(&fs::read(&ready).expect("multi-profile ready payload"))
            .expect("multi-profile ready json");
    let ready_terminal_ids = ready_payload["running_terminal_instance_ids"]
        .as_array()
        .expect("ready terminal ids")
        .iter()
        .filter_map(Value::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        ready_terminal_ids,
        std::collections::BTreeSet::from([primary_terminal_id, observer_terminal_id])
    );
    for profile_id in [DEFAULT_PROFILE_ID, observer_profile_id] {
        assert_eq!(
            request_local_control(
                profile_id,
                LocalControlAction::InternalUpdateDrain { timeout_msc: 1_000 },
            ),
            LocalControlResult::Accepted,
            "every ready profile must expose the internal update drain endpoint"
        );
    }
    for profile_id in [observer_profile_id, DEFAULT_PROFILE_ID] {
        assert_eq!(
            request_local_control(profile_id, LocalControlAction::InternalUpdateResume),
            LocalControlResult::Accepted,
            "paused profiles must resume in reverse order after an aborted activation"
        );
    }

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(DEFAULT_PROFILE_ID).expect("default instance id"),
    )
    .expect("request default core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    assert!(
        runtime_status_json(&observer_paths.runtime_status_path)
            .is_some_and(|status| status["phase"] == "stopped"),
        "default Core shutdown must stop its observer Core"
    );
    assert!(
        !observer_paths
            .data_directory
            .join("native-bridge-core.active")
            .exists()
    );

    server.stop();
    fs::remove_dir_all(root).expect("remove multi-profile fixture");
}

#[test]
fn default_core_does_not_report_launcher_ready_when_an_expected_observer_is_offline() {
    let root = unique_test_directory();
    let primary_terminal_id = "mt5_333333333333333333333333";
    let observer_terminal_id = "mt5_444444444444444444444444";
    let observer_profile_id = "source-1";
    let mut server = LoopbackBridgeServer::start_read_only_multi();
    let application = prepare_application(&root);
    let primary_paths = prepare_read_only_profile(
        &root,
        DEFAULT_PROFILE_ID,
        primary_terminal_id,
        "primary/terminal64.exe",
        "Primary-Demo",
        "300003",
        &server.control_url,
        &server.realtime_url,
    );
    let observer_paths = prepare_read_only_profile(
        &root,
        observer_profile_id,
        observer_terminal_id,
        "observer/terminal64.exe",
        "Observer-Demo",
        "400004",
        &server.control_url,
        &server.realtime_url,
    );
    BridgePreferencesStore::new(observer_paths.data_directory.join("preferences.json"))
        .expect("observer preferences store")
        .save_observer_profile(&ObserverProfilePreferences {
            platform: "mt5".to_owned(),
            terminal_instance_id: observer_terminal_id.to_owned(),
            terminal_path: root
                .join("observer/terminal64.exe")
                .to_string_lossy()
                .into_owned(),
            bridge_user_id: 30,
            observer_account_label: Some("离线观摩源".to_owned()),
            trading_account_id: Some(82),
            trading_account_label: Some("离线账户".to_owned()),
        })
        .expect("save observer profile");
    BridgePreferencesStore::new(observer_paths.data_directory.join("preferences.json"))
        .expect("observer preferences store")
        .save_observer_enabled(true)
        .expect("enable observer profile");
    CredentialStore::new(&observer_paths.credential_path)
        .expect("observer credential store")
        .clear()
        .expect("remove observer credential");

    let ready = root.join("offline-observer-ready.json");
    let update_state_path = root.join("offline-observer-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery_with_expected(
        application.join("liangjian-bridge-core.exe"),
        &root,
        DEFAULT_PROFILE_ID,
        &ready,
        &update_state_path,
        &[primary_terminal_id, observer_terminal_id],
    );
    wait_until(&mut child, Duration::from_secs(30), || {
        server.websocket_connections() == 1
            && server.saw_routed_full_snapshot(primary_terminal_id)
            && runtime_status_json(&primary_paths.runtime_status_path).is_some_and(|status| {
                status["phase"] == "online"
                    && status["terminals"][0]["terminal_instance_id"] == primary_terminal_id
            })
            && runtime_status_json(&observer_paths.runtime_status_path)
                .is_some_and(|status| status["phase"] == "pairing_required")
    });
    thread::sleep(Duration::from_millis(500));
    child.assert_running();
    assert!(
        !ready.exists(),
        "Launcher ready must wait for every previously healthy observer"
    );

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(DEFAULT_PROFILE_ID).expect("default instance id"),
    )
    .expect("request default core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove offline observer fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT4 demo terminal"]
fn native_core_serves_live_mt4_history_from_sqlite_without_commands() {
    let terminal_data_path = std::env::var_os("AURUM_MT4_TEST_DATA_PATH")
        .map(PathBuf::from)
        .expect("AURUM_MT4_TEST_DATA_PATH");
    let broker_server = std::env::var("AURUM_MT4_TEST_SERVER").expect("AURUM_MT4_TEST_SERVER");
    let login = std::env::var("AURUM_MT4_TEST_LOGIN").expect("AURUM_MT4_TEST_LOGIN");
    assert!(terminal_data_path.is_absolute());
    assert!(terminal_data_path.join("MQL4").is_dir());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());

    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_read_only();
    let application = prepare_application(&root);
    let paths = prepare_mt4_discovery_profile(&root, &server.control_url, &server.realtime_url);
    let ready = root.join("mt4-ready.json");
    let update_state_path = root.join("mt4-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(30), || {
        ready.is_file() && server.saw_complete_history_payload("mt4_sqlite")
    });
    let ready_payload: Value =
        serde_json::from_slice(&fs::read(&ready).expect("MT4 ready payload"))
            .expect("MT4 ready json");
    assert_eq!(ready_payload["ready"], true);
    assert_eq!(ready_payload["server_connected"], true);
    assert!(server.saw_data_response("history"));
    assert!(server.saw_complete_history_payload("mt4_sqlite"));
    assert!(
        !server.saw_succeeded_command_result(),
        "read-only acceptance must not receive a trade result"
    );
    let store = OutboxStore::open_existing(&paths.database_path).expect("open MT4 history store");
    let bindings = store.terminal_bindings().expect("MT4 bindings");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].platform, "mt4");
    assert_eq!(bindings[0].account_ref.broker_server, broker_server);
    assert_eq!(bindings[0].account_ref.login, login);
    let runtime_status: Value = serde_json::from_slice(
        &fs::read(paths.data_directory.join("runtime-status.json"))
            .expect("MT4 runtime status payload"),
    )
    .expect("MT4 runtime status json");
    assert_eq!(
        runtime_status["terminals"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(runtime_status["terminals"][0]["state"], "ready");
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT4 instance id"),
    )
    .expect("request MT4 core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove live MT4 fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT4 demo terminal"]
fn native_core_returns_and_acks_a_live_mt4_pretrade_rejection() {
    let terminal_data_path = std::env::var_os("AURUM_MT4_TEST_DATA_PATH")
        .map(PathBuf::from)
        .expect("AURUM_MT4_TEST_DATA_PATH");
    let broker_server = std::env::var("AURUM_MT4_TEST_SERVER").expect("AURUM_MT4_TEST_SERVER");
    let login = std::env::var("AURUM_MT4_TEST_LOGIN").expect("AURUM_MT4_TEST_LOGIN");
    assert!(terminal_data_path.is_absolute());
    assert!(terminal_data_path.join("MQL4").is_dir());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());

    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_with_rejected_command(serde_json::json!({
        "symbol": "XAUUSD",
        "side": "buy",
        "volume": 0.001,
        "magic": 923412,
        "comment": "AURUM:CORE-MT4-REJECT"
    }));
    let application = prepare_application(&root);
    let paths = prepare_mt4_discovery_profile(&root, &server.control_url, &server.realtime_url);
    let ready = root.join("mt4-rejection-ready.json");
    let update_state_path = root.join("mt4-rejection-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(30), || {
        ready.is_file()
            && server.saw_command_result("command_01JCONNECTED1", "rejected", "mt4_error_131")
            && command_is_acked(&paths.database_path)
    });
    assert!(server.saw_command_result("command_01JCONNECTED1", "rejected", "mt4_error_131",));
    assert!(command_is_acked(&paths.database_path));
    let store = OutboxStore::open_existing(&paths.database_path).expect("open MT4 rejection store");
    let ledger = store
        .command_ledger("command_01JCONNECTED1")
        .expect("MT4 rejection ledger")
        .expect("MT4 rejection command");
    assert_eq!(ledger.status, "acked");
    let bindings = store.terminal_bindings().expect("MT4 rejection bindings");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].platform, "mt4");
    assert_eq!(bindings[0].account_ref.broker_server, broker_server);
    assert_eq!(bindings[0].account_ref.login, login);
    let projection = store
        .load_terminal_projection(
            &bindings[0].terminal_instance_id,
            &bindings[0].account_ref,
            bindings[0].connection_epoch,
        )
        .expect("MT4 rejection projection");
    let active_state =
        serde_json::to_string(&(projection.positions.items, projection.orders.items))
            .expect("MT4 active state json");
    assert!(!active_state.contains("AURUM:CORE-MT4-REJECT"));
    assert!(!active_state.contains("923412"));
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT4 rejection instance id"),
    )
    .expect("request MT4 rejection core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove live MT4 rejection fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT4 demo terminal and sends one market round trip"]
fn native_core_opens_acks_and_closes_a_live_mt4_demo_position() {
    let terminal_data_path = std::env::var_os("AURUM_MT4_TEST_DATA_PATH")
        .map(PathBuf::from)
        .expect("AURUM_MT4_TEST_DATA_PATH");
    let broker_server = std::env::var("AURUM_MT4_TEST_SERVER").expect("AURUM_MT4_TEST_SERVER");
    let login = std::env::var("AURUM_MT4_TEST_LOGIN").expect("AURUM_MT4_TEST_LOGIN");
    assert!(terminal_data_path.is_absolute());
    assert!(terminal_data_path.join("MQL4").is_dir());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());

    let marker = "AURUM:CORE-MT4-ROUNDTRIP";
    let magic = 923_413;
    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_with_round_trip(RoundTripCommand {
        symbol: "XAUUSD".to_owned(),
        side: "buy".to_owned(),
        order_kind: "market".to_owned(),
        volume: 0.02,
        price: None,
        modified_price: None,
        stop_loss: None,
        take_profit: None,
        protection_distance: Some(20.0),
        partial_close_volume: Some(0.01),
        magic,
        comment: marker.to_owned(),
    });
    let application = prepare_application(&root);
    let paths = prepare_mt4_discovery_profile(&root, &server.control_url, &server.realtime_url);
    let ready = root.join("mt4-round-trip-ready.json");
    let update_state_path = root.join("mt4-round-trip-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(30), || {
        ready.is_file()
            && server.saw_command_result(CONNECTED_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CLOSE_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CANCEL_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_FINAL_COMMAND_ID, "succeeded", "none")
            && command_is_acked_by_id(&paths.database_path, CONNECTED_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CLOSE_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CANCEL_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_FINAL_COMMAND_ID)
    });
    thread::sleep(Duration::from_millis(500));
    let store =
        OutboxStore::open_existing(&paths.database_path).expect("open MT4 round-trip store");
    for command_id in [
        CONNECTED_COMMAND_ID,
        ROUND_TRIP_CLOSE_COMMAND_ID,
        ROUND_TRIP_CANCEL_COMMAND_ID,
        ROUND_TRIP_FINAL_COMMAND_ID,
    ] {
        let ledger = store
            .command_ledger(command_id)
            .expect("MT4 round-trip ledger")
            .expect("MT4 round-trip command");
        assert_eq!(ledger.status, "acked");
    }
    let open_receipt = store
        .execution_receipt(CONNECTED_COMMAND_ID)
        .expect("MT4 open receipt")
        .expect("MT4 open result");
    let modify_receipt = store
        .execution_receipt(ROUND_TRIP_CLOSE_COMMAND_ID)
        .expect("MT4 modify position receipt")
        .expect("MT4 modify position result");
    let partial_close_receipt = store
        .execution_receipt(ROUND_TRIP_CANCEL_COMMAND_ID)
        .expect("MT4 partial close receipt")
        .expect("MT4 partial close result");
    let close_receipt = store
        .execution_receipt(ROUND_TRIP_FINAL_COMMAND_ID)
        .expect("MT4 final close receipt")
        .expect("MT4 final close result");
    assert_eq!(open_receipt.status, "succeeded");
    assert_eq!(modify_receipt.status, "succeeded");
    assert_eq!(partial_close_receipt.status, "succeeded");
    assert_eq!(close_receipt.status, "succeeded");
    assert_eq!(open_receipt.evidence.broker_retcode, Some(0));
    assert_eq!(modify_receipt.evidence.broker_retcode, Some(0));
    assert_eq!(partial_close_receipt.evidence.broker_retcode, Some(0));
    assert_eq!(close_receipt.evidence.broker_retcode, Some(0));
    let open_ticket = open_receipt
        .evidence
        .order_tickets
        .first()
        .expect("MT4 opened ticket");
    let partial_ticket = partial_close_receipt
        .evidence
        .position_tickets
        .first()
        .expect("MT4 partially closed ticket");
    let final_ticket = close_receipt
        .evidence
        .position_tickets
        .first()
        .expect("MT4 final closed ticket");
    assert_eq!(partial_ticket, open_ticket);
    assert!(!final_ticket.is_empty());
    let bindings = store.terminal_bindings().expect("MT4 round-trip bindings");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].platform, "mt4");
    assert_eq!(bindings[0].account_ref.broker_server, broker_server);
    assert_eq!(bindings[0].account_ref.login, login);
    let projection = store
        .load_terminal_projection(
            &bindings[0].terminal_instance_id,
            &bindings[0].account_ref,
            bindings[0].connection_epoch,
        )
        .expect("MT4 round-trip projection");
    let active_state =
        serde_json::to_string(&(projection.positions.items, projection.orders.items))
            .expect("MT4 round-trip active state json");
    assert!(!active_state.contains(marker));
    assert!(!active_state.contains(&magic.to_string()));
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT4 round-trip instance id"),
    )
    .expect("request MT4 round-trip core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove live MT4 round-trip fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT4 demo terminal and sends one pending-order round trip"]
fn native_core_places_modifies_and_cancels_a_live_mt4_demo_order() {
    let terminal_data_path = std::env::var_os("AURUM_MT4_TEST_DATA_PATH")
        .map(PathBuf::from)
        .expect("AURUM_MT4_TEST_DATA_PATH");
    let broker_server = std::env::var("AURUM_MT4_TEST_SERVER").expect("AURUM_MT4_TEST_SERVER");
    let login = std::env::var("AURUM_MT4_TEST_LOGIN").expect("AURUM_MT4_TEST_LOGIN");
    assert!(terminal_data_path.is_absolute());
    assert!(terminal_data_path.join("MQL4").is_dir());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());

    let marker = "AURUM:CORE-MT4-PENDING";
    let magic = 923_416;
    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_with_round_trip(RoundTripCommand {
        symbol: "XAUUSD".to_owned(),
        side: "buy".to_owned(),
        order_kind: "limit".to_owned(),
        volume: 0.01,
        price: None,
        modified_price: None,
        stop_loss: None,
        take_profit: None,
        protection_distance: None,
        partial_close_volume: None,
        magic,
        comment: marker.to_owned(),
    });
    let application = prepare_application(&root);
    let paths = prepare_mt4_discovery_profile(&root, &server.control_url, &server.realtime_url);
    let ready = root.join("mt4-pending-round-trip-ready.json");
    let update_state_path = root.join("mt4-pending-round-trip-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(30), || {
        ready.is_file()
            && server.saw_command_result(CONNECTED_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CLOSE_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CANCEL_COMMAND_ID, "succeeded", "none")
            && command_is_acked_by_id(&paths.database_path, CONNECTED_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CLOSE_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CANCEL_COMMAND_ID)
    });
    thread::sleep(Duration::from_millis(500));
    let store = OutboxStore::open_existing(&paths.database_path)
        .expect("open MT4 pending round-trip store");
    let placed = store
        .execution_receipt(CONNECTED_COMMAND_ID)
        .expect("MT4 pending place receipt")
        .expect("MT4 pending place result");
    let modified = store
        .execution_receipt(ROUND_TRIP_CLOSE_COMMAND_ID)
        .expect("MT4 pending modify receipt")
        .expect("MT4 pending modify result");
    let cancelled = store
        .execution_receipt(ROUND_TRIP_CANCEL_COMMAND_ID)
        .expect("MT4 pending cancel receipt")
        .expect("MT4 pending cancel result");
    for receipt in [&placed, &modified, &cancelled] {
        assert_eq!(receipt.status, "succeeded");
        assert_eq!(receipt.evidence.broker_retcode, Some(0));
    }
    assert!(!placed.evidence.order_tickets.is_empty());
    for command_id in [
        CONNECTED_COMMAND_ID,
        ROUND_TRIP_CLOSE_COMMAND_ID,
        ROUND_TRIP_CANCEL_COMMAND_ID,
    ] {
        assert_eq!(
            store
                .command_ledger(command_id)
                .expect("MT4 pending round-trip ledger")
                .expect("MT4 pending round-trip command")
                .status,
            "acked"
        );
    }
    let bindings = store.terminal_bindings().expect("MT4 pending bindings");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].account_ref.broker_server, broker_server);
    assert_eq!(bindings[0].account_ref.login, login);
    let projection = store
        .load_terminal_projection(
            &bindings[0].terminal_instance_id,
            &bindings[0].account_ref,
            bindings[0].connection_epoch,
        )
        .expect("MT4 pending round-trip projection");
    let active_state =
        serde_json::to_string(&(projection.positions.items, projection.orders.items))
            .expect("MT4 pending round-trip active state json");
    assert!(!active_state.contains(marker));
    assert!(!active_state.contains(&magic.to_string()));
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT4 pending round-trip instance id"),
    )
    .expect("request MT4 pending round-trip core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove live MT4 pending round-trip fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT5 demo terminal and bundled Python runtime"]
fn native_core_serves_live_mt5_history_from_sqlite_without_commands() {
    let terminal_path = std::env::var_os("AURUM_MT5_TEST_TERMINAL")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_TERMINAL");
    let python_runtime = std::env::var_os("AURUM_MT5_TEST_PYTHON_RUNTIME")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_PYTHON_RUNTIME");
    let broker_server = std::env::var("AURUM_MT5_TEST_SERVER").expect("AURUM_MT5_TEST_SERVER");
    let login = std::env::var("AURUM_MT5_TEST_LOGIN").expect("AURUM_MT5_TEST_LOGIN");
    assert!(terminal_path.is_absolute());
    assert!(terminal_path.is_file());
    assert!(python_runtime.join("python.exe").is_file());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());

    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_read_only();
    let application = prepare_live_mt5_application(&root, &python_runtime);
    let terminal_id = mt5_terminal_instance_id(&terminal_path);
    let paths = prepare_mt5_discovery_profile(
        &root,
        &terminal_id,
        &terminal_path,
        &server.control_url,
        &server.realtime_url,
    );
    let ready = root.join("mt5-ready.json");
    let update_state_path = root.join("mt5-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    let timeout_seconds = std::env::var("AURUM_MT5_TEST_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(120);
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    loop {
        child.assert_running();
        if ready.is_file() && server.saw_complete_history_payload("mt5_sqlite") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "MT5 history condition timed out: {:?}",
            server.message_summaries()
        );
        thread::sleep(Duration::from_millis(25));
    }
    let ready_payload: Value =
        serde_json::from_slice(&fs::read(&ready).expect("MT5 ready payload"))
            .expect("MT5 ready json");
    assert_eq!(ready_payload["ready"], true);
    assert_eq!(ready_payload["server_connected"], true);
    assert!(server.saw_data_response("history"));
    assert!(server.saw_complete_history_payload("mt5_sqlite"));
    assert!(
        !server.saw_succeeded_command_result(),
        "read-only acceptance must not receive a trade result"
    );
    let store = OutboxStore::open_existing(&paths.database_path).expect("open MT5 history store");
    let bindings = store.terminal_bindings().expect("MT5 bindings");
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].terminal_instance_id, terminal_id);
    assert_eq!(bindings[0].platform, "mt5");
    assert_eq!(bindings[0].account_ref.broker_server, broker_server);
    assert_eq!(bindings[0].account_ref.login, login);
    let runtime_status: Value = serde_json::from_slice(
        &fs::read(paths.data_directory.join("runtime-status.json"))
            .expect("MT5 runtime status payload"),
    )
    .expect("MT5 runtime status json");
    assert_eq!(
        runtime_status["terminals"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(runtime_status["terminals"][0]["state"], "ready");
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT5 instance id"),
    )
    .expect("request MT5 core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    fs::remove_dir_all(root).expect("remove live MT5 fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT5 demo terminal and bundled Python runtime"]
fn native_core_returns_and_acks_a_live_mt5_pretrade_rejection() {
    let terminal_path = std::env::var_os("AURUM_MT5_TEST_TERMINAL")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_TERMINAL");
    let python_runtime = std::env::var_os("AURUM_MT5_TEST_PYTHON_RUNTIME")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_PYTHON_RUNTIME");
    let broker_server = std::env::var("AURUM_MT5_TEST_SERVER").expect("AURUM_MT5_TEST_SERVER");
    let login = std::env::var("AURUM_MT5_TEST_LOGIN").expect("AURUM_MT5_TEST_LOGIN");
    assert!(terminal_path.is_absolute());
    assert!(terminal_path.is_file());
    assert!(python_runtime.join("python.exe").is_file());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());
    let before = mt5_active_trade_snapshot(&python_runtime, &terminal_path);

    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_with_rejected_command(serde_json::json!({
        "symbol": "XAUUSD",
        "side": "buy",
        "volume": 0.001,
        "magic": 923411,
        "comment": "AURUM:CORE-REJECT"
    }));
    let application = prepare_live_mt5_application(&root, &python_runtime);
    let terminal_id = mt5_terminal_instance_id(&terminal_path);
    let paths = prepare_mt5_discovery_profile(
        &root,
        &terminal_id,
        &terminal_path,
        &server.control_url,
        &server.realtime_url,
    );
    let ready = root.join("mt5-rejection-ready.json");
    let update_state_path = root.join("mt5-rejection-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(30), || {
        ready.is_file()
            && server.saw_command_result(
                "command_01JCONNECTED1",
                "rejected",
                "order_volume_below_minimum",
            )
            && command_is_acked(&paths.database_path)
    });
    assert!(server.saw_command_result(
        "command_01JCONNECTED1",
        "rejected",
        "order_volume_below_minimum",
    ));
    assert!(command_is_acked(&paths.database_path));
    let ledger = OutboxStore::open_existing(&paths.database_path)
        .expect("open MT5 rejection store")
        .command_ledger("command_01JCONNECTED1")
        .expect("MT5 rejection ledger")
        .expect("MT5 rejection command");
    assert_eq!(ledger.status, "acked");

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT5 rejection instance id"),
    )
    .expect("request MT5 rejection core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    let after = mt5_active_trade_snapshot(&python_runtime, &terminal_path);
    assert_eq!(after, before, "rejected command changed live MT5 state");
    fs::remove_dir_all(root).expect("remove live MT5 rejection fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT5 demo terminal and sends one market round trip"]
fn native_core_opens_acks_and_closes_a_live_mt5_demo_position() {
    let terminal_path = std::env::var_os("AURUM_MT5_TEST_TERMINAL")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_TERMINAL");
    let python_runtime = std::env::var_os("AURUM_MT5_TEST_PYTHON_RUNTIME")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_PYTHON_RUNTIME");
    let broker_server = std::env::var("AURUM_MT5_TEST_SERVER").expect("AURUM_MT5_TEST_SERVER");
    let login = std::env::var("AURUM_MT5_TEST_LOGIN").expect("AURUM_MT5_TEST_LOGIN");
    assert!(terminal_path.is_absolute());
    assert!(terminal_path.is_file());
    assert!(python_runtime.join("python.exe").is_file());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());
    let before = mt5_active_trade_snapshot(&python_runtime, &terminal_path);
    let (stop_loss, take_profit) =
        mt5_buy_protection_prices(&python_runtime, &terminal_path, "XAUUSD");

    let marker = "AURUM:CORE-MT5-ROUNDTRIP";
    let magic = 923_414;
    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_with_round_trip(RoundTripCommand {
        symbol: "XAUUSD".to_owned(),
        side: "buy".to_owned(),
        order_kind: "market".to_owned(),
        volume: 0.02,
        price: None,
        modified_price: None,
        stop_loss: Some(stop_loss),
        take_profit: Some(take_profit),
        protection_distance: None,
        partial_close_volume: Some(0.01),
        magic,
        comment: marker.to_owned(),
    });
    let application = prepare_live_mt5_application(&root, &python_runtime);
    let terminal_id = mt5_terminal_instance_id(&terminal_path);
    let paths = prepare_mt5_discovery_profile(
        &root,
        &terminal_id,
        &terminal_path,
        &server.control_url,
        &server.realtime_url,
    );
    let ready = root.join("mt5-round-trip-ready.json");
    let update_state_path = root.join("mt5-round-trip-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(45), || {
        ready.is_file()
            && server.saw_command_result(CONNECTED_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CLOSE_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CANCEL_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_FINAL_COMMAND_ID, "succeeded", "none")
            && command_is_acked_by_id(&paths.database_path, CONNECTED_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CLOSE_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CANCEL_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_FINAL_COMMAND_ID)
    });
    thread::sleep(Duration::from_millis(500));
    let store =
        OutboxStore::open_existing(&paths.database_path).expect("open MT5 round-trip store");
    for command_id in [
        CONNECTED_COMMAND_ID,
        ROUND_TRIP_CLOSE_COMMAND_ID,
        ROUND_TRIP_CANCEL_COMMAND_ID,
        ROUND_TRIP_FINAL_COMMAND_ID,
    ] {
        let ledger = store
            .command_ledger(command_id)
            .expect("MT5 round-trip ledger")
            .expect("MT5 round-trip command");
        assert_eq!(ledger.status, "acked");
    }
    let open_receipt = store
        .execution_receipt(CONNECTED_COMMAND_ID)
        .expect("MT5 open receipt")
        .expect("MT5 open result");
    let modify_receipt = store
        .execution_receipt(ROUND_TRIP_CLOSE_COMMAND_ID)
        .expect("MT5 modify position receipt")
        .expect("MT5 modify position result");
    let partial_close_receipt = store
        .execution_receipt(ROUND_TRIP_CANCEL_COMMAND_ID)
        .expect("MT5 partial close receipt")
        .expect("MT5 partial close result");
    let close_receipt = store
        .execution_receipt(ROUND_TRIP_FINAL_COMMAND_ID)
        .expect("MT5 final close receipt")
        .expect("MT5 final close result");
    assert_eq!(open_receipt.status, "succeeded");
    assert_eq!(modify_receipt.status, "succeeded");
    assert_eq!(partial_close_receipt.status, "succeeded");
    assert_eq!(close_receipt.status, "succeeded");
    assert_eq!(open_receipt.evidence.broker_retcode, Some(10_009));
    assert_eq!(modify_receipt.evidence.broker_retcode, Some(10_009));
    assert_eq!(partial_close_receipt.evidence.broker_retcode, Some(10_009));
    assert_eq!(close_receipt.evidence.broker_retcode, Some(10_009));
    assert!(!open_receipt.evidence.order_tickets.is_empty());
    assert!(
        partial_close_receipt
            .raw_result
            .as_ref()
            .and_then(|result| result.get("position"))
            .is_some_and(|ticket| ticket.as_u64().is_some_and(|ticket| ticket > 0))
    );
    assert!(
        close_receipt
            .raw_result
            .as_ref()
            .and_then(|result| result.get("position"))
            .is_some_and(|ticket| ticket.as_u64().is_some_and(|ticket| ticket > 0))
    );
    let projection = store
        .load_terminal_projection(
            &terminal_id,
            &AccountRef {
                broker_server: broker_server.clone(),
                login: login.clone(),
            },
            1,
        )
        .expect("MT5 round-trip projection");
    let active_state =
        serde_json::to_string(&(projection.positions.items, projection.orders.items))
            .expect("MT5 round-trip active state json");
    assert!(!active_state.contains(marker));
    assert!(!active_state.contains(&magic.to_string()));
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT5 round-trip instance id"),
    )
    .expect("request MT5 round-trip core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    let after = mt5_active_trade_snapshot(&python_runtime, &terminal_path);
    assert_eq!(after, before, "MT5 round trip changed live terminal state");
    fs::remove_dir_all(root).expect("remove live MT5 round-trip fixture");
}

#[test]
#[ignore = "requires an explicitly configured live MT5 demo terminal and sends one pending-order round trip"]
fn native_core_places_acks_and_cancels_a_live_mt5_demo_order() {
    let terminal_path = std::env::var_os("AURUM_MT5_TEST_TERMINAL")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_TERMINAL");
    let python_runtime = std::env::var_os("AURUM_MT5_TEST_PYTHON_RUNTIME")
        .map(PathBuf::from)
        .expect("AURUM_MT5_TEST_PYTHON_RUNTIME");
    let broker_server = std::env::var("AURUM_MT5_TEST_SERVER").expect("AURUM_MT5_TEST_SERVER");
    let login = std::env::var("AURUM_MT5_TEST_LOGIN").expect("AURUM_MT5_TEST_LOGIN");
    assert!(terminal_path.is_absolute());
    assert!(terminal_path.is_file());
    assert!(python_runtime.join("python.exe").is_file());
    assert!(broker_server.to_ascii_lowercase().contains("demo"));
    assert!(!login.trim().is_empty());
    let before = mt5_active_trade_snapshot(&python_runtime, &terminal_path);
    let (pending_price, modified_price) =
        mt5_buy_limit_prices(&python_runtime, &terminal_path, "XAUUSD");

    let marker = "AURUM:CORE-MT5-PENDING";
    let magic = 923_415;
    let root = unique_test_directory();
    let profile_id = DEFAULT_PROFILE_ID.to_owned();
    let mut server = LoopbackBridgeServer::start_with_round_trip(RoundTripCommand {
        symbol: "XAUUSD".to_owned(),
        side: "buy".to_owned(),
        order_kind: "limit".to_owned(),
        volume: 0.01,
        price: Some(pending_price),
        modified_price: Some(modified_price),
        stop_loss: None,
        take_profit: None,
        protection_distance: None,
        partial_close_volume: None,
        magic,
        comment: marker.to_owned(),
    });
    let application = prepare_live_mt5_application(&root, &python_runtime);
    let terminal_id = mt5_terminal_instance_id(&terminal_path);
    let paths = prepare_mt5_discovery_profile(
        &root,
        &terminal_id,
        &terminal_path,
        &server.control_url,
        &server.realtime_url,
    );
    let ready = root.join("mt5-pending-round-trip-ready.json");
    let update_state_path = root.join("mt5-pending-round-trip-update-state.json");
    let mut child = ChildGuard::spawn_for_discovery(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        &update_state_path,
    );

    wait_until(&mut child, Duration::from_secs(45), || {
        ready.is_file()
            && server.saw_command_result(CONNECTED_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CLOSE_COMMAND_ID, "succeeded", "none")
            && server.saw_command_result(ROUND_TRIP_CANCEL_COMMAND_ID, "succeeded", "none")
            && command_is_acked_by_id(&paths.database_path, CONNECTED_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CLOSE_COMMAND_ID)
            && command_is_acked_by_id(&paths.database_path, ROUND_TRIP_CANCEL_COMMAND_ID)
    });
    thread::sleep(Duration::from_millis(500));
    let store = OutboxStore::open_existing(&paths.database_path)
        .expect("open MT5 pending round-trip store");
    let placed = store
        .execution_receipt(CONNECTED_COMMAND_ID)
        .expect("MT5 pending place receipt")
        .expect("MT5 pending place result");
    let modified = store
        .execution_receipt(ROUND_TRIP_CLOSE_COMMAND_ID)
        .expect("MT5 pending modify receipt")
        .expect("MT5 pending modify result");
    let cancelled = store
        .execution_receipt(ROUND_TRIP_CANCEL_COMMAND_ID)
        .expect("MT5 pending cancel receipt")
        .expect("MT5 pending cancel result");
    assert_eq!(placed.status, "succeeded");
    assert_eq!(modified.status, "succeeded");
    assert_eq!(cancelled.status, "succeeded");
    assert_eq!(placed.evidence.broker_retcode, Some(10_009));
    assert_eq!(modified.evidence.broker_retcode, Some(10_009));
    assert_eq!(cancelled.evidence.broker_retcode, Some(10_009));
    assert!(!placed.evidence.order_tickets.is_empty());
    for command_id in [
        CONNECTED_COMMAND_ID,
        ROUND_TRIP_CLOSE_COMMAND_ID,
        ROUND_TRIP_CANCEL_COMMAND_ID,
    ] {
        assert_eq!(
            store
                .command_ledger(command_id)
                .expect("MT5 pending round-trip ledger")
                .expect("MT5 pending round-trip command")
                .status,
            "acked"
        );
    }
    let projection = store
        .load_terminal_projection(
            &terminal_id,
            &AccountRef {
                broker_server: broker_server.clone(),
                login: login.clone(),
            },
            1,
        )
        .expect("MT5 pending round-trip projection");
    let active_state =
        serde_json::to_string(&(projection.positions.items, projection.orders.items))
            .expect("MT5 pending round-trip active state json");
    assert!(!active_state.contains(marker));
    assert!(!active_state.contains(&magic.to_string()));
    drop(store);

    SingleInstanceGuard::request_shutdown(
        &profile_instance_id(&profile_id).expect("MT5 pending round-trip instance id"),
    )
    .expect("request MT5 pending round-trip core shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    server.stop();
    let after = mt5_active_trade_snapshot(&python_runtime, &terminal_path);
    assert_eq!(
        after, before,
        "MT5 pending round trip changed live terminal state"
    );
    fs::remove_dir_all(root).expect("remove live MT5 pending round-trip fixture");
}

fn request_local_control(profile_id: &str, action: LocalControlAction) -> LocalControlResult {
    try_request_local_control(profile_id, action).expect("local control response")
}

fn try_request_local_control(
    profile_id: &str,
    action: LocalControlAction,
) -> Result<LocalControlResult, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("local control runtime");
    runtime.block_on(async {
        let mut client = LocalControlPipeClient::connect(profile_id, Duration::from_secs(5))
            .await
            .map_err(|error| error.code().to_owned())?;
        client
            .request(&LocalControlRequest {
                schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                request_id: format!(
                    "test_drain_{}",
                    LOCAL_CONTROL_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                ),
                profile_id: profile_id.to_owned(),
                action,
            })
            .await
            .map(|response| response.result)
            .map_err(|error| error.code().to_owned())
    })
}

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn spawn(
        executable: PathBuf,
        root: &Path,
        profile_id: &str,
        ready: &Path,
        terminal_id: &str,
        update_state_path: &Path,
    ) -> Self {
        Self::spawn_with_optional_worker_delay(
            executable,
            root,
            profile_id,
            ready,
            terminal_id,
            update_state_path,
            None,
        )
    }

    fn spawn_with_worker_delay(
        executable: PathBuf,
        root: &Path,
        profile_id: &str,
        ready: &Path,
        terminal_id: &str,
        update_state_path: &Path,
        worker_delay_msc: u64,
    ) -> Self {
        Self::spawn_with_optional_worker_delay(
            executable,
            root,
            profile_id,
            ready,
            terminal_id,
            update_state_path,
            Some(worker_delay_msc),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_with_optional_worker_delay(
        executable: PathBuf,
        root: &Path,
        profile_id: &str,
        ready: &Path,
        terminal_id: &str,
        update_state_path: &Path,
        worker_delay_msc: Option<u64>,
    ) -> Self {
        let mut command = Command::new(executable);
        command
            .args([
                "--profile",
                profile_id,
                "--background",
                "--ready-file",
                ready.to_str().expect("ready path"),
                "--expected-terminal",
                terminal_id,
            ])
            .env("AURUM_BRIDGE_DATA_DIR", root)
            .env("AURUM_BRIDGE_UPDATE_STATE_PATH", update_state_path)
            .env("LOCALAPPDATA", root.join("local"))
            .env("AURUM_TEST_WORKER_PID_FILE", root.join("worker.pid"))
            .env(
                "AURUM_TEST_WORKER_ORDER_SEND_COUNT_FILE",
                root.join("order-send-count.txt"),
            );
        if let Some(worker_delay_msc) = worker_delay_msc {
            command.env(
                "AURUM_TEST_WORKER_ORDER_SEND_DELAY_MSC",
                worker_delay_msc.to_string(),
            );
        }
        let child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn native core");
        Self(Some(child))
    }

    fn spawn_for_discovery(
        executable: PathBuf,
        root: &Path,
        profile_id: &str,
        ready: &Path,
        update_state_path: &Path,
    ) -> Self {
        Self::spawn_for_discovery_with_expected(
            executable,
            root,
            profile_id,
            ready,
            update_state_path,
            &[],
        )
    }

    fn spawn_for_discovery_with_expected(
        executable: PathBuf,
        root: &Path,
        profile_id: &str,
        ready: &Path,
        update_state_path: &Path,
        expected_terminal_ids: &[&str],
    ) -> Self {
        let mut command = Command::new(executable);
        command.args([
            "--profile",
            profile_id,
            "--ready-file",
            ready.to_str().expect("ready path"),
        ]);
        for terminal_id in expected_terminal_ids {
            command.args(["--expected-terminal", terminal_id]);
        }
        let child = command
            .env("AURUM_BRIDGE_DATA_DIR", root)
            .env("AURUM_BRIDGE_UPDATE_STATE_PATH", update_state_path)
            .env("LOCALAPPDATA", root.join("local"))
            .env("AURUM_TEST_WORKER_PID_FILE", root.join("worker.pid"))
            .env(
                "AURUM_TEST_WORKER_ORDER_SEND_COUNT_FILE",
                root.join("order-send-count.txt"),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn native MT4 core");
        Self(Some(child))
    }

    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("child available")
    }

    fn assert_running(&mut self) {
        let status = self.child_mut().try_wait().expect("poll native core");
        if status.is_some() {
            let output = self
                .0
                .take()
                .expect("child available")
                .wait_with_output()
                .expect("collect native core output");
            panic!(
                "native core exited early: status={:?} stdout={} stderr={}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    fn wait_with_output(&mut self) -> std::process::Output {
        self.0
            .take()
            .expect("child available")
            .wait_with_output()
            .expect("wait native core")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct LoopbackBridgeServer {
    control_url: String,
    realtime_url: String,
    disconnect_first: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    websocket_connections: Arc<AtomicUsize>,
    message_types: Arc<Mutex<Vec<String>>>,
    maintenance_released: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl LoopbackBridgeServer {
    fn start() -> Self {
        Self::start_with_commands(true, None, None, false)
    }

    fn start_read_only() -> Self {
        Self::start_with_commands(false, None, None, false)
    }

    fn start_read_only_multi() -> Self {
        Self::start_with_commands(false, None, None, true)
    }

    fn start_with_rejected_command(params: Value) -> Self {
        Self::start_with_commands(false, Some(params), None, false)
    }

    fn start_with_round_trip(command: RoundTripCommand) -> Self {
        let params = round_trip_params(&command);
        Self::start_with_commands(false, Some(params), Some(command), false)
    }

    fn start_with_commands(
        send_commands: bool,
        command_override: Option<Value>,
        round_trip: Option<RoundTripCommand>,
        concurrent_read_only: bool,
    ) -> Self {
        let disconnect_first = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let websocket_connections = Arc::new(AtomicUsize::new(0));
        let command_sent = Arc::new(AtomicBool::new(false));
        let message_types = Arc::new(Mutex::new(Vec::new()));
        let maintenance_released = Arc::new(AtomicBool::new(false));
        let (addresses_tx, addresses_rx) = mpsc::sync_channel(1);
        let thread = {
            let disconnect_first = Arc::clone(&disconnect_first);
            let stop = Arc::clone(&stop);
            let websocket_connections = Arc::clone(&websocket_connections);
            let command_sent = Arc::clone(&command_sent);
            let message_types = Arc::clone(&message_types);
            let maintenance_released = Arc::clone(&maintenance_released);
            thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("server runtime");
                runtime.block_on(async move {
                    let control = TcpListener::bind("127.0.0.1:0")
                        .await
                        .expect("control bind");
                    let realtime = TcpListener::bind("127.0.0.1:0")
                        .await
                        .expect("realtime bind");
                    addresses_tx
                        .send((
                            control.local_addr().expect("control address"),
                            realtime.local_addr().expect("realtime address"),
                        ))
                        .expect("send addresses");
                    tokio::join!(
                        serve_control(control, Arc::clone(&stop), maintenance_released,),
                        serve_realtime_dispatch(
                            RealtimeFixture {
                                listener: realtime,
                                disconnect_first,
                                stop: Arc::clone(&stop),
                                websocket_connections,
                                command_sent,
                                message_types,
                                send_commands,
                                command_override,
                                round_trip,
                            },
                            concurrent_read_only
                        )
                    );
                });
            })
        };
        let (control, realtime) = addresses_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server addresses");
        Self {
            control_url: format!("http://{control}"),
            realtime_url: format!("ws://{realtime}"),
            disconnect_first,
            stop,
            websocket_connections,
            message_types,
            maintenance_released,
            thread: Some(thread),
        }
    }

    fn disconnect_first(&self) {
        self.disconnect_first.store(true, Ordering::SeqCst);
    }

    fn websocket_connections(&self) -> usize {
        self.websocket_connections.load(Ordering::SeqCst)
    }

    fn maintenance_released(&self) -> bool {
        self.maintenance_released.load(Ordering::SeqCst)
    }

    fn saw_routed_full_snapshot(&self, terminal_id: &str) -> bool {
        self.full_snapshot_count(terminal_id) > 0
    }

    fn full_snapshot_count(&self, terminal_id: &str) -> usize {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .filter(|value| *value == &format!("data_delta:{terminal_id}:full"))
            .count()
    }

    fn saw_succeeded_command_result(&self) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| value == "command_result:succeeded:10009")
    }

    fn saw_recovered_command_result(&self) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| value == &format!("command_result_id:{RECOVERED_COMMAND_ID}:succeeded"))
    }

    fn saw_command_result(&self, command_id: &str, status: &str, error_code: &str) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| {
                value == &format!("command_result_error:{command_id}:{status}:{error_code}")
            })
    }

    fn saw_history_response(&self) -> bool {
        self.saw_data_response("history")
    }

    fn saw_complete_history_payload(&self, source: &str) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| {
                let fields = value.split(':').collect::<Vec<_>>();
                fields.len() == 6
                    && fields[0] == "history_payload"
                    && fields[1] == source
                    && fields[2].parse::<usize>().is_ok_and(|count| count > 0)
                    && fields[3].parse::<usize>().is_ok_and(|count| count > 0)
                    && fields[4].parse::<usize>().is_ok_and(|size| size <= 20)
                    && fields[5] == "true"
            })
    }

    fn message_summaries(&self) -> Vec<String> {
        self.message_types.lock().expect("message types").clone()
    }

    fn saw_data_response(&self, action: &str) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| value == &format!("data_response:{action}:succeeded"))
    }

    fn saw_hello_route(
        &self,
        terminal_id: &str,
        connection_epoch: i64,
        broker_server: &str,
        login: &str,
    ) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| {
                value == &format!("hello:{terminal_id}:{connection_epoch}:{broker_server}:{login}")
            })
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("server thread");
        }
    }
}

impl Drop for LoopbackBridgeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn serve_control(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    maintenance_released: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::SeqCst) {
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(accepted.expect("control accept").0),
            _ = sleep(Duration::from_millis(20)) => None,
        };
        let Some(stream) = accepted else {
            continue;
        };
        let request = read_http_request(stream).await;
        let body = if request.1.starts_with("POST /api/auth/bridge-refresh ") {
            r#"{"ok":true,"token":"access_fixture","refreshExpiresInSeconds":3600,"bridgeRole":"admin"}"#
        } else if request.1.starts_with("POST /api/auth/bridge-ticket ") {
            r#"{"ok":true,"ticket":"ticket_fixture","expiresInSeconds":30}"#
        } else if request
            .1
            .starts_with("POST /api/bridge/v3/maintenance-leases/lease_01JSTARTUP/release ")
        {
            maintenance_released.store(true, Ordering::SeqCst);
            r#"{"ok":true,"released":true,"lease_id":"lease_01JSTARTUP"}"#
        } else {
            panic!(
                "unexpected control request: {}",
                request.1.lines().next().unwrap_or("")
            );
        };
        write_http_json(request.0, body).await;
    }
}

fn prepare_verifying_update_state(path: &Path) {
    BridgeUpdateStateStore::new(path)
        .expect("update state store")
        .save(BridgeUpdateState {
            schema_version: 1,
            state: STATE_VERIFYING.to_owned(),
            target_version: Some("3.0.0".to_owned()),
            release_id: Some("release_3.0.0".to_owned()),
            priority: Some("normal".to_owned()),
            manual_activation_requested: false,
            staged_at_utc_msc: Some(now_utc_msc()),
            activation_started_at_utc_msc: Some(now_utc_msc()),
            minimum_idle_seconds: 120,
            activation_deadline_utc_msc: None,
            maintenance_lease_id: Some("lease_01JSTARTUP".to_owned()),
            maintenance_lease_expires_at_utc_msc: Some(now_utc_msc() + 90_000),
            next_retry_at_utc_msc: None,
            last_error_code: None,
            updated_at_utc_msc: 1,
        })
        .expect("save verifying update state");
}

struct RealtimeFixture {
    listener: TcpListener,
    disconnect_first: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    websocket_connections: Arc<AtomicUsize>,
    command_sent: Arc<AtomicBool>,
    message_types: Arc<Mutex<Vec<String>>>,
    send_commands: bool,
    command_override: Option<Value>,
    round_trip: Option<RoundTripCommand>,
}

async fn send_place_order(
    socket: &mut WebSocketStream<TcpStream>,
    terminal: &TerminalDescriptor,
    params: Value,
) {
    let now = now_utc_msc();
    socket
        .send(Message::Text(
            serde_json::json!({
                "v": 3,
                "type": "command",
                "message_id": "message_01JCONNECTED1",
                "sent_at_utc_msc": now,
                "command_id": CONNECTED_COMMAND_ID,
                "terminal_instance_id": terminal.terminal_instance_id,
                "account_ref": terminal.account_ref,
                "connection_epoch": terminal.connection_epoch,
                "issued_at_utc_msc": now,
                "deadline_utc_msc": now + 30_000,
                "action": "place_order",
                "params": params
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("place order command send");
}

async fn send_round_trip_completion(
    socket: &mut WebSocketStream<TcpStream>,
    terminal: &TerminalDescriptor,
    round_trip: &RoundTripCommand,
    expected_state: Value,
    command_id: &str,
    requested_volume: Option<f64>,
) {
    let now = now_utc_msc();
    let (action, params) = if round_trip.order_kind == "market" {
        (
            "close_position",
            serde_json::json!({
                "ticket": expected_state["ticket"],
                "symbol": expected_state["symbol"],
                "side": expected_state["direction"],
                "volume": requested_volume.unwrap_or_else(|| {
                    expected_state["volume"]
                        .as_f64()
                        .expect("round-trip expected volume")
                }),
                "magic": round_trip.magic,
                "expected_state": expected_state
            }),
        )
    } else {
        (
            "cancel_order",
            serde_json::json!({
                "ticket": expected_state["ticket"],
                "expected_state": expected_state
            }),
        )
    };
    socket
        .send(Message::Text(
            serde_json::json!({
                "v": 3,
                "type": "command",
                "message_id": format!("message_{command_id}"),
                "sent_at_utc_msc": now,
                "command_id": command_id,
                "terminal_instance_id": terminal.terminal_instance_id,
                "account_ref": terminal.account_ref,
                "connection_epoch": terminal.connection_epoch,
                "issued_at_utc_msc": now,
                "deadline_utc_msc": now + 30_000,
                "action": action,
                "params": params
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("round-trip close command send");
}

async fn send_pending_modify(
    socket: &mut WebSocketStream<TcpStream>,
    terminal: &TerminalDescriptor,
    round_trip: &RoundTripCommand,
    expected_state: &Value,
) {
    let now = now_utc_msc();
    socket
        .send(Message::Text(
            serde_json::json!({
                "v": 3,
                "type": "command",
                "message_id": "message_01JCONNECTED2",
                "sent_at_utc_msc": now,
                "command_id": ROUND_TRIP_CLOSE_COMMAND_ID,
                "terminal_instance_id": terminal.terminal_instance_id,
                "account_ref": terminal.account_ref,
                "connection_epoch": terminal.connection_epoch,
                "issued_at_utc_msc": now,
                "deadline_utc_msc": now + 30_000,
                "action": "modify_order",
                "params": {
                    "ticket": expected_state["ticket"],
                    "price": round_trip.modified_price.expect("pending modified price"),
                    "expected_state": expected_state
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("round-trip modify command send");
}

async fn send_position_modify(
    socket: &mut WebSocketStream<TcpStream>,
    terminal: &TerminalDescriptor,
    round_trip: &RoundTripCommand,
    expected_state: &Value,
    stop_loss: f64,
    take_profit: f64,
) {
    let now = now_utc_msc();
    socket
        .send(Message::Text(
            serde_json::json!({
                "v": 3,
                "type": "command",
                "message_id": "message_01JCONNECTED2",
                "sent_at_utc_msc": now,
                "command_id": ROUND_TRIP_CLOSE_COMMAND_ID,
                "terminal_instance_id": terminal.terminal_instance_id,
                "account_ref": terminal.account_ref,
                "connection_epoch": terminal.connection_epoch,
                "issued_at_utc_msc": now,
                "deadline_utc_msc": now + 30_000,
                "action": "modify_position",
                "params": {
                    "ticket": expected_state["ticket"],
                    "symbol": expected_state["symbol"],
                    "side": expected_state["direction"],
                    "volume": expected_state["volume"],
                    "magic": round_trip.magic,
                    "stop_loss": stop_loss,
                    "take_profit": take_profit,
                    "expected_state": expected_state
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("round-trip position modify command send");
}

async fn serve_realtime_dispatch(fixture: RealtimeFixture, concurrent_read_only: bool) {
    if concurrent_read_only {
        serve_realtime_read_only_multi(fixture).await;
    } else {
        serve_realtime(fixture).await;
    }
}

async fn serve_realtime_read_only_multi(fixture: RealtimeFixture) {
    let RealtimeFixture {
        listener,
        stop,
        websocket_connections,
        message_types,
        ..
    } = fixture;
    let mut tasks = tokio::task::JoinSet::new();
    while !stop.load(Ordering::SeqCst) {
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(accepted.expect("multi realtime accept").0),
            _ = sleep(Duration::from_millis(20)) => None,
        };
        let Some(stream) = accepted else {
            continue;
        };
        let sequence = websocket_connections.fetch_add(1, Ordering::SeqCst) + 1;
        tasks.spawn(serve_realtime_read_only_connection(
            stream,
            sequence,
            Arc::clone(&stop),
            Arc::clone(&message_types),
        ));
    }
    while let Some(result) = tasks.join_next().await {
        result.expect("multi realtime connection task");
    }
}

#[allow(clippy::result_large_err)]
async fn serve_realtime_read_only_connection(
    stream: TcpStream,
    sequence: usize,
    stop: Arc<AtomicBool>,
    message_types: Arc<Mutex<Vec<String>>>,
) {
    let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
        assert_eq!(request.uri().path(), "/aurum-api/bridge/v3/ws");
        Ok(response)
    })
    .await
    .expect("multi websocket handshake");
    let hello_json = socket
        .next()
        .await
        .expect("multi hello message")
        .expect("multi hello frame")
        .into_text()
        .expect("multi hello text");
    let hello: HelloMessage = serde_json::from_str(&hello_json).expect("multi hello json");
    hello.validate().expect("valid multi hello");
    for terminal in &hello.terminals {
        message_types.lock().expect("message types").push(format!(
            "hello:{}:{}:{}:{}",
            terminal.terminal_instance_id,
            terminal.connection_epoch,
            terminal.account_ref.broker_server,
            terminal.account_ref.login
        ));
    }
    let terminal_ids = hello
        .terminals
        .iter()
        .map(|terminal| terminal.terminal_instance_id.clone())
        .collect::<Vec<_>>();
    socket
        .send(Message::Text(
            serde_json::to_string(&HelloAcknowledgement {
                v: 3,
                message_type: "hello_ack".to_owned(),
                message_id: format!("hello_ack_multi_{sequence}"),
                sent_at_utc_msc: now_utc_msc(),
                acked_message_id: hello.message_id,
                session_id: hello.session_id,
                accepted_terminal_instance_ids: terminal_ids,
            })
            .expect("multi ack json")
            .into(),
        ))
        .await
        .expect("multi ack send");

    let mut acknowledgement_sequence = 0_u64;
    while !stop.load(Ordering::SeqCst) {
        let received = timeout(Duration::from_millis(20), socket.next()).await;
        if matches!(received, Ok(None)) {
            return;
        }
        let Ok(Some(frame)) = received else {
            continue;
        };
        let Ok(frame) = frame else {
            return;
        };
        let Ok(text) = frame.into_text() else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(message_type) = payload["type"].as_str() else {
            continue;
        };
        if message_type == "data_delta" {
            let stream = payload["stream"].as_str().expect("multi data stream");
            message_types.lock().expect("message types").push(format!(
                "data_delta:{}:{}",
                payload["terminal_instance_id"]
                    .as_str()
                    .unwrap_or("missing"),
                if payload["full_snapshot"].as_bool().unwrap_or(false) {
                    "full"
                } else {
                    "delta"
                }
            ));
            acknowledgement_sequence += 1;
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "v": 3,
                        "type": "data_ack",
                        "message_id": format!("data_ack_multi_{sequence}_{acknowledgement_sequence}"),
                        "sent_at_utc_msc": now_utc_msc(),
                        "acked_message_id": payload["message_id"],
                        "terminal_instance_id": payload["terminal_instance_id"],
                        "connection_epoch": payload["connection_epoch"],
                        "stream": stream,
                        "revision": payload["revision"],
                        "status": "applied"
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("multi data acknowledgement send");
        } else {
            message_types
                .lock()
                .expect("message types")
                .push(message_type.to_owned());
        }
    }
    let _ = socket.close(None).await;
}

#[allow(clippy::result_large_err)]
async fn serve_realtime(fixture: RealtimeFixture) {
    let RealtimeFixture {
        listener,
        disconnect_first,
        stop,
        websocket_connections,
        command_sent,
        message_types,
        send_commands,
        command_override,
        round_trip,
    } = fixture;
    let mut round_trip = round_trip;
    while !stop.load(Ordering::SeqCst) {
        let accepted = tokio::select! {
            accepted = listener.accept() => Some(accepted.expect("realtime accept").0),
            _ = sleep(Duration::from_millis(20)) => None,
        };
        let Some(stream) = accepted else {
            continue;
        };
        let sequence = websocket_connections.load(Ordering::SeqCst) + 1;
        let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
            assert_eq!(
                request.uri().path(),
                "/aurum-api/bridge/v3/ws",
                "websocket path"
            );
            Ok(response)
        })
        .await
        .expect("websocket handshake");
        let hello_json = socket
            .next()
            .await
            .expect("hello message")
            .expect("hello frame")
            .into_text()
            .expect("hello text");
        let hello: HelloMessage = serde_json::from_str(&hello_json).expect("hello json");
        hello.validate().expect("valid hello");
        for terminal in &hello.terminals {
            message_types.lock().expect("message types").push(format!(
                "hello:{}:{}:{}:{}",
                terminal.terminal_instance_id,
                terminal.connection_epoch,
                terminal.account_ref.broker_server,
                terminal.account_ref.login
            ));
        }
        let terminal_ids = hello
            .terminals
            .iter()
            .map(|terminal| terminal.terminal_instance_id.clone())
            .collect::<Vec<_>>();
        socket
            .send(Message::Text(
                serde_json::to_string(&HelloAcknowledgement {
                    v: 3,
                    message_type: "hello_ack".to_owned(),
                    message_id: format!("hello_ack_connected_{sequence}"),
                    sent_at_utc_msc: now_utc_msc(),
                    acked_message_id: hello.message_id,
                    session_id: hello.session_id,
                    accepted_terminal_instance_ids: terminal_ids,
                })
                .expect("ack json")
                .into(),
            ))
            .await
            .expect("ack send");
        websocket_connections.fetch_add(1, Ordering::SeqCst);
        let terminal = hello
            .terminals
            .first()
            .expect("terminal descriptor")
            .clone();
        let mut acknowledged_initial_streams = BTreeSet::new();
        let mut acknowledgement_sequence = 0_u64;
        let mut history_requested = false;
        let mut history_retry_sequence = 0_u32;
        let mut round_trip_open_succeeded = false;
        let mut round_trip_close_sent = false;
        let mut round_trip_final_sent = false;
        let mut round_trip_partial_succeeded = false;
        let mut round_trip_cleanup_sent = false;
        let mut completion_expected_state = None;

        loop {
            if stop.load(Ordering::SeqCst)
                || sequence == 1 && disconnect_first.load(Ordering::SeqCst)
            {
                let _ = socket.close(None).await;
                break;
            }
            let received = timeout(Duration::from_millis(20), socket.next()).await;
            if matches!(received, Ok(None)) {
                break;
            }
            if let Ok(Some(frame)) = received {
                let Ok(frame) = frame else {
                    break;
                };
                if let Ok(text) = frame.into_text()
                    && let Ok(payload) = serde_json::from_str::<Value>(&text)
                    && let Some(message_type) = payload["type"].as_str()
                {
                    let summary = if message_type == "data_delta" {
                        format!(
                            "data_delta:{}:{}",
                            payload["terminal_instance_id"]
                                .as_str()
                                .unwrap_or("missing"),
                            if payload["full_snapshot"].as_bool().unwrap_or(false) {
                                "full"
                            } else {
                                "delta"
                            }
                        )
                    } else if message_type == "data_response" {
                        format!(
                            "data_response:{}:{}",
                            payload["action"].as_str().unwrap_or("missing"),
                            payload["status"].as_str().unwrap_or("missing")
                        )
                    } else {
                        if message_type == "command_result" {
                            format!(
                                "command_result:{}:{}",
                                payload["status"].as_str().unwrap_or("missing"),
                                payload["evidence"]["broker_retcode"]
                                    .as_i64()
                                    .map(|value| value.to_string())
                                    .unwrap_or_else(|| "missing".to_owned())
                            )
                        } else {
                            message_type.to_owned()
                        }
                    };
                    message_types.lock().expect("message types").push(summary);
                    if message_type == "data_response"
                        && payload["action"] == "symbol_snapshot"
                        && payload["status"] == "succeeded"
                        && terminal.platform == "mt4"
                        && let Some(command) = round_trip.as_mut()
                        && command.order_kind != "market"
                        && command.price.is_none()
                        && !command_sent.swap(true, Ordering::SeqCst)
                    {
                        let instrument = &payload["payload"]["instrument"];
                        let bid = instrument["margin_reference_price_sell"]
                            .as_f64()
                            .filter(|value| value.is_finite() && *value > 0.0)
                            .expect("MT4 pending bid");
                        let point = instrument["point"]
                            .as_f64()
                            .filter(|value| value.is_finite() && *value > 0.0)
                            .expect("MT4 pending point");
                        let tick_size = instrument["tick_size"]
                            .as_f64()
                            .filter(|value| value.is_finite() && *value > 0.0)
                            .unwrap_or(point);
                        let minimum_points = instrument["trade_stops_level"]
                            .as_i64()
                            .unwrap_or(0)
                            .max(instrument["trade_freeze_level"].as_i64().unwrap_or(0))
                            .max(100) as f64;
                        let distance = (point * minimum_points).max(tick_size * 10.0);
                        let digits = instrument["digits"].as_i64().unwrap_or(2).clamp(0, 8) as i32;
                        let factor = 10_f64.powi(digits);
                        let normalize = |value: f64| {
                            (((value / tick_size).round() * tick_size) * factor).round() / factor
                        };
                        command.price = Some(normalize(bid - distance * 2.0));
                        command.modified_price = Some(normalize(bid - distance * 3.0));
                        send_place_order(&mut socket, &terminal, round_trip_params(command)).await;
                    }
                    if message_type == "data_response"
                        && payload["action"] == "history"
                        && payload["status"] == "succeeded"
                    {
                        let history = &payload["payload"];
                        let history_complete = history["history_sync"]["complete"]
                            .as_bool()
                            .unwrap_or(false);
                        message_types.lock().expect("message types").push(format!(
                            "history_payload:{}:{}:{}:{}:{}",
                            history["source"].as_str().unwrap_or("missing"),
                            history["pagination"]["total_count"].as_u64().unwrap_or(0),
                            history["orders"].as_array().map_or(0, Vec::len),
                            history["pagination"]["page_size"].as_u64().unwrap_or(0),
                            history_complete
                        ));
                        if !send_commands && !history_complete && history_retry_sequence < 400 {
                            history_retry_sequence += 1;
                            tokio::time::sleep(Duration::from_millis(250)).await;
                            if socket
                                .send(Message::Text(
                                    serde_json::json!({
                                        "v": 3,
                                        "type": "data_request",
                                        "message_id": format!("message_01JHISTRETRY{history_retry_sequence:04}"),
                                        "sent_at_utc_msc": now_utc_msc(),
                                        "request_id": format!("data_01JHISTRETRY{history_retry_sequence:04}"),
                                        "terminal_instance_id": terminal.terminal_instance_id,
                                        "account_ref": terminal.account_ref,
                                        "connection_epoch": terminal.connection_epoch,
                                        "action": "history",
                                        "params": {
                                            "page": 1,
                                            "page_size": 20,
                                            "include_deals": true
                                        }
                                    })
                                    .to_string()
                                    .into(),
                                ))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                    if message_type == "command_result" {
                        message_types.lock().expect("message types").push(format!(
                            "command_result_id:{}:{}",
                            payload["command_id"].as_str().unwrap_or("missing"),
                            payload["status"].as_str().unwrap_or("missing")
                        ));
                        message_types.lock().expect("message types").push(format!(
                            "command_result_error:{}:{}:{}",
                            payload["command_id"].as_str().unwrap_or("missing"),
                            payload["status"].as_str().unwrap_or("missing"),
                            payload["error_code"].as_str().unwrap_or("none")
                        ));
                    }

                    if message_type == "data_delta" {
                        let full_snapshot = payload["full_snapshot"].as_bool() == Some(true);
                        acknowledgement_sequence += 1;
                        let stream = payload["stream"].as_str().expect("data stream");
                        socket
                            .send(Message::Text(
                                serde_json::json!({
                                    "v": 3,
                                    "type": "data_ack",
                                    "message_id": format!("data_ack_connected_{sequence}_{acknowledgement_sequence}"),
                                    "sent_at_utc_msc": now_utc_msc(),
                                    "acked_message_id": payload["message_id"],
                                    "terminal_instance_id": payload["terminal_instance_id"],
                                    "connection_epoch": payload["connection_epoch"],
                                    "stream": stream,
                                    "revision": payload["revision"],
                                    "status": "applied"
                                })
                                .to_string()
                                .into(),
                            ))
                            .await
                            .expect("data acknowledgement send");
                        if !full_snapshot {
                            if round_trip_partial_succeeded
                                && !round_trip_cleanup_sent
                                && stream == "positions"
                                && let Some(round_trip) = round_trip.as_ref()
                                && round_trip.partial_close_volume.is_some()
                                && let Some(position) =
                                    payload["upserts"].as_array().and_then(|positions| {
                                        positions.iter().find(|position| {
                                            position["magic"].as_i64() == Some(round_trip.magic)
                                        })
                                    })
                            {
                                let ticket = position["ticket"]
                                    .as_u64()
                                    .map(|value| value.to_string())
                                    .or_else(|| position["ticket"].as_str().map(str::to_owned))
                                    .expect("round-trip remaining position ticket");
                                let direction =
                                    match (position["type"].as_i64(), position["type"].as_str()) {
                                        (Some(0 | 2 | 4 | 6), _) => "buy",
                                        (Some(1 | 3 | 5 | 7), _) => "sell",
                                        (_, Some(value)) if value.starts_with("buy") => "buy",
                                        (_, Some(value)) if value.starts_with("sell") => "sell",
                                        _ => panic!("round-trip remaining position direction"),
                                    };
                                let symbol = position["symbol"]
                                    .as_str()
                                    .filter(|value| !value.is_empty())
                                    .expect("round-trip remaining position symbol");
                                let volume = position["volume"]
                                    .as_f64()
                                    .or_else(|| position["volume_current"].as_f64())
                                    .filter(|value| value.is_finite() && *value > 0.0)
                                    .expect("round-trip remaining position volume");
                                let expected_remaining_volume = round_trip.volume
                                    - round_trip
                                        .partial_close_volume
                                        .expect("round-trip partial close volume");
                                assert!(
                                    (volume - expected_remaining_volume).abs() < 1e-9,
                                    "round-trip remaining position volume"
                                );
                                let expected_state = serde_json::json!({
                                    "ticket": ticket,
                                    "symbol": symbol,
                                    "direction": direction,
                                    "magic": round_trip.magic,
                                    "volume": volume,
                                    "broker_server_key": terminal.account_ref.broker_server,
                                    "login_account": terminal.account_ref.login,
                                    "stop_loss": position["sl"].as_f64()
                                        .or_else(|| position["stop_loss"].as_f64()).unwrap_or(0.0),
                                    "take_profit": position["tp"].as_f64()
                                        .or_else(|| position["take_profit"].as_f64()).unwrap_or(0.0)
                                });
                                send_round_trip_completion(
                                    &mut socket,
                                    &terminal,
                                    round_trip,
                                    expected_state,
                                    ROUND_TRIP_FINAL_COMMAND_ID,
                                    None,
                                )
                                .await;
                                round_trip_cleanup_sent = true;
                            }
                            if (terminal.platform == "mt5"
                                || round_trip.as_ref().is_some_and(|command| {
                                    command.protection_distance.is_some()
                                        || command.order_kind != "market"
                                }))
                                && round_trip_open_succeeded
                                && !round_trip_close_sent
                                && let Some(round_trip) = round_trip.as_ref()
                                && stream
                                    == if round_trip.order_kind == "market" {
                                        "positions"
                                    } else {
                                        "orders"
                                    }
                                && let Some(position) =
                                    payload["upserts"].as_array().and_then(|positions| {
                                        positions.iter().find(|position| {
                                            position["magic"].as_i64() == Some(round_trip.magic)
                                        })
                                    })
                            {
                                let ticket = position["ticket"]
                                    .as_u64()
                                    .map(|value| value.to_string())
                                    .or_else(|| position["ticket"].as_str().map(str::to_owned))
                                    .expect("MT5 round-trip position ticket");
                                let direction =
                                    match (position["type"].as_i64(), position["type"].as_str()) {
                                        (Some(0 | 2 | 4 | 6), _) => "buy",
                                        (Some(1 | 3 | 5 | 7), _) => "sell",
                                        (_, Some(value)) if value.starts_with("buy") => "buy",
                                        (_, Some(value)) if value.starts_with("sell") => "sell",
                                        _ => panic!("MT5 round-trip target direction"),
                                    };
                                let symbol = position["symbol"]
                                    .as_str()
                                    .filter(|value| !value.is_empty())
                                    .expect("MT5 round-trip position symbol");
                                let volume = position["volume"]
                                    .as_f64()
                                    .or_else(|| position["volume_current"].as_f64())
                                    .or_else(|| position["volume_initial"].as_f64())
                                    .filter(|value| value.is_finite() && *value > 0.0)
                                    .expect("MT5 round-trip position volume");
                                let mut expected_state = serde_json::json!({
                                    "ticket": ticket,
                                    "symbol": symbol,
                                    "direction": direction,
                                    "magic": round_trip.magic,
                                    "volume": volume,
                                    "broker_server_key": terminal.account_ref.broker_server,
                                    "login_account": terminal.account_ref.login,
                                    "stop_loss": position["sl"].as_f64()
                                        .or_else(|| position["stop_loss"].as_f64()).unwrap_or(0.0),
                                    "take_profit": position["tp"].as_f64()
                                        .or_else(|| position["take_profit"].as_f64()).unwrap_or(0.0)
                                });
                                if round_trip.order_kind == "market" {
                                    let protection = match (
                                        round_trip.stop_loss,
                                        round_trip.take_profit,
                                        round_trip.protection_distance,
                                    ) {
                                        (Some(stop_loss), Some(take_profit), _) => {
                                            Some((stop_loss, take_profit))
                                        }
                                        (_, _, Some(distance)) => {
                                            let price = position["price_current"]
                                                .as_f64()
                                                .or_else(|| position["price_open"].as_f64())
                                                .filter(|price| {
                                                    price.is_finite() && *price > distance
                                                })
                                                .expect("MT4 round-trip position price");
                                            Some(if direction == "buy" {
                                                (price - distance, price + distance)
                                            } else {
                                                (price + distance, price - distance)
                                            })
                                        }
                                        _ => None,
                                    };
                                    if let Some((stop_loss, take_profit)) = protection {
                                        send_position_modify(
                                            &mut socket,
                                            &terminal,
                                            round_trip,
                                            &expected_state,
                                            stop_loss,
                                            take_profit,
                                        )
                                        .await;
                                        expected_state["stop_loss"] = serde_json::json!(stop_loss);
                                        expected_state["take_profit"] =
                                            serde_json::json!(take_profit);
                                        completion_expected_state = Some(expected_state);
                                    } else {
                                        send_round_trip_completion(
                                            &mut socket,
                                            &terminal,
                                            round_trip,
                                            expected_state,
                                            ROUND_TRIP_CLOSE_COMMAND_ID,
                                            None,
                                        )
                                        .await;
                                    }
                                } else {
                                    send_pending_modify(
                                        &mut socket,
                                        &terminal,
                                        round_trip,
                                        &expected_state,
                                    )
                                    .await;
                                    completion_expected_state = Some(expected_state);
                                }
                                round_trip_close_sent = true;
                            }
                            continue;
                        }
                        acknowledged_initial_streams.insert(stream.to_owned());
                        let initial_ready = ["account", "positions", "orders"]
                            .into_iter()
                            .all(|required| acknowledged_initial_streams.contains(required));
                        if initial_ready && !history_requested {
                            history_requested = true;
                            let now = now_utc_msc();
                            socket
                                .send(Message::Text(
                                    serde_json::json!({
                                        "v": 3,
                                        "type": "data_request",
                                        "message_id": "message_01JHISTORY01",
                                        "sent_at_utc_msc": now,
                                        "request_id": "data_01JHISTORYREQ1",
                                        "terminal_instance_id": terminal.terminal_instance_id,
                                        "account_ref": terminal.account_ref,
                                        "connection_epoch": terminal.connection_epoch,
                                        "action": "history",
                                        "params": { "page": 1, "page_size": 20, "include_deals": true }
                                    })
                                    .to_string()
                                    .into(),
                                ))
                                .await
                                .expect("history request send");
                            for (request_id, message_id, action, params) in [
                                (
                                    "data_01JCHARTREQ01",
                                    "message_01JCHARTREQ1",
                                    "chart_data",
                                    serde_json::json!({ "force_refresh": true }),
                                ),
                                (
                                    "data_01JRATESREQ01",
                                    "message_01JRATES001",
                                    "rates",
                                    serde_json::json!({
                                        "symbol": "XAUUSD",
                                        "timeframe": "M5",
                                        "count": 20
                                    }),
                                ),
                                (
                                    "data_01JSYMBOLREQ1",
                                    "message_01JSYMBOLS01",
                                    "symbols",
                                    serde_json::json!({}),
                                ),
                                (
                                    "data_01JSYMSNAP01",
                                    "message_01JSYMSNAP01",
                                    "symbol_snapshot",
                                    serde_json::json!({ "symbol": "XAUUSD" }),
                                ),
                                (
                                    "data_01JRISKREQ001",
                                    "message_01JRISKREQ01",
                                    "risk_snapshot",
                                    serde_json::json!({
                                        "symbol": "XAUUSD", "last_deal_time_msc": 0,
                                        "last_deal_ticket": 0, "baseline_from_utc_msc": now
                                    }),
                                ),
                                (
                                    "data_01JPERFREQ001",
                                    "message_01JPERFREQ01",
                                    "performance_daily",
                                    serde_json::json!({
                                        "date_from": "2026-07-01", "date_to": "2026-07-29"
                                    }),
                                ),
                                (
                                    "data_01JPENDREQ001",
                                    "message_01JPENDREQ01",
                                    "pending_order_state",
                                    serde_json::json!({ "ticket": "999999" }),
                                ),
                                (
                                    "data_01JDIAGREQ001",
                                    "message_01JDIAGREQ01",
                                    "diagnostics",
                                    serde_json::json!({}),
                                ),
                            ] {
                                socket
                                    .send(Message::Text(
                                        serde_json::json!({
                                            "v": 3,
                                            "type": "data_request",
                                            "message_id": message_id,
                                            "sent_at_utc_msc": now,
                                            "request_id": request_id,
                                            "terminal_instance_id": terminal.terminal_instance_id,
                                            "account_ref": terminal.account_ref,
                                            "connection_epoch": terminal.connection_epoch,
                                            "action": action,
                                            "params": params
                                        })
                                        .to_string()
                                        .into(),
                                    ))
                                    .await
                                    .expect("market data request send");
                            }
                        }
                        if initial_ready
                            && (send_commands || command_override.is_some())
                            && !round_trip.as_ref().is_some_and(|command| {
                                terminal.platform == "mt4"
                                    && command.order_kind != "market"
                                    && command.price.is_none()
                            })
                            && !command_sent.swap(true, Ordering::SeqCst)
                        {
                            let command_params = command_override.clone().unwrap_or_else(|| {
                                serde_json::json!({
                                    "symbol": "XAUUSD",
                                    "side": "buy",
                                    "volume": 0.01
                                })
                            });
                            send_place_order(&mut socket, &terminal, command_params).await;
                        }
                    } else if message_type == "command_result" {
                        acknowledgement_sequence += 1;
                        socket
                            .send(Message::Text(
                                serde_json::json!({
                                    "v": 3,
                                    "type": "command_result_ack",
                                    "message_id": format!("result_ack_connected_{sequence}_{acknowledgement_sequence}"),
                                    "sent_at_utc_msc": now_utc_msc(),
                                    "acked_message_id": payload["message_id"],
                                    "command_id": payload["command_id"],
                                    "terminal_instance_id": payload["terminal_instance_id"],
                                    "account_ref": payload["account_ref"],
                                    "connection_epoch": payload["connection_epoch"],
                                    "status": "applied"
                                })
                                .to_string()
                                .into(),
                            ))
                            .await
                            .expect("command result acknowledgement send");
                        if payload["command_id"] == CONNECTED_COMMAND_ID
                            && payload["status"] == "succeeded"
                            && let Some(round_trip) = round_trip.as_ref()
                        {
                            round_trip_open_succeeded = true;
                            if terminal.platform != "mt4"
                                || round_trip_close_sent
                                || round_trip.protection_distance.is_some()
                                || round_trip.order_kind != "market"
                            {
                                continue;
                            }
                            let ticket = payload["evidence"]["order_tickets"]
                                .as_array()
                                .and_then(|tickets| tickets.first())
                                .and_then(|ticket| {
                                    ticket
                                        .as_str()
                                        .map(str::to_owned)
                                        .or_else(|| ticket.as_i64().map(|value| value.to_string()))
                                })
                                .expect("round-trip open ticket");
                            let expected_state = serde_json::json!({
                                "ticket": ticket,
                                "symbol": round_trip.symbol,
                                "direction": round_trip.side,
                                "volume": round_trip.volume,
                                "magic": round_trip.magic,
                                "broker_server_key": terminal.account_ref.broker_server,
                                "login_account": terminal.account_ref.login
                            });
                            send_round_trip_completion(
                                &mut socket,
                                &terminal,
                                round_trip,
                                expected_state,
                                ROUND_TRIP_CLOSE_COMMAND_ID,
                                None,
                            )
                            .await;
                            round_trip_close_sent = true;
                        }
                        if payload["command_id"] == ROUND_TRIP_CLOSE_COMMAND_ID
                            && payload["status"] == "succeeded"
                            && !round_trip_final_sent
                            && let Some(round_trip) = round_trip.as_ref()
                            && (round_trip.order_kind != "market"
                                || round_trip.stop_loss.is_some()
                                || round_trip.protection_distance.is_some())
                            && let Some(expected_state) = completion_expected_state.take()
                        {
                            send_round_trip_completion(
                                &mut socket,
                                &terminal,
                                round_trip,
                                expected_state,
                                ROUND_TRIP_CANCEL_COMMAND_ID,
                                round_trip.partial_close_volume,
                            )
                            .await;
                            round_trip_final_sent = true;
                        }
                        if payload["command_id"] == ROUND_TRIP_CANCEL_COMMAND_ID
                            && payload["status"] == "succeeded"
                            && round_trip
                                .as_ref()
                                .is_some_and(|command| command.partial_close_volume.is_some())
                        {
                            round_trip_partial_succeeded = true;
                        }
                    }
                }
            }
        }
    }
}

fn command_is_acked(database_path: &Path) -> bool {
    command_is_acked_by_id(database_path, "command_01JCONNECTED1")
}

fn command_is_acked_by_id(database_path: &Path, command_id: &str) -> bool {
    OutboxStore::open_existing(database_path)
        .ok()
        .and_then(|store| store.command_ledger(command_id).ok())
        .flatten()
        .is_some_and(|record| record.status == "acked")
}

async fn read_http_request(mut stream: TcpStream) -> (TcpStream, String) {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 2048];
    let mut expected_length = None;
    loop {
        let read = stream.read(&mut buffer).await.expect("http read");
        assert!(read > 0, "request closed before body completed");
        bytes.extend_from_slice(&buffer[..read]);
        assert!(bytes.len() <= 64 * 1024, "request unexpectedly large");
        if expected_length.is_none()
            && let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
        {
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            expected_length = Some(header_end + 4 + content_length);
        }
        if expected_length.is_some_and(|length| bytes.len() >= length) {
            break;
        }
    }
    (stream, String::from_utf8(bytes).expect("utf8 request"))
}

async fn write_http_json(mut stream: TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .expect("http response");
    stream.shutdown().await.expect("http shutdown");
}

fn prepare_application(root: &Path) -> PathBuf {
    let application = root.join("application");
    let python_directory = application.join("runtime/python");
    let worker_directory = application.join("modules/adapter.mt5.python");
    fs::create_dir_all(&python_directory).expect("python directory");
    fs::create_dir_all(&worker_directory).expect("worker directory");
    fs::copy(
        env!("CARGO_BIN_EXE_liangjian-bridge-core"),
        application.join("liangjian-bridge-core.exe"),
    )
    .expect("copy core");

    let python = locate_python();
    fs::copy(&python, python_directory.join("python.exe")).expect("copy python launcher");
    let python_runtime = Command::new(&python)
        .args([
            "-c",
            "import sys; print(sys.base_prefix); print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ])
        .output()
        .expect("python runtime metadata");
    assert!(python_runtime.status.success(), "python metadata failed");
    let python_runtime = String::from_utf8(python_runtime.stdout).expect("python metadata utf8");
    let mut python_runtime = python_runtime.lines();
    let base_prefix = python_runtime.next().expect("base prefix");
    let python_version = python_runtime.next().expect("python version");
    fs::write(
        python_directory.join("pyvenv.cfg"),
        format!(
            "home = {base_prefix}\ninclude-system-site-packages = false\nversion = {python_version}\n"
        ),
    )
    .expect("python venv config");

    let native_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("native root");
    let source_worker_directory = native_root.join("workers/mt5");
    fs::copy(
        source_worker_directory.join("worker.py"),
        worker_directory.join("runtime_worker.py"),
    )
    .expect("copy runtime worker");
    fs::copy(
        source_worker_directory.join("trade.py"),
        worker_directory.join("trade.py"),
    )
    .expect("copy trade worker module");
    let fake_entry = fs::read_to_string(source_worker_directory.join("fake_worker_entry.py"))
        .expect("fake worker entry")
        .replace(
            "from __future__ import annotations",
            "from __future__ import annotations\n\nimport os\nfrom pathlib import Path\nPath(os.environ['AURUM_TEST_WORKER_PID_FILE']).write_text(str(os.getpid()), encoding='ascii')",
        )
        .replace("from worker import run", "from runtime_worker import run");
    fs::write(worker_directory.join("worker.py"), fake_entry).expect("write fake entry");
    application
}

fn prepare_live_mt5_application(root: &Path, python_runtime: &Path) -> PathBuf {
    let application = root.join("application");
    let python_directory = application.join("runtime/python");
    let worker_directory = application.join("modules/adapter.mt5.python");
    copy_directory(python_runtime, &python_directory);
    fs::create_dir_all(&worker_directory).expect("live MT5 worker directory");
    fs::copy(
        env!("CARGO_BIN_EXE_liangjian-bridge-core"),
        application.join("liangjian-bridge-core.exe"),
    )
    .expect("copy live MT5 core");
    let native_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("native root");
    let source_worker_directory = native_root.join("workers/mt5");
    for file in ["worker.py", "trade.py"] {
        fs::copy(
            source_worker_directory.join(file),
            worker_directory.join(file),
        )
        .expect("copy live MT5 worker module");
    }
    application
}

fn copy_directory(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("copy directory destination");
    for entry in fs::read_dir(source).expect("copy directory source") {
        let entry = entry.expect("copy directory entry");
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .expect("copy directory file type")
            .is_dir()
        {
            copy_directory(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copy directory file");
        }
    }
}

fn mt5_terminal_instance_id(terminal_path: &Path) -> String {
    let normalized = std::path::absolute(terminal_path)
        .expect("absolute MT5 terminal path")
        .to_string_lossy()
        .to_uppercase();
    let digest = Sha256::digest(normalized.as_bytes());
    format!("mt5_{:x}", digest)[..28].to_owned()
}

fn mt5_active_trade_snapshot(python_runtime: &Path, terminal_path: &Path) -> Value {
    let script = r#"
import json
import sys
import MetaTrader5 as mt5

if not mt5.initialize(path=sys.argv[1], timeout=10000, portable=False):
    raise SystemExit("mt5_initialize_failed")
try:
    account = mt5.account_info()
    positions = mt5.positions_get()
    orders = mt5.orders_get()
    if account is None or positions is None or orders is None:
        raise SystemExit("mt5_state_unavailable")
    print(json.dumps({
        "server": str(account.server),
        "login": str(account.login),
        "positions": sorted(str(item.ticket) for item in positions),
        "orders": sorted(str(item.ticket) for item in orders),
    }, separators=(",", ":")))
finally:
    mt5.shutdown()
"#;
    let output = Command::new(python_runtime.join("python.exe"))
        .args(["-B", "-c", script])
        .arg(terminal_path)
        .output()
        .expect("read live MT5 state");
    assert!(
        output.status.success(),
        "live MT5 state failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("live MT5 state json")
}

fn mt5_buy_limit_prices(
    python_runtime: &Path,
    terminal_path: &Path,
    requested_symbol: &str,
) -> (f64, f64) {
    let script = r#"
import sys
import MetaTrader5 as mt5

if not mt5.initialize(path=sys.argv[1], timeout=10000, portable=False):
    raise SystemExit("mt5_initialize_failed")
try:
    requested = sys.argv[2].upper()
    symbols = mt5.symbols_get(group=f"*{requested}*") or ()
    names = [str(item.name) for item in symbols]
    exact = next((name for name in names if name.upper() == requested), None)
    symbol = exact or min(
        (name for name in names if name.upper().startswith(requested)),
        key=lambda name: (len(name), name),
        default=None,
    )
    if symbol is None or not mt5.symbol_select(symbol, True):
        raise SystemExit("mt5_symbol_unavailable")
    info, tick = mt5.symbol_info(symbol), mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise SystemExit("mt5_quote_unavailable")
    point = float(getattr(info, "point", 0) or 0)
    tick_size = float(getattr(info, "trade_tick_size", 0) or point or 1e-8)
    minimum_points = max(
        int(getattr(info, "trade_stops_level", 0) or 0),
        int(getattr(info, "trade_freeze_level", 0) or 0),
        100,
    )
    distance = max(point * minimum_points, tick_size * 10)
    digits = max(0, int(getattr(info, "digits", 0) or 0))
    price = round(round((float(tick.bid) - distance * 2) / tick_size) * tick_size, digits)
    changed = round(round((price - distance) / tick_size) * tick_size, digits)
    print(price)
    print(changed)
finally:
    mt5.shutdown()
"#;
    let output = Command::new(python_runtime.join("python.exe"))
        .args(["-B", "-c", script])
        .arg(terminal_path)
        .arg(requested_symbol)
        .output()
        .expect("calculate live MT5 pending price");
    assert!(
        output.status.success(),
        "live MT5 pending price failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("live MT5 pending price utf8");
    let mut prices = stdout
        .lines()
        .map(|value| value.parse::<f64>().expect("live MT5 pending price value"));
    let pending = prices.next().expect("live MT5 pending price");
    let modified = prices.next().expect("live MT5 modified price");
    assert!(prices.next().is_none(), "unexpected live MT5 price output");
    (pending, modified)
}

fn mt5_buy_protection_prices(
    python_runtime: &Path,
    terminal_path: &Path,
    requested_symbol: &str,
) -> (f64, f64) {
    let script = r#"
import sys
import MetaTrader5 as mt5

if not mt5.initialize(path=sys.argv[1], timeout=10000, portable=False):
    raise SystemExit("mt5_initialize_failed")
try:
    requested = sys.argv[2].upper()
    symbols = mt5.symbols_get(group=f"*{requested}*") or ()
    names = [str(item.name) for item in symbols]
    exact = next((name for name in names if name.upper() == requested), None)
    symbol = exact or min(
        (name for name in names if name.upper().startswith(requested)),
        key=lambda name: (len(name), name),
        default=None,
    )
    if symbol is None or not mt5.symbol_select(symbol, True):
        raise SystemExit("mt5_symbol_unavailable")
    info, tick = mt5.symbol_info(symbol), mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise SystemExit("mt5_quote_unavailable")
    point = float(getattr(info, "point", 0) or 0)
    tick_size = float(getattr(info, "trade_tick_size", 0) or point or 1e-8)
    minimum_points = max(
        int(getattr(info, "trade_stops_level", 0) or 0),
        int(getattr(info, "trade_freeze_level", 0) or 0),
        100,
    )
    distance = max(point * minimum_points, tick_size * 10) * 3
    digits = max(0, int(getattr(info, "digits", 0) or 0))
    stop_loss = round(round((float(tick.bid) - distance) / tick_size) * tick_size, digits)
    take_profit = round(round((float(tick.ask) + distance) / tick_size) * tick_size, digits)
    print(stop_loss)
    print(take_profit)
finally:
    mt5.shutdown()
"#;
    let output = Command::new(python_runtime.join("python.exe"))
        .args(["-B", "-c", script])
        .arg(terminal_path)
        .arg(requested_symbol)
        .output()
        .expect("calculate live MT5 protection prices");
    assert!(
        output.status.success(),
        "live MT5 protection prices failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("live MT5 protection prices utf8");
    let mut prices = stdout.lines().map(|value| {
        value
            .parse::<f64>()
            .expect("live MT5 protection price value")
    });
    let stop_loss = prices.next().expect("live MT5 stop loss");
    let take_profit = prices.next().expect("live MT5 take profit");
    assert!(prices.next().is_none(), "unexpected live MT5 price output");
    (stop_loss, take_profit)
}

fn locate_python() -> PathBuf {
    let output = Command::new("where.exe")
        .arg("python.exe")
        .output()
        .expect("locate python");
    assert!(output.status.success(), "python is required");
    String::from_utf8(output.stdout)
        .expect("python path utf8")
        .lines()
        .next()
        .map(PathBuf::from)
        .expect("python path")
}

fn prepare_profile(
    root: &Path,
    profile_id: &str,
    terminal_id: &str,
    control_url: &str,
    realtime_url: &str,
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
    let store = OutboxStore::open_or_create(&paths.database_path).expect("store");
    let binding = store
        .activate_terminal_binding(
            terminal_id,
            "mt5",
            &terminal_path,
            &AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            now_utc_msc(),
        )
        .expect("terminal binding");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("preferences store");
    preferences.save_platform("mt5").expect("save platform");
    preferences
        .save_terminal("mt5", terminal_id)
        .expect("save terminal");
    let now = now_utc_msc();
    let interrupted = CommandMessage {
        v: 3,
        message_type: "command".to_owned(),
        message_id: "message_01JRECOVER01".to_owned(),
        sent_at_utc_msc: now - 60_000,
        command_id: RECOVERED_COMMAND_ID.to_owned(),
        terminal_instance_id: binding.terminal_instance_id,
        account_ref: binding.account_ref,
        connection_epoch: binding.connection_epoch,
        issued_at_utc_msc: now - 60_000,
        deadline_utc_msc: now - 30_000,
        action: "place_order".to_owned(),
        params: serde_json::json!({
            "symbol": "XAUUSD",
            "side": "buy",
            "volume": 0.01,
            "magic": 234000
        }),
    };
    store
        .record_command(&interrupted, now - 60_000)
        .expect("record interrupted command");
    store
        .mark_command_dispatched(RECOVERED_COMMAND_ID, now - 59_999)
        .expect("mark interrupted command dispatched");
    fs::create_dir_all(&paths.root_data_directory).expect("root data directory");
    fs::write(
        paths.root_data_directory.join("endpoint-settings.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "control_url": control_url,
            "realtime_url": realtime_url,
        }))
        .expect("endpoint json"),
    )
    .expect("endpoint settings");
    paths
}

#[allow(clippy::too_many_arguments)]
fn prepare_read_only_profile(
    root: &Path,
    profile_id: &str,
    terminal_id: &str,
    terminal_file_name: &str,
    broker_server: &str,
    login: &str,
    control_url: &str,
    realtime_url: &str,
) -> bridge_foundation::BridgeProfilePaths {
    let paths = resolve_profile_paths(root, profile_id).expect("read-only profile paths");
    CredentialStore::new(&paths.credential_path)
        .expect("read-only credential store")
        .save(&BridgeCredential {
            refresh_token: "r".repeat(48),
            expires_at_utc_msc: 1_900_000_000_000,
        })
        .expect("read-only credential");
    let terminal_path = root.join(terminal_file_name);
    fs::create_dir_all(terminal_path.parent().expect("read-only terminal parent"))
        .expect("read-only terminal directory");
    fs::write(&terminal_path, b"terminal fixture").expect("read-only terminal fixture");
    OutboxStore::open_or_create(&paths.database_path)
        .expect("read-only store")
        .activate_terminal_binding(
            terminal_id,
            "mt5",
            &terminal_path,
            &AccountRef {
                broker_server: broker_server.to_owned(),
                login: login.to_owned(),
            },
            now_utc_msc(),
        )
        .expect("read-only terminal binding");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("read-only preferences store");
    preferences
        .save_platform("mt5")
        .expect("read-only platform");
    preferences
        .save_terminal("mt5", terminal_id)
        .expect("read-only terminal");
    fs::create_dir_all(&paths.root_data_directory).expect("read-only root data directory");
    fs::write(
        paths.root_data_directory.join("endpoint-settings.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "control_url": control_url,
            "realtime_url": realtime_url,
        }))
        .expect("read-only endpoint json"),
    )
    .expect("read-only endpoint settings");
    paths
}

fn prepare_mt4_discovery_profile(
    root: &Path,
    control_url: &str,
    realtime_url: &str,
) -> bridge_foundation::BridgeProfilePaths {
    let paths = resolve_profile_paths(root, DEFAULT_PROFILE_ID).expect("MT4 profile paths");
    CredentialStore::new(&paths.credential_path)
        .expect("MT4 credential store")
        .save(&BridgeCredential {
            refresh_token: "r".repeat(48),
            expires_at_utc_msc: 1_900_000_000_000,
        })
        .expect("MT4 credential");
    OutboxStore::open_or_create(&paths.database_path).expect("MT4 store");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("MT4 preferences store");
    preferences.save_platform("mt4").expect("MT4 platform");
    fs::create_dir_all(&paths.root_data_directory).expect("MT4 root data directory");
    fs::write(
        paths.root_data_directory.join("endpoint-settings.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "control_url": control_url,
            "realtime_url": realtime_url,
        }))
        .expect("MT4 endpoint json"),
    )
    .expect("MT4 endpoint settings");
    paths
}

fn prepare_mt5_discovery_profile(
    root: &Path,
    terminal_id: &str,
    terminal_path: &Path,
    control_url: &str,
    realtime_url: &str,
) -> bridge_foundation::BridgeProfilePaths {
    let paths = resolve_profile_paths(root, DEFAULT_PROFILE_ID).expect("MT5 profile paths");
    CredentialStore::new(&paths.credential_path)
        .expect("MT5 credential store")
        .save(&BridgeCredential {
            refresh_token: "r".repeat(48),
            expires_at_utc_msc: 1_900_000_000_000,
        })
        .expect("MT5 credential");
    OutboxStore::open_or_create(&paths.database_path).expect("MT5 store");
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .expect("MT5 preferences store");
    preferences.save_platform("mt5").expect("MT5 platform");
    preferences
        .save_terminal_installation("mt5", terminal_id, terminal_path)
        .expect("MT5 installation");
    fs::create_dir_all(&paths.root_data_directory).expect("MT5 root data directory");
    fs::write(
        paths.root_data_directory.join("endpoint-settings.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "control_url": control_url,
            "realtime_url": realtime_url,
        }))
        .expect("MT5 endpoint json"),
    )
    .expect("MT5 endpoint settings");
    paths
}

fn wait_until<F>(child: &mut ChildGuard, timeout: Duration, mut condition: F)
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        child.assert_running();
        if condition() {
            return;
        }
        assert!(Instant::now() < deadline, "condition timed out");
        thread::sleep(Duration::from_millis(25));
    }
}

fn wait_for_process_exit(process_id: u32, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while process_is_running(process_id) {
        assert!(Instant::now() < deadline, "worker process did not exit");
        thread::sleep(Duration::from_millis(25));
    }
}

fn process_is_running(process_id: u32) -> bool {
    // SAFETY: OpenProcess receives a concrete PID and requests query-only access. Any returned
    // handle is closed exactly once before this function returns.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        return false;
    }
    let mut exit_code = 0_u32;
    // SAFETY: handle is a valid process handle and exit_code points to writable storage.
    let succeeded = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    // SAFETY: this function owns the handle returned by OpenProcess.
    unsafe { CloseHandle(handle) };
    succeeded && exit_code == 259
}

fn terminate_process(process_id: u32) {
    // SAFETY: the PID belongs to the isolated fake Worker created by this test. The handle is
    // opened only for termination/query and is closed exactly once.
    let handle = unsafe {
        OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            process_id,
        )
    };
    assert!(!handle.is_null(), "open isolated worker for termination");
    // SAFETY: handle is a valid process handle for the isolated fake Worker.
    assert_ne!(
        unsafe { TerminateProcess(handle, 86) },
        0,
        "terminate isolated worker"
    );
    // SAFETY: this function owns the handle returned by OpenProcess.
    unsafe { CloseHandle(handle) };
    wait_for_process_exit(process_id, Duration::from_secs(5));
}

fn runtime_status_json(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .and_then(|payload| serde_json::from_slice(&payload).ok())
}

fn log_events(data_directory: &Path) -> Vec<String> {
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
                .filter_map(|record| record["event_name"].as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis() as i64
}

fn unique_profile_id() -> String {
    format!("connected-{}-{}", std::process::id(), now_utc_msc())
}

fn unique_test_directory() -> PathBuf {
    std::env::temp_dir().join(format!(
        "liangjian-bridge-core-connected-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos()
    ))
}
