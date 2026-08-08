use std::path::{Path, PathBuf};

use crate::mt4_terminal_discovery;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedObserverTerminal {
    pub platform: String,
    pub terminal_instance_id: String,
    /// Matches the existing .NET preferences contract: MT5 stores the executable and MT4 the
    /// terminal data directory that contains MQL4.
    pub preference_path: PathBuf,
}

pub(crate) fn resolve_observer_terminal(
    platform: &str,
    selected_directory: &Path,
) -> Result<ResolvedObserverTerminal, &'static str> {
    match platform {
        "mt5" => resolve_mt5(selected_directory),
        "mt4" => resolve_mt4(selected_directory),
        _ => Err("bridge_observer_platform_invalid"),
    }
}

fn resolve_mt5(selected: &Path) -> Result<ResolvedObserverTerminal, &'static str> {
    let selected = absolute(selected, "bridge_observer_mt5_directory_invalid")?;
    let executable = if selected.is_file() && is_terminal_executable(&selected) {
        selected
    } else if selected.is_dir() {
        ["terminal64.exe", "terminal.exe"]
            .into_iter()
            .map(|name| selected.join(name))
            .find(|path| path.is_file())
            .ok_or("bridge_observer_mt5_directory_invalid")?
    } else {
        return Err("bridge_observer_mt5_directory_invalid");
    };
    let terminal_instance_id = mt5_terminal_instance_id(&executable)?;
    Ok(ResolvedObserverTerminal {
        platform: "mt5".to_owned(),
        terminal_instance_id,
        preference_path: executable,
    })
}

fn resolve_mt4(selected: &Path) -> Result<ResolvedObserverTerminal, &'static str> {
    let selected = absolute(selected, "bridge_observer_mt4_directory_invalid")?;
    let data_path = if selected.join("MQL4").is_dir() {
        selected
    } else {
        discover_mt4_installations()
            .into_iter()
            .find(|installation| paths_equal(&installation.installation_path, &selected))
            .map(|installation| installation.data_path)
            .ok_or("bridge_observer_mt4_directory_invalid")?
    };
    let terminal_instance_id =
        mt4_terminal_discovery::installation_terminal_instance_id(&data_path)?;
    Ok(ResolvedObserverTerminal {
        platform: "mt4".to_owned(),
        terminal_instance_id,
        preference_path: data_path,
    })
}

#[derive(Clone, Debug)]
struct Mt4Installation {
    data_path: PathBuf,
    installation_path: PathBuf,
}

fn discover_mt4_installations() -> Vec<Mt4Installation> {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(app_data).join("MetaQuotes").join("Terminal");
    let Ok(entries) = std::fs::read_dir(root) else {
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
            contains_terminal_executable(&installation_path).then_some(Mt4Installation {
                data_path: absolute(&data_path, "bridge_observer_mt4_directory_invalid").ok()?,
                installation_path: absolute(
                    &installation_path,
                    "bridge_observer_mt4_directory_invalid",
                )
                .ok()?,
            })
        })
        .collect()
}

fn read_origin(path: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(path).ok()?;
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

pub(crate) fn mt5_terminal_instance_id(executable: &Path) -> Result<String, &'static str> {
    let normalized = absolute(executable, "bridge_observer_mt5_directory_invalid")?
        .to_string_lossy()
        .to_uppercase();
    Ok(hash_identity("mt5", normalized.as_bytes()))
}

#[cfg(test)]
pub(crate) fn mt4_terminal_instance_id(
    terminal_data_path: &Path,
    device_namespace: &str,
) -> Result<String, &'static str> {
    mt4_terminal_discovery::terminal_instance_id(terminal_data_path, device_namespace, None)
}

fn hash_identity(prefix: &str, input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    let hex = format!("{digest:x}");
    format!("{prefix}_{}", &hex[..24])
}

fn absolute(path: &Path, code: &'static str) -> Result<PathBuf, &'static str> {
    if path.as_os_str().is_empty() {
        return Err(code);
    }
    std::path::absolute(path).map_err(|_| code)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

fn contains_terminal_executable(path: &Path) -> bool {
    path.join("terminal.exe").is_file() || path.join("terminal64.exe").is_file()
}

fn is_terminal_executable(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("terminal.exe")
                || value.eq_ignore_ascii_case("terminal64.exe")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-observer-terminal-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn mt5_resolution_matches_the_dotnet_executable_preference_contract() {
        let directory = fixture_directory("mt5");
        std::fs::create_dir_all(&directory).expect("create mt5 fixture");
        let executable = directory.join("terminal64.exe");
        std::fs::write(&executable, b"fixture").expect("write terminal");
        let resolved = resolve_observer_terminal("mt5", &directory).expect("resolve mt5");
        assert_eq!(resolved.platform, "mt5");
        assert_eq!(
            resolved.preference_path,
            std::path::absolute(&executable).unwrap()
        );
        assert!(resolved.terminal_instance_id.starts_with("mt5_"));
        assert_eq!(resolved.terminal_instance_id.len(), 28);
        std::fs::remove_dir_all(directory).expect("remove mt5 fixture");
    }

    #[test]
    fn mt4_identity_is_device_and_data_directory_scoped_like_dotnet() {
        let directory = fixture_directory("mt4");
        std::fs::create_dir_all(directory.join("MQL4")).expect("create mt4 fixture");
        let first = mt4_terminal_instance_id(&directory, "device-a").expect("first identity");
        let same = mt4_terminal_instance_id(&directory, "device-a").expect("same identity");
        let other = mt4_terminal_instance_id(&directory, "device-b").expect("other identity");
        assert_eq!(first, same);
        assert_ne!(first, other);
        assert!(first.starts_with("mt4_"));
        assert_eq!(first.len(), 28);
        std::fs::remove_dir_all(directory).expect("remove mt4 fixture");
    }

    #[test]
    fn origin_reader_accepts_metaquotes_utf16_files() {
        let directory = fixture_directory("origin");
        std::fs::create_dir_all(&directory).expect("create origin fixture");
        let path = directory.join("origin.txt");
        let mut bytes = vec![0xff, 0xfe];
        for word in r"C:\Program Files\Broker MT4".encode_utf16() {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        std::fs::write(&path, bytes).expect("write origin");
        assert_eq!(
            read_origin(&path),
            Some(PathBuf::from(r"C:\Program Files\Broker MT4"))
        );
        std::fs::remove_dir_all(directory).expect("remove origin fixture");
    }
}
