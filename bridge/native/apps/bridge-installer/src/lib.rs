use bridge_runtime_win::{SingleInstanceGuard, default_lock_directory};
use bridge_update::{
    InstallationIdentityStore, RELEASE_MARKER_FILE_NAME, ReleaseActivationStore, ReleaseManifest,
    ReleaseManifestClient, ReleaseManifestVerifier, ReleasePackage, ReleasePackageStager,
    ReleasePublishMode, ReleasePublishReceipt, ReleasePublishRequest, extract_verified_package,
    publish_release, validate_native_release_layout, validate_release_package_compatibility,
    verified_expanded_size, verify_package_file,
};
use std::collections::HashSet;
use std::ffi::{OsStr, OsString, c_void};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf, Prefix};
use std::process;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::{Host, Url};
use windows_registry::{CURRENT_USER, Transaction};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
#[cfg(test)]
use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
#[cfg(test)]
use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, GetAce};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetTokenInformation,
    PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_WRITE_THROUGH, GetDriveTypeW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    MoveFileExW,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{CSIDL_PROGRAM_FILES, SHGFP_TYPE_CURRENT, SHGetFolderPathW};

const LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
pub const UNINSTALL_HELPER_FILE_NAME: &str = "AURUMBridge.UninstallHelper.exe";
const PUBLIC_KEY_FILE_NAME: &str = "release-public-key.pem";
const ROLLOUT_CHANNEL_FILE_NAME: &str = "rollout-channel";
const POINTER_FILE_NAME: &str = "current.json";
const UNINSTALL_KEY_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\LiangjianBridge";
const MAXIMUM_MANIFEST_BYTES: u64 = 128 * 1024;
const MAXIMUM_TOTAL_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const REQUIRED_MODULES: [&str; 3] = ["core", "adapter.mt5.python", "adapter.mt4"];
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static LAST_PUBLISH_DIAGNOSTIC: OnceLock<Mutex<Option<String>>> = OnceLock::new();
const BOOTSTRAP_MANIFEST_PATH: &str = "/api/bridge/v3/releases/bootstrap";
const BRIDGE_RUNTIME_INSTANCE_PREFIX: &str = "AURUMBridge.v3";
const BRIDGE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);
const BRIDGE_PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const ROOT_TRANSACTION_FILE_NAMES: [&str; 5] = [
    LAUNCHER_FILE_NAME,
    UNINSTALL_HELPER_FILE_NAME,
    PUBLIC_KEY_FILE_NAME,
    ROLLOUT_CHANNEL_FILE_NAME,
    POINTER_FILE_NAME,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InstallerError {
    code: &'static str,
}

impl InstallerError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for InstallerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for InstallerError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallerConfiguration {
    pub public_key_pem: String,
    pub launcher_version: String,
    pub target_environment: String,
    pub install_root: PathBuf,
    pub rehearsal: bool,
}

impl InstallerConfiguration {
    pub fn validate(&self) -> Result<(), InstallerError> {
        if !self.install_root.is_absolute() {
            return Err(InstallerError::new("bootstrap_install_root_invalid"));
        }
        let install_root = std::path::absolute(&self.install_root)
            .map_err(|_| InstallerError::new("bootstrap_install_root_invalid"))?;
        if self.public_key_pem.trim().is_empty()
            || self.public_key_pem.len() > 16 * 1024
            || !matches!(self.target_environment.as_str(), "test" | "production")
            || self.launcher_version.trim().is_empty()
            || (self.rehearsal && self.target_environment != "test")
            || (self.rehearsal && paths_equal(&install_root, &default_install_root()?))
        {
            return Err(InstallerError::new("bootstrap_configuration_invalid"));
        }
        validate_install_root(&install_root, self.rehearsal)?;
        if !self.rehearsal {
            validate_target_user_identity()?;
            match registered_installation_root()? {
                Some(registered_root) => {
                    if !paths_equal(&registered_root, &install_root) {
                        return Err(InstallerError::new("bootstrap_install_root_locked"));
                    }
                    if !is_valid_registered_installation(&registered_root) {
                        return Err(InstallerError::new(
                            "bootstrap_installation_registration_invalid",
                        ));
                    }
                }
                None if install_root.is_dir()
                    && directory_has_unregistered_content(&install_root)? =>
                {
                    return Err(InstallerError::new("bootstrap_install_root_not_empty"));
                }
                None => {}
            }
        }
        ReleaseManifestVerifier::new(&self.public_key_pem)
            .map_err(|error| InstallerError::new(error.code()))?;
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallOutcome {
    pub version: String,
    pub install_root: PathBuf,
}

pub struct OfflineInstaller {
    configuration: InstallerConfiguration,
}

impl OfflineInstaller {
    pub fn new(configuration: InstallerConfiguration) -> Result<Self, InstallerError> {
        configuration.validate()?;
        Ok(Self { configuration })
    }

    pub async fn install(
        &self,
        offline_bundle_root: impl AsRef<Path>,
    ) -> Result<InstallOutcome, InstallerError> {
        let bundle_root = validate_bundle_root(offline_bundle_root.as_ref())?;
        let install_root = std::path::absolute(&self.configuration.install_root)
            .map_err(|_| InstallerError::new("bootstrap_install_root_invalid"))?;
        fs::create_dir_all(&install_root)
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        let _installation_lock =
            InstallationLock::acquire(&install_root, self.configuration.rehearsal)?;
        self.install_bundle(&bundle_root, &install_root).await
    }

    async fn install_bundle(
        &self,
        bundle_root: &Path,
        install_root: &Path,
    ) -> Result<InstallOutcome, InstallerError> {
        let operation_root = install_root.join(format!(
            ".bootstrap-{}-{}-{}",
            process::id(),
            timestamp_nanos(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&operation_root).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        let _operation_cleanup = TemporaryDirectoryCleanup {
            directory: operation_root.clone(),
            required_parent: install_root.to_path_buf(),
            required_prefix: ".bootstrap-",
        };
        let manifest = load_and_verify_manifest(
            bundle_root,
            &self.configuration.public_key_pem,
            &self.configuration.launcher_version,
        )?;
        validate_bootstrap_manifest(&manifest)?;
        let version_directory = operation_root.join("version");
        extract_offline_packages(bundle_root, &version_directory, &manifest).await?;
        validate_native_release_layout(&version_directory)
            .map_err(|error| InstallerError::new(error.code()))?;
        write_new_file(
            &version_directory.join(RELEASE_MARKER_FILE_NAME),
            &serde_json::to_vec(&manifest)
                .map_err(|_| InstallerError::new("bootstrap_json_invalid"))?,
        )?;

        prepare_running_bridge_for_install(self.configuration.rehearsal)?;

        let mut root_transaction = RootFileTransaction::capture(install_root)?;
        let publication =
            match install_version(install_root, &version_directory, &manifest.release_version) {
                Ok(publication) => publication,
                Err(error) => return Err(error),
            };
        let installed_version = publication.destination().to_path_buf();
        let persist_result = (|| -> Result<Option<RegistryInstallTransaction>, InstallerError> {
            let packaged_launcher = installed_version.join("launcher").join(LAUNCHER_FILE_NAME);
            if !packaged_launcher.is_file() {
                return Err(InstallerError::new("bootstrap_native_launcher_missing"));
            }
            copy_file_atomically(&packaged_launcher, &install_root.join(LAUNCHER_FILE_NAME))?;
            copy_file_atomically(
                &packaged_launcher,
                &install_root.join(UNINSTALL_HELPER_FILE_NAME),
            )?;
            write_file_atomically(
                &install_root.join(PUBLIC_KEY_FILE_NAME),
                self.configuration.public_key_pem.as_bytes(),
            )?;
            write_file_atomically(&install_root.join(ROLLOUT_CHANNEL_FILE_NAME), b"stable")?;
            ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))
                .map_err(|error| InstallerError::new(error.code()))?
                .initialize_healthy(&manifest.release_version, now_utc_msc())
                .map_err(|error| InstallerError::new(error.code()))?;
            if self.configuration.rehearsal {
                return Ok(None);
            }
            let target_sid = target_user_sid()?;
            apply_installation_acl(install_root, &target_sid)?;
            Ok(Some(register_installation(
                install_root,
                &manifest.release_version,
                directory_size(install_root)?,
            )?))
        })();
        let registry_transaction = match persist_result {
            Ok(registry_transaction) => registry_transaction,
            Err(error) => {
                let root_restore = root_transaction.rollback();
                let publication_restore = publication.rollback();
                if let Err(restore_error) = root_restore {
                    root_transaction.preserve();
                    record_root_diagnostic(&restore_error);
                    eprintln!(
                        "native_installer_root_restore_failed code=bootstrap_root_restore_failed {}",
                        restore_error.diagnostic_line()
                    );
                    if let Err(publication_error) = publication_restore {
                        record_publish_diagnostic(&publication_error);
                        eprintln!(
                            "native_installer_repair_restore_failed code={} {}",
                            publication_error.code(),
                            publication_error.diagnostic_line()
                        );
                    }
                    return Err(InstallerError::new("bootstrap_root_restore_failed"));
                }
                if let Err(restore_error) = publication_restore {
                    record_publish_diagnostic(&restore_error);
                    eprintln!(
                        "native_installer_repair_restore_failed code={} {}",
                        restore_error.code(),
                        restore_error.diagnostic_line()
                    );
                    return Err(InstallerError::new(restore_error.code()));
                }
                root_transaction.commit();
                return Err(error);
            }
        };
        if let Some(registry_transaction) = registry_transaction
            && let Err(error) = registry_transaction.commit()
        {
            let root_restore = root_transaction.rollback();
            let publication_restore = publication.rollback();
            if let Err(restore_error) = root_restore {
                root_transaction.preserve();
                record_root_diagnostic(&restore_error);
                eprintln!(
                    "native_installer_root_restore_failed code=bootstrap_root_restore_failed {}",
                    restore_error.diagnostic_line()
                );
                if let Err(publication_error) = publication_restore {
                    record_publish_diagnostic(&publication_error);
                    eprintln!(
                        "native_installer_repair_restore_failed code={} {}",
                        publication_error.code(),
                        publication_error.diagnostic_line()
                    );
                }
                return Err(InstallerError::new("bootstrap_root_restore_failed"));
            }
            if let Err(restore_error) = publication_restore {
                record_publish_diagnostic(&restore_error);
                eprintln!(
                    "native_installer_repair_restore_failed code={} {}",
                    restore_error.code(),
                    restore_error.diagnostic_line()
                );
                return Err(InstallerError::new(restore_error.code()));
            }
            root_transaction.commit();
            return Err(error);
        }
        root_transaction.commit();
        publication.commit();
        Ok(InstallOutcome {
            version: manifest.release_version,
            install_root: install_root.to_path_buf(),
        })
    }
}

pub struct OnlineInstaller {
    configuration: InstallerConfiguration,
    server_base: Url,
    client: reqwest::Client,
}

impl OnlineInstaller {
    pub fn new(
        configuration: InstallerConfiguration,
        server_url: &str,
    ) -> Result<Self, InstallerError> {
        configuration.validate()?;
        let server_base = validate_online_server(server_url, &configuration.target_environment)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10 * 60))
            .build()
            .map_err(|_| InstallerError::new("bootstrap_network_client_failed"))?;
        Ok(Self {
            configuration,
            server_base,
            client,
        })
    }

    pub fn server_url(&self) -> &str {
        self.server_base.as_str()
    }

    pub async fn install(
        &self,
        status: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<InstallOutcome, InstallerError> {
        let install_root = std::path::absolute(&self.configuration.install_root)
            .map_err(|_| InstallerError::new("bootstrap_install_root_invalid"))?;
        fs::create_dir_all(&install_root)
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        let _installation_lock =
            InstallationLock::acquire(&install_root, self.configuration.rehearsal)?;
        let bundle_root = install_root.join(format!(
            ".bootstrap-online-{}-{}-{}",
            process::id(),
            timestamp_nanos(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&bundle_root).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        let _bundle_cleanup = TemporaryDirectoryCleanup {
            directory: bundle_root.clone(),
            required_parent: install_root.clone(),
            required_prefix: ".bootstrap-online-",
        };

        status("正在验证发布信息…");
        status(if is_loopback_url(&self.server_base) {
            "正在检查本地安装服务…"
        } else {
            "正在连接安装服务器…"
        });
        let installation_id = InstallationIdentityStore::new(install_root.join("installation-id"))
            .map_err(|error| InstallerError::new(error.code()))?
            .load_or_create()
            .map_err(|error| InstallerError::new(error.code()))?;
        let verifier = ReleaseManifestVerifier::new(&self.configuration.public_key_pem)
            .map_err(|error| InstallerError::new(error.code()))?;
        let mut client = ReleaseManifestClient::with_endpoint(
            self.server_base.clone(),
            self.client.clone(),
            BOOTSTRAP_MANIFEST_PATH,
        )
        .map_err(|error| InstallerError::new(error.code()))?;
        let deadline = if is_loopback_url(&self.server_base) {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(15)
        };
        let manifest = match tokio::time::timeout(
            deadline,
            client.fetch_verified(
                &verifier,
                &self.configuration.launcher_version,
                &installation_id,
                "stable",
            ),
        )
        .await
        {
            Ok(Ok(Some(manifest))) => manifest,
            Ok(Ok(None)) | Err(_) => {
                return Err(InstallerError::new("bootstrap_release_unavailable"));
            }
            Ok(Err(error)) if error.code() == "update_manifest_request_failed" => {
                return Err(InstallerError::new("bootstrap_release_unavailable"));
            }
            Ok(Err(error)) => return Err(InstallerError::new(error.code())),
        };
        validate_bootstrap_manifest(&manifest)?;
        write_new_file(
            &bundle_root.join("manifest.signed.json"),
            &serde_json::to_vec(&manifest)
                .map_err(|_| InstallerError::new("bootstrap_json_invalid"))?,
        )?;

        status(&format!("正在下载量见智桥 {}…", manifest.release_version));
        let stager = ReleasePackageStager::new(self.client.clone(), bundle_root.join("cache"))
            .map_err(|error| InstallerError::new(error.code()))?;
        let mut packages = manifest.packages.iter().collect::<Vec<_>>();
        packages.sort_by(|left, right| left.module_id.cmp(&right.module_id));
        for package in packages {
            let downloaded = stager
                .download_verified(package)
                .await
                .map_err(|error| InstallerError::new(error.code()))?;
            copy_file_atomically(
                &downloaded,
                &bundle_root.join(package_file_name(&package.module_id)?),
            )?;
        }

        status("正在安装稳定启动组件…");
        OfflineInstaller::new(self.configuration.clone())?
            .install_bundle(&bundle_root, &install_root)
            .await
    }
}

pub fn default_install_root() -> Result<PathBuf, InstallerError> {
    let program_files = known_folder(CSIDL_PROGRAM_FILES)
        .ok()
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        })
        .ok_or_else(|| InstallerError::new("bootstrap_known_folder_failed"))?;
    Ok(program_files.join("AURUM").join("LiangjianBridge"))
}

fn known_folder(folder: u32) -> Result<PathBuf, InstallerError> {
    let mut buffer = [0_u16; 260];
    let result = unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            folder as i32,
            std::ptr::null_mut(),
            SHGFP_TYPE_CURRENT as u32,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(InstallerError::new("bootstrap_known_folder_failed"));
    }
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(0);
    if length == 0 {
        return Err(InstallerError::new("bootstrap_known_folder_failed"));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

fn validate_install_root(path: &Path, rehearsal: bool) -> Result<(), InstallerError> {
    let absolute = std::path::absolute(path)
        .map_err(|_| InstallerError::new("bootstrap_install_root_invalid"))?;
    if absolute.components().any(|component| {
        matches!(component, Component::ParentDir)
            || matches!(
                component,
                Component::Prefix(prefix)
                    if matches!(
                        prefix.kind(),
                        Prefix::UNC(..)
                            | Prefix::VerbatimUNC(..)
                            | Prefix::DeviceNS(..)
                            | Prefix::Verbatim(..)
                    )
            )
    }) {
        return Err(InstallerError::new("bootstrap_install_root_invalid"));
    }
    if absolute.components().next().is_none_or(|component| {
        !matches!(component, Component::Prefix(prefix) if matches!(prefix.kind(), Prefix::Disk(_)))
    }) || absolute.components().all(|component| !matches!(component, Component::RootDir)) {
        return Err(InstallerError::new("bootstrap_install_root_invalid"));
    }
    let root = drive_root(&absolute)
        .ok_or_else(|| InstallerError::new("bootstrap_install_root_invalid"))?;
    let root_text = wide_path(&root);
    if unsafe { GetDriveTypeW(root_text.as_ptr()) } != 3 {
        return Err(InstallerError::new("bootstrap_install_root_drive_invalid"));
    }
    validate_install_ancestors(&absolute)?;
    if absolute
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
        < 2
    {
        return Err(InstallerError::new("bootstrap_install_root_invalid"));
    }
    let program_files_roots = known_folder(CSIDL_PROGRAM_FILES)
        .ok()
        .into_iter()
        .chain(std::env::var_os("ProgramFiles").map(PathBuf::from))
        .chain(std::env::var_os("ProgramFiles(x86)").map(PathBuf::from))
        .collect::<Vec<_>>();
    if program_files_roots
        .iter()
        .any(|value| paths_equal(&absolute, value))
        || is_system_directory(&absolute)
        || (!rehearsal && is_temporary_directory(&absolute))
    {
        return Err(InstallerError::new("bootstrap_install_root_invalid"));
    }
    if let Ok(metadata) = fs::symlink_metadata(&absolute) {
        if !metadata.is_dir() || is_reparse_metadata(&metadata) {
            return Err(InstallerError::new("bootstrap_install_root_boundary"));
        }
    } else if absolute.exists() {
        return Err(InstallerError::new("bootstrap_install_root_invalid"));
    }
    Ok(())
}

fn validate_install_ancestors(path: &Path) -> Result<(), InstallerError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_reparse_metadata(&metadata) => {
                return Err(InstallerError::new("bootstrap_install_root_boundary"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(InstallerError::new("bootstrap_install_root_invalid")),
        }
    }
    Ok(())
}

fn drive_root(path: &Path) -> Option<PathBuf> {
    let text = path.to_string_lossy();
    (text.len() >= 2 && text.as_bytes().get(1) == Some(&b':'))
        .then(|| PathBuf::from(format!("{}\\", &text[..2])))
}

fn is_system_directory(path: &Path) -> bool {
    let path_is_under = |base: Option<PathBuf>| {
        base.is_some_and(|base| path_starts_with_case_insensitive(path, &base))
    };
    let windows_root = std::env::var_os("WINDIR").map(PathBuf::from);
    let system_root = windows_root.as_ref().map(|value| value.join("System32"));
    path_is_under(windows_root) || path_is_under(system_root)
}

fn is_temporary_directory(path: &Path) -> bool {
    path_starts_with_case_insensitive(path, &std::env::temp_dir())
}

fn path_starts_with_case_insensitive(path: &Path, base: &Path) -> bool {
    let path = path
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase();
    let base = base
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase();
    path == base
        || path
            .strip_prefix(&base)
            .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
}

fn directory_has_unregistered_content(path: &Path) -> Result<bool, InstallerError> {
    let entries = fs::read_dir(path).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    for entry in entries {
        let entry = entry.map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(
            name.as_ref(),
            "logs" | "versions" | "cache" | "health" | "quarantine" | "update-state.json"
        ) || name.starts_with(".bootstrap-")
            || name.starts_with(".repair-")
        {
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn registered_installation_root() -> Result<Option<PathBuf>, InstallerError> {
    let key = match CURRENT_USER.open(UNINSTALL_KEY_PATH) {
        Ok(key) => key,
        Err(error) if matches!(error.code().0 as u32, 0x8007_0002 | 0x8007_0003) => {
            return Ok(None);
        }
        Err(_) => {
            return Err(InstallerError::new(
                "bootstrap_installation_registration_unavailable",
            ));
        }
    };
    let value = key
        .get_string("InstallLocation")
        .map_err(|_| InstallerError::new("bootstrap_installation_registration_invalid"))?;
    let path = std::path::absolute(value)
        .map_err(|_| InstallerError::new("bootstrap_installation_registration_invalid"))?;
    Ok(Some(path))
}

fn is_valid_registered_installation(root: &Path) -> bool {
    root.join(LAUNCHER_FILE_NAME).is_file()
        && root.join(POINTER_FILE_NAME).is_file()
        && root.join("versions").is_dir()
}

fn validate_target_user_identity() -> Result<(), InstallerError> {
    target_user_sid().map(|_| ())
}

fn target_user_sid() -> Result<String, InstallerError> {
    let current = token_sid(unsafe { GetCurrentProcess() })
        .map_err(|_| InstallerError::new("bootstrap_target_user_unavailable"))?;
    let target = interactive_shell_sid()
        .ok_or_else(|| InstallerError::new("bootstrap_target_user_unavailable"))?;
    if current != target {
        return Err(InstallerError::new("bootstrap_target_user_mismatch"));
    }
    Ok(current)
}

fn interactive_shell_sid() -> Option<String> {
    let mut current_session = 0_u32;
    if unsafe { ProcessIdToSessionId(std::process::id(), &mut current_session) } == 0 {
        return None;
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    let mut sid = None;
    while available {
        let mut explorer_session = 0_u32;
        if utf16_name(&entry.szExeFile).eq_ignore_ascii_case("explorer.exe")
            && unsafe { ProcessIdToSessionId(entry.th32ProcessID, &mut explorer_session) } != 0
            && explorer_session == current_session
        {
            let process =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
            if !process.is_null() {
                sid = token_sid(process).ok();
                unsafe { CloseHandle(process) };
                if sid.is_some() {
                    break;
                }
            }
        }
        available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    sid
}

fn token_sid(process: HANDLE) -> Result<String, ()> {
    let mut token = null_mut();
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
    if opened == 0 {
        return Err(());
    }
    let mut required = 0_u32;
    unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required) };
    if required == 0 {
        unsafe { CloseHandle(token) };
        return Err(());
    }
    let mut buffer = vec![0_u8; required as usize];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        unsafe { CloseHandle(token) };
        return Err(());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid_text = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid_text) } == 0 {
        unsafe { CloseHandle(token) };
        return Err(());
    }
    let sid = utf16_ptr(sid_text);
    unsafe {
        LocalFree(sid_text.cast());
        CloseHandle(token);
    }
    sid.ok_or(())
}

fn utf16_ptr(value: *const u16) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let mut length = 0_usize;
    unsafe {
        while *value.add(length) != 0 {
            length += 1;
            if length > 256 {
                return None;
            }
        }
        String::from_utf16(std::slice::from_raw_parts(value, length)).ok()
    }
}

fn apply_installation_acl(install_root: &Path, target_sid: &str) -> Result<(), InstallerError> {
    if target_sid.is_empty() || !target_sid.starts_with("S-") {
        return Err(InstallerError::new("bootstrap_target_user_invalid"));
    }
    let root_sddl = root_acl_sddl(target_sid);
    set_path_dacl(install_root, &root_sddl)?;
    let writable_directory_sddl = writable_directory_acl_sddl(target_sid);
    for directory in ["versions", "cache", "logs", "health", "quarantine"] {
        let path = install_root.join(directory);
        if path.exists() {
            set_path_dacl(&path, &writable_directory_sddl)?;
        }
    }
    let writable_file_sddl = writable_file_acl_sddl(target_sid);
    for file in [
        LAUNCHER_FILE_NAME,
        POINTER_FILE_NAME,
        "update-state.json",
        "installation-id",
        ROLLOUT_CHANNEL_FILE_NAME,
    ] {
        let path = install_root.join(file);
        if path.is_file() {
            set_path_dacl(&path, &writable_file_sddl)?;
        }
    }
    let protected_file_sddl = protected_file_acl_sddl(target_sid);
    for file in [PUBLIC_KEY_FILE_NAME, UNINSTALL_HELPER_FILE_NAME] {
        let path = install_root.join(file);
        if path.is_file() {
            set_path_dacl(&path, &protected_file_sddl)?;
        }
    }
    Ok(())
}

fn root_acl_sddl(target_sid: &str) -> String {
    format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200af;;;{target_sid})(A;OICIIO;0x1301bf;;;CO)")
}

fn writable_directory_acl_sddl(target_sid: &str) -> String {
    format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;OICI;0x1301bf;;;{target_sid})")
}

fn writable_file_acl_sddl(target_sid: &str) -> String {
    format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1301bf;;;{target_sid})")
}

fn protected_file_acl_sddl(target_sid: &str) -> String {
    format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;{target_sid})(D;;GWSD;;;{target_sid})")
}

fn set_path_dacl(path: &Path, sddl: &str) -> Result<(), InstallerError> {
    let descriptor_text = wide_null(sddl);
    let mut descriptor: *mut c_void = null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_text.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    };
    if converted == 0 || descriptor.is_null() {
        return Err(InstallerError::new("bootstrap_acl_apply_failed"));
    }
    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl = null_mut();
    let dacl_result = unsafe {
        GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    };
    let result = if dacl_result == 0 || dacl_present == 0 {
        Err(InstallerError::new("bootstrap_acl_apply_failed"))
    } else {
        let path_text = wide_path(path);
        let status = unsafe {
            SetNamedSecurityInfoW(
                path_text.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(InstallerError::new("bootstrap_acl_apply_failed"))
        }
    };
    unsafe { LocalFree(descriptor) };
    result
}

#[cfg(test)]
fn named_dacl_masks(path: &Path) -> Result<Vec<(u8, u32)>, InstallerError> {
    let path_text = wide_path(path);
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: *mut c_void = null_mut();
    let status = unsafe {
        GetNamedSecurityInfoW(
            path_text.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 || dacl.is_null() || descriptor.is_null() {
        return Err(InstallerError::new("bootstrap_acl_query_failed"));
    }
    let acl = unsafe { &*dacl };
    let mut masks = Vec::with_capacity(acl.AceCount as usize);
    for index in 0..u32::from(acl.AceCount) {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
            unsafe { LocalFree(descriptor) };
            return Err(InstallerError::new("bootstrap_acl_query_failed"));
        }
        let header = unsafe { &*(ace.cast::<ACE_HEADER>()) };
        if header.AceType == 0 {
            let allowed = unsafe { &*(ace.cast::<ACCESS_ALLOWED_ACE>()) };
            masks.push((header.AceFlags, allowed.Mask));
        } else {
            masks.push((header.AceFlags, 0));
        }
    }
    unsafe { LocalFree(descriptor) };
    Ok(masks)
}

pub fn write_failure_log(error: InstallerError) {
    let Ok(root) = default_install_root() else {
        return;
    };
    write_failure_log_at(&root, error);
}

pub fn write_failure_log_at(root: &Path, error: InstallerError) {
    let logs = root.join("logs");
    if fs::create_dir_all(&logs).is_err() {
        return;
    }
    let diagnostic = LAST_PUBLISH_DIAGNOSTIC
        .get()
        .and_then(|value| value.lock().ok())
        .and_then(|mut value| value.take());
    let payload = match diagnostic {
        Some(diagnostic) => format!(
            "{}\r\n{}\r\n{}\r\n",
            now_utc_msc(),
            error.code(),
            diagnostic
        ),
        None => format!("{}\r\n{}\r\n", now_utc_msc(), error.code()),
    };
    let _ = fs::write(logs.join("installer-last-error.log"), payload.as_bytes());
}

fn record_publish_diagnostic(error: &bridge_update::ReleasePublishError) {
    let slot = LAST_PUBLISH_DIAGNOSTIC.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = slot.lock() {
        *value = Some(error.diagnostic_line());
    }
}

#[derive(Debug)]
struct RootFileTransactionError {
    phase: &'static str,
    error: io::Error,
}

impl RootFileTransactionError {
    fn diagnostic_line(&self) -> String {
        format!(
            "stage={};raw_os_error={};error_kind={:?}",
            self.phase,
            self.error
                .raw_os_error()
                .map_or_else(|| "none".to_owned(), |value| value.to_string()),
            self.error.kind(),
        )
    }
}

#[derive(Debug)]
struct RootFileSnapshot {
    target: PathBuf,
    backup: Option<PathBuf>,
}

/// Backs up the root files that are changed after version publication.  The
/// directory is deliberately outside the temporary extraction folder so a
/// failed restore leaves an administrator-recoverable copy.
#[must_use = "a root file transaction must be committed or restored"]
struct RootFileTransaction {
    backup_directory: PathBuf,
    snapshots: Vec<RootFileSnapshot>,
    preserve_on_drop: bool,
}

impl RootFileTransaction {
    fn capture(install_root: &Path) -> Result<Self, InstallerError> {
        let backup_directory = install_root.join(format!(
            ".repair-root-backup-{}-{}",
            process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&backup_directory)
            .map_err(|_| InstallerError::new("bootstrap_root_backup_failed"))?;
        let mut transaction = Self {
            backup_directory,
            snapshots: Vec::with_capacity(ROOT_TRANSACTION_FILE_NAMES.len()),
            preserve_on_drop: false,
        };
        for name in ROOT_TRANSACTION_FILE_NAMES {
            let target = install_root.join(name);
            let metadata = match fs::symlink_metadata(&target) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    transaction.snapshots.push(RootFileSnapshot {
                        target,
                        backup: None,
                    });
                    continue;
                }
                Err(_) => {
                    return Err(InstallerError::new("bootstrap_root_backup_failed"));
                }
            };
            if !metadata.is_file() || is_reparse_metadata(&metadata) {
                return Err(InstallerError::new("bootstrap_root_backup_boundary"));
            }
            let backup = transaction.backup_directory.join(name);
            copy_file_create_new_raw(&target, &backup)
                .map_err(|_| InstallerError::new("bootstrap_root_backup_failed"))?;
            transaction.snapshots.push(RootFileSnapshot {
                target,
                backup: Some(backup),
            });
        }
        Ok(transaction)
    }

    fn rollback(&self) -> Result<(), RootFileTransactionError> {
        let mut first_error = None;
        for snapshot in &self.snapshots {
            let result = match &snapshot.backup {
                Some(backup) => restore_root_file(backup, &snapshot.target),
                None => remove_absent_root_file(&snapshot.target),
            };
            if let Err(error) = result
                && first_error.is_none()
            {
                first_error = Some(RootFileTransactionError {
                    phase: "root_file_restore",
                    error,
                });
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn preserve(&mut self) {
        self.preserve_on_drop = true;
    }

    fn commit(mut self) {
        self.preserve_on_drop = false;
        if let Err(error) = fs::remove_dir_all(&self.backup_directory)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!(
                "native_installer_root_backup_cleanup_failed stage=root_backup_cleanup raw_os_error={} error_kind={:?}",
                error
                    .raw_os_error()
                    .map_or_else(|| "none".to_owned(), |value| value.to_string()),
                error.kind()
            );
        }
    }
}

impl Drop for RootFileTransaction {
    fn drop(&mut self) {
        if !self.preserve_on_drop {
            let _ = fs::remove_dir_all(&self.backup_directory);
        }
    }
}

fn record_root_diagnostic(error: &RootFileTransactionError) {
    let slot = LAST_PUBLISH_DIAGNOSTIC.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = slot.lock() {
        *value = Some(error.diagnostic_line());
    }
}

fn is_reparse_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink()
}

fn remove_absent_root_file(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() || is_reparse_metadata(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "root file boundary",
        ));
    }
    fs::remove_file(path)
}

fn restore_root_file(backup: &Path, target: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if metadata.is_some_and(|value| !value.is_file() || is_reparse_metadata(&value)) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "root file boundary",
        ));
    }
    copy_file_atomically_raw(backup, target)
}

fn copy_file_create_new_raw(source: &Path, destination: &Path) -> io::Result<()> {
    let mut input = fs::File::open(source)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(destination)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()
}

fn copy_file_atomically_raw(source: &Path, destination: &Path) -> io::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination"))?;
    let temporary = parent.join(format!(
        ".root-restore-{}-{}-{}.tmp",
        process::id(),
        timestamp_nanos(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        copy_file_create_new_raw(source, &temporary)?;
        replace_file_raw(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn replace_file_raw(source: &Path, destination: &Path) -> io::Result<()> {
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

pub fn describe_installer_error(error: InstallerError) -> &'static str {
    match error.code() {
        "bootstrap_running_process_detected" => "请先退出正在运行的量见智桥，再重新安装。",
        "bootstrap_running_process_stop_timeout" => {
            "量见智桥未能自动退出。请从托盘退出后重新安装。"
        }
        "bootstrap_shutdown_signal_failed" => {
            "无法通知正在运行的量见智桥退出。请从托盘退出后重新安装。"
        }
        "bootstrap_installation_in_progress" => "另一个安装程序正在运行，请稍后重试。",
        "bootstrap_release_unavailable" => "当前没有可用于首次安装的稳定版本，请稍后重试。",
        "update_manifest_signature_invalid" | "update_package_signature_invalid" => {
            "安装包安全校验失败，已停止安装。"
        }
        "update_package_integrity_failed" | "update_package_size_mismatch" => {
            "安装包下载不完整，请检查网络后重试。"
        }
        "bootstrap_io_failed" | "update_version_publish_failed" => {
            "安装文件暂时被安全软件或其他程序占用。安装程序已重试仍未完成，请稍后重试；如持续失败，请将错误日志交给管理员。"
        }
        "bootstrap_repair_restore_failed" => {
            "修复未完成，旧版本备份仍然保留。请不要手工删除安装目录，并联系管理员处理。"
        }
        "bootstrap_root_restore_failed" => {
            "安装失败后的根文件恢复未完成。请不要手工删除安装目录，并联系管理员处理。"
        }
        _ => "安装未完成，请检查网络后重试；如仍失败，请联系管理员。",
    }
}

pub fn start_launcher(install_root: impl AsRef<Path>) -> Result<(), InstallerError> {
    let root = std::path::absolute(install_root.as_ref())
        .map_err(|_| InstallerError::new("bootstrap_install_root_invalid"))?;
    let launcher = root.join(LAUNCHER_FILE_NAME);
    if !launcher.is_file() {
        return Err(InstallerError::new("bootstrap_native_launcher_missing"));
    }
    process::Command::new(launcher)
        .spawn()
        .map_err(|_| InstallerError::new("bootstrap_launcher_start_failed"))?;
    Ok(())
}

fn validate_online_server(value: &str, target_environment: &str) -> Result<Url, InstallerError> {
    let mut server =
        Url::parse(value).map_err(|_| InstallerError::new("bootstrap_server_url_invalid"))?;
    if server.cannot_be_a_base()
        || !server.username().is_empty()
        || server.password().is_some()
        || server.query().is_some()
        || server.fragment().is_some()
        || server.path() != "/"
        || (target_environment == "test"
            && (server.scheme() != "http" || !is_loopback_url(&server)))
        || (target_environment == "production" && server.scheme() != "https")
    {
        return Err(InstallerError::new("bootstrap_server_url_invalid"));
    }
    server.set_path("/");
    Ok(server)
}

fn is_loopback_url(server: &Url) -> bool {
    match server.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

fn load_and_verify_manifest(
    bundle_root: &Path,
    public_key_pem: &str,
    launcher_version: &str,
) -> Result<ReleaseManifest, InstallerError> {
    let path = bundle_root.join("manifest.signed.json");
    let metadata = fs::metadata(&path)
        .map_err(|_| InstallerError::new("bootstrap_offline_manifest_missing"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_MANIFEST_BYTES {
        return Err(InstallerError::new("bootstrap_offline_manifest_missing"));
    }
    let payload =
        fs::read(path).map_err(|_| InstallerError::new("bootstrap_offline_manifest_missing"))?;
    let manifest = serde_json::from_slice::<ReleaseManifest>(&payload)
        .map_err(|_| InstallerError::new("bootstrap_offline_manifest_invalid"))?;
    ReleaseManifestVerifier::new(public_key_pem)
        .map_err(|error| InstallerError::new(error.code()))?
        .verify(&manifest, launcher_version)
        .map_err(|error| InstallerError::new(error.code()))?;
    Ok(manifest)
}

fn validate_bootstrap_manifest(manifest: &ReleaseManifest) -> Result<(), InstallerError> {
    validate_release_package_compatibility(manifest)
        .map_err(|error| InstallerError::new(error.code()))?;
    let modules = manifest
        .packages
        .iter()
        .map(|package| package.module_id.as_str())
        .collect::<HashSet<_>>();
    if manifest.schema_version != 2
        || manifest.release_id.as_deref().is_none_or(str::is_empty)
        || manifest.priority.as_deref() != Some("normal")
        || manifest.activation_deadline_utc_msc.is_some()
        || manifest.rollout_channel.as_deref() != Some("stable")
        || manifest.rollout_percentage != Some(100)
        || manifest.packages.len() != REQUIRED_MODULES.len()
        || REQUIRED_MODULES
            .iter()
            .any(|required| !modules.contains(required))
        || manifest
            .packages
            .iter()
            .any(|package| package.version != manifest.release_version)
    {
        return Err(InstallerError::new(
            "bootstrap_manifest_package_set_invalid",
        ));
    }
    Ok(())
}

async fn extract_offline_packages(
    bundle_root: &Path,
    version_directory: &Path,
    manifest: &ReleaseManifest,
) -> Result<(), InstallerError> {
    let mut packages = manifest.packages.iter().collect::<Vec<_>>();
    packages.sort_by_key(|package| {
        (
            if package.module_id == "core" { 0 } else { 1 },
            package.module_id.as_str(),
        )
    });
    let mut expanded_total = 0_u64;
    for package in &packages {
        let archive = offline_package_path(bundle_root, package)?;
        if !verify_package_file(package, &archive)
            .await
            .map_err(|error| InstallerError::new(error.code()))?
        {
            return Err(InstallerError::new(
                "bootstrap_offline_package_integrity_failed",
            ));
        }
        expanded_total = expanded_total
            .checked_add(
                verified_expanded_size(package, &archive)
                    .map_err(|error| InstallerError::new(error.code()))?,
            )
            .ok_or_else(|| InstallerError::new("bootstrap_package_expanded_size_exceeded"))?;
        if expanded_total > MAXIMUM_TOTAL_EXPANDED_BYTES {
            return Err(InstallerError::new(
                "bootstrap_package_expanded_size_exceeded",
            ));
        }
    }
    for package in packages {
        let archive = offline_package_path(bundle_root, package)?;
        let destination = if package.module_id == "core" {
            version_directory.to_path_buf()
        } else {
            let modules = version_directory.join("modules");
            fs::create_dir_all(&modules).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
            modules.join(&package.module_id)
        };
        extract_verified_package(package, archive, destination)
            .map_err(|error| InstallerError::new(error.code()))?;
    }
    Ok(())
}

fn offline_package_path(
    bundle_root: &Path,
    package: &ReleasePackage,
) -> Result<PathBuf, InstallerError> {
    Ok(bundle_root.join(package_file_name(&package.module_id)?))
}

fn package_file_name(module_id: &str) -> Result<&'static str, InstallerError> {
    Ok(match module_id {
        "core" => "core.zip",
        "adapter.mt5.python" => "adapter.mt5.python.zip",
        "adapter.mt4" => "adapter.mt4.zip",
        _ => return Err(InstallerError::new("bootstrap_offline_package_invalid")),
    })
}

fn validate_bundle_root(value: &Path) -> Result<PathBuf, InstallerError> {
    let root = std::path::absolute(value)
        .map_err(|_| InstallerError::new("bootstrap_offline_bundle_invalid"))?;
    let metadata =
        fs::metadata(&root).map_err(|_| InstallerError::new("bootstrap_offline_bundle_invalid"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(InstallerError::new("bootstrap_offline_bundle_invalid"));
    }
    Ok(root)
}

fn install_version(
    install_root: &Path,
    source: &Path,
    version: &str,
) -> Result<ReleasePublishReceipt, InstallerError> {
    if version.split('.').count() < 2
        || !version.split('.').all(|component| {
            !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err(InstallerError::new("bootstrap_version_invalid"));
    }
    let versions = install_root.join("versions");
    fs::create_dir_all(&versions).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    let destination = versions.join(version);
    let mut protected_versions = HashSet::new();
    let pointer_path = install_root.join(POINTER_FILE_NAME);
    if pointer_path.exists() {
        let pointer = ReleaseActivationStore::new(pointer_path)
            .map_err(|error| InstallerError::new(error.code()))?
            .load()
            .map_err(|error| InstallerError::new(error.code()))?;
        protected_versions.insert(pointer.active_version);
        protected_versions.insert(pointer.last_known_good_version);
    }
    let mode = if destination.exists() {
        ReleasePublishMode::SameVersionRepair
    } else {
        ReleasePublishMode::NewVersion
    };
    let validate_layout =
        |directory: &Path| validate_native_release_layout(directory).map_err(|error| error.code());
    publish_release(ReleasePublishRequest {
        versions_root: &versions,
        source_directory: source,
        destination_version: version,
        protected_versions: &protected_versions,
        mode,
        io_error_code: "bootstrap_io_failed",
        repair_restore_error_code: "bootstrap_repair_restore_failed",
        validate_layout: &validate_layout,
    })
    .map_err(|error| {
        record_publish_diagnostic(&error);
        eprintln!(
            "native_installer_version_publish_failed code={} {}",
            error.code(),
            error.diagnostic_line()
        );
        InstallerError::new(error.code())
    })
}

fn write_new_file(path: &Path, payload: &[u8]) -> Result<(), InstallerError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(path)
        .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    file.write_all(payload)
        .and_then(|()| file.sync_all())
        .map_err(|_| InstallerError::new("bootstrap_io_failed"))
}

fn copy_file_atomically(source: &Path, destination: &Path) -> Result<(), InstallerError> {
    let mut input =
        fs::File::open(source).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    let parent = destination
        .parent()
        .ok_or_else(|| InstallerError::new("bootstrap_io_failed"))?;
    fs::create_dir_all(parent).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("installer"),
        process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .custom_flags(FILE_FLAG_WRITE_THROUGH)
            .open(&temporary)
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        io::copy(&mut input, &mut output)
            .and_then(|_| output.sync_all())
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        drop(output);
        replace_file(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn write_file_atomically(path: &Path, payload: &[u8]) -> Result<(), InstallerError> {
    let parent = path
        .parent()
        .ok_or_else(|| InstallerError::new("bootstrap_io_failed"))?;
    fs::create_dir_all(parent).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("installer"),
        process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        write_new_file(&temporary, payload)?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), InstallerError> {
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
        Err(InstallerError::new("bootstrap_io_failed"))
    } else {
        Ok(())
    }
}

struct RegistryInstallTransaction {
    transaction: Option<Transaction>,
}

impl RegistryInstallTransaction {
    fn commit(mut self) -> Result<(), InstallerError> {
        self.transaction
            .take()
            .ok_or_else(|| InstallerError::new("bridge_uninstall_registry_unavailable"))?
            .commit()
            .map_err(|_| InstallerError::new("bridge_uninstall_registry_unavailable"))
    }
}

fn register_installation(
    install_root: &Path,
    version: &str,
    estimated_size_bytes: u64,
) -> Result<RegistryInstallTransaction, InstallerError> {
    let launcher = install_root.join(LAUNCHER_FILE_NAME);
    if !launcher.is_file() || !install_root.join(UNINSTALL_HELPER_FILE_NAME).is_file() {
        return Err(InstallerError::new("bridge_launcher_missing"));
    }
    let launcher_text = launcher.to_string_lossy();
    let install_text = install_root.to_string_lossy();
    let uninstall = format!("\"{launcher_text}\" --uninstall");
    let transaction = Transaction::new()
        .map_err(|_| InstallerError::new("bridge_uninstall_registry_unavailable"))?;
    let mut options = CURRENT_USER.options();
    let key = options
        .read()
        .write()
        .create()
        .transaction(&transaction)
        .open(UNINSTALL_KEY_PATH)
        .map_err(|_| InstallerError::new("bridge_uninstall_registry_unavailable"))?;
    key.set_string("DisplayName", "量见智桥")
        .and_then(|()| key.set_string("DisplayVersion", version))
        .and_then(|()| key.set_string("Publisher", "量见"))
        .and_then(|()| key.set_string("DisplayIcon", launcher_text.as_ref()))
        .and_then(|()| key.set_string("InstallLocation", install_text.as_ref()))
        .and_then(|()| key.set_string("UninstallString", uninstall))
        .and_then(|()| key.set_u32("NoModify", 1))
        .and_then(|()| key.set_u32("NoRepair", 1))
        .and_then(|()| {
            key.set_u32(
                "EstimatedSize",
                (estimated_size_bytes / 1024).clamp(1, i32::MAX as u64) as u32,
            )
        })
        .map_err(|_| InstallerError::new("bridge_uninstall_registry_unavailable"))?;
    Ok(RegistryInstallTransaction {
        transaction: Some(transaction),
    })
}

fn directory_size(root: &Path) -> Result<u64, InstallerError> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(directory).map_err(|_| InstallerError::new("bootstrap_io_failed"))?
        {
            let entry = entry.map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
            let metadata = entry
                .metadata()
                .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
            if metadata.file_type().is_symlink() {
                return Err(InstallerError::new("bootstrap_version_path_invalid"));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| InstallerError::new("bootstrap_io_failed"))?;
            }
        }
    }
    Ok(total)
}

fn prepare_running_bridge_for_install(rehearsal: bool) -> Result<(), InstallerError> {
    if rehearsal {
        return Ok(());
    }
    stop_running_bridge_with(
        bridge_processes_running,
        request_bridge_shutdown,
        wait_for_bridge_processes_to_exit,
        BRIDGE_SHUTDOWN_TIMEOUT,
    )
}

fn stop_running_bridge_with<Probe, Signal, Wait>(
    mut process_probe: Probe,
    shutdown_signal: Signal,
    wait_for_exit: Wait,
    timeout: Duration,
) -> Result<(), InstallerError>
where
    Probe: FnMut() -> Result<bool, InstallerError>,
    Signal: FnOnce() -> Result<(), InstallerError>,
    Wait: FnOnce(Duration) -> Result<bool, InstallerError>,
{
    if !process_probe()? {
        return Ok(());
    }
    shutdown_signal()?;
    if !wait_for_exit(timeout)? || process_probe()? {
        return Err(InstallerError::new(
            "bootstrap_running_process_stop_timeout",
        ));
    }
    Ok(())
}

fn request_bridge_shutdown() -> Result<(), InstallerError> {
    let lock_directory = default_lock_directory()
        .map_err(|_| InstallerError::new("bootstrap_shutdown_signal_failed"))?;
    request_bridge_shutdown_in(&lock_directory)
}

fn request_bridge_shutdown_in(lock_directory: &Path) -> Result<(), InstallerError> {
    let mut instance_ids = vec![
        BRIDGE_RUNTIME_INSTANCE_PREFIX.to_owned(),
        format!("{BRIDGE_RUNTIME_INSTANCE_PREFIX}.ui"),
    ];
    match fs::read_dir(lock_directory) {
        Ok(entries) => {
            for entry in entries {
                let entry =
                    entry.map_err(|_| InstallerError::new("bootstrap_shutdown_signal_failed"))?;
                if !entry
                    .file_type()
                    .map_err(|_| InstallerError::new("bootstrap_shutdown_signal_failed"))?
                    .is_file()
                {
                    continue;
                }
                let name = entry.file_name();
                let Some(instance_id) = name.to_str().and_then(|value| value.strip_suffix(".lock"))
                else {
                    continue;
                };
                if is_bridge_runtime_instance_id(instance_id) {
                    instance_ids.push(instance_id.to_owned());
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(InstallerError::new("bootstrap_shutdown_signal_failed")),
    }
    instance_ids.sort_by(|left, right| {
        right
            .ends_with(".ui")
            .cmp(&left.ends_with(".ui"))
            .then_with(|| left.cmp(right))
    });
    instance_ids.dedup();
    for instance_id in instance_ids {
        SingleInstanceGuard::request_shutdown(&instance_id)
            .map_err(|_| InstallerError::new("bootstrap_shutdown_signal_failed"))?;
    }
    Ok(())
}

fn is_bridge_runtime_instance_id(instance_id: &str) -> bool {
    if matches!(instance_id, "AURUMBridge.v3" | "AURUMBridge.v3.ui") {
        return true;
    }
    let Some(profile) = instance_id
        .strip_prefix("AURUMBridge.v3.profile.")
        .map(|value| value.strip_suffix(".ui").unwrap_or(value))
    else {
        return false;
    };
    !profile.is_empty()
        && profile.len() <= 40
        && profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn wait_for_bridge_processes_to_exit(timeout: Duration) -> Result<bool, InstallerError> {
    let deadline = Instant::now() + timeout;
    loop {
        if !bridge_processes_running()? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(
            BRIDGE_PROCESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn bridge_processes_running() -> Result<bool, InstallerError> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(InstallerError::new("bootstrap_process_scan_failed"));
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    let mut running = false;
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while available {
        let name = utf16_name(&entry.szExeFile);
        if name.eq_ignore_ascii_case("AURUMBridge.exe")
            || name.eq_ignore_ascii_case("AURUMBridge.Core.exe")
            || name.eq_ignore_ascii_case(LAUNCHER_FILE_NAME)
        {
            running = true;
            break;
        }
        available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    Ok(running)
}

struct InstallationLock(HANDLE);

impl InstallationLock {
    fn acquire(install_root: &Path, rehearsal: bool) -> Result<Self, InstallerError> {
        let suffix = if rehearsal {
            let identity = install_root.to_string_lossy().bytes().fold(
                1469598103934665603_u64,
                |hash, byte| {
                    hash.wrapping_mul(1099511628211)
                        .wrapping_add(u64::from(byte))
                },
            );
            format!("-Rehearsal-{identity:016x}")
        } else {
            String::new()
        };
        let name = wide_null(&format!("Local\\AURUM-LiangjianBridge-Installer{suffix}"));
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(InstallerError::new("bootstrap_installation_lock_failed"));
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) };
            return Err(InstallerError::new("bootstrap_installation_in_progress"));
        }
        Ok(Self(handle))
    }
}

impl Drop for InstallationLock {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

struct TemporaryDirectoryCleanup {
    directory: PathBuf,
    required_parent: PathBuf,
    required_prefix: &'static str,
}

impl Drop for TemporaryDirectoryCleanup {
    fn drop(&mut self) {
        if self
            .directory
            .parent()
            .is_some_and(|parent| paths_equal(parent, &self.required_parent))
            && self
                .directory
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with(self.required_prefix))
        {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

fn utf16_name(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let trim = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_owned()
    };
    trim(left).eq_ignore_ascii_case(&trim(right))
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_runtime_win::{InstanceAcquireResult, InstanceSignal};
    use std::cell::Cell;

    #[test]
    fn acl_contract_keeps_root_traversable_but_protected_files_non_writable() {
        let sid = "S-1-5-21-123-456-789-1001";
        let root = root_acl_sddl(sid);
        assert!(root.contains("0x1200af"));
        assert!(!root.contains("0x1301bf;;;S-"));
        assert!(root.contains("OICIIO"));

        let writable = writable_file_acl_sddl(sid);
        assert!(writable.contains("0x1301bf"));
        let protected = protected_file_acl_sddl(sid);
        assert!(protected.contains("0x1200a9"));
        assert!(protected.contains("D;;GWSD"));
        assert!(!protected.contains("0x1301bf"));
    }

    #[test]
    fn applied_root_acl_is_observable_through_named_security_info() {
        let root = test_transaction_directory("acl-query");
        fs::create_dir_all(&root).expect("acl root");
        let sid = match token_sid(unsafe { GetCurrentProcess() }) {
            Ok(sid) => sid,
            Err(()) => {
                fs::remove_dir_all(&root).expect("acl cleanup");
                return;
            }
        };
        if apply_installation_acl(&root, &sid).is_err() {
            fs::remove_dir_all(&root).expect("acl cleanup");
            return;
        }
        let masks = named_dacl_masks(&root).expect("named dacl");
        assert!(masks.iter().any(|(_, mask)| *mask == 0x1200af));
        assert!(
            masks
                .iter()
                .filter(|(_, mask)| *mask == 0x1301bf)
                .all(|(flags, _)| *flags & 0x08 != 0)
        );
        fs::remove_dir_all(&root).expect("acl cleanup");
    }

    #[test]
    fn install_root_boundary_rejects_disk_root_and_protected_roots() {
        let drive = std::env::var_os("SystemDrive")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:"));
        let drive_root = PathBuf::from(format!(
            "{}\\",
            drive.to_string_lossy().trim_end_matches(['\\', '/'])
        ));
        assert_eq!(
            validate_install_root(&drive_root, false)
                .expect_err("disk root must be refused")
                .code(),
            "bootstrap_install_root_invalid"
        );
        let windows = std::env::var_os("WINDIR").map(PathBuf::from);
        if let Some(windows) = windows {
            assert_eq!(
                validate_install_root(&windows, false)
                    .expect_err("Windows root must be refused")
                    .code(),
                "bootstrap_install_root_invalid"
            );
        }
    }

    #[test]
    fn existing_registered_layout_does_not_require_new_uninstall_helper() {
        let root = test_transaction_directory("legacy-registration");
        fs::create_dir_all(root.join("versions")).expect("versions");
        fs::write(root.join(LAUNCHER_FILE_NAME), b"launcher").expect("launcher");
        fs::write(root.join(POINTER_FILE_NAME), b"{}").expect("pointer");
        assert!(is_valid_registered_installation(&root));
        assert!(!root.join(UNINSTALL_HELPER_FILE_NAME).exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn protected_directory_checks_are_case_insensitive_and_boundary_aware() {
        assert!(path_starts_with_case_insensitive(
            Path::new(r"C:\WINDOWS\System32\AURUM"),
            Path::new(r"c:\windows")
        ));
        assert!(!path_starts_with_case_insensitive(
            Path::new(r"C:\Windows.old\AURUM"),
            Path::new(r"C:\Windows")
        ));
    }

    #[test]
    fn running_bridge_is_signalled_and_waited_before_installation_continues() {
        let probe_count = Cell::new(0_u32);
        let signalled = Cell::new(false);
        let waited = Cell::new(false);

        stop_running_bridge_with(
            || {
                let count = probe_count.get();
                probe_count.set(count + 1);
                Ok(count == 0)
            },
            || {
                signalled.set(true);
                Ok(())
            },
            |timeout| {
                waited.set(true);
                assert_eq!(timeout, BRIDGE_SHUTDOWN_TIMEOUT);
                Ok(true)
            },
            BRIDGE_SHUTDOWN_TIMEOUT,
        )
        .expect("running Bridge should stop cooperatively");

        assert!(signalled.get());
        assert!(waited.get());
        assert_eq!(probe_count.get(), 2);
    }

    #[test]
    fn stopped_bridge_does_not_receive_a_shutdown_signal() {
        stop_running_bridge_with(
            || Ok(false),
            || panic!("stopped Bridge must not be signalled"),
            |_| panic!("stopped Bridge must not be awaited"),
            BRIDGE_SHUTDOWN_TIMEOUT,
        )
        .expect("stopped Bridge should not block installation");
    }

    #[test]
    fn installer_fails_closed_when_bridge_does_not_exit() {
        let error = stop_running_bridge_with(
            || Ok(true),
            || Ok(()),
            |_| Ok(false),
            BRIDGE_SHUTDOWN_TIMEOUT,
        )
        .expect_err("an unresponsive Bridge must block file replacement");

        assert_eq!(error.code(), "bootstrap_running_process_stop_timeout");
    }

    #[test]
    fn only_current_bridge_runtime_lock_names_are_signalled() {
        for instance_id in [
            "AURUMBridge.v3",
            "AURUMBridge.v3.ui",
            "AURUMBridge.v3.profile.source-1",
            "AURUMBridge.v3.profile.source-1.ui",
        ] {
            assert!(is_bridge_runtime_instance_id(instance_id), "{instance_id}");
        }
        for instance_id in [
            "AURUMBridge.v2",
            "AURUMBridge.v3.profile.",
            "AURUMBridge.v3.profile.source.1",
            "unrelated",
        ] {
            assert!(!is_bridge_runtime_instance_id(instance_id), "{instance_id}");
        }
    }

    #[test]
    fn discovered_profile_lock_receives_the_real_shutdown_event() {
        let root = std::env::temp_dir().join(format!(
            "liangjian-installer-shutdown-{}-{}",
            process::id(),
            timestamp_nanos()
        ));
        fs::create_dir_all(&root).expect("lock directory");
        let profile = format!("test{}{}", process::id(), timestamp_nanos() % 1_000_000);
        let instance_id = format!("AURUMBridge.v3.profile.{profile}");
        let instance = match SingleInstanceGuard::try_acquire(&instance_id, &root, false)
            .expect("instance guard")
        {
            InstanceAcquireResult::Acquired(instance) => instance,
            InstanceAcquireResult::Duplicate => panic!("unique test instance must be acquired"),
        };

        request_bridge_shutdown_in(&root).expect("installer shutdown request");
        assert_eq!(
            instance
                .wait_for_signal(Duration::from_secs(1))
                .expect("shutdown event"),
            InstanceSignal::Shutdown
        );

        drop(instance);
        fs::remove_dir_all(root).expect("lock cleanup");
    }

    #[test]
    fn same_version_persistence_failure_restores_root_files_before_version_rollback() {
        let root = test_transaction_directory("same-version");
        let versions = root.join("versions");
        let source = root.join("operation").join("version");
        fs::create_dir_all(&versions).expect("versions");
        fs::create_dir_all(&source).expect("source");
        fs::create_dir_all(versions.join("3.0.0")).expect("old version");
        fs::write(versions.join("3.0.0/old.txt"), b"old version").expect("old version file");
        fs::write(source.join("AURUMBridge.exe"), b"new version").expect("new version");
        fs::write(source.join(RELEASE_MARKER_FILE_NAME), b"marker").expect("marker");
        let old_files = [
            (LAUNCHER_FILE_NAME, b"old launcher".as_slice()),
            (PUBLIC_KEY_FILE_NAME, b"old key".as_slice()),
            (ROLLOUT_CHANNEL_FILE_NAME, b"old channel".as_slice()),
            (POINTER_FILE_NAME, b"old pointer".as_slice()),
        ];
        for (name, payload) in old_files {
            fs::write(root.join(name), payload).expect("old root file");
        }
        let transaction = RootFileTransaction::capture(&root).expect("root transaction");
        let protected = HashSet::from(["3.0.0".to_owned()]);
        let validate = |_: &Path| Ok(());
        let receipt = publish_release(ReleasePublishRequest {
            versions_root: &versions,
            source_directory: &source,
            destination_version: "3.0.0",
            protected_versions: &protected,
            mode: ReleasePublishMode::SameVersionRepair,
            io_error_code: "bootstrap_io_failed",
            repair_restore_error_code: "bootstrap_repair_restore_failed",
            validate_layout: &validate,
        })
        .expect("publish");
        for name in ROOT_TRANSACTION_FILE_NAMES {
            fs::write(root.join(name), b"new root state").expect("new root state");
        }

        transaction.rollback().expect("root rollback");
        receipt.rollback().expect("version rollback");
        transaction.commit();
        for (name, payload) in old_files {
            assert_eq!(
                fs::read(root.join(name)).expect("restored root file"),
                payload
            );
        }
        assert_eq!(
            fs::read(versions.join("3.0.0/old.txt")).expect("restored version"),
            b"old version"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn first_install_persistence_failure_removes_new_root_files_and_version() {
        let root = test_transaction_directory("first-install");
        let versions = root.join("versions");
        let source = root.join("operation").join("version");
        fs::create_dir_all(&versions).expect("versions");
        fs::create_dir_all(&source).expect("source");
        fs::write(source.join("AURUMBridge.exe"), b"new version").expect("new version");
        fs::write(source.join(RELEASE_MARKER_FILE_NAME), b"marker").expect("marker");
        let transaction = RootFileTransaction::capture(&root).expect("root transaction");
        let protected = HashSet::new();
        let validate = |_: &Path| Ok(());
        let receipt = publish_release(ReleasePublishRequest {
            versions_root: &versions,
            source_directory: &source,
            destination_version: "3.0.0",
            protected_versions: &protected,
            mode: ReleasePublishMode::NewVersion,
            io_error_code: "bootstrap_io_failed",
            repair_restore_error_code: "bootstrap_repair_restore_failed",
            validate_layout: &validate,
        })
        .expect("publish");
        for name in ROOT_TRANSACTION_FILE_NAMES {
            fs::write(root.join(name), b"new root state").expect("new root state");
        }

        transaction.rollback().expect("root rollback");
        receipt.rollback().expect("version rollback");
        transaction.commit();
        for name in ROOT_TRANSACTION_FILE_NAMES {
            assert!(!root.join(name).exists(), "new root file remains: {name}");
        }
        assert!(!versions.join("3.0.0").exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn test_transaction_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-installer-transaction-{}-{}-{label}",
            process::id(),
            timestamp_nanos()
        ))
    }
}
