use bridge_update::{
    BridgeUpdateStateStore, ReleaseActivationPointer, ReleaseActivationStore, STATE_HEALTHY,
    STATE_ROLLED_BACK, STATE_VERIFYING,
};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

pub const LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
pub const BRIDGE_FILE_NAME: &str = "AURUMBridge.exe";
const POINTER_FILE_NAME: &str = "current.json";
const UPDATE_STATE_FILE_NAME: &str = "update-state.json";
const MAXIMUM_READY_BYTES: u64 = 64 * 1024;
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const PENDING_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const ROLLBACK_STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
const READY_STABILITY_DELAY: Duration = Duration::from_secs(2);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LauncherError {
    code: &'static str,
}

impl LauncherError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl Display for LauncherError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for LauncherError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LauncherStartupOptions {
    pub start_minimized: bool,
    pub delay: Duration,
}

impl LauncherStartupOptions {
    pub fn parse(arguments: &[String]) -> Result<Self, LauncherError> {
        match arguments {
            [] => Ok(Self {
                start_minimized: false,
                delay: Duration::ZERO,
            }),
            [argument] if argument == "--autostart" => Ok(Self {
                start_minimized: true,
                delay: Duration::from_secs(10),
            }),
            _ => Err(LauncherError::new("launcher_arguments_invalid")),
        }
    }
}

pub trait BridgeProcessRunner {
    fn run_health_check(&self, executable: &Path, timeout: Duration)
    -> Result<bool, LauncherError>;

    fn start_and_wait_ready(
        &self,
        executable: &Path,
        expected_version: &str,
        expected_terminal_instance_ids: &[String],
        start_minimized: bool,
        timeout: Duration,
    ) -> Result<bool, LauncherError>;

    fn start_bridge(&self, executable: &Path, start_minimized: bool) -> Result<(), LauncherError>;
}

pub struct LauncherEngine<R> {
    install_root: PathBuf,
    pointer_store: ReleaseActivationStore,
    update_state_store: BridgeUpdateStateStore,
    process_runner: R,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl<R: BridgeProcessRunner> LauncherEngine<R> {
    pub fn new(install_root: impl AsRef<Path>, process_runner: R) -> Result<Self, LauncherError> {
        Self::with_clock(install_root, process_runner, now_utc_msc)
    }

    pub fn with_clock(
        install_root: impl AsRef<Path>,
        process_runner: R,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Result<Self, LauncherError> {
        let install_root = std::path::absolute(install_root.as_ref())
            .map_err(|_| LauncherError::new("launcher_install_root_invalid"))?;
        let pointer_store = ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))
            .map_err(|_| LauncherError::new("launcher_version_pointer_invalid"))?;
        let update_state_store =
            BridgeUpdateStateStore::new(install_root.join(UPDATE_STATE_FILE_NAME))
                .map_err(|_| LauncherError::new("launcher_update_state_invalid"))?;
        Ok(Self {
            install_root,
            pointer_store,
            update_state_store,
            process_runner,
            clock: Arc::new(clock),
        })
    }

    pub fn launch(&self, start_minimized: bool) -> Result<String, LauncherError> {
        let pointer = self
            .pointer_store
            .load()
            .map_err(|_| LauncherError::new("launcher_version_pointer_invalid"))?;
        let active_executable = self.resolve_executable(&pointer.active_version)?;
        if self
            .process_runner
            .run_health_check(&active_executable, HEALTH_CHECK_TIMEOUT)?
        {
            if pointer.status == "pending" {
                return self.verify_pending(pointer, active_executable, start_minimized);
            }
            self.pointer_store
                .mark_healthy(&pointer.active_version, (self.clock)())
                .map_err(|_| LauncherError::new("launcher_version_pointer_invalid"))?;
            self.process_runner
                .start_bridge(&active_executable, start_minimized)?;
            return Ok(pointer.active_version);
        }
        self.rollback(
            pointer,
            "launcher_health_check_failed".to_owned(),
            start_minimized,
        )
    }

    fn verify_pending(
        &self,
        pointer: ReleaseActivationPointer,
        active_executable: PathBuf,
        start_minimized: bool,
    ) -> Result<String, LauncherError> {
        self.update_state_store
            .mark_launcher_state(STATE_VERIFYING, &pointer.active_version, None, false)
            .map_err(|_| LauncherError::new("launcher_update_state_invalid"))?;
        if self.process_runner.start_and_wait_ready(
            &active_executable,
            &pointer.active_version,
            &pointer.expected_terminal_instance_ids,
            start_minimized,
            PENDING_STARTUP_TIMEOUT,
        )? {
            self.pointer_store
                .mark_healthy(&pointer.active_version, (self.clock)())
                .map_err(|_| LauncherError::new("launcher_version_pointer_invalid"))?;
            self.update_state_store
                .mark_launcher_state(STATE_HEALTHY, &pointer.active_version, None, true)
                .map_err(|_| LauncherError::new("launcher_update_state_invalid"))?;
            return Ok(pointer.active_version);
        }
        self.rollback(
            pointer,
            "launcher_startup_readiness_failed".to_owned(),
            start_minimized,
        )
    }

    fn rollback(
        &self,
        pointer: ReleaseActivationPointer,
        failure_code: String,
        start_minimized: bool,
    ) -> Result<String, LauncherError> {
        if pointer.active_version == pointer.last_known_good_version {
            return Err(LauncherError::new("launcher_health_check_failed"));
        }
        let failed_version = pointer.active_version.clone();
        let rollback_version = pointer.last_known_good_version.clone();
        let rollback_executable = self.resolve_executable(&rollback_version)?;
        let rollback_pointer = self
            .pointer_store
            .mark_rolled_back(&failed_version, (self.clock)())
            .map_err(|_| LauncherError::new("launcher_version_pointer_invalid"))?;
        self.update_state_store
            .mark_launcher_state(
                STATE_ROLLED_BACK,
                &failed_version,
                Some(failure_code.clone()),
                false,
            )
            .map_err(|_| LauncherError::new("launcher_update_state_invalid"))?;
        if !self
            .process_runner
            .run_health_check(&rollback_executable, HEALTH_CHECK_TIMEOUT)?
        {
            return Err(LauncherError::new("launcher_rollback_health_check_failed"));
        }
        if !self.process_runner.start_and_wait_ready(
            &rollback_executable,
            &rollback_version,
            &rollback_pointer.expected_terminal_instance_ids,
            start_minimized,
            ROLLBACK_STARTUP_TIMEOUT,
        )? {
            return Err(LauncherError::new("launcher_rollback_startup_failed"));
        }
        self.pointer_store
            .confirm_rollback(&rollback_version, (self.clock)())
            .map_err(|_| LauncherError::new("launcher_version_pointer_invalid"))?;
        self.update_state_store
            .mark_launcher_state(STATE_ROLLED_BACK, &failed_version, Some(failure_code), true)
            .map_err(|_| LauncherError::new("launcher_update_state_invalid"))?;
        Ok(rollback_version)
    }

    fn resolve_executable(&self, version: &str) -> Result<PathBuf, LauncherError> {
        if !valid_numeric_version(version) {
            return Err(LauncherError::new("launcher_version_invalid"));
        }
        let executable = self
            .install_root
            .join("versions")
            .join(version)
            .join(BRIDGE_FILE_NAME);
        if !executable.is_file() {
            return Err(LauncherError::new("launcher_bridge_executable_not_found"));
        }
        Ok(executable)
    }
}

#[derive(Clone)]
pub struct NativeBridgeProcessRunner {
    health_directory: PathBuf,
}

impl NativeBridgeProcessRunner {
    pub fn new(install_root: impl AsRef<Path>) -> Result<Self, LauncherError> {
        let install_root = std::path::absolute(install_root.as_ref())
            .map_err(|_| LauncherError::new("launcher_install_root_invalid"))?;
        Ok(Self {
            health_directory: install_root.join("health"),
        })
    }

    fn temporary_signal_path(&self, prefix: &str) -> Result<PathBuf, LauncherError> {
        fs::create_dir_all(&self.health_directory)
            .map_err(|_| LauncherError::new("launcher_health_directory_unavailable"))?;
        let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Ok(self.health_directory.join(format!(
            "{prefix}-{}-{}-{sequence}.json",
            std::process::id(),
            timestamp_nanos()
        )))
    }
}

impl BridgeProcessRunner for NativeBridgeProcessRunner {
    fn run_health_check(
        &self,
        executable: &Path,
        timeout: Duration,
    ) -> Result<bool, LauncherError> {
        if timeout.is_zero() {
            return Err(LauncherError::new("launcher_timeout_invalid"));
        }
        let health_file = self.temporary_signal_path("health")?;
        let result = (|| {
            let mut child = Command::new(executable)
                .args(["--health-check", "--health-file"])
                .arg(&health_file)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|_| LauncherError::new("launcher_health_process_start_failed"))?;
            let status = wait_for_exit(&mut child, timeout)?;
            Ok(status && health_file.is_file())
        })();
        let _ = fs::remove_file(health_file);
        result
    }

    fn start_and_wait_ready(
        &self,
        executable: &Path,
        expected_version: &str,
        expected_terminal_instance_ids: &[String],
        start_minimized: bool,
        timeout: Duration,
    ) -> Result<bool, LauncherError> {
        if timeout.is_zero() || !valid_numeric_version(expected_version) {
            return Err(LauncherError::new("launcher_timeout_invalid"));
        }
        let ready_file = self.temporary_signal_path("ready")?;
        let mut command = Command::new(executable);
        if start_minimized {
            command.arg("--start-minimized");
        }
        command.args(["--ready-file"]).arg(&ready_file);
        for terminal_id in expected_terminal_instance_ids {
            command.args(["--expected-terminal", terminal_id]);
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| LauncherError::new("launcher_bridge_process_start_failed"))?;
        let deadline = Instant::now() + timeout;
        let mut ready = false;
        while Instant::now() < deadline {
            if child
                .try_wait()
                .map_err(|_| LauncherError::new("launcher_bridge_process_wait_failed"))?
                .is_some()
            {
                break;
            }
            if expected_ready_signal(
                &ready_file,
                expected_version,
                expected_terminal_instance_ids,
            ) {
                thread::sleep(READY_STABILITY_DELAY);
                ready = child
                    .try_wait()
                    .map_err(|_| LauncherError::new("launcher_bridge_process_wait_failed"))?
                    .is_none();
                break;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        if !ready {
            terminate_child(&mut child);
        }
        let _ = fs::remove_file(ready_file);
        Ok(ready)
    }

    fn start_bridge(&self, executable: &Path, start_minimized: bool) -> Result<(), LauncherError> {
        let mut command = Command::new(executable);
        if start_minimized {
            command.arg("--start-minimized");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| LauncherError::new("launcher_bridge_process_start_failed"))
    }
}

#[derive(Deserialize)]
struct StartupReadySignal {
    ready: bool,
    version: String,
    server_connected: bool,
    running_terminal_instance_ids: Vec<String>,
}

fn expected_ready_signal(
    path: &Path,
    expected_version: &str,
    expected_terminal_instance_ids: &[String],
) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_READY_BYTES {
        return false;
    }
    let Ok(payload) = fs::read(path) else {
        return false;
    };
    let Ok(signal) = serde_json::from_slice::<StartupReadySignal>(&payload) else {
        return false;
    };
    if !signal.ready || !signal.server_connected || signal.version != expected_version {
        return false;
    }
    let running = signal
        .running_terminal_instance_ids
        .into_iter()
        .collect::<BTreeSet<_>>();
    expected_terminal_instance_ids
        .iter()
        .all(|terminal_id| running.contains(terminal_id))
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<bool, LauncherError> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| LauncherError::new("launcher_health_process_wait_failed"))?
        {
            return Ok(status.success());
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
    terminate_child(child);
    Ok(false)
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn valid_numeric_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 10
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_update::{BridgeUpdateState, STATE_ACTIVATING};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRunner {
        health: Mutex<VecDeque<bool>>,
        ready: Mutex<VecDeque<bool>>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeRunner {
        fn with_results(health: &[bool], ready: &[bool]) -> Self {
            Self {
                health: Mutex::new(health.iter().copied().collect()),
                ready: Mutex::new(ready.iter().copied().collect()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }
    }

    impl BridgeProcessRunner for &FakeRunner {
        fn run_health_check(
            &self,
            executable: &Path,
            _timeout: Duration,
        ) -> Result<bool, LauncherError> {
            self.calls
                .lock()
                .expect("calls")
                .push(format!("health:{}", version_name(executable)));
            self.health
                .lock()
                .expect("health")
                .pop_front()
                .ok_or_else(|| LauncherError::new("test_health_result_missing"))
        }

        fn start_and_wait_ready(
            &self,
            executable: &Path,
            expected_version: &str,
            expected_terminal_instance_ids: &[String],
            start_minimized: bool,
            _timeout: Duration,
        ) -> Result<bool, LauncherError> {
            self.calls.lock().expect("calls").push(format!(
                "ready:{}:{expected_version}:{}:{start_minimized}",
                version_name(executable),
                expected_terminal_instance_ids.join(",")
            ));
            self.ready
                .lock()
                .expect("ready")
                .pop_front()
                .ok_or_else(|| LauncherError::new("test_ready_result_missing"))
        }

        fn start_bridge(
            &self,
            executable: &Path,
            start_minimized: bool,
        ) -> Result<(), LauncherError> {
            self.calls.lock().expect("calls").push(format!(
                "start:{}:{start_minimized}",
                version_name(executable)
            ));
            Ok(())
        }
    }

    #[test]
    fn startup_arguments_match_the_dotnet_launcher() {
        assert_eq!(
            LauncherStartupOptions::parse(&[]),
            Ok(LauncherStartupOptions {
                start_minimized: false,
                delay: Duration::ZERO,
            })
        );
        assert_eq!(
            LauncherStartupOptions::parse(&["--autostart".to_owned()]),
            Ok(LauncherStartupOptions {
                start_minimized: true,
                delay: Duration::from_secs(10),
            })
        );
        assert_eq!(
            LauncherStartupOptions::parse(&["--start-minimized".to_owned()])
                .expect_err("unsupported direct argument")
                .code(),
            "launcher_arguments_invalid"
        );
    }

    #[test]
    fn pending_release_becomes_healthy_only_after_ready() {
        let root = installed_fixture("pending-success", "3.1.0", "3.0.0", "pending");
        save_update_state(&root, "3.1.0");
        let runner = FakeRunner::with_results(&[true], &[true]);
        let engine = LauncherEngine::with_clock(&root, &runner, || 1_800_000_000_111)
            .expect("launcher engine");
        assert_eq!(engine.launch(true), Ok("3.1.0".to_owned()));
        assert_eq!(
            runner.calls(),
            vec![
                "health:3.1.0".to_owned(),
                "ready:3.1.0:3.1.0:mt5_a:true".to_owned(),
            ]
        );
        let pointer = ReleaseActivationStore::new(root.join(POINTER_FILE_NAME))
            .expect("pointer store")
            .load()
            .expect("pointer");
        assert_eq!(pointer.status, "healthy");
        assert_eq!(pointer.last_known_good_version, "3.1.0");
        assert!(pointer.expected_terminal_instance_ids.is_empty());
        let state = BridgeUpdateStateStore::new(root.join(UPDATE_STATE_FILE_NAME))
            .expect("state store")
            .load()
            .expect("state")
            .expect("persisted state");
        assert_eq!(state.state, STATE_HEALTHY);
        assert!(state.maintenance_lease_id.is_none());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn failed_pending_release_rolls_back_and_preserves_the_failure_reason() {
        let root = installed_fixture("pending-rollback", "3.1.0", "3.0.0", "pending");
        save_update_state(&root, "3.1.0");
        let runner = FakeRunner::with_results(&[true, true], &[false, true]);
        let engine = LauncherEngine::with_clock(&root, &runner, || 1_800_000_000_222)
            .expect("launcher engine");
        assert_eq!(engine.launch(false), Ok("3.0.0".to_owned()));
        assert_eq!(
            runner.calls(),
            vec![
                "health:3.1.0".to_owned(),
                "ready:3.1.0:3.1.0:mt5_a:false".to_owned(),
                "health:3.0.0".to_owned(),
                "ready:3.0.0:3.0.0:mt5_a:false".to_owned(),
            ]
        );
        let pointer = ReleaseActivationStore::new(root.join(POINTER_FILE_NAME))
            .expect("pointer store")
            .load()
            .expect("pointer");
        assert_eq!(pointer.active_version, "3.0.0");
        assert_eq!(pointer.last_known_good_version, "3.0.0");
        assert_eq!(pointer.status, "rolled_back");
        assert!(pointer.expected_terminal_instance_ids.is_empty());
        let state = BridgeUpdateStateStore::new(root.join(UPDATE_STATE_FILE_NAME))
            .expect("state store")
            .load()
            .expect("state")
            .expect("persisted state");
        assert_eq!(state.state, STATE_ROLLED_BACK);
        assert_eq!(
            state.last_error_code.as_deref(),
            Some("launcher_startup_readiness_failed")
        );
        assert!(state.maintenance_lease_id.is_none());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn ready_signal_requires_version_connection_and_every_expected_terminal() {
        let root = test_directory("ready-signal");
        fs::create_dir_all(&root).expect("root");
        let path = root.join("ready.json");
        fs::write(
            &path,
            br#"{"ready":true,"version":"3.1.0","server_connected":true,"running_terminal_instance_ids":["mt5_a","mt4_b"]}"#,
        )
        .expect("ready signal");
        assert!(expected_ready_signal(&path, "3.1.0", &["mt4_b".to_owned()]));
        assert!(!expected_ready_signal(
            &path,
            "3.2.0",
            &["mt4_b".to_owned()]
        ));
        assert!(!expected_ready_signal(
            &path,
            "3.1.0",
            &["mt5_missing".to_owned()]
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn installed_fixture(
        label: &str,
        active: &str,
        last_known_good: &str,
        status: &str,
    ) -> PathBuf {
        let root = test_directory(label);
        for version in [active, last_known_good] {
            let directory = root.join("versions").join(version);
            fs::create_dir_all(&directory).expect("version directory");
            fs::write(directory.join(BRIDGE_FILE_NAME), []).expect("bridge executable");
        }
        fs::write(
            root.join(POINTER_FILE_NAME),
            serde_json::to_vec(&ReleaseActivationPointer {
                active_version: active.to_owned(),
                last_known_good_version: last_known_good.to_owned(),
                status: status.to_owned(),
                expected_terminal_instance_ids: vec!["mt5_a".to_owned()],
                updated_at_utc_msc: 1,
            })
            .expect("pointer payload"),
        )
        .expect("pointer");
        root
    }

    fn save_update_state(root: &Path, version: &str) {
        BridgeUpdateStateStore::new(root.join(UPDATE_STATE_FILE_NAME))
            .expect("state store")
            .save(BridgeUpdateState {
                schema_version: 1,
                state: STATE_ACTIVATING.to_owned(),
                target_version: Some(version.to_owned()),
                release_id: Some("release_3.1.0".to_owned()),
                priority: Some("normal".to_owned()),
                manual_activation_requested: false,
                staged_at_utc_msc: Some(1_800_000_000_000),
                activation_started_at_utc_msc: Some(1_800_000_000_010),
                minimum_idle_seconds: 120,
                activation_deadline_utc_msc: None,
                maintenance_lease_id: Some("lease_01JLAUNCHER".to_owned()),
                maintenance_lease_expires_at_utc_msc: Some(1_800_000_090_000),
                next_retry_at_utc_msc: None,
                last_error_code: None,
                updated_at_utc_msc: 1,
            })
            .expect("save update state");
    }

    fn version_name(executable: &Path) -> String {
        executable
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .expect("version directory")
            .to_owned()
    }

    fn test_directory(label: &str) -> PathBuf {
        let nonce = timestamp_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-launcher-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
