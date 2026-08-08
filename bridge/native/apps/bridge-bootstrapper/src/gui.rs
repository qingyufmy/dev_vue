use liangjian_bridge_installer::{
    InstallOutcome, InstallerConfiguration, InstallerError, OnlineInstaller,
    describe_installer_error, start_launcher, write_failure_log,
};
use std::ptr::{null, null_mut};
use std::thread;
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH,
    DEFAULT_QUALITY, DeleteObject, FF_DONTCARE, FW_BOLD, FW_NORMAL, HBRUSH, OUT_DEFAULT_PRECIS,
    SetBkMode, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    InitCommonControls, PBM_SETMARQUEE, PBM_SETPOS, PBS_MARQUEE, PROGRESS_CLASSW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyIcon,
    DestroyWindow, DispatchMessageW, GWLP_USERDATA, GetMessageW, GetWindowLongPtrW, HICON, HMENU,
    IDC_ARROW, IMAGE_ICON, LR_DEFAULTCOLOR, LoadCursorW, LoadImageW, MB_ICONERROR, MB_OK, MSG,
    MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassExW, SW_HIDE, SW_SHOW, SendMessageW,
    SetTimer, SetWindowLongPtrW, SetWindowTextW, ShowWindow, TranslateMessage, WM_APP, WM_CLOSE,
    WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_DESTROY, WM_NCCREATE, WM_NCDESTROY, WM_SETFONT,
    WM_TIMER, WNDCLASSEXW, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_OVERLAPPED, WS_SYSMENU,
    WS_TABSTOP, WS_VISIBLE,
};

const WINDOW_CLASS: &str = "LiangJianBridgeNativeBootstrapper";
const WINDOW_TITLE: &str = "量见智桥安装程序";
const PRODUCT_NAME: &str = "量见智桥";
const INITIAL_STATUS: &str = "正在准备安装…";
const RETRY_TEXT: &str = "重试安装";
const FAILURE_TITLE: &str = "量见智桥安装失败";
const WINDOW_WIDTH: i32 = 536;
const WINDOW_HEIGHT: i32 = 252;
const CONTROL_RETRY: i32 = 1001;
const TIMER_CLOSE: usize = 1;
const WM_INSTALL_STATUS: u32 = WM_APP + 1;
const WM_INSTALL_COMPLETE: u32 = WM_APP + 2;

struct Completion {
    result: Result<InstallOutcome, InstallerError>,
}

struct BootstrapperState {
    configuration: InstallerConfiguration,
    server_url: String,
    status: HWND,
    progress: HWND,
    retry: HWND,
    body_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    title_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    background_brush: HBRUSH,
    icon: HICON,
    running: bool,
}

pub fn run(configuration: InstallerConfiguration, server_url: &str) -> Result<(), InstallerError> {
    OnlineInstaller::new(configuration.clone(), server_url)?;
    let instance = unsafe { GetModuleHandleW(null()) };
    if instance.is_null() {
        return Err(InstallerError::new("bootstrap_window_create_failed"));
    }
    let icon = load_brand_icon(instance);
    register_window_class(instance, icon)?;
    let state = Box::new(BootstrapperState {
        configuration,
        server_url: server_url.to_owned(),
        status: null_mut(),
        progress: null_mut(),
        retry: null_mut(),
        body_font: create_font(10, FW_NORMAL as i32),
        title_font: create_font(17, FW_BOLD as i32),
        background_brush: unsafe { CreateSolidBrush(0x00ff_ffff) },
        icon,
        running: false,
    });
    let state_pointer = Box::into_raw(state);
    let screen_width = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
            windows_sys::Win32::UI::WindowsAndMessaging::SM_CXSCREEN,
        )
    };
    let screen_height = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(
            windows_sys::Win32::UI::WindowsAndMessaging::SM_CYSCREEN,
        )
    };
    let class_name = wide(WINDOW_CLASS);
    let title = wide(WINDOW_TITLE);
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN,
            (screen_width - WINDOW_WIDTH) / 2,
            (screen_height - WINDOW_HEIGHT) / 2,
            WINDOW_WIDTH,
            WINDOW_HEIGHT,
            null_mut(),
            null_mut(),
            instance,
            state_pointer.cast(),
        )
    };
    if hwnd.is_null() {
        unsafe { drop(Box::from_raw(state_pointer)) };
        return Err(InstallerError::new("bootstrap_window_create_failed"));
    }
    unsafe { ShowWindow(hwnd, SW_SHOW) };
    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
        if result <= 0 {
            break;
        }
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

fn register_window_class(instance: HINSTANCE, icon: HICON) -> Result<(), InstallerError> {
    let class_name = wide(WINDOW_CLASS);
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: icon,
        hCursor: unsafe { LoadCursorW(null_mut(), IDC_ARROW) },
        hbrBackground: unsafe { CreateSolidBrush(0x00ff_ffff) },
        lpszMenuName: null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: icon,
    };
    if unsafe { RegisterClassExW(&class) } != 0
        || unsafe { GetLastError() } == ERROR_CLASS_ALREADY_EXISTS
    {
        Ok(())
    } else {
        Err(InstallerError::new("bootstrap_window_class_failed"))
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam as *const CREATESTRUCTW;
        if !create.is_null() {
            let state = unsafe { (*create).lpCreateParams as *mut BootstrapperState };
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize) };
        }
    }
    let state_pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut BootstrapperState;
    if state_pointer.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    if message == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
        let state = unsafe { Box::from_raw(state_pointer) };
        cleanup_state(*state);
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    let state = unsafe { &mut *state_pointer };
    match message {
        WM_CREATE => {
            unsafe { create_controls(hwnd, state) };
            begin_install(hwnd, state);
            0
        }
        WM_COMMAND if (wparam & 0xffff) as i32 == CONTROL_RETRY => {
            begin_install(hwnd, state);
            0
        }
        WM_INSTALL_STATUS => {
            let value = unsafe { Box::from_raw(lparam as *mut String) };
            set_text(state.status, &value);
            0
        }
        WM_INSTALL_COMPLETE => {
            let completion = unsafe { Box::from_raw(lparam as *mut Completion) };
            finish_install(hwnd, state, completion.result);
            0
        }
        WM_CTLCOLORSTATIC => {
            unsafe { SetBkMode(wparam as _, TRANSPARENT as i32) };
            state.background_brush as LRESULT
        }
        WM_TIMER if wparam == TIMER_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_CLOSE if state.running => 0,
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut BootstrapperState) {
    unsafe { InitCommonControls() };
    let static_class = wide("STATIC");
    let button_class = wide("BUTTON");
    let product = wide(PRODUCT_NAME);
    let status = wide(INITIAL_STATUS);
    let retry = wide(RETRY_TEXT);
    let title = unsafe {
        CreateWindowExW(
            0,
            static_class.as_ptr(),
            product.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            32,
            24,
            456,
            36,
            hwnd,
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    state.status = unsafe {
        CreateWindowExW(
            0,
            static_class.as_ptr(),
            status.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            32,
            76,
            456,
            52,
            hwnd,
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    state.progress = unsafe {
        CreateWindowExW(
            0,
            PROGRESS_CLASSW,
            null(),
            WS_CHILD | WS_VISIBLE | PBS_MARQUEE,
            32,
            138,
            456,
            10,
            hwnd,
            null_mut(),
            null_mut(),
            null_mut(),
        )
    };
    state.retry = unsafe {
        CreateWindowExW(
            0,
            button_class.as_ptr(),
            retry.as_ptr(),
            WS_CHILD | WS_TABSTOP,
            368,
            166,
            120,
            36,
            hwnd,
            CONTROL_RETRY as HMENU,
            null_mut(),
            null_mut(),
        )
    };
    unsafe {
        SendMessageW(title, WM_SETFONT, state.title_font as usize, 1);
        SendMessageW(state.status, WM_SETFONT, state.body_font as usize, 1);
        SendMessageW(state.retry, WM_SETFONT, state.body_font as usize, 1);
        SendMessageW(state.progress, PBM_SETMARQUEE, 1, 24);
        ShowWindow(state.retry, SW_HIDE);
    }
}

fn begin_install(hwnd: HWND, state: &mut BootstrapperState) {
    if state.running {
        return;
    }
    state.running = true;
    set_text(state.status, INITIAL_STATUS);
    unsafe {
        ShowWindow(state.retry, SW_HIDE);
        SendMessageW(state.progress, PBM_SETPOS, 0, 0);
        SendMessageW(state.progress, PBM_SETMARQUEE, 1, 24);
    }
    let configuration = state.configuration.clone();
    let server_url = state.server_url.clone();
    let window = hwnd as usize;
    thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build();
        let result = match runtime {
            Ok(runtime) => runtime.block_on(async {
                let installer = OnlineInstaller::new(configuration, &server_url)?;
                installer.install(&|value| post_status(window, value)).await
            }),
            Err(_) => Err(InstallerError::new("bootstrap_runtime_failed")),
        };
        post_completion(window, result);
    });
}

fn finish_install(
    hwnd: HWND,
    state: &mut BootstrapperState,
    result: Result<InstallOutcome, InstallerError>,
) {
    unsafe { SendMessageW(state.progress, PBM_SETMARQUEE, 0, 0) };
    match result {
        Ok(outcome) => {
            unsafe { SendMessageW(state.progress, PBM_SETPOS, 100, 0) };
            set_text(
                state.status,
                &format!("安装完成，正在启动量见智桥 {}…", outcome.version),
            );
            if let Err(error) = start_launcher(&outcome.install_root) {
                show_failure(hwnd, state, error);
                return;
            }
            state.running = false;
            unsafe { SetTimer(hwnd, TIMER_CLOSE, 800, None) };
        }
        Err(error) => show_failure(hwnd, state, error),
    }
}

fn show_failure(hwnd: HWND, state: &mut BootstrapperState, error: InstallerError) {
    state.running = false;
    write_failure_log(error);
    unsafe {
        SendMessageW(state.progress, PBM_SETPOS, 0, 0);
        ShowWindow(state.retry, SW_SHOW);
    }
    let description = describe_installer_error(error);
    set_text(state.status, description);
    let message = wide(description);
    let title = wide(FAILURE_TITLE);
    unsafe { MessageBoxW(hwnd, message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}

fn post_status(hwnd: usize, value: &str) {
    let payload = Box::into_raw(Box::new(value.to_owned()));
    if unsafe { PostMessageW(hwnd as HWND, WM_INSTALL_STATUS, 0, payload as LPARAM) } == 0 {
        unsafe { drop(Box::from_raw(payload)) };
    }
}

fn post_completion(hwnd: usize, result: Result<InstallOutcome, InstallerError>) {
    let payload = Box::into_raw(Box::new(Completion { result }));
    if unsafe { PostMessageW(hwnd as HWND, WM_INSTALL_COMPLETE, 0, payload as LPARAM) } == 0 {
        unsafe { drop(Box::from_raw(payload)) };
    }
}

fn cleanup_state(state: BootstrapperState) {
    unsafe {
        if !state.body_font.is_null() {
            DeleteObject(state.body_font as _);
        }
        if !state.title_font.is_null() {
            DeleteObject(state.title_font as _);
        }
        if !state.background_brush.is_null() {
            DeleteObject(state.background_brush as _);
        }
        if !state.icon.is_null() {
            DestroyIcon(state.icon);
        }
    }
}

fn create_font(points: i32, weight: i32) -> windows_sys::Win32::Graphics::Gdi::HFONT {
    let family = wide("Microsoft YaHei UI");
    unsafe {
        CreateFontW(
            -((points * 96) / 72),
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            u32::from(DEFAULT_CHARSET),
            u32::from(OUT_DEFAULT_PRECIS),
            u32::from(CLIP_DEFAULT_PRECIS),
            u32::from(DEFAULT_QUALITY),
            u32::from(DEFAULT_PITCH | FF_DONTCARE),
            family.as_ptr(),
        )
    }
}

fn load_brand_icon(instance: HINSTANCE) -> HICON {
    unsafe {
        LoadImageW(
            instance,
            std::ptr::without_provenance::<u16>(1),
            IMAGE_ICON,
            32,
            32,
            LR_DEFAULTCOLOR,
        ) as HICON
    }
}

fn set_text(control: HWND, value: &str) {
    let value = wide(value);
    unsafe { SetWindowTextW(control, value.as_ptr()) };
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_and_chinese_contract_match_the_dotnet_bootstrapper() {
        assert_eq!((WINDOW_WIDTH, WINDOW_HEIGHT), (536, 252));
        assert_eq!(WINDOW_TITLE, "量见智桥安装程序");
        assert_eq!(INITIAL_STATUS, "正在准备安装…");
        assert_eq!(RETRY_TEXT, "重试安装");
        assert_eq!(FAILURE_TITLE, "量见智桥安装失败");
    }

    #[test]
    fn security_and_integrity_failures_keep_the_existing_user_copy() {
        assert_eq!(
            describe_installer_error(InstallerError::new("update_manifest_signature_invalid")),
            "安装包安全校验失败，已停止安装。"
        );
        assert_eq!(
            describe_installer_error(InstallerError::new("update_package_size_mismatch")),
            "安装包下载不完整，请检查网络后重试。"
        );
    }
}
