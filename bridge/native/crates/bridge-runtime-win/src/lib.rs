use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_FILE_NOT_FOUND, GetLastError, HANDLE, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_WRITE_THROUGH;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Registry::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_SZ,
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateEventW, SetEvent, WaitForMultipleObjects,
};

mod pipe_security;
pub use pipe_security::CurrentUserPipeSecurity;

const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(100);
const AUTOSTART_VALUE_NAME: &str = "AURUMBridge";
const AUTOSTART_RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STABLE_LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
const MACHINE_GUID_KEY: &str = "SOFTWARE\\Microsoft\\Cryptography";
const MACHINE_GUID_VALUE: &str = "MachineGuid";

pub fn machine_guid() -> Result<String, RuntimeError> {
    let path = wide_string(MACHINE_GUID_KEY);
    let mut key = null_mut();
    let mut result = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if result != 0 || key.is_null() {
        key = null_mut();
        result = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                path.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            )
        };
    }
    if result != 0 || key.is_null() {
        return Err(RuntimeError::windows_code(
            "bridge_machine_guid_unavailable",
            result,
        ));
    }
    let key = RegistryKey(key);
    let value = read_registry_string(key.0, &wide_string(MACHINE_GUID_VALUE))
        .map_err(|_| RuntimeError::new("bridge_machine_guid_unavailable"))?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeError::new("bridge_machine_guid_unavailable"))?;
    Ok(value)
}

pub struct AutoStartRegistration;

impl AutoStartRegistration {
    pub fn ensure_for_installed_application(
        application_directory: impl AsRef<Path>,
        enabled: bool,
    ) -> Result<bool, RuntimeError> {
        if !enabled {
            return Self::disable();
        }
        let Some(launcher) = resolve_stable_launcher(application_directory.as_ref()) else {
            return Ok(false);
        };
        write_autostart_command(&build_autostart_command(&launcher))
    }

    pub fn set_enabled_for_installed_application(
        application_directory: impl AsRef<Path>,
        enabled: bool,
    ) -> Result<bool, RuntimeError> {
        if !enabled {
            return Self::disable();
        }
        let launcher = resolve_stable_launcher(application_directory.as_ref())
            .ok_or_else(|| RuntimeError::new("bridge_autostart_launcher_unavailable"))?;
        write_autostart_command(&build_autostart_command(&launcher))
    }

    pub fn disable() -> Result<bool, RuntimeError> {
        let key = open_run_key(KEY_QUERY_VALUE | KEY_SET_VALUE, false)?;
        let Some(key) = key else {
            return Ok(false);
        };
        let value_name = wide_string(AUTOSTART_VALUE_NAME);
        let existing = read_registry_string(key.0, &value_name)?;
        if existing.is_none() {
            return Ok(false);
        }
        let deleted = unsafe { RegDeleteValueW(key.0, value_name.as_ptr()) };
        if deleted != 0 {
            return Err(RuntimeError::windows_code(
                "bridge_autostart_registry_write_failed",
                deleted,
            ));
        }
        Ok(true)
    }
}

fn resolve_stable_launcher(application_directory: &Path) -> Option<PathBuf> {
    let version_directory = fs::canonicalize(application_directory).ok()?;
    let version = version_directory.file_name()?.to_str()?;
    if !is_version_directory_name(version) {
        return None;
    }
    let versions_directory = version_directory.parent()?;
    if !versions_directory
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case("versions")
    {
        return None;
    }
    let launcher = versions_directory.parent()?.join(STABLE_LAUNCHER_FILE_NAME);
    launcher.is_file().then_some(launcher)
}

fn is_version_directory_name(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn build_autostart_command(launcher: &Path) -> String {
    format!("\"{}\" --autostart", launcher.display())
}

fn write_autostart_command(command: &str) -> Result<bool, RuntimeError> {
    let key = open_run_key(KEY_QUERY_VALUE | KEY_SET_VALUE, true)?
        .ok_or_else(|| RuntimeError::new("bridge_autostart_registry_unavailable"))?;
    let value_name = wide_string(AUTOSTART_VALUE_NAME);
    if read_registry_string(key.0, &value_name)?.as_deref() == Some(command) {
        return Ok(false);
    }
    let payload = wide_string(command);
    let bytes = u32::try_from(payload.len().saturating_mul(std::mem::size_of::<u16>()))
        .map_err(|_| RuntimeError::new("bridge_autostart_registry_write_failed"))?;
    let written = unsafe {
        RegSetValueExW(
            key.0,
            value_name.as_ptr(),
            0,
            REG_SZ,
            payload.as_ptr().cast(),
            bytes,
        )
    };
    if written != 0 {
        return Err(RuntimeError::windows_code(
            "bridge_autostart_registry_write_failed",
            written,
        ));
    }
    Ok(true)
}

fn open_run_key(access: u32, create: bool) -> Result<Option<RegistryKey>, RuntimeError> {
    let path = wide_string(AUTOSTART_RUN_KEY);
    let mut key = std::ptr::null_mut();
    let result = if create {
        let mut disposition = 0;
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                null_mut(),
                0,
                access,
                null(),
                &mut key,
                &mut disposition,
            )
        }
    } else {
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut key) }
    };
    if result == ERROR_FILE_NOT_FOUND && !create {
        return Ok(None);
    }
    if result != 0 || key.is_null() {
        return Err(RuntimeError::windows_code(
            "bridge_autostart_registry_unavailable",
            result,
        ));
    }
    Ok(Some(RegistryKey(key)))
}

fn read_registry_string(
    key: windows_sys::Win32::System::Registry::HKEY,
    value_name: &[u16],
) -> Result<Option<String>, RuntimeError> {
    let mut value_type = 0;
    let mut size = 0;
    let measured = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            null_mut(),
            &mut value_type,
            null_mut(),
            &mut size,
        )
    };
    if measured == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if measured != 0 {
        return Err(RuntimeError::windows_code(
            "bridge_autostart_registry_read_failed",
            measured,
        ));
    }
    if value_type != REG_SZ || size == 0 || size > 32 * 1024 || size % 2 != 0 {
        return Err(RuntimeError::new("bridge_autostart_registry_read_failed"));
    }
    let mut buffer = vec![0_u16; size as usize / std::mem::size_of::<u16>()];
    let read = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            null_mut(),
            &mut value_type,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if read != 0 {
        return Err(RuntimeError::windows_code(
            "bridge_autostart_registry_read_failed",
            read,
        ));
    }
    if value_type != REG_SZ || size == 0 || size % 2 != 0 {
        return Err(RuntimeError::new("bridge_autostart_registry_read_failed"));
    }
    buffer.truncate(size as usize / std::mem::size_of::<u16>());
    if buffer.last() == Some(&0) {
        buffer.pop();
    }
    String::from_utf16(&buffer)
        .map(Some)
        .map_err(|_| RuntimeError::new("bridge_autostart_registry_read_failed"))
}

struct RegistryKey(windows_sys::Win32::System::Registry::HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}

fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeError {
    code: &'static str,
    windows_error: Option<u32>,
}

impl RuntimeError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(code: &'static str) -> Self {
        Self {
            code,
            windows_error: None,
        }
    }

    fn windows(code: &'static str) -> Self {
        Self {
            code,
            // SAFETY: GetLastError has no preconditions and is read immediately after failure.
            windows_error: Some(unsafe { GetLastError() }),
        }
    }

    fn windows_code(code: &'static str, windows_error: u32) -> Self {
        Self {
            code,
            windows_error: Some(windows_error),
        }
    }
}

impl Display for RuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self.windows_error {
            Some(value) => write!(formatter, "{} (win32={value})", self.code),
            None => formatter.write_str(self.code),
        }
    }
}

impl Error for RuntimeError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstanceSignal {
    Activation,
    Shutdown,
    Timeout,
}

pub enum InstanceAcquireResult {
    Acquired(SingleInstanceGuard),
    Duplicate,
}

pub struct SingleInstanceGuard {
    _lock_file: File,
    activation_event: OwnedHandle,
    shutdown_event: OwnedHandle,
}

impl SingleInstanceGuard {
    pub fn try_acquire(
        instance_id: &str,
        lock_directory: impl AsRef<Path>,
        activate_existing: bool,
    ) -> Result<InstanceAcquireResult, RuntimeError> {
        validate_instance_id(instance_id)?;
        let lock_directory = absolute_path(
            lock_directory.as_ref(),
            "bridge_instance_lock_directory_invalid",
        )?;
        fs::create_dir_all(&lock_directory)
            .map_err(|_| RuntimeError::new("bridge_instance_lock_directory_failed"))?;
        let activation_event = OwnedHandle::event(&format!("Local\\{instance_id}.activate"))?;
        let shutdown_event = OwnedHandle::event(&format!("Local\\{instance_id}.shutdown"))?;
        let lock_path = lock_directory.join(format!("{instance_id}.lock"));
        match OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_WRITE_THROUGH)
            .open(lock_path)
        {
            Ok(lock_file) => Ok(InstanceAcquireResult::Acquired(Self {
                _lock_file: lock_file,
                activation_event,
                shutdown_event,
            })),
            Err(error) if is_lock_contention(&error) => {
                if activate_existing {
                    activation_event.set()?;
                }
                Ok(InstanceAcquireResult::Duplicate)
            }
            Err(_) => Err(RuntimeError::new("bridge_instance_lock_failed")),
        }
    }

    pub fn wait_for_signal(&self, timeout: Duration) -> Result<InstanceSignal, RuntimeError> {
        let milliseconds = duration_to_wait_milliseconds(timeout);
        let handles = [self.activation_event.raw(), self.shutdown_event.raw()];
        // SAFETY: both handles are valid for this guard's lifetime and the array has two entries.
        let result = unsafe {
            WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, milliseconds)
        };
        match result {
            WAIT_OBJECT_0 => Ok(InstanceSignal::Activation),
            value if value == WAIT_OBJECT_0 + 1 => Ok(InstanceSignal::Shutdown),
            WAIT_TIMEOUT => Ok(InstanceSignal::Timeout),
            WAIT_FAILED => Err(RuntimeError::windows("bridge_instance_wait_failed")),
            _ => Err(RuntimeError::new("bridge_instance_wait_invalid")),
        }
    }

    pub fn request_shutdown(instance_id: &str) -> Result<(), RuntimeError> {
        validate_instance_id(instance_id)?;
        OwnedHandle::event(&format!("Local\\{instance_id}.shutdown"))?.set()
    }

    pub fn is_running(
        instance_id: &str,
        lock_directory: impl AsRef<Path>,
    ) -> Result<bool, RuntimeError> {
        validate_instance_id(instance_id)?;
        let lock_directory = absolute_path(
            lock_directory.as_ref(),
            "bridge_instance_lock_directory_invalid",
        )?;
        fs::create_dir_all(&lock_directory)
            .map_err(|_| RuntimeError::new("bridge_instance_lock_directory_failed"))?;
        match OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_WRITE_THROUGH)
            .open(lock_directory.join(format!("{instance_id}.lock")))
        {
            Ok(_) => Ok(false),
            Err(error) if is_lock_contention(&error) => Ok(true),
            Err(_) => Err(RuntimeError::new("bridge_instance_lock_failed")),
        }
    }

    pub fn wait_for_release(
        instance_id: &str,
        lock_directory: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<bool, RuntimeError> {
        if timeout.is_zero() {
            return Err(RuntimeError::new("bridge_instance_timeout_invalid"));
        }
        let deadline = Instant::now() + timeout;
        while Self::is_running(instance_id, &lock_directory)? {
            if Instant::now() >= deadline {
                return Ok(false);
            }
            thread::sleep(
                LOCK_RETRY_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        Ok(true)
    }
}

pub fn default_lock_directory() -> Result<PathBuf, RuntimeError> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| RuntimeError::new("bridge_local_appdata_unavailable"))?;
    absolute_path(
        &PathBuf::from(local_app_data)
            .join("AURUMBridge")
            .join("locks"),
        "bridge_instance_lock_directory_invalid",
    )
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn event(name: &str) -> Result<Self, RuntimeError> {
        let name = wide_null(OsStr::new(name));
        // SAFETY: the name is null terminated, security attributes are absent, and the returned
        // handle is owned by OwnedHandle. Auto-reset matches the current V3 EventWaitHandle.
        let handle = unsafe { CreateEventW(null(), 0, 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(RuntimeError::windows("bridge_instance_event_failed"));
        }
        Ok(Self(handle))
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn set(&self) -> Result<(), RuntimeError> {
        // SAFETY: this object owns a valid event handle.
        if unsafe { SetEvent(self.0) } == 0 {
            return Err(RuntimeError::windows("bridge_instance_signal_failed"));
        }
        Ok(())
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this object exclusively owns the handle.
            unsafe { CloseHandle(self.0) };
            self.0 = std::ptr::null_mut();
        }
    }
}

// Windows event handles are kernel objects that may be waited and signaled across threads.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessState {
    Starting,
    Running,
    Restarting,
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessEvent {
    pub state: ProcessState,
    pub consecutive_failures: u32,
    pub error_code: Option<&'static str>,
    pub process_id: Option<u32>,
    pub exit_code: Option<i32>,
}

#[derive(Clone)]
pub struct ProcessSpec {
    executable: PathBuf,
    arguments: Vec<OsString>,
    working_directory: PathBuf,
    environment: Vec<(OsString, OsString)>,
    no_window: bool,
}

impl ProcessSpec {
    pub fn new(
        executable: impl AsRef<Path>,
        working_directory: impl AsRef<Path>,
    ) -> Result<Self, RuntimeError> {
        let executable = absolute_path(executable.as_ref(), "bridge_worker_path_invalid")?;
        let working_directory = absolute_path(
            working_directory.as_ref(),
            "bridge_worker_directory_invalid",
        )?;
        if !executable.is_file() {
            return Err(RuntimeError::new("bridge_worker_executable_not_found"));
        }
        if !working_directory.is_dir() {
            return Err(RuntimeError::new("bridge_worker_directory_not_found"));
        }
        Ok(Self {
            executable,
            arguments: Vec::new(),
            working_directory,
            environment: Vec::new(),
            no_window: true,
        })
    }

    pub fn arg(mut self, value: impl Into<OsString>) -> Self {
        self.arguments.push(value.into());
        self
    }

    pub fn env(
        mut self,
        name: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> Result<Self, RuntimeError> {
        let name = name.into();
        if name.is_empty() || name.to_string_lossy().contains('=') {
            return Err(RuntimeError::new("bridge_worker_environment_invalid"));
        }
        self.environment.push((name, value.into()));
        Ok(self)
    }

    pub fn show_window(mut self, show_window: bool) -> Self {
        self.no_window = !show_window;
        self
    }
}

#[derive(Clone, Debug)]
pub struct RestartPolicy {
    pub stable_run_threshold: Duration,
    pub poll_interval: Duration,
    pub restart_delays: [Duration; 5],
    pub maximum_failure_counter: u32,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            stable_run_threshold: Duration::from_secs(30),
            poll_interval: Duration::from_millis(100),
            restart_delays: [
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(10),
            ],
            maximum_failure_counter: 8,
        }
    }
}

impl RestartPolicy {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.stable_run_threshold.is_zero()
            || self.poll_interval.is_zero()
            || self.restart_delays.iter().any(Duration::is_zero)
            || !(1..=100).contains(&self.maximum_failure_counter)
        {
            return Err(RuntimeError::new("bridge_worker_restart_policy_invalid"));
        }
        Ok(())
    }

    pub fn restart_delay(&self, consecutive_failures: u32) -> Duration {
        let index = consecutive_failures.saturating_sub(1).min(4) as usize;
        self.restart_delays[index]
    }
}

#[derive(Clone)]
pub struct ProcessSupervisorHandle {
    stop: Arc<AtomicBool>,
    graceful_stop: Arc<AtomicBool>,
}

impl ProcessSupervisorHandle {
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    pub fn stop_requested(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    pub fn request_graceful_stop(&self) {
        self.graceful_stop.store(true, Ordering::Release);
    }

    pub fn graceful_stop_requested(&self) -> bool {
        self.graceful_stop.load(Ordering::Acquire)
    }
}

pub struct ProcessSupervisor {
    spec: ProcessSpec,
    policy: RestartPolicy,
    stop: Arc<AtomicBool>,
    graceful_stop: Arc<AtomicBool>,
    started: AtomicBool,
}

impl ProcessSupervisor {
    pub fn new(spec: ProcessSpec, policy: RestartPolicy) -> Result<Self, RuntimeError> {
        policy.validate()?;
        Ok(Self {
            spec,
            policy,
            stop: Arc::new(AtomicBool::new(false)),
            graceful_stop: Arc::new(AtomicBool::new(false)),
            started: AtomicBool::new(false),
        })
    }

    pub fn handle(&self) -> ProcessSupervisorHandle {
        ProcessSupervisorHandle {
            stop: Arc::clone(&self.stop),
            graceful_stop: Arc::clone(&self.graceful_stop),
        }
    }

    pub fn run(&self, events: Option<&Sender<ProcessEvent>>) -> Result<(), RuntimeError> {
        if self.started.swap(true, Ordering::AcqRel) {
            return Err(RuntimeError::new(
                "bridge_worker_supervisor_already_running",
            ));
        }
        let mut failures = 0u32;
        while !self.stop.load(Ordering::Acquire) && !self.graceful_stop.load(Ordering::Acquire) {
            send_event(
                events,
                ProcessEvent {
                    state: if failures == 0 {
                        ProcessState::Starting
                    } else {
                        ProcessState::Restarting
                    },
                    consecutive_failures: failures,
                    error_code: None,
                    process_id: None,
                    exit_code: None,
                },
            );
            let mut managed = match ManagedProcess::spawn(&self.spec) {
                Ok(child) => child,
                Err(error) => {
                    failures = increment_failures(failures, self.policy.maximum_failure_counter);
                    send_event(
                        events,
                        ProcessEvent {
                            state: ProcessState::Restarting,
                            consecutive_failures: failures,
                            error_code: Some(error.code()),
                            process_id: None,
                            exit_code: None,
                        },
                    );
                    self.wait_before_restart(failures);
                    continue;
                }
            };
            let process_id = managed.id();
            send_event(
                events,
                ProcessEvent {
                    state: ProcessState::Running,
                    consecutive_failures: failures,
                    error_code: None,
                    process_id: Some(process_id),
                    exit_code: None,
                },
            );
            let started_at = Instant::now();
            let mut stable_budget_reset = false;
            let failure = loop {
                if self.stop.load(Ordering::Acquire) {
                    managed.terminate()?;
                    break None;
                }
                match managed.try_wait() {
                    Ok(Some(status)) => {
                        if self.graceful_stop.load(Ordering::Acquire) {
                            break None;
                        }
                        if started_at.elapsed() >= self.policy.stable_run_threshold {
                            failures = 0;
                        }
                        break Some(("bridge_worker_process_exited", exit_code(status)));
                    }
                    Ok(None) => {
                        if !stable_budget_reset
                            && started_at.elapsed() >= self.policy.stable_run_threshold
                        {
                            failures = 0;
                            stable_budget_reset = true;
                            send_event(
                                events,
                                ProcessEvent {
                                    state: ProcessState::Running,
                                    consecutive_failures: 0,
                                    error_code: None,
                                    process_id: Some(process_id),
                                    exit_code: None,
                                },
                            );
                        }
                        thread::sleep(self.policy.poll_interval);
                    }
                    Err(error) => break Some((error.code(), None)),
                }
            };
            let Some((error_code, exit_code)) = failure else {
                break;
            };
            failures = increment_failures(failures, self.policy.maximum_failure_counter);
            send_event(
                events,
                ProcessEvent {
                    state: ProcessState::Restarting,
                    consecutive_failures: failures,
                    error_code: Some(error_code),
                    process_id: Some(process_id),
                    exit_code,
                },
            );
            self.wait_before_restart(failures);
        }
        send_event(
            events,
            ProcessEvent {
                state: ProcessState::Stopped,
                consecutive_failures: failures,
                error_code: None,
                process_id: None,
                exit_code: None,
            },
        );
        Ok(())
    }

    fn wait_before_restart(&self, failures: u32) {
        let deadline = Instant::now() + self.policy.restart_delay(failures);
        while !self.stop.load(Ordering::Acquire)
            && !self.graceful_stop.load(Ordering::Acquire)
            && Instant::now() < deadline
        {
            thread::sleep(
                self.policy
                    .poll_interval
                    .min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
}

pub struct ManagedProcess {
    child: Child,
    job: KillOnCloseJob,
}

/// The small amount of process state that callers need for diagnostics.
///
/// Child output intentionally remains attached to the null device. Worker output can contain
/// broker/account details (and Python tracebacks can contain local paths), so the runtime reports
/// only the exit classification and optional platform exit code instead of forwarding raw output
/// into Bridge logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedProcessState {
    Running,
    Exited { exit_code: Option<i32> },
}

impl ManagedProcess {
    pub fn spawn(spec: &ProcessSpec) -> Result<Self, RuntimeError> {
        let job = KillOnCloseJob::new()?;
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.arguments)
            .current_dir(&spec.working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .envs(spec.environment.iter().cloned());
        if spec.no_window {
            std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|_| RuntimeError::new("bridge_worker_process_start_failed"))?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self { child, job })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, RuntimeError> {
        self.child
            .try_wait()
            .map_err(|_| RuntimeError::new("bridge_worker_process_wait_failed"))
    }

    /// Polls the child without exposing stdout/stderr contents to callers.
    pub fn state(&mut self) -> Result<ManagedProcessState, RuntimeError> {
        Ok(match self.try_wait()? {
            Some(status) => ManagedProcessState::Exited {
                exit_code: exit_code(status),
            },
            None => ManagedProcessState::Running,
        })
    }

    pub fn terminate(&mut self) -> Result<(), RuntimeError> {
        if self.try_wait()?.is_none() {
            self.job.terminate()?;
            self.child
                .wait()
                .map_err(|_| RuntimeError::new("bridge_worker_process_wait_failed"))?;
        }
        Ok(())
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

struct KillOnCloseJob(HANDLE);

impl KillOnCloseJob {
    fn new() -> Result<Self, RuntimeError> {
        // SAFETY: no security attributes or global name are supplied; returned handle is owned.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(RuntimeError::windows("bridge_worker_job_create_failed"));
        }
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        // SAFETY: limits points to the expected structure for this information class.
        let succeeded = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if succeeded == 0 {
            return Err(RuntimeError::windows("bridge_worker_job_configure_failed"));
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> Result<(), RuntimeError> {
        let process_handle = child.as_raw_handle().cast();
        // SAFETY: both the job handle and child process handle are valid.
        if unsafe { AssignProcessToJobObject(self.0, process_handle) } == 0 {
            return Err(RuntimeError::windows("bridge_worker_job_assign_failed"));
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), RuntimeError> {
        // SAFETY: this object owns a valid job handle.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(RuntimeError::windows("bridge_worker_job_terminate_failed"));
        }
        Ok(())
    }
}

// Windows kernel handles may be used and closed from any thread.
unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this object exclusively owns the job handle.
            unsafe { CloseHandle(self.0) };
            self.0 = std::ptr::null_mut();
        }
    }
}

fn send_event(sender: Option<&Sender<ProcessEvent>>, event: ProcessEvent) {
    if let Some(sender) = sender {
        let _ = sender.send(event);
    }
}

fn increment_failures(current: u32, maximum: u32) -> u32 {
    current.saturating_add(1).min(maximum)
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    status.code()
}

fn validate_instance_id(instance_id: &str) -> Result<(), RuntimeError> {
    if instance_id.is_empty()
        || instance_id.len() > 96
        || !instance_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(RuntimeError::new("bridge_instance_id_invalid"));
    }
    Ok(())
}

fn absolute_path(path: &Path, error_code: &'static str) -> Result<PathBuf, RuntimeError> {
    if path.as_os_str().is_empty() {
        return Err(RuntimeError::new(error_code));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|_| RuntimeError::new(error_code))
    }
}

fn is_lock_contention(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32 | 33))
}

fn duration_to_wait_milliseconds(timeout: Duration) -> u32 {
    timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn duplicate_instance_signals_the_existing_owner() {
        let root = unique_test_directory("instance-activation");
        let instance_id = unique_instance_id("activation");
        let owner = match SingleInstanceGuard::try_acquire(&instance_id, &root, true)
            .expect("owner acquisition")
        {
            InstanceAcquireResult::Acquired(owner) => owner,
            InstanceAcquireResult::Duplicate => panic!("first instance must own the lock"),
        };
        assert!(SingleInstanceGuard::is_running(&instance_id, &root).expect("running state"));
        let duplicate = SingleInstanceGuard::try_acquire(&instance_id, &root, true)
            .expect("duplicate acquisition");
        assert!(matches!(duplicate, InstanceAcquireResult::Duplicate));
        assert_eq!(
            owner
                .wait_for_signal(Duration::from_secs(2))
                .expect("activation signal"),
            InstanceSignal::Activation
        );
        drop(owner);
        assert!(!SingleInstanceGuard::is_running(&instance_id, &root).expect("released state"));
        fs::remove_dir_all(root).expect("remove instance fixture");
    }

    #[test]
    fn silent_duplicate_does_not_activate_the_owner_and_shutdown_is_coordinated() {
        let root = unique_test_directory("instance-shutdown");
        let instance_id = unique_instance_id("shutdown");
        let owner = match SingleInstanceGuard::try_acquire(&instance_id, &root, true)
            .expect("owner acquisition")
        {
            InstanceAcquireResult::Acquired(owner) => owner,
            InstanceAcquireResult::Duplicate => panic!("first instance must own the lock"),
        };
        let duplicate =
            SingleInstanceGuard::try_acquire(&instance_id, &root, false).expect("silent duplicate");
        assert!(matches!(duplicate, InstanceAcquireResult::Duplicate));
        assert_eq!(
            owner
                .wait_for_signal(Duration::from_millis(100))
                .expect("silent timeout"),
            InstanceSignal::Timeout
        );
        SingleInstanceGuard::request_shutdown(&instance_id).expect("shutdown signal");
        assert_eq!(
            owner
                .wait_for_signal(Duration::from_secs(2))
                .expect("shutdown wait"),
            InstanceSignal::Shutdown
        );
        drop(owner);
        assert!(
            SingleInstanceGuard::wait_for_release(&instance_id, &root, Duration::from_secs(1))
                .expect("release wait")
        );
        fs::remove_dir_all(root).expect("remove instance fixture");
    }

    #[test]
    fn restart_policy_matches_v3_and_caps_the_counter_without_stopping_retries() {
        let policy = RestartPolicy::default();
        assert_eq!(
            (1..=7)
                .map(|failure| policy.restart_delay(failure).as_secs())
                .collect::<Vec<_>>(),
            vec![1, 2, 4, 8, 10, 10, 10]
        );
        let mut failures = 0;
        for _ in 0..20 {
            failures = increment_failures(failures, policy.maximum_failure_counter);
        }
        assert_eq!(failures, 8);
    }

    #[test]
    fn supervisor_restarts_real_failed_processes_until_stopped() {
        let spec = ProcessSpec::new(command_interpreter(), std::env::temp_dir())
            .expect("process spec")
            .arg("/D")
            .arg("/C")
            .arg("exit /B 7");
        let policy = RestartPolicy {
            // A process that exits immediately must never be reclassified as stable merely
            // because a loaded CI host took longer than a few milliseconds to observe it.
            stable_run_threshold: Duration::from_secs(5),
            poll_interval: Duration::from_millis(1),
            restart_delays: [Duration::from_millis(1); 5],
            maximum_failure_counter: 3,
        };
        let supervisor = Arc::new(ProcessSupervisor::new(spec, policy).expect("supervisor"));
        let handle = supervisor.handle();
        let (sender, receiver) = mpsc::channel();
        let running = Arc::clone(&supervisor);
        let thread = thread::spawn(move || running.run(Some(&sender)));

        let mut restarted = 0;
        let mut stopped_failures = None;
        while let Ok(event) = receiver.recv_timeout(Duration::from_secs(5)) {
            if event.state == ProcessState::Restarting && event.error_code.is_some() {
                restarted += 1;
                assert_eq!(event.exit_code, Some(7));
                if restarted == 3 {
                    handle.request_stop();
                }
            }
            if event.state == ProcessState::Stopped {
                stopped_failures = Some(event.consecutive_failures);
                break;
            }
        }
        thread
            .join()
            .expect("supervisor thread")
            .expect("supervisor run");
        assert_eq!(restarted, 3);
        assert_eq!(stopped_failures, Some(3));
        assert!(handle.stop_requested());
    }

    #[test]
    fn graceful_supervisor_stop_waits_for_the_child_and_suppresses_restart() {
        let spec = ProcessSpec::new(command_interpreter(), std::env::temp_dir())
            .expect("process spec")
            .arg("/D")
            .arg("/C")
            .arg("ping -n 2 127.0.0.1 >NUL");
        let policy = RestartPolicy {
            stable_run_threshold: Duration::from_millis(50),
            poll_interval: Duration::from_millis(5),
            restart_delays: [Duration::from_millis(5); 5],
            maximum_failure_counter: 3,
        };
        let supervisor = Arc::new(ProcessSupervisor::new(spec, policy).expect("supervisor"));
        let handle = supervisor.handle();
        let (sender, receiver) = mpsc::channel();
        let running = Arc::clone(&supervisor);
        let thread = thread::spawn(move || running.run(Some(&sender)));

        let mut process_ids = Vec::new();
        let mut restarting_events = 0;
        while let Ok(event) = receiver.recv_timeout(Duration::from_secs(5)) {
            match event.state {
                ProcessState::Running => {
                    let process_id = event.process_id.expect("running process id");
                    if !process_ids.contains(&process_id) {
                        process_ids.push(process_id);
                    }
                    handle.request_graceful_stop();
                }
                ProcessState::Restarting => restarting_events += 1,
                ProcessState::Stopped => break,
                ProcessState::Starting => {}
            }
        }
        thread
            .join()
            .expect("supervisor thread")
            .expect("supervisor run");
        assert_eq!(process_ids.len(), 1);
        assert_eq!(restarting_events, 0);
        assert!(handle.graceful_stop_requested());
        assert!(!handle.stop_requested());
    }

    #[test]
    fn managed_child_is_terminated_with_its_kill_on_close_job() {
        let spec = ProcessSpec::new(command_interpreter(), std::env::temp_dir())
            .expect("process spec")
            .arg("/D")
            .arg("/C")
            .arg("ping -n 30 127.0.0.1 >NUL");
        let mut child = ManagedProcess::spawn(&spec).expect("managed child");
        assert_eq!(
            child.state().expect("initial state"),
            ManagedProcessState::Running
        );
        child.terminate().expect("terminate job");
        assert!(matches!(
            child.state().expect("final state"),
            ManagedProcessState::Exited { .. }
        ));
    }

    #[test]
    fn autostart_resolves_the_same_stable_launcher_layout_as_dotnet() {
        let root = unique_test_directory("autostart-layout");
        let version_directory = root.join("versions").join("3.0.0");
        fs::create_dir_all(&version_directory).expect("version directory");
        let launcher = root.join(STABLE_LAUNCHER_FILE_NAME);
        fs::write(&launcher, b"fixture").expect("launcher fixture");
        let resolved = resolve_stable_launcher(&version_directory).expect("stable launcher");
        assert_eq!(
            resolved,
            fs::canonicalize(&launcher).expect("canonical launcher")
        );
        assert_eq!(
            build_autostart_command(&resolved),
            format!("\"{}\" --autostart", resolved.display())
        );
        assert!(is_version_directory_name("3.0"));
        assert!(is_version_directory_name("3.0.0.1"));
        assert!(!is_version_directory_name("3.0.0-alpha"));
        fs::remove_dir_all(root).expect("remove autostart fixture");
    }

    fn command_interpreter() -> PathBuf {
        PathBuf::from(std::env::var_os("ComSpec").expect("ComSpec"))
    }

    fn unique_instance_id(suffix: &str) -> String {
        format!(
            "AURUMBridge.native.test.{}.{}.{suffix}",
            std::process::id(),
            UNIQUE_TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    static UNIQUE_TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-runtime-{}-{stamp}-{suffix}",
            std::process::id()
        ))
    }
}
