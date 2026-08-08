//! Safe publication of an already verified Bridge release directory.
//!
//! A release directory is never made visible by copying files into an active
//! version.  New versions use an atomic same-volume rename whenever possible.
//! If Windows keeps returning a transient sharing/lock error, a new,
//! unprotected version may be built with a marker-last copy protocol.  Same
//! version repair is deliberately atomic-only and keeps a rollback receipt
//! until the caller has persisted the rest of its installation state.

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
};

pub const RELEASE_MARKER_FILE_NAME: &str = ".aurum-release.json";
const MAXIMUM_MARKER_BYTES: u64 = 128 * 1024;
const MAXIMUM_RENAME_ATTEMPTS: u32 = 7;
const RETRY_DELAYS: [Duration; 6] = [
    Duration::from_millis(100),
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleasePublishMode {
    NewVersion,
    SameVersionRepair,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleasePublishStrategy {
    AtomicRename,
    AtomicRenameAfterRetry,
    VerifiedCopy,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleasePublishOutcome {
    pub strategy: ReleasePublishStrategy,
    pub attempts: u32,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleasePublishError {
    code: &'static str,
    phase: &'static str,
    raw_os_error: Option<i32>,
    error_kind: Option<io::ErrorKind>,
    attempts: u32,
    elapsed_ms: u128,
}

impl ReleasePublishError {
    fn new(code: &'static str, phase: &'static str) -> Self {
        Self {
            code,
            phase,
            raw_os_error: None,
            error_kind: None,
            attempts: 0,
            elapsed_ms: 0,
        }
    }

    fn io(
        code: &'static str,
        phase: &'static str,
        error: &io::Error,
        attempts: u32,
        elapsed_ms: u128,
    ) -> Self {
        Self {
            code,
            phase,
            raw_os_error: error.raw_os_error(),
            error_kind: Some(error.kind()),
            attempts,
            elapsed_ms,
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn phase(&self) -> &'static str {
        self.phase
    }

    pub fn raw_os_error(&self) -> Option<i32> {
        self.raw_os_error
    }

    pub fn error_kind(&self) -> Option<io::ErrorKind> {
        self.error_kind
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.elapsed_ms
    }

    /// A bounded, path-free diagnostic suitable for the local installer log.
    pub fn diagnostic_line(&self) -> String {
        format!(
            "stage={};raw_os_error={};error_kind={};attempts={};elapsed_ms={}",
            self.phase,
            self.raw_os_error
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_owned()),
            self.error_kind
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|| "none".to_owned()),
            self.attempts,
            self.elapsed_ms,
        )
    }
}

impl std::fmt::Display for ReleasePublishError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ReleasePublishError {}

pub struct ReleasePublishRequest<'a> {
    pub versions_root: &'a Path,
    pub source_directory: &'a Path,
    pub destination_version: &'a str,
    pub protected_versions: &'a HashSet<String>,
    pub mode: ReleasePublishMode,
    pub io_error_code: &'static str,
    pub repair_restore_error_code: &'static str,
    pub validate_layout: &'a dyn Fn(&Path) -> Result<(), &'static str>,
}

/// A publication receipt keeps a repair backup until the caller has persisted
/// all related installation state.  Dropping an uncommitted receipt leaves the
/// backup in place so a later startup/repair can recover it rather than losing
/// the only known-good version.
#[must_use = "a release publication must be committed or rolled back"]
#[derive(Debug)]
pub struct ReleasePublishReceipt {
    destination: PathBuf,
    backup: Option<PathBuf>,
    mode: ReleasePublishMode,
    io_error_code: &'static str,
    repair_restore_error_code: &'static str,
    outcome: ReleasePublishOutcome,
}

impl ReleasePublishReceipt {
    pub fn destination(&self) -> &Path {
        &self.destination
    }

    pub fn outcome(&self) -> &ReleasePublishOutcome {
        &self.outcome
    }

    pub fn backup_path(&self) -> Option<&Path> {
        self.backup.as_deref()
    }

    /// Finalize a publication after the caller has persisted its pointer and
    /// registration.  Backup cleanup is intentionally best-effort; retaining
    /// a stale, uniquely named backup is safer than reporting a healthy
    /// installation as failed after the new version has already been verified.
    pub fn commit(mut self) {
        if let Some(backup) = self.backup.take()
            && let Err(error) = remove_private_directory(&backup)
        {
            eprintln!(
                "native_release_publish_commit_cleanup_failed stage=commit_backup_cleanup raw_os_error={} error_kind={:?}",
                error
                    .raw_os_error()
                    .map_or_else(|| "none".to_owned(), |value| value.to_string()),
                error.kind()
            );
        }
    }

    /// Roll back a publication without a file-by-file replacement.  Repair
    /// rollback only uses another same-volume rename, preserving the original
    /// version directory as the recovery source.
    pub fn rollback(mut self) -> Result<(), ReleasePublishError> {
        let Some(backup) = self.backup.take() else {
            if self.mode == ReleasePublishMode::NewVersion && self.destination.exists() {
                remove_private_directory(&self.destination).map_err(|error| {
                    ReleasePublishError::io(
                        self.io_error_code,
                        "rollback_new_version",
                        &error,
                        1,
                        0,
                    )
                })?;
            }
            return Ok(());
        };

        if self.destination.exists() {
            remove_private_directory(&self.destination).map_err(|error| {
                ReleasePublishError::io(
                    self.repair_restore_error_code,
                    "repair_restore_cleanup",
                    &error,
                    1,
                    0,
                )
            })?;
        }
        let started = Instant::now();
        let (attempts, result) = rename_with_retry(
            &backup,
            &self.destination,
            &|source, destination| fs::rename(source, destination),
            &|delay| thread::sleep(delay),
        );
        result.map_err(|error| {
            ReleasePublishError::io(
                self.repair_restore_error_code,
                "repair_restore",
                &error,
                attempts,
                started.elapsed().as_millis(),
            )
        })
    }
}

pub fn publish_release(
    request: ReleasePublishRequest<'_>,
) -> Result<ReleasePublishReceipt, ReleasePublishError> {
    publish_release_with_ops(
        request,
        &|source, destination| fs::rename(source, destination),
        &|delay| thread::sleep(delay),
        &copy_file_create_new,
    )
}

/// Remove an interrupted, uncommitted version directory after the caller has
/// proved that no activation pointer refers to it.  A valid marker with a
/// different manifest must be treated as a conflict by the caller and must
/// never be passed here.
pub fn discard_unpublished_release(
    versions_root: &Path,
    version: &str,
    protected_versions: &HashSet<String>,
    error_code: &'static str,
) -> Result<bool, ReleasePublishError> {
    validate_version_name(version)
        .map_err(|code| ReleasePublishError::new(code, "discard_validate"))?;
    let versions_root = absolute_directory(versions_root)
        .map_err(|error| ReleasePublishError::io(error_code, "discard_validate", &error, 0, 0))?;
    let destination = versions_root.join(version);
    if protected_versions
        .iter()
        .any(|value| value.eq_ignore_ascii_case(version))
    {
        return Ok(false);
    }
    let Some(metadata) = fs::symlink_metadata(&destination).ok() else {
        return Ok(false);
    };
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(ReleasePublishError::new(
            "update_staged_release_cleanup_boundary",
            "discard_validate",
        ));
    }
    remove_private_directory(&destination)
        .map_err(|error| ReleasePublishError::io(error_code, "discard_cleanup", &error, 1, 0))?;
    Ok(true)
}

#[cfg(test)]
fn publish_release_with_ops(
    request: ReleasePublishRequest<'_>,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sleep: &dyn Fn(Duration),
    copy_file: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<ReleasePublishReceipt, ReleasePublishError> {
    publish_release_inner(request, rename, sleep, copy_file)
}

#[cfg(not(test))]
fn publish_release_with_ops(
    request: ReleasePublishRequest<'_>,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sleep: &dyn Fn(Duration),
    copy_file: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<ReleasePublishReceipt, ReleasePublishError> {
    publish_release_inner(request, rename, sleep, copy_file)
}

fn publish_release_inner(
    request: ReleasePublishRequest<'_>,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sleep: &dyn Fn(Duration),
    copy_file: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<ReleasePublishReceipt, ReleasePublishError> {
    let started = Instant::now();
    validate_version_name(request.destination_version)
        .map_err(|code| ReleasePublishError::new(code, "validate_destination_version"))?;
    let versions_root = absolute_directory(request.versions_root).map_err(|error| {
        ReleasePublishError::io(
            request.io_error_code,
            "validate_versions_root",
            &error,
            0,
            started.elapsed().as_millis(),
        )
    })?;
    let source = absolute_directory(request.source_directory).map_err(|error| {
        ReleasePublishError::io(
            request.io_error_code,
            "validate_source",
            &error,
            0,
            started.elapsed().as_millis(),
        )
    })?;
    if paths_equal(&source, &versions_root)
        || source == versions_root.join(request.destination_version)
        || !is_safe_directory(&source)
    {
        return Err(ReleasePublishError::new(
            "update_version_publish_boundary",
            "validate_source",
        ));
    }
    let destination = versions_root.join(request.destination_version);
    if destination.parent() != Some(versions_root.as_path()) {
        return Err(ReleasePublishError::new(
            "update_version_publish_boundary",
            "validate_destination",
        ));
    }
    let marker_source = source.join(RELEASE_MARKER_FILE_NAME);
    validate_marker(&marker_source).map_err(|error| {
        ReleasePublishError::io(
            request.io_error_code,
            "validate_marker",
            &error,
            0,
            started.elapsed().as_millis(),
        )
    })?;

    let existing = fs::symlink_metadata(&destination).ok();
    let target_protected = request
        .protected_versions
        .iter()
        .any(|value| value.eq_ignore_ascii_case(request.destination_version));
    match request.mode {
        ReleasePublishMode::NewVersion => {
            if existing.is_some() || target_protected {
                return Err(ReleasePublishError::new(
                    "update_version_already_exists",
                    "validate_destination",
                ));
            }
            let (attempts, rename_result) = rename_with_retry(&source, &destination, rename, sleep);
            match rename_result {
                Ok(()) => {
                    if let Err(code) =
                        validate_published_directory(&destination, request.validate_layout)
                    {
                        let _ = remove_private_directory(&destination);
                        return Err(ReleasePublishError::new(code, "validate_published"));
                    }
                    Ok(ReleasePublishReceipt {
                        destination,
                        backup: None,
                        mode: request.mode,
                        io_error_code: request.io_error_code,
                        repair_restore_error_code: request.repair_restore_error_code,
                        outcome: ReleasePublishOutcome {
                            strategy: if attempts == 1 {
                                ReleasePublishStrategy::AtomicRename
                            } else {
                                ReleasePublishStrategy::AtomicRenameAfterRetry
                            },
                            attempts,
                            elapsed_ms: started.elapsed().as_millis(),
                        },
                    })
                }
                Err(error) if is_retryable_windows_error(&error) => {
                    if destination.exists() || target_is_protected(&request) {
                        return Err(ReleasePublishError::io(
                            request.io_error_code,
                            "publish_rename",
                            &error,
                            attempts,
                            started.elapsed().as_millis(),
                        ));
                    }
                    let outcome = copy_publish(
                        &source,
                        &destination,
                        request.validate_layout,
                        copy_file,
                        request.io_error_code,
                        attempts,
                        started,
                    )?;
                    Ok(ReleasePublishReceipt {
                        destination,
                        backup: None,
                        mode: request.mode,
                        io_error_code: request.io_error_code,
                        repair_restore_error_code: request.repair_restore_error_code,
                        outcome,
                    })
                }
                Err(error) => Err(ReleasePublishError::io(
                    request.io_error_code,
                    "publish_rename",
                    &error,
                    attempts,
                    started.elapsed().as_millis(),
                )),
            }
        }
        ReleasePublishMode::SameVersionRepair => {
            let Some(metadata) = existing else {
                return Err(ReleasePublishError::new(
                    "update_version_missing",
                    "repair_backup",
                ));
            };
            if !metadata.is_dir() || is_reparse(&metadata) {
                return Err(ReleasePublishError::new(
                    "update_version_publish_boundary",
                    "repair_backup",
                ));
            }
            let backup = unique_backup_path(&versions_root, request.destination_version);
            let (backup_attempts, backup_result) =
                rename_with_retry(&destination, &backup, rename, sleep);
            if let Err(error) = backup_result {
                return Err(ReleasePublishError::io(
                    request.io_error_code,
                    "repair_backup",
                    &error,
                    backup_attempts,
                    started.elapsed().as_millis(),
                ));
            }
            let (publish_attempts, publish_result) =
                rename_with_retry(&source, &destination, rename, sleep);
            if let Err(error) = publish_result {
                return Err(restore_after_failed_repair(
                    backup,
                    destination,
                    request.io_error_code,
                    request.repair_restore_error_code,
                    publish_attempts,
                    error,
                    started.elapsed(),
                    rename,
                    sleep,
                ));
            }
            if let Err(code) = validate_published_directory(&destination, request.validate_layout) {
                let _ = remove_private_directory(&destination);
                return Err(restore_after_failed_repair_code(
                    backup,
                    destination,
                    request.repair_restore_error_code,
                    code,
                    started.elapsed(),
                    rename,
                    sleep,
                ));
            }
            Ok(ReleasePublishReceipt {
                destination,
                backup: Some(backup),
                mode: request.mode,
                io_error_code: request.io_error_code,
                repair_restore_error_code: request.repair_restore_error_code,
                outcome: ReleasePublishOutcome {
                    strategy: if backup_attempts + publish_attempts == 2 {
                        ReleasePublishStrategy::AtomicRename
                    } else {
                        ReleasePublishStrategy::AtomicRenameAfterRetry
                    },
                    attempts: backup_attempts + publish_attempts,
                    elapsed_ms: started.elapsed().as_millis(),
                },
            })
        }
    }
}

fn copy_publish(
    source: &Path,
    destination: &Path,
    validate_layout: &dyn Fn(&Path) -> Result<(), &'static str>,
    copy_file: &dyn Fn(&Path, &Path) -> io::Result<()>,
    error_code: &'static str,
    rename_attempts: u32,
    started: Instant,
) -> Result<ReleasePublishOutcome, ReleasePublishError> {
    let source_tree = collect_tree(source, RELEASE_MARKER_FILE_NAME).map_err(|error| {
        ReleasePublishError::io(
            error_code,
            "publish_copy_scan",
            &error,
            rename_attempts,
            started.elapsed().as_millis(),
        )
    })?;
    if !source_tree.contains_key(Path::new(RELEASE_MARKER_FILE_NAME)) {
        return Err(ReleasePublishError::new(
            "update_version_publish_marker_missing",
            "publish_copy_scan",
        ));
    }
    if fs::create_dir(destination).is_err() {
        return Err(ReleasePublishError::new(
            "update_version_publish_race",
            "publish_copy_create",
        ));
    }
    let copy_result = (|| {
        for (relative, entry) in &source_tree {
            if relative == Path::new(RELEASE_MARKER_FILE_NAME) {
                continue;
            }
            let target = destination.join(relative);
            match entry {
                TreeEntry::Directory => {
                    fs::create_dir_all(&target)?;
                }
                TreeEntry::File { .. } => {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    copy_file(&source.join(relative), &target)?;
                }
            }
        }
        let non_marker = collect_tree(destination, RELEASE_MARKER_FILE_NAME)?;
        compare_trees_without_marker(&source_tree, &non_marker).map_err(io::Error::other)?;
        validate_layout(destination).map_err(io::Error::other)?;
        let marker = source.join(RELEASE_MARKER_FILE_NAME);
        let marker_target = destination.join(RELEASE_MARKER_FILE_NAME);
        copy_file(&marker, &marker_target)?;
        let destination_tree = collect_tree(destination, RELEASE_MARKER_FILE_NAME)?;
        compare_trees(&source_tree, &destination_tree).map_err(io::Error::other)?;
        validate_published_directory(destination, validate_layout).map_err(io::Error::other)?;
        Ok::<(), io::Error>(())
    })();
    if let Err(error) = copy_result {
        let _ = remove_private_directory(destination);
        return Err(ReleasePublishError::io(
            error_code,
            "publish_copy",
            &error,
            rename_attempts,
            started.elapsed().as_millis(),
        ));
    }
    Ok(ReleasePublishOutcome {
        strategy: ReleasePublishStrategy::VerifiedCopy,
        attempts: rename_attempts,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn validate_published_directory(
    directory: &Path,
    validate_layout: &dyn Fn(&Path) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let marker = directory.join(RELEASE_MARKER_FILE_NAME);
    validate_marker(&marker).map_err(|_| "update_version_publish_marker_invalid")?;
    validate_layout(directory)
}

#[allow(clippy::too_many_arguments)]
fn restore_after_failed_repair(
    backup: PathBuf,
    destination: PathBuf,
    publish_error_code: &'static str,
    restore_error_code: &'static str,
    attempts: u32,
    error: io::Error,
    elapsed: Duration,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sleep: &dyn Fn(Duration),
) -> ReleasePublishError {
    let _ = remove_private_directory(&destination);
    let (restore_attempts, restore_result) =
        rename_with_retry(&backup, &destination, rename, sleep);
    match restore_result {
        Ok(()) => ReleasePublishError::io(
            publish_error_code,
            "repair_publish",
            &error,
            attempts,
            elapsed.as_millis(),
        ),
        Err(restore_error) => ReleasePublishError::io(
            restore_error_code,
            "repair_restore",
            &restore_error,
            restore_attempts,
            elapsed.as_millis(),
        ),
    }
}

fn restore_after_failed_repair_code(
    backup: PathBuf,
    destination: PathBuf,
    error_code: &'static str,
    failed_code: &'static str,
    elapsed: Duration,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sleep: &dyn Fn(Duration),
) -> ReleasePublishError {
    let _ = remove_private_directory(&destination);
    let (restore_attempts, restore_result) =
        rename_with_retry(&backup, &destination, rename, sleep);
    match restore_result {
        Ok(()) => ReleasePublishError::new(failed_code, "validate_published"),
        Err(error) => ReleasePublishError::io(
            error_code,
            "repair_restore",
            &error,
            restore_attempts,
            elapsed.as_millis(),
        ),
    }
}

fn rename_with_retry(
    source: &Path,
    destination: &Path,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sleep: &dyn Fn(Duration),
) -> (u32, Result<(), io::Error>) {
    let mut attempts = 0_u32;
    loop {
        attempts += 1;
        match rename(source, destination) {
            Ok(()) => return (attempts, Ok(())),
            Err(error)
                if is_retryable_windows_error(&error) && attempts < MAXIMUM_RENAME_ATTEMPTS =>
            {
                if let Some(delay) = RETRY_DELAYS.get((attempts - 1) as usize) {
                    sleep(*delay);
                }
            }
            Err(error) => return (attempts, Err(error)),
        }
    }
}

fn is_retryable_windows_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

fn validate_version_name(value: &str) -> Result<(), &'static str> {
    let components = value.split('.').collect::<Vec<_>>();
    if !(2..=4).contains(&components.len())
        || components.iter().any(|component| {
            component.is_empty()
                || !component.bytes().all(|byte| byte.is_ascii_digit())
                || component.len() > 10
        })
    {
        return Err("update_release_version_invalid");
    }
    Ok(())
}

fn absolute_directory(path: &Path) -> io::Result<PathBuf> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path"));
    }
    let absolute = std::path::absolute(path)?;
    for ancestor in absolute.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        if is_reparse(&metadata) || metadata.file_type().is_symlink() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "reparse"));
        }
    }
    let metadata = fs::symlink_metadata(&absolute)?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "directory"));
    }
    Ok(absolute)
}

fn is_safe_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !is_reparse(&metadata))
        .unwrap_or(false)
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

fn validate_marker(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || is_reparse(&metadata)
        || metadata.len() == 0
        || metadata.len() > MAXIMUM_MARKER_BYTES
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "marker"));
    }
    Ok(())
}

fn unique_backup_path(versions_root: &Path, version: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let nonce = format!(
        "{}-{}-{}",
        std::process::id(),
        timestamp,
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    versions_root.join(format!(".repair-backup-{version}-{nonce}"))
}

fn remove_private_directory(path: &Path) -> io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "boundary"));
    }
    fs::remove_dir_all(path)
}

fn target_is_protected(request: &ReleasePublishRequest<'_>) -> bool {
    request
        .protected_versions
        .iter()
        .any(|value| value.eq_ignore_ascii_case(request.destination_version))
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TreeEntry {
    Directory,
    File { size: u64, sha256: [u8; 32] },
}

fn collect_tree(root: &Path, marker: &str) -> io::Result<BTreeMap<PathBuf, TreeEntry>> {
    let mut entries = BTreeMap::new();
    collect_tree_inner(root, root, marker, &mut entries)?;
    Ok(entries)
}

fn collect_tree_inner(
    root: &Path,
    directory: &Path,
    marker: &str,
    entries: &mut BTreeMap<PathBuf, TreeEntry>,
) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if is_reparse(&metadata) || metadata.file_type().is_symlink() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "reparse"));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "boundary"))?;
        if !valid_relative_path(relative) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "path"));
        }
        if metadata.is_dir() {
            entries.insert(relative.to_path_buf(), TreeEntry::Directory);
            collect_tree_inner(root, &path, marker, entries)?;
        } else if metadata.is_file() {
            let hash = hash_file(&path)?;
            entries.insert(
                relative.to_path_buf(),
                TreeEntry::File {
                    size: metadata.len(),
                    sha256: hash,
                },
            );
        } else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "entry"));
        }
        if relative == Path::new(marker) {
            // The marker is allowed to exist at the root and is copied last;
            // nested files with the marker name remain ordinary files.
        }
    }
    Ok(())
}

fn valid_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn compare_trees_without_marker(
    source: &BTreeMap<PathBuf, TreeEntry>,
    destination: &BTreeMap<PathBuf, TreeEntry>,
) -> Result<(), &'static str> {
    let filter = |tree: &BTreeMap<PathBuf, TreeEntry>| {
        tree.iter()
            .filter(|(path, _)| path.as_path() != Path::new(RELEASE_MARKER_FILE_NAME))
            .map(|(path, entry)| (path.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    if filter(source) == filter(destination) {
        Ok(())
    } else {
        Err("update_version_publish_integrity_failed")
    }
}

fn compare_trees(
    source: &BTreeMap<PathBuf, TreeEntry>,
    destination: &BTreeMap<PathBuf, TreeEntry>,
) -> Result<(), &'static str> {
    if source == destination {
        Ok(())
    } else {
        Err("update_version_publish_integrity_failed")
    }
}

fn hash_file(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn copy_file_create_new(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = File::open(source)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(destination)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "liangjian-release-publish-{}-{}-{label}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let versions = root.join("versions");
        let source = root.join("operation").join("version");
        fs::create_dir_all(&source).expect("source");
        fs::create_dir_all(&versions).expect("versions");
        fs::write(source.join("AURUMBridge.exe"), b"bridge").expect("core");
        fs::write(source.join(RELEASE_MARKER_FILE_NAME), b"marker").expect("marker");
        (root, versions, source)
    }

    fn request<'a>(
        versions: &'a Path,
        source: &'a Path,
        protected: &'a HashSet<String>,
        mode: ReleasePublishMode,
    ) -> ReleasePublishRequest<'a> {
        ReleasePublishRequest {
            versions_root: versions,
            source_directory: source,
            destination_version: "3.0.0",
            protected_versions: protected,
            mode,
            io_error_code: "publish_failed",
            repair_restore_error_code: "restore_failed",
            validate_layout: &|_| Ok(()),
        }
    }

    fn real_copy(source: &Path, destination: &Path) -> io::Result<()> {
        copy_file_create_new(source, destination)
    }

    #[test]
    fn atomic_rename_is_the_fast_path() {
        let (root, versions, source) = fixture("rename");
        let protected = HashSet::new();
        let receipt = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::NewVersion,
            ),
            &|source, destination| fs::rename(source, destination),
            &|_| {},
            &real_copy,
        )
        .expect("publish");
        assert_eq!(
            receipt.outcome().strategy,
            ReleasePublishStrategy::AtomicRename
        );
        assert!(!source.exists());
        assert!(versions.join("3.0.0/.aurum-release.json").is_file());
        receipt.commit();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn retryable_windows_error_retries_then_renames() {
        let (root, versions, source) = fixture("retry");
        let protected = HashSet::new();
        let attempts = Arc::new(Mutex::new(0_u32));
        let state = attempts.clone();
        let receipt = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::NewVersion,
            ),
            &move |source, destination| {
                let mut value = state.lock().expect("counter");
                *value += 1;
                if *value <= 2 {
                    Err(io::Error::from_raw_os_error(32))
                } else {
                    fs::rename(source, destination)
                }
            },
            &|_| {},
            &real_copy,
        )
        .expect("publish after retries");
        assert_eq!(*attempts.lock().expect("counter"), 3);
        assert_eq!(receipt.outcome().attempts, 3);
        assert_eq!(
            receipt.outcome().strategy,
            ReleasePublishStrategy::AtomicRenameAfterRetry
        );
        receipt.commit();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn persistent_retryable_error_uses_marker_last_verified_copy() {
        let (root, versions, source) = fixture("copy");
        let protected = HashSet::new();
        let receipt = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::NewVersion,
            ),
            &|_, _| Err(io::Error::from_raw_os_error(5)),
            &|_| {},
            &real_copy,
        )
        .expect("verified copy");
        assert_eq!(
            receipt.outcome().strategy,
            ReleasePublishStrategy::VerifiedCopy
        );
        assert!(versions.join("3.0.0/.aurum-release.json").is_file());
        receipt.commit();
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn non_retryable_error_fails_closed_without_copy() {
        let (root, versions, source) = fixture("non-retry");
        let protected = HashSet::new();
        let error = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::NewVersion,
            ),
            &|_, _| Err(io::Error::from_raw_os_error(87)),
            &|_| panic!("must not sleep"),
            &real_copy,
        )
        .expect_err("nonretryable error");
        assert_eq!(error.code(), "publish_failed");
        assert_eq!(error.attempts(), 1);
        assert_eq!(error.raw_os_error(), Some(87));
        assert!(source.exists());
        assert!(!versions.join("3.0.0").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn copy_failure_removes_uncommitted_destination_and_marker() {
        let (root, versions, source) = fixture("copy-failure");
        let protected = HashSet::new();
        let calls = Arc::new(Mutex::new(0_u32));
        let state = calls.clone();
        let error = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::NewVersion,
            ),
            &|_, _| Err(io::Error::from_raw_os_error(32)),
            &|_| {},
            &move |source, destination| {
                let mut count = state.lock().expect("counter");
                *count += 1;
                if *count == 1 {
                    Err(io::Error::from_raw_os_error(32))
                } else {
                    real_copy(source, destination)
                }
            },
        )
        .expect_err("copy should fail");
        assert_eq!(error.code(), "publish_failed");
        assert!(!versions.join("3.0.0").exists());
        assert!(source.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn protected_new_version_never_enters_copy_fallback() {
        let (root, versions, source) = fixture("protected");
        let protected = HashSet::from(["3.0.0".to_owned()]);
        let error = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::NewVersion,
            ),
            &|_, _| panic!("protected target must fail before rename"),
            &|_| {},
            &real_copy,
        )
        .expect_err("protected target");
        assert_eq!(error.code(), "update_version_already_exists");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn repair_keeps_backup_until_commit_and_can_restore_atomically() {
        let (root, versions, source) = fixture("repair");
        let destination = versions.join("3.0.0");
        fs::create_dir_all(&destination).expect("destination");
        fs::write(destination.join("old.txt"), b"old").expect("old");
        let protected = HashSet::from(["3.0.0".to_owned()]);
        let receipt = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::SameVersionRepair,
            ),
            &|source, destination| fs::rename(source, destination),
            &|_| {},
            &real_copy,
        )
        .expect("repair");
        let backup = receipt.backup_path().expect("backup").to_path_buf();
        assert!(backup.is_dir());
        receipt.rollback().expect("restore");
        assert!(destination.join("old.txt").is_file());
        assert!(!backup.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn repair_publish_failure_with_successful_restore_keeps_original_publish_error() {
        let (root, versions, source) = fixture("repair-publish-failure");
        let destination = versions.join("3.0.0");
        fs::create_dir_all(&destination).expect("destination");
        fs::write(destination.join("old.txt"), b"old").expect("old");
        let protected = HashSet::from(["3.0.0".to_owned()]);
        let calls = Arc::new(Mutex::new(0_u32));
        let state = calls.clone();
        let error = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::SameVersionRepair,
            ),
            &move |source, destination| {
                let mut call = state.lock().expect("counter");
                *call += 1;
                match *call {
                    1 => fs::rename(source, destination),
                    2 => Err(io::Error::from_raw_os_error(87)),
                    3 => fs::rename(source, destination),
                    _ => panic!("unexpected rename call"),
                }
            },
            &|_| {},
            &real_copy,
        )
        .expect_err("publish failure");
        assert_eq!(error.code(), "publish_failed");
        assert!(destination.join("old.txt").is_file());
        assert!(versions.read_dir().expect("versions").all(|entry| {
            !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".repair-backup-")
        }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn repair_publish_failure_with_restore_failure_uses_restore_error() {
        let (root, versions, source) = fixture("repair-restore-failure");
        let destination = versions.join("3.0.0");
        fs::create_dir_all(&destination).expect("destination");
        fs::write(destination.join("old.txt"), b"old").expect("old");
        let protected = HashSet::from(["3.0.0".to_owned()]);
        let calls = Arc::new(Mutex::new(0_u32));
        let state = calls.clone();
        let error = publish_release_with_ops(
            request(
                &versions,
                &source,
                &protected,
                ReleasePublishMode::SameVersionRepair,
            ),
            &move |source, destination| {
                let mut call = state.lock().expect("counter");
                *call += 1;
                match *call {
                    1 => fs::rename(source, destination),
                    2 | 3 => Err(io::Error::from_raw_os_error(87)),
                    _ => panic!("unexpected rename call"),
                }
            },
            &|_| {},
            &real_copy,
        )
        .expect_err("publish and restore failure");
        assert_eq!(error.code(), "restore_failed");
        assert_eq!(error.raw_os_error(), Some(87));
        assert!(versions.read_dir().expect("versions").any(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".repair-backup-")
        }));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn path_validation_rejects_parent_components() {
        assert!(!valid_relative_path(Path::new("..\\outside")));
        assert!(!valid_relative_path(Path::new("C:\\outside")));
        assert!(valid_relative_path(Path::new("modules\\core.dll")));
    }

    #[test]
    fn ancestor_reparse_points_are_rejected_without_rejecting_a_drive_root() {
        let (root, versions, _source) = fixture("ancestor-boundary");
        let absolute_versions = absolute_directory(&versions).expect("normal ancestors");
        let text = absolute_versions.to_string_lossy();
        if text.len() >= 2 && text.as_bytes()[1] == b':' {
            let drive_root = format!("{}\\", &text[..2]);
            assert!(absolute_directory(Path::new(&drive_root)).is_ok());
        }

        let junction = root.join("junction");
        let junction_result = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &root.to_string_lossy(),
            ])
            .output();
        if junction_result
            .as_ref()
            .is_ok_and(|output| output.status.success())
        {
            let child = junction.join("child");
            fs::create_dir_all(&child).expect("junction child");
            assert!(absolute_directory(&child).is_err());
            let _ = fs::remove_dir_all(&junction);
        }
        fs::remove_dir_all(root).expect("cleanup");
    }
}
