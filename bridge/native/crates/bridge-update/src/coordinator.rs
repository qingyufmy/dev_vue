use crate::activation::ReleaseActivationStore;
use crate::manifest::DotNetVersion;
use crate::release_publish::{ReleasePublishMode, ReleasePublishRequest, publish_release};
use crate::{
    BridgeUpdateState, BridgeUpdateStateStore, ReleaseManifest, ReleaseManifestClient,
    ReleaseManifestVerifier, ReleasePackageStager, STATE_ACQUIRING_LEASE, STATE_ACTIVATING,
    STATE_CHECKING, STATE_DOWNLOADING, STATE_DRAINING, STATE_FAILED, STATE_ROLLED_BACK,
    STATE_WAITING_WINDOW, UpdateError, discard_unpublished_release, extract_verified_package,
    verified_expanded_size, verify_extracted_package, verify_package_file,
};
use reqwest::Client;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_WRITE_THROUGH, GetDiskFreeSpaceExW, GetFileVersionInfoSizeW, GetFileVersionInfoW,
    VS_FIXEDFILEINFO, VerQueryValueW,
};

pub const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(15 * 60);
const RELEASE_MARKER_FILE_NAME: &str = ".aurum-release.json";
const PUBLIC_KEY_FILE_NAME: &str = "release-public-key.pem";
const LAUNCHER_FILE_NAME: &str = "AURUMBridge.Launcher.exe";
const VERSION_POINTER_FILE_NAME: &str = "current.json";
const INSTALLATION_ID_FILE_NAME: &str = "installation-id";
const RELEASE_CHANNEL_FILE_NAME: &str = "release-channel";
const MAXIMUM_PUBLIC_KEY_BYTES: u64 = 16 * 1024;
const MAXIMUM_IDENTITY_BYTES: u64 = 1024;
const DISK_SAFETY_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
const ESTIMATED_EXPANSION_MULTIPLIER: u64 = 4;
const REQUIRED_PACKAGE_IDS: [&str; 3] = ["core", "adapter.mt5.python", "adapter.mt4"];
const REQUIRED_CORE_FILES: [&str; 5] = [
    "AURUMBridge.exe",
    "AURUMBridge.Core.exe",
    "launcher/AURUMBridge.Launcher.exe",
    "server-endpoints.json",
    "runtime/python/python.exe",
];
const REJECTED_LEGACY_CORE_FILES: [&str; 7] = [
    "AURUMBridge.dll",
    "AURUMBridge.deps.json",
    "AURUMBridge.runtimeconfig.json",
    "hostfxr.dll",
    "coreclr.dll",
    "e_sqlite3.dll",
    "Microsoft.Data.Sqlite.dll",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeUpdateEnvironment {
    pub install_root: PathBuf,
    pub application_directory: PathBuf,
    pub current_version: String,
    pub launcher_version: String,
    pub state_path: PathBuf,
}

impl BridgeUpdateEnvironment {
    pub fn resolve(application_directory: impl AsRef<Path>) -> Result<Option<Self>, UpdateError> {
        let application_directory = std::path::absolute(application_directory.as_ref())
            .map_err(|_| UpdateError::new("update_environment_path_invalid"))?;
        let Some(version) = application_directory
            .file_name()
            .and_then(|value| value.to_str())
        else {
            return Ok(None);
        };
        if DotNetVersion::parse(version).is_none() {
            return Ok(None);
        }
        let version = version.to_owned();
        let Some(versions_directory) = application_directory.parent() else {
            return Ok(None);
        };
        if !versions_directory
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("versions"))
        {
            return Ok(None);
        }
        let Some(install_root) = versions_directory.parent() else {
            return Ok(None);
        };
        let install_root = install_root.to_path_buf();
        let launcher = install_root.join(LAUNCHER_FILE_NAME);
        if !launcher.is_file()
            || !install_root.join(PUBLIC_KEY_FILE_NAME).is_file()
            || !install_root.join(VERSION_POINTER_FILE_NAME).is_file()
        {
            return Ok(None);
        }
        Ok(Some(Self {
            install_root: install_root.clone(),
            application_directory,
            current_version: version,
            launcher_version: read_file_version(&launcher)?,
            state_path: install_root.join(crate::UPDATE_STATE_FILE_NAME),
        }))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedRelease {
    pub version: String,
    pub version_directory: PathBuf,
    pub release_id: Option<String>,
    pub priority: String,
    pub minimum_idle_seconds: u32,
    pub activation_deadline_utc_msc: Option<i64>,
}

pub struct BridgeUpdateCoordinator {
    environment: BridgeUpdateEnvironment,
    verifier: ReleaseManifestVerifier,
    state_store: BridgeUpdateStateStore,
    activation_store: ReleaseActivationStore,
    package_stager: ReleasePackageStager,
    http_client: Client,
    manifest_client: Option<(Url, ReleaseManifestClient)>,
    installation_id: String,
    rollout_channel: String,
}

impl BridgeUpdateCoordinator {
    pub fn create_if_installed(
        application_directory: impl AsRef<Path>,
        state_store: BridgeUpdateStateStore,
    ) -> Result<Option<Self>, UpdateError> {
        let Some(environment) = BridgeUpdateEnvironment::resolve(application_directory)? else {
            return Ok(None);
        };
        if state_store.path() != environment.state_path {
            return Err(UpdateError::new("update_state_path_mismatch"));
        }
        let public_key_path = environment.install_root.join(PUBLIC_KEY_FILE_NAME);
        let metadata = fs::metadata(&public_key_path)
            .map_err(|_| UpdateError::new("update_public_key_invalid"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_PUBLIC_KEY_BYTES {
            return Err(UpdateError::new("update_public_key_invalid"));
        }
        let public_key = fs::read_to_string(public_key_path)
            .map_err(|_| UpdateError::new("update_public_key_invalid"))?;
        let verifier = ReleaseManifestVerifier::new(&public_key)?;
        let http_client = Client::builder()
            .tls_backend_rustls()
            .timeout(Duration::from_secs(5 * 60))
            .build()
            .map_err(|_| UpdateError::new("update_http_client_failed"))?;
        let package_stager = ReleasePackageStager::new(
            http_client.clone(),
            environment.install_root.join("cache").join("packages"),
        )?;
        let installation_id = InstallationIdentityStore::new(
            environment.install_root.join(INSTALLATION_ID_FILE_NAME),
        )?
        .load_or_create()?;
        let rollout_channel = read_rollout_channel(&environment.install_root)?;
        let activation_store =
            ReleaseActivationStore::new(environment.install_root.join(VERSION_POINTER_FILE_NAME))?;
        let coordinator = Self {
            environment,
            verifier,
            state_store,
            activation_store,
            package_stager,
            http_client,
            manifest_client: None,
            installation_id,
            rollout_channel,
        };
        // Storage cleanup is deliberately best-effort: a locked diagnostic or
        // cache file must never prevent the Bridge from starting.
        let _ = coordinator.prune_release_storage();
        Ok(Some(coordinator))
    }

    #[cfg(test)]
    fn for_test(
        environment: BridgeUpdateEnvironment,
        verifier: ReleaseManifestVerifier,
        state_store: BridgeUpdateStateStore,
        http_client: Client,
        installation_id: String,
    ) -> Result<Self, UpdateError> {
        let package_stager = ReleasePackageStager::new(
            http_client.clone(),
            environment.install_root.join("cache").join("packages"),
        )?;
        let activation_store =
            ReleaseActivationStore::new(environment.install_root.join(VERSION_POINTER_FILE_NAME))?;
        Ok(Self {
            environment,
            verifier,
            state_store,
            activation_store,
            package_stager,
            http_client,
            manifest_client: None,
            installation_id,
            rollout_channel: "stable".to_owned(),
        })
    }

    pub fn environment(&self) -> &BridgeUpdateEnvironment {
        &self.environment
    }

    pub fn installation_id(&self) -> &str {
        &self.installation_id
    }

    pub fn load_state(&self) -> Result<Option<BridgeUpdateState>, UpdateError> {
        self.state_store.load()
    }

    pub fn restore_staged_release(&self) -> Result<Option<StagedRelease>, UpdateError> {
        let Some(state) = self.state_store.load()? else {
            return Ok(None);
        };
        if !matches!(
            state.state.as_str(),
            STATE_WAITING_WINDOW | STATE_ACQUIRING_LEASE | STATE_DRAINING | STATE_ACTIVATING
        ) {
            return Ok(None);
        }
        let target_version = state
            .target_version
            .as_deref()
            .ok_or_else(|| UpdateError::new("update_staged_release_state_mismatch"))?;
        let current = DotNetVersion::parse(&self.environment.current_version)
            .ok_or_else(|| UpdateError::new("update_current_version_invalid"))?;
        let target = DotNetVersion::parse(target_version)
            .ok_or_else(|| UpdateError::new("update_release_version_invalid"))?;
        if target <= current {
            return Err(UpdateError::new("update_staged_release_invalid"));
        }
        let directory = self
            .environment
            .install_root
            .join("versions")
            .join(target_version);
        let marker_path = directory.join(RELEASE_MARKER_FILE_NAME);
        let marker_metadata = fs::metadata(&marker_path)
            .map_err(|_| UpdateError::new("update_staged_release_missing"))?;
        if !marker_metadata.is_file()
            || marker_metadata.len() == 0
            || marker_metadata.len() > 128 * 1024
        {
            return Err(UpdateError::new("update_staged_release_invalid"));
        }
        let marker =
            fs::read(marker_path).map_err(|_| UpdateError::new("update_staged_release_missing"))?;
        let manifest = serde_json::from_slice::<ReleaseManifest>(&marker)
            .map_err(|_| UpdateError::new("update_staged_release_invalid"))?;
        self.verifier
            .verify(&manifest, &self.environment.launcher_version)?;
        let priority = manifest
            .priority
            .clone()
            .unwrap_or_else(|| "normal".to_owned());
        if manifest.release_version != target_version
            || manifest.release_id != state.release_id
            || state.priority.as_deref() != Some(priority.as_str())
            || manifest.minimum_idle_seconds.unwrap_or(120) != state.minimum_idle_seconds
            || manifest.activation_deadline_utc_msc != state.activation_deadline_utc_msc
        {
            return Err(UpdateError::new("update_staged_release_state_mismatch"));
        }
        validate_existing_release(&directory, &manifest)?;
        self.verify_staged_release_contents(&directory, &manifest)?;
        Ok(Some(describe_staged_release(&manifest, directory)))
    }

    pub fn abandon_invalid_staged_release(
        &self,
        state: &BridgeUpdateState,
        error_code: &str,
    ) -> Result<bool, UpdateError> {
        let target_version = state
            .target_version
            .as_deref()
            .ok_or_else(|| UpdateError::new("update_staged_release_state_mismatch"))?;
        let current = DotNetVersion::parse(&self.environment.current_version)
            .ok_or_else(|| UpdateError::new("update_current_version_invalid"))?;
        let target = DotNetVersion::parse(target_version)
            .ok_or_else(|| UpdateError::new("update_release_version_invalid"))?;
        if target <= current {
            return Err(UpdateError::new("update_staged_release_invalid"));
        }
        let pointer = self.activation_store.load()?;
        if pointer.status == "pending" && pointer.active_version == target_version {
            return Ok(false);
        }
        let directory = self
            .environment
            .install_root
            .join("versions")
            .join(target_version);
        if directory.exists() {
            let metadata = fs::symlink_metadata(&directory)
                .map_err(|_| UpdateError::new("update_staged_release_cleanup_failed"))?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.file_attributes() & 0x400 != 0
            {
                return Err(UpdateError::new("update_staged_release_cleanup_boundary"));
            }
            fs::remove_dir_all(&directory)
                .map_err(|_| UpdateError::new("update_staged_release_cleanup_failed"))?;
        }
        self.state_store.save(BridgeUpdateState {
            schema_version: 1,
            state: STATE_FAILED.to_owned(),
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
            last_error_code: Some(error_code.to_owned()),
            updated_at_utc_msc: now_utc_msc(),
        })?;
        Ok(true)
    }

    fn verify_staged_release_contents(
        &self,
        directory: &Path,
        manifest: &ReleaseManifest,
    ) -> Result<(), UpdateError> {
        let mut expected_files = HashSet::new();
        for package in &manifest.packages {
            let archive = self
                .package_stager
                .cache_directory()
                .join(format!("{}.zip", package.sha256.to_ascii_lowercase()));
            let relative_root = if package.module_id == "core" {
                PathBuf::new()
            } else {
                PathBuf::from("modules").join(&package.module_id)
            };
            let destination = directory.join(&relative_root);
            for relative_file in verify_extracted_package(package, archive, destination)? {
                if !expected_files.insert(relative_root.join(relative_file)) {
                    return Err(UpdateError::new("update_staged_release_integrity_failed"));
                }
            }
        }
        let mut actual_files = HashSet::new();
        collect_staged_files(directory, directory, &mut actual_files)?;
        actual_files.remove(Path::new(RELEASE_MARKER_FILE_NAME));
        if actual_files != expected_files {
            return Err(UpdateError::new("update_staged_release_integrity_failed"));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_activation_phase(
        &self,
        staged: &StagedRelease,
        phase: &str,
        manual_activation_requested: bool,
        lease_id: Option<String>,
        lease_expires_at_utc_msc: Option<i64>,
        next_retry_at_utc_msc: Option<i64>,
        last_error_code: Option<String>,
    ) -> Result<BridgeUpdateState, UpdateError> {
        if !matches!(
            phase,
            STATE_WAITING_WINDOW | STATE_ACQUIRING_LEASE | STATE_DRAINING | STATE_ACTIVATING
        ) {
            return Err(UpdateError::new("update_activation_phase_invalid"));
        }
        let previous = self.state_store.load()?;
        let now = now_utc_msc();
        let same_release = previous
            .as_ref()
            .is_some_and(|state| state.target_version.as_deref() == Some(staged.version.as_str()));
        let staged_at_utc_msc = if same_release {
            previous
                .as_ref()
                .and_then(|state| state.staged_at_utc_msc)
                .or(Some(now))
        } else {
            Some(now)
        };
        let activation_started_at_utc_msc = if phase == STATE_WAITING_WINDOW {
            None
        } else if same_release
            && previous
                .as_ref()
                .is_some_and(|state| state.state != STATE_WAITING_WINDOW)
        {
            previous
                .as_ref()
                .and_then(|state| state.activation_started_at_utc_msc)
                .or(Some(now))
        } else {
            Some(now)
        };
        self.state_store.save(BridgeUpdateState {
            schema_version: 1,
            state: phase.to_owned(),
            target_version: Some(staged.version.clone()),
            release_id: staged.release_id.clone(),
            priority: Some(staged.priority.clone()),
            manual_activation_requested: manual_activation_requested
                || previous
                    .as_ref()
                    .is_some_and(|state| state.manual_activation_requested),
            staged_at_utc_msc,
            activation_started_at_utc_msc,
            minimum_idle_seconds: staged.minimum_idle_seconds,
            activation_deadline_utc_msc: staged.activation_deadline_utc_msc,
            maintenance_lease_id: lease_id,
            maintenance_lease_expires_at_utc_msc: lease_expires_at_utc_msc,
            next_retry_at_utc_msc,
            last_error_code,
            updated_at_utc_msc: now,
        })
    }

    pub fn prepare_activation(
        &self,
        staged: &StagedRelease,
        expected_terminal_instance_ids: &[String],
    ) -> Result<(), UpdateError> {
        self.activation_store.prepare(
            staged,
            &self.environment.current_version,
            expected_terminal_instance_ids,
            now_utc_msc(),
        )
    }

    pub async fn check_and_stage(
        &mut self,
        server_base: Url,
    ) -> Result<Option<StagedRelease>, UpdateError> {
        let result = self.check_and_stage_inner(server_base).await;
        if let Err(error) = result {
            self.try_record_failure(error.code());
        }
        result
    }

    async fn check_and_stage_inner(
        &mut self,
        server_base: Url,
    ) -> Result<Option<StagedRelease>, UpdateError> {
        let previous = self.state_store.load()?;
        if self
            .manifest_client
            .as_ref()
            .is_none_or(|(base, _)| base != &server_base)
        {
            self.manifest_client = Some((
                server_base.clone(),
                ReleaseManifestClient::new(server_base, self.http_client.clone())?,
            ));
        }
        let manifest = self
            .manifest_client
            .as_mut()
            .ok_or_else(|| UpdateError::new("update_manifest_client_missing"))?
            .1
            .fetch_verified(
                &self.verifier,
                &self.environment.launcher_version,
                &self.installation_id,
                &self.rollout_channel,
            )
            .await?;
        let Some(manifest) = manifest else {
            if previous
                .as_ref()
                .is_none_or(|state| state.state != STATE_ROLLED_BACK)
            {
                self.save_checking()?;
            }
            return Ok(None);
        };
        let current = DotNetVersion::parse(&self.environment.current_version)
            .ok_or_else(|| UpdateError::new("update_current_version_invalid"))?;
        let target = DotNetVersion::parse(&manifest.release_version)
            .ok_or_else(|| UpdateError::new("update_release_version_invalid"))?;
        if target <= current {
            self.save_checking()?;
            return Ok(None);
        }
        validate_package_set(&manifest, target)?;
        let same_release = previous.as_ref().is_some_and(|state| {
            state.target_version.as_deref() == Some(manifest.release_version.as_str())
                && state.release_id == manifest.release_id
        });
        if same_release
            && previous
                .as_ref()
                .is_some_and(|state| state.state == STATE_ROLLED_BACK)
        {
            return Ok(None);
        }
        let manual_activation_requested = same_release
            && previous
                .as_ref()
                .is_some_and(|state| state.manual_activation_requested);
        if !(same_release
            && previous
                .as_ref()
                .is_some_and(|state| state.state == STATE_WAITING_WINDOW))
        {
            self.state_store.save(state_for_manifest(
                STATE_DOWNLOADING,
                &manifest,
                manual_activation_requested,
                previous.as_ref().and_then(|state| state.staged_at_utc_msc),
            ))?;
        }
        let staged = self.stage_manifest(&manifest).await?;
        let staged_at = if same_release {
            previous
                .as_ref()
                .and_then(|state| state.staged_at_utc_msc)
                .unwrap_or_else(now_utc_msc)
        } else {
            now_utc_msc()
        };
        self.state_store.save(state_for_manifest(
            STATE_WAITING_WINDOW,
            &manifest,
            manual_activation_requested,
            Some(staged_at),
        ))?;
        let _ = self.prune_release_storage();
        Ok(Some(staged))
    }

    fn prune_release_storage(&self) -> Result<ReleaseStoragePruneReport, UpdateError> {
        let pointer = self.activation_store.load()?;
        let mut protected_versions = HashSet::from([
            self.environment.current_version.clone(),
            pointer.active_version,
            pointer.last_known_good_version,
        ]);
        if let Some(target) = self
            .state_store
            .load()?
            .and_then(|state| state.target_version)
        {
            protected_versions.insert(target);
        }
        Ok(prune_release_storage(
            &self.environment.install_root,
            &protected_versions,
        ))
    }

    async fn stage_manifest(
        &self,
        manifest: &ReleaseManifest,
    ) -> Result<StagedRelease, UpdateError> {
        let versions_root = self.environment.install_root.join("versions");
        fs::create_dir_all(&versions_root)
            .map_err(|_| UpdateError::new("update_staging_create_failed"))?;
        let final_directory = versions_root.join(&manifest.release_version);
        let pointer = self.activation_store.load()?;
        let protected_versions = HashSet::from([
            self.environment.current_version.clone(),
            pointer.active_version,
            pointer.last_known_good_version,
        ]);
        if final_directory.exists() {
            match validate_existing_release(&final_directory, manifest) {
                Ok(()) => return Ok(describe_staged_release(manifest, final_directory)),
                Err(error) if error.code() == "update_version_already_exists" => {
                    return Err(error);
                }
                Err(error) => {
                    let discarded = discard_unpublished_release(
                        &versions_root,
                        &manifest.release_version,
                        &protected_versions,
                        "update_staged_release_cleanup_failed",
                    )
                    .map_err(|cleanup_error| {
                        eprintln!(
                            "native_update_staged_release_cleanup_failed code={} {}",
                            cleanup_error.code(),
                            cleanup_error.diagnostic_line()
                        );
                        UpdateError::new(cleanup_error.code())
                    })?;
                    if !discarded {
                        return Err(error);
                    }
                }
            }
        }
        let operation_id = random_hex_16()?;
        let temporary_directory =
            versions_root.join(format!(".{}-{operation_id}.tmp", manifest.release_version));
        let _temporary_cleanup = TemporaryDirectoryCleanup(temporary_directory.clone());
        let result = async {
            let mut archives = BTreeMap::new();
            let mut packages = manifest.packages.iter().collect::<Vec<_>>();
            packages.sort_by_key(|package| {
                (
                    if package.module_id == "core" { 0 } else { 1 },
                    package.module_id.as_str(),
                )
            });
            let mut compressed_bytes = 0_u64;
            let mut missing_download_bytes = 0_u64;
            for package in &packages {
                compressed_bytes = compressed_bytes
                    .checked_add(package.size_bytes)
                    .ok_or_else(|| UpdateError::new("update_required_space_invalid"))?;
                let cache_path = self
                    .package_stager
                    .cache_directory()
                    .join(format!("{}.zip", package.sha256.to_ascii_lowercase()));
                if !verify_package_file(package, cache_path).await? {
                    missing_download_bytes = missing_download_bytes
                        .checked_add(package.size_bytes)
                        .ok_or_else(|| UpdateError::new("update_required_space_invalid"))?;
                }
            }
            let estimated_expanded_bytes = compressed_bytes
                .checked_mul(ESTIMATED_EXPANSION_MULTIPLIER)
                .ok_or_else(|| UpdateError::new("update_required_space_invalid"))?;
            let estimated_required_bytes = missing_download_bytes
                .checked_add(estimated_expanded_bytes)
                .and_then(|value| value.checked_add(DISK_SAFETY_RESERVE_BYTES))
                .ok_or_else(|| UpdateError::new("update_required_space_invalid"))?;
            ensure_available_disk_space(&self.environment.install_root, estimated_required_bytes)?;
            for package in &packages {
                archives.insert(
                    package.module_id.clone(),
                    self.package_stager.download_verified(package).await?,
                );
            }
            let mut expanded_bytes = 0_u64;
            for package in &packages {
                let archive = archives
                    .get(&package.module_id)
                    .ok_or_else(|| UpdateError::new("update_package_cache_missing"))?;
                expanded_bytes = expanded_bytes
                    .checked_add(verified_expanded_size(package, archive)?)
                    .ok_or_else(|| UpdateError::new("update_required_space_invalid"))?;
            }
            let exact_required_bytes = expanded_bytes
                .checked_add(DISK_SAFETY_RESERVE_BYTES)
                .ok_or_else(|| UpdateError::new("update_required_space_invalid"))?;
            ensure_available_disk_space(&self.environment.install_root, exact_required_bytes)?;
            for package in packages {
                let destination = if package.module_id == "core" {
                    temporary_directory.clone()
                } else {
                    let modules = temporary_directory.join("modules");
                    fs::create_dir_all(&modules)
                        .map_err(|_| UpdateError::new("update_staging_create_failed"))?;
                    modules.join(&package.module_id)
                };
                let archive = archives
                    .get(&package.module_id)
                    .cloned()
                    .ok_or_else(|| UpdateError::new("update_package_cache_missing"))?;
                extract_verified_package(package, archive, destination)?;
            }
            validate_native_release_layout(&temporary_directory)?;
            write_release_marker(&temporary_directory, manifest)?;
            let validate_layout = |directory: &Path| {
                validate_native_release_layout(directory).map_err(|error| error.code())
            };
            let receipt = publish_release(ReleasePublishRequest {
                versions_root: &versions_root,
                source_directory: &temporary_directory,
                destination_version: &manifest.release_version,
                protected_versions: &protected_versions,
                mode: ReleasePublishMode::NewVersion,
                io_error_code: "update_version_publish_failed",
                repair_restore_error_code: "update_version_publish_failed",
                validate_layout: &validate_layout,
            })
            .map_err(|error| {
                eprintln!(
                    "native_update_version_publish_failed code={} {}",
                    error.code(),
                    error.diagnostic_line()
                );
                UpdateError::new(error.code())
            })?;
            receipt.commit();
            Ok::<(), UpdateError>(())
        }
        .await;
        result?;
        Ok(describe_staged_release(manifest, final_directory))
    }

    fn save_checking(&self) -> Result<(), UpdateError> {
        self.state_store.save(BridgeUpdateState {
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
            updated_at_utc_msc: now_utc_msc(),
        })?;
        Ok(())
    }

    fn try_record_failure(&self, code: &'static str) {
        let previous = self.state_store.load().ok().flatten();
        if previous
            .as_ref()
            .is_some_and(|state| state.state != STATE_DOWNLOADING)
        {
            return;
        }
        let _ = self.state_store.save(BridgeUpdateState {
            schema_version: 1,
            state: STATE_FAILED.to_owned(),
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
            last_error_code: Some(code.to_owned()),
            updated_at_utc_msc: now_utc_msc(),
        });
    }
}

struct TemporaryDirectoryCleanup(PathBuf);

impl Drop for TemporaryDirectoryCleanup {
    fn drop(&mut self) {
        if self.0.exists() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ReleaseStoragePruneReport {
    versions_removed: usize,
    packages_removed: usize,
    quarantines_removed: usize,
}

fn prune_release_storage(
    install_root: &Path,
    protected_versions: &HashSet<String>,
) -> ReleaseStoragePruneReport {
    let mut report = ReleaseStoragePruneReport::default();
    let versions_root = install_root.join("versions");
    let mut protected_package_hashes = HashSet::new();
    for version in protected_versions {
        let marker = versions_root.join(version).join(RELEASE_MARKER_FILE_NAME);
        let Ok(payload) = fs::read(marker) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<ReleaseManifest>(&payload) else {
            continue;
        };
        if manifest.release_version != *version {
            continue;
        }
        protected_package_hashes.extend(
            manifest
                .packages
                .into_iter()
                .map(|package| package.sha256.to_ascii_lowercase()),
        );
    }

    if let Ok(entries) = fs::read_dir(&versions_root) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if protected_versions.contains(&name) || DotNetVersion::parse(&name).is_none() {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.file_attributes() & 0x400 != 0
            {
                continue;
            }
            if fs::remove_dir_all(entry.path()).is_ok() {
                report.versions_removed += 1;
            }
        }
    }

    let cache_root = install_root.join("cache").join("packages");
    if let Ok(entries) = fs::read_dir(cache_root) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(hash) = name.strip_suffix(".zip") else {
                continue;
            };
            if hash.len() != 64
                || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                || protected_package_hashes.contains(&hash.to_ascii_lowercase())
            {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.file_attributes() & 0x400 != 0
            {
                continue;
            }
            if fs::remove_file(entry.path()).is_ok() {
                report.packages_removed += 1;
            }
        }
    }

    let quarantine_root = install_root.join("quarantine");
    let mut quarantines = fs::read_dir(quarantine_root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.file_attributes() & 0x400 != 0
            {
                return None;
            }
            Some((metadata.modified().unwrap_or(UNIX_EPOCH), entry.path()))
        })
        .collect::<Vec<_>>();
    quarantines.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, path) in quarantines.into_iter().skip(2) {
        if fs::remove_dir_all(path).is_ok() {
            report.quarantines_removed += 1;
        }
    }
    report
}

fn validate_package_set(
    manifest: &ReleaseManifest,
    target: DotNetVersion,
) -> Result<(), UpdateError> {
    let modules = manifest
        .packages
        .iter()
        .map(|package| package.module_id.as_str())
        .collect::<HashSet<_>>();
    if REQUIRED_PACKAGE_IDS
        .iter()
        .any(|required| !modules.contains(required))
    {
        return Err(UpdateError::new("update_required_package_missing"));
    }
    let core = manifest
        .packages
        .iter()
        .find(|package| package.module_id == "core")
        .ok_or_else(|| UpdateError::new("update_core_package_missing"))?;
    if DotNetVersion::parse(&core.version) != Some(target) {
        return Err(UpdateError::new("update_core_version_mismatch"));
    }
    for package in &manifest.packages {
        if package
            .minimum_core_version
            .as_deref()
            .and_then(DotNetVersion::parse)
            .is_some_and(|minimum| target < minimum)
            || package
                .maximum_core_version
                .as_deref()
                .and_then(DotNetVersion::parse)
                .is_some_and(|maximum| target > maximum)
        {
            return Err(UpdateError::new("update_package_core_incompatible"));
        }
    }
    Ok(())
}

pub fn validate_release_package_compatibility(
    manifest: &ReleaseManifest,
) -> Result<(), UpdateError> {
    let target = DotNetVersion::parse(&manifest.release_version)
        .ok_or_else(|| UpdateError::new("update_release_version_invalid"))?;
    validate_package_set(manifest, target)
}

fn state_for_manifest(
    state: &str,
    manifest: &ReleaseManifest,
    manual_activation_requested: bool,
    staged_at_utc_msc: Option<i64>,
) -> BridgeUpdateState {
    BridgeUpdateState {
        schema_version: 1,
        state: state.to_owned(),
        target_version: Some(manifest.release_version.clone()),
        release_id: manifest.release_id.clone(),
        priority: Some(
            manifest
                .priority
                .clone()
                .unwrap_or_else(|| "normal".to_owned()),
        ),
        manual_activation_requested,
        staged_at_utc_msc,
        activation_started_at_utc_msc: None,
        minimum_idle_seconds: manifest.minimum_idle_seconds.unwrap_or(120),
        activation_deadline_utc_msc: manifest.activation_deadline_utc_msc,
        maintenance_lease_id: None,
        maintenance_lease_expires_at_utc_msc: None,
        next_retry_at_utc_msc: None,
        last_error_code: None,
        updated_at_utc_msc: now_utc_msc(),
    }
}

fn describe_staged_release(manifest: &ReleaseManifest, directory: PathBuf) -> StagedRelease {
    StagedRelease {
        version: manifest.release_version.clone(),
        version_directory: directory,
        release_id: manifest.release_id.clone(),
        priority: manifest
            .priority
            .clone()
            .unwrap_or_else(|| "normal".to_owned()),
        minimum_idle_seconds: manifest.minimum_idle_seconds.unwrap_or(120),
        activation_deadline_utc_msc: manifest.activation_deadline_utc_msc,
    }
}

fn validate_existing_release(
    directory: &Path,
    expected: &ReleaseManifest,
) -> Result<(), UpdateError> {
    validate_native_release_layout(directory)?;
    let marker = fs::read(directory.join(RELEASE_MARKER_FILE_NAME))
        .map_err(|_| UpdateError::new("update_staged_release_missing"))?;
    let actual = serde_json::from_slice::<ReleaseManifest>(&marker)
        .map_err(|_| UpdateError::new("update_staged_release_invalid"))?;
    if crate::canonicalize_manifest(&actual)? != crate::canonicalize_manifest(expected)?
        || actual.signature != expected.signature
    {
        return Err(UpdateError::new("update_version_already_exists"));
    }
    Ok(())
}

fn collect_staged_files(
    root: &Path,
    directory: &Path,
    files: &mut HashSet<PathBuf>,
) -> Result<(), UpdateError> {
    for entry in fs::read_dir(directory)
        .map_err(|_| UpdateError::new("update_staged_release_integrity_failed"))?
    {
        let entry =
            entry.map_err(|_| UpdateError::new("update_staged_release_integrity_failed"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| UpdateError::new("update_staged_release_integrity_failed"))?;
        if metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0 {
            return Err(UpdateError::new("update_staged_release_integrity_failed"));
        }
        if metadata.is_dir() {
            collect_staged_files(root, &entry.path(), files)?;
        } else if metadata.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| UpdateError::new("update_staged_release_integrity_failed"))?
                .to_path_buf();
            if !files.insert(relative) {
                return Err(UpdateError::new("update_staged_release_integrity_failed"));
            }
        } else {
            return Err(UpdateError::new("update_staged_release_integrity_failed"));
        }
    }
    Ok(())
}

pub fn validate_native_release_layout(directory: &Path) -> Result<(), UpdateError> {
    if REQUIRED_CORE_FILES
        .iter()
        .any(|path| !directory.join(path).is_file())
        || REJECTED_LEGACY_CORE_FILES
            .iter()
            .any(|path| directory.join(path).is_file())
        || !directory
            .join("modules/adapter.mt5.python/worker.py")
            .is_file()
        || !directory
            .join("modules/adapter.mt5.python/trade.py")
            .is_file()
        || !directory
            .join("modules/adapter.mt4/AURUMBridgeEA.ex4")
            .is_file()
    {
        return Err(UpdateError::new("update_core_component_missing"));
    }
    let endpoint = fs::read(directory.join("server-endpoints.json"))
        .map_err(|_| UpdateError::new("update_server_endpoints_invalid"))?;
    let endpoint = serde_json::from_slice::<Value>(&endpoint)
        .map_err(|_| UpdateError::new("update_server_endpoints_invalid"))?;
    if endpoint.get("schema_version").and_then(Value::as_u64) != Some(1)
        || endpoint.get("server_url").and_then(Value::as_str).is_none()
    {
        return Err(UpdateError::new("update_server_endpoints_invalid"));
    }
    Ok(())
}

fn write_release_marker(directory: &Path, manifest: &ReleaseManifest) -> Result<(), UpdateError> {
    let payload = serde_json::to_vec(manifest)
        .map_err(|_| UpdateError::new("update_staged_release_invalid"))?;
    let mut marker = OpenOptions::new()
        .create_new(true)
        .write(true)
        .custom_flags(FILE_FLAG_WRITE_THROUGH)
        .open(directory.join(RELEASE_MARKER_FILE_NAME))
        .map_err(|_| UpdateError::new("update_staged_release_write_failed"))?;
    marker
        .write_all(&payload)
        .and_then(|()| marker.sync_all())
        .map_err(|_| UpdateError::new("update_staged_release_write_failed"))
}

pub struct InstallationIdentityStore {
    path: PathBuf,
}

impl InstallationIdentityStore {
    pub fn new(path: PathBuf) -> Result<Self, UpdateError> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err(UpdateError::new(
                "bridge_installation_identity_path_invalid",
            ));
        }
        Ok(Self { path })
    }

    pub fn load_or_create(&self) -> Result<String, UpdateError> {
        if let Some(existing) = self.load()? {
            return Ok(existing);
        }
        let identity = format!("install_{}", random_hex_16()?);
        let parent = self
            .path
            .parent()
            .ok_or_else(|| UpdateError::new("bridge_installation_identity_path_invalid"))?;
        fs::create_dir_all(parent)
            .map_err(|_| UpdateError::new("bridge_installation_identity_write_failed"))?;
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(1)
            .custom_flags(FILE_FLAG_WRITE_THROUGH)
            .open(&self.path)
        {
            Ok(mut file) => {
                file.write_all(identity.as_bytes())
                    .and_then(|()| file.sync_all())
                    .map_err(|_| UpdateError::new("bridge_installation_identity_write_failed"))?;
                Ok(identity)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => self
                .load()?
                .ok_or_else(|| UpdateError::new("bridge_installation_identity_invalid")),
            Err(_) => Err(UpdateError::new(
                "bridge_installation_identity_write_failed",
            )),
        }
    }

    fn load(&self) -> Result<Option<String>, UpdateError> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(UpdateError::new("bridge_installation_identity_invalid")),
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAXIMUM_IDENTITY_BYTES {
            return Err(UpdateError::new("bridge_installation_identity_invalid"));
        }
        let identity = fs::read_to_string(&self.path)
            .map_err(|_| UpdateError::new("bridge_installation_identity_invalid"))?;
        let identity = identity.trim().to_owned();
        if identity.len() != 40
            || !identity.starts_with("install_")
            || !identity[8..]
                .bytes()
                .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        {
            return Err(UpdateError::new("bridge_installation_identity_invalid"));
        }
        Ok(Some(identity))
    }
}

fn read_rollout_channel(install_root: &Path) -> Result<String, UpdateError> {
    let path = install_root.join(RELEASE_CHANNEL_FILE_NAME);
    if !path.exists() {
        return Ok("stable".to_owned());
    }
    let metadata =
        fs::metadata(&path).map_err(|_| UpdateError::new("update_rollout_channel_invalid"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 128 {
        return Err(UpdateError::new("update_rollout_channel_invalid"));
    }
    let value =
        fs::read_to_string(path).map_err(|_| UpdateError::new("update_rollout_channel_invalid"))?;
    let value = value.trim().to_ascii_lowercase();
    if matches!(value.as_str(), "internal" | "stable") {
        Ok(value)
    } else {
        Err(UpdateError::new("update_rollout_channel_invalid"))
    }
}

fn random_hex_16() -> Result<String, UpdateError> {
    let mut bytes = [0_u8; 16];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(UpdateError::new("update_random_failed"));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn read_file_version(path: &Path) -> Result<String, UpdateError> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut ignored = 0_u32;
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), &mut ignored) };
    if size == 0 || size > 16 * 1024 * 1024 {
        return Err(UpdateError::new("update_launcher_version_invalid"));
    }
    let mut buffer = vec![0_u8; size as usize];
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr().cast::<c_void>()) }
        == 0
    {
        return Err(UpdateError::new("update_launcher_version_invalid"));
    }
    let root = [b'\\' as u16, 0];
    let mut fixed = null_mut::<c_void>();
    let mut fixed_size = 0_u32;
    if unsafe {
        VerQueryValueW(
            buffer.as_ptr().cast::<c_void>(),
            root.as_ptr(),
            &mut fixed,
            &mut fixed_size,
        )
    } == 0
        || fixed.is_null()
        || fixed_size < std::mem::size_of::<VS_FIXEDFILEINFO>() as u32
    {
        return Err(UpdateError::new("update_launcher_version_invalid"));
    }
    let fixed = unsafe { fixed.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    if fixed.dwSignature != 0xFEEF04BD {
        return Err(UpdateError::new("update_launcher_version_invalid"));
    }
    Ok(format!(
        "{}.{}.{}",
        fixed.dwFileVersionMS >> 16,
        fixed.dwFileVersionMS & 0xffff,
        fixed.dwFileVersionLS >> 16
    ))
}

fn ensure_available_disk_space(path: &Path, required_bytes: u64) -> Result<(), UpdateError> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut available_bytes = 0_u64;
    let result =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available_bytes, null_mut(), null_mut()) };
    if result == 0 {
        return Err(UpdateError::new("update_disk_space_check_failed"));
    }
    if available_bytes < required_bytes {
        return Err(UpdateError::new("update_insufficient_disk_space"));
    }
    Ok(())
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReleasePackage;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::{Signature, SigningKey};
    use p256::pkcs8::{EncodePublicKey as _, LineEnding};
    use sha2::{Digest, Sha256};
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use zip::write::SimpleFileOptions;

    #[test]
    fn release_storage_pruning_preserves_active_artifacts_and_bounds_diagnostics() {
        let root = test_directory("storage-prune");
        for version in ["2.9.0", "3.0.0", "3.0.1"] {
            fs::create_dir_all(root.join("versions").join(version)).expect("version directory");
        }
        let package = package_for_release(
            "core",
            b"protected-package",
            "https://example.test/protected.zip".to_owned(),
        );
        let manifest = ReleaseManifest {
            schema_version: 2,
            release_version: "3.0.0".to_owned(),
            release_id: Some("release-storage-test".to_owned()),
            generated_at_utc_msc: 1,
            published_at_utc_msc: Some(1),
            expires_at_utc_msc: None,
            priority: Some("normal".to_owned()),
            minimum_launcher_version: "1.0.0".to_owned(),
            minimum_idle_seconds: Some(120),
            activation_deadline_utc_msc: None,
            rollout_channel: Some("stable".to_owned()),
            rollout_percentage: Some(100),
            packages: vec![package.clone()],
            signature: "fixture".to_owned(),
        };
        fs::write(
            root.join("versions/3.0.0").join(RELEASE_MARKER_FILE_NAME),
            serde_json::to_vec(&manifest).expect("release marker"),
        )
        .expect("write release marker");
        let cache = root.join("cache/packages");
        fs::create_dir_all(&cache).expect("package cache");
        fs::write(cache.join(format!("{}.zip", package.sha256)), b"protected")
            .expect("protected cache package");
        let unused_hash = "b".repeat(64);
        fs::write(cache.join(format!("{unused_hash}.zip")), b"unused")
            .expect("unused cache package");
        for index in 0..4 {
            fs::create_dir_all(root.join("quarantine").join(format!("invalid-{index}")))
                .expect("quarantine directory");
        }

        let report = prune_release_storage(
            &root,
            &HashSet::from(["3.0.0".to_owned(), "3.0.1".to_owned()]),
        );

        assert_eq!(
            report,
            ReleaseStoragePruneReport {
                versions_removed: 1,
                packages_removed: 1,
                quarantines_removed: 2,
            }
        );
        assert!(root.join("versions/3.0.0").is_dir());
        assert!(root.join("versions/3.0.1").is_dir());
        assert!(!root.join("versions/2.9.0").exists());
        assert!(cache.join(format!("{}.zip", package.sha256)).is_file());
        assert!(!cache.join(format!("{unused_hash}.zip")).exists());
        assert_eq!(
            fs::read_dir(root.join("quarantine"))
                .expect("quarantine")
                .count(),
            2
        );
        fs::remove_dir_all(root).expect("cleanup storage fixture");
    }

    #[tokio::test]
    async fn signed_loopback_release_is_downloaded_and_staged_as_one_native_version() {
        let root = test_directory("signed-stage");
        fs::create_dir_all(&root).expect("root");
        fs::create_dir_all(root.join("versions/3.0.0")).expect("current version");
        fs::write(
            root.join(VERSION_POINTER_FILE_NAME),
            br#"{"active_version":"3.0.0","last_known_good_version":"3.0.0","status":"healthy","expected_terminal_instance_ids":[],"updated_at_utc_msc":1}"#,
        )
        .expect("version pointer");
        let core_archive = zip_payload(&[
            ("AURUMBridge.exe", b"native ui"),
            ("AURUMBridge.Core.exe", b"native core"),
            ("launcher/AURUMBridge.Launcher.exe", b"native launcher"),
            (
                "server-endpoints.json",
                br#"{"schema_version":1,"server_url":"http://127.0.0.1:3000"}"#,
            ),
            ("runtime/python/python.exe", b"python runtime"),
        ]);
        let mt5_archive = zip_payload(&[
            ("worker.py", b"print('ready')"),
            ("trade.py", b"print('trade')"),
        ]);
        let mt4_archive = zip_payload(&[("AURUMBridgeEA.ex4", b"compiled ea")]);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let address = listener.local_addr().expect("server address");
        let signing_key = SigningKey::from_bytes((&[42_u8; 32]).into()).expect("signing key");
        let public_key = signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("public key");
        let mut packages = vec![
            package_for_release(
                "core",
                &core_archive,
                format!("http://{address}/bridge/releases/core.zip"),
            ),
            package_for_release(
                "adapter.mt5.python",
                &mt5_archive,
                format!("http://{address}/bridge/releases/mt5.zip"),
            ),
            package_for_release(
                "adapter.mt4",
                &mt4_archive,
                format!("http://{address}/bridge/releases/mt4.zip"),
            ),
        ];
        for package in &mut packages {
            package.signature = sign_text(&signing_key, &crate::canonicalize_package(package));
        }
        let mut manifest = ReleaseManifest {
            schema_version: 2,
            release_version: "3.1.0".to_owned(),
            release_id: Some("release-test-3.1.0".to_owned()),
            generated_at_utc_msc: 1_800_000_000_000,
            published_at_utc_msc: Some(1_800_000_000_000),
            expires_at_utc_msc: Some(4_102_444_800_000),
            priority: Some("normal".to_owned()),
            minimum_launcher_version: "1.0.0".to_owned(),
            minimum_idle_seconds: Some(120),
            activation_deadline_utc_msc: None,
            rollout_channel: Some("stable".to_owned()),
            rollout_percentage: Some(100),
            packages,
            signature: "pending".to_owned(),
        };
        manifest.signature = sign_text(
            &signing_key,
            &crate::canonicalize_manifest(&manifest).expect("canonical manifest"),
        );
        let manifest_payload = serde_json::to_vec(&manifest).expect("manifest payload");
        let responses = Arc::new(Mutex::new(BTreeMap::from([
            (
                "/api/bridge/v3/releases/current".to_owned(),
                manifest_payload,
            ),
            ("/bridge/releases/core.zip".to_owned(), core_archive),
            ("/bridge/releases/mt5.zip".to_owned(), mt5_archive),
            ("/bridge/releases/mt4.zip".to_owned(), mt4_archive),
        ])));
        let observed_requests = Arc::new(Mutex::new(Vec::new()));
        let served = Arc::clone(&responses);
        let observed = Arc::clone(&observed_requests);
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let mut request = vec![0_u8; 16 * 1024];
                let read = socket.read(&mut request).await.expect("read request");
                let request = String::from_utf8(request[..read].to_vec()).expect("HTTP request");
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("request path")
                    .to_owned();
                observed.lock().expect("observed requests").push(request);
                let body = served
                    .lock()
                    .expect("responses")
                    .remove(&path)
                    .expect("known request");
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket
                    .write_all(header.as_bytes())
                    .await
                    .expect("write header");
                socket.write_all(&body).await.expect("write body");
            }
        });

        let state_store = BridgeUpdateStateStore::new(root.join(crate::UPDATE_STATE_FILE_NAME))
            .expect("state store");
        let verifier = ReleaseManifestVerifier::with_clock(&public_key, || 1_800_000_000_100)
            .expect("verifier");
        let client = Client::builder()
            .tls_backend_rustls()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client");
        let mut coordinator = BridgeUpdateCoordinator::for_test(
            BridgeUpdateEnvironment {
                install_root: root.clone(),
                application_directory: root.join("versions/3.0.0"),
                current_version: "3.0.0".to_owned(),
                launcher_version: "1.0.0".to_owned(),
                state_path: root.join(crate::UPDATE_STATE_FILE_NAME),
            },
            verifier,
            state_store.clone(),
            client,
            "install_0123456789abcdef0123456789abcdef".to_owned(),
        )
        .expect("coordinator");
        let staged = coordinator
            .check_and_stage(Url::parse(&format!("http://{address}")).expect("server URL"))
            .await
            .expect("stage release")
            .expect("new release");
        server.await.expect("server");

        assert_eq!(staged.version, "3.1.0");
        assert!(staged.version_directory.join("AURUMBridge.exe").is_file());
        assert!(
            staged
                .version_directory
                .join("AURUMBridge.Core.exe")
                .is_file()
        );
        assert!(
            staged
                .version_directory
                .join("launcher/AURUMBridge.Launcher.exe")
                .is_file()
        );
        assert!(
            staged
                .version_directory
                .join("modules/adapter.mt5.python/worker.py")
                .is_file()
        );
        assert!(
            staged
                .version_directory
                .join("modules/adapter.mt5.python/trade.py")
                .is_file()
        );
        assert!(
            staged
                .version_directory
                .join("modules/adapter.mt4/AURUMBridgeEA.ex4")
                .is_file()
        );
        assert!(
            staged
                .version_directory
                .join(RELEASE_MARKER_FILE_NAME)
                .is_file()
        );
        let state = state_store.load().expect("state").expect("persisted state");
        assert_eq!(state.state, STATE_WAITING_WINDOW);
        assert_eq!(state.target_version.as_deref(), Some("3.1.0"));
        assert_eq!(
            coordinator
                .restore_staged_release()
                .expect("restore staged release"),
            Some(staged.clone())
        );
        for phase in [
            STATE_WAITING_WINDOW,
            STATE_ACQUIRING_LEASE,
            STATE_DRAINING,
            STATE_ACTIVATING,
        ] {
            let requires_lease = matches!(phase, STATE_DRAINING | STATE_ACTIVATING);
            coordinator
                .save_activation_phase(
                    &staged,
                    phase,
                    true,
                    requires_lease.then(|| "lease_01JUPDATE".to_owned()),
                    requires_lease.then_some(1_800_000_090_000),
                    None,
                    None,
                )
                .expect("interrupted activation state");
            assert_eq!(
                coordinator
                    .restore_staged_release()
                    .expect("restore interrupted staged release"),
                Some(staged.clone()),
                "phase {phase} must revalidate and restore the same release"
            );
        }
        let staged_core = staged.version_directory.join("AURUMBridge.Core.exe");
        let original_core = fs::read(&staged_core).expect("read staged core");
        fs::write(&staged_core, b"tampered native core").expect("tamper staged core");
        assert_eq!(
            coordinator
                .restore_staged_release()
                .expect_err("tampered extracted core must not recover")
                .code(),
            "update_staged_release_integrity_failed"
        );
        fs::write(&staged_core, original_core).expect("restore staged core");
        assert_eq!(
            coordinator
                .restore_staged_release()
                .expect("restore repaired staged release"),
            Some(staged.clone())
        );
        let unexpected = staged.version_directory.join("unexpected.dll");
        fs::write(&unexpected, b"unexpected").expect("write unexpected staged file");
        assert_eq!(
            coordinator
                .restore_staged_release()
                .expect_err("unexpected staged file must not recover")
                .code(),
            "update_staged_release_integrity_failed"
        );
        fs::remove_file(unexpected).expect("remove unexpected staged file");
        coordinator
            .prepare_activation(
                &staged,
                &["mt5_terminal_b".to_owned(), "mt4_terminal_a".to_owned()],
            )
            .expect("prepare activation");
        let pointer = coordinator
            .activation_store
            .load()
            .expect("pending pointer");
        assert_eq!(pointer.active_version, "3.1.0");
        assert_eq!(pointer.status, "pending");
        assert_eq!(
            pointer.expected_terminal_instance_ids,
            vec!["mt4_terminal_a".to_owned(), "mt5_terminal_b".to_owned()]
        );
        let requests = observed_requests.lock().expect("observed requests");
        let manifest_request = requests
            .iter()
            .find(|request| request.starts_with("GET /api/bridge/v3/releases/current"))
            .expect("manifest request")
            .to_ascii_lowercase();
        assert!(
            manifest_request
                .contains("x-aurum-installation-id: install_0123456789abcdef0123456789abcdef")
        );
        assert!(manifest_request.contains("x-aurum-release-channel: stable"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn installation_identity_is_stable_across_native_upgrades() {
        let root = test_directory("identity");
        fs::create_dir_all(&root).expect("root");
        let store = InstallationIdentityStore::new(root.join(INSTALLATION_ID_FILE_NAME))
            .expect("identity store");
        let first = store.load_or_create().expect("first identity");
        let second = store.load_or_create().expect("second identity");
        assert_eq!(first, second);
        assert_eq!(first.len(), 40);
        assert!(first.starts_with("install_"));
        assert!(first[8..].bytes().all(|value| value.is_ascii_hexdigit()));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn reads_the_current_native_launcher_file_version_when_available() {
        let launcher = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/x86_64-pc-windows-msvc/release/liangjian-bridge-launcher.exe");
        if launcher.is_file() {
            assert!(read_file_version(&launcher).is_ok());
        }
    }

    #[test]
    fn staged_layout_requires_native_ui_core_and_both_adapters() {
        let root = test_directory("layout");
        for relative in REQUIRED_CORE_FILES {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("directory");
            fs::write(path, b"component").expect("component");
        }
        let endpoint = root.join("server-endpoints.json");
        fs::write(
            endpoint,
            br#"{"schema_version":1,"server_url":"http://127.0.0.1:3000"}"#,
        )
        .expect("endpoint");
        for relative in [
            "modules/adapter.mt5.python/worker.py",
            "modules/adapter.mt5.python/trade.py",
            "modules/adapter.mt4/AURUMBridgeEA.ex4",
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("directory");
            fs::write(path, b"adapter").expect("adapter");
        }
        assert_eq!(validate_native_release_layout(&root), Ok(()));
        fs::remove_file(root.join("AURUMBridge.Core.exe")).expect("remove core");
        assert_eq!(
            validate_native_release_layout(&root)
                .expect_err("missing core")
                .code(),
            "update_core_component_missing"
        );
        fs::write(root.join("AURUMBridge.Core.exe"), b"component").expect("restore core");
        fs::write(root.join("AURUMBridge.dll"), b"legacy").expect("legacy component");
        assert_eq!(
            validate_native_release_layout(&root)
                .expect_err("legacy core layout")
                .code(),
            "update_core_component_missing"
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn failure_does_not_erase_a_verified_waiting_release() {
        let root = test_directory("failure-preserves-waiting");
        fs::create_dir_all(&root).expect("root");
        let state_store = BridgeUpdateStateStore::new(root.join(crate::UPDATE_STATE_FILE_NAME))
            .expect("state store");
        let waiting = BridgeUpdateState {
            schema_version: 1,
            state: STATE_WAITING_WINDOW.to_owned(),
            target_version: Some("3.1.0".to_owned()),
            release_id: Some("release-test-3.1.0".to_owned()),
            priority: Some("normal".to_owned()),
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
        };
        let waiting = state_store.save(waiting).expect("waiting state");
        let coordinator = coordinator_for_state_test(root.clone(), state_store.clone());
        coordinator.try_record_failure("update_manifest_request_failed");
        assert_eq!(state_store.load(), Ok(Some(waiting)));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn invalid_interrupted_stage_is_discarded_unless_launcher_already_owns_pending_activation() {
        let root = test_directory("interrupted-stage-cleanup");
        let current_directory = root.join("versions/3.0.0");
        let target_directory = root.join("versions/3.1.0");
        fs::create_dir_all(&current_directory).expect("current directory");
        fs::write(current_directory.join("AURUMBridge.exe"), b"current").expect("current UI");
        fs::create_dir_all(&target_directory).expect("target directory");
        fs::write(target_directory.join("AURUMBridge.exe"), b"candidate").expect("candidate UI");
        let activation_store = ReleaseActivationStore::new(root.join(VERSION_POINTER_FILE_NAME))
            .expect("activation store");
        activation_store
            .initialize_healthy("3.0.0", 1_800_000_000_000)
            .expect("healthy pointer");
        let state_store = BridgeUpdateStateStore::new(root.join(crate::UPDATE_STATE_FILE_NAME))
            .expect("state store");
        let interrupted = BridgeUpdateState {
            schema_version: 1,
            state: STATE_DRAINING.to_owned(),
            target_version: Some("3.1.0".to_owned()),
            release_id: Some("release-test-3.1.0".to_owned()),
            priority: Some("normal".to_owned()),
            manual_activation_requested: true,
            staged_at_utc_msc: Some(1_800_000_000_000),
            activation_started_at_utc_msc: Some(1_800_000_000_010),
            minimum_idle_seconds: 120,
            activation_deadline_utc_msc: None,
            maintenance_lease_id: Some("lease_01JINTERRUPTED".to_owned()),
            maintenance_lease_expires_at_utc_msc: Some(1_800_000_090_000),
            next_retry_at_utc_msc: None,
            last_error_code: None,
            updated_at_utc_msc: 1_800_000_000_010,
        };
        state_store
            .save(interrupted.clone())
            .expect("interrupted state");
        let coordinator = coordinator_for_state_test(root.clone(), state_store.clone());
        assert!(
            coordinator
                .abandon_invalid_staged_release(
                    &interrupted,
                    "update_staged_release_integrity_failed"
                )
                .expect("discard invalid stage")
        );
        assert!(!target_directory.exists());
        let failed = state_store.load().expect("failed state").expect("state");
        assert_eq!(failed.state, STATE_FAILED);
        assert!(failed.maintenance_lease_id.is_none());
        assert_eq!(
            failed.last_error_code.as_deref(),
            Some("update_staged_release_integrity_failed")
        );

        fs::write(&target_directory, b"not a version directory")
            .expect("write invalid target file");
        assert_eq!(
            coordinator
                .abandon_invalid_staged_release(
                    &interrupted,
                    "update_staged_release_integrity_failed"
                )
                .expect_err("cleanup must reject a non-directory target")
                .code(),
            "update_staged_release_cleanup_boundary"
        );
        fs::remove_file(&target_directory).expect("remove invalid target file");
        fs::create_dir_all(&target_directory).expect("recreate target directory");
        fs::write(target_directory.join("AURUMBridge.exe"), b"candidate")
            .expect("recreate candidate UI");
        coordinator
            .prepare_activation(
                &StagedRelease {
                    version: "3.1.0".to_owned(),
                    version_directory: target_directory.clone(),
                    release_id: Some("release-test-3.1.0".to_owned()),
                    priority: "normal".to_owned(),
                    minimum_idle_seconds: 120,
                    activation_deadline_utc_msc: None,
                },
                &[],
            )
            .expect("prepare pending activation");
        assert!(
            !coordinator
                .abandon_invalid_staged_release(
                    &interrupted,
                    "update_staged_release_integrity_failed"
                )
                .expect("delegate pending activation")
        );
        assert!(target_directory.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn coordinator_for_state_test(
        root: PathBuf,
        state_store: BridgeUpdateStateStore,
    ) -> BridgeUpdateCoordinator {
        let verifier = ReleaseManifestVerifier::new(include_str!(
            "../../../../update-contract/release-public-key.pem"
        ))
        .expect("verifier");
        let client = Client::builder()
            .tls_backend_rustls()
            .build()
            .expect("client");
        BridgeUpdateCoordinator::for_test(
            BridgeUpdateEnvironment {
                install_root: root.clone(),
                application_directory: root.join("versions/3.0.0"),
                current_version: "3.0.0".to_owned(),
                launcher_version: "3.0.0".to_owned(),
                state_path: root.join(crate::UPDATE_STATE_FILE_NAME),
            },
            verifier,
            state_store,
            client,
            "install_0123456789abcdef0123456789abcdef".to_owned(),
        )
        .expect("coordinator")
    }

    fn package_for_release(module_id: &str, payload: &[u8], url: String) -> ReleasePackage {
        ReleasePackage {
            module_id: module_id.to_owned(),
            version: "3.1.0".to_owned(),
            url: Url::parse(&url).expect("package URL"),
            size_bytes: payload.len() as u64,
            sha256: format!("{:x}", Sha256::digest(payload)),
            signature: "pending".to_owned(),
            minimum_core_version: (module_id != "core").then(|| "3.1.0".to_owned()),
            maximum_core_version: (module_id != "core").then(|| "3.1.0".to_owned()),
        }
    }

    fn sign_text(signing_key: &SigningKey, payload: &str) -> String {
        let signature: Signature = signing_key.sign(payload.as_bytes());
        STANDARD.encode(signature.to_bytes())
    }

    fn zip_payload(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, payload) in entries {
            archive.start_file(*name, options).expect("zip entry");
            archive.write_all(payload).expect("zip payload");
        }
        archive.finish().expect("finish zip").into_inner()
    }

    fn test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-update-coordinator-{}-{}-{label}",
            std::process::id(),
            now_utc_msc()
        ))
    }
}
