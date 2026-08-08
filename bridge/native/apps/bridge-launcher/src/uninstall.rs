use crate::{LAUNCHER_FILE_NAME, LauncherError, LauncherStartupOptions};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER, ERROR_PATH_NOT_FOUND, GetLastError,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDriveTypeW, MOVEFILE_DELAY_UNTIL_REBOOT, MoveFileExW,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, RegCloseKey, RegDeleteTreeW,
    RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};
use windows_sys::Win32::UI::Shell::{
    CSIDL_APPDATA, CSIDL_DESKTOPDIRECTORY, CSIDL_PROGRAMS, SEE_MASK_NOCLOSEPROCESS,
    SHELLEXECUTEINFOW, SHGFP_TYPE_CURRENT, SHGetFolderPathW, ShellExecuteExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const UNINSTALL_HELPER_FILE_NAME: &str = "AURUMBridge.UninstallHelper.exe";
const DATA_DIRECTORY_NAME: &str = "BridgeV3";
const POINTER_FILE_NAME: &str = "current.json";
const SHORTCUT_FILE_NAME: &str = "量见智桥.lnk";
const AUTOSTART_VALUE_NAME: &str = "AURUMBridge";
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const UNINSTALL_KEY_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\LiangjianBridge";
const PARENT_WAIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DataRemovalMode {
    Keep,
    Remove,
}

impl DataRemovalMode {
    pub fn as_argument(self) -> &'static str {
        match self {
            Self::Keep => "keep-data",
            Self::Remove => "remove-data",
        }
    }

    fn parse(value: &str) -> Result<Self, LauncherError> {
        match value {
            "keep-data" => Ok(Self::Keep),
            "remove-data" => Ok(Self::Remove),
            _ => Err(LauncherError::new("bridge_uninstall_request_invalid")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UninstallWorkerRequest {
    pub install_root: PathBuf,
    pub data_mode: DataRemovalMode,
    pub parent_process_id: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LauncherCommand {
    Launch(LauncherStartupOptions),
    BeginUninstall,
    UninstallWorker(UninstallWorkerRequest),
}

pub fn parse_launcher_command(arguments: &[String]) -> Result<LauncherCommand, LauncherError> {
    match arguments {
        [argument] if argument == "--uninstall" => Ok(LauncherCommand::BeginUninstall),
        [worker, install_root, data_mode, parent_process_id] if worker == "--uninstall-worker" => {
            let parent_process_id = parent_process_id
                .parse::<u32>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| LauncherError::new("bridge_uninstall_request_invalid"))?;
            let install_root = std::path::absolute(install_root)
                .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
            Ok(LauncherCommand::UninstallWorker(UninstallWorkerRequest {
                install_root,
                data_mode: DataRemovalMode::parse(data_mode)?,
                parent_process_id,
            }))
        }
        _ => LauncherStartupOptions::parse(arguments).map(LauncherCommand::Launch),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallationLayout {
    pub install_root: PathBuf,
    pub data_root: PathBuf,
    pub desktop_shortcut: PathBuf,
    pub start_menu_shortcut: PathBuf,
}

impl InstallationLayout {
    pub fn current() -> Result<Self, LauncherError> {
        let executable = std::env::current_exe()
            .map_err(|_| LauncherError::new("bridge_uninstall_executable_missing"))?;
        Self::from_launcher(&executable)
    }

    pub fn from_launcher(current_executable: &Path) -> Result<Self, LauncherError> {
        let executable = std::path::absolute(current_executable)
            .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
        if !is_stable_launcher_path(&executable) {
            return Err(LauncherError::new("bridge_uninstall_entry_invalid"));
        }
        let install_root = executable
            .parent()
            .ok_or_else(|| LauncherError::new("bridge_uninstall_entry_invalid"))?
            .to_path_buf();
        validate_install_root(&install_root)?;
        let registered_root = registered_install_root()?
            .ok_or_else(|| LauncherError::new("bridge_uninstall_registration_missing"))?;
        if !paths_equal_trimmed(&install_root, &registered_root) {
            return Err(LauncherError::new("bridge_uninstall_entry_invalid"));
        }
        Self::for_install_root(&install_root)
    }

    pub fn for_install_root(install_root: &Path) -> Result<Self, LauncherError> {
        validate_install_root(install_root)?;
        let registered_root = registered_install_root()?
            .ok_or_else(|| LauncherError::new("bridge_uninstall_registration_missing"))?;
        if !paths_equal_trimmed(install_root, &registered_root) {
            return Err(LauncherError::new("bridge_uninstall_entry_invalid"));
        }
        let roaming_app_data = known_folder(CSIDL_APPDATA)?;
        Ok(Self {
            install_root: install_root.to_path_buf(),
            data_root: roaming_app_data.join("AURUM").join(DATA_DIRECTORY_NAME),
            desktop_shortcut: known_folder(CSIDL_DESKTOPDIRECTORY)?.join(SHORTCUT_FILE_NAME),
            start_menu_shortcut: known_folder(CSIDL_PROGRAMS)?.join(SHORTCUT_FILE_NAME),
        })
    }

    fn matches_install_root(&self, value: &Path) -> bool {
        paths_equal_trimmed(value, &self.install_root)
    }

    fn matches_registered_root(&self) -> Result<bool, LauncherError> {
        Ok(registered_install_root()?
            .is_some_and(|registered| paths_equal_trimmed(&registered, &self.install_root)))
    }
}

pub fn uninstall_preflight(
    layout: &InstallationLayout,
    current_executable: &Path,
) -> Result<(), LauncherError> {
    let current_executable = std::path::absolute(current_executable)
        .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
    if current_executable
        .file_name()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case(LAUNCHER_FILE_NAME))
        || current_executable
            .parent()
            .is_none_or(|parent| !layout.matches_install_root(parent))
        || !is_stable_launcher_path(&current_executable)
        || !layout.matches_registered_root()?
        || !layout.install_root.join(POINTER_FILE_NAME).is_file()
    {
        return Err(LauncherError::new("bridge_uninstall_entry_invalid"));
    }
    ensure_protected_helper(&layout.install_root)?;
    if bridge_processes_running(std::process::id())? {
        return Err(LauncherError::new("bridge_uninstall_process_running"));
    }
    Ok(())
}

pub fn spawn_uninstall_worker(
    current_executable: &Path,
    layout: &InstallationLayout,
    data_mode: DataRemovalMode,
) -> Result<(), LauncherError> {
    let current_executable = std::path::absolute(current_executable)
        .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
    uninstall_preflight(layout, &current_executable)?;
    let helper = layout.install_root.join(UNINSTALL_HELPER_FILE_NAME);
    if !helper.is_file() {
        return Err(LauncherError::new("bridge_uninstall_helper_missing"));
    }
    let verb = wide_null("runas");
    let file = wide_path(&helper);
    let parameters = wide_null(&format!(
        "--uninstall-worker \"{}\" {} {}",
        quote_windows_argument(&layout.install_root),
        data_mode.as_argument(),
        std::process::id()
    ));
    let directory = wide_path(&layout.install_root);
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        hwnd: std::ptr::null_mut(),
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        lpDirectory: directory.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..SHELLEXECUTEINFOW::default()
    };
    if unsafe { ShellExecuteExW(&mut execute) } == 0 {
        return Err(LauncherError::new("bridge_uninstall_worker_start_failed"));
    }
    if !execute.hProcess.is_null() {
        unsafe { CloseHandle(execute.hProcess) };
    }
    Ok(())
}

pub fn run_uninstall_worker(
    request: &UninstallWorkerRequest,
    layout: &InstallationLayout,
    worker_executable: &Path,
) -> Result<(), LauncherError> {
    let result = (|| {
        validate_worker_request(request, layout, worker_executable)?;
        wait_for_parent(request.parent_process_id, PARENT_WAIT_TIMEOUT)?;
        if bridge_processes_running(std::process::id())? {
            return Err(LauncherError::new("bridge_uninstall_process_running"));
        }
        remove_installation_files(request, layout)?;
        remove_registration_and_shortcuts(layout)?;
        remove_selected_data(request, layout)?;
        Ok(())
    })();
    let _ = schedule_delete_on_reboot(worker_executable);
    result
}

fn validate_worker_request(
    request: &UninstallWorkerRequest,
    layout: &InstallationLayout,
    worker_executable: &Path,
) -> Result<(), LauncherError> {
    let worker_executable = std::path::absolute(worker_executable)
        .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
    let helper = request.install_root.join(UNINSTALL_HELPER_FILE_NAME);
    if request.parent_process_id == 0
        || !layout.matches_install_root(&request.install_root)
        || !layout.matches_registered_root()?
        || !is_protected_helper_path(&worker_executable, &request.install_root)
        || !paths_equal_trimmed(&worker_executable, &helper)
    {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    if !request.install_root.join(POINTER_FILE_NAME).is_file()
        || !request.install_root.join("versions").is_dir()
    {
        return Err(LauncherError::new("bridge_uninstall_installation_invalid"));
    }
    Ok(())
}

fn remove_installation_files(
    request: &UninstallWorkerRequest,
    layout: &InstallationLayout,
) -> Result<(), LauncherError> {
    if request.parent_process_id == 0 || !layout.matches_install_root(&request.install_root) {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    let launcher = request.install_root.join(LAUNCHER_FILE_NAME);
    let pointer = request.install_root.join(POINTER_FILE_NAME);
    if !launcher.is_file() || !pointer.is_file() {
        return Err(LauncherError::new("bridge_uninstall_installation_invalid"));
    }
    ensure_tree_no_reparse(&request.install_root)?;
    let helper = request.install_root.join(UNINSTALL_HELPER_FILE_NAME);
    if helper.is_file() {
        for entry in fs::read_dir(&request.install_root)
            .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?
        {
            let entry = entry.map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
            let path = entry.path();
            if paths_equal_trimmed(&path, &helper) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(LauncherError::new("bridge_uninstall_remove_failed"));
            }
            if metadata.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
            } else {
                fs::remove_file(&path)
                    .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
            }
        }
        schedule_delete_on_reboot(&helper)?;
        schedule_delete_on_reboot(&request.install_root)?;
    } else {
        fs::remove_dir_all(&request.install_root)
            .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
    }
    Ok(())
}

fn remove_selected_data(
    request: &UninstallWorkerRequest,
    layout: &InstallationLayout,
) -> Result<(), LauncherError> {
    if request.parent_process_id == 0 || !layout.matches_install_root(&request.install_root) {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    if request.data_mode == DataRemovalMode::Remove && layout.data_root.exists() {
        ensure_tree_no_reparse(&layout.data_root)?;
        fs::remove_dir_all(&layout.data_root)
            .map_err(|_| LauncherError::new("bridge_uninstall_data_remove_failed"))?;
    }
    Ok(())
}

fn ensure_tree_no_reparse(root: &Path) -> Result<(), LauncherError> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let metadata = fs::symlink_metadata(&directory)
            .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
        if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() {
            return Err(LauncherError::new("bridge_uninstall_remove_failed"));
        }
        if !metadata.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&directory)
            .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?
        {
            let entry = entry.map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
            let child = entry.path();
            let child_metadata = fs::symlink_metadata(&child)
                .map_err(|_| LauncherError::new("bridge_uninstall_remove_failed"))?;
            if child_metadata.file_attributes() & 0x400 != 0
                || child_metadata.file_type().is_symlink()
            {
                return Err(LauncherError::new("bridge_uninstall_remove_failed"));
            }
            if child_metadata.is_dir() {
                pending.push(child);
            }
        }
    }
    Ok(())
}

fn bridge_processes_running(current_process_id: u32) -> Result<bool, LauncherError> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(LauncherError::new("bridge_uninstall_process_scan_failed"));
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    let mut running = false;
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while available {
        if entry.th32ProcessID != current_process_id {
            let name = utf16_name(&entry.szExeFile);
            if name.eq_ignore_ascii_case("AURUMBridge.exe")
                || name.eq_ignore_ascii_case(LAUNCHER_FILE_NAME)
            {
                running = true;
                break;
            }
        }
        available = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    Ok(running)
}

fn wait_for_parent(parent_process_id: u32, timeout: Duration) -> Result<(), LauncherError> {
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_process_id) };
    if process.is_null() {
        let error = unsafe { GetLastError() };
        return if error == ERROR_INVALID_PARAMETER {
            Ok(())
        } else {
            Err(LauncherError::new("bridge_uninstall_parent_wait_failed"))
        };
    }
    let milliseconds = timeout.as_millis().min(u128::from(u32::MAX)) as u32;
    let wait = unsafe { WaitForSingleObject(process, milliseconds) };
    unsafe { CloseHandle(process) };
    if wait == WAIT_OBJECT_0 {
        Ok(())
    } else {
        Err(LauncherError::new("bridge_uninstall_parent_wait_failed"))
    }
}

fn remove_registration_and_shortcuts(layout: &InstallationLayout) -> Result<(), LauncherError> {
    let uninstall_key = wide_null(UNINSTALL_KEY_PATH);
    let deleted = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, uninstall_key.as_ptr()) };
    if !matches!(deleted, 0 | ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Err(LauncherError::new("bridge_uninstall_registry_failed"));
    }

    let run_key_path = wide_null(RUN_KEY_PATH);
    let mut run_key: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            run_key_path.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut run_key,
        )
    };
    if opened == 0 {
        let value_name = wide_null(AUTOSTART_VALUE_NAME);
        let deleted = unsafe { RegDeleteValueW(run_key, value_name.as_ptr()) };
        unsafe { RegCloseKey(run_key) };
        if !matches!(deleted, 0 | ERROR_FILE_NOT_FOUND) {
            return Err(LauncherError::new("bridge_uninstall_registry_failed"));
        }
    } else if !matches!(opened, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Err(LauncherError::new("bridge_uninstall_registry_failed"));
    }

    for shortcut in [&layout.desktop_shortcut, &layout.start_menu_shortcut] {
        match fs::remove_file(shortcut) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LauncherError::new("bridge_uninstall_shortcut_failed")),
        }
    }
    Ok(())
}

fn schedule_delete_on_reboot(path: &Path) -> Result<(), LauncherError> {
    let path = wide_path(path);
    let scheduled =
        unsafe { MoveFileExW(path.as_ptr(), std::ptr::null(), MOVEFILE_DELAY_UNTIL_REBOOT) };
    if scheduled == 0 {
        Err(LauncherError::new("bridge_uninstall_worker_cleanup_failed"))
    } else {
        Ok(())
    }
}

fn ensure_protected_helper(install_root: &Path) -> Result<(), LauncherError> {
    let helper = install_root.join(UNINSTALL_HELPER_FILE_NAME);
    if !helper.is_file() {
        return Err(LauncherError::new("bridge_uninstall_helper_missing"));
    }
    // The ordinary launcher must never elevate a file that the same user can
    // replace.  ACL application is performed by the installer; this check is
    // deliberately conservative and fails closed when the helper is writable.
    if OpenOptions::new().write(true).open(&helper).is_ok() {
        return Err(LauncherError::new("bridge_uninstall_helper_unprotected"));
    }
    Ok(())
}

fn is_stable_launcher_path(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.file_attributes() & 0x400 == 0)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(LAUNCHER_FILE_NAME))
}

fn is_protected_helper_path(path: &Path, install_root: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.file_attributes() & 0x400 == 0)
        && path
            .parent()
            .is_some_and(|parent| paths_equal_trimmed(parent, install_root))
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(UNINSTALL_HELPER_FILE_NAME))
}

fn validate_install_root(path: &Path) -> Result<(), LauncherError> {
    let path = std::path::absolute(path)
        .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
    if path.components().any(|component| {
        matches!(component, std::path::Component::ParentDir)
            || matches!(
                component,
                std::path::Component::Prefix(prefix)
                    if matches!(
                        prefix.kind(),
                        std::path::Prefix::UNC(..)
                            | std::path::Prefix::VerbatimUNC(..)
                            | std::path::Prefix::DeviceNS(..)
                            | std::path::Prefix::Verbatim(..)
                    )
            )
    }) {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    let is_disk = path.components().next().is_some_and(|component| {
        matches!(
            component,
            std::path::Component::Prefix(prefix)
                if matches!(prefix.kind(), std::path::Prefix::Disk(_))
        )
    });
    if !is_disk
        || !path
            .components()
            .any(|component| matches!(component, std::path::Component::RootDir))
    {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    let path_text = path.to_string_lossy();
    let drive_root = PathBuf::from(format!("{}\\", &path_text[..2]));
    let text = wide_path(&drive_root);
    if unsafe { GetDriveTypeW(text.as_ptr()) } != 3 {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| LauncherError::new("bridge_uninstall_request_invalid"))?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(LauncherError::new("bridge_uninstall_request_invalid"));
        }
    }
    let normal_count = path
        .components()
        .filter(|component| matches!(component, std::path::Component::Normal(_)))
        .count();
    if normal_count < 2 {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    if is_protected_install_root_path(&path) {
        return Err(LauncherError::new("bridge_uninstall_request_invalid"));
    }
    Ok(())
}

fn is_protected_install_root_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let windows = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let windows = windows
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase();
    let temp = std::env::temp_dir()
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase();
    let protected_subtrees = [windows.clone(), format!(r"{windows}\system32"), temp];
    let protected_roots = [
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase(),
        std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"))
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase(),
    ];
    protected_subtrees.iter().any(|base| {
        lower == *base
            || lower
                .strip_prefix(base)
                .is_some_and(|suffix| suffix.starts_with('\\') || suffix.starts_with('/'))
    }) || protected_roots.contains(&lower)
}

fn registered_install_root() -> Result<Option<PathBuf>, LauncherError> {
    let key_path = wide_null(UNINSTALL_KEY_PATH);
    let mut key: HKEY = std::ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND {
        return Ok(None);
    }
    if opened != 0 {
        return Err(LauncherError::new("bridge_uninstall_registry_unavailable"));
    }
    let value_name = wide_null("InstallLocation");
    let mut value_type = 0_u32;
    let mut value_size = 0_u32;
    let first = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut value_size,
        )
    };
    if first != 0 || value_type != REG_SZ || !(2..=32 * 1024).contains(&value_size) {
        unsafe { RegCloseKey(key) };
        return Err(LauncherError::new("bridge_uninstall_registry_invalid"));
    }
    let mut units = vec![0_u16; value_size as usize / 2];
    let second = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            units.as_mut_ptr().cast(),
            &mut value_size,
        )
    };
    unsafe { RegCloseKey(key) };
    if second != 0 || value_type != REG_SZ || value_size < 2 {
        return Err(LauncherError::new("bridge_uninstall_registry_invalid"));
    }
    let units = &units[..value_size as usize / 2];
    let length = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    let value = String::from_utf16(&units[..length])
        .map_err(|_| LauncherError::new("bridge_uninstall_registry_invalid"))?;
    if value.trim() != value || value.contains('"') || value.is_empty() {
        return Err(LauncherError::new("bridge_uninstall_registry_invalid"));
    }
    let path = std::path::absolute(value)
        .map_err(|_| LauncherError::new("bridge_uninstall_registry_invalid"))?;
    validate_install_root(&path)?;
    Ok(Some(path))
}

fn known_folder(csidl: u32) -> Result<PathBuf, LauncherError> {
    let mut buffer = [0_u16; 260];
    let result = unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            csidl as i32,
            std::ptr::null_mut(),
            SHGFP_TYPE_CURRENT as u32,
            buffer.as_mut_ptr(),
        )
    };
    if result < 0 {
        return Err(LauncherError::new("bridge_uninstall_known_folder_failed"));
    }
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(0);
    if length == 0 {
        return Err(LauncherError::new("bridge_uninstall_known_folder_failed"));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

fn utf16_name(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

fn paths_equal_trimmed(left: &Path, right: &Path) -> bool {
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

fn quote_windows_argument(path: &Path) -> String {
    path.to_string_lossy().replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timestamp_nanos;

    #[test]
    fn command_contract_matches_the_dotnet_launcher_and_rejects_partial_workers() {
        assert_eq!(
            parse_launcher_command(&["--uninstall".to_owned()]),
            Ok(LauncherCommand::BeginUninstall)
        );
        let worker = parse_launcher_command(&[
            "--uninstall-worker".to_owned(),
            r"C:\AURUM\LiangjianBridge".to_owned(),
            "remove-data".to_owned(),
            "1234".to_owned(),
        ])
        .expect("worker command");
        assert!(matches!(
            worker,
            LauncherCommand::UninstallWorker(UninstallWorkerRequest {
                data_mode: DataRemovalMode::Remove,
                parent_process_id: 1234,
                ..
            })
        ));
        assert_eq!(
            parse_launcher_command(&[
                "--uninstall-worker".to_owned(),
                r"C:\AURUM\LiangjianBridge".to_owned(),
                "remove-data".to_owned(),
            ])
            .expect_err("partial worker")
            .code(),
            "launcher_arguments_invalid"
        );
    }

    #[test]
    fn program_files_root_is_protected_but_application_subdirectories_are_allowed() {
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        assert!(is_protected_install_root_path(&program_files));
        assert!(!is_protected_install_root_path(
            &program_files.join("AURUM").join("LiangjianBridge")
        ));
        assert!(is_protected_install_root_path(Path::new(
            r"C:\Windows\AURUM"
        )));
    }

    #[test]
    fn uninstall_worker_rejects_the_writable_stable_launcher_path() {
        let layout = fixture("stable-launcher-worker");
        let worker = layout.install_root.join(LAUNCHER_FILE_NAME);
        assert!(!is_protected_helper_path(&worker, &layout.install_root));
        fs::remove_dir_all(fixture_root(&layout)).expect("cleanup");
    }

    #[test]
    fn isolated_uninstall_preserves_or_removes_only_the_selected_data_root() {
        let keep = fixture("keep-data");
        let keep_request = request(&keep, DataRemovalMode::Keep);
        remove_installation_files(&keep_request, &keep).expect("keep-data uninstall");
        remove_selected_data(&keep_request, &keep).expect("keep-data selection");
        assert!(!keep.install_root.exists());
        assert!(keep.data_root.is_dir());
        fs::remove_dir_all(fixture_root(&keep)).expect("keep cleanup");

        let remove = fixture("remove-data");
        let remove_request = request(&remove, DataRemovalMode::Remove);
        remove_installation_files(&remove_request, &remove).expect("remove-data uninstall");
        remove_selected_data(&remove_request, &remove).expect("remove-data selection");
        assert!(!remove.install_root.exists());
        assert!(!remove.data_root.exists());
        fs::remove_dir_all(fixture_root(&remove)).expect("remove cleanup");
    }

    #[test]
    fn uninstall_rejects_another_root_before_any_recursive_delete() {
        let layout = fixture("wrong-root");
        let foreign = layout
            .install_root
            .parent()
            .expect("install parent")
            .join("Foreign");
        fs::create_dir_all(&foreign).expect("foreign root");
        fs::write(foreign.join("keep.txt"), b"keep").expect("foreign marker");
        let invalid = UninstallWorkerRequest {
            install_root: foreign.clone(),
            data_mode: DataRemovalMode::Remove,
            parent_process_id: 1,
        };
        assert_eq!(
            remove_installation_files(&invalid, &layout)
                .expect_err("wrong root")
                .code(),
            "bridge_uninstall_request_invalid"
        );
        assert!(foreign.join("keep.txt").is_file());
        fs::remove_dir_all(fixture_root(&layout)).expect("cleanup");
    }

    #[test]
    fn uninstall_rejects_nested_reparse_before_touching_external_data() {
        let layout = fixture("nested-reparse");
        let external = std::env::temp_dir().join(format!(
            "liangjian-bridge-launcher-uninstall-external-{}",
            crate::timestamp_nanos()
        ));
        fs::create_dir_all(&external).expect("external directory");
        fs::write(external.join("keep.txt"), b"keep").expect("external marker");
        let junction = layout.install_root.join("versions");
        let real_versions = layout.install_root.join("versions-real");
        fs::rename(&junction, &real_versions).expect("move versions");
        if std::os::windows::fs::symlink_dir(&external, &junction).is_err() {
            fs::rename(real_versions, junction).expect("restore versions");
            fs::remove_dir_all(external).expect("external cleanup");
            fs::remove_dir_all(fixture_root(&layout)).expect("fixture cleanup");
            return;
        }
        let request = request(&layout, DataRemovalMode::Remove);
        let error = remove_installation_files(&request, &layout)
            .expect_err("nested reparse must fail closed");
        assert_eq!(error.code(), "bridge_uninstall_remove_failed");
        assert!(external.join("keep.txt").is_file());
        fs::remove_dir(&junction).expect("junction cleanup");
        fs::rename(real_versions, junction).expect("restore versions");
        fs::remove_dir_all(external).expect("external cleanup");
        fs::remove_dir_all(fixture_root(&layout)).expect("fixture cleanup");
    }

    fn fixture(label: &str) -> InstallationLayout {
        let root = std::env::temp_dir().join(format!(
            "liangjian-bridge-launcher-uninstall-{label}-{}-{}",
            std::process::id(),
            timestamp_nanos()
        ));
        let install_root = root.join("local/AURUM/LiangjianBridge");
        let data_root = root.join("roaming/AURUM/BridgeV3");
        fs::create_dir_all(&install_root).expect("install root");
        fs::create_dir_all(install_root.join("versions")).expect("versions");
        fs::create_dir_all(&data_root).expect("data root");
        fs::write(install_root.join(LAUNCHER_FILE_NAME), b"launcher").expect("launcher");
        fs::write(install_root.join(POINTER_FILE_NAME), b"{}").expect("pointer");
        fs::write(data_root.join("settings.json"), b"{}").expect("data");
        InstallationLayout {
            install_root,
            data_root,
            desktop_shortcut: root.join("desktop").join(SHORTCUT_FILE_NAME),
            start_menu_shortcut: root.join("programs").join(SHORTCUT_FILE_NAME),
        }
    }

    fn request(layout: &InstallationLayout, data_mode: DataRemovalMode) -> UninstallWorkerRequest {
        UninstallWorkerRequest {
            install_root: layout.install_root.clone(),
            data_mode,
            parent_process_id: 1,
        }
    }

    fn fixture_root(layout: &InstallationLayout) -> &Path {
        layout
            .install_root
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .expect("fixture root")
    }
}
