use crate::coordinator::read_file_version;
use crate::manifest::DotNetVersion;
use crate::{StagedRelease, TEMP_SEQUENCE, UpdateError, replace_file, timestamp_nanos};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::ptr::null;
use std::sync::atomic::Ordering;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
};

const POINTER_FILE_NAME: &str = "current.json";
const LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
const MAXIMUM_POINTER_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseActivationPointer {
    pub active_version: String,
    pub last_known_good_version: String,
    pub status: String,
    #[serde(default)]
    pub expected_terminal_instance_ids: Vec<String>,
    pub updated_at_utc_msc: i64,
}

#[derive(Clone)]
pub struct ReleaseActivationStore {
    pointer_path: PathBuf,
}

impl ReleaseActivationStore {
    pub fn new(pointer_path: impl AsRef<Path>) -> Result<Self, UpdateError> {
        let pointer_path = std::path::absolute(pointer_path.as_ref())
            .map_err(|_| UpdateError::new("update_pointer_invalid"))?;
        if pointer_path.file_name().and_then(|value| value.to_str()) != Some(POINTER_FILE_NAME) {
            return Err(UpdateError::new("update_pointer_invalid"));
        }
        Ok(Self { pointer_path })
    }

    pub fn load(&self) -> Result<ReleaseActivationPointer, UpdateError> {
        let metadata = fs::metadata(&self.pointer_path)
            .map_err(|_| UpdateError::new("update_pointer_invalid"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_POINTER_BYTES {
            return Err(UpdateError::new("update_pointer_invalid"));
        }
        let payload =
            fs::read(&self.pointer_path).map_err(|_| UpdateError::new("update_pointer_invalid"))?;
        let pointer = serde_json::from_slice::<ReleaseActivationPointer>(&payload)
            .map_err(|_| UpdateError::new("update_pointer_invalid"))?;
        validate_pointer(&pointer)?;
        Ok(pointer)
    }

    pub(crate) fn prepare(
        &self,
        staged: &StagedRelease,
        running_version: &str,
        expected_terminal_instance_ids: &[String],
        now_utc_msc: i64,
    ) -> Result<(), UpdateError> {
        let pointer = self.load()?;
        let running = DotNetVersion::parse(running_version)
            .ok_or_else(|| UpdateError::new("update_activation_invalid"))?;
        let target = DotNetVersion::parse(&staged.version)
            .ok_or_else(|| UpdateError::new("update_activation_invalid"))?;
        let versions_root = self
            .pointer_path
            .parent()
            .ok_or_else(|| UpdateError::new("update_activation_invalid"))?
            .join("versions");
        let expected_directory = versions_root.join(&staged.version);
        let actual_directory = std::path::absolute(&staged.version_directory)
            .map_err(|_| UpdateError::new("update_activation_invalid"))?;
        if target <= running
            || pointer.active_version != running_version
            || !paths_equal(&actual_directory, &expected_directory)
            || !actual_directory.join("AURUMBridge.exe").is_file()
            || now_utc_msc <= 0
        {
            return Err(UpdateError::new("update_activation_invalid"));
        }
        let expected_terminal_instance_ids =
            normalize_terminal_ids(expected_terminal_instance_ids)?;
        self.save(&ReleaseActivationPointer {
            active_version: staged.version.clone(),
            last_known_good_version: pointer.last_known_good_version,
            status: "pending".to_owned(),
            expected_terminal_instance_ids,
            updated_at_utc_msc: now_utc_msc,
        })
    }

    pub fn mark_healthy(
        &self,
        expected_active_version: &str,
        now_utc_msc: i64,
    ) -> Result<ReleaseActivationPointer, UpdateError> {
        let pointer = self.load()?;
        if pointer.active_version != expected_active_version || now_utc_msc <= 0 {
            return Err(UpdateError::new("update_activation_invalid"));
        }
        let healthy = ReleaseActivationPointer {
            active_version: pointer.active_version.clone(),
            last_known_good_version: pointer.active_version,
            status: "healthy".to_owned(),
            expected_terminal_instance_ids: Vec::new(),
            updated_at_utc_msc: now_utc_msc,
        };
        self.save(&healthy)?;
        Ok(healthy)
    }

    pub fn mark_rolled_back(
        &self,
        failed_active_version: &str,
        now_utc_msc: i64,
    ) -> Result<ReleaseActivationPointer, UpdateError> {
        let pointer = self.load()?;
        if pointer.active_version != failed_active_version
            || pointer.active_version == pointer.last_known_good_version
            || now_utc_msc <= 0
        {
            return Err(UpdateError::new("update_activation_invalid"));
        }
        let rolled_back = ReleaseActivationPointer {
            active_version: pointer.last_known_good_version.clone(),
            last_known_good_version: pointer.last_known_good_version,
            status: "rolled_back".to_owned(),
            expected_terminal_instance_ids: pointer.expected_terminal_instance_ids,
            updated_at_utc_msc: now_utc_msc,
        };
        self.save(&rolled_back)?;
        Ok(rolled_back)
    }

    pub fn confirm_rollback(
        &self,
        expected_active_version: &str,
        now_utc_msc: i64,
    ) -> Result<ReleaseActivationPointer, UpdateError> {
        let pointer = self.load()?;
        if pointer.status != "rolled_back"
            || pointer.active_version != expected_active_version
            || pointer.last_known_good_version != expected_active_version
            || now_utc_msc <= 0
        {
            return Err(UpdateError::new("update_activation_invalid"));
        }
        let confirmed = ReleaseActivationPointer {
            active_version: pointer.active_version,
            last_known_good_version: pointer.last_known_good_version,
            status: pointer.status,
            expected_terminal_instance_ids: Vec::new(),
            updated_at_utc_msc: now_utc_msc,
        };
        self.save(&confirmed)?;
        Ok(confirmed)
    }

    fn save(&self, pointer: &ReleaseActivationPointer) -> Result<(), UpdateError> {
        validate_pointer(pointer)?;
        let payload =
            serde_json::to_vec(pointer).map_err(|_| UpdateError::new("update_pointer_invalid"))?;
        let parent = self
            .pointer_path
            .parent()
            .ok_or_else(|| UpdateError::new("update_pointer_invalid"))?;
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".current.{}.{}.{}.tmp",
            std::process::id(),
            timestamp_nanos(),
            sequence
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .custom_flags(FILE_FLAG_WRITE_THROUGH)
                .open(&temporary)
                .map_err(|_| UpdateError::new("update_pointer_io_failed"))?;
            file.write_all(&payload)
                .and_then(|()| file.sync_all())
                .map_err(|_| UpdateError::new("update_pointer_io_failed"))?;
            drop(file);
            replace_file(&temporary, &self.pointer_path)
                .map_err(|_| UpdateError::new("update_pointer_io_failed"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

pub fn pending_launcher_handoff(
    application_directory: impl AsRef<Path>,
) -> Result<Option<PathBuf>, UpdateError> {
    let application_directory = std::path::absolute(application_directory.as_ref())
        .map_err(|_| UpdateError::new("update_environment_path_invalid"))?;
    let Some(current_version) = application_directory
        .file_name()
        .and_then(|value| value.to_str())
    else {
        return Ok(None);
    };
    if DotNetVersion::parse(current_version).is_none() {
        return Ok(None);
    }
    let Some(versions_root) = application_directory.parent() else {
        return Ok(None);
    };
    if !versions_root
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("versions"))
    {
        return Ok(None);
    }
    let Some(install_root) = versions_root.parent() else {
        return Ok(None);
    };
    let stable_launcher = install_root.join(LAUNCHER_FILE_NAME);
    if !stable_launcher.is_file() {
        return Ok(None);
    }
    let pointer = ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))?.load()?;
    if pointer.status != "pending" || pointer.active_version == current_version {
        return Ok(None);
    }
    let target_directory = install_root.join("versions").join(&pointer.active_version);
    if !target_directory.join("AURUMBridge.exe").is_file() {
        return Err(UpdateError::new("update_activation_invalid"));
    }
    let staged_launcher = target_directory.join("launcher").join(LAUNCHER_FILE_NAME);
    if !staged_launcher.is_file() {
        return Err(UpdateError::new("update_activation_invalid"));
    }
    Ok(Some(staged_launcher))
}

pub fn promote_staged_launcher(
    staged_launcher: impl AsRef<Path>,
    launched_version: &str,
) -> Result<bool, UpdateError> {
    let staged_launcher = std::path::absolute(staged_launcher.as_ref())
        .map_err(|_| UpdateError::new("update_launcher_promotion_invalid"))?;
    let (install_root, staged_version) = staged_launcher_identity(&staged_launcher)?;
    if staged_version != launched_version || DotNetVersion::parse(launched_version).is_none() {
        return Err(UpdateError::new("update_launcher_promotion_invalid"));
    }
    let pointer = ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))?.load()?;
    if pointer.status != "healthy"
        || pointer.active_version != launched_version
        || pointer.last_known_good_version != launched_version
    {
        return Err(UpdateError::new("update_launcher_promotion_not_healthy"));
    }
    let stable_launcher = install_root.join(LAUNCHER_FILE_NAME);
    if !stable_launcher.is_file() {
        return Err(UpdateError::new("update_launcher_promotion_invalid"));
    }
    let candidate_version = read_file_version(&staged_launcher)?;
    let stable_version = read_file_version(&stable_launcher)?;
    if !should_promote_launcher_versions(&candidate_version, &stable_version)? {
        return Ok(false);
    }
    promote_launcher_file(&staged_launcher, &stable_launcher, &candidate_version)?;
    Ok(true)
}

fn should_promote_launcher_versions(
    candidate_version: &str,
    stable_version: &str,
) -> Result<bool, UpdateError> {
    let candidate = DotNetVersion::parse(candidate_version)
        .ok_or_else(|| UpdateError::new("update_launcher_version_invalid"))?;
    let stable = DotNetVersion::parse(stable_version)
        .ok_or_else(|| UpdateError::new("update_launcher_version_invalid"))?;
    Ok(candidate > stable)
}

fn staged_launcher_identity(staged_launcher: &Path) -> Result<(PathBuf, String), UpdateError> {
    if staged_launcher.file_name().and_then(|value| value.to_str()) != Some(LAUNCHER_FILE_NAME)
        || !staged_launcher.is_file()
    {
        return Err(UpdateError::new("update_launcher_promotion_invalid"));
    }
    let launcher_directory = staged_launcher
        .parent()
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("launcher"))
        })
        .ok_or_else(|| UpdateError::new("update_launcher_promotion_invalid"))?;
    let version_directory = launcher_directory
        .parent()
        .ok_or_else(|| UpdateError::new("update_launcher_promotion_invalid"))?;
    let version = version_directory
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| DotNetVersion::parse(value).is_some())
        .ok_or_else(|| UpdateError::new("update_launcher_promotion_invalid"))?;
    let versions_root = version_directory
        .parent()
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("versions"))
        })
        .ok_or_else(|| UpdateError::new("update_launcher_promotion_invalid"))?;
    let install_root = versions_root
        .parent()
        .ok_or_else(|| UpdateError::new("update_launcher_promotion_invalid"))?;
    Ok((install_root.to_path_buf(), version.to_owned()))
}

fn promote_launcher_file(
    source: &Path,
    stable_launcher: &Path,
    expected_version: &str,
) -> Result<(), UpdateError> {
    let install_root = stable_launcher
        .parent()
        .ok_or_else(|| UpdateError::new("update_launcher_promotion_invalid"))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nonce = format!("{}.{}.{}", std::process::id(), timestamp_nanos(), sequence);
    let pending = install_root.join(format!(".AURUMBridge.Launcher.{nonce}.pending.exe"));
    let backup = install_root.join(format!(".AURUMBridge.Launcher.{nonce}.previous.exe"));
    let result = (|| {
        let mut input = fs::File::open(source)
            .map_err(|_| UpdateError::new("update_launcher_promotion_io_failed"))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .custom_flags(FILE_FLAG_WRITE_THROUGH)
            .open(&pending)
            .map_err(|_| UpdateError::new("update_launcher_promotion_io_failed"))?;
        io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|_| UpdateError::new("update_launcher_promotion_io_failed"))?;
        drop(output);
        if read_file_version(&pending)? != expected_version {
            return Err(UpdateError::new("update_launcher_version_invalid"));
        }
        replace_file_with_backup(stable_launcher, &pending, &backup)?;
        if read_file_version(stable_launcher)? != expected_version {
            let _ = restore_launcher_backup(stable_launcher, &backup);
            return Err(UpdateError::new("update_launcher_promotion_io_failed"));
        }
        fs::remove_file(&backup)
            .map_err(|_| UpdateError::new("update_launcher_promotion_io_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&pending);
        if !stable_launcher.is_file() && backup.is_file() {
            let _ = replace_file(&backup, stable_launcher);
        }
    }
    result
}

fn replace_file_with_backup(
    destination: &Path,
    replacement: &Path,
    backup: &Path,
) -> Result<(), UpdateError> {
    let destination = wide_null(destination);
    let replacement = wide_null(replacement);
    let backup = wide_null(backup);
    let result = unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            replacement.as_ptr(),
            backup.as_ptr(),
            REPLACEFILE_WRITE_THROUGH,
            null(),
            null(),
        )
    };
    if result == 0 {
        return Err(UpdateError::new("update_launcher_promotion_io_failed"));
    }
    Ok(())
}

fn restore_launcher_backup(destination: &Path, backup: &Path) -> Result<(), UpdateError> {
    let recovery = destination.with_file_name(format!(
        ".AURUMBridge.Launcher.{}.rejected.exe",
        timestamp_nanos()
    ));
    replace_file_with_backup(destination, backup, &recovery)?;
    let _ = fs::remove_file(recovery);
    Ok(())
}

fn wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn validate_pointer(pointer: &ReleaseActivationPointer) -> Result<(), UpdateError> {
    if DotNetVersion::parse(&pointer.active_version).is_none()
        || DotNetVersion::parse(&pointer.last_known_good_version).is_none()
        || !matches!(
            pointer.status.as_str(),
            "pending" | "healthy" | "rolled_back"
        )
        || normalize_terminal_ids(&pointer.expected_terminal_instance_ids)?
            != pointer.expected_terminal_instance_ids
        || pointer.updated_at_utc_msc <= 0
    {
        return Err(UpdateError::new("update_pointer_invalid"));
    }
    Ok(())
}

fn normalize_terminal_ids(values: &[String]) -> Result<Vec<String>, UpdateError> {
    if values.len() > 64
        || values.iter().any(|value| {
            value.is_empty()
                || value.len() > 128
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
    {
        return Err(UpdateError::new("update_pointer_invalid"));
    }
    Ok(values
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn prepares_the_exact_dotnet_pending_pointer_and_detects_ui_handoff() {
        let root = test_directory("pending");
        let current = root.join("versions/3.0.0");
        let target = root.join("versions/3.1.0");
        fs::create_dir_all(&current).expect("current directory");
        fs::create_dir_all(target.join("launcher")).expect("target directory");
        fs::write(target.join("AURUMBridge.exe"), []).expect("target executable");
        fs::write(target.join("launcher").join(LAUNCHER_FILE_NAME), []).expect("target launcher");
        fs::write(root.join(LAUNCHER_FILE_NAME), []).expect("launcher");
        fs::write(
            root.join(POINTER_FILE_NAME),
            br#"{"active_version":"3.0.0","last_known_good_version":"3.0.0","status":"healthy","expected_terminal_instance_ids":[],"updated_at_utc_msc":1}"#,
        )
        .expect("pointer");
        let store = ReleaseActivationStore::new(root.join(POINTER_FILE_NAME)).expect("store");
        store
            .prepare(
                &StagedRelease {
                    version: "3.1.0".to_owned(),
                    version_directory: target,
                    release_id: Some("release_3.1.0".to_owned()),
                    priority: "normal".to_owned(),
                    minimum_idle_seconds: 120,
                    activation_deadline_utc_msc: None,
                },
                "3.0.0",
                &["mt5_b".to_owned(), "mt4_a".to_owned(), "mt5_b".to_owned()],
                1_800_000_000_000,
            )
            .expect("prepare");
        assert_eq!(
            store.load().expect("pending pointer"),
            ReleaseActivationPointer {
                active_version: "3.1.0".to_owned(),
                last_known_good_version: "3.0.0".to_owned(),
                status: "pending".to_owned(),
                expected_terminal_instance_ids: vec!["mt4_a".to_owned(), "mt5_b".to_owned()],
                updated_at_utc_msc: 1_800_000_000_000,
            }
        );
        assert_eq!(
            pending_launcher_handoff(&current).expect("handoff"),
            Some(
                root.join("versions/3.1.0/launcher")
                    .join(LAUNCHER_FILE_NAME)
            )
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn staged_launcher_identity_is_versioned_and_atomic_replacement_keeps_a_backup() {
        let root = test_directory("launcher-promotion");
        let staged = root
            .join("versions/3.1.0/launcher")
            .join(LAUNCHER_FILE_NAME);
        fs::create_dir_all(staged.parent().expect("staged parent")).expect("staged directory");
        fs::write(&staged, b"candidate").expect("staged launcher");
        assert_eq!(
            staged_launcher_identity(&staged),
            Ok((root.clone(), "3.1.0".to_owned()))
        );

        let stable = root.join(LAUNCHER_FILE_NAME);
        let replacement = root.join("replacement.exe");
        let backup = root.join("previous.exe");
        fs::write(&stable, b"stable").expect("stable launcher");
        fs::write(&replacement, b"replacement").expect("replacement launcher");
        replace_file_with_backup(&stable, &replacement, &backup).expect("replace launcher");
        assert_eq!(fs::read(&stable).expect("promoted bytes"), b"replacement");
        assert_eq!(fs::read(&backup).expect("backup bytes"), b"stable");
        assert!(!replacement.exists());
        restore_launcher_backup(&stable, &backup).expect("restore backup");
        assert_eq!(fs::read(&stable).expect("restored bytes"), b"stable");
        assert!(!backup.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn launcher_promotion_is_strictly_monotonic() {
        assert_eq!(should_promote_launcher_versions("3.1.0", "3.0.0"), Ok(true));
        assert_eq!(
            should_promote_launcher_versions("3.0.0", "3.0.0"),
            Ok(false)
        );
        assert_eq!(
            should_promote_launcher_versions("2.9.9", "3.0.0"),
            Ok(false)
        );
        assert_eq!(
            should_promote_launcher_versions("invalid", "3.0.0")
                .expect_err("invalid version")
                .code(),
            "update_launcher_version_invalid"
        );
    }

    #[test]
    fn damaged_or_non_installed_layout_never_starts_the_launcher() {
        let root = test_directory("rejected");
        fs::create_dir_all(root.join("versions/3.0.0")).expect("version directory");
        fs::write(root.join(LAUNCHER_FILE_NAME), []).expect("launcher");
        fs::write(root.join(POINTER_FILE_NAME), b"{damaged").expect("damaged pointer");
        assert_eq!(pending_launcher_handoff(root.join("development")), Ok(None));
        assert_eq!(
            pending_launcher_handoff(root.join("versions/3.0.0"))
                .expect_err("damaged installed pointer")
                .code(),
            "update_pointer_invalid"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn launcher_health_and_rollback_transitions_preserve_the_dotnet_pointer_contract() {
        let root = test_directory("launcher-transitions");
        fs::create_dir_all(&root).expect("root");
        let path = root.join(POINTER_FILE_NAME);
        fs::write(
            &path,
            br#"{"active_version":"3.1.0","last_known_good_version":"3.0.0","status":"pending","expected_terminal_instance_ids":["mt5_a"],"updated_at_utc_msc":1}"#,
        )
        .expect("pending pointer");
        let store = ReleaseActivationStore::new(&path).expect("store");
        assert_eq!(
            store
                .mark_healthy("3.1.0", 1_800_000_000_001)
                .expect("mark healthy"),
            ReleaseActivationPointer {
                active_version: "3.1.0".to_owned(),
                last_known_good_version: "3.1.0".to_owned(),
                status: "healthy".to_owned(),
                expected_terminal_instance_ids: Vec::new(),
                updated_at_utc_msc: 1_800_000_000_001,
            }
        );

        fs::write(
            &path,
            br#"{"active_version":"3.2.0","last_known_good_version":"3.1.0","status":"pending","expected_terminal_instance_ids":["mt4_b"],"updated_at_utc_msc":2}"#,
        )
        .expect("second pending pointer");
        assert_eq!(
            store
                .mark_rolled_back("3.2.0", 1_800_000_000_002)
                .expect("mark rolled back"),
            ReleaseActivationPointer {
                active_version: "3.1.0".to_owned(),
                last_known_good_version: "3.1.0".to_owned(),
                status: "rolled_back".to_owned(),
                expected_terminal_instance_ids: vec!["mt4_b".to_owned()],
                updated_at_utc_msc: 1_800_000_000_002,
            }
        );
        assert_eq!(
            store
                .confirm_rollback("3.1.0", 1_800_000_000_003)
                .expect("confirm rollback")
                .expected_terminal_instance_ids,
            Vec::<String>::new()
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn test_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-update-activation-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
