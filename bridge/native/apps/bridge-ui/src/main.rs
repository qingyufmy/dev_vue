#![windows_subsystem = "windows"]

use bridge_foundation::{DEFAULT_PROFILE_ID, validate_profile_id};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeClient, LocalControlRequest,
    LocalControlResult, UiStateSnapshot,
};
use bridge_ui_model::{
    AccountCardView, MainWindowView, ObserverAction, PRODUCT_NAME, Rgb, SAFETY_COPY,
    build_main_window_view, resolve_account_column_count,
};
use std::collections::BTreeSet;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    COLORREF, FILETIME, HINSTANCE, HWND, LPARAM, LRESULT, RECT, SYSTEMTIME, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH,
    DEFAULT_QUALITY, DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, DT_WORDBREAK,
    DeleteObject, DrawFocusRect, DrawTextW, FF_DONTCARE, FW_BOLD, FW_NORMAL, FillRect,
    GetStockObject, HBRUSH, HDC, HFONT, HGDIOBJ, InvalidateRect, OUT_DEFAULT_PRECIS, SelectObject,
    SetBkMode, SetTextColor, TRANSPARENT, WHITE_BRUSH,
};
use windows_sys::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Time::FileTimeToSystemTime;
use windows_sys::Win32::UI::Controls::{
    DRAWITEMSTRUCT, InitCommonControls, ODS_DISABLED, ODS_FOCUS, ODS_SELECTED, ODT_BUTTON,
    WC_COMBOBOXW,
};
use windows_sys::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
    ShellExecuteW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BS_OWNERDRAW, CBS_DROPDOWNLIST, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW,
    CW_USEDEFAULT, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyMenu, DestroyWindow, DispatchMessageW, DrawMenuBar, GWLP_USERDATA, GetClientRect,
    GetMessageW, GetWindowLongPtrW, HICON, HMENU, IDC_ARROW, IDI_APPLICATION, LR_DEFAULTCOLOR,
    LoadCursorW, LoadIconW, MF_STRING, MINMAXINFO, MSG, MoveWindow, PostMessageW, RegisterClassExW,
    SW_HIDE, SW_SHOW, SW_SHOWNORMAL, SetWindowLongPtrW, ShowWindow, TPM_BOTTOMALIGN, TPM_LEFTALIGN,
    TrackPopupMenu, TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE, WM_DESTROY,
    WM_DRAWITEM, WM_GETMINMAXINFO, WM_LBUTTONDBLCLK, WM_NCCREATE, WM_NCDESTROY, WM_PAINT,
    WM_RBUTTONUP, WM_SIZE, WM_TIMER, WNDCLASSEXW, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN,
    WS_EX_APPWINDOW, WS_MINIMIZEBOX, WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME, WS_VISIBLE,
};

const WINDOW_CLASS: &str = "LiangJianBridgeNativeUi";
const WINDOW_WIDTH: i32 = 620;
const WINDOW_HEIGHT: i32 = 700;
const WINDOW_MIN_WIDTH: i32 = 580;
const WINDOW_MIN_HEIGHT: i32 = 620;
const CONTROL_PLATFORM: i32 = 100;
const CONTROL_OBSERVER: i32 = 101;
const CONTROL_LOGOUT: i32 = 102;
const CONTROL_TERMINAL: i32 = 103;
const CONTROL_MT4_EXPERT: i32 = 104;
const CONTROL_UPDATE: i32 = 105;
const CONTROL_PAIR: i32 = 110;
const CONTROL_DETECT: i32 = 111;
const CONTROL_LOGS: i32 = 112;
const CONTROL_SETTINGS: i32 = 113;
const CONTROL_EXIT: i32 = 114;
const MENU_OPEN: usize = 201;
const MENU_EXIT: usize = 202;
const MENU_OPEN_COMMAND: i32 = MENU_OPEN as i32;
const MENU_EXIT_COMMAND: i32 = MENU_EXIT as i32;
const TIMER_POLL: usize = 1;
const WM_STATE_READY: u32 = WM_APP + 1;
const WM_ACTION_READY: u32 = WM_APP + 2;
const WM_TRAY: u32 = WM_APP + 3;

#[derive(Clone)]
enum UiMessage {
    State(Result<UiStateSnapshot, String>),
    Action {
        action: LocalControlAction,
        result: Result<LocalControlResult, String>,
    },
}

struct SharedInbox {
    message: Mutex<Option<UiMessage>>,
    poll_running: AtomicBool,
    sequence: AtomicU64,
}

struct Fonts {
    body: HFONT,
    body_bold: HFONT,
    heading: HFONT,
    title: HFONT,
    small: HFONT,
}

struct Controls {
    platform: HWND,
    observer: HWND,
    logout: HWND,
    terminal: HWND,
    mt4_expert: HWND,
    update: HWND,
    pair: HWND,
    detect: HWND,
    logs: HWND,
    settings: HWND,
    exit: HWND,
}

struct AppState {
    profile_id: String,
    state: UiStateSnapshot,
    view: MainWindowView,
    inbox: Arc<SharedInbox>,
    fonts: Fonts,
    controls: Controls,
    brand_icon: HICON,
    brand_icon_small: HICON,
    tray_added: bool,
}

fn main() {
    let profile_id = parse_profile_id();
    #[cfg(debug_assertions)]
    let state = if std::env::args().any(|argument| argument == "--demo") {
        demo_state(&profile_id)
    } else {
        initial_state(&profile_id)
    };
    #[cfg(not(debug_assertions))]
    let state = initial_state(&profile_id);
    let view = build_main_window_view(&state, &BTreeSet::new(), format_local_time)
        .expect("bridge_ui_initial_state_invalid");
    // SAFETY: the Win32 UI is created and driven on this thread only.
    unsafe {
        SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
        InitCommonControls();
        run_window(AppState {
            profile_id,
            state,
            view,
            inbox: Arc::new(SharedInbox {
                message: Mutex::new(None),
                poll_running: AtomicBool::new(false),
                sequence: AtomicU64::new(1),
            }),
            fonts: create_fonts(),
            controls: Controls::empty(),
            brand_icon: null_mut(),
            brand_icon_small: null_mut(),
            tray_added: false,
        });
    }
}

#[cfg(debug_assertions)]
fn demo_state(profile_id: &str) -> UiStateSnapshot {
    use bridge_local_control::{UiObserverProfile, UiTerminalCandidate, UiTerminalStatus};

    UiStateSnapshot {
        schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
        revision: 7,
        profile_id: profile_id.to_owned(),
        observed_at_utc_msc: now_utc_msc(),
        phase: "online".to_owned(),
        detail_code: None,
        selected_platform: Some("mt4".to_owned()),
        selected_terminal_instance_id: Some("mt4-main".to_owned()),
        terminal_candidates: vec![UiTerminalCandidate {
            terminal_instance_id: "mt4-main".to_owned(),
            platform: "mt4".to_owned(),
            broker_server: "DPrimeVU-Demo 5".to_owned(),
            login: "8950701".to_owned(),
            display_name: Some("8950701 · DPrimeVU-Demo 5".to_owned()),
        }],
        terminals: vec![
            UiTerminalStatus {
                terminal_instance_id: "mt4-main".to_owned(),
                platform: "mt4".to_owned(),
                broker_server: "DPrimeVU-Demo 5".to_owned(),
                login: "8950701".to_owned(),
                runtime_state: "running".to_owned(),
                error_code: None,
                observer_profile_id: None,
                terminal_trading_allowed: Some(true),
                program_trading_allowed: Some(true),
                account_trading_allowed: Some(true),
                account_expert_trading_allowed: Some(true),
                mt4_expert_restart_required: false,
            },
            UiTerminalStatus {
                terminal_instance_id: "observer-1-terminal".to_owned(),
                platform: "mt5".to_owned(),
                broker_server: "DooTechnology-Demo".to_owned(),
                login: "596520".to_owned(),
                runtime_state: "running".to_owned(),
                error_code: None,
                observer_profile_id: Some("source-1".to_owned()),
                terminal_trading_allowed: Some(false),
                program_trading_allowed: None,
                account_trading_allowed: Some(true),
                account_expert_trading_allowed: Some(true),
                mt4_expert_restart_required: false,
            },
        ],
        server_connected: true,
        last_data_sync_utc_msc: Some(now_utc_msc()),
        bridge_version: "3.0.0".to_owned(),
        can_manage_observer_sources: true,
        is_administrator: true,
        observer_profiles: vec![UiObserverProfile {
            observer_profile_id: "source-1".to_owned(),
            platform: Some("mt5".to_owned()),
            configured: true,
            enabled: true,
            terminal_instance_id: Some("observer-1-terminal".to_owned()),
            bridge_user_id: Some(9),
            observer_account_label: Some("一号观摩源".to_owned()),
            trading_account_label: Some("596520 · DooTechnology-Demo".to_owned()),
            runtime_phase: Some("online".to_owned()),
            runtime_detail_code: None,
        }],
        update_notice: None,
        autostart_enabled: true,
        custom_endpoint_active: false,
    }
}

fn parse_profile_id() -> String {
    let mut args = std::env::args().skip(1);
    let mut profile_id = DEFAULT_PROFILE_ID.to_owned();
    while let Some(argument) = args.next() {
        if argument == "--profile"
            && let Some(value) = args.next()
            && let Ok(validated) = validate_profile_id(Some(&value))
        {
            profile_id = validated;
        }
    }
    profile_id
}

fn initial_state(profile_id: &str) -> UiStateSnapshot {
    UiStateSnapshot {
        schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
        revision: 1,
        profile_id: profile_id.to_owned(),
        observed_at_utc_msc: now_utc_msc(),
        phase: "starting".to_owned(),
        detail_code: None,
        selected_platform: None,
        selected_terminal_instance_id: None,
        terminal_candidates: Vec::new(),
        terminals: Vec::new(),
        server_connected: false,
        last_data_sync_utc_msc: None,
        bridge_version: env!("CARGO_PKG_VERSION").to_owned(),
        can_manage_observer_sources: false,
        is_administrator: false,
        observer_profiles: Vec::new(),
        update_notice: None,
        autostart_enabled: false,
        custom_endpoint_active: false,
    }
}

impl Controls {
    fn empty() -> Self {
        Self {
            platform: null_mut(),
            observer: null_mut(),
            logout: null_mut(),
            terminal: null_mut(),
            mt4_expert: null_mut(),
            update: null_mut(),
            pair: null_mut(),
            detect: null_mut(),
            logs: null_mut(),
            settings: null_mut(),
            exit: null_mut(),
        }
    }
}

unsafe fn run_window(mut state: AppState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    state.brand_icon =
        load_brand_icon(32).unwrap_or_else(|| unsafe { LoadIconW(null_mut(), IDI_APPLICATION) });
    state.brand_icon_small =
        load_brand_icon(16).unwrap_or_else(|| unsafe { LoadIconW(null_mut(), IDI_APPLICATION) });
    let class_name = wide(WINDOW_CLASS);
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: state.brand_icon,
        hCursor: unsafe { LoadCursorW(null_mut(), IDC_ARROW) },
        hbrBackground: unsafe { GetStockObject(WHITE_BRUSH) } as HBRUSH,
        lpszMenuName: null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: state.brand_icon_small,
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        return;
    }
    let boxed = Box::new(state);
    let state_ptr = Box::into_raw(boxed);
    let title = wide(PRODUCT_NAME);
    let window_style = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_THICKFRAME | WS_CLIPCHILDREN;
    let mut outer = RECT {
        left: 0,
        top: 0,
        right: WINDOW_WIDTH,
        bottom: WINDOW_HEIGHT,
    };
    unsafe { AdjustWindowRectEx(&mut outer, window_style, 0, WS_EX_APPWINDOW) };
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_APPWINDOW,
            class_name.as_ptr(),
            title.as_ptr(),
            window_style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            outer.right - outer.left,
            outer.bottom - outer.top,
            null_mut(),
            null_mut(),
            instance,
            state_ptr.cast(),
        )
    };
    if hwnd.is_null() {
        unsafe { drop(Box::from_raw(state_ptr)) };
        return;
    }
    unsafe { ShowWindow(hwnd, SW_SHOW) };
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
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
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*create).lpCreateParams as isize) };
        }
    }
    let state_ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut AppState;
    if state_ptr.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    let state = unsafe { &mut *state_ptr };
    match message {
        WM_CREATE => {
            unsafe {
                create_controls(hwnd, state);
                add_tray_icon(hwnd, state);
                windows_sys::Win32::UI::WindowsAndMessaging::SetTimer(hwnd, TIMER_POLL, 500, None);
                begin_state_poll(hwnd, state);
                apply_layout(hwnd, state);
            }
            0
        }
        WM_SIZE => {
            unsafe { apply_layout(hwnd, state) };
            0
        }
        WM_GETMINMAXINFO => {
            let info = lparam as *mut MINMAXINFO;
            if !info.is_null() {
                unsafe {
                    (*info).ptMinTrackSize.x = WINDOW_MIN_WIDTH;
                    (*info).ptMinTrackSize.y = WINDOW_MIN_HEIGHT;
                }
            }
            0
        }
        WM_TIMER if wparam == TIMER_POLL => {
            unsafe { begin_state_poll(hwnd, state) };
            0
        }
        WM_STATE_READY | WM_ACTION_READY => {
            unsafe { receive_background_message(hwnd, state) };
            0
        }
        WM_COMMAND => {
            unsafe { handle_command(hwnd, state, (wparam & 0xffff) as i32) };
            0
        }
        WM_DRAWITEM => unsafe { draw_button(lparam) },
        WM_PAINT => {
            unsafe { paint_window(hwnd, state) };
            0
        }
        WM_CLOSE => {
            unsafe { ShowWindow(hwnd, SW_HIDE) };
            0
        }
        WM_TRAY => {
            unsafe { handle_tray(hwnd, state, lparam as u32) };
            0
        }
        WM_DESTROY => {
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::KillTimer(hwnd, TIMER_POLL);
                remove_tray_icon(hwnd, state);
                windows_sys::Win32::UI::WindowsAndMessaging::PostQuitMessage(0);
            }
            0
        }
        WM_NCDESTROY => {
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(state_ptr));
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut AppState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    state.controls.platform = unsafe {
        CreateWindowExW(
            0,
            WC_COMBOBOXW,
            null(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST as u32,
            0,
            0,
            136,
            240,
            hwnd,
            CONTROL_PLATFORM as HMENU,
            instance,
            null(),
        )
    };
    send_combo_text(state.controls.platform, "MT5");
    send_combo_text(state.controls.platform, "MT4");
    state.controls.terminal = unsafe {
        CreateWindowExW(
            0,
            WC_COMBOBOXW,
            null(),
            WS_CHILD | WS_TABSTOP | CBS_DROPDOWNLIST as u32,
            0,
            0,
            100,
            240,
            hwnd,
            CONTROL_TERMINAL as HMENU,
            instance,
            null(),
        )
    };
    state.controls.observer = create_button(hwnd, instance, CONTROL_OBSERVER, "添加观摩源");
    state.controls.logout = create_button(hwnd, instance, CONTROL_LOGOUT, "退出账号");
    state.controls.mt4_expert = create_button(hwnd, instance, CONTROL_MT4_EXPERT, "安装 / 修复 EA");
    state.controls.update = create_button(hwnd, instance, CONTROL_UPDATE, "重启更新");
    state.controls.pair = create_button(hwnd, instance, CONTROL_PAIR, "连接账号");
    state.controls.detect = create_button(hwnd, instance, CONTROL_DETECT, "重新检测");
    state.controls.logs = create_button(hwnd, instance, CONTROL_LOGS, "查看日志");
    state.controls.settings = create_button(hwnd, instance, CONTROL_SETTINGS, "连接设置");
    state.controls.exit = create_button(hwnd, instance, CONTROL_EXIT, "退出桥接");
    for control in control_handles(&state.controls) {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                control,
                windows_sys::Win32::UI::WindowsAndMessaging::WM_SETFONT,
                state.fonts.body as usize,
                1,
            );
        }
    }
    unsafe {
        EnableWindow(state.controls.platform, 0);
        EnableWindow(state.controls.terminal, 0);
        EnableWindow(state.controls.observer, 0);
        EnableWindow(state.controls.mt4_expert, 0);
        EnableWindow(state.controls.detect, 0);
        EnableWindow(state.controls.logs, 0);
        EnableWindow(state.controls.settings, 0);
        EnableWindow(state.controls.update, 0);
    }
}

fn control_handles(controls: &Controls) -> [HWND; 11] {
    [
        controls.platform,
        controls.observer,
        controls.logout,
        controls.terminal,
        controls.mt4_expert,
        controls.update,
        controls.pair,
        controls.detect,
        controls.logs,
        controls.settings,
        controls.exit,
    ]
}

fn create_button(hwnd: HWND, instance: HINSTANCE, id: i32, text: &str) -> HWND {
    let class = wide("BUTTON");
    let copy = wide(text);
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            copy.as_ptr(),
            WS_CHILD | WS_TABSTOP | BS_OWNERDRAW as u32,
            0,
            0,
            104,
            36,
            hwnd,
            id as HMENU,
            instance,
            null(),
        )
    }
}

fn send_combo_text(combo: HWND, text: &str) {
    let value = wide(text);
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            combo,
            windows_sys::Win32::UI::WindowsAndMessaging::CB_ADDSTRING,
            0,
            value.as_ptr() as isize,
        );
    }
}

unsafe fn apply_layout(hwnd: HWND, app: &mut AppState) {
    sync_combo_selection(app);
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let width = (client.right - client.left).max(WINDOW_MIN_WIDTH);
    let height = (client.bottom - client.top).max(WINDOW_MIN_HEIGHT);
    let x = 32;
    let content_width = width - 64;
    let mut y = 96;
    if app.view.update_banner.is_some() {
        unsafe { move_show(app.controls.update, width - 148, y + 14, 104, 36, true) };
        y += 76;
    } else {
        unsafe { ShowWindow(app.controls.update, SW_HIDE) };
    }
    unsafe {
        move_show(app.controls.platform, 156, y, 136, 240, true);
        move_show(
            app.controls.observer,
            width - 264,
            y,
            108,
            36,
            app.view.show_observer_sources,
        );
        move_show(
            app.controls.logout,
            width - 148,
            y,
            96,
            36,
            app.view.show_logout,
        );
    }
    y += 52;
    unsafe {
        move_show(
            app.controls.terminal,
            112,
            y,
            content_width - 80,
            240,
            app.view.terminal_selector_visible,
        );
    }
    if app.view.terminal_selector_visible {
        y += 52;
    }
    unsafe {
        move_show(
            app.controls.mt4_expert,
            width - 180,
            y + 10,
            128,
            36,
            app.view.show_mt4_setup,
        );
    }
    if app.view.show_mt4_setup {
        y += 56;
    }
    let bottom_y = height - 60;
    let mut right = width - 32;
    for (handle, visible, button_width) in [
        (app.controls.pair, app.view.show_pair, 104),
        (app.controls.detect, true, 104),
        (app.controls.logs, true, 104),
        (app.controls.settings, app.view.show_settings, 104),
        (app.controls.exit, true, 104),
    ] {
        if visible {
            right -= button_width;
            unsafe { move_show(handle, right, bottom_y, button_width, 36, true) };
            right -= 8;
        } else {
            unsafe { ShowWindow(handle, SW_HIDE) };
        }
    }
    let _ = (x, y);
    unsafe { InvalidateRect(hwnd, null(), 1) };
}

fn sync_combo_selection(app: &AppState) {
    let platform_index = match app.state.selected_platform.as_deref() {
        Some("mt5") => 0,
        Some("mt4") => 1,
        _ => -1,
    };
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            app.controls.platform,
            windows_sys::Win32::UI::WindowsAndMessaging::CB_SETCURSEL,
            platform_index as usize,
            0,
        );
    }
}

unsafe fn move_show(hwnd: HWND, x: i32, y: i32, width: i32, height: i32, visible: bool) {
    unsafe {
        MoveWindow(hwnd, x, y, width.max(0), height, 1);
        ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
    }
}

unsafe fn paint_window(hwnd: HWND, app: &AppState) {
    let mut paint = windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT::default();
    let hdc = unsafe { windows_sys::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint) };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    fill(hdc, client, Rgb(248, 250, 252));
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    draw_text(
        hdc,
        &app.view.heading,
        rect(32, 22, width - 32, 52),
        app.fonts.heading,
        Rgb(15, 23, 42),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        &app.view.subtitle,
        rect(32, 54, width - 32, 78),
        app.fonts.body,
        Rgb(71, 85, 105),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let mut y = 96;
    if let Some(banner) = &app.view.update_banner {
        fill(hdc, rect(32, y, width - 32, y + 64), banner.background);
        draw_text(
            hdc,
            &banner.title,
            rect(46, y + 8, width - 166, y + 30),
            app.fonts.body_bold,
            banner.title_color,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        draw_text(
            hdc,
            &banner.description,
            rect(46, y + 30, width - 166, y + 57),
            app.fonts.small,
            banner.description_color,
            DT_LEFT | DT_WORDBREAK,
        );
        y += 76;
    }
    draw_text(
        hdc,
        "选择交易平台",
        rect(32, y, 148, y + 36),
        app.fonts.body_bold,
        Rgb(51, 65, 85),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    y += 52;
    if app.view.terminal_selector_visible {
        draw_text(
            hdc,
            &app.view.terminal_selector_label,
            rect(32, y, 104, y + 36),
            app.fonts.body,
            Rgb(51, 65, 85),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        y += 52;
    }
    if app.view.show_mt4_setup {
        fill(hdc, rect(32, y, width - 32, y + 56), Rgb(239, 246, 255));
        draw_text(
            hdc,
            "MT4 重装或 EA 丢失时，可随时重新安装。",
            rect(44, y + 10, width - 190, y + 46),
            app.fonts.body,
            Rgb(30, 64, 175),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        y += 72;
    }
    let card_bottom = height - 104;
    let card = rect(32, y, width - 32, card_bottom);
    fill(hdc, card, Rgb(255, 255, 255));
    fill(hdc, rect(52, y + 28, 60, y + 36), app.view.status.accent);
    draw_text(
        hdc,
        &app.view.status.title,
        rect(72, y + 18, width - 52, y + 46),
        app.fonts.title,
        Rgb(15, 23, 42),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    draw_text(
        hdc,
        &app.view.status.description,
        rect(72, y + 48, width - 52, y + 82),
        app.fonts.body,
        Rgb(71, 85, 105),
        DT_LEFT | DT_WORDBREAK,
    );
    draw_text(
        hdc,
        &app.view.runtime_summary,
        rect(72, y + 82, width - 52, y + 108),
        app.fonts.small,
        Rgb(100, 116, 139),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    fill(
        hdc,
        rect(52, y + 116, width - 52, y + 117),
        Rgb(226, 232, 240),
    );
    draw_text(
        hdc,
        "账户连接",
        rect(52, y + 124, width - 120, y + 148),
        app.fonts.body_bold,
        Rgb(51, 65, 85),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        &app.view.account_count_text,
        rect(width - 120, y + 124, width - 52, y + 148),
        app.fonts.body,
        Rgb(100, 116, 139),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let accounts_top = y + 154;
    if app.view.accounts.is_empty() {
        draw_text(
            hdc,
            app.view
                .empty_accounts_text
                .as_deref()
                .unwrap_or("尚未识别到交易账户"),
            rect(52, accounts_top, width - 52, accounts_top + 40),
            app.fonts.body,
            Rgb(100, 116, 139),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
    } else {
        draw_account_cards(
            hdc,
            app,
            rect(52, accounts_top, width - 52, card_bottom - 8),
        );
    }
    draw_text(
        hdc,
        SAFETY_COPY,
        rect(32, height - 100, width - 32, height - 68),
        app.fonts.small,
        Rgb(100, 116, 139),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    unsafe { windows_sys::Win32::Graphics::Gdi::EndPaint(hwnd, &paint) };
}

fn draw_account_cards(hdc: HDC, app: &AppState, bounds: RECT) {
    let available_width = bounds.right - bounds.left;
    let columns = resolve_account_column_count(available_width);
    let gap = 8;
    let card_width = ((available_width - gap * (columns - 1)) / columns).max(240);
    for (index, account) in app.view.accounts.iter().enumerate() {
        let column = index as i32 % columns;
        let row = index as i32 / columns;
        let left = bounds.left + column * (card_width + gap);
        let top = bounds.top + row * 96;
        if top + 88 > bounds.bottom {
            break;
        }
        draw_account_card(
            hdc,
            app,
            account,
            rect(left, top, left + card_width, top + 88),
        );
    }
}

fn draw_account_card(hdc: HDC, app: &AppState, account: &AccountCardView, bounds: RECT) {
    fill(hdc, bounds, Rgb(248, 250, 252));
    let action_count =
        usize::from(account.settings_visible) + usize::from(account.primary_action.is_some());
    let action_left = bounds.right - action_count as i32 * 76;
    let copy_right = if action_count == 0 {
        bounds.right - 8
    } else {
        action_left - 8
    };
    fill(
        hdc,
        rect(
            bounds.left + 16,
            bounds.top + 37,
            bounds.left + 24,
            bounds.top + 45,
        ),
        account.state_color,
    );
    draw_text(
        hdc,
        &account.title,
        rect(
            bounds.left + 34,
            bounds.top + 7,
            copy_right,
            bounds.top + 30,
        ),
        app.fonts.body_bold,
        Rgb(30, 41, 59),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    draw_text(
        hdc,
        &account.state,
        rect(
            bounds.left + 34,
            bounds.top + 30,
            copy_right,
            bounds.top + 54,
        ),
        app.fonts.body,
        Rgb(71, 85, 105),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    if let Some(permission) = &account.permission {
        let badge_width = 100;
        fill(
            hdc,
            rect(
                bounds.left + 34,
                bounds.top + 58,
                bounds.left + 34 + badge_width,
                bounds.top + 82,
            ),
            permission.background,
        );
        draw_text(
            hdc,
            &permission.summary,
            rect(
                bounds.left + 42,
                bounds.top + 58,
                bounds.left + 34 + badge_width - 6,
                bounds.top + 82,
            ),
            app.fonts.small,
            permission.foreground,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
    }
    let mut button_left = action_left;
    if let Some(action) = account.primary_action {
        let primary = matches!(
            action,
            ObserverAction::Start | ObserverAction::Retry | ObserverAction::Bind
        );
        draw_compact_button(
            hdc,
            app,
            rect(
                button_left + 3,
                bounds.top + 27,
                button_left + 73,
                bounds.top + 61,
            ),
            account.primary_action_text.as_deref().unwrap_or("处理中…"),
            primary,
            account.actions_busy,
        );
        button_left += 76;
    }
    if account.settings_visible {
        draw_compact_button(
            hdc,
            app,
            rect(
                button_left + 3,
                bounds.top + 27,
                button_left + 73,
                bounds.top + 61,
            ),
            "设置",
            false,
            account.actions_busy,
        );
    }
}

fn draw_compact_button(
    hdc: HDC,
    app: &AppState,
    bounds: RECT,
    text: &str,
    primary: bool,
    disabled: bool,
) {
    let background = if disabled {
        Rgb(226, 232, 240)
    } else if primary {
        Rgb(37, 99, 235)
    } else {
        Rgb(255, 255, 255)
    };
    let foreground = if disabled {
        Rgb(148, 163, 184)
    } else if primary {
        Rgb(255, 255, 255)
    } else {
        Rgb(30, 41, 59)
    };
    fill(hdc, bounds, background);
    if !primary {
        draw_border(hdc, bounds, Rgb(203, 213, 225));
    }
    draw_text(
        hdc,
        text,
        bounds,
        app.fonts.body,
        foreground,
        windows_sys::Win32::Graphics::Gdi::DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );
}

fn draw_border(hdc: HDC, bounds: RECT, color: Rgb) {
    fill(
        hdc,
        rect(bounds.left, bounds.top, bounds.right, bounds.top + 1),
        color,
    );
    fill(
        hdc,
        rect(bounds.left, bounds.bottom - 1, bounds.right, bounds.bottom),
        color,
    );
    fill(
        hdc,
        rect(bounds.left, bounds.top, bounds.left + 1, bounds.bottom),
        color,
    );
    fill(
        hdc,
        rect(bounds.right - 1, bounds.top, bounds.right, bounds.bottom),
        color,
    );
}

unsafe fn draw_button(lparam: LPARAM) -> LRESULT {
    let item = lparam as *const DRAWITEMSTRUCT;
    if item.is_null() || unsafe { (*item).CtlType } != ODT_BUTTON {
        return 0;
    }
    let item = unsafe { &*item };
    let primary = matches!(item.CtlID as i32, CONTROL_PAIR | CONTROL_UPDATE);
    let disabled = item.itemState & ODS_DISABLED != 0;
    let selected = item.itemState & ODS_SELECTED != 0;
    let background = if disabled {
        Rgb(226, 232, 240)
    } else if primary && selected {
        Rgb(29, 78, 216)
    } else if primary {
        Rgb(37, 99, 235)
    } else if selected {
        Rgb(241, 245, 249)
    } else {
        Rgb(255, 255, 255)
    };
    fill(item.hDC, item.rcItem, background);
    if !primary {
        draw_border(item.hDC, item.rcItem, Rgb(203, 213, 225));
    }
    let mut buffer = [0_u16; 128];
    let length = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
            item.hwndItem,
            buffer.as_mut_ptr(),
            buffer.len() as i32,
        )
    };
    let foreground = if disabled {
        Rgb(148, 163, 184)
    } else if primary {
        Rgb(255, 255, 255)
    } else {
        Rgb(30, 41, 59)
    };
    draw_text_wide(
        item.hDC,
        &buffer[..length.max(0) as usize],
        item.rcItem,
        null_mut(),
        foreground,
        windows_sys::Win32::Graphics::Gdi::DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );
    if item.itemState & ODS_FOCUS != 0 {
        let mut focus = item.rcItem;
        focus.left += 3;
        focus.top += 3;
        focus.right -= 3;
        focus.bottom -= 3;
        unsafe { DrawFocusRect(item.hDC, &focus) };
    }
    1
}

unsafe fn handle_command(hwnd: HWND, app: &mut AppState, id: i32) {
    match id {
        CONTROL_PAIR => unsafe { begin_action(hwnd, app, LocalControlAction::Pair) },
        CONTROL_LOGOUT => unsafe { begin_action(hwnd, app, LocalControlAction::Logout) },
        CONTROL_EXIT | MENU_EXIT_COMMAND => unsafe {
            begin_action(hwnd, app, LocalControlAction::BridgeExit)
        },
        MENU_OPEN_COMMAND => unsafe {
            ShowWindow(hwnd, SW_SHOWNORMAL);
            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        },
        _ => {}
    }
}

unsafe fn begin_state_poll(hwnd: HWND, app: &AppState) {
    if app.inbox.poll_running.swap(true, Ordering::AcqRel) {
        return;
    }
    let profile_id = app.profile_id.clone();
    let inbox = Arc::clone(&app.inbox);
    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        let result = run_local_request(
            &profile_id,
            &inbox,
            LocalControlAction::GetState,
            Duration::from_millis(350),
        )
        .and_then(|result| match result {
            LocalControlResult::State { state } => Ok(*state),
            LocalControlResult::Rejected { code } => Err(code),
            _ => Err("bridge_local_control_response_invalid".to_owned()),
        });
        if let Ok(mut slot) = inbox.message.lock() {
            *slot = Some(UiMessage::State(result));
        }
        inbox.poll_running.store(false, Ordering::Release);
        unsafe { PostMessageW(hwnd_value as HWND, WM_STATE_READY, 0, 0) };
    });
}

unsafe fn begin_action(hwnd: HWND, app: &AppState, action: LocalControlAction) {
    let profile_id = app.profile_id.clone();
    let inbox = Arc::clone(&app.inbox);
    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        let result = run_local_request(&profile_id, &inbox, action.clone(), Duration::from_secs(2));
        if let Ok(mut slot) = inbox.message.lock() {
            *slot = Some(UiMessage::Action { action, result });
        }
        unsafe { PostMessageW(hwnd_value as HWND, WM_ACTION_READY, 0, 0) };
    });
}

fn run_local_request(
    profile_id: &str,
    inbox: &SharedInbox,
    action: LocalControlAction,
    timeout: Duration,
) -> Result<LocalControlResult, String> {
    let request_id = format!(
        "ui-{}-{}",
        now_utc_msc(),
        inbox.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "bridge_local_control_runtime_failed".to_owned())?;
    runtime.block_on(async {
        let mut client = LocalControlPipeClient::connect(profile_id, timeout)
            .await
            .map_err(|error| error.code().to_owned())?;
        let response = client
            .request(&LocalControlRequest {
                schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                request_id,
                profile_id: profile_id.to_owned(),
                action,
            })
            .await
            .map_err(|error| error.code().to_owned())?;
        Ok(response.result)
    })
}

unsafe fn receive_background_message(hwnd: HWND, app: &mut AppState) {
    let message = app
        .inbox
        .message
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    match message {
        Some(UiMessage::State(Ok(state))) => {
            if let Ok(view) = build_main_window_view(&state, &BTreeSet::new(), format_local_time) {
                app.state = state;
                app.view = view;
                unsafe { apply_layout(hwnd, app) };
            }
        }
        Some(UiMessage::Action {
            result: Ok(LocalControlResult::PairingUrl { url }),
            ..
        }) => {
            open_browser(&url);
        }
        Some(UiMessage::Action {
            action,
            result: Ok(LocalControlResult::Accepted),
        }) => {
            if action == LocalControlAction::BridgeExit {
                unsafe { DestroyWindow(hwnd) };
            } else {
                unsafe { begin_state_poll(hwnd, app) };
            }
        }
        Some(UiMessage::Action {
            result: Ok(LocalControlResult::Rejected { code }),
            ..
        })
        | Some(UiMessage::Action {
            result: Err(code), ..
        }) => show_error(hwnd, &code),
        Some(UiMessage::State(Err(_))) | None => {}
        Some(UiMessage::Action { result: Ok(_), .. }) => {}
    }
}

fn open_browser(url: &str) {
    let operation = wide("open");
    let target = wide(url);
    unsafe {
        ShellExecuteW(
            null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        );
    }
}

fn show_error(hwnd: HWND, code: &str) {
    let message = if code == "bridge_local_control_action_unavailable" {
        "该功能正在迁移到新版核心，当前尚不可用。"
    } else {
        "量见智桥暂时无法完成操作，请稍后重试。"
    };
    let text = wide(message);
    let title = wide(PRODUCT_NAME);
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            hwnd,
            text.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_OK
                | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONWARNING,
        );
    }
}

unsafe fn add_tray_icon(hwnd: HWND, app: &mut AppState) {
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: WM_TRAY,
        hIcon: app.brand_icon_small,
        ..Default::default()
    };
    copy_wide_fixed(&mut data.szTip, PRODUCT_NAME);
    app.tray_added = unsafe { Shell_NotifyIconW(NIM_ADD, &data) } != 0;
}

unsafe fn remove_tray_icon(hwnd: HWND, app: &mut AppState) {
    if !app.tray_added {
        return;
    }
    let data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        ..Default::default()
    };
    unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
    app.tray_added = false;
}

unsafe fn handle_tray(hwnd: HWND, app: &AppState, event: u32) {
    if event == WM_LBUTTONDBLCLK {
        unsafe {
            ShowWindow(hwnd, SW_SHOWNORMAL);
            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        }
        return;
    }
    if event != WM_RBUTTONUP {
        return;
    }
    let menu = unsafe { CreatePopupMenu() };
    let open = wide("打开量见智桥");
    let exit = wide("退出桥接");
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
            menu,
            MF_STRING,
            MENU_OPEN,
            open.as_ptr(),
        );
        windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
            menu,
            MF_STRING,
            MENU_EXIT,
            exit.as_ptr(),
        );
        let mut point = windows_sys::Win32::Foundation::POINT::default();
        windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point);
        windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_BOTTOMALIGN,
            point.x,
            point.y,
            0,
            hwnd,
            null(),
        );
        DestroyMenu(menu);
        DrawMenuBar(hwnd);
    }
    let _ = app;
}

fn format_local_time(timestamp: i64) -> String {
    const WINDOWS_EPOCH_OFFSET_MSC: i64 = 11_644_473_600_000;
    let Some(file_ticks) = timestamp
        .checked_add(WINDOWS_EPOCH_OFFSET_MSC)
        .and_then(|value| value.checked_mul(10_000))
    else {
        return "--:--:--".to_owned();
    };
    let utc = FILETIME {
        dwLowDateTime: file_ticks as u32,
        dwHighDateTime: (file_ticks as u64 >> 32) as u32,
    };
    let mut local = FILETIME::default();
    let mut system = SYSTEMTIME::default();
    let converted = unsafe {
        FileTimeToLocalFileTime(&utc, &mut local) != 0
            && FileTimeToSystemTime(&local, &mut system) != 0
    };
    if !converted {
        return "--:--:--".to_owned();
    }
    format!(
        "{:02}:{:02}:{:02}",
        system.wHour, system.wMinute, system.wSecond
    )
}

unsafe fn create_fonts() -> Fonts {
    Fonts {
        body: create_font(14, FW_NORMAL as i32),
        body_bold: create_font(14, FW_BOLD as i32),
        heading: create_font(24, FW_BOLD as i32),
        title: create_font(17, FW_BOLD as i32),
        small: create_font(12, FW_NORMAL as i32),
    }
}

fn create_font(pixel_height: i32, weight: i32) -> HFONT {
    let face = wide("Microsoft YaHei UI");
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

impl Drop for Fonts {
    fn drop(&mut self) {
        for font in [
            self.body,
            self.body_bold,
            self.heading,
            self.title,
            self.small,
        ] {
            if !font.is_null() {
                unsafe { DeleteObject(font as HGDIOBJ) };
            }
        }
    }
}

fn fill(hdc: HDC, bounds: RECT, color: Rgb) {
    let brush = unsafe { CreateSolidBrush(color_ref(color)) };
    unsafe {
        FillRect(hdc, &bounds, brush);
        DeleteObject(brush as HGDIOBJ);
    }
}

fn draw_text(hdc: HDC, text: &str, bounds: RECT, font: HFONT, color: Rgb, flags: u32) {
    let value = wide(text);
    draw_text_wide(
        hdc,
        &value[..value.len().saturating_sub(1)],
        bounds,
        font,
        color,
        flags,
    );
}

fn draw_text_wide(hdc: HDC, text: &[u16], mut bounds: RECT, font: HFONT, color: Rgb, flags: u32) {
    unsafe {
        let previous = if font.is_null() {
            null_mut()
        } else {
            SelectObject(hdc, font as HGDIOBJ)
        };
        SetBkMode(hdc, TRANSPARENT as i32);
        SetTextColor(hdc, color_ref(color));
        DrawTextW(hdc, text.as_ptr(), text.len() as i32, &mut bounds, flags);
        if !previous.is_null() {
            SelectObject(hdc, previous);
        }
    }
}

fn color_ref(color: Rgb) -> COLORREF {
    color.0 as u32 | ((color.1 as u32) << 8) | ((color.2 as u32) << 16)
}

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
    RECT {
        left,
        top,
        right,
        bottom,
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn copy_wide_fixed<const N: usize>(target: &mut [u16; N], value: &str) {
    let encoded = value.encode_utf16().take(N.saturating_sub(1));
    for (index, character) in encoded.enumerate() {
        target[index] = character;
    }
}

fn load_brand_icon(preferred_size: i32) -> Option<HICON> {
    const ICON: &[u8] = include_bytes!("../../../../assets/liangjian-bridge.ico");
    let count = read_u16(ICON, 4)? as usize;
    let mut selected = None;
    for index in 0..count {
        let entry = 6_usize.checked_add(index.checked_mul(16)?)?;
        let width = match *ICON.get(entry)? {
            0 => 256,
            value => value as i32,
        };
        if width != preferred_size {
            continue;
        }
        let size = read_u32(ICON, entry + 8)? as usize;
        let offset = read_u32(ICON, entry + 12)? as usize;
        let end = offset.checked_add(size)?;
        selected = ICON.get(offset..end);
        break;
    }
    let image = selected?;
    let icon = unsafe {
        CreateIconFromResourceEx(
            image.as_ptr(),
            image.len().try_into().ok()?,
            1,
            0x0003_0000,
            preferred_size,
            preferred_size,
            LR_DEFAULTCOLOR,
        )
    };
    (!icon.is_null()).then_some(icon)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let value = bytes.get(offset..offset.checked_add(2)?)?;
    Some(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let value = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_current_timestamp_in_local_time() {
        assert_ne!(format_local_time(now_utc_msc()), "--:--:--");
    }

    #[test]
    fn loads_the_same_embedded_brand_icon_as_dotnet() {
        assert!(load_brand_icon(16).is_some());
        assert!(load_brand_icon(32).is_some());
    }
}
