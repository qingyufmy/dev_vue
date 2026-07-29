use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn native_foundation_initializes_diagnostics_but_stays_fail_closed() {
    let root = unique_test_directory();
    let data_directory = root.join("data");
    let output = Command::new(env!("CARGO_BIN_EXE_liangjian-bridge-core"))
        .env("AURUM_BRIDGE_DATA_DIR", &data_directory)
        .env("LOCALAPPDATA", root.join("local"))
        .output()
        .expect("run native core foundation");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stderr)
            .expect("native stderr")
            .trim(),
        "native_bridge_runtime_not_ready"
    );
    let logs = fs::read_dir(data_directory.join("logs"))
        .expect("native log directory")
        .map(|entry| entry.expect("native log entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
        .collect::<Vec<_>>();
    assert_eq!(logs.len(), 1);
    let records = fs::read_to_string(&logs[0])
        .expect("native log")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("native jsonl"))
        .collect::<Vec<_>>();
    assert_eq!(
        records
            .iter()
            .map(|record| record["event_name"].as_str().expect("event name"))
            .collect::<Vec<_>>(),
        vec![
            "native_runtime_foundation_started",
            "native_runtime_not_ready"
        ]
    );
    assert!(!data_directory.join("native-bridge-core.active").exists());
    assert!(!root.join("ready.json").exists());

    fs::remove_dir_all(root).expect("remove native foundation fixture");
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
