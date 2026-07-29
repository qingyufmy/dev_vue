use bridge_observability::BridgeLogReader;
use std::fs;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH,
    DEFAULT_QUALITY, DeleteObject, FF_DONTCARE, FW_BOLD, FW_NORMAL, GetMonitorInfoW,
    GetStockObject, HBRUSH, HGDIOBJ, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
    OUT_DEFAULT_PRECIS, SetBkColor, SetTextColor, WHITE_BRUSH,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    BST_CHECKED, EM_GETSEL, EM_SCROLLCARET, EM_SETLIMITTEXT, EM_SETSEL, InitCommonControls,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, GetKeyState, SetFocus, VK_SHIFT, VK_TAB,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BM_GETCHECK, BM_SETCHECK, BS_AUTOCHECKBOX, CREATESTRUCTW, CS_HREDRAW,
    CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow, ES_AUTOHSCROLL,
    ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, GWLP_USERDATA, GetClientRect, GetDlgCtrlID,
    GetNextDlgTabItem, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, HICON, HMENU,
    IDC_ARROW, IsChild, IsWindow, KillTimer, LoadCursorW, MINMAXINFO, MoveWindow, PostMessageW,
    RegisterClassExW, SB_LEFT, SW_SHOW, SW_SHOWNORMAL, SendMessageW, SetForegroundWindow, SetTimer,
    SetWindowLongPtrW, SetWindowTextW, ShowWindow, WM_APP, WM_CLOSE, WM_COMMAND, WM_COPY,
    WM_CREATE, WM_CTLCOLORSTATIC, WM_DPICHANGED, WM_DRAWITEM, WM_GETMINMAXINFO, WM_HSCROLL,
    WM_KEYDOWN, WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_SETFONT, WM_SIZE, WM_TIMER, WNDCLASSEXW,
    WS_BORDER, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_HSCROLL, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
    WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME, WS_VISIBLE, WS_VSCROLL,
};

use super::{PRODUCT_NAME, Rgb, draw_button, draw_text, fill, rect, scale, wide, window_dpi};

const WINDOW_CLASS: &str = "LiangJianBridgeNativeLogViewer";
const WINDOW_CLIENT_WIDTH: i32 = 780;
const WINDOW_CLIENT_HEIGHT: i32 = 520;
const WINDOW_MIN_WIDTH: i32 = 640;
const WINDOW_MIN_HEIGHT: i32 = 420;
const CONTROL_CONTENT: i32 = 2000;
const CONTROL_REFRESH: i32 = 2001;
const CONTROL_COPY: i32 = 2002;
const CONTROL_AUTO_REFRESH: i32 = 2003;
const TIMER_AUTO_REFRESH: usize = 1;
const WM_LOG_READY: u32 = WM_APP + 20;
const WM_LOG_REFRESH_REQUEST: u32 = WM_APP + 21;

struct LogViewerState {
    dpi: u32,
    reader: BridgeLogReader,
    inbox: Arc<Mutex<Option<Result<String, &'static str>>>>,
    refresh_running: Arc<AtomicBool>,
    lifetime_transferred: Arc<AtomicBool>,
    content: HWND,
    refresh: HWND,
    copy: HWND,
    auto_refresh: HWND,
    body_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    title_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    mono_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    background_brush: HBRUSH,
    refresh_status: String,
}

fn is_content_tab_message(message: u32, key: WPARAM, control_id: i32) -> bool {
    message == WM_KEYDOWN && key == usize::from(VK_TAB) && control_id == CONTROL_CONTENT
}

pub(super) unsafe fn handle_dialog_tab(
    log_window: HWND,
    message_window: HWND,
    message: u32,
    key: WPARAM,
) -> bool {
    if log_window.is_null()
        || message_window.is_null()
        || message != WM_KEYDOWN
        || key != usize::from(VK_TAB)
    {
        return false;
    }
    if unsafe { IsWindow(log_window) } == 0
        || unsafe { IsChild(log_window, message_window) } == 0
        || !is_content_tab_message(message, key, unsafe { GetDlgCtrlID(message_window) })
    {
        return false;
    }
    let previous = unsafe { GetKeyState(VK_SHIFT as i32) } < 0;
    let next = unsafe { GetNextDlgTabItem(log_window, message_window, i32::from(previous)) };
    if next.is_null() {
        return false;
    }
    unsafe { SetFocus(next) };
    true
}

pub(super) unsafe fn show_or_refresh(
    existing: HWND,
    owner: HWND,
    log_directory: &Path,
    icon: HICON,
) -> Result<HWND, &'static str> {
    if !existing.is_null() && unsafe { IsWindow(existing) } != 0 {
        unsafe {
            ShowWindow(existing, SW_SHOWNORMAL);
            SetForegroundWindow(existing);
            PostMessageW(existing, WM_LOG_REFRESH_REQUEST, 0, 0);
        }
        return Ok(existing);
    }
    fs::create_dir_all(log_directory).map_err(|_| "bridge_log_directory_failed")?;
    let reader = BridgeLogReader::new(log_directory).map_err(|error| error.code())?;
    let instance = unsafe { GetModuleHandleW(null()) };
    register_window_class(instance, icon)?;
    let lifetime_transferred = Arc::new(AtomicBool::new(false));
    let dpi = window_dpi(owner);
    let state = Box::new(LogViewerState {
        dpi,
        reader,
        inbox: Arc::new(Mutex::new(None)),
        refresh_running: Arc::new(AtomicBool::new(false)),
        lifetime_transferred: Arc::clone(&lifetime_transferred),
        content: null_mut(),
        refresh: null_mut(),
        copy: null_mut(),
        auto_refresh: null_mut(),
        body_font: create_point_font("Microsoft YaHei UI", 90, dpi, FW_NORMAL as i32),
        title_font: create_point_font("Microsoft YaHei UI", 120, dpi, FW_BOLD as i32),
        mono_font: create_point_font("Consolas", 90, dpi, FW_NORMAL as i32),
        background_brush: unsafe { CreateSolidBrush(color_ref(Rgb(248, 250, 252))) },
        refresh_status: "等待刷新".to_owned(),
    });
    let state_pointer = Box::into_raw(state);
    let style = WS_OVERLAPPED
        | WS_CAPTION
        | WS_SYSMENU
        | WS_THICKFRAME
        | WS_MINIMIZEBOX
        | WS_MAXIMIZEBOX
        | WS_CLIPCHILDREN;
    let mut outer = RECT {
        left: 0,
        top: 0,
        right: scale(WINDOW_CLIENT_WIDTH, dpi),
        bottom: scale(WINDOW_CLIENT_HEIGHT, dpi),
    };
    unsafe { AdjustWindowRectEx(&mut outer, style, 0, 0) };
    let width = outer.right - outer.left;
    let height = outer.bottom - outer.top;
    let (x, y) = centered_position(owner, width, height);
    let class_name = wide(WINDOW_CLASS);
    let title = wide(&format!("{PRODUCT_NAME}日志"));
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            style,
            x,
            y,
            width,
            height,
            owner,
            null_mut(),
            instance,
            state_pointer.cast(),
        )
    };
    if hwnd.is_null() {
        if !lifetime_transferred.load(Ordering::Acquire) {
            unsafe { drop(Box::from_raw(state_pointer)) };
        }
        return Err("bridge_log_window_create_failed");
    }
    unsafe {
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
    }
    Ok(hwnd)
}

fn register_window_class(instance: HINSTANCE, icon: HICON) -> Result<(), &'static str> {
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
        hbrBackground: unsafe { GetStockObject(WHITE_BRUSH) } as HBRUSH,
        lpszMenuName: null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: icon,
    };
    if unsafe { RegisterClassExW(&class) } != 0
        || unsafe { GetLastError() } == ERROR_CLASS_ALREADY_EXISTS
    {
        Ok(())
    } else {
        Err("bridge_log_window_class_failed")
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
            let state_pointer = unsafe { (*create).lpCreateParams as *mut LogViewerState };
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_pointer as isize) };
            if !state_pointer.is_null() {
                unsafe {
                    (*state_pointer)
                        .lifetime_transferred
                        .store(true, Ordering::Release)
                };
            }
        }
    }
    let state_pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut LogViewerState;
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
            unsafe {
                InitCommonControls();
                create_controls(hwnd, state);
                layout_controls(hwnd, state);
                update_auto_refresh_timer(hwnd, state);
                begin_reload(hwnd, state);
            }
            0
        }
        WM_SIZE => {
            unsafe { layout_controls(hwnd, state) };
            0
        }
        WM_DPICHANGED => {
            let new_dpi = (wparam & 0xffff) as u32;
            let suggested = lparam as *const RECT;
            if new_dpi >= 96 && !suggested.is_null() {
                unsafe {
                    apply_dpi(state, new_dpi);
                    let bounds = *suggested;
                    MoveWindow(
                        hwnd,
                        bounds.left,
                        bounds.top,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        1,
                    );
                    layout_controls(hwnd, state);
                }
            }
            0
        }
        WM_GETMINMAXINFO => {
            let info = lparam as *mut MINMAXINFO;
            if !info.is_null() {
                unsafe {
                    (*info).ptMinTrackSize.x = scale(WINDOW_MIN_WIDTH, state.dpi);
                    (*info).ptMinTrackSize.y = scale(WINDOW_MIN_HEIGHT, state.dpi);
                }
            }
            0
        }
        WM_TIMER if wparam == TIMER_AUTO_REFRESH => {
            unsafe { begin_reload(hwnd, state) };
            0
        }
        WM_LOG_REFRESH_REQUEST => {
            unsafe { begin_reload(hwnd, state) };
            0
        }
        WM_LOG_READY => {
            unsafe { receive_reload(hwnd, state) };
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xffff) as i32;
            match id {
                CONTROL_REFRESH => unsafe { begin_reload(hwnd, state) },
                CONTROL_COPY => unsafe { copy_all(state.content) },
                CONTROL_AUTO_REFRESH => unsafe { update_auto_refresh_timer(hwnd, state) },
                _ => {}
            }
            0
        }
        WM_DRAWITEM => unsafe { draw_button(lparam, false) },
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            unsafe {
                SetBkColor(hdc, color_ref(Rgb(248, 250, 252)));
                SetTextColor(hdc, color_ref(Rgb(30, 41, 59)));
            }
            state.background_brush as LRESULT
        }
        WM_PAINT => {
            unsafe { paint_window(hwnd, state) };
            0
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut LogViewerState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    let edit_class = wide("EDIT");
    state.content = unsafe {
        CreateWindowExW(
            0,
            edit_class.as_ptr(),
            null(),
            WS_CHILD
                | WS_VISIBLE
                | WS_TABSTOP
                | WS_BORDER
                | WS_VSCROLL
                | WS_HSCROLL
                | ES_MULTILINE as u32
                | ES_AUTOVSCROLL as u32
                | ES_AUTOHSCROLL as u32
                | ES_READONLY as u32,
            0,
            0,
            100,
            100,
            hwnd,
            CONTROL_CONTENT as HMENU,
            instance,
            null(),
        )
    };
    state.refresh = super::create_button(hwnd, instance, CONTROL_REFRESH, "刷新");
    state.copy = super::create_button(hwnd, instance, CONTROL_COPY, "复制全部");
    let button_class = wide("BUTTON");
    let auto_text = wide("自动刷新");
    state.auto_refresh = unsafe {
        CreateWindowExW(
            0,
            button_class.as_ptr(),
            auto_text.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX as u32,
            0,
            0,
            100,
            36,
            hwnd,
            CONTROL_AUTO_REFRESH as HMENU,
            instance,
            null(),
        )
    };
    unsafe {
        SendMessageW(state.content, WM_SETFONT, state.mono_font as usize, 1);
        SendMessageW(state.content, EM_SETLIMITTEXT, 10 * 1024 * 1024, 0);
        SendMessageW(state.refresh, WM_SETFONT, state.body_font as usize, 1);
        SendMessageW(state.copy, WM_SETFONT, state.body_font as usize, 1);
        SendMessageW(state.auto_refresh, WM_SETFONT, state.body_font as usize, 1);
        SendMessageW(state.auto_refresh, BM_SETCHECK, BST_CHECKED as usize, 0);
    }
}

unsafe fn layout_controls(hwnd: HWND, state: &LogViewerState) {
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    let s = |value| scale(value, state.dpi);
    let content_bottom = (height - s(68)).max(s(96));
    unsafe {
        MoveWindow(
            state.content,
            s(20),
            s(56),
            (width - s(40)).max(s(100)),
            (content_bottom - s(56)).max(s(40)),
            1,
        );
        MoveWindow(
            state.refresh,
            width - s(116),
            height - s(56),
            s(96),
            s(36),
            1,
        );
        MoveWindow(state.copy, width - s(220), height - s(56), s(96), s(36), 1);
        MoveWindow(
            state.auto_refresh,
            (width - s(332)).max(s(20)),
            height - s(56),
            s(104),
            s(36),
            1,
        );
        ShowWindow(state.refresh, SW_SHOW);
        ShowWindow(state.copy, SW_SHOW);
    }
    unsafe { windows_sys::Win32::Graphics::Gdi::InvalidateRect(hwnd, null(), 1) };
}

unsafe fn paint_window(hwnd: HWND, state: &LogViewerState) {
    let mut paint = windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT::default();
    let hdc = unsafe { windows_sys::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint) };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let s = |value| scale(value, state.dpi);
    fill(hdc, client, Rgb(248, 250, 252));
    draw_text(
        hdc,
        "运行日志",
        rect(s(20), s(18), client.right - s(180), s(44)),
        state.title_font,
        Rgb(15, 23, 42),
        windows_sys::Win32::Graphics::Gdi::DT_LEFT
            | windows_sys::Win32::Graphics::Gdi::DT_SINGLELINE
            | windows_sys::Win32::Graphics::Gdi::DT_VCENTER,
    );
    draw_text(
        hdc,
        &state.refresh_status,
        rect(client.right - s(220), s(18), client.right - s(20), s(44)),
        state.body_font,
        Rgb(100, 116, 139),
        windows_sys::Win32::Graphics::Gdi::DT_RIGHT
            | windows_sys::Win32::Graphics::Gdi::DT_SINGLELINE
            | windows_sys::Win32::Graphics::Gdi::DT_VCENTER,
    );
    unsafe { windows_sys::Win32::Graphics::Gdi::EndPaint(hwnd, &paint) };
}

unsafe fn apply_dpi(state: &mut LogViewerState, dpi: u32) {
    let body = create_point_font("Microsoft YaHei UI", 90, dpi, FW_NORMAL as i32);
    let title = create_point_font("Microsoft YaHei UI", 120, dpi, FW_BOLD as i32);
    let mono = create_point_font("Consolas", 90, dpi, FW_NORMAL as i32);
    unsafe {
        SendMessageW(state.content, WM_SETFONT, mono as usize, 1);
        for control in [state.refresh, state.copy, state.auto_refresh] {
            SendMessageW(control, WM_SETFONT, body as usize, 1);
        }
    }
    let previous = [state.body_font, state.title_font, state.mono_font];
    state.dpi = dpi;
    state.body_font = body;
    state.title_font = title;
    state.mono_font = mono;
    for font in previous {
        if !font.is_null() {
            unsafe { DeleteObject(font as HGDIOBJ) };
        }
    }
}

unsafe fn begin_reload(hwnd: HWND, state: &LogViewerState) {
    if state.refresh_running.swap(true, Ordering::AcqRel) {
        return;
    }
    let busy = wide("正在刷新…");
    unsafe {
        EnableWindow(state.refresh, 0);
        SetWindowTextW(state.refresh, busy.as_ptr());
    }
    let reader = state.reader.clone();
    let inbox = Arc::clone(&state.inbox);
    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        let result = reader.read_recent_text(None).map_err(|error| error.code());
        if let Ok(mut slot) = inbox.lock() {
            *slot = Some(result);
        }
        unsafe { PostMessageW(hwnd_value as HWND, WM_LOG_READY, 0, 0) };
    });
}

unsafe fn receive_reload(hwnd: HWND, state: &mut LogViewerState) {
    let result = state.inbox.lock().ok().and_then(|mut slot| slot.take());
    match result {
        Some(Ok(text)) => {
            set_content(state.content, &text);
            state.refresh_status =
                format!("已更新 {}", super::format_local_time(super::now_utc_msc()));
        }
        Some(Err(_)) => {
            set_content(state.content, "暂时无法读取日志，请稍后重试。");
            state.refresh_status = "刷新失败".to_owned();
        }
        None => return,
    }
    state.refresh_running.store(false, Ordering::Release);
    let refresh = wide("刷新");
    unsafe {
        SetWindowTextW(state.refresh, refresh.as_ptr());
        EnableWindow(state.refresh, 1);
        windows_sys::Win32::Graphics::Gdi::InvalidateRect(hwnd, null(), 1);
    }
}

fn set_content(content: HWND, text: &str) {
    let value = wide(text);
    let end = value.len().saturating_sub(1);
    unsafe {
        SetWindowTextW(content, value.as_ptr());
        SendMessageW(content, EM_SETSEL, end, end as isize);
        SendMessageW(content, EM_SCROLLCARET, 0, 0);
        SendMessageW(content, WM_HSCROLL, SB_LEFT as usize, 0);
    }
}

unsafe fn copy_all(content: HWND) {
    let length = unsafe { GetWindowTextLengthW(content) };
    if length <= 0 {
        return;
    }
    let mut selection_start = 0_u32;
    let mut selection_end = 0_u32;
    unsafe {
        SendMessageW(
            content,
            EM_GETSEL,
            (&mut selection_start as *mut u32) as usize,
            (&mut selection_end as *mut u32) as isize,
        );
        SendMessageW(content, EM_SETSEL, 0, -1);
        SendMessageW(content, WM_COPY, 0, 0);
        SendMessageW(
            content,
            EM_SETSEL,
            selection_start as usize,
            selection_end as isize,
        );
    }
}

unsafe fn update_auto_refresh_timer(hwnd: HWND, state: &LogViewerState) {
    let checked =
        unsafe { SendMessageW(state.auto_refresh, BM_GETCHECK, 0, 0) } as u32 == BST_CHECKED;
    unsafe { KillTimer(hwnd, TIMER_AUTO_REFRESH) };
    if checked {
        unsafe { SetTimer(hwnd, TIMER_AUTO_REFRESH, 3_000, None) };
    }
}

fn cleanup_state(state: LogViewerState) {
    for font in [state.body_font, state.title_font, state.mono_font] {
        if !font.is_null() {
            unsafe { DeleteObject(font as HGDIOBJ) };
        }
    }
    if !state.background_brush.is_null() {
        unsafe { DeleteObject(state.background_brush as HGDIOBJ) };
    }
}

fn centered_position(owner: HWND, width: i32, height: i32) -> (i32, i32) {
    if owner.is_null() || unsafe { IsWindow(owner) } == 0 {
        return (CW_USEDEFAULT, CW_USEDEFAULT);
    }
    let mut owner_bounds = RECT::default();
    if unsafe { GetWindowRect(owner, &mut owner_bounds) } == 0 {
        return (CW_USEDEFAULT, CW_USEDEFAULT);
    }
    let centered_x = owner_bounds.left + (owner_bounds.right - owner_bounds.left - width) / 2;
    let centered_y = owner_bounds.top + (owner_bounds.bottom - owner_bounds.top - height) / 2;
    let monitor = unsafe { MonitorFromWindow(owner, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut monitor_info) } == 0 {
        return (centered_x, centered_y);
    }
    let work = monitor_info.rcWork;
    let max_x = (work.right - width).max(work.left);
    let max_y = (work.bottom - height).max(work.top);
    (
        centered_x.clamp(work.left, max_x),
        centered_y.clamp(work.top, max_y),
    )
}

fn create_point_font(
    family: &str,
    point_size_tenths: i32,
    dpi: u32,
    weight: i32,
) -> windows_sys::Win32::Graphics::Gdi::HFONT {
    let face = wide(family);
    let pixel_height = ((point_size_tenths as i64 * i64::from(dpi) + 360) / 720) as i32;
    unsafe {
        CreateFontW(
            -pixel_height,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET.into(),
            OUT_DEFAULT_PRECIS.into(),
            CLIP_DEFAULT_PRECIS.into(),
            DEFAULT_QUALITY.into(),
            (DEFAULT_PITCH | FF_DONTCARE).into(),
            face.as_ptr(),
        )
    }
}

fn color_ref(color: Rgb) -> u32 {
    color.0 as u32 | ((color.1 as u32) << 8) | ((color.2 as u32) << 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_viewer_geometry_tracks_dotnet_dpi_scaling() {
        assert_eq!(scale(WINDOW_CLIENT_WIDTH, 120), 975);
        assert_eq!(scale(WINDOW_CLIENT_HEIGHT, 144), 780);
        assert_eq!(scale(WINDOW_MIN_WIDTH, 120), 800);
        assert_eq!(scale(WINDOW_MIN_HEIGHT, 144), 630);
    }

    #[test]
    fn only_tab_from_the_multiline_log_content_needs_manual_dialog_navigation() {
        assert!(is_content_tab_message(
            WM_KEYDOWN,
            usize::from(VK_TAB),
            CONTROL_CONTENT
        ));
        assert!(!is_content_tab_message(
            WM_KEYDOWN,
            usize::from(VK_TAB),
            CONTROL_REFRESH
        ));
        assert!(!is_content_tab_message(
            WM_COMMAND,
            usize::from(VK_TAB),
            CONTROL_CONTENT
        ));
    }
}
