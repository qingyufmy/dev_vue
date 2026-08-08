use bridge_security_win::{BridgeCredential, CredentialStore};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn dotnet_and_rust_share_the_v3_dpapi_credential_contract() {
    let root = unique_test_directory();
    fs::create_dir_all(&root).expect("fixture directory");
    let credential_path = root.join("credential.dat");
    let plaintext_output = root.join("credential.json");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/dpapi-compat-fixture.ps1");
    let dotnet_token = "D".repeat(64);
    let rust_token = "R".repeat(64);

    run_fixture_script(
        &script,
        &[
            "-Mode",
            "Encrypt",
            "-CredentialPath",
            path_text(&credential_path),
            "-RefreshToken",
            &dotnet_token,
            "-ExpiresAtUtcMsc",
            "1785268800000",
        ],
    );
    let store = CredentialStore::new(&credential_path).expect("credential store");
    assert_eq!(
        store.load().expect("load .NET credential"),
        Some(BridgeCredential {
            refresh_token: dotnet_token,
            expires_at_utc_msc: 1785268800000,
        })
    );

    let rust_credential = BridgeCredential {
        refresh_token: rust_token.clone(),
        expires_at_utc_msc: 1785355200000,
    };
    store.save(&rust_credential).expect("save Rust credential");
    run_fixture_script(
        &script,
        &[
            "-Mode",
            "Decrypt",
            "-CredentialPath",
            path_text(&credential_path),
            "-PlaintextOutputPath",
            path_text(&plaintext_output),
        ],
    );
    let decrypted: BridgeCredential =
        serde_json::from_slice(&fs::read(&plaintext_output).expect("decrypted fixture"))
            .expect("decrypted credential json");
    assert_eq!(decrypted, rust_credential);

    drop(store);
    fs::remove_dir_all(root).expect("remove dpapi fixture");
}

fn run_fixture_script(script: &Path, arguments: &[&str]) {
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path_text(script),
        ])
        .args(arguments)
        .status()
        .expect("run .NET DPAPI fixture");
    assert!(status.success(), "DPAPI fixture script failed: {status}");
}

fn path_text(path: &Path) -> &str {
    path.to_str().expect("Windows fixture path")
}

fn unique_test_directory() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "liangjian-bridge-dotnet-dpapi-{}-{stamp}",
        std::process::id()
    ))
}
