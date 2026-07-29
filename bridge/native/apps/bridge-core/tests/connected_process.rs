use bridge_contract::{AccountRef, HelloAcknowledgement, HelloMessage};
use bridge_foundation::{profile_instance_id, resolve_profile_paths};
use bridge_runtime_win::SingleInstanceGuard;
use bridge_security_win::{BridgeCredential, CredentialStore};
use bridge_store::OutboxStore;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::fs;
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
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

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
    let mut child = ChildGuard::spawn(
        application.join("liangjian-bridge-core.exe"),
        &root,
        &profile_id,
        &ready,
        terminal_id,
    );

    wait_until(&mut child, Duration::from_secs(20), || {
        ready.is_file() && worker_pid_file.is_file() && server.saw_routed_full_snapshot(terminal_id)
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
    assert_eq!(server.websocket_connections(), 1);
    assert!(
        server.saw_routed_full_snapshot(terminal_id),
        "forwarded full snapshot route missing"
    );

    server.disconnect_first();
    wait_until(&mut child, Duration::from_secs(15), || {
        server.websocket_connections() >= 2
    });
    SingleInstanceGuard::request_shutdown(&profile_instance_id(&profile_id).expect("instance id"))
        .expect("request shutdown");
    let output = child.wait_with_output();
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    wait_for_process_exit(worker_pid, Duration::from_secs(5));
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
        events.iter().any(|event| event == "native_runtime_stopped"),
        "graceful stop log missing"
    );
    assert!(
        !paths
            .data_directory
            .join("native-bridge-core.active")
            .exists()
    );

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
        let message_types = Arc::new(Mutex::new(Vec::new()));
        let (addresses_tx, addresses_rx) = mpsc::sync_channel(1);
        let thread = {
            let disconnect_first = Arc::clone(&disconnect_first);
            let stop = Arc::clone(&stop);
            let websocket_connections = Arc::clone(&websocket_connections);
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
        self.message_types
            .lock()
            .expect("message types")
            .iter()
            .any(|value| value == &format!("data_delta:{terminal_id}:full"))
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

        loop {
            if stop.load(Ordering::SeqCst)
                || sequence == 1 && disconnect_first.load(Ordering::SeqCst)
            {
                let _ = socket.close(None).await;
                break;
            }
            if let Ok(Some(frame)) = timeout(Duration::from_millis(20), socket.next()).await {
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
                    } else {
                        message_type.to_owned()
                    };
                    message_types.lock().expect("message types").push(summary);
                }
            }
        }
    }
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
    OutboxStore::open_or_create(&paths.database_path)
        .expect("store")
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
