#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use liangjian_bridge_launcher::{
    LauncherEngine, LauncherStartupOptions, NativeBridgeProcessRunner,
};
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::thread;
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let automatic_startup = arguments.len() == 1 && arguments[0] == "--autostart";
    if let Err(code) = run(arguments) {
        if !automatic_startup {
            show_startup_failure();
        }
        eprintln!("{code}");
        std::process::exit(1);
    }
}

fn run(arguments: Vec<OsString>) -> Result<(), &'static str> {
    let arguments = arguments
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "launcher_arguments_invalid")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let startup = LauncherStartupOptions::parse(&arguments).map_err(|error| error.code())?;
    if !startup.delay.is_zero() {
        thread::sleep(startup.delay);
    }
    let executable = std::env::current_exe().map_err(|_| "launcher_executable_invalid")?;
    let install_root = executable
        .parent()
        .map(PathBuf::from)
        .ok_or("launcher_install_root_invalid")?;
    if executable.file_name().and_then(|value| value.to_str()) != Some("AURUMBridge.Launcher.exe") {
        return Err("launcher_executable_invalid");
    }
    let runner = NativeBridgeProcessRunner::new(&install_root).map_err(|error| error.code())?;
    LauncherEngine::new(&install_root, runner)
        .map_err(|error| error.code())?
        .launch(startup.start_minimized)
        .map_err(|error| error.code())?;
    Ok(())
}

fn show_startup_failure() {
    let message = wide_null("量见智桥启动失败，且无法自动恢复上一个版本。请运行修复安装。");
    let caption = wide_null("量见智桥");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}
