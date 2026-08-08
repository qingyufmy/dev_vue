use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

pub(crate) const EXPERT_FILE_NAME: &str = "AURUMBridgeEA.ex4";
const MAXIMUM_EXPERT_BYTES: u64 = 16 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Mt4ExpertDeploymentStatus {
    Installed,
    Current,
}

impl Mt4ExpertDeploymentStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Current => "current",
        }
    }
}

pub(crate) fn resolve_expert_source(
    application_directory: &Path,
    configured_path: Option<OsString>,
) -> Result<PathBuf, &'static str> {
    if !application_directory.is_absolute() || !application_directory.is_dir() {
        return Err("bridge_application_directory_invalid");
    }
    if let Some(configured_path) = configured_path {
        let configured = configured_path.to_string_lossy();
        let configured = configured.trim();
        if !configured.is_empty() {
            let configured = absolute(Path::new(configured))?;
            return configured
                .is_file()
                .then_some(configured)
                .ok_or("mt4_ea_package_not_found");
        }
    }

    let packaged = application_directory
        .join("modules")
        .join("adapter.mt4")
        .join(EXPERT_FILE_NAME);
    if packaged.is_file() {
        return absolute(&packaged);
    }

    let mut current = Some(application_directory);
    for _ in 0..8 {
        let Some(directory) = current else {
            break;
        };
        let candidate = directory
            .join("bridge")
            .join("adapters")
            .join("mt4-ea")
            .join(EXPERT_FILE_NAME);
        if candidate.is_file() {
            return absolute(&candidate);
        }
        current = directory.parent();
    }
    Err("mt4_ea_package_not_found")
}

pub(crate) fn deploy_expert(
    source_path: &Path,
    terminal_data_path: &Path,
) -> Result<Mt4ExpertDeploymentStatus, &'static str> {
    let source_path = absolute(source_path)?;
    let terminal_data_path = absolute(terminal_data_path)?;
    let source = read_source(&source_path)?;
    let mql4_directory = terminal_data_path.join("MQL4");
    if !mql4_directory.is_dir() {
        return Err("mt4_terminal_data_path_not_found");
    }
    let experts_directory = mql4_directory.join("Experts");
    fs::create_dir_all(&experts_directory).map_err(normalize_install_error)?;
    let destination = experts_directory.join(EXPERT_FILE_NAME);
    if destination_matches(&destination, &source)? {
        return Ok(Mt4ExpertDeploymentStatus::Current);
    }
    write_atomically(&destination, &source)?;
    Ok(Mt4ExpertDeploymentStatus::Installed)
}

fn read_source(source_path: &Path) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::metadata(source_path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "mt4_ea_package_not_found"
        } else {
            normalize_install_error(error)
        }
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_EXPERT_BYTES {
        return Err("mt4_ea_package_invalid");
    }
    let source = fs::read(source_path).map_err(normalize_install_error)?;
    if source.is_empty() || source.len() as u64 > MAXIMUM_EXPERT_BYTES {
        return Err("mt4_ea_package_invalid");
    }
    Ok(source)
}

fn destination_matches(destination: &Path, source: &[u8]) -> Result<bool, &'static str> {
    let metadata = match fs::metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(normalize_install_error(error)),
    };
    if !metadata.is_file() || metadata.len() != source.len() as u64 {
        return Ok(false);
    }
    let current = fs::read(destination).map_err(normalize_install_error)?;
    Ok(Sha256::digest(source) == Sha256::digest(current))
}

fn write_atomically(destination: &Path, content: &[u8]) -> Result<(), &'static str> {
    let parent = destination.parent().ok_or("mt4_ea_destination_invalid")?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{EXPERT_FILE_NAME}.{}.{}.{}.tmp",
        std::process::id(),
        stamp,
        sequence
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(normalize_install_error)?;
        file.write_all(content).map_err(normalize_install_error)?;
        file.sync_all().map_err(normalize_install_error)?;
        drop(file);
        replace_file(&temporary, destination).map_err(normalize_install_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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

fn normalize_install_error(error: io::Error) -> &'static str {
    if error.kind() == io::ErrorKind::PermissionDenied {
        "mt4_ea_install_access_denied"
    } else {
        "mt4_ea_install_io_failed"
    }
}

fn absolute(path: &Path) -> Result<PathBuf, &'static str> {
    if path.as_os_str().is_empty() {
        return Err("mt4_ea_package_not_found");
    }
    std::path::absolute(path).map_err(|_| "mt4_ea_install_io_failed")
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_is_atomic_idempotent_and_replaces_an_old_expert() {
        let root = unique_test_directory("deploy");
        let application = root.join("application");
        let terminal = root.join("terminal");
        fs::create_dir_all(application.join("modules").join("adapter.mt4"))
            .expect("package directory");
        fs::create_dir_all(terminal.join("MQL4")).expect("terminal MQL4");
        let source = application
            .join("modules")
            .join("adapter.mt4")
            .join(EXPERT_FILE_NAME);
        fs::write(&source, b"expert-v1").expect("source expert");
        assert_eq!(
            deploy_expert(&source, &terminal),
            Ok(Mt4ExpertDeploymentStatus::Installed)
        );
        let destination = terminal.join("MQL4").join("Experts").join(EXPERT_FILE_NAME);
        assert_eq!(
            fs::read(&destination).expect("installed expert"),
            b"expert-v1"
        );
        assert_eq!(
            deploy_expert(&source, &terminal),
            Ok(Mt4ExpertDeploymentStatus::Current)
        );
        fs::write(&source, b"expert-v2").expect("updated source expert");
        assert_eq!(
            deploy_expert(&source, &terminal),
            Ok(Mt4ExpertDeploymentStatus::Installed)
        );
        assert_eq!(
            fs::read(&destination).expect("updated expert"),
            b"expert-v2"
        );
        assert_eq!(
            fs::read_dir(destination.parent().expect("experts directory"))
                .expect("read experts")
                .count(),
            1
        );
        fs::remove_dir_all(root).expect("remove deployment fixture");
    }

    #[test]
    fn source_and_terminal_failures_use_the_dotnet_error_contract() {
        let root = unique_test_directory("errors");
        fs::create_dir_all(&root).expect("error fixture");
        let missing = root.join("missing.ex4");
        let terminal = root.join("terminal");
        fs::create_dir_all(&terminal).expect("terminal");
        assert_eq!(
            deploy_expert(&missing, &terminal),
            Err("mt4_ea_package_not_found")
        );
        let empty = root.join("empty.ex4");
        fs::write(&empty, []).expect("empty source");
        assert_eq!(
            deploy_expert(&empty, &terminal),
            Err("mt4_ea_package_invalid")
        );
        let oversized = root.join("oversized.ex4");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&oversized)
            .expect("oversized source")
            .set_len(MAXIMUM_EXPERT_BYTES + 1)
            .expect("oversized source length");
        assert_eq!(
            deploy_expert(&oversized, &terminal),
            Err("mt4_ea_package_invalid")
        );
        fs::write(&empty, b"expert").expect("valid source");
        assert_eq!(
            deploy_expert(&empty, &terminal),
            Err("mt4_terminal_data_path_not_found")
        );
        fs::remove_dir_all(root).expect("remove error fixture");
    }

    #[test]
    fn source_resolution_matches_packaged_and_dotnet_development_layouts() {
        let root = unique_test_directory("source");
        let application = root
            .join("bridge")
            .join("native")
            .join("target")
            .join("debug");
        let development = root
            .join("bridge")
            .join("adapters")
            .join("mt4-ea")
            .join(EXPERT_FILE_NAME);
        fs::create_dir_all(&application).expect("application");
        fs::create_dir_all(development.parent().expect("development parent"))
            .expect("development directory");
        fs::write(&development, b"expert").expect("development expert");
        assert_eq!(
            resolve_expert_source(&application, None),
            Ok(std::path::absolute(&development).expect("absolute development path"))
        );

        let configured = root.join("configured.ex4");
        fs::write(&configured, b"configured").expect("configured expert");
        assert_eq!(
            resolve_expert_source(&application, Some(configured.clone().into_os_string())),
            Ok(std::path::absolute(&configured).expect("absolute configured path"))
        );
        assert_eq!(
            resolve_expert_source(&application, Some(root.join("absent.ex4").into_os_string())),
            Err("mt4_ea_package_not_found")
        );
        fs::remove_dir_all(root).expect("remove source fixture");
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-mt4-expert-installer-{}-{stamp}-{suffix}",
            std::process::id()
        ))
    }
}
