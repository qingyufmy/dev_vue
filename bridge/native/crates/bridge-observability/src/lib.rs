use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::error::Error;
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
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
    log_directory: PathBuf,
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

impl BridgeLogReader {
    pub fn new(log_directory: impl AsRef<Path>) -> Result<Self, LogError> {
        Ok(Self {
            log_directory: absolute_path(log_directory.as_ref(), "bridge_log_reader_path_invalid")?,
        })
    }

    pub fn read_recent_text(&self, max_lines: Option<usize>) -> Result<String, LogError> {
        let max_lines = max_lines
            .unwrap_or(DEFAULT_RECENT_LOG_LINES)
            .clamp(1, MAX_RECENT_LOG_LINES);
        if !self.log_directory.is_dir() {
            return Ok("暂无日志。".to_owned());
        }
        let mut files = fs::read_dir(&self.log_directory)
            .map_err(|_| LogError::new("bridge_log_read_failed"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| is_bridge_log_path(path))
            .collect::<Vec<_>>();
        files.sort_by(|left, right| {
            let left_modified = fs::metadata(left)
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            let right_modified = fs::metadata(right)
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            right_modified.cmp(&left_modified).then_with(|| {
                right
                    .file_name()
                    .map(|value| value.to_string_lossy().to_ascii_lowercase())
                    .cmp(
                        &left
                            .file_name()
                            .map(|value| value.to_string_lossy().to_ascii_lowercase()),
                    )
            })
        });
        let mut blocks = Vec::new();
        let mut collected_lines = 0_usize;
        for path in files {
            let remaining = max_lines.saturating_sub(collected_lines);
            if remaining == 0 {
                break;
            }
            let file = fs::File::open(path).map_err(|_| LogError::new("bridge_log_read_failed"))?;
            let mut reader = BufReader::with_capacity(16 * 1024, file);
            let mut line = String::new();
            let mut file_lines = VecDeque::with_capacity(remaining);
            loop {
                line.clear();
                let read = reader
                    .read_line(&mut line)
                    .map_err(|_| LogError::new("bridge_log_read_failed"))?;
                if read == 0 {
                    break;
                }
                let line = line.trim_end_matches(['\r', '\n']);
                if line.trim().is_empty() {
                    continue;
                }
                if file_lines.len() == remaining {
                    file_lines.pop_front();
                }
                file_lines.push_back(format_display_log_line(line));
            }
            if !file_lines.is_empty() {
                collected_lines += file_lines.len();
                blocks.push(file_lines.into_iter().collect::<Vec<_>>());
            }
        }
        if collected_lines == 0 {
            return Ok("暂无日志。".to_owned());
        }
        Ok(blocks
            .into_iter()
            .rev()
            .flatten()
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

fn is_bridge_log_path(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let Some(file_name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    let file_name = file_name.to_ascii_lowercase();
    file_name.starts_with("bridge-") && file_name.ends_with(".log")
}

fn format_display_log_line(line: &str) -> String {
    let Ok(record) = serde_json::from_str::<DisplayLogRecord>(line) else {
        return line.to_owned();
    };
    let timestamp = format_local_log_timestamp(&record.timestamp_utc)
        .unwrap_or_else(|| record.timestamp_utc.trim().to_owned());
    let level = match record.level.as_str() {
        "warning" => "警告",
        "error" => "错误",
        _ => "信息",
    };
    match record.message.as_deref().map(str::trim) {
        Some(message) if !message.is_empty() => {
            format!("{timestamp}  [{level}]  {}  {message}", record.event_name)
        }
        _ => format!("{timestamp}  [{level}]  {}", record.event_name),
    }
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
    fn recent_log_reader_uses_the_same_empty_state_as_dotnet() {
        let root = unique_test_directory("reader-empty");
        let reader = BridgeLogReader::new(&root).expect("reader");
        assert_eq!(
            reader.read_recent_text(None).expect("empty state"),
            "暂无日志。"
        );
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
