use bridge_runtime_win::{InstanceAcquireResult, InstanceSignal, SingleInstanceGuard};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[test]
fn rust_and_dotnet_share_the_v3_lock_and_activation_contract() {
    let root = unique_test_directory();
    fs::create_dir_all(&root).expect("fixture directory");
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/single-instance-compat-fixture.ps1");

    let rust_owner_id = unique_instance_id("rust-owner");
    let rust_result = root.join("rust-owner-result.txt");
    let rust_owner = acquired(
        SingleInstanceGuard::try_acquire(&rust_owner_id, &root, true)
            .expect("Rust owner acquisition"),
    );
    let status = powershell_command(
        &script,
        "ProbeDuplicate",
        &rust_owner_id,
        &root,
        &rust_result,
        None,
    )
    .status()
    .expect("run .NET duplicate probe");
    assert!(status.success());
    assert_eq!(
        fs::read_to_string(&rust_result).expect("Rust owner result"),
        "duplicate"
    );
    assert_eq!(
        rust_owner
            .wait_for_signal(Duration::from_secs(2))
            .expect(".NET activation signal"),
        InstanceSignal::Activation
    );
    drop(rust_owner);

    let dotnet_owner_id = unique_instance_id("dotnet-owner");
    let dotnet_ready = root.join("dotnet-owner-ready.txt");
    let dotnet_result = root.join("dotnet-owner-result.txt");
    let mut dotnet_owner = powershell_command(
        &script,
        "HoldForActivation",
        &dotnet_owner_id,
        &root,
        &dotnet_result,
        Some(&dotnet_ready),
    )
    .spawn()
    .expect("start .NET owner");
    wait_for_file(&dotnet_ready, &mut dotnet_owner);
    assert!(matches!(
        SingleInstanceGuard::try_acquire(&dotnet_owner_id, &root, true)
            .expect("Rust duplicate probe"),
        InstanceAcquireResult::Duplicate
    ));
    assert!(dotnet_owner.wait().expect("wait .NET owner").success());
    assert_eq!(
        fs::read_to_string(&dotnet_result).expect(".NET owner result"),
        "activated"
    );

    fs::remove_dir_all(root).expect("remove interop fixture");
}

fn acquired(result: InstanceAcquireResult) -> SingleInstanceGuard {
    match result {
        InstanceAcquireResult::Acquired(owner) => owner,
        InstanceAcquireResult::Duplicate => panic!("first instance must own the lock"),
    }
}

fn powershell_command(
    script: &Path,
    mode: &str,
    instance_id: &str,
    lock_directory: &Path,
    result_file: &Path,
    ready_file: Option<&Path>,
) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path_text(script),
        "-Mode",
        mode,
        "-InstanceId",
        instance_id,
        "-LockDirectory",
        path_text(lock_directory),
        "-ResultFile",
        path_text(result_file),
        "-TimeoutMilliseconds",
        "5000",
    ]);
    if let Some(ready_file) = ready_file {
        command.args(["-ReadyFile", path_text(ready_file)]);
    }
    command
}

fn wait_for_file(path: &Path, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            child.try_wait().expect("probe child state").is_none(),
            ".NET owner exited before becoming ready"
        );
        assert!(Instant::now() < deadline, ".NET owner readiness timed out");
        thread::sleep(Duration::from_millis(25));
    }
}

fn path_text(path: &Path) -> &str {
    path.to_str().expect("Windows fixture path")
}

fn unique_instance_id(suffix: &str) -> String {
    format!(
        "AURUMBridge.dotnet.compat.{}.{}",
        std::process::id(),
        suffix
    )
}

fn unique_test_directory() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "liangjian-bridge-instance-dotnet-{}-{stamp}",
        std::process::id()
    ))
}
