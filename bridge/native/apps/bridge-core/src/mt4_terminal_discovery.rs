use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use bridge_runtime_win::machine_guid;
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};

const MAX_PROCESS_PATH_CHARS: usize = 32_768;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Mt4Installation {
    pub data_path: PathBuf,
    pub installation_path: PathBuf,
    pub terminal_instance_id: String,
    pub display_name: String,
    pub is_running: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Mt4InstallationCandidate {
    data_path: PathBuf,
    installation_path: PathBuf,
    is_running: bool,
}

pub(crate) fn discover_windows() -> Vec<Mt4Installation> {
    let running = running_terminal_paths();
    let mut candidates = metaquotes_data_candidates(&running);
    candidates.extend(running.into_iter().filter_map(|executable| {
        let installation_path = executable.parent()?.to_path_buf();
        installation_path
            .join("MQL4")
            .is_dir()
            .then_some(Mt4InstallationCandidate {
                data_path: installation_path.clone(),
                installation_path,
                is_running: true,
            })
    }));
    resolve_candidates(candidates)
}

pub(crate) fn selected_or_discovered(selected_path: Option<&str>) -> Vec<Mt4Installation> {
    let discovered = discover_windows();
    let Some(selected_path) = selected_path.filter(|value| !value.trim().is_empty()) else {
        return discovered;
    };
    let selected = Path::new(selected_path);
    if let Some(installation) = discovered.into_iter().find(|installation| {
        paths_equal(&installation.data_path, selected)
            || paths_equal(&installation.installation_path, selected)
    }) {
        return vec![installation];
    }
    resolve_candidates([Mt4InstallationCandidate {
        data_path: selected.to_path_buf(),
        installation_path: selected.to_path_buf(),
        is_running: false,
    }])
}

pub(crate) fn start_terminal_if_stopped(
    installation: &Mt4Installation,
) -> Result<bool, &'static str> {
    if installation.is_running
        || running_terminal_paths().iter().any(|executable| {
            executable
                .parent()
                .is_some_and(|directory| paths_equal(directory, &installation.installation_path))
        })
    {
        return Ok(false);
    }
    let executable = ["terminal.exe", "terminal64.exe"]
        .into_iter()
        .map(|name| installation.installation_path.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or("mt4_terminal_not_found")?;
    Command::new(&executable)
        .current_dir(&installation.installation_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| true)
        .map_err(|_| "mt4_terminal_start_failed")
}

pub(crate) fn installation_terminal_instance_id(
    terminal_data_path: &Path,
) -> Result<String, &'static str> {
    let device_namespace = machine_guid().map_err(|error| error.code())?;
    terminal_instance_id(terminal_data_path, &device_namespace, None)
}

pub(crate) fn account_terminal_instance_id(
    terminal_data_path: &Path,
    broker_server: &str,
    login: &str,
) -> Result<String, &'static str> {
    let device_namespace = machine_guid().map_err(|error| error.code())?;
    terminal_instance_id(
        terminal_data_path,
        &device_namespace,
        Some((broker_server, login)),
    )
}

pub(crate) fn terminal_instance_id(
    terminal_data_path: &Path,
    device_namespace: &str,
    account: Option<(&str, &str)>,
) -> Result<String, &'static str> {
    if device_namespace.trim().is_empty() {
        return Err("bridge_machine_guid_unavailable");
    }
    let normalized_path = absolute(terminal_data_path)
        .ok_or("bridge_observer_mt4_directory_invalid")?
        .to_string_lossy()
        .to_uppercase();
    let identity = match account {
        Some((broker_server, login)) => {
            let broker_server = broker_server.trim();
            let login = login.trim();
            if broker_server.is_empty() || login.is_empty() {
                return Err("mt4_ea_identity_invalid");
            }
            format!(
                "{}\n{normalized_path}\n{}\n{login}",
                device_namespace.trim(),
                broker_server.to_uppercase()
            )
        }
        None => format!("{}\n{normalized_path}", device_namespace.trim()),
    };
    let digest = Sha256::digest(identity.as_bytes());
    let hex = format!("{digest:x}");
    Ok(format!("mt4_{}", &hex[..24]))
}

pub(crate) fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

fn metaquotes_data_candidates(running: &[PathBuf]) -> Vec<Mt4InstallationCandidate> {
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
            if !data_path.join("MQL4").is_dir() {
                return None;
            }
            let origin = read_origin(&data_path.join("origin.txt"))?;
            let installation_path = if origin.is_file() {
                origin.parent()?.to_path_buf()
            } else {
                origin
            };
            if !contains_terminal_executable(&installation_path) {
                return None;
            }
            let is_running = running.iter().any(|executable| {
                executable
                    .parent()
                    .is_some_and(|directory| paths_equal(directory, &installation_path))
            });
            Some(Mt4InstallationCandidate {
                data_path,
                installation_path,
                is_running,
            })
        })
        .collect()
}

fn resolve_candidates(
    candidates: impl IntoIterator<Item = Mt4InstallationCandidate>,
) -> Vec<Mt4Installation> {
    let mut resolved = BTreeMap::<String, Mt4Installation>::new();
    for candidate in candidates {
        let Some(data_path) = absolute(&candidate.data_path) else {
            continue;
        };
        if !data_path.join("MQL4").is_dir() {
            continue;
        }
        let Some(installation_path) = absolute(&candidate.installation_path) else {
            continue;
        };
        if !contains_terminal_executable(&installation_path) {
            continue;
        }
        let Ok(terminal_instance_id) = installation_terminal_instance_id(&data_path) else {
            continue;
        };
        let display_name = installation_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("MT4")
            .to_owned();
        let key = data_path.to_string_lossy().to_uppercase();
        resolved
            .entry(key)
            .and_modify(|existing| existing.is_running |= candidate.is_running)
            .or_insert(Mt4Installation {
                data_path,
                installation_path,
                terminal_instance_id,
                display_name,
                is_running: candidate.is_running,
            });
    }
    let mut values = resolved.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .is_running
            .cmp(&left.is_running)
            .then_with(|| left.display_name.cmp(&right.display_name))
            .then_with(|| left.terminal_instance_id.cmp(&right.terminal_instance_id))
    });
    values
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

fn contains_terminal_executable(path: &Path) -> bool {
    path.join("terminal.exe").is_file() || path.join("terminal64.exe").is_file()
}

fn absolute(path: &Path) -> Option<PathBuf> {
    std::path::absolute(path).ok()
}

fn utf16_z(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|word| *word == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-mt4-discovery-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn candidate_resolution_prefers_running_and_deduplicates_data_paths() {
        let root = fixture_directory("candidates");
        let data_path = root.join("terminal-data");
        let installation_path = root.join("Broker MT4");
        fs::create_dir_all(data_path.join("MQL4")).expect("MQL4 data directory");
        fs::create_dir_all(&installation_path).expect("installation directory");
        fs::write(installation_path.join("terminal.exe"), b"terminal")
            .expect("terminal executable");
        let values = resolve_candidates([
            Mt4InstallationCandidate {
                data_path: data_path.clone(),
                installation_path: installation_path.clone(),
                is_running: false,
            },
            Mt4InstallationCandidate {
                data_path: data_path.clone(),
                installation_path,
                is_running: true,
            },
        ]);
        assert_eq!(values.len(), 1);
        assert!(values[0].is_running);
        assert_eq!(values[0].data_path, std::path::absolute(data_path).unwrap());
        fs::remove_dir_all(root).expect("remove candidate fixture");
    }

    #[test]
    fn installation_and_account_identities_match_the_dotnet_contract() {
        let root = fixture_directory("identity");
        fs::create_dir_all(&root).expect("identity fixture");
        let installation = terminal_instance_id(&root, "device-a", None).expect("installation");
        let account = terminal_instance_id(&root, "device-a", Some(("Broker-Demo", "12345678")))
            .expect("account");
        assert_ne!(installation, account);
        assert_eq!(installation.len(), 28);
        assert_eq!(account.len(), 28);
        assert_eq!(
            account,
            terminal_instance_id(&root, "device-a", Some(("broker-demo", "12345678")))
                .expect("normalized account")
        );
        fs::remove_dir_all(root).expect("remove identity fixture");
    }

    #[test]
    fn windows_discovery_returns_only_existing_unique_mt4_data_paths() {
        let values = discover_windows();
        let unique = values
            .iter()
            .map(|value| value.data_path.to_string_lossy().to_uppercase())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), values.len());
        assert!(values.iter().all(|value| {
            value.data_path.join("MQL4").is_dir()
                && contains_terminal_executable(&value.installation_path)
                && value.terminal_instance_id.starts_with("mt4_")
        }));
        eprintln!("native_mt4_discovery_count={}", values.len());
    }
}
