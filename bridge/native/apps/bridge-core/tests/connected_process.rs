use bridge_contract::{AccountRef, CommandMessage, HelloAcknowledgement, HelloMessage};
use bridge_foundation::{profile_instance_id, resolve_profile_paths};
use bridge_runtime_win::SingleInstanceGuard;
use bridge_security_win::{BridgeCredential, CredentialStore};
use bridge_store::OutboxStore;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
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
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    TerminateProcess,
};

const RECOVERED_COMMAND_ID: &str = "command_01JRECOVER01";

#[test]
fn native_core_reaches_ready_reconnects_and_stops_as_one_process_tree() {
    let root = unique_test_directory();
    let profile_id = unique_profile_id();
    let terminal_id = "mt5_connected_process";
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
    let worker_pid_file = root.join("worker.pid");
    let order_send_count_file = root.join("order-send-count.txt");
    let mut child = ChildGuard::spawn(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        terminal_id,
    );

    wait_until(&mut child, Duration::from_secs(20), || {
        ready.is_file()
            && worker_pid_file.is_file()
            && server.saw_routed_full_snapshot(terminal_id)
            && server.saw_succeeded_command_result()
            && server.saw_recovered_command_result()
            && server.saw_history_response()
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
    assert_eq!(
        fs::read_to_string(&order_send_count_file)
            .expect("order send count")
            .trim(),
        "1",
        "startup reconciliation must query terminal facts without replaying the interrupted order"
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

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn spawn(
        executable: PathBuf,
        root: &Path,
        profile_id: &str,
        ready: &Path,
        terminal_id: &str,
    ) -> Self {
        let child = Command::new(executable)
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
            .env("LOCALAPPDATA", root.join("local"))
            .env("AURUM_TEST_WORKER_PID_FILE", root.join("worker.pid"))
            .env(
                "AURUM_TEST_WORKER_ORDER_SEND_COUNT_FILE",
                root.join("order-send-count.txt"),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn native core");
        Self(Some(child))
    }

    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("child available")
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
    thread: Option<thread::JoinHandle<()>>,
}

impl LoopbackBridgeServer {
    fn start() -> Self {
        let disconnect_first = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let websocket_connections = Arc::new(AtomicUsize::new(0));
        let command_sent = Arc::new(AtomicBool::new(false));
        let message_types = Arc::new(Mutex::new(Vec::new()));
        let (addresses_tx, addresses_rx) = mpsc::sync_channel(1);
        let thread = {
            let disconnect_first = Arc::clone(&disconnect_first);
            let stop = Arc::clone(&stop);
            let websocket_connections = Arc::clone(&websocket_connections);
            let command_sent = Arc::clone(&command_sent);
            let message_types = Arc::clone(&message_types);
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
                        serve_control(control, Arc::clone(&stop)),
                        serve_realtime(
                            realtime,
                            disconnect_first,
                            Arc::clone(&stop),
                            websocket_connections,
                            command_sent,
                            message_types,
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
            thread: Some(thread),
        }
    }

    fn disconnect_first(&self) {
        self.disconnect_first.store(true, Ordering::SeqCst);
    }

    fn websocket_connections(&self) -> usize {
        self.websocket_connections.load(Ordering::SeqCst)
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

    fn saw_history_response(&self) -> bool {
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| value == "data_response:history:succeeded")
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

async fn serve_control(listener: TcpListener, stop: Arc<AtomicBool>) {
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
        } else {
            panic!(
                "unexpected control request: {}",
                request.1.lines().next().unwrap_or("")
            );
        };
        write_http_json(request.0, body).await;
    }
}

#[allow(clippy::result_large_err)]
async fn serve_realtime(
    listener: TcpListener,
    disconnect_first: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    websocket_connections: Arc<AtomicUsize>,
    command_sent: Arc<AtomicBool>,
    message_types: Arc<Mutex<Vec<String>>>,
) {
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
                    if message_type == "command_result" {
                        message_types.lock().expect("message types").push(format!(
                            "command_result_id:{}:{}",
                            payload["command_id"].as_str().unwrap_or("missing"),
                            payload["status"].as_str().unwrap_or("missing")
                        ));
                    }

                    if message_type == "data_delta"
                        && payload["full_snapshot"].as_bool() == Some(true)
                    {
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
                        }
                        if initial_ready && !command_sent.swap(true, Ordering::SeqCst) {
                            let now = now_utc_msc();
                            socket
                                .send(Message::Text(
                                    serde_json::json!({
                                        "v": 3,
                                        "type": "command",
                                        "message_id": "message_01JCONNECTED1",
                                        "sent_at_utc_msc": now,
                                        "command_id": "command_01JCONNECTED1",
                                        "terminal_instance_id": terminal.terminal_instance_id,
                                        "account_ref": terminal.account_ref,
                                        "connection_epoch": terminal.connection_epoch,
                                        "issued_at_utc_msc": now,
                                        "deadline_utc_msc": now + 30_000,
                                        "action": "place_order",
                                        "params": {
                                            "symbol": "XAUUSD",
                                            "side": "buy",
                                            "volume": 0.01
                                        }
                                    })
                                    .to_string()
                                    .into(),
                                ))
                                .await
                                .expect("command send");
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

fn wait_until<F>(child: &mut ChildGuard, timeout: Duration, mut condition: F)
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        assert_eq!(
            child.child_mut().try_wait().expect("poll native core"),
            None,
            "native core exited early"
        );
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
