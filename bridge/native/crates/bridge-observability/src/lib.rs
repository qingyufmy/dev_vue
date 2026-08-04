use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::error::Error;
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_WRITE_THROUGH, FILE_SHARE_READ, FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::SystemInformation::GetSystemTime;
use windows_sys::Win32::System::Time::SystemTimeToTzSpecificLocalTime;

const DEFAULT_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_RETAINED_FILES: usize = 10;
const DEFAULT_RECENT_LOG_LINES: usize = 1_000;
const MAX_RECENT_LOG_LINES: usize = 10_000;
// The log viewer refreshes automatically.  Keep each file refresh bounded even when a
// retained log file contains very long messages or has grown unexpectedly.
const MAX_LOG_TAIL_BYTES: usize = 256 * 1024;
const MAX_LOG_REFRESH_BYTES: usize = 4 * 1024 * 1024;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;
const LOG_TAIL_READ_BLOCK_BYTES: usize = 16 * 1024;
const MT5_DIAGNOSTIC_FILE_NAME: &str = "mt5-worker-diagnostics.jsonl";
const SECRET_NAMES: [&str; 7] = [
    "access_token",
    "refresh_token",
    "password",
    "authorization",
    "ticket",
    "device_key",
    "private_key",
];
static UNIQUE_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogError {
    code: &'static str,
}

impl LogError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl Display for LogError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for LogError {}

#[derive(Clone, Debug)]
pub struct LoggerConfig {
    pub log_directory: PathBuf,
    pub max_file_bytes: u64,
    pub retained_files: usize,
}

#[derive(Clone, Debug)]
pub struct BridgeLogReader {
    log_directories: Vec<LogDirectorySource>,
}

#[derive(Clone, Debug)]
struct LogDirectorySource {
    directory: PathBuf,
    label: Option<String>,
}

#[derive(Deserialize)]
struct DisplayLogRecord {
    #[serde(default)]
    timestamp_utc: String,
    #[serde(default)]
    level: String,
    #[serde(default)]
    event_name: String,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct DiagnosticLogRecord {
    #[serde(default)]
    observed_at_utc_msc: Option<i64>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    exception_type: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    consecutive_failures: Option<u32>,
}

#[derive(Clone, Copy)]
enum LogFileKind {
    Bridge,
    Mt5Diagnostic,
}

struct LogLineCandidate {
    timestamp_utc: Option<String>,
    source_key: String,
    line_number: usize,
    rendered: String,
}

impl BridgeLogReader {
    pub fn new(log_directory: impl AsRef<Path>) -> Result<Self, LogError> {
        Self::from_directories([log_directory])
    }

    /// Creates a reader over a fixed set of log directories.
    ///
    /// The reader never walks outside the directories supplied by the caller.  Keeping the
    /// directory list explicit lets the UI aggregate the default profile and its existing
    /// observer profiles without exposing arbitrary files under the application data root.  Each
    /// directory only contributes `bridge-*.log` and the exact MT5 diagnostic file.
    pub fn from_directories<I>(log_directories: I) -> Result<Self, LogError>
    where
        I: IntoIterator,
        I::Item: AsRef<Path>,
    {
        let mut directories = Vec::new();
        for directory in log_directories {
            directories.push((None, directory.as_ref().to_path_buf()));
        }
        Self::from_directory_sources(directories)
    }

    /// Creates a reader over explicitly named sources.  Labels are supplied by the caller (the
    /// UI uses validated profile IDs); they are never inferred from a filesystem path.
    pub fn from_named_directories<I, S, P>(sources: I) -> Result<Self, LogError>
    where
        I: IntoIterator<Item = (S, P)>,
        S: AsRef<str>,
        P: AsRef<Path>,
    {
        let mut directories = Vec::new();
        for (label, directory) in sources {
            let label = label.as_ref();
            validate_source_label(label)?;
            directories.push((Some(label.to_owned()), directory.as_ref().to_path_buf()));
        }
        Self::from_directory_sources(directories)
    }

    fn from_directory_sources(sources: Vec<(Option<String>, PathBuf)>) -> Result<Self, LogError> {
        let mut directories = Vec::new();
        for (label, directory) in sources {
            let directory = absolute_path(&directory, "bridge_log_reader_path_invalid")?;
            if !directories
                .iter()
                .any(|existing: &LogDirectorySource| existing.directory == directory)
            {
                directories.push(LogDirectorySource { directory, label });
            }
        }
        if directories.is_empty() {
            return Err(LogError::new("bridge_log_reader_path_invalid"));
        }
        Ok(Self {
            log_directories: directories,
        })
    }

    pub fn read_recent_text(&self, max_lines: Option<usize>) -> Result<String, LogError> {
        let max_lines = max_lines
            .unwrap_or(DEFAULT_RECENT_LOG_LINES)
            .clamp(1, MAX_RECENT_LOG_LINES);
        let mut existing_directory_count = 0_usize;
        let mut directory_read_failures = 0_usize;
        let mut files = Vec::new();
        for source in &self.log_directories {
            if !source.directory.is_dir() {
                continue;
            }
            existing_directory_count = existing_directory_count.saturating_add(1);
            let Ok(entries) = fs::read_dir(&source.directory) else {
                directory_read_failures = directory_read_failures.saturating_add(1);
                continue;
            };
            files.extend(entries.filter_map(Result::ok).filter_map(|entry| {
                let path = entry.path();
                log_file_kind(&path).map(|kind| (path, kind, source.label.clone()))
            }));
        }
        if existing_directory_count == 0 {
            return Ok("暂无日志。".to_owned());
        }
        files.sort_by(|left, right| {
            left.0
                .to_string_lossy()
                .to_ascii_lowercase()
                .cmp(&right.0.to_string_lossy().to_ascii_lowercase())
        });
        let discovered_file_count = files.len();
        debug_assert!(planned_tail_read_bytes(discovered_file_count) <= MAX_LOG_REFRESH_BYTES);
        let file_tail_budget = per_file_tail_budget(discovered_file_count);
        let mut candidates = Vec::new();
        let mut readable_file_count = 0_usize;
        for (path, kind, label) in files {
            let Ok(tail) = read_log_file_tail(&path, file_tail_budget) else {
                continue;
            };
            readable_file_count = readable_file_count.saturating_add(1);
            let mut file_lines = VecDeque::with_capacity(max_lines);
            let source_key = path.to_string_lossy().to_ascii_lowercase();
            let mut last_valid_timestamp = None;
            let context = LogFileContext {
                kind,
                label: label.as_deref(),
                source_key: &source_key,
            };
            tail.for_each_line(|line_number, line| {
                append_log_line_candidate(
                    line,
                    &context,
                    line_number,
                    &mut last_valid_timestamp,
                    &mut file_lines,
                    max_lines,
                );
            });
            candidates.extend(file_lines);
        }
        if discovered_file_count > 0 && readable_file_count == 0 {
            return Err(LogError::new("bridge_log_read_failed"));
        }
        if discovered_file_count == 0 && directory_read_failures == existing_directory_count {
            return Err(LogError::new("bridge_log_read_failed"));
        }
        if candidates.is_empty() {
            return Ok("暂无日志。".to_owned());
        }
        candidates.sort_by(|left, right| {
            compare_log_timestamps(&left.timestamp_utc, &right.timestamp_utc)
                .then_with(|| left.source_key.cmp(&right.source_key))
                .then_with(|| left.line_number.cmp(&right.line_number))
        });
        let first = candidates.len().saturating_sub(max_lines);
        Ok(candidates
            .drain(first..)
            .map(|candidate| candidate.rendered)
            .collect::<Vec<_>>()
            .join("\r\n"))
    }
}

impl LoggerConfig {
    pub fn new(log_directory: impl AsRef<Path>) -> Result<Self, LogError> {
        Ok(Self {
            log_directory: absolute_path(log_directory.as_ref(), "bridge_log_path_invalid")?,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            retained_files: DEFAULT_RETAINED_FILES,
        })
    }

    pub fn with_limits(
        mut self,
        max_file_bytes: u64,
        retained_files: usize,
    ) -> Result<Self, LogError> {
        if max_file_bytes < 128 {
            return Err(LogError::new("bridge_log_size_invalid"));
        }
        if !(2..=100).contains(&retained_files) {
            return Err(LogError::new("bridge_log_retention_invalid"));
        }
        self.max_file_bytes = max_file_bytes;
        self.retained_files = retained_files;
        Ok(self)
    }
}

#[derive(Clone)]
pub struct BridgeLogger {
    inner: Arc<LoggerInner>,
}

struct LoggerInner {
    config: LoggerConfig,
    write_lock: Mutex<()>,
}

#[derive(Serialize)]
struct LogRecord<'a> {
    timestamp_utc: &'a str,
    level: &'a str,
    event_name: &'a str,
    message: Option<&'a str>,
}

#[derive(Serialize)]
struct RunMarker<'a> {
    process_id: u32,
    process_role: &'a str,
    version: &'a str,
    started_at_utc: &'a str,
}

impl BridgeLogger {
    pub fn new(config: LoggerConfig) -> Self {
        Self {
            inner: Arc::new(LoggerInner {
                config,
                write_lock: Mutex::new(()),
            }),
        }
    }

    pub fn log_directory(&self) -> &Path {
        &self.inner.config.log_directory
    }

    pub fn info(&self, event_name: &str, message: Option<&str>) {
        let _ = self.write("info", event_name, message);
    }

    pub fn warning(&self, event_name: &str, message: Option<&str>) {
        let _ = self.write("warning", event_name, message);
    }

    pub fn error(&self, event_name: &str, message: Option<&str>) {
        let _ = self.write("error", event_name, message);
    }

    pub fn install_panic_hook(&self, process_role: &'static str, version: &'static str) {
        let logger = self.clone();
        std::panic::set_hook(Box::new(move |panic_info| {
            let panic_message = panic_info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| {
                    panic_info
                        .payload()
                        .downcast_ref::<String>()
                        .map(String::as_str)
                })
                .unwrap_or("non_string_panic_payload");
            let location = panic_info
                .location()
                .map(|value| format!("{}:{}:{}", value.file(), value.line(), value.column()))
                .unwrap_or_else(|| "unknown".to_owned());
            let thread_name = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_owned();
            logger.write_crash_record(
                process_role,
                version,
                &thread_name,
                &location,
                panic_message,
            );
        }));
    }

    pub fn begin_run_marker(
        &self,
        data_directory: impl AsRef<Path>,
        process_role: &str,
        version: &str,
    ) -> Result<ProcessRunMarker, LogError> {
        validate_identifier(process_role, "bridge_process_role_invalid")?;
        validate_identifier(version, "bridge_process_version_invalid")?;
        let data_directory =
            absolute_path(data_directory.as_ref(), "bridge_run_marker_path_invalid")?;
        fs::create_dir_all(&data_directory)
            .map_err(|_| LogError::new("bridge_run_marker_directory_failed"))?;
        let path = data_directory.join(format!("native-{process_role}.active"));
        if path.exists() {
            self.warning(
                "native_previous_unclean_shutdown",
                Some(&format!("process_role={process_role}")),
            );
        }
        let timestamp = utc_timestamp();
        let payload = serde_json::to_vec(&RunMarker {
            process_id: std::process::id(),
            process_role,
            version,
            started_at_utc: &timestamp.rfc3339,
        })
        .map_err(|_| LogError::new("bridge_run_marker_serialize_failed"))?;
        write_replace_sync(&path, &payload)?;
        Ok(ProcessRunMarker { path, armed: true })
    }

    fn write(
        &self,
        level: &'static str,
        event_name: &str,
        message: Option<&str>,
    ) -> Result<(), LogError> {
        let event_name = event_name.trim();
        if event_name.is_empty() {
            return Err(LogError::new("bridge_log_event_invalid"));
        }
        let _guard = self
            .inner
            .write_lock
            .lock()
            .map_err(|_| LogError::new("bridge_log_lock_failed"))?;
        let timestamp = utc_timestamp();
        let event_name = redact(event_name);
        let message = message.map(redact);
        let mut line = serde_json::to_vec(&LogRecord {
            timestamp_utc: &timestamp.rfc3339,
            level,
            event_name: &event_name,
            message: message.as_deref(),
        })
        .map_err(|_| LogError::new("bridge_log_serialize_failed"))?;
        line.extend_from_slice(b"\r\n");

        fs::create_dir_all(&self.inner.config.log_directory)
            .map_err(|_| LogError::new("bridge_log_directory_failed"))?;
        let active_path = self
            .inner
            .config
            .log_directory
            .join(format!("bridge-{}.log", timestamp.date));
        self.rotate_if_needed(&active_path, line.len() as u64, &timestamp)?;
        append_sync(&active_path, &line)?;
        self.enforce_retention(&active_path)?;
        Ok(())
    }

    fn write_crash_record(
        &self,
        process_role: &str,
        version: &str,
        thread_name: &str,
        location: &str,
        panic_message: &str,
    ) {
        let timestamp = utc_timestamp();
        let message = redact(&format!(
            "process_role={process_role} version={version} thread={thread_name} location={location} panic={panic_message}"
        ));
        let record = LogRecord {
            timestamp_utc: &timestamp.rfc3339,
            level: "error",
            event_name: "native_process_panic",
            message: Some(&message),
        };
        let Ok(mut payload) = serde_json::to_vec(&record) else {
            return;
        };
        payload.extend_from_slice(b"\r\n");
        let _ = fs::create_dir_all(&self.inner.config.log_directory);
        let path = self.inner.config.log_directory.join(format!(
            "bridge-crash-{}-{}-{}-{}.log",
            timestamp.date,
            timestamp.unix_millis,
            std::process::id(),
            UNIQUE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = write_new_sync(&path, &payload);
        if let Ok(_guard) = self.inner.write_lock.try_lock() {
            let _ = self.enforce_retention(&path);
        }
    }

    fn rotate_if_needed(
        &self,
        active_path: &Path,
        next_line_bytes: u64,
        timestamp: &UtcTimestamp,
    ) -> Result<(), LogError> {
        let existing_bytes = match active_path.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(LogError::new("bridge_log_rotation_failed")),
        };
        if existing_bytes + next_line_bytes <= self.inner.config.max_file_bytes {
            return Ok(());
        }
        let archive_path = self.inner.config.log_directory.join(format!(
            "bridge-{}-{}-{}-{}.log",
            timestamp.date,
            timestamp.unix_millis,
            std::process::id(),
            UNIQUE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::rename(active_path, archive_path)
            .map_err(|_| LogError::new("bridge_log_rotation_failed"))
    }

    fn enforce_retention(&self, active_path: &Path) -> Result<(), LogError> {
        let entries = fs::read_dir(&self.inner.config.log_directory)
            .map_err(|_| LogError::new("bridge_log_retention_failed"))?;
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| LogError::new("bridge_log_retention_failed"))?;
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(OsStr::to_str) else {
                continue;
            };
            if !entry
                .file_type()
                .map_err(|_| LogError::new("bridge_log_retention_failed"))?
                .is_file()
                || !file_name.starts_with("bridge-")
                || !file_name.ends_with(".log")
            {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            files.push((modified, path));
        }
        files.sort_by(|left, right| right.cmp(left));
        for (_, path) in files.into_iter().skip(self.inner.config.retained_files) {
            if path != active_path {
                fs::remove_file(path).map_err(|_| LogError::new("bridge_log_retention_failed"))?;
            }
        }
        Ok(())
    }
}

pub struct ProcessRunMarker {
    path: PathBuf,
    armed: bool,
}

impl ProcessRunMarker {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn finish(mut self) -> Result<(), LogError> {
        self.remove()?;
        self.armed = false;
        Ok(())
    }

    fn remove(&self) -> Result<(), LogError> {
        if self.path.exists() {
            fs::remove_file(&self.path)
                .map_err(|_| LogError::new("bridge_run_marker_clear_failed"))?;
        }
        Ok(())
    }
}

impl Drop for ProcessRunMarker {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.remove();
        }
    }
}

pub fn redact(value: &str) -> String {
    let mut output = redact_bearer(value);
    for secret_name in SECRET_NAMES {
        output = redact_named_secret(&output, secret_name);
    }
    output
}

fn redact_bearer(value: &str) -> String {
    let mut output = value.to_owned();
    let mut search_start = 0;
    loop {
        let lowercase = output.to_ascii_lowercase();
        let Some(relative) = lowercase[search_start..].find("bearer") else {
            break;
        };
        let start = search_start + relative;
        let end_word = start + "bearer".len();
        if !is_word_boundary(lowercase.as_bytes(), start, end_word) {
            search_start = end_word;
            continue;
        }
        let bytes = output.as_bytes();
        let mut token_start = end_word;
        while token_start < bytes.len() && bytes[token_start].is_ascii_whitespace() {
            token_start += 1;
        }
        if token_start == end_word {
            search_start = end_word;
            continue;
        }
        let mut token_end = token_start;
        while token_end < bytes.len() && is_bearer_character(bytes[token_end]) {
            token_end += 1;
        }
        if token_end == token_start {
            search_start = token_start;
            continue;
        }
        output.replace_range(token_start..token_end, "[REDACTED]");
        search_start = token_start + "[REDACTED]".len();
    }
    output
}

fn redact_named_secret(value: &str, secret_name: &str) -> String {
    let mut output = value.to_owned();
    let mut search_start = 0;
    loop {
        let lowercase = output.to_ascii_lowercase();
        let Some(relative) = lowercase[search_start..].find(secret_name) else {
            break;
        };
        let start = search_start + relative;
        let end_word = start + secret_name.len();
        if !is_word_boundary(lowercase.as_bytes(), start, end_word) {
            search_start = end_word;
            continue;
        }
        let bytes = output.as_bytes();
        let mut cursor = end_word;
        if cursor < bytes.len() && matches!(bytes[cursor], b'\'' | b'"') {
            cursor += 1;
        }
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || !matches!(bytes[cursor], b':' | b'=') {
            search_start = end_word;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor < bytes.len() && matches!(bytes[cursor], b'\'' | b'"') {
            cursor += 1;
        }
        let value_start = cursor;
        while cursor < bytes.len() && !is_secret_delimiter(bytes[cursor]) {
            cursor += 1;
        }
        if cursor == value_start {
            search_start = end_word;
            continue;
        }
        output.replace_range(value_start..cursor, "[REDACTED]");
        search_start = value_start + "[REDACTED]".len();
    }
    output
}

fn is_word_boundary(bytes: &[u8], start: usize, end: usize) -> bool {
    let before = start.checked_sub(1).and_then(|index| bytes.get(index));
    let after = bytes.get(end);
    before.is_none_or(|byte| !is_word_character(*byte))
        && after.is_none_or(|byte| !is_word_character(*byte))
}

fn is_word_character(value: u8) -> bool {
    value.is_ascii_alphanumeric() || value == b'_'
}

fn is_bearer_character(value: u8) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'~' | b'+' | b'-' | b'/' | b'=')
}

fn is_secret_delimiter(value: u8) -> bool {
    value.is_ascii_whitespace() || matches!(value, b'"' | b'\'' | b'&' | b',' | b'}')
}

fn validate_identifier(value: &str, error_code: &'static str) -> Result<(), LogError> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(LogError::new(error_code));
    }
    Ok(())
}

fn validate_source_label(value: &str) -> Result<(), LogError> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(LogError::new("bridge_log_source_label_invalid"));
    }
    Ok(())
}

fn append_sync(path: &Path, payload: &[u8]) -> Result<(), LogError> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| LogError::new("bridge_log_write_failed"))?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| LogError::new("bridge_log_write_failed"))
}

fn write_new_sync(path: &Path, payload: &[u8]) -> Result<(), LogError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| LogError::new("bridge_crash_log_write_failed"))?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| LogError::new("bridge_crash_log_write_failed"))
}

fn write_replace_sync(path: &Path, payload: &[u8]) -> Result<(), LogError> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| LogError::new("bridge_run_marker_write_failed"))?;
    file.write_all(payload)
        .and_then(|_| file.sync_all())
        .map_err(|_| LogError::new("bridge_run_marker_write_failed"))
}

fn absolute_path(path: &Path, error_code: &'static str) -> Result<PathBuf, LogError> {
    if path.as_os_str().is_empty() {
        return Err(LogError::new(error_code));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|_| LogError::new(error_code))
    }
}

fn log_file_kind(path: &Path) -> Option<LogFileKind> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    let file_name = path.file_name().and_then(OsStr::to_str)?;
    let lowercase_name = file_name.to_ascii_lowercase();
    if lowercase_name.starts_with("bridge-") && lowercase_name.ends_with(".log") {
        Some(LogFileKind::Bridge)
    } else if lowercase_name == MT5_DIAGNOSTIC_FILE_NAME {
        Some(LogFileKind::Mt5Diagnostic)
    } else {
        None
    }
}

/// Plans an equal tail-read budget for every discovered file.  The single-file cap protects a
/// small source set from oversized reads, while the aggregate cap protects the auto-refresh path
/// when many observer profiles are configured.  Integer division intentionally leaves any
/// remainder unused so the planned sum can never exceed MAX_LOG_REFRESH_BYTES.
fn per_file_tail_budget(discovered_file_count: usize) -> usize {
    if discovered_file_count == 0 {
        return 0;
    }
    (MAX_LOG_REFRESH_BYTES / discovered_file_count).min(MAX_LOG_TAIL_BYTES)
}

fn planned_tail_read_bytes(discovered_file_count: usize) -> usize {
    per_file_tail_budget(discovered_file_count).saturating_mul(discovered_file_count)
}

struct LogFileTail {
    bytes: Vec<u8>,
    starts_at_file_beginning: bool,
}

/// Reads only a bounded byte window ending at the current file end.  The caller must parse
/// complete lines from the returned window; a partial first line is intentionally discarded when
/// the window starts in the middle of a retained file.
fn read_log_file_tail(path: &Path, max_bytes: usize) -> Result<LogFileTail, ()> {
    let max_bytes = max_bytes.min(MAX_LOG_TAIL_BYTES);
    if max_bytes == 0 {
        return Ok(LogFileTail {
            bytes: Vec::new(),
            starts_at_file_beginning: true,
        });
    }
    let mut file = fs::File::open(path).map_err(|_| ())?;
    let file_length = file.seek(SeekFrom::End(0)).map_err(|_| ())?;
    let requested_bytes = usize::try_from(file_length)
        .unwrap_or(max_bytes)
        .min(max_bytes);
    let start_offset = file_length.saturating_sub(requested_bytes as u64);
    file.seek(SeekFrom::Start(start_offset)).map_err(|_| ())?;

    let mut bytes = Vec::with_capacity(requested_bytes);
    let mut remaining = requested_bytes;
    while remaining > 0 {
        let block_size = remaining.min(LOG_TAIL_READ_BLOCK_BYTES);
        let previous_length = bytes.len();
        bytes.resize(previous_length + block_size, 0);
        let read = file.read(&mut bytes[previous_length..]).map_err(|_| ())?;
        if read == 0 {
            // The file changed under us (for example, rotation/truncation).  Do not expose a
            // potentially mixed or incomplete snapshot to the viewer.
            return Err(());
        }
        bytes.truncate(previous_length + read);
        remaining -= read;
    }
    Ok(LogFileTail {
        bytes,
        starts_at_file_beginning: start_offset == 0,
    })
}

impl LogFileTail {
    fn for_each_line(&self, mut callback: impl FnMut(usize, &str)) {
        let mut line_start = if self.starts_at_file_beginning {
            0
        } else {
            match self.bytes.iter().position(|byte| *byte == b'\n') {
                Some(newline) => newline.saturating_add(1),
                None => return,
            }
        };
        let mut line_number = 0_usize;
        while line_start < self.bytes.len() {
            let Some(relative_end) = self.bytes[line_start..]
                .iter()
                .position(|byte| *byte == b'\n')
            else {
                break;
            };
            let line_end = line_start + relative_end;
            if let Ok(line) = std::str::from_utf8(&self.bytes[line_start..line_end]) {
                callback(line_number, line);
            }
            line_number = line_number.saturating_add(1);
            line_start = line_end.saturating_add(1);
        }
        // A final line ending at EOF is complete even when the logger has not flushed its final
        // newline yet.  It is still subject to MAX_LOG_LINE_BYTES and tail truncation above.
        if line_start < self.bytes.len()
            && (self.starts_at_file_beginning || line_number > 0)
            && let Ok(line) = std::str::from_utf8(&self.bytes[line_start..])
        {
            callback(line_number, line);
        }
    }
}

struct LogFileContext<'a> {
    kind: LogFileKind,
    label: Option<&'a str>,
    source_key: &'a str,
}

fn append_log_line_candidate(
    line: &str,
    context: &LogFileContext<'_>,
    line_number: usize,
    last_valid_timestamp: &mut Option<String>,
    file_lines: &mut VecDeque<LogLineCandidate>,
    max_lines: usize,
) {
    if line.len() > MAX_LOG_LINE_BYTES {
        return;
    }
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.trim().is_empty() {
        return;
    }
    let formatted = match context.kind {
        LogFileKind::Bridge => {
            let (rendered, timestamp_utc) = format_display_log_line(line);
            if timestamp_utc.is_some() {
                *last_valid_timestamp = timestamp_utc.clone();
            }
            Some((
                rendered,
                timestamp_utc.or_else(|| last_valid_timestamp.clone()),
            ))
        }
        // Diagnostic records are a separate, strictly allow-listed format.  Invalid or unknown
        // records are dropped rather than falling back to raw text, since the worker file may
        // contain future or accidentally sensitive fields.
        LogFileKind::Mt5Diagnostic => format_diagnostic_log_line(line),
    };
    let Some((rendered, timestamp_utc)) = formatted else {
        return;
    };
    let rendered = match context.label {
        Some(label) => format!("[{label}]  {rendered}"),
        None => rendered,
    };
    if file_lines.len() == max_lines {
        file_lines.pop_front();
    }
    file_lines.push_back(LogLineCandidate {
        timestamp_utc,
        source_key: context.source_key.to_owned(),
        line_number,
        rendered,
    });
}

fn format_display_log_line(line: &str) -> (String, Option<String>) {
    let Ok(record) = serde_json::from_str::<DisplayLogRecord>(line) else {
        return (line.to_owned(), None);
    };
    let timestamp_utc = canonical_timestamp(&record.timestamp_utc);
    let timestamp = format_local_log_timestamp(&record.timestamp_utc)
        .unwrap_or_else(|| record.timestamp_utc.trim().to_owned());
    let level = match record.level.as_str() {
        "warning" => "警告",
        "error" => "错误",
        _ => "信息",
    };
    let rendered = match record.message.as_deref().map(str::trim) {
        Some(message) if !message.is_empty() => {
            format!("{timestamp}  [{level}]  {}  {message}", record.event_name)
        }
        _ => format!("{timestamp}  [{level}]  {}", record.event_name),
    };
    (rendered, timestamp_utc)
}

fn format_diagnostic_log_line(line: &str) -> Option<(String, Option<String>)> {
    let record = serde_json::from_str::<DiagnosticLogRecord>(line).ok()?;
    let event = safe_diagnostic_value(record.event.as_deref())?;
    if !matches!(
        event.as_str(),
        "mt5_worker_terminal_session_restart" | "mt5_worker_unexpected_exception"
    ) {
        return None;
    }
    let timestamp_utc = record
        .observed_at_utc_msc
        .and_then(format_utc_timestamp_msc);
    let timestamp = timestamp_utc
        .as_deref()
        .and_then(format_local_log_timestamp)
        .unwrap_or_else(|| "时间未知".to_owned());
    let level = match event.as_str() {
        "mt5_worker_terminal_session_restart" | "mt5_worker_unexpected_exception" => "错误",
        _ => "信息",
    };
    let mut fields = Vec::new();
    if let Some(stage) = safe_diagnostic_value(record.stage.as_deref()) {
        fields.push(format!("阶段={stage}"));
    }
    if let Some(exception_type) = safe_diagnostic_value(record.exception_type.as_deref()) {
        fields.push(format!("异常类型={exception_type}"));
    }
    if let Some(error_code) = safe_diagnostic_value(record.error_code.as_deref()) {
        fields.push(format!("错误码={error_code}"));
    }
    if let Some(consecutive_failures) = record.consecutive_failures {
        fields.push(format!("连续失败={consecutive_failures}"));
    }
    let suffix = if fields.is_empty() {
        String::new()
    } else {
        format!("  {}", fields.join("  "))
    };
    Some((
        format!("{timestamp}  [{level}]  诊断事件={event}{suffix}"),
        timestamp_utc,
    ))
}

fn safe_diagnostic_value(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let value = value
        .chars()
        .take(96)
        .map(|character| {
            if character.is_control() {
                '?'
            } else {
                character
            }
        })
        .collect::<String>();
    Some(redact(&value))
}

fn compare_log_timestamps(left: &Option<String>, right: &Option<String>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        // A raw fallback after a valid record inherits that record's timestamp.  A raw line at
        // the beginning of a file remains oldest, so it cannot displace newer timestamped data
        // when the global line budget is applied.
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn canonical_timestamp(value: &str) -> Option<String> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
        || !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
        || !bytes[17..19].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let fraction = if bytes.get(19) == Some(&b'.') {
        if bytes.len() <= 21 || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit) {
            return None;
        }
        &value[20..value.len() - 1]
    } else if bytes.len() == 20 {
        ""
    } else {
        return None;
    };
    let mut normalized_fraction = fraction.chars().take(9).collect::<String>();
    while normalized_fraction.len() < 9 {
        normalized_fraction.push('0');
    }
    Some(format!(
        "{}-{}-{}T{}:{}:{}.{normalized_fraction}Z",
        &value[0..4],
        &value[5..7],
        &value[8..10],
        &value[11..13],
        &value[14..16],
        &value[17..19],
    ))
}

fn format_utc_timestamp_msc(value: i64) -> Option<String> {
    if value <= 0 {
        return None;
    }
    let seconds = value.div_euclid(1_000);
    let millis = value.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    if !(0..=9_999).contains(&year) {
        return None;
    }
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_seconds / 3_600,
        (day_seconds % 3_600) / 60,
        day_seconds % 60,
    ))
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_unix_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted / 146_097
    } else {
        (shifted - 146_096) / 146_097
    };
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn format_local_log_timestamp(value: &str) -> Option<String> {
    let bytes = value.trim().as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
    {
        return None;
    }
    let utc = SYSTEMTIME {
        wYear: parse_u16(&bytes[0..4])?,
        wMonth: parse_u16(&bytes[5..7])?,
        wDayOfWeek: 0,
        wDay: parse_u16(&bytes[8..10])?,
        wHour: parse_u16(&bytes[11..13])?,
        wMinute: parse_u16(&bytes[14..16])?,
        wSecond: parse_u16(&bytes[17..19])?,
        wMilliseconds: 0,
    };
    let mut local = SYSTEMTIME::default();
    let converted = unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) };
    if converted == 0 {
        return None;
    }
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        local.wYear, local.wMonth, local.wDay, local.wHour, local.wMinute, local.wSecond
    ))
}

fn parse_u16(bytes: &[u8]) -> Option<u16> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0_u16, |value, byte| {
        value
            .checked_mul(10)?
            .checked_add(u16::from(byte.saturating_sub(b'0')))
    })
}

struct UtcTimestamp {
    date: String,
    rfc3339: String,
    unix_millis: u128,
}

fn utc_timestamp() -> UtcTimestamp {
    let mut system_time = SYSTEMTIME::default();
    // SAFETY: system_time points to a valid writable SYSTEMTIME for the duration of the call.
    unsafe { GetSystemTime(&mut system_time) };
    let unix_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    UtcTimestamp {
        date: format!(
            "{:04}{:02}{:02}",
            system_time.wYear, system_time.wMonth, system_time.wDay
        ),
        rfc3339: format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            system_time.wYear,
            system_time.wMonth,
            system_time.wDay,
            system_time.wHour,
            system_time.wMinute,
            system_time.wSecond,
            system_time.wMilliseconds
        ),
        unix_millis,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;

    #[test]
    fn redacts_v3_secret_patterns_without_damaging_normal_text() {
        let input = "账户正常 access_token=token-secret Authorization: Bearer bearer.secret ticket='pair-secret' password: pwd";
        let output = redact(input);
        assert!(output.starts_with("账户正常"));
        for secret in ["token-secret", "bearer.secret", "pair-secret", "pwd"] {
            assert!(!output.contains(secret));
        }
        assert!(output.matches("[REDACTED]").count() >= 4);
    }

    #[test]
    fn writes_jsonl_that_the_existing_v3_log_reader_can_consume() {
        let root = unique_test_directory("jsonl");
        let logger = logger(&root, DEFAULT_MAX_FILE_BYTES, DEFAULT_RETAINED_FILES);
        logger.info("native_runtime_started", Some("profile=default"));

        let files = log_files(&root);
        assert_eq!(files.len(), 1);
        let text = fs::read_to_string(&files[0]).expect("read log");
        let payload: Value = serde_json::from_str(text.trim()).expect("parse jsonl");
        assert_eq!(payload["level"], "info");
        assert_eq!(payload["event_name"], "native_runtime_started");
        assert_eq!(payload["message"], "profile=default");
        assert!(
            payload["timestamp_utc"]
                .as_str()
                .is_some_and(|value| value.ends_with('Z'))
        );

        fs::remove_dir_all(root).expect("remove log fixture");
    }

    #[test]
    fn rotates_and_retains_a_bounded_number_of_log_files() {
        let root = unique_test_directory("rotation");
        let logger = logger(&root, 256, 3);
        for _ in 0..20 {
            logger.info("rotation_test", Some(&"x".repeat(100)));
            std::thread::sleep(Duration::from_millis(1));
        }
        let files = log_files(&root);
        assert!((2..=3).contains(&files.len()));
        fs::remove_dir_all(root).expect("remove rotation fixture");
    }

    #[test]
    fn an_oversized_first_record_is_written_before_future_rotation() {
        let root = unique_test_directory("oversized-first");
        let logger = logger(&root, 256, 3);
        logger.info("oversized_first", Some(&"x".repeat(400)));
        let files = log_files(&root);
        assert_eq!(files.len(), 1);
        assert!(
            fs::metadata(&files[0])
                .expect("oversized log metadata")
                .len()
                > 256,
            "a single record must not be discarded merely because it exceeds the rotation limit"
        );
        fs::remove_dir_all(root).expect("remove oversized log fixture");
    }

    #[test]
    fn crash_record_is_separate_redacted_and_durable() {
        let root = unique_test_directory("crash");
        let logger = logger(&root, DEFAULT_MAX_FILE_BYTES, DEFAULT_RETAINED_FILES);
        logger.write_crash_record(
            "bridge-core",
            "3.0.0-alpha.1",
            "main",
            "fixture.rs:1:1",
            "refresh_token=panic-secret",
        );
        let files = log_files(&root);
        assert_eq!(files.len(), 1);
        let text = fs::read_to_string(&files[0]).expect("read crash log");
        assert!(text.contains("native_process_panic"));
        assert!(!text.contains("panic-secret"));
        fs::remove_dir_all(root).expect("remove crash fixture");
    }

    #[test]
    fn panic_hook_records_a_real_child_process_panic() {
        let root = unique_test_directory("panic-child");
        fs::create_dir_all(&root).expect("panic fixture directory");
        let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", "tests::panic_hook_child_entry", "--nocapture"])
            .env("AURUM_NATIVE_PANIC_FIXTURE_DIR", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("run panic child");
        assert!(!status.success());
        let text = log_files(&root)
            .into_iter()
            .map(|path| fs::read_to_string(path).expect("read panic child log"))
            .collect::<String>();
        assert!(text.contains("native_process_panic"));
        assert!(!text.contains("child-secret"));
        fs::remove_dir_all(root).expect("remove panic fixture");
    }

    #[test]
    fn panic_hook_child_entry() {
        let Some(root) = std::env::var_os("AURUM_NATIVE_PANIC_FIXTURE_DIR") else {
            return;
        };
        let logger = logger(
            PathBuf::from(root),
            DEFAULT_MAX_FILE_BYTES,
            DEFAULT_RETAINED_FILES,
        );
        logger.install_panic_hook("bridge-core", "3.0.0-alpha.1");
        panic!("refresh_token=child-secret");
    }

    #[test]
    fn stale_run_marker_becomes_an_unclean_shutdown_log() {
        let root = unique_test_directory("marker");
        let data = root.join("data");
        let logger = logger(
            root.join("logs"),
            DEFAULT_MAX_FILE_BYTES,
            DEFAULT_RETAINED_FILES,
        );
        let marker = logger
            .begin_run_marker(&data, "bridge-core", "3.0.0-alpha.1")
            .expect("first marker");
        let marker_path = marker.path().to_path_buf();
        std::mem::forget(marker);

        let replacement = logger
            .begin_run_marker(&data, "bridge-core", "3.0.0-alpha.1")
            .expect("replacement marker");
        replacement.finish().expect("finish marker");
        assert!(!marker_path.exists());
        let text = log_files(&root.join("logs"))
            .into_iter()
            .map(|path| fs::read_to_string(path).expect("read marker log"))
            .collect::<String>();
        assert!(text.contains("native_previous_unclean_shutdown"));
        fs::remove_dir_all(root).expect("remove marker fixture");
    }

    #[test]
    fn recent_log_reader_matches_the_dotnet_display_contract_and_line_budget() {
        let root = unique_test_directory("reader");
        fs::create_dir_all(&root).expect("reader directory");
        fs::write(
            root.join("bridge-20260729.log"),
            concat!(
                "{\"timestamp_utc\":\"2026-07-29T12:34:56.789Z\",\"level\":\"info\",\"event_name\":\"first\",\"message\":null}\n",
                "\n",
                "{\"timestamp_utc\":\"2026-07-29T12:35:56.789Z\",\"level\":\"warning\",\"event_name\":\"second\",\"message\":\"detail\"}\n",
                "raw fallback line\n",
            ),
        )
        .expect("reader fixture");
        fs::write(root.join("ignored.txt"), "must not be visible").expect("ignored fixture");
        let reader = BridgeLogReader::new(&root).expect("reader");
        let text = reader.read_recent_text(Some(2)).expect("recent text");
        assert!(!text.contains("first"));
        assert!(text.contains("[警告]  second  detail"));
        assert!(text.ends_with("raw fallback line"));
        assert!(!text.contains("must not be visible"));
        fs::remove_dir_all(root).expect("remove reader fixture");
    }

    #[test]
    fn recent_log_reader_does_not_let_an_old_raw_line_displace_new_timestamped_data() {
        let root = unique_test_directory("reader-raw-order");
        fs::create_dir_all(&root).expect("reader raw order directory");
        fs::write(root.join("bridge-old.log"), "old raw fallback\n").expect("old raw log");
        fs::write(
            root.join("bridge-new.log"),
            "{\"timestamp_utc\":\"2026-07-29T12:35:56.789Z\",\"level\":\"info\",\"event_name\":\"new-event\",\"message\":null}\n",
        )
        .expect("new timestamped log");
        let reader = BridgeLogReader::new(&root).expect("raw order reader");
        let text = reader.read_recent_text(Some(1)).expect("raw order text");
        assert!(text.contains("new-event"));
        assert!(!text.contains("old raw fallback"));
        fs::remove_dir_all(root).expect("remove raw order fixture");
    }

    #[test]
    fn recent_log_reader_uses_the_same_empty_state_as_dotnet() {
        let root = unique_test_directory("reader-empty");
        let reader = BridgeLogReader::new(&root).expect("reader");
        assert_eq!(
            reader.read_recent_text(None).expect("empty state"),
            "暂无日志。"
        );
    }

    #[test]
    fn recent_log_reader_aggregates_explicit_profile_directories_with_one_line_budget() {
        let root = unique_test_directory("reader-profiles");
        let default_logs = root.join("logs");
        let observer_logs = root.join("profiles").join("source-a").join("logs");
        fs::create_dir_all(&default_logs).expect("default log directory");
        fs::create_dir_all(&observer_logs).expect("observer log directory");
        fs::write(
            default_logs.join("bridge-default.log"),
            "{\"timestamp_utc\":\"2026-07-29T12:34:56.789Z\",\"level\":\"info\",\"event_name\":\"default_event\",\"message\":null}\n",
        )
        .expect("default log");
        fs::write(
            observer_logs.join("bridge-observer.log"),
            "{\"timestamp_utc\":\"2026-07-29T12:35:56.789Z\",\"level\":\"error\",\"event_name\":\"observer_event\",\"message\":null}\n",
        )
        .expect("observer log");

        let reader = BridgeLogReader::from_directories([&default_logs, &observer_logs])
            .expect("profile log reader");
        let text = reader
            .read_recent_text(Some(2))
            .expect("profile recent text");
        assert!(text.contains("default_event"));
        assert!(text.contains("observer_event"));
        assert!(!text.contains("[default]"));
        assert!(!text.contains("[source-a]"));
        assert_eq!(text.lines().count(), 2);

        fs::remove_dir_all(root).expect("remove profile log fixture");
    }

    #[test]
    fn named_log_sources_render_stable_labels_for_each_profile() {
        let root = unique_test_directory("reader-named-sources");
        let default_logs = root.join("default-logs");
        let observer_logs = root.join("observer-logs");
        fs::create_dir_all(&default_logs).expect("default log directory");
        fs::create_dir_all(&observer_logs).expect("observer log directory");
        fs::write(
            default_logs.join("bridge-default.log"),
            "{\"timestamp_utc\":\"2026-07-29T12:34:56.789Z\",\"level\":\"info\",\"event_name\":\"default_event\",\"message\":null}\n",
        )
        .expect("default log");
        fs::write(
            observer_logs.join(MT5_DIAGNOSTIC_FILE_NAME),
            "{\"observed_at_utc_msc\":1785326400000,\"event\":\"mt5_worker_terminal_session_restart\",\"stage\":\"worker_request\",\"error_code\":\"mt5_account_unavailable\",\"consecutive_failures\":3}\n",
        )
        .expect("observer diagnostic log");

        let reader = BridgeLogReader::from_named_directories(vec![
            ("default".to_owned(), default_logs.clone()),
            ("source-1".to_owned(), observer_logs.clone()),
        ])
        .expect("named profile log reader");
        let text = reader
            .read_recent_text(Some(2))
            .expect("named profile text");
        assert!(text.contains("[default]  "));
        assert!(text.contains("[source-1]  "));
        assert!(text.contains("[source-1]  2026-"));
        assert_eq!(text.lines().count(), 2);

        fs::remove_dir_all(root).expect("remove named profile fixture");
    }

    #[test]
    fn named_log_source_labels_are_strictly_validated() {
        let root = unique_test_directory("reader-invalid-label");
        let invalid =
            BridgeLogReader::from_named_directories(vec![("source.bad".to_owned(), root.clone())])
                .expect_err("invalid source label must fail closed");
        assert_eq!(invalid.code(), "bridge_log_source_label_invalid");

        let too_long = "x".repeat(41);
        let invalid = BridgeLogReader::from_named_directories(vec![(too_long, root.clone())])
            .expect_err("overlong source label must fail closed");
        assert_eq!(invalid.code(), "bridge_log_source_label_invalid");
    }

    #[test]
    fn recent_log_reader_merges_interleaved_profiles_after_each_file_tail_budget() {
        let root = unique_test_directory("reader-interleaved");
        let default_logs = root.join("logs");
        let observer_logs = root.join("profiles").join("source-a").join("logs");
        fs::create_dir_all(&default_logs).expect("default log directory");
        fs::create_dir_all(&observer_logs).expect("observer log directory");
        let default_lines = (0..8)
            .map(|index| {
                format!(
                    "{{\"timestamp_utc\":\"2026-07-29T12:{:02}:00.000Z\",\"level\":\"info\",\"event_name\":\"default-{index}\",\"message\":null}}",
                    index * 2
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let observer_lines = (0..3)
            .map(|index| {
                format!(
                    "{{\"timestamp_utc\":\"2026-07-29T12:{:02}:00.000Z\",\"level\":\"info\",\"event_name\":\"observer-{index}\",\"message\":null}}",
                    index * 2 + 11
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(default_logs.join("bridge-default.log"), default_lines).expect("default log");
        fs::write(observer_logs.join("bridge-observer.log"), observer_lines).expect("observer log");

        let reader = BridgeLogReader::from_directories([&default_logs, &observer_logs])
            .expect("profile log reader");
        let text = reader
            .read_recent_text(Some(4))
            .expect("profile recent text");
        assert_eq!(text.lines().count(), 4);
        assert!(text.contains("default-6"));
        assert!(text.contains("default-7"));
        assert!(text.contains("observer-1"));
        assert!(text.contains("observer-2"));
        assert!(!text.contains("default-0"));

        fs::remove_dir_all(root).expect("remove interleaved profile fixture");
    }

    #[test]
    fn recent_log_reader_reads_a_bounded_tail_and_keeps_recent_complete_lines() {
        let root = unique_test_directory("reader-bounded-tail");
        fs::create_dir_all(&root).expect("bounded tail directory");
        let path = root.join("bridge-history.log");
        let mut payload = vec![b'x'; MAX_LOG_TAIL_BYTES + 32 * 1024];
        payload.extend_from_slice(b"\n");
        payload.extend_from_slice(
            b"{\"timestamp_utc\":\"2026-07-29T12:35:56.789Z\",\"level\":\"info\",\"event_name\":\"recent-tail-event\",\"message\":null}\n",
        );
        fs::write(&path, payload).expect("bounded tail log");

        let tail = read_log_file_tail(&path, MAX_LOG_TAIL_BYTES).expect("tail read");
        assert_eq!(tail.bytes.len(), MAX_LOG_TAIL_BYTES);
        assert!(!tail.starts_at_file_beginning);

        let reader = BridgeLogReader::new(&root).expect("bounded tail reader");
        let text = reader.read_recent_text(Some(1)).expect("bounded tail text");
        assert!(text.contains("recent-tail-event"));
        assert!(!text.contains("xxxxxxxx"));
        fs::remove_dir_all(root).expect("remove bounded tail fixture");
    }

    #[test]
    fn recent_log_reader_tail_budget_is_bounded_for_small_and_large_source_sets() {
        for file_count in [1, 10, 187] {
            let per_file = per_file_tail_budget(file_count);
            let planned = planned_tail_read_bytes(file_count);
            assert!(per_file <= MAX_LOG_TAIL_BYTES);
            assert!(planned <= MAX_LOG_REFRESH_BYTES);
            assert_eq!(planned, per_file.saturating_mul(file_count));
        }
        assert_eq!(per_file_tail_budget(0), 0);
        assert_eq!(planned_tail_read_bytes(1), MAX_LOG_TAIL_BYTES);
        assert_eq!(per_file_tail_budget(10), MAX_LOG_TAIL_BYTES);
        assert_eq!(per_file_tail_budget(187), MAX_LOG_REFRESH_BYTES / 187);
    }

    #[test]
    fn recent_log_reader_skips_invalid_utf8_file_lines_but_keeps_other_sources() {
        let root = unique_test_directory("reader-invalid-utf8");
        fs::create_dir_all(&root).expect("invalid utf8 directory");
        fs::write(root.join("bridge-invalid.log"), [0xff, 0xfe, b'\n']).expect("invalid utf8 log");
        fs::write(
            root.join("bridge-valid.log"),
            b"{\"timestamp_utc\":\"2026-07-29T12:35:56.789Z\",\"level\":\"info\",\"event_name\":\"valid-after-invalid\",\"message\":null}\n",
        )
        .expect("valid log");

        let reader = BridgeLogReader::new(&root).expect("invalid utf8 reader");
        let text = reader.read_recent_text(Some(2)).expect("invalid utf8 text");
        assert!(text.contains("valid-after-invalid"));
        assert!(!text.contains("bridge-invalid"));
        fs::remove_dir_all(root).expect("remove invalid utf8 fixture");
    }

    #[test]
    fn recent_log_reader_returns_safe_empty_state_when_all_records_decode_invalid() {
        let root = unique_test_directory("reader-all-invalid");
        fs::create_dir_all(&root).expect("all invalid directory");
        fs::write(root.join("bridge-invalid.log"), [0xff, 0xfe, b'\n']).expect("all invalid log");
        // A file with an invalid UTF-8 record is still a readable file at the byte level, so the
        // reader safely reports the same empty state used for an allow-listed file with no valid
        // records rather than surfacing decoder details.
        let reader = BridgeLogReader::new(&root).expect("all invalid reader");
        assert_eq!(
            reader.read_recent_text(Some(2)).expect("safe empty state"),
            "暂无日志。"
        );
        fs::remove_dir_all(root).expect("remove all unreadable fixture");
    }

    #[test]
    fn recent_log_reader_skips_overlong_lines_without_scanning_unbounded_input() {
        let root = unique_test_directory("reader-overlong-line");
        fs::create_dir_all(&root).expect("overlong directory");
        let mut payload = vec![b'X'; MAX_LOG_LINE_BYTES + 1];
        payload.extend_from_slice(b"\n");
        payload.extend_from_slice(
            b"{\"timestamp_utc\":\"2026-07-29T12:35:56.789Z\",\"level\":\"info\",\"event_name\":\"after-overlong\",\"message\":null}\n",
        );
        fs::write(root.join("bridge-overlong.log"), payload).expect("overlong log");
        let reader = BridgeLogReader::new(&root).expect("overlong reader");
        let text = reader.read_recent_text(Some(2)).expect("overlong text");
        assert!(text.contains("after-overlong"));
        assert!(!text.contains('X'));
        fs::remove_dir_all(root).expect("remove overlong fixture");
    }

    #[test]
    fn recent_log_reader_formats_only_allow_listed_mt5_diagnostics() {
        let root = unique_test_directory("reader-diagnostics");
        fs::create_dir_all(&root).expect("diagnostic directory");
        fs::write(
            root.join(MT5_DIAGNOSTIC_FILE_NAME),
            concat!(
                "{\"observed_at_utc_msc\":1785326400000,\"event\":\"mt5_worker_terminal_session_restart\",\"stage\":\"worker_request\",\"error_code\":\"mt5_account_unavailable\",\"consecutive_failures\":3,\"password\":\"diagnostic-secret\"}\n",
                "not-json diagnostic-secret\n",
                "{\"unknown\":\"diagnostic-secret\",\"password\":\"diagnostic-secret\"}\n",
                "{\"observed_at_utc_msc\":1785326400001,\"event\":\"diagnostic-secret-event\",\"password\":\"diagnostic-secret\"}\n",
            ),
        )
        .expect("diagnostic log");
        fs::write(
            root.join("other.jsonl"),
            "{\"event\":\"mt5_worker_unexpected_exception\",\"password\":\"diagnostic-secret\"}\n",
        )
        .expect("ordinary jsonl");

        let reader = BridgeLogReader::new(&root).expect("diagnostic reader");
        let text = reader.read_recent_text(Some(10)).expect("diagnostic text");
        assert!(text.contains("诊断事件=mt5_worker_terminal_session_restart"));
        assert!(text.contains("阶段=worker_request"));
        assert!(text.contains("错误码=mt5_account_unavailable"));
        assert!(text.contains("连续失败=3"));
        assert!(!text.contains("diagnostic-secret"));
        assert!(!text.contains("not-json"));
        assert!(!text.contains("password"));
        assert!(!text.contains("other.jsonl"));

        fs::remove_dir_all(root).expect("remove diagnostic fixture");
    }

    #[test]
    fn diagnostic_epoch_timestamp_is_normalized_for_global_ordering() {
        assert_eq!(
            format_utc_timestamp_msc(1_700_000_000_123),
            Some("2023-11-14T22:13:20.123Z".to_owned())
        );
        assert_eq!(format_utc_timestamp_msc(0), None);
    }

    fn logger(root: impl AsRef<Path>, max_file_bytes: u64, retained_files: usize) -> BridgeLogger {
        BridgeLogger::new(
            LoggerConfig::new(root)
                .expect("logger config")
                .with_limits(max_file_bytes, retained_files)
                .expect("logger limits"),
        )
    }

    fn log_files(root: &Path) -> Vec<PathBuf> {
        let mut files = fs::read_dir(root)
            .expect("log directory")
            .map(|entry| entry.expect("log entry").path())
            .filter(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with("bridge-") && name.ends_with(".log"))
            })
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-observability-{}-{stamp}-{suffix}",
            std::process::id()
        ))
    }
}
