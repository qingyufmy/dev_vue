use bridge_foundation::{CliMode, profile_instance_id};
use bridge_runtime_win::{SingleInstanceGuard, default_lock_directory};
use std::ffi::OsString;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

const INSTALLED_CORE_FILE_NAME: &str = "AURUMBridge.Core.exe";
const DEVELOPMENT_CORE_FILE_NAME: &str = "liangjian-bridge-core.exe";
const RESTART_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(10),
];

pub struct CoreProcessHost {
    executable: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    child: Option<Child>,
    failures: usize,
    restart_after: Option<Instant>,
    restart_enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CoreProcessPoll {
    Running,
    Idle,
    UpdateHandoff(PathBuf),
}

impl CoreProcessHost {
    pub fn start(
        application_directory: &Path,
        arguments: Vec<OsString>,
        mode: &CliMode,
    ) -> Result<Option<Self>, &'static str> {
        let CliMode::Run {
            profile_id,
            ready_file,
            ..
        } = mode
        else {
            return Err("bridge_ui_core_mode_invalid");
        };
        let instance_id = profile_instance_id(profile_id)?;
        let core_running = SingleInstanceGuard::is_running(
            &instance_id,
            default_lock_directory().map_err(|error| error.code())?,
        )
        .map_err(|error| error.code())?;
        if core_running {
            return if ready_file.is_some() {
                Err("bridge_ui_core_update_instance_conflict")
            } else {
                Ok(None)
            };
        }

        let executable = resolve_core_executable(application_directory)?;
        let mut host = Self {
            executable,
            working_directory: application_directory.to_path_buf(),
            arguments,
            child: None,
            failures: 0,
            restart_after: None,
            restart_enabled: true,
        };
        host.spawn()?;
        Ok(Some(host))
    }

    pub fn poll(&mut self) -> Result<CoreProcessPoll, &'static str> {
        let Some(child) = self.child.as_mut() else {
            if self.restart_enabled
                && self
                    .restart_after
                    .is_some_and(|deadline| Instant::now() >= deadline)
            {
                self.spawn()?;
                return Ok(CoreProcessPoll::Running);
            }
            return Ok(CoreProcessPoll::Idle);
        };
        match child.try_wait() {
            Ok(None) => Ok(CoreProcessPoll::Running),
            Ok(Some(status)) => {
                self.child = None;
                self.schedule_restart(status);
                if status.success()
                    && let Some(launcher) =
                        bridge_update::pending_launcher_handoff(&self.working_directory)
                            .map_err(|_| "bridge_ui_update_handoff_invalid")?
                {
                    return Ok(CoreProcessPoll::UpdateHandoff(launcher));
                }
                Ok(CoreProcessPoll::Idle)
            }
            Err(_) => Err("bridge_ui_core_process_wait_failed"),
        }
    }

    pub fn disable_restart(&mut self) {
        self.restart_enabled = false;
        self.restart_after = None;
    }

    fn spawn(&mut self) -> Result<(), &'static str> {
        let child = spawn_core(&self.executable, &self.working_directory, &self.arguments)
            .map_err(|_| "bridge_ui_core_process_start_failed")?;
        self.child = Some(child);
        self.restart_after = None;
        Ok(())
    }

    fn schedule_restart(&mut self, status: ExitStatus) {
        if !self.restart_enabled {
            self.restart_after = None;
            return;
        }
        if status.success() {
            self.restart_enabled = false;
            self.restart_after = None;
            return;
        }
        self.failures = self.failures.saturating_add(1).min(RESTART_DELAYS.len());
        let index = self
            .failures
            .saturating_sub(1)
            .min(RESTART_DELAYS.len() - 1);
        self.restart_after = Some(Instant::now() + RESTART_DELAYS[index]);
    }
}

pub fn start_launcher(executable: &Path) -> Result<(), &'static str> {
    if executable.file_name().and_then(|value| value.to_str()) != Some("AURUMBridge.Launcher.exe")
        || !executable.is_file()
    {
        return Err("bridge_ui_update_launcher_invalid");
    }
    Command::new(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|_| "bridge_ui_update_launcher_start_failed")
}

pub fn run_health_check(
    application_directory: &Path,
    arguments: &[OsString],
) -> Result<bool, &'static str> {
    let executable = resolve_core_executable(application_directory)?;
    let status = Command::new(executable)
        .args(arguments)
        .current_dir(application_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "bridge_ui_core_health_start_failed")?;
    Ok(status.success())
}

fn spawn_core(
    executable: &Path,
    working_directory: &Path,
    arguments: &[OsString],
) -> io::Result<Child> {
    Command::new(executable)
        .args(arguments)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

fn resolve_core_executable(application_directory: &Path) -> Result<PathBuf, &'static str> {
    let installed = application_directory.join(INSTALLED_CORE_FILE_NAME);
    if installed.is_file() {
        return Ok(installed);
    }
    if cfg!(debug_assertions) {
        let development = application_directory.join(DEVELOPMENT_CORE_FILE_NAME);
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("bridge_ui_core_executable_not_found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn installed_core_name_has_priority() {
        let root = temporary_directory("installed-priority");
        let installed = root.join(INSTALLED_CORE_FILE_NAME);
        let development = root.join(DEVELOPMENT_CORE_FILE_NAME);
        fs::write(&installed, []).expect("installed core");
        fs::write(&development, []).expect("development core");
        assert_eq!(resolve_core_executable(&root), Ok(installed));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn missing_core_fails_closed() {
        let root = temporary_directory("missing");
        assert_eq!(
            resolve_core_executable(&root),
            Err("bridge_ui_core_executable_not_found")
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn clean_core_exit_is_terminal_but_failure_is_scheduled_for_recovery() {
        let command = PathBuf::from(std::env::var_os("SystemRoot").expect("system root"))
            .join("System32")
            .join("cmd.exe");
        let success = Command::new(&command)
            .args(["/d", "/c", "exit", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .expect("successful child");
        let failure = Command::new(&command)
            .args(["/d", "/c", "exit", "7"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .expect("failed child");

        let mut clean_host = host_for_exit_policy(&command);
        clean_host.schedule_restart(success);
        assert!(!clean_host.restart_enabled);
        assert!(clean_host.restart_after.is_none());

        let mut failed_host = host_for_exit_policy(&command);
        failed_host.schedule_restart(failure);
        assert!(failed_host.restart_enabled);
        assert_eq!(failed_host.failures, 1);
        assert!(failed_host.restart_after.is_some());
    }

    #[test]
    fn clean_core_exit_hands_a_pending_version_to_its_verified_launcher() {
        let root = temporary_directory("update-handoff");
        let current = root.join("versions/3.0.0");
        let target = root.join("versions/3.1.0");
        fs::create_dir_all(&current).expect("current version");
        fs::create_dir_all(target.join("launcher")).expect("target version");
        fs::write(root.join("AURUMBridge.Launcher.exe"), []).expect("launcher");
        fs::write(target.join("AURUMBridge.exe"), []).expect("target UI");
        fs::write(target.join("launcher/AURUMBridge.Launcher.exe"), []).expect("target launcher");
        fs::write(
            root.join("current.json"),
            br#"{"active_version":"3.1.0","last_known_good_version":"3.0.0","status":"pending","expected_terminal_instance_ids":[],"updated_at_utc_msc":1800000000000}"#,
        )
        .expect("pointer");
        let command = PathBuf::from(std::env::var_os("SystemRoot").expect("system root"))
            .join("System32")
            .join("cmd.exe");
        let child = Command::new(&command)
            .args(["/d", "/c", "exit", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("clean child");
        let mut host = CoreProcessHost {
            executable: command,
            working_directory: current,
            arguments: Vec::new(),
            child: Some(child),
            failures: 0,
            restart_after: None,
            restart_enabled: true,
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match host.poll().expect("poll") {
                CoreProcessPoll::Running if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                CoreProcessPoll::UpdateHandoff(launcher) => {
                    assert_eq!(launcher, target.join("launcher/AURUMBridge.Launcher.exe"));
                    break;
                }
                outcome => panic!("unexpected poll outcome: {outcome:?}"),
            }
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn host_for_exit_policy(command: &Path) -> CoreProcessHost {
        CoreProcessHost {
            executable: command.to_path_buf(),
            working_directory: std::env::temp_dir(),
            arguments: Vec::new(),
            child: None,
            failures: 0,
            restart_after: None,
            restart_enabled: true,
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "liangjian-bridge-ui-core-host-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temporary directory");
        path
    }
}
