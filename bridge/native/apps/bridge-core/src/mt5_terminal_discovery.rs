use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::os::windows::ffi::OsStringExt;
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

use crate::observer_terminal::mt5_terminal_instance_id;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const MAX_PROBE_OUTPUT_BYTES: u64 = 16 * 1024;
const MAX_PROCESS_PATH_CHARS: usize = 32_768;
const MAX_REGISTRY_PATH_BYTES: u32 = 64 * 1024;

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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Mt5ProbeDocument {
    probe_version: u32,
    terminal_path: String,
    account_ref: AccountRef,
}

pub(crate) fn discover_windows() -> Vec<Mt5Installation> {
    let mut candidates = running_terminal_paths()
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("terminal64.exe"))
                || path
                    .parent()
                    .is_some_and(|directory| directory.join("MQL5").is_dir())
        })
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

pub(crate) fn start_terminal_if_stopped(terminal_executable: &Path) -> Result<bool, &'static str> {
    let executable =
        find_terminal_executable(terminal_executable).ok_or("mt5_terminal_not_found")?;
    if running_terminal_paths()
        .iter()
        .any(|running| paths_equal(running, &executable))
    {
        return Ok(false);
    }
    let working_directory = executable.parent().ok_or("mt5_terminal_not_found")?;
    Command::new(&executable)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| true)
        .map_err(|_| "mt5_terminal_start_failed")
}

pub(crate) fn probe_terminal(
    python_executable: &Path,
    worker_script: &Path,
    terminal_executable: &Path,
    timeout: Duration,
) -> Result<Mt5ProbeResult, &'static str> {
    if !python_executable.is_file() {
        return Err("mt5_python_runtime_not_found");
    }
    if !worker_script.is_file() {
        return Err("mt5_worker_script_not_found");
    }
    if !terminal_executable.is_file() {
        return Err("mt5_terminal_not_found");
    }
    let expected_path = absolute(terminal_executable).ok_or("mt5_terminal_not_found")?;
    let mut child = Command::new(python_executable)
        .arg("-B")
        .arg(worker_script)
        .arg("--probe")
        .arg("--terminal")
        .arg(&expected_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| "mt5_probe_process_start_failed")?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("mt5_probe_timeout");
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("mt5_probe_failed");
            }
        }
    };
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        stdout
            .take(MAX_PROBE_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)
            .map_err(|_| "mt5_probe_response_invalid")?;
    }
    if !status.success() {
        return Err("mt5_probe_failed");
    }
    if output.is_empty() || output.len() as u64 > MAX_PROBE_OUTPUT_BYTES {
        return Err("mt5_probe_response_invalid");
    }
    let document = serde_json::from_slice::<Mt5ProbeDocument>(&output)
        .map_err(|_| "mt5_probe_response_invalid")?;
    if document.probe_version != 1
        || !paths_equal(&expected_path, Path::new(&document.terminal_path))
        || document.account_ref.validate().is_err()
    {
        return Err("mt5_probe_identity_mismatch");
    }
    Ok(Mt5ProbeResult {
        executable_path: expected_path,
        account_ref: document.account_ref,
    })
}

fn resolve_candidates(
    candidates: impl IntoIterator<Item = Mt5InstallationCandidate>,
) -> Vec<Mt5Installation> {
    let mut resolved = BTreeMap::<String, Mt5Installation>::new();
    for candidate in candidates {
        let Some(executable) = find_terminal_executable(&candidate.path) else {
            continue;
        };
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

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

fn is_terminal_executable(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("terminal64.exe")
                || value.eq_ignore_ascii_case("terminal.exe")
        })
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
    fn probe_document_is_strict_and_route_validated() {
        let valid = serde_json::from_str::<Mt5ProbeDocument>(
            r#"{"probe_version":1,"terminal_path":"C:\\Broker MT5\\terminal64.exe","account_ref":{"broker_server":"Broker-Demo","login":"123456"}}"#,
        )
        .expect("valid probe");
        assert_eq!(valid.probe_version, 1);
        assert!(valid.account_ref.validate().is_ok());
        assert!(serde_json::from_str::<Mt5ProbeDocument>(
            r#"{"probe_version":1,"terminal_path":"C:\\terminal64.exe","account_ref":{"broker_server":"Broker-Demo","login":"123456"},"secret":"no"}"#,
        )
        .is_err());
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
