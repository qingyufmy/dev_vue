use base64::{Engine as _, engine::general_purpose::STANDARD};
use bridge_update::{ReleaseManifest, ReleasePackage, canonicalize_manifest, canonicalize_package};
use liangjian_bridge_installer::{InstallerConfiguration, OnlineInstaller};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::{EncodePublicKey as _, LineEnding};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use zip::write::SimpleFileOptions;

#[tokio::test]
async fn signed_loopback_bootstrap_release_downloads_and_installs_the_native_layout() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("loopback server");
    let base = format!("http://{}/", listener.local_addr().expect("server address"));
    let fixture = signed_online_fixture(&base);
    let routes = Arc::new(HashMap::from([
        (
            "/api/bridge/v3/releases/bootstrap".to_owned(),
            fixture.manifest.clone(),
        ),
        ("/packages/core.zip".to_owned(), fixture.core.clone()),
        ("/packages/mt5.zip".to_owned(), fixture.mt5.clone()),
        ("/packages/mt4.zip".to_owned(), fixture.mt4.clone()),
    ]));
    let server = thread::spawn(move || serve_requests(listener, routes, 4));
    let statuses = Mutex::new(Vec::new());
    let installer = OnlineInstaller::new(fixture.configuration(), &base).expect("installer");
    let outcome = installer
        .install(&|value| statuses.lock().expect("status").push(value.to_owned()))
        .await
        .expect("online install");
    server.join().expect("server thread");

    assert_eq!(outcome.version, "3.1.0");
    assert!(
        fixture
            .install_root
            .join("versions/3.1.0/AURUMBridge.exe")
            .is_file()
    );
    assert!(
        fixture
            .install_root
            .join("versions/3.1.0/modules/adapter.mt5.python/trade.py")
            .is_file()
    );
    let installation_id = fs::read_to_string(fixture.install_root.join("installation-id"))
        .expect("installation identity");
    assert_eq!(installation_id.len(), 40);
    assert!(installation_id.starts_with("install_"));
    assert_eq!(
        statuses.into_inner().expect("statuses"),
        vec![
            "正在验证发布信息…",
            "正在检查本地安装服务…",
            "正在下载量见智桥 3.1.0…",
            "正在安装稳定启动组件…",
        ]
    );
    assert!(
        fs::read_dir(&fixture.install_root)
            .expect("install root")
            .all(|entry| !entry
                .expect("root entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".bootstrap-"))
    );
    fs::remove_dir_all(&fixture.root).expect("cleanup");
}

#[test]
fn test_bootstrapper_rejects_every_non_loopback_server_before_network_io() {
    let fixture = signed_online_fixture("http://127.0.0.1:9/");
    assert_eq!(
        installer_error(fixture.configuration(), "https://www.example.com/"),
        "bootstrap_server_url_invalid"
    );
    assert_eq!(
        installer_error(fixture.configuration(), "http://192.0.2.1/"),
        "bootstrap_server_url_invalid"
    );
    fs::remove_dir_all(&fixture.root).expect("cleanup");
}

fn installer_error(configuration: InstallerConfiguration, server: &str) -> &'static str {
    match OnlineInstaller::new(configuration, server) {
        Ok(_) => panic!("server should be rejected"),
        Err(error) => error.code(),
    }
}

struct OnlineFixture {
    root: PathBuf,
    install_root: PathBuf,
    public_key: String,
    manifest: Vec<u8>,
    core: Vec<u8>,
    mt5: Vec<u8>,
    mt4: Vec<u8>,
}

impl OnlineFixture {
    fn configuration(&self) -> InstallerConfiguration {
        InstallerConfiguration {
            public_key_pem: self.public_key.clone(),
            launcher_version: "1.0.0".to_owned(),
            target_environment: "test".to_owned(),
            install_root: self.install_root.clone(),
            rehearsal: true,
        }
    }
}

fn signed_online_fixture(server_base: &str) -> OnlineFixture {
    let root = test_directory("online");
    let install_root = root.join("install");
    fs::create_dir_all(&root).expect("fixture root");
    let core = zip_payload(&[
        ("AURUMBridge.exe", b"native ui"),
        ("AURUMBridge.Core.exe", b"native core"),
        ("launcher/AURUMBridge.Launcher.exe", b"native launcher"),
        (
            "server-endpoints.json",
            br#"{"schema_version":1,"server_url":"http://127.0.0.1:3000"}"#,
        ),
        ("runtime/python/python.exe", b"python runtime"),
    ]);
    let mt5 = zip_payload(&[
        ("worker.py", b"print('ready')"),
        ("trade.py", b"print('trade')"),
    ]);
    let mt4 = zip_payload(&[("AURUMBridgeEA.ex4", b"compiled ea")]);
    let signing_key = SigningKey::from_bytes((&[43_u8; 32]).into()).expect("signing key");
    let public_key = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .expect("public key");
    let mut packages = vec![
        package("core", &format!("{server_base}packages/core.zip"), &core),
        package(
            "adapter.mt5.python",
            &format!("{server_base}packages/mt5.zip"),
            &mt5,
        ),
        package(
            "adapter.mt4",
            &format!("{server_base}packages/mt4.zip"),
            &mt4,
        ),
    ];
    for package in &mut packages {
        package.signature = sign_text(&signing_key, &canonicalize_package(package));
    }
    let now = now_utc_msc();
    let mut manifest = ReleaseManifest {
        schema_version: 2,
        release_version: "3.1.0".to_owned(),
        release_id: Some("bridge-3.1.0-online-test".to_owned()),
        generated_at_utc_msc: now,
        published_at_utc_msc: Some(now),
        expires_at_utc_msc: Some(now + 180 * 24 * 60 * 60 * 1_000),
        priority: Some("normal".to_owned()),
        minimum_launcher_version: "1.0.0".to_owned(),
        minimum_idle_seconds: Some(120),
        activation_deadline_utc_msc: None,
        rollout_channel: Some("stable".to_owned()),
        rollout_percentage: Some(100),
        packages,
        signature: "pending".to_owned(),
    };
    manifest.signature = sign_text(
        &signing_key,
        &canonicalize_manifest(&manifest).expect("canonical manifest"),
    );
    OnlineFixture {
        root,
        install_root,
        public_key,
        manifest: serde_json::to_vec(&manifest).expect("manifest"),
        core,
        mt5,
        mt4,
    }
}

fn package(module_id: &str, url: &str, payload: &[u8]) -> ReleasePackage {
    ReleasePackage {
        module_id: module_id.to_owned(),
        version: "3.1.0".to_owned(),
        url: Url::parse(url).expect("package URL"),
        size_bytes: payload.len() as u64,
        sha256: format!("{:x}", Sha256::digest(payload)),
        signature: "pending".to_owned(),
        minimum_core_version: (module_id != "core").then(|| "3.1.0".to_owned()),
        maximum_core_version: (module_id != "core").then(|| "3.1.0".to_owned()),
    }
}

fn serve_requests(listener: TcpListener, routes: Arc<HashMap<String, Vec<u8>>>, count: usize) {
    for _ in 0..count {
        let (mut stream, _) = listener.accept().expect("accept request");
        let path = request_path(&mut stream);
        let (status, payload) = routes
            .get(&path)
            .map(|payload| ("200 OK", payload.as_slice()))
            .unwrap_or(("404 Not Found", b"missing"));
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
            payload.len()
        )
        .expect("response header");
        stream.write_all(payload).expect("response body");
        stream.flush().expect("response flush");
    }
}

fn request_path(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !request.windows(4).any(|value| value == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).expect("read request");
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        assert!(request.len() <= 16 * 1024);
    }
    String::from_utf8_lossy(&request)
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_owned()
}

fn sign_text(signing_key: &SigningKey, payload: &str) -> String {
    let signature: Signature = signing_key.sign(payload.as_bytes());
    STANDARD.encode(signature.to_bytes())
}

fn zip_payload(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, payload) in entries {
        archive.start_file(*name, options).expect("zip entry");
        archive.write_all(payload).expect("zip payload");
    }
    archive.finish().expect("finish zip").into_inner()
}

fn test_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "liangjian-native-installer-{}-{}-{label}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
