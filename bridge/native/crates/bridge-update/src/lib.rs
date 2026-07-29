mod activation;
mod coordinator;
mod manifest;
mod staging;

pub use activation::{ReleaseActivationPointer, pending_launcher_handoff};
pub use coordinator::{
    BridgeUpdateCoordinator, BridgeUpdateEnvironment, StagedRelease, UPDATE_CHECK_INTERVAL,
};
pub use manifest::{
    ReleaseManifest, ReleaseManifestClient, ReleaseManifestVerifier, ReleasePackage,
    canonicalize_manifest, canonicalize_package,
};
pub use staging::{
    ReleasePackageStager, extract_verified_package, verified_expanded_size, verify_package_file,
};

use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

pub const UPDATE_STATE_FILE_NAME: &str = "update-state.json";
pub const STATE_CHECKING: &str = "checking";
pub const STATE_DOWNLOADING: &str = "downloading";
pub const STATE_WAITING_WINDOW: &str = "waiting_window";
pub const STATE_ACQUIRING_LEASE: &str = "acquiring_lease";
pub const STATE_DRAINING: &str = "draining";
pub const STATE_ACTIVATING: &str = "activating";
pub const STATE_VERIFYING: &str = "verifying";
pub const STATE_HEALTHY: &str = "healthy";
pub const STATE_ROLLED_BACK: &str = "rolled_back";
pub const STATE_FAILED: &str = "failed";

const MAXIMUM_STATE_BYTES: u64 = 64 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeUpdateState {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub state: String,
    pub target_version: Option<String>,
    pub release_id: Option<String>,
    pub priority: Option<String>,
    #[serde(default)]
    pub manual_activation_requested: bool,
    pub staged_at_utc_msc: Option<i64>,
    pub activation_started_at_utc_msc: Option<i64>,
    #[serde(default = "default_minimum_idle_seconds")]
    pub minimum_idle_seconds: u32,
    pub activation_deadline_utc_msc: Option<i64>,
    pub maintenance_lease_id: Option<String>,
    pub maintenance_lease_expires_at_utc_msc: Option<i64>,
    pub next_retry_at_utc_msc: Option<i64>,
    pub last_error_code: Option<String>,
    pub updated_at_utc_msc: i64,
}

impl BridgeUpdateState {
    pub fn validate(&self) -> Result<(), UpdateError> {
        let requires_target = !matches!(self.state.as_str(), STATE_CHECKING | STATE_FAILED);
        let requires_staged_at = matches!(
            self.state.as_str(),
            STATE_WAITING_WINDOW
                | STATE_ACQUIRING_LEASE
                | STATE_DRAINING
                | STATE_ACTIVATING
                | STATE_VERIFYING
        );
        let requires_lease = matches!(self.state.as_str(), STATE_DRAINING | STATE_ACTIVATING);
        let allows_lease =
            requires_lease || matches!(self.state.as_str(), STATE_VERIFYING | STATE_ROLLED_BACK);
        let valid = self.schema_version == 1
            && valid_state(&self.state)
            && self.updated_at_utc_msc > 0
            && (!requires_target
                || self
                    .target_version
                    .as_deref()
                    .is_some_and(valid_dotnet_version)
                    && matches!(self.priority.as_deref(), Some("normal" | "urgent")))
            && self
                .release_id
                .as_deref()
                .is_none_or(|value| value.len() <= 128)
            && self.staged_at_utc_msc.is_none_or(|value| value > 0)
            && self
                .activation_started_at_utc_msc
                .is_none_or(|value| value > 0)
            && (30..=3600).contains(&self.minimum_idle_seconds)
            && self
                .activation_deadline_utc_msc
                .is_none_or(|value| value >= 0)
            && self
                .maintenance_lease_id
                .as_deref()
                .is_none_or(|value| value.len() <= 128 && value.starts_with("lease_"))
            && self
                .maintenance_lease_expires_at_utc_msc
                .is_none_or(|value| value >= 0)
            && self.maintenance_lease_id.is_none()
                == self.maintenance_lease_expires_at_utc_msc.is_none()
            && (!requires_lease || self.maintenance_lease_id.is_some())
            && (allows_lease || self.maintenance_lease_id.is_none())
            && self.next_retry_at_utc_msc.is_none_or(|value| value >= 0)
            && self
                .last_error_code
                .as_deref()
                .is_none_or(|value| value.len() <= 256)
            && (self.state != STATE_FAILED
                || self
                    .last_error_code
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty()))
            && (!requires_staged_at || self.staged_at_utc_msc.is_some());
        if valid {
            Ok(())
        } else {
            Err(UpdateError::new("update_state_invalid"))
        }
    }

    pub fn notice(&self) -> Option<UpdateNotice> {
        let phase = match self.state.as_str() {
            STATE_DOWNLOADING => "downloading",
            STATE_WAITING_WINDOW => "ready",
            STATE_ACQUIRING_LEASE => "waiting",
            STATE_DRAINING | STATE_ACTIVATING | STATE_VERIFYING => "activating",
            STATE_FAILED => "failed",
            STATE_ROLLED_BACK => "rolled_back",
            STATE_HEALTHY => "healthy",
            STATE_CHECKING => return None,
            _ => return None,
        };
        Some(UpdateNotice {
            version: self.target_version.clone().unwrap_or_default(),
            urgent: self.priority.as_deref() == Some("urgent"),
            phase,
            manual_activation_requested: self.manual_activation_requested,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateNotice {
    pub version: String,
    pub urgent: bool,
    pub phase: &'static str,
    pub manual_activation_requested: bool,
}

#[derive(Clone)]
pub struct BridgeUpdateStateStore {
    state_path: PathBuf,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    mutation_gate: Arc<Mutex<()>>,
}

impl BridgeUpdateStateStore {
    pub fn new(state_path: impl AsRef<Path>) -> Result<Self, UpdateError> {
        Self::with_clock(state_path, now_utc_msc)
    }

    pub fn with_clock(
        state_path: impl AsRef<Path>,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Result<Self, UpdateError> {
        let state_path = std::path::absolute(state_path.as_ref())
            .map_err(|_| UpdateError::new("update_state_path_invalid"))?;
        if state_path.file_name().is_none() {
            return Err(UpdateError::new("update_state_path_invalid"));
        }
        Ok(Self {
            state_path,
            clock: Arc::new(clock),
            mutation_gate: Arc::new(Mutex::new(())),
        })
    }

    pub fn path(&self) -> &Path {
        &self.state_path
    }

    pub fn load(&self) -> Result<Option<BridgeUpdateState>, UpdateError> {
        let _guard = self
            .mutation_gate
            .lock()
            .map_err(|_| UpdateError::new("update_state_io_failed"))?;
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Result<Option<BridgeUpdateState>, UpdateError> {
        let metadata = match fs::metadata(&self.state_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(UpdateError::new("update_state_io_failed")),
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_STATE_BYTES {
            return Err(UpdateError::new("update_state_invalid"));
        }
        let payload =
            fs::read(&self.state_path).map_err(|_| UpdateError::new("update_state_io_failed"))?;
        let state = serde_json::from_slice::<BridgeUpdateState>(&payload)
            .map_err(|_| UpdateError::new("update_state_invalid"))?;
        state.validate()?;
        Ok(Some(state))
    }

    pub fn save(&self, state: BridgeUpdateState) -> Result<BridgeUpdateState, UpdateError> {
        let _guard = self
            .mutation_gate
            .lock()
            .map_err(|_| UpdateError::new("update_state_io_failed"))?;
        self.save_unlocked(state)
    }

    fn save_unlocked(
        &self,
        mut state: BridgeUpdateState,
    ) -> Result<BridgeUpdateState, UpdateError> {
        state.updated_at_utc_msc = (self.clock)();
        state.validate()?;
        let payload =
            serde_json::to_vec(&state).map_err(|_| UpdateError::new("update_state_invalid"))?;
        if payload.is_empty() || payload.len() as u64 > MAXIMUM_STATE_BYTES {
            return Err(UpdateError::new("update_state_invalid"));
        }
        let directory = self
            .state_path
            .parent()
            .ok_or_else(|| UpdateError::new("update_state_path_invalid"))?;
        fs::create_dir_all(directory).map_err(|_| UpdateError::new("update_state_io_failed"))?;
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = directory.join(format!(
            ".{}.{}.{}.{}.tmp",
            self.state_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(UPDATE_STATE_FILE_NAME),
            std::process::id(),
            timestamp_nanos(),
            sequence
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| UpdateError::new("update_state_io_failed"))?;
            file.write_all(&payload)
                .map_err(|_| UpdateError::new("update_state_io_failed"))?;
            file.sync_all()
                .map_err(|_| UpdateError::new("update_state_io_failed"))?;
            drop(file);
            replace_file(&temporary, &self.state_path)
                .map_err(|_| UpdateError::new("update_state_io_failed"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(state)
    }

    pub fn request_manual_activation(&self) -> Result<Option<BridgeUpdateState>, UpdateError> {
        let _guard = self
            .mutation_gate
            .lock()
            .map_err(|_| UpdateError::new("update_state_io_failed"))?;
        let Some(mut state) = self.load_unlocked()? else {
            return Ok(None);
        };
        if state.state != STATE_WAITING_WINDOW || state.manual_activation_requested {
            return Ok((state.state == STATE_WAITING_WINDOW).then_some(state));
        }
        state.manual_activation_requested = true;
        self.save_unlocked(state).map(Some)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdateError {
    code: &'static str,
}

impl UpdateError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(self) -> &'static str {
        self.code
    }
}

impl Display for UpdateError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for UpdateError {}

fn valid_state(value: &str) -> bool {
    matches!(
        value,
        STATE_CHECKING
            | STATE_DOWNLOADING
            | STATE_WAITING_WINDOW
            | STATE_ACQUIRING_LEASE
            | STATE_DRAINING
            | STATE_ACTIVATING
            | STATE_VERIFYING
            | STATE_HEALTHY
            | STATE_ROLLED_BACK
            | STATE_FAILED
    )
}

fn valid_dotnet_version(value: &str) -> bool {
    let components = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&components.len())
        && components.iter().all(|component| {
            !component.is_empty()
                && component.bytes().all(|value| value.is_ascii_digit())
                && component.parse::<i32>().is_ok()
        })
}

fn schema_version() -> u32 {
    1
}

fn default_minimum_idle_seconds() -> u32 {
    120
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

fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    let source = wide_path(source);
    let destination = wide_path(destination);
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_store_round_trips_the_dotnet_json_contract_and_marks_manual_activation() {
        let root = unique_test_directory("round-trip");
        let path = root.join(UPDATE_STATE_FILE_NAME);
        let store =
            BridgeUpdateStateStore::with_clock(&path, || 1_800_000_000_123).expect("state store");
        let saved = store.save(waiting_state()).expect("save waiting state");
        assert_eq!(saved.updated_at_utc_msc, 1_800_000_000_123);
        let payload = fs::read_to_string(&path).expect("state payload");
        assert!(payload.contains("\"schema_version\":1"));
        assert!(payload.contains("\"state\":\"waiting_window\""));
        assert!(payload.contains("\"manual_activation_requested\":false"));
        assert_eq!(store.load(), Ok(Some(saved.clone())));

        let requested = store
            .request_manual_activation()
            .expect("request activation")
            .expect("waiting state");
        assert!(requested.manual_activation_requested);
        assert_eq!(requested.notice().expect("notice").phase, "ready");
        assert_eq!(store.load(), Ok(Some(requested)));
        assert_eq!(fs::read_dir(&root).expect("state directory").count(), 1);
        fs::remove_dir_all(root).expect("remove state fixture");
    }

    #[test]
    fn concurrent_manual_activation_requests_share_one_atomic_state_transition() {
        let root = unique_test_directory("concurrent-request");
        let path = root.join(UPDATE_STATE_FILE_NAME);
        let store =
            BridgeUpdateStateStore::with_clock(&path, || 1_800_000_000_123).expect("state store");
        store.save(waiting_state()).expect("save waiting state");
        let requests = (0..16)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store
                        .request_manual_activation()
                        .expect("request activation")
                        .expect("waiting state")
                })
            })
            .collect::<Vec<_>>();
        assert!(requests.into_iter().all(|request| {
            request
                .join()
                .expect("activation request thread")
                .manual_activation_requested
        }));
        assert!(
            store
                .load()
                .expect("load update state")
                .expect("persisted update state")
                .manual_activation_requested
        );
        assert_eq!(fs::read_dir(&root).expect("state directory").count(), 1);
        fs::remove_dir_all(root).expect("remove state fixture");
    }

    #[test]
    fn damaged_unknown_and_non_waiting_states_fail_closed() {
        let root = unique_test_directory("fail-closed");
        fs::create_dir_all(&root).expect("state directory");
        let path = root.join(UPDATE_STATE_FILE_NAME);
        let store =
            BridgeUpdateStateStore::with_clock(&path, || 1_800_000_000_123).expect("state store");
        fs::write(
            &path,
            br#"{"schema_version":1,"state":"checking","updated_at_utc_msc":1,"unknown":true}"#,
        )
        .expect("unknown state");
        assert_eq!(
            store.load().expect_err("unknown field").code(),
            "update_state_invalid"
        );
        let checking = BridgeUpdateState {
            schema_version: 1,
            state: STATE_CHECKING.to_owned(),
            target_version: None,
            release_id: None,
            priority: None,
            manual_activation_requested: false,
            staged_at_utc_msc: None,
            activation_started_at_utc_msc: None,
            minimum_idle_seconds: 120,
            activation_deadline_utc_msc: None,
            maintenance_lease_id: None,
            maintenance_lease_expires_at_utc_msc: None,
            next_retry_at_utc_msc: None,
            last_error_code: None,
            updated_at_utc_msc: 1,
        };
        store.save(checking).expect("save checking");
        assert_eq!(store.request_manual_activation(), Ok(None));
        fs::remove_dir_all(root).expect("remove state fixture");
    }

    #[test]
    fn validation_matches_required_dotnet_phase_fields() {
        let state = waiting_state();
        assert_eq!(state.validate(), Ok(()));
        let mut invalid = state.clone();
        invalid.staged_at_utc_msc = None;
        assert_eq!(
            invalid.validate().expect_err("missing staged time").code(),
            "update_state_invalid"
        );
        let mut invalid = state.clone();
        invalid.target_version = Some("3".to_owned());
        assert_eq!(
            invalid.validate().expect_err("invalid version").code(),
            "update_state_invalid"
        );
        let mut failed = state;
        failed.state = STATE_FAILED.to_owned();
        failed.target_version = None;
        failed.priority = None;
        failed.staged_at_utc_msc = None;
        failed.last_error_code = Some("update_check_failed".to_owned());
        assert_eq!(failed.validate(), Ok(()));
        assert_eq!(failed.notice().expect("failed notice").version, "");
    }

    fn waiting_state() -> BridgeUpdateState {
        BridgeUpdateState {
            schema_version: 1,
            state: STATE_WAITING_WINDOW.to_owned(),
            target_version: Some("3.0.1".to_owned()),
            release_id: Some("release-3.0.1".to_owned()),
            priority: Some("urgent".to_owned()),
            manual_activation_requested: false,
            staged_at_utc_msc: Some(1_800_000_000_000),
            activation_started_at_utc_msc: None,
            minimum_idle_seconds: 120,
            activation_deadline_utc_msc: None,
            maintenance_lease_id: None,
            maintenance_lease_expires_at_utc_msc: None,
            next_retry_at_utc_msc: None,
            last_error_code: None,
            updated_at_utc_msc: 1_800_000_000_000,
        }
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-update-state-{}-{}-{suffix}",
            std::process::id(),
            timestamp_nanos()
        ))
    }
}
