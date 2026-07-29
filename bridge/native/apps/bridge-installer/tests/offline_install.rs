use base64::{Engine as _, engine::general_purpose::STANDARD};
use bridge_update::{
    ReleaseActivationStore, ReleaseManifest, ReleasePackage, canonicalize_manifest,
    canonicalize_package,
};
use liangjian_bridge_installer::{InstallerConfiguration, OfflineInstaller};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::{EncodePublicKey as _, LineEnding};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use zip::write::SimpleFileOptions;

#[tokio::test]
async fn signed_offline_bundle_installs_and_repairs_one_isolated_native_version() {
    let fixture = signed_bundle("install-repair");
    let installer = OfflineInstaller::new(fixture.configuration()).expect("installer");
    let first = installer
        .install(&fixture.bundle_root)
        .await
        .expect("first install");
    assert_eq!(first.version, "3.1.0");
    let version = fixture.install_root.join("versions/3.1.0");
    assert!(version.join("AURUMBridge.exe").is_file());
    assert!(version.join("AURUMBridge.Core.exe").is_file());
    assert!(
        version
            .join("modules/adapter.mt5.python/worker.py")
            .is_file()
    );
    assert!(
        version
            .join("modules/adapter.mt5.python/trade.py")
            .is_file()
    );
    assert!(
        version
            .join("modules/adapter.mt4/AURUMBridgeEA.ex4")
            .is_file()
    );
    assert_eq!(
        fs::read(fixture.install_root.join("AURUMBridge.Launcher.exe")).expect("stable launcher"),
        b"native launcher"
    );
    let pointer = ReleaseActivationStore::new(fixture.install_root.join("current.json"))
        .expect("pointer store")
        .load()
        .expect("pointer");
    assert_eq!(pointer.active_version, "3.1.0");
    assert_eq!(pointer.last_known_good_version, "3.1.0");
    assert_eq!(pointer.status, "healthy");
    fs::write(version.join("stale-from-old-install.txt"), b"stale").expect("stale file");

    installer
        .install(&fixture.bundle_root)
        .await
        .expect("repair install");
    assert!(!version.join("stale-from-old-install.txt").exists());
    assert_no_installer_work_directories(&fixture.install_root);
    fs::remove_dir_all(&fixture.root).expect("cleanup");
}

#[tokio::test]
async fn corrupt_offline_package_never_mutates_an_existing_healthy_installation() {
    let fixture = signed_bundle("corrupt-package");
    let installer = OfflineInstaller::new(fixture.configuration()).expect("installer");
    installer
        .install(&fixture.bundle_root)
        .await
        .expect("healthy install");
    let stable = fixture.install_root.join("AURUMBridge.Launcher.exe");
    let pointer = fixture.install_root.join("current.json");
    let stable_before = fs::read(&stable).expect("stable before");
    let pointer_before = fs::read(&pointer).expect("pointer before");
    fs::write(fixture.bundle_root.join("adapter.mt4.zip"), b"corrupt").expect("corrupt package");

    assert_eq!(
        installer
            .install(&fixture.bundle_root)
            .await
            .expect_err("corrupt package")
            .code(),
        "bootstrap_offline_package_integrity_failed"
    );
    assert_eq!(fs::read(stable).expect("stable after"), stable_before);
    assert_eq!(fs::read(pointer).expect("pointer after"), pointer_before);
    assert_no_installer_work_directories(&fixture.install_root);
    fs::remove_dir_all(&fixture.root).expect("cleanup");
}

#[test]
fn offline_command_contract_rejects_an_untrusted_bundle_and_writes_the_inno_result_document() {
    let fixture = signed_bundle("command-contract");
    let result_path = fixture.root.join("install-result.json");
    let output = Command::new(env!("CARGO_BIN_EXE_liangjian-bridge-installer"))
        .arg("--offline-bundle-root")
        .arg(&fixture.bundle_root)
        .arg("--rehearsal-install-root")
        .arg(&fixture.install_root)
        .arg("--rehearsal-result")
        .arg(&result_path)
        .output()
        .expect("installer command");
    assert_eq!(output.status.code(), Some(1));
    let result = serde_json::from_slice::<serde_json::Value>(
        &fs::read(result_path).expect("result document"),
    )
    .expect("result JSON");
    assert_eq!(
        result.get("ok").and_then(serde_json::Value::as_bool),
        Some(false)
    );
    assert_eq!(
        result.get("error").and_then(serde_json::Value::as_str),
        Some("update_manifest_signature_invalid")
    );
    assert!(!fixture.install_root.join("current.json").exists());
    fs::remove_dir_all(&fixture.root).expect("cleanup");
}

struct SignedBundleFixture {
    root: PathBuf,
    bundle_root: PathBuf,
    install_root: PathBuf,
    public_key: String,
}

impl SignedBundleFixture {
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

fn signed_bundle(label: &str) -> SignedBundleFixture {
    let root = test_directory(label);
    let bundle_root = root.join("bundle");
    let install_root = root.join("install");
    fs::create_dir_all(&bundle_root).expect("bundle root");
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
    fs::write(bundle_root.join("core.zip"), &core).expect("core archive");
    fs::write(bundle_root.join("adapter.mt5.python.zip"), &mt5).expect("mt5 archive");
    fs::write(bundle_root.join("adapter.mt4.zip"), &mt4).expect("mt4 archive");

    let signing_key = SigningKey::from_bytes((&[42_u8; 32]).into()).expect("signing key");
    let public_key = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .expect("public key");
    let mut packages = vec![
        package("core", &core),
        package("adapter.mt5.python", &mt5),
        package("adapter.mt4", &mt4),
    ];
    for package in &mut packages {
        package.signature = sign_text(&signing_key, &canonicalize_package(package));
    }
    let now = now_utc_msc();
    let mut manifest = ReleaseManifest {
        schema_version: 2,
        release_version: "3.1.0".to_owned(),
        release_id: Some(format!("bridge-3.1.0-{label}")),
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
        &canonicalize_manifest(&manifest).expect("canonical"),
    );
    fs::write(
        bundle_root.join("manifest.signed.json"),
        serde_json::to_vec(&manifest).expect("manifest"),
    )
    .expect("manifest file");
    SignedBundleFixture {
        root,
        bundle_root,
        install_root,
        public_key,
    }
}

fn package(module_id: &str, payload: &[u8]) -> ReleasePackage {
    ReleasePackage {
        module_id: module_id.to_owned(),
        version: "3.1.0".to_owned(),
        url: Url::parse(&format!("https://packages.invalid/{module_id}.zip")).expect("package URL"),
        size_bytes: payload.len() as u64,
        sha256: format!("{:x}", Sha256::digest(payload)),
        signature: "pending".to_owned(),
        minimum_core_version: (module_id != "core").then(|| "3.1.0".to_owned()),
        maximum_core_version: (module_id != "core").then(|| "3.1.0".to_owned()),
    }
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

fn assert_no_installer_work_directories(install_root: &Path) {
    let names = fs::read_dir(install_root)
        .expect("install root")
        .map(|entry| {
            entry
                .expect("root entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert!(names.iter().all(|name| !name.starts_with(".bootstrap-")));
    let versions = fs::read_dir(install_root.join("versions"))
        .expect("versions")
        .map(|entry| {
            entry
                .expect("version entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    assert!(
        versions
            .iter()
            .all(|name| !name.starts_with(".repair-backup-"))
    );
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
