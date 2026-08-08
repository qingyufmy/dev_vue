use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn versioned_launcher_is_readable_and_never_replaces_an_equal_stable_version() {
    let source = PathBuf::from(env!("CARGO_BIN_EXE_liangjian-bridge-launcher"));
    let root = test_directory();
    let staged = root.join("versions/3.0.0/launcher/AURUMBridge.Launcher.exe");
    let stable = root.join("AURUMBridge.Launcher.exe");
    fs::create_dir_all(staged.parent().expect("staged parent")).expect("staged directory");
    fs::copy(&source, &staged).expect("staged launcher");
    fs::copy(&source, &stable).expect("stable launcher");
    fs::write(
        root.join("current.json"),
        br#"{"active_version":"3.0.0","last_known_good_version":"3.0.0","status":"healthy","expected_terminal_instance_ids":[],"updated_at_utc_msc":1800000000000}"#,
    )
    .expect("healthy pointer");
    let before = fs::read(&stable).expect("stable bytes");
    assert_eq!(
        bridge_update::promote_staged_launcher(&staged, "3.0.0"),
        Ok(false)
    );
    assert_eq!(fs::read(&stable).expect("stable bytes after"), before);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
#[ignore = "requires AURUM_TEST_OLDER_LAUNCHER to point to an older PE fixture"]
fn newer_versioned_launcher_atomically_promotes_over_an_older_stable_launcher() {
    let candidate = PathBuf::from(env!("CARGO_BIN_EXE_liangjian-bridge-launcher"));
    let older = PathBuf::from(
        std::env::var_os("AURUM_TEST_OLDER_LAUNCHER").expect("older launcher fixture"),
    );
    let root = test_directory();
    let staged = root.join("versions/3.0.0/launcher/AURUMBridge.Launcher.exe");
    let stable = root.join("AURUMBridge.Launcher.exe");
    fs::create_dir_all(staged.parent().expect("staged parent")).expect("staged directory");
    fs::copy(&candidate, &staged).expect("staged launcher");
    fs::copy(&older, &stable).expect("older stable launcher");
    fs::write(
        root.join("current.json"),
        br#"{"active_version":"3.0.0","last_known_good_version":"3.0.0","status":"healthy","expected_terminal_instance_ids":[],"updated_at_utc_msc":1800000000000}"#,
    )
    .expect("healthy pointer");
    assert_eq!(
        bridge_update::promote_staged_launcher(&staged, "3.0.0"),
        Ok(true)
    );
    assert_eq!(
        fs::read(&stable).expect("promoted launcher"),
        fs::read(&candidate).expect("candidate launcher")
    );
    assert!(fs::read_dir(&root).expect("install root").all(|entry| {
        !entry
            .expect("root entry")
            .file_name()
            .to_string_lossy()
            .contains(".previous.exe")
    }));
    fs::remove_dir_all(root).expect("cleanup");
}

fn test_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "liangjian-launcher-promotion-test-{}-{nonce}",
        std::process::id()
    ))
}
