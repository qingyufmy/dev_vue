#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use liangjian_bridge_launcher::{
    DataRemovalMode, InstallationLayout, LauncherCommand, LauncherEngine, LauncherExecutionContext,
    NativeBridgeProcessRunner, parse_launcher_command, run_uninstall_worker,
    spawn_uninstall_worker, uninstall_preflight,
};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::thread;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    IDNO, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNOCANCEL,
    MessageBoxW,
};

fn main() {
    let arguments = match std::env::args_os()
        .skip(1)
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "launcher_arguments_invalid")
        })
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(arguments) => arguments,
        Err(code) => return fail_startup(code, false),
    };
    let command = match parse_launcher_command(&arguments) {
        Ok(command) => command,
        Err(error) => return fail_startup(error.code(), false),
    };
    let result = match command {
        LauncherCommand::Launch(startup) => run_launch(startup),
        LauncherCommand::BeginUninstall => run_interactive_uninstall(),
        LauncherCommand::UninstallWorker(request) => run_worker_uninstall(request),
    };
    if let Err((code, mode)) = result {
        match mode {
            FailureMode::Startup { automatic } => fail_startup(code, automatic),
            FailureMode::Uninstall => fail_uninstall(code),
        }
    }
}

#[derive(Clone, Copy)]
enum FailureMode {
    Startup { automatic: bool },
    Uninstall,
}

fn run_launch(
    startup: liangjian_bridge_launcher::LauncherStartupOptions,
) -> Result<(), (&'static str, FailureMode)> {
    if !startup.delay.is_zero() {
        thread::sleep(startup.delay);
    }
    let executable = current_launcher_executable()
        .map_err(|code| (code, FailureMode::Startup { automatic: false }))?;
    let context = LauncherExecutionContext::resolve(&executable)
        .map_err(|error| (error.code(), FailureMode::Startup { automatic: false }))?;
    let install_root = context.install_root;
    let automatic = startup.start_minimized && !startup.delay.is_zero();
    let runner = NativeBridgeProcessRunner::new(&install_root)
        .map_err(|error| (error.code(), FailureMode::Startup { automatic }))?;
    let launched_version = LauncherEngine::new(&install_root, runner)
        .map_err(|error| (error.code(), FailureMode::Startup { automatic }))?
        .launch(startup.start_minimized)
        .map_err(|error| (error.code(), FailureMode::Startup { automatic }))?;
    if context.staged_version.as_deref() == Some(launched_version.as_str())
        && let Err(error) = bridge_update::promote_staged_launcher(&executable, &launched_version)
    {
        record_launcher_promotion_failure(&install_root, &launched_version, error.code());
    }
    Ok(())
}

fn record_launcher_promotion_failure(install_root: &Path, version: &str, code: &'static str) {
    let Ok(store) = bridge_update::BridgeUpdateStateStore::new(
        install_root.join(bridge_update::UPDATE_STATE_FILE_NAME),
    ) else {
        return;
    };
    let _ = store.mark_launcher_state(
        bridge_update::STATE_HEALTHY,
        version,
        Some(code.to_owned()),
        true,
    );
}

fn run_interactive_uninstall() -> Result<(), (&'static str, FailureMode)> {
    let executable =
        current_launcher_executable().map_err(|code| (code, FailureMode::Uninstall))?;
    let layout = InstallationLayout::from_launcher(&executable)
        .map_err(|error| (error.code(), FailureMode::Uninstall))?;
    uninstall_preflight(&layout, &executable)
        .map_err(|error| (error.code(), FailureMode::Uninstall))?;
    let message = wide_null(
        "确认卸载量见智桥吗？\n\n选择“是”：卸载软件并保留授权、设置和日志。\n选择“否”：卸载软件并删除全部本地数据。\n选择“取消”：不卸载。",
    );
    let caption = wide_null("卸载量见智桥");
    let choice = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            caption.as_ptr(),
            MB_YESNOCANCEL | MB_ICONQUESTION,
        )
    };
    let data_mode = match choice {
        IDYES => DataRemovalMode::Keep,
        IDNO => DataRemovalMode::Remove,
        _ => return Ok(()),
    };
    spawn_uninstall_worker(&executable, &layout, data_mode)
        .map_err(|error| (error.code(), FailureMode::Uninstall))
}

fn run_worker_uninstall(
    request: liangjian_bridge_launcher::UninstallWorkerRequest,
) -> Result<(), (&'static str, FailureMode)> {
    let worker = std::env::current_exe().map_err(|_| {
        (
            "bridge_uninstall_executable_missing",
            FailureMode::Uninstall,
        )
    })?;
    let layout = InstallationLayout::for_install_root(&request.install_root)
        .map_err(|error| (error.code(), FailureMode::Uninstall))?;
    run_uninstall_worker(&request, &layout, &worker)
        .map_err(|error| (error.code(), FailureMode::Uninstall))?;
    show_message(
        "量见智桥已卸载完成。",
        "量见智桥",
        MB_OK | MB_ICONINFORMATION,
    );
    Ok(())
}

fn current_launcher_executable() -> Result<PathBuf, &'static str> {
    let executable = std::env::current_exe().map_err(|_| "launcher_executable_invalid")?;
    if executable.file_name().and_then(|value| value.to_str()) != Some("AURUMBridge.Launcher.exe") {
        return Err("launcher_executable_invalid");
    }
    Ok(executable)
}

fn fail_startup(code: &'static str, automatic: bool) {
    if !automatic {
        show_message(
            "量见智桥启动失败，且无法自动恢复上一个版本。请运行修复安装。",
            "量见智桥",
            MB_OK | MB_ICONERROR,
        );
    }
    eprintln!("{code}");
    std::process::exit(1);
}

fn fail_uninstall(code: &'static str) {
    let message = match code {
        "bridge_uninstall_entry_invalid" => "卸载入口无效，请从 Windows“应用和功能”中重新操作。",
        "bridge_uninstall_process_running" => "请先在托盘菜单中退出量见智桥，然后重新卸载。",
        "bridge_uninstall_installation_invalid" => "未找到完整的量见智桥安装目录。",
        _ => "卸载未完成，请重启电脑后重试。",
    };
    show_message(message, "量见智桥", MB_OK | MB_ICONERROR);
    eprintln!("{code}");
    std::process::exit(1);
}

fn show_message(message: &str, caption: &str, style: u32) {
    let message = wide_null(message);
    let caption = wide_null(caption);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            caption.as_ptr(),
            style,
        );
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}
