use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

const MAX_PREFERENCES_BYTES: u64 = 64 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct BridgeUserPreferences {
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub mt5_terminal_instance_id: Option<String>,
    #[serde(default)]
    pub mt5_terminal_path: Option<String>,
    #[serde(default)]
    pub mt4_terminal_instance_id: Option<String>,
    #[serde(default)]
    pub mt4_terminal_path: Option<String>,
    #[serde(default = "default_true")]
    pub observer_enabled: bool,
    #[serde(default)]
    pub observer_bridge_user_id: Option<i64>,
    #[serde(default)]
    pub observer_account_label: Option<String>,
    #[serde(default)]
    pub observer_trading_account_id: Option<i64>,
    #[serde(default)]
    pub observer_trading_account_label: Option<String>,
    #[serde(default)]
    pub observer_claimed_terminal_instance_id: Option<String>,
    #[serde(default = "default_true")]
    pub auto_start_enabled: bool,
}

impl Default for BridgeUserPreferences {
    fn default() -> Self {
        Self {
            platform: None,
            mt5_terminal_instance_id: None,
            mt5_terminal_path: None,
            mt4_terminal_instance_id: None,
            mt4_terminal_path: None,
            observer_enabled: true,
            observer_bridge_user_id: None,
            observer_account_label: None,
            observer_trading_account_id: None,
            observer_trading_account_label: None,
            observer_claimed_terminal_instance_id: None,
            auto_start_enabled: true,
        }
    }
}

impl BridgeUserPreferences {
    pub fn selected_terminal_instance_id(&self) -> Option<&str> {
        match self.platform.as_deref() {
            Some("mt4") => self.mt4_terminal_instance_id.as_deref(),
            Some("mt5") => self.mt5_terminal_instance_id.as_deref(),
            _ => None,
        }
    }

    fn normalize(mut self) -> Self {
        self.platform = normalize_platform(self.platform.as_deref());
        self.mt5_terminal_instance_id =
            normalize_terminal_id(self.mt5_terminal_instance_id.as_deref(), "mt5_");
        self.mt4_terminal_instance_id =
            normalize_terminal_id(self.mt4_terminal_instance_id.as_deref(), "mt4_");
        self.observer_claimed_terminal_instance_id =
            normalize_any_terminal_id(self.observer_claimed_terminal_instance_id.as_deref());
        self.mt5_terminal_path = normalize_mt5_path(self.mt5_terminal_path.as_deref());
        self.mt4_terminal_path = normalize_absolute_path(self.mt4_terminal_path.as_deref());
        self.observer_bridge_user_id = self.observer_bridge_user_id.filter(|value| *value > 0);
        self.observer_trading_account_id =
            self.observer_trading_account_id.filter(|value| *value > 0);
        self.observer_account_label = normalize_label(self.observer_account_label.as_deref());
        self.observer_trading_account_label =
            normalize_label(self.observer_trading_account_label.as_deref());
        self
    }
}

#[derive(Clone, Debug)]
pub struct BridgePreferencesStore {
    path: PathBuf,
}

impl BridgePreferencesStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, PreferencesError> {
        let path = absolute_path(path.as_ref())?;
        Ok(Self { path })
    }

    pub fn load(&self) -> BridgeUserPreferences {
        let metadata = match fs::metadata(&self.path) {
            Ok(value) => value,
            Err(_) => return BridgeUserPreferences::default(),
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PREFERENCES_BYTES {
            return BridgeUserPreferences::default();
        }
        let payload = match fs::read(&self.path) {
            Ok(value) => value,
            Err(_) => return BridgeUserPreferences::default(),
        };
        serde_json::from_slice::<BridgeUserPreferences>(&payload)
            .unwrap_or_default()
            .normalize()
    }

    pub fn save_platform(&self, platform: &str) -> Result<(), PreferencesError> {
        let platform = normalize_platform(Some(platform))
            .ok_or_else(|| PreferencesError::new("bridge_preferences_platform_invalid"))?;
        self.update(|preferences| preferences.platform = Some(platform))
    }

    pub fn save_terminal(
        &self,
        platform: &str,
        terminal_instance_id: &str,
    ) -> Result<(), PreferencesError> {
        let platform = normalize_platform(Some(platform))
            .ok_or_else(|| PreferencesError::new("bridge_preferences_platform_invalid"))?;
        let id = normalize_terminal_id(Some(terminal_instance_id), &format!("{platform}_"))
            .ok_or_else(|| PreferencesError::new("bridge_preferences_terminal_invalid"))?;
        self.update(|preferences| {
            if platform == "mt4" {
                preferences.mt4_terminal_instance_id = Some(id);
            } else {
                preferences.mt5_terminal_instance_id = Some(id);
            }
        })
    }

    pub fn save_observer_enabled(&self, enabled: bool) -> Result<(), PreferencesError> {
        self.update(|preferences| preferences.observer_enabled = enabled)
    }

    pub fn save_autostart_enabled(&self, enabled: bool) -> Result<(), PreferencesError> {
        self.update(|preferences| preferences.auto_start_enabled = enabled)
    }

    fn update(
        &self,
        update: impl FnOnce(&mut BridgeUserPreferences),
    ) -> Result<(), PreferencesError> {
        let mut preferences = self.load();
        update(&mut preferences);
        self.write(&preferences.normalize())
    }

    fn write(&self, preferences: &BridgeUserPreferences) -> Result<(), PreferencesError> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| PreferencesError::new("bridge_preferences_path_invalid"))?;
        fs::create_dir_all(parent)
            .map_err(|_| PreferencesError::new("bridge_preferences_directory_failed"))?;
        let payload = serde_json::to_vec(preferences)
            .map_err(|_| PreferencesError::new("bridge_preferences_encode_failed"))?;
        if payload.is_empty() || payload.len() as u64 > MAX_PREFERENCES_BYTES {
            return Err(PreferencesError::new("bridge_preferences_size_invalid"));
        }
        let temporary = temporary_path(&self.path)?;
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| PreferencesError::new("bridge_preferences_write_failed"))?;
            file.write_all(&payload)
                .and_then(|_| file.sync_all())
                .map_err(|_| PreferencesError::new("bridge_preferences_write_failed"))?;
            replace_file(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreferencesError {
    code: &'static str,
}

impl PreferencesError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for PreferencesError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for PreferencesError {}

fn default_true() -> bool {
    true
}

fn normalize_platform(value: Option<&str>) -> Option<String> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "mt4" => Some("mt4".to_owned()),
        "mt5" => Some("mt5".to_owned()),
        _ => None,
    }
}

fn normalize_terminal_id(value: Option<&str>, prefix: &str) -> Option<String> {
    let value = value?.trim().to_ascii_lowercase();
    (value.len() == 28
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()))
    .then_some(value)
}

fn normalize_any_terminal_id(value: Option<&str>) -> Option<String> {
    normalize_terminal_id(value, "mt5_").or_else(|| normalize_terminal_id(value, "mt4_"))
}

fn normalize_absolute_path(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let path = Path::new(value);
    path.is_absolute()
        .then(|| path.to_string_lossy().into_owned())
}

fn normalize_mt5_path(value: Option<&str>) -> Option<String> {
    let value = normalize_absolute_path(value)?;
    let file_name = Path::new(&value).file_name()?.to_string_lossy();
    (file_name.eq_ignore_ascii_case("terminal.exe")
        || file_name.eq_ignore_ascii_case("terminal64.exe"))
    .then_some(value)
}

fn normalize_label(value: Option<&str>) -> Option<String> {
    let value = value?
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(220).collect())
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, PreferencesError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|_| PreferencesError::new("bridge_preferences_path_invalid"))
    }
}

fn temporary_path(path: &Path) -> Result<PathBuf, PreferencesError> {
    let parent = path
        .parent()
        .ok_or_else(|| PreferencesError::new("bridge_preferences_path_invalid"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| PreferencesError::new("bridge_preferences_path_invalid"))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    )))
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), PreferencesError> {
    let source = wide(source);
    let destination = wide(destination);
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(PreferencesError::new("bridge_preferences_replace_failed"))
    } else {
        Ok(())
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-preferences-{name}-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn reads_and_writes_the_existing_dotnet_json_contract() {
        let path = test_path("dotnet");
        fs::write(
            &path,
            br#"{"Platform":"MT5","Mt5TerminalInstanceId":"MT5_0123456789ABCDEF01234567","Mt5TerminalPath":"C:\\MT5\\terminal64.exe","Mt4TerminalInstanceId":null,"Mt4TerminalPath":null,"ObserverEnabled":true,"ObserverBridgeUserId":7,"ObserverAccountLabel":" A\u0000B ","ObserverTradingAccountId":8,"ObserverTradingAccountLabel":"Demo","ObserverClaimedTerminalInstanceId":null,"AutoStartEnabled":false}"#,
        )
        .expect("write dotnet fixture");
        let store = BridgePreferencesStore::new(&path).expect("store");
        let loaded = store.load();
        assert_eq!(loaded.platform.as_deref(), Some("mt5"));
        assert_eq!(
            loaded.mt5_terminal_instance_id.as_deref(),
            Some("mt5_0123456789abcdef01234567")
        );
        assert_eq!(loaded.observer_account_label.as_deref(), Some("AB"));
        assert!(!loaded.auto_start_enabled);
        store.save_platform("mt4").expect("save platform");
        let encoded: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read saved preferences"))
                .expect("decode saved preferences");
        assert_eq!(encoded["Platform"], "mt4");
        assert!(encoded.get("Mt5TerminalInstanceId").is_some());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn damaged_oversized_and_invalid_values_fail_back_to_safe_defaults() {
        let path = test_path("damage");
        fs::write(&path, b"{not-json").expect("write damaged preferences");
        let store = BridgePreferencesStore::new(&path).expect("store");
        assert_eq!(store.load(), BridgeUserPreferences::default());
        fs::write(
            &path,
            format!(
                "{{\"Platform\":\"other\",\"Mt4TerminalInstanceId\":\"bad\",\"ObserverEnabled\":false,\"ObserverBridgeUserId\":-1,\"AutoStartEnabled\":false,\"padding\":\"{}\"}}",
                "x".repeat(MAX_PREFERENCES_BYTES as usize)
            ),
        )
        .expect("write oversized preferences");
        assert_eq!(store.load(), BridgeUserPreferences::default());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn terminal_selection_is_platform_scoped_and_atomically_replaceable() {
        let path = test_path("selection");
        let store = BridgePreferencesStore::new(&path).expect("store");
        store.save_platform("MT4").expect("save platform");
        store
            .save_terminal("mt4", "mt4_0123456789abcdef01234567")
            .expect("save mt4 terminal");
        store
            .save_terminal("mt5", "mt5_89abcdef0123456701234567")
            .expect("save mt5 terminal");
        let loaded = store.load();
        assert_eq!(
            loaded.selected_terminal_instance_id(),
            Some("mt4_0123456789abcdef01234567")
        );
        assert!(
            store
                .save_terminal("mt4", "mt5_89abcdef0123456701234567")
                .is_err()
        );
        let parent = path.parent().expect("parent");
        let file_name = path.file_name().expect("file name").to_string_lossy();
        assert!(
            fs::read_dir(parent)
                .expect("read temp directory")
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&format!(".{file_name}.{}.", std::process::id())))
        );
        let _ = fs::remove_file(path);
    }
}
