use serde::{Deserialize, Serialize};
use std::error::Error;
use std::ffi::OsStr;
use std::fmt::{Debug, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

pub const DPAPI_ENTROPY: &[u8] = b"AURUM Bridge v3 refresh credential";
const MINIMUM_REFRESH_TOKEN_LENGTH: usize = 40;
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(25);
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct BridgeCredential {
    #[serde(rename = "RefreshToken")]
    pub refresh_token: String,
    #[serde(rename = "ExpiresAtUtcMsc")]
    pub expires_at_utc_msc: i64,
}

impl Debug for BridgeCredential {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BridgeCredential")
            .field("refresh_token", &"[REDACTED]")
            .field("expires_at_utc_msc", &self.expires_at_utc_msc)
            .finish()
    }
}

impl BridgeCredential {
    pub fn validate(&self) -> Result<(), SecurityError> {
        if self.refresh_token.len() < MINIMUM_REFRESH_TOKEN_LENGTH {
            return Err(SecurityError::new("bridge_credential_payload_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SecurityError {
    code: &'static str,
    windows_error: Option<u32>,
}

impl SecurityError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(code: &'static str) -> Self {
        Self {
            code,
            windows_error: None,
        }
    }

    fn windows(code: &'static str) -> Self {
        Self {
            code,
            // SAFETY: GetLastError has no preconditions and is read immediately after failure.
            windows_error: Some(unsafe { GetLastError() }),
        }
    }
}

impl Display for SecurityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self.windows_error {
            Some(value) => write!(formatter, "{} (win32={value})", self.code),
            None => formatter.write_str(self.code),
        }
    }
}

impl Error for SecurityError {}

pub fn protect_current_user(plaintext: &[u8]) -> Result<Vec<u8>, SecurityError> {
    crypt_data(plaintext, true)
}

pub fn unprotect_current_user(ciphertext: &[u8]) -> Result<Vec<u8>, SecurityError> {
    crypt_data(ciphertext, false)
}

fn crypt_data(input: &[u8], protect: bool) -> Result<Vec<u8>, SecurityError> {
    let input_length = u32::try_from(input.len())
        .map_err(|_| SecurityError::new("bridge_credential_payload_too_large"))?;
    let entropy_length = u32::try_from(DPAPI_ENTROPY.len())
        .map_err(|_| SecurityError::new("bridge_credential_entropy_invalid"))?;
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: input.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy_length,
        pbData: DPAPI_ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = LocalBlob::default();
    // SAFETY: all blob pointers remain valid for the duration of the call. Optional pointers are
    // null, UI is disabled, and the returned LocalAlloc buffer is owned by LocalBlob.
    let succeeded = unsafe {
        if protect {
            CryptProtectData(
                &input_blob,
                null(),
                &entropy_blob,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.blob,
            )
        } else {
            CryptUnprotectData(
                &input_blob,
                null_mut(),
                &entropy_blob,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.blob,
            )
        }
    };
    if succeeded == 0 {
        return Err(SecurityError::windows(if protect {
            "bridge_credential_protection_failed"
        } else {
            "bridge_credential_decryption_failed"
        }));
    }
    output.to_vec(if protect {
        "bridge_credential_protection_failed"
    } else {
        "bridge_credential_decryption_failed"
    })
}

#[derive(Default)]
struct LocalBlob {
    blob: CRYPT_INTEGER_BLOB,
}

impl LocalBlob {
    fn to_vec(&self, error_code: &'static str) -> Result<Vec<u8>, SecurityError> {
        if self.blob.cbData == 0 {
            return Ok(Vec::new());
        }
        if self.blob.pbData.is_null() {
            return Err(SecurityError::new(error_code));
        }
        // SAFETY: CryptProtectData/CryptUnprotectData returned a buffer of cbData bytes and the
        // LocalBlob guard keeps that allocation alive until after this copy.
        Ok(unsafe {
            std::slice::from_raw_parts(self.blob.pbData, self.blob.cbData as usize).to_vec()
        })
    }
}

impl Drop for LocalBlob {
    fn drop(&mut self) {
        if !self.blob.pbData.is_null() {
            // SAFETY: DPAPI allocates this pointer with LocalAlloc and ownership is held here.
            unsafe {
                std::ptr::write_bytes(self.blob.pbData, 0, self.blob.cbData as usize);
                LocalFree(self.blob.pbData.cast());
            }
            self.blob.pbData = null_mut();
            self.blob.cbData = 0;
        }
    }
}

#[derive(Clone, Debug)]
pub struct CredentialStore {
    credential_path: PathBuf,
    lock_path: PathBuf,
}

impl CredentialStore {
    pub fn new(credential_path: impl AsRef<Path>) -> Result<Self, SecurityError> {
        let credential_path = absolute_path(credential_path.as_ref())?;
        let file_name = credential_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| SecurityError::new("bridge_credential_path_invalid"))?;
        let lock_path = credential_path.with_file_name(format!("{file_name}.lock"));
        Ok(Self {
            credential_path,
            lock_path,
        })
    }

    pub fn credential_path(&self) -> &Path {
        &self.credential_path
    }

    pub fn load(&self) -> Result<Option<BridgeCredential>, SecurityError> {
        let _lock = self.acquire_process_lock()?;
        self.load_core()
    }

    pub fn save(&self, credential: &BridgeCredential) -> Result<(), SecurityError> {
        credential.validate()?;
        let _lock = self.acquire_process_lock()?;
        self.save_core(credential)
    }

    pub fn save_if_current(
        &self,
        expected: &BridgeCredential,
        replacement: &BridgeCredential,
    ) -> Result<bool, SecurityError> {
        expected.validate()?;
        replacement.validate()?;
        let _lock = self.acquire_process_lock()?;
        let Some(current) = self.load_core()? else {
            return Ok(false);
        };
        if !fixed_time_equals(
            current.refresh_token.as_bytes(),
            expected.refresh_token.as_bytes(),
        ) {
            return Ok(false);
        }
        self.save_core(replacement)?;
        Ok(true)
    }

    pub fn clear(&self) -> Result<(), SecurityError> {
        let _lock = self.acquire_process_lock()?;
        if self.credential_path.exists() {
            fs::remove_file(&self.credential_path)
                .map_err(|_| SecurityError::new("bridge_credential_clear_failed"))?;
        }
        Ok(())
    }

    /// Remove the credential only when the on-disk refresh token still matches
    /// the token that the caller observed.  The comparison and delete happen
    /// while holding the same process lock used by `save`, so a newly paired
    /// credential can never be deleted by a stale connection failure.
    pub fn clear_if_matches(&self, expected_refresh_token: &str) -> Result<bool, SecurityError> {
        let _lock = self.acquire_process_lock()?;
        let Some(current) = self.load_core()? else {
            return Ok(false);
        };
        if !fixed_time_equals(
            current.refresh_token.as_bytes(),
            expected_refresh_token.as_bytes(),
        ) {
            return Ok(false);
        }
        fs::remove_file(&self.credential_path)
            .map_err(|_| SecurityError::new("bridge_credential_clear_failed"))?;
        Ok(true)
    }

    fn load_core(&self) -> Result<Option<BridgeCredential>, SecurityError> {
        if !self.credential_path.exists() {
            return Ok(None);
        }
        let ciphertext = fs::read(&self.credential_path)
            .map_err(|_| SecurityError::new("bridge_credential_read_failed"))?;
        let mut plaintext = unprotect_current_user(&ciphertext)?;
        let parsed = serde_json::from_slice::<BridgeCredential>(&plaintext)
            .map_err(|_| SecurityError::new("bridge_credential_decryption_failed"));
        plaintext.fill(0);
        let credential = parsed?;
        credential.validate()?;
        Ok(Some(credential))
    }

    fn save_core(&self, credential: &BridgeCredential) -> Result<(), SecurityError> {
        let parent = self
            .credential_path
            .parent()
            .ok_or_else(|| SecurityError::new("bridge_credential_path_invalid"))?;
        fs::create_dir_all(parent)
            .map_err(|_| SecurityError::new("bridge_credential_directory_failed"))?;
        let mut plaintext = serde_json::to_vec(credential)
            .map_err(|_| SecurityError::new("bridge_credential_payload_invalid"))?;
        let encrypted = protect_current_user(&plaintext);
        plaintext.fill(0);
        let encrypted = encrypted?;
        let temporary = temporary_path(&self.credential_path)?;
        let result = (|| -> Result<(), SecurityError> {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|_| SecurityError::new("bridge_credential_write_failed"))?;
            file.write_all(&encrypted)
                .map_err(|_| SecurityError::new("bridge_credential_write_failed"))?;
            file.sync_all()
                .map_err(|_| SecurityError::new("bridge_credential_write_failed"))?;
            drop(file);
            move_replace_write_through(&temporary, &self.credential_path)
        })();
        if temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn acquire_process_lock(&self) -> Result<File, SecurityError> {
        let parent = self
            .lock_path
            .parent()
            .ok_or_else(|| SecurityError::new("bridge_credential_path_invalid"))?;
        fs::create_dir_all(parent)
            .map_err(|_| SecurityError::new("bridge_credential_directory_failed"))?;
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            match OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&self.lock_path)
            {
                Ok(file) => return Ok(file),
                Err(error) if is_lock_contention(&error) && Instant::now() < deadline => {
                    thread::sleep(LOCK_RETRY_INTERVAL);
                }
                Err(_) => return Err(SecurityError::new("bridge_credential_lock_failed")),
            }
        }
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf, SecurityError> {
    if path.as_os_str().is_empty() {
        return Err(SecurityError::new("bridge_credential_path_invalid"));
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|_| SecurityError::new("bridge_credential_path_invalid"))
    }
}

fn is_lock_contention(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32 | 33))
}

fn temporary_path(path: &Path) -> Result<PathBuf, SecurityError> {
    let parent = path
        .parent()
        .ok_or_else(|| SecurityError::new("bridge_credential_path_invalid"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| SecurityError::new("bridge_credential_path_invalid"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SecurityError::new("bridge_system_clock_invalid"))?
        .as_nanos();
    Ok(parent.join(format!(".{file_name}.{}.{stamp}.tmp", std::process::id())))
}

fn move_replace_write_through(source: &Path, destination: &Path) -> Result<(), SecurityError> {
    let source = wide_null(source.as_os_str());
    let destination = wide_null(destination.as_os_str());
    // SAFETY: both UTF-16 strings are null-terminated and remain alive for the call.
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        return Err(SecurityError::windows("bridge_credential_replace_failed"));
    }
    Ok(())
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn fixed_time_equals(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(left.get(index).copied().unwrap_or(0))
            ^ usize::from(right.get(index).copied().unwrap_or(0));
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trip_uses_current_user_and_v3_entropy() {
        let plaintext = b"native-3.0.0-dpapi-fixture";
        let encrypted = protect_current_user(plaintext).expect("protect fixture");
        assert_ne!(encrypted, plaintext);
        assert_eq!(
            unprotect_current_user(&encrypted).expect("unprotect fixture"),
            plaintext
        );
    }

    #[test]
    fn credential_store_round_trips_and_rotates_atomically() {
        let root = unique_test_directory("credential-store");
        let path = root.join("credential.dat");
        let store = CredentialStore::new(&path).expect("credential store");
        let original = credential('a', 1785268800000);
        let replacement = credential('b', 1785355200000);
        fs::create_dir_all(&root).expect("credential directory");

        assert_eq!(store.load().expect("empty credential"), None);
        store.save(&original).expect("save credential");
        assert_eq!(
            store.load().expect("load credential"),
            Some(original.clone())
        );
        assert!(
            store
                .save_if_current(&original, &replacement)
                .expect("rotate credential")
        );
        assert_eq!(
            store.load().expect("load replacement"),
            Some(replacement.clone())
        );
        assert!(
            !store
                .save_if_current(&original, &original)
                .expect("reject stale credential")
        );
        store.clear().expect("clear credential");
        assert_eq!(store.load().expect("cleared credential"), None);

        drop(store);
        fs::remove_dir_all(root).expect("remove credential fixture");
    }

    #[test]
    fn stale_clear_does_not_remove_a_replaced_credential() {
        let root = unique_test_directory("credential-store-stale-clear");
        let path = root.join("credential.dat");
        let store = CredentialStore::new(&path).expect("credential store");
        let original = credential('a', 1785268800000);
        let replacement = credential('b', 1785355200000);

        store.save(&original).expect("save original");
        assert!(
            store
                .save_if_current(&original, &replacement)
                .expect("replace credential")
        );
        assert!(
            !store
                .clear_if_matches(&original.refresh_token)
                .expect("stale clear")
        );
        assert_eq!(store.load().expect("load replacement"), Some(replacement));
        assert!(
            store
                .clear_if_matches(&credential('b', 0).refresh_token)
                .expect("matching clear")
        );
        assert_eq!(store.load().expect("cleared credential"), None);

        drop(store);
        fs::remove_dir_all(root).expect("remove credential fixture");
    }

    #[test]
    fn concurrent_replace_and_stale_clear_cannot_delete_the_replacement() {
        let root = unique_test_directory("credential-store-concurrent-clear");
        let path = root.join("credential.dat");
        let store = CredentialStore::new(&path).expect("credential store");
        let original = credential('a', 1785268800000);
        let replacement = credential('b', 1785355200000);
        store.save(&original).expect("save original");

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let clear_store = store.clone();
        let replace_store = store.clone();
        let clear_barrier = std::sync::Arc::clone(&barrier);
        let replace_barrier = std::sync::Arc::clone(&barrier);
        let expected = original.refresh_token.clone();
        let replacement_for_thread = replacement.clone();
        let clear_thread = std::thread::spawn(move || {
            clear_barrier.wait();
            clear_store.clear_if_matches(&expected)
        });
        let replace_thread = std::thread::spawn(move || {
            replace_barrier.wait();
            replace_store.save_if_current(&original, &replacement_for_thread)
        });
        barrier.wait();
        let cleared = clear_thread
            .join()
            .expect("clear thread")
            .expect("clear result");
        let replaced = replace_thread
            .join()
            .expect("replace thread")
            .expect("replace result");

        // The lock serializes the operations: either the stale clear wins, or
        // the replacement wins, but a successful replacement is never deleted
        // by a stale clear that observed the old token.
        if replaced {
            assert!(!cleared);
            assert_eq!(store.load().expect("load replacement"), Some(replacement));
        } else if cleared {
            assert_eq!(store.load().expect("load cleared credential"), None);
        }

        drop(store);
        fs::remove_dir_all(root).expect("remove credential fixture");
    }

    #[test]
    fn short_refresh_token_fails_closed() {
        let invalid = BridgeCredential {
            refresh_token: "short".to_owned(),
            expires_at_utc_msc: 0,
        };
        assert_eq!(
            invalid.validate().expect_err("short token").code(),
            "bridge_credential_payload_invalid"
        );
    }

    #[test]
    fn credential_debug_output_never_contains_the_refresh_token() {
        let token = "S".repeat(MINIMUM_REFRESH_TOKEN_LENGTH);
        let credential = BridgeCredential {
            refresh_token: token.clone(),
            expires_at_utc_msc: 1,
        };
        let output = format!("{credential:?}");
        assert!(!output.contains(&token));
        assert!(output.contains("[REDACTED]"));
    }

    fn credential(character: char, expires_at_utc_msc: i64) -> BridgeCredential {
        BridgeCredential {
            refresh_token: std::iter::repeat_n(character, 64).collect(),
            expires_at_utc_msc,
        }
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-security-{}-{}-{suffix}",
            std::process::id(),
            stamp
        ))
    }
}
