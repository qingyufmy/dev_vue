use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use bridge_contract::AccountRef;
use serde::Deserialize;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FFI_SIGNATURE, VS_FIXEDFILEINFO,
    VerQueryValueW,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    REG_SZ, RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
};

use crate::observer_terminal::mt5_terminal_instance_id;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_PROBE_OUTPUT_BYTES: u64 = 16 * 1024;
const MAX_PROCESS_PATH_CHARS: usize = 32_768;
const MAX_REGISTRY_PATH_BYTES: u32 = 64 * 1024;
const MAX_VERSION_INFO_BYTES: u32 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Mt5Installation {
    pub executable_path: PathBuf,
    pub terminal_instance_id: String,
    pub is_running: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Mt5InstallationCandidate {
    path: PathBuf,
    is_running: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Mt5ProbeResult {
    pub executable_path: PathBuf,
    pub account_ref: AccountRef,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Mt5ProbeFailure {
    pub code: String,
    pub last_error: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Mt5ProbeDocument {
    probe_version: u32,
    terminal_path: String,
    #[serde(default)]
    account_ref: Option<AccountRef>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    last_error: Option<i64>,
}

pub(crate) fn discover_windows() -> Vec<Mt5Installation> {
    let mut candidates = running_terminal_paths()
        .into_iter()
        .filter(|path| is_running_mt5_candidate(path))
        .map(|path| Mt5InstallationCandidate {
            path,
            is_running: true,
        })
        .collect::<Vec<_>>();
    candidates.extend(registry_candidates());
    candidates.extend(metaquotes_data_candidates());
    resolve_candidates(candidates)
}

pub(crate) fn selected_or_discovered(selected_terminal_path: Option<&str>) -> Vec<Mt5Installation> {
    if let Some(path) = selected_terminal_path.filter(|value| !value.trim().is_empty()) {
        return resolve_candidates([Mt5InstallationCandidate {
            path: PathBuf::from(path),
            is_running: running_terminal_paths()
                .iter()
                .any(|running| paths_equal(running, Path::new(path))),
        }]);
    }
    discover_windows()
}

pub(crate) fn probe_terminal(
    python_executable: &Path,
    worker_script: &Path,
    terminal_executable: &Path,
    timeout: Duration,
) -> Result<Mt5ProbeResult, Mt5ProbeFailure> {
    if !python_executable.is_file() {
        return Err(probe_failure("mt5_python_runtime_not_found", None));
    }
    if !worker_script.is_file() {
        return Err(probe_failure("mt5_worker_script_not_found", None));
    }
    if !terminal_executable.is_file() {
        return Err(probe_failure("mt5_terminal_not_found", None));
    }
    let expected_path = absolute(terminal_executable)
        .ok_or_else(|| probe_failure("mt5_terminal_not_found", None))?;
    let previous_foreground = capture_foreground_window();
    let result = (|| {
        let mut child = Command::new(python_executable)
            .arg("-B")
            .arg(worker_script)
            .arg("--probe")
            .arg("--terminal")
            .arg(&expected_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|_| probe_failure("mt5_probe_process_start_failed", None))?;

        // Drain both streams while the process is running.  The worker's
        // structured error stays on stdout, while stderr remains bounded and
        // is never copied into UI text or logs.
        let stdout_reader = child
            .stdout
            .take()
            .map(|stdout| thread::spawn(move || read_probe_stream(stdout)));
        let stderr_reader = child
            .stderr
            .take()
            .map(|stderr| thread::spawn(move || read_probe_stream(stderr)));
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    join_probe_stream(stdout_reader)?;
                    join_probe_stream(stderr_reader)?;
                    return Err(probe_failure("mt5_probe_timeout", None));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    join_probe_stream(stdout_reader)?;
                    join_probe_stream(stderr_reader)?;
                    return Err(probe_failure("mt5_probe_failed", None));
                }
            }
        };
        let output = join_probe_stream(stdout_reader)?;
        // Reading stderr is intentional even though its content is discarded;
        // this avoids dropping the pipe and lets the structured stdout error
        // be used for stable failure classification.
        let _stderr = join_probe_stream(stderr_reader)?;
        if output.is_empty() || output.len() as u64 > MAX_PROBE_OUTPUT_BYTES {
            return Err(probe_failure("mt5_probe_response_invalid", None));
        }
        let document = serde_json::from_slice::<Mt5ProbeDocument>(&output)
            .map_err(|_| probe_failure("mt5_probe_response_invalid", None))?;
        if document.probe_version != 1
            || !paths_equal(&expected_path, Path::new(&document.terminal_path))
        {
            return Err(probe_failure(
                "mt5_probe_identity_mismatch",
                document.last_error,
            ));
        }
        if let Some(error_code) = document.error_code.as_deref() {
            return Err(probe_failure(
                normalize_probe_error_code(error_code).unwrap_or("mt5_probe_failed"),
                document.last_error,
            ));
        }
        let last_error = document.last_error;
        let account_ref = document
            .account_ref
            .filter(|account| account.validate().is_ok())
            .ok_or_else(|| probe_failure("mt5_probe_identity_mismatch", last_error))?;
        if !status.success() {
            return Err(probe_failure("mt5_probe_failed", last_error));
        }
        Ok(Mt5ProbeResult {
            executable_path: expected_path.clone(),
            account_ref,
        })
    })();
    restore_foreground_window_if_probe_active(previous_foreground, &expected_path);
    result
}

fn probe_failure(code: &str, last_error: Option<i64>) -> Mt5ProbeFailure {
    Mt5ProbeFailure {
        code: code.to_owned(),
        last_error,
    }
}

fn normalize_probe_error_code(code: &str) -> Option<&'static str> {
    match code {
        "terminal_not_found" | "mt5_terminal_not_found" => Some("mt5_terminal_not_found"),
        "terminal_not_running" | "mt5_terminal_not_running" => Some("mt5_terminal_not_running"),
        "initialize_failed" | "mt5_initialize_failed" => Some("mt5_initialize_failed"),
        "account_unavailable" | "mt5_account_unavailable" => Some("mt5_account_unavailable"),
        "disconnected" | "terminal_disconnected" | "mt5_terminal_disconnected" => {
            Some("mt5_terminal_disconnected")
        }
        _ => None,
    }
}

fn read_probe_stream(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4 * 1024];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = (MAX_PROBE_OUTPUT_BYTES as usize + 1).saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    }
    Ok(output)
}

fn join_probe_stream(
    reader: Option<thread::JoinHandle<std::io::Result<Vec<u8>>>>,
) -> Result<Vec<u8>, Mt5ProbeFailure> {
    reader
        .ok_or_else(|| probe_failure("mt5_probe_response_invalid", None))?
        .join()
        .map_err(|_| probe_failure("mt5_probe_response_invalid", None))?
        .map_err(|_| probe_failure("mt5_probe_response_invalid", None))
}

fn capture_foreground_window() -> Option<windows_sys::Win32::Foundation::HWND> {
    let window = unsafe { GetForegroundWindow() };
    (!window.is_null()).then_some(window)
}

fn foreground_process_image_path(
    window: Option<windows_sys::Win32::Foundation::HWND>,
) -> Option<PathBuf> {
    let window = window?;
    let mut process_id = 0_u32;
    if unsafe { GetWindowThreadProcessId(window, &mut process_id) } == 0 || process_id == 0 {
        return None;
    }
    process_image_path(process_id)
}

fn should_restore_foreground_window(
    current_process_path: Option<&Path>,
    probed_terminal_path: &Path,
) -> bool {
    current_process_path.is_some_and(|path| paths_equal(path, probed_terminal_path))
}

fn restore_foreground_window_if_probe_active(
    previous_window: Option<windows_sys::Win32::Foundation::HWND>,
    probed_terminal_path: &Path,
) {
    let current_process_path = foreground_process_image_path(capture_foreground_window());
    if should_restore_foreground_window(current_process_path.as_deref(), probed_terminal_path) {
        restore_foreground_window(previous_window);
    }
}

fn restore_foreground_window(window: Option<windows_sys::Win32::Foundation::HWND>) {
    if let Some(window) = window
        && unsafe { IsWindow(window) } != 0
    {
        unsafe {
            let _ = SetForegroundWindow(window);
        }
    }
}

fn resolve_candidates(
    candidates: impl IntoIterator<Item = Mt5InstallationCandidate>,
) -> Vec<Mt5Installation> {
    let mut resolved = BTreeMap::<String, Mt5Installation>::new();
    for candidate in candidates {
        let Some(executable) = find_terminal_executable(&candidate.path) else {
            continue;
        };
        // MT4 also ships a `terminal.exe`.  Only reject an installation when
        // its layout proves that it is MT4-only; portable/legacy MT5 layouts
        // without MQL5 must remain discoverable.
        if is_explicit_mt4_only_candidate(&executable) {
            continue;
        }
        let Ok(terminal_instance_id) = mt5_terminal_instance_id(&executable) else {
            continue;
        };
        let key = executable.to_string_lossy().to_uppercase();
        resolved
            .entry(key)
            .and_modify(|existing| existing.is_running |= candidate.is_running)
            .or_insert(Mt5Installation {
                executable_path: executable,
                terminal_instance_id,
                is_running: candidate.is_running,
            });
    }
    let mut values = resolved.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .is_running
            .cmp(&left.is_running)
            .then_with(|| left.terminal_instance_id.cmp(&right.terminal_instance_id))
    });
    values
}

fn metaquotes_data_candidates() -> Vec<Mt5InstallationCandidate> {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(app_data).join("MetaQuotes").join("Terminal");
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let data_path = entry.path();
            if !data_path.join("MQL5").is_dir() {
                return None;
            }
            let origin = read_origin(&data_path.join("origin.txt"))?;
            Some(Mt5InstallationCandidate {
                path: origin,
                is_running: false,
            })
        })
        .collect()
}

fn registry_candidates() -> Vec<Mt5InstallationCandidate> {
    let mut values = Vec::new();
    values.extend(registry_install_paths(HKEY_CURRENT_USER, 0));
    values.extend(registry_install_paths(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY));
    values.extend(registry_install_paths(HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY));
    values
        .into_iter()
        .map(|path| Mt5InstallationCandidate {
            path,
            is_running: false,
        })
        .collect()
}

fn registry_install_paths(hive: HKEY, registry_view: u32) -> Vec<PathBuf> {
    let key_path = wide_z(r"Software\MetaQuotes\Terminal");
    let mut terminal_key: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(
            hive,
            key_path.as_ptr(),
            0,
            KEY_READ | registry_view,
            &mut terminal_key,
        )
    };
    if opened != ERROR_SUCCESS || terminal_key.is_null() {
        return Vec::new();
    }
    let key = RegistryKey(terminal_key);
    let mut values = Vec::new();
    let mut index = 0_u32;
    loop {
        let mut name = vec![0_u16; 512];
        let mut name_length = u32::try_from(name.len().saturating_sub(1)).unwrap_or(u32::MAX);
        let result = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                name.as_mut_ptr(),
                &mut name_length,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == ERROR_NO_MORE_ITEMS {
            break;
        }
        if result != ERROR_SUCCESS {
            index = index.saturating_add(1);
            if index > 4_096 {
                break;
            }
            continue;
        }
        name.truncate(usize::try_from(name_length).unwrap_or(0));
        if let Some(path) = registry_install_path(key.0, &name) {
            values.push(path);
        }
        index = index.saturating_add(1);
        if index > 4_096 {
            break;
        }
    }
    values
}

fn registry_install_path(parent: HKEY, subkey_name: &[u16]) -> Option<PathBuf> {
    let mut name = subkey_name.to_vec();
    name.push(0);
    let mut subkey: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(parent, name.as_ptr(), 0, KEY_READ, &mut subkey) } != ERROR_SUCCESS
        || subkey.is_null()
    {
        return None;
    }
    let key = RegistryKey(subkey);
    let value_name = wide_z("InstallPath");
    let mut value_type = 0_u32;
    let mut byte_count = 0_u32;
    if unsafe {
        RegQueryValueExW(
            key.0,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut byte_count,
        )
    } != ERROR_SUCCESS
        || value_type != REG_SZ
        || !(2..=MAX_REGISTRY_PATH_BYTES).contains(&byte_count)
        || !byte_count.is_multiple_of(2)
    {
        return None;
    }
    let mut bytes = vec![0_u8; usize::try_from(byte_count).ok()?];
    if unsafe {
        RegQueryValueExW(
            key.0,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            bytes.as_mut_ptr(),
            &mut byte_count,
        )
    } != ERROR_SUCCESS
        || value_type != REG_SZ
    {
        return None;
    }
    let words = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|word| *word != 0)
        .collect::<Vec<_>>();
    let path = String::from_utf16(&words).ok()?;
    (!path.trim().is_empty()).then(|| PathBuf::from(path.trim()))
}

fn running_terminal_paths() -> Vec<PathBuf> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap_or(u32::MAX),
        ..Default::default()
    };
    let mut values = Vec::new();
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while available {
        let name = utf16_z(&entry.szExeFile);
        if (name.eq_ignore_ascii_case("terminal64.exe")
            || name.eq_ignore_ascii_case("terminal.exe"))
            && let Some(path) = process_image_path(entry.th32ProcessID)
        {
            values.push(path);
        }
        available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    values
}

fn process_image_path(process_id: u32) -> Option<PathBuf> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; MAX_PROCESS_PATH_CHARS];
    let mut length = u32::try_from(buffer.len()).ok()?;
    let success =
        unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(process) };
    if success == 0 || length == 0 {
        return None;
    }
    buffer.truncate(usize::try_from(length).ok()?);
    Some(PathBuf::from(OsString::from_wide(&buffer)))
}

fn find_terminal_executable(path: &Path) -> Option<PathBuf> {
    let path = absolute(path)?;
    if path.is_file() && is_terminal_executable(&path) {
        return Some(path);
    }
    if !path.is_dir() {
        return None;
    }
    ["terminal64.exe", "terminal.exe"]
        .into_iter()
        .map(|name| path.join(name))
        .find(|candidate| candidate.is_file())
}

fn read_origin(path: &Path) -> Option<PathBuf> {
    let bytes = fs::read(path).ok()?;
    let text = if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let words = content
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&words).ok()?
    } else if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let words = content
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&words).ok()?
    } else {
        std::str::from_utf8(&bytes)
            .ok()?
            .trim_start_matches('\u{feff}')
            .to_owned()
    };
    let value = text.trim().trim_matches('\0').trim();
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn absolute(path: &Path) -> Option<PathBuf> {
    std::path::absolute(path).ok()
}

pub(crate) fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

pub(crate) fn safe_terminal_directory_name(path: &Path) -> String {
    let fallback = "MT5终端";
    let Some(raw) = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
    else {
        return fallback.to_owned();
    };
    let name = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(96)
        .collect::<String>();
    if name.trim().is_empty() {
        fallback.to_owned()
    } else {
        name
    }
}

fn is_terminal_executable(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("terminal64.exe")
                || value.eq_ignore_ascii_case("terminal.exe")
        })
}

pub(crate) fn is_terminal64_executable(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("terminal64.exe"))
}

fn is_running_mt5_candidate(path: &Path) -> bool {
    is_terminal_executable(path) && !is_explicit_mt4_only_candidate(path)
}

fn is_explicit_mt4_only_candidate(path: &Path) -> bool {
    let Some(installation_directory) = path.is_dir().then_some(path).or_else(|| path.parent())
    else {
        return false;
    };
    (installation_directory.join("MQL4").is_dir() && !installation_directory.join("MQL5").is_dir())
        || file_product_major_version(path).is_some_and(is_mt4_product_major)
}

fn is_mt4_product_major(product_major: u16) -> bool {
    product_major == 4
}

fn file_product_major_version(path: &Path) -> Option<u16> {
    if !path.is_file() {
        return None;
    }
    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut ignored_handle = 0_u32;
    let size = unsafe { GetFileVersionInfoSizeW(wide_path.as_ptr(), &mut ignored_handle) };
    if size == 0 || size > MAX_VERSION_INFO_BYTES {
        return None;
    }
    let mut version_data = vec![0_u8; usize::try_from(size).ok()?];
    if unsafe {
        GetFileVersionInfoW(
            wide_path.as_ptr(),
            0,
            size,
            version_data.as_mut_ptr().cast(),
        )
    } == 0
    {
        return None;
    }
    let root_query = wide_z(r"\");
    let mut fixed_info = std::ptr::null_mut();
    let mut fixed_info_size = 0_u32;
    if unsafe {
        VerQueryValueW(
            version_data.as_ptr().cast(),
            root_query.as_ptr(),
            &mut fixed_info,
            &mut fixed_info_size,
        )
    } == 0
        || fixed_info.is_null()
        || usize::try_from(fixed_info_size).ok()? < std::mem::size_of::<VS_FIXEDFILEINFO>()
    {
        return None;
    }
    let fixed_info = unsafe { fixed_info.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    if fixed_info.dwSignature != VS_FFI_SIGNATURE as u32 {
        return None;
    }
    Some((fixed_info.dwProductVersionMS >> 16) as u16)
}

fn utf16_z(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|word| *word == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

fn wide_z(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { RegCloseKey(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-mt5-discovery-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn candidate_resolution_prefers_running_and_deduplicates_paths() {
        let root = fixture_directory("candidates");
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).expect("first terminal directory");
        fs::create_dir_all(&second).expect("second terminal directory");
        fs::write(first.join("terminal64.exe"), b"terminal").expect("first terminal");
        fs::write(second.join("terminal.exe"), b"terminal").expect("second terminal");
        let values = resolve_candidates([
            Mt5InstallationCandidate {
                path: first.clone(),
                is_running: false,
            },
            Mt5InstallationCandidate {
                path: first.join("terminal64.exe"),
                is_running: true,
            },
            Mt5InstallationCandidate {
                path: second,
                is_running: false,
            },
        ]);
        assert_eq!(values.len(), 2);
        assert!(values[0].is_running);
        assert_eq!(
            values[0].executable_path,
            std::path::absolute(first.join("terminal64.exe")).unwrap()
        );
        fs::remove_dir_all(root).expect("remove candidate fixture");
    }

    #[test]
    fn running_terminal_exe_is_a_candidate_without_an_mql5_directory() {
        let root = fixture_directory("running-terminal-exe");
        fs::create_dir_all(&root).expect("terminal directory");
        let terminal = root.join("terminal.exe");
        fs::write(&terminal, b"terminal").expect("terminal executable");
        assert!(!root.join("MQL5").is_dir());
        assert!(is_running_mt5_candidate(&terminal));
        fs::remove_dir_all(root).expect("remove terminal fixture");
    }

    #[test]
    fn explicit_mt4_only_candidates_are_filtered_but_mt5_and_unknown_are_kept() {
        let root = fixture_directory("platform-layout");
        let mt4 = root.join("MetaTrader 4");
        let mt5 = root.join("MetaTrader 5");
        let unknown = root.join("Portable");
        fs::create_dir_all(mt4.join("MQL4")).expect("mt4 data directory");
        fs::create_dir_all(mt5.join("MQL5")).expect("mt5 data directory");
        fs::create_dir_all(&unknown).expect("unknown installation directory");
        let mt4_terminal = mt4.join("terminal.exe");
        let mt5_terminal = mt5.join("terminal.exe");
        let unknown_terminal = unknown.join("terminal.exe");
        fs::write(&mt4_terminal, b"terminal").expect("mt4 terminal");
        fs::write(&mt5_terminal, b"terminal").expect("mt5 terminal");
        fs::write(&unknown_terminal, b"terminal").expect("unknown terminal");

        assert!(is_explicit_mt4_only_candidate(&mt4_terminal));
        assert!(!is_explicit_mt4_only_candidate(&mt5_terminal));
        assert!(!is_explicit_mt4_only_candidate(&unknown_terminal));
        assert!(!is_running_mt5_candidate(&mt4_terminal));
        assert!(is_running_mt5_candidate(&mt5_terminal));
        assert!(is_running_mt5_candidate(&unknown_terminal));

        let values = resolve_candidates([
            Mt5InstallationCandidate {
                path: mt4.clone(),
                is_running: true,
            },
            Mt5InstallationCandidate {
                path: mt5,
                is_running: false,
            },
            Mt5InstallationCandidate {
                path: unknown,
                is_running: false,
            },
        ]);
        assert_eq!(values.len(), 2);
        assert!(values.iter().all(|value| {
            !paths_equal(&value.executable_path, &mt4_terminal)
                && (paths_equal(&value.executable_path, &mt5_terminal)
                    || paths_equal(&value.executable_path, &unknown_terminal))
        }));
        fs::remove_dir_all(root).expect("remove platform fixture");
    }

    #[test]
    fn mt4_product_major_is_classified_without_rejecting_mt5_or_unknown_versions() {
        assert!(is_mt4_product_major(4));
        assert!(!is_mt4_product_major(5));
        assert!(!is_mt4_product_major(0));
    }

    #[test]
    fn only_terminal64_is_unambiguous_for_a_failed_mt5_placeholder() {
        assert!(is_terminal64_executable(Path::new(
            r"C:\Broker\terminal64.exe"
        )));
        assert!(!is_terminal64_executable(Path::new(
            r"C:\Broker\terminal.exe"
        )));
    }

    #[test]
    fn probe_document_is_strict_and_route_validated() {
        let valid = serde_json::from_str::<Mt5ProbeDocument>(
            r#"{"probe_version":1,"terminal_path":"C:\\Broker MT5\\terminal64.exe","account_ref":{"broker_server":"Broker-Demo","login":"123456"}}"#,
        )
        .expect("valid probe");
        assert_eq!(valid.probe_version, 1);
        assert!(
            valid
                .account_ref
                .as_ref()
                .is_some_and(|account| account.validate().is_ok())
        );
        assert!(serde_json::from_str::<Mt5ProbeDocument>(
            r#"{"probe_version":1,"terminal_path":"C:\\terminal64.exe","account_ref":{"broker_server":"Broker-Demo","login":"123456"},"secret":"no"}"#,
        )
        .is_err());
        let failure = serde_json::from_str::<Mt5ProbeDocument>(
            r#"{"probe_version":1,"terminal_path":"C:\\Broker MT5\\terminal64.exe","error_code":"account_unavailable","last_error":-10004}"#,
        )
        .expect("structured failure probe");
        assert_eq!(
            normalize_probe_error_code(failure.error_code.as_deref().unwrap()),
            Some("mt5_account_unavailable")
        );
        assert_eq!(failure.last_error, Some(-10004));
    }

    #[test]
    fn foreground_restore_only_applies_while_the_probed_terminal_is_foreground() {
        let terminal = Path::new(r"C:\Broker MT5\terminal64.exe");
        assert!(should_restore_foreground_window(Some(terminal), terminal));
        assert!(!should_restore_foreground_window(
            Some(Path::new(r"C:\Windows\explorer.exe")),
            terminal
        ));
        assert!(!should_restore_foreground_window(None, terminal));
    }

    #[test]
    fn safe_terminal_directory_name_does_not_expose_parent_path_or_controls() {
        let path = Path::new("C:\\Users\\secret\\Broker\u{7} MT5\\terminal64.exe");
        let name = safe_terminal_directory_name(path);
        assert_eq!(name, "Broker MT5");
        assert!(!name.contains("secret"));
        assert!(!name.chars().any(char::is_control));
    }

    #[test]
    fn probe_process_is_bounded_and_validates_the_exact_terminal_path() {
        let output = Command::new("where.exe")
            .arg("python.exe")
            .output()
            .expect("query python");
        if !output.status.success() {
            return;
        }
        let Some(python) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
        else {
            return;
        };
        let root = fixture_directory("probe-process");
        fs::create_dir_all(&root).expect("probe fixture");
        let terminal = root.join("terminal64.exe");
        let worker = root.join("probe.py");
        fs::write(&terminal, b"terminal").expect("probe terminal");
        fs::write(
            &worker,
            b"import json,sys\nprint(json.dumps({'probe_version':1,'terminal_path':sys.argv[-1],'account_ref':{'broker_server':'Broker-Demo','login':'123456'}},separators=(',',':')))\n",
        )
        .expect("probe worker");
        let result = probe_terminal(&python, &worker, &terminal, Duration::from_secs(5))
            .expect("probe process");
        assert_eq!(result.account_ref.login, "123456");
        assert!(paths_equal(&result.executable_path, &terminal));
        fs::remove_dir_all(root).expect("remove probe fixture");
    }

    #[test]
    fn nonzero_probe_process_preserves_structured_failure_code_and_last_error() {
        let output = Command::new("where.exe")
            .arg("python.exe")
            .output()
            .expect("query python");
        if !output.status.success() {
            return;
        }
        let Some(python) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
        else {
            return;
        };
        let root = fixture_directory("probe-failure");
        fs::create_dir_all(&root).expect("probe failure fixture");
        let terminal = root.join("terminal64.exe");
        let worker = root.join("probe.py");
        fs::write(&terminal, b"terminal").expect("probe terminal");
        fs::write(
            &worker,
            b"import json,sys\nprint(json.dumps({'probe_version':1,'terminal_path':sys.argv[-1],'error_code':'account_unavailable','last_error':-10004},separators=(',',':')))\nsys.exit(2)\n",
        )
        .expect("probe failure worker");
        let failure = probe_terminal(&python, &worker, &terminal, Duration::from_secs(5))
            .expect_err("structured probe failure");
        assert_eq!(failure.code, "mt5_account_unavailable");
        assert_eq!(failure.last_error, Some(-10004));
        fs::remove_dir_all(root).expect("remove probe failure fixture");
    }

    #[test]
    fn windows_discovery_returns_only_existing_unique_mt5_executables() {
        let values = discover_windows();
        let unique = values
            .iter()
            .map(|value| value.executable_path.to_string_lossy().to_uppercase())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), values.len());
        assert!(values.iter().all(|value| {
            value.executable_path.is_file()
                && is_terminal_executable(&value.executable_path)
                && value.terminal_instance_id.starts_with("mt5_")
        }));
        eprintln!("native_mt5_discovery_count={}", values.len());
    }
}
