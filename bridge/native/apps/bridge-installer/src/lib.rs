use bridge_update::{
    InstallationIdentityStore, ReleaseActivationStore, ReleaseManifest, ReleaseManifestClient,
    ReleaseManifestVerifier, ReleasePackage, ReleasePackageStager, extract_verified_package,
    validate_native_release_layout, validate_release_package_compatibility, verified_expanded_size,
    verify_package_file,
};
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use url::{Host, Url};
use windows_registry::CURRENT_USER;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_WRITE_THROUGH, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::CreateMutexW;
use windows_sys::Win32::UI::Shell::{CSIDL_LOCAL_APPDATA, SHGFP_TYPE_CURRENT, SHGetFolderPathW};

const LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
const RELEASE_MARKER_FILE_NAME: &str = ".aurum-release.json";
const PUBLIC_KEY_FILE_NAME: &str = "release-public-key.pem";
const ROLLOUT_CHANNEL_FILE_NAME: &str = "rollout-channel";
const POINTER_FILE_NAME: &str = "current.json";
const UNINSTALL_KEY_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\LiangjianBridge";
const MAXIMUM_MANIFEST_BYTES: u64 = 128 * 1024;
const MAXIMUM_TOTAL_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const REQUIRED_MODULES: [&str; 3] = ["core", "adapter.mt5.python", "adapter.mt4"];
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const BOOTSTRAP_MANIFEST_PATH: &str = "/api/bridge/v3/releases/bootstrap";

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
        let install_root = std::path::absolute(&self.install_root)
            .map_err(|_| InstallerError::new("bootstrap_install_root_invalid"))?;
        if self.public_key_pem.trim().is_empty()
            || self.public_key_pem.len() > 16 * 1024
            || !matches!(self.target_environment.as_str(), "test" | "production")
            || self.launcher_version.trim().is_empty()
            || install_root.file_name().is_none()
            || (self.rehearsal && self.target_environment != "test")
            || (self.rehearsal && paths_equal(&install_root, &default_install_root()?))
            || (!self.rehearsal && !paths_equal(&install_root, &default_install_root()?))
        {
            return Err(InstallerError::new("bootstrap_configuration_invalid"));
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
        if !self.configuration.rehearsal && bridge_processes_running()? {
            return Err(InstallerError::new("bootstrap_running_process_detected"));
        }

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

        let installed_version =
            install_version(install_root, &version_directory, &manifest.release_version)?;
        let packaged_launcher = installed_version.join("launcher").join(LAUNCHER_FILE_NAME);
        if !packaged_launcher.is_file() {
            return Err(InstallerError::new("bootstrap_native_launcher_missing"));
        }
        copy_file_atomically(&packaged_launcher, &install_root.join(LAUNCHER_FILE_NAME))?;
        write_file_atomically(
            &install_root.join(PUBLIC_KEY_FILE_NAME),
            self.configuration.public_key_pem.as_bytes(),
        )?;
        write_file_atomically(&install_root.join(ROLLOUT_CHANNEL_FILE_NAME), b"stable")?;
        ReleaseActivationStore::new(install_root.join(POINTER_FILE_NAME))
            .map_err(|error| InstallerError::new(error.code()))?
            .initialize_healthy(&manifest.release_version, now_utc_msc())
            .map_err(|error| InstallerError::new(error.code()))?;
        if !self.configuration.rehearsal {
            register_installation(
                install_root,
                &manifest.release_version,
                directory_size(install_root)?,
            )?;
        }
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
        if !self.configuration.rehearsal && bridge_processes_running()? {
            return Err(InstallerError::new("bootstrap_running_process_detected"));
        }
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
    let mut buffer = [0_u16; 260];
    let result = unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            CSIDL_LOCAL_APPDATA as i32,
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
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length]))
        .join("AURUM")
        .join("LiangjianBridge"))
}

pub fn write_failure_log(error: InstallerError) {
    let Ok(root) = default_install_root() else {
        return;
    };
    let logs = root.join("logs");
    if fs::create_dir_all(&logs).is_err() {
        return;
    }
    let payload = format!("{}\r\n{}\r\n", now_utc_msc(), error.code());
    let _ = fs::write(logs.join("installer-last-error.log"), payload.as_bytes());
}

pub fn describe_installer_error(error: InstallerError) -> &'static str {
    match error.code() {
        "bootstrap_running_process_detected" => "请先退出正在运行的量见智桥，再重新安装。",
        "bootstrap_installation_in_progress" => "另一个安装程序正在运行，请稍后重试。",
        "bootstrap_release_unavailable" => "当前没有可用于首次安装的稳定版本，请稍后重试。",
        "update_manifest_signature_invalid" | "update_package_signature_invalid" => {
            "安装包安全校验失败，已停止安装。"
        }
        "update_package_integrity_failed" | "update_package_size_mismatch" => {
            "安装包下载不完整，请检查网络后重试。"
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
) -> Result<PathBuf, InstallerError> {
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
    if destination.exists() {
        let metadata = fs::symlink_metadata(&destination)
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(InstallerError::new("bootstrap_version_path_invalid"));
        }
        let backup = versions.join(format!(
            ".repair-backup-{version}-{}-{}",
            timestamp_nanos(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::rename(&destination, &backup)
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        let replacement = fs::rename(source, &destination)
            .map_err(|_| InstallerError::new("bootstrap_io_failed"))
            .and_then(|()| {
                validate_native_release_layout(&destination)
                    .map_err(|error| InstallerError::new(error.code()))
            });
        if let Err(error) = replacement {
            if destination.exists() {
                let _ = fs::remove_dir_all(&destination);
            }
            let _ = fs::rename(&backup, &destination);
            return Err(error);
        }
        fs::remove_dir_all(&backup).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
    } else {
        fs::rename(source, &destination).map_err(|_| InstallerError::new("bootstrap_io_failed"))?;
        if let Err(error) = validate_native_release_layout(&destination) {
            let _ = fs::remove_dir_all(&destination);
            return Err(InstallerError::new(error.code()));
        }
    }
    Ok(destination)
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

fn register_installation(
    install_root: &Path,
    version: &str,
    estimated_size_bytes: u64,
) -> Result<(), InstallerError> {
    if !paths_equal(install_root, &default_install_root()?) {
        return Err(InstallerError::new(
            "bridge_installation_registration_invalid",
        ));
    }
    let launcher = install_root.join(LAUNCHER_FILE_NAME);
    if !launcher.is_file() {
        return Err(InstallerError::new("bridge_launcher_missing"));
    }
    let launcher_text = launcher.to_string_lossy();
    let install_text = install_root.to_string_lossy();
    let uninstall = format!("\"{launcher_text}\" --uninstall");
    let key = CURRENT_USER
        .create(UNINSTALL_KEY_PATH)
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
        .map_err(|_| InstallerError::new("bridge_uninstall_registry_unavailable"))
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
