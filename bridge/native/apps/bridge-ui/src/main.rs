#![windows_subsystem = "windows"]

mod log_viewer;
mod permission_tooltip;
mod settings;

use bridge_foundation::{DEFAULT_PROFILE_ID, default_data_directory, validate_profile_id};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeClient, LocalControlRequest,
    LocalControlResult, UiStateSnapshot,
};
use bridge_ui_model::{
    AccountCardView, MainWindowView, ObserverAction, PRODUCT_NAME, Rgb, SAFETY_COPY,
    build_main_window_view, resolve_account_column_count,
};
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    COLORREF, FILETIME, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SYSTEMTIME, WPARAM,
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
    WC_COMBOBOXW, WM_MOUSELEAVE,
};
use windows_sys::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
    ShellExecuteW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BS_OWNERDRAW, CBN_SELCHANGE, CBS_DROPDOWNLIST, CREATESTRUCTW, CS_HREDRAW,
    CS_VREDRAW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyMenu, DestroyWindow, DispatchMessageW, DrawMenuBar, GWLP_USERDATA, GetClientRect,
    GetMessageW, GetSystemMetrics, GetWindowLongPtrW, HICON, HMENU, IDC_ARROW, IDI_APPLICATION,
    LR_DEFAULTCOLOR, LoadCursorW, LoadIconW, MF_CHECKED, MF_GRAYED, MF_SEPARATOR, MF_STRING,
    MINMAXINFO, MSG, MoveWindow, PostMessageW, RegisterClassExW, SM_CXSCREEN, SM_CYSCREEN, SW_HIDE,
    SW_SHOW, SW_SHOWNORMAL, SetWindowLongPtrW, ShowWindow, TPM_BOTTOMALIGN, TPM_LEFTALIGN,
    TrackPopupMenu, TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE, WM_DESTROY,
    WM_DRAWITEM, WM_GETMINMAXINFO, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCCREATE,
    WM_NCDESTROY, WM_PAINT, WM_RBUTTONUP, WM_SIZE, WM_TIMER, WNDCLASSEXW, WS_CAPTION, WS_CHILD,
    WS_CLIPCHILDREN, WS_EX_APPWINDOW, WS_MINIMIZEBOX, WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME,
    WS_VISIBLE,
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
const MENU_AUTOSTART: usize = 203;
const MENU_SETTINGS: usize = 204;
const MENU_RECOVER_OFFICIAL: usize = 205;
const MENU_OPEN_COMMAND: i32 = MENU_OPEN as i32;
const MENU_EXIT_COMMAND: i32 = MENU_EXIT as i32;
const MENU_AUTOSTART_COMMAND: i32 = MENU_AUTOSTART as i32;
const MENU_SETTINGS_COMMAND: i32 = MENU_SETTINGS as i32;
const MENU_RECOVER_OFFICIAL_COMMAND: i32 = MENU_RECOVER_OFFICIAL as i32;
const TIMER_POLL: usize = 1;
const WM_STATE_READY: u32 = WM_APP + 1;
const WM_ACTION_READY: u32 = WM_APP + 2;
const WM_TRAY: u32 = WM_APP + 3;

#[derive(Clone)]
enum UiMessage {
    State(Box<Result<UiStateSnapshot, String>>),
    Action {
        action: LocalControlAction,
        result: Result<LocalControlResult, String>,
    },
}

struct SharedInbox {
    messages: Mutex<VecDeque<UiMessage>>,
    poll_running: AtomicBool,
    action_running: AtomicBool,
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
    terminal_choices_fingerprint: String,
    log_window: HWND,
    settings_window: HWND,
    permission_tooltip: HWND,
    hovered_permission_account: Option<usize>,
    tracking_mouse_leave: bool,
    busy_observer_profiles: BTreeSet<String>,
}

#[derive(Debug, Eq, PartialEq)]
struct TrayMenuView {
    show_administration: bool,
    autostart_checked: bool,
    settings_text: &'static str,
    show_settings: bool,
    show_recovery: bool,
    actions_enabled: bool,
}

fn build_tray_menu_view(
    profile_id: &str,
    state: &UiStateSnapshot,
    show_settings: bool,
    action_running: bool,
) -> TrayMenuView {
    let show_administration = profile_id == DEFAULT_PROFILE_ID;
    TrayMenuView {
        show_administration,
        autostart_checked: state.autostart_enabled,
        settings_text: if state.server_connected {
            "连接设置"
        } else {
            "切换服务器"
        },
        show_settings: show_administration && show_settings,
        show_recovery: show_administration
            && state.custom_endpoint_active
            && !state.server_connected,
        actions_enabled: !action_running,
    }
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
                messages: Mutex::new(VecDeque::new()),
                poll_running: AtomicBool::new(false),
                action_running: AtomicBool::new(false),
                sequence: AtomicU64::new(1),
            }),
            fonts: create_fonts(),
            controls: Controls::empty(),
            brand_icon: null_mut(),
            brand_icon_small: null_mut(),
            tray_added: false,
            terminal_choices_fingerprint: String::new(),
            log_window: null_mut(),
            settings_window: null_mut(),
            permission_tooltip: null_mut(),
            hovered_permission_account: None,
            tracking_mouse_leave: false,
            busy_observer_profiles: BTreeSet::new(),
        });
    }
}

#[cfg(debug_assertions)]
fn demo_state(profile_id: &str) -> UiStateSnapshot {
    use bridge_local_control::{
        UiObserverProfile, UiObserverSource, UiTerminalCandidate, UiTerminalStatus,
    };

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
        observer_sources: vec![UiObserverSource {
            bridge_user_id: 9,
            display_name: "一号观摩源".to_owned(),
            account_summary: "596520 · DooTechnology-Demo".to_owned(),
        }],
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
        observer_sources: Vec::new(),
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
    let title = wide(&unsafe { &*state_ptr }.view.window_title);
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
            ((GetSystemMetrics(SM_CXSCREEN) - (outer.right - outer.left)) / 2).max(0),
            ((GetSystemMetrics(SM_CYSCREEN) - (outer.bottom - outer.top)) / 2).max(0),
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
            unsafe {
                handle_command(
                    hwnd,
                    state,
                    (wparam & 0xffff) as i32,
                    ((wparam >> 16) & 0xffff) as u32,
                )
            };
            0
        }
        WM_MOUSEMOVE => {
            unsafe { handle_mouse_move(hwnd, state, point_from_lparam(lparam)) };
            0
        }
        WM_MOUSELEAVE => {
            state.tracking_mouse_leave = false;
            state.hovered_permission_account = None;
            unsafe { permission_tooltip::hide(state.permission_tooltip) };
            0
        }
        WM_LBUTTONUP => {
            unsafe { handle_account_click(hwnd, state, point_from_lparam(lparam)) };
            0
        }
        WM_DRAWITEM => unsafe { draw_button(lparam) },
        WM_PAINT => {
            unsafe { paint_window(hwnd, state) };
            0
        }
        WM_CLOSE => {
            state.hovered_permission_account = None;
            unsafe { permission_tooltip::hide(state.permission_tooltip) };
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
                if !state.permission_tooltip.is_null() {
                    DestroyWindow(state.permission_tooltip);
                    state.permission_tooltip = null_mut();
                }
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
        EnableWindow(state.controls.platform, 1);
        EnableWindow(state.controls.terminal, 0);
        EnableWindow(state.controls.observer, 0);
        EnableWindow(state.controls.mt4_expert, 0);
        EnableWindow(state.controls.detect, 1);
        EnableWindow(state.controls.logs, 1);
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
    unsafe {
        let idle = !app.inbox.action_running.load(Ordering::Acquire);
        EnableWindow(app.controls.platform, i32::from(idle));
        EnableWindow(
            app.controls.observer,
            i32::from(idle && app.view.show_observer_sources),
        );
        EnableWindow(app.controls.logout, i32::from(idle && app.view.show_logout));
        EnableWindow(
            app.controls.mt4_expert,
            i32::from(idle && app.view.show_mt4_setup),
        );
        EnableWindow(app.controls.pair, i32::from(idle && app.view.show_pair));
        EnableWindow(app.controls.detect, i32::from(idle));
        EnableWindow(
            app.controls.settings,
            i32::from(idle && app.view.show_settings),
        );
        EnableWindow(
            app.controls.terminal,
            i32::from(idle && app.view.terminal_selector_visible),
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

fn sync_combo_selection(app: &mut AppState) {
    let platform_index = match app.state.selected_platform.as_deref() {
        Some("mt5") => 0,
        Some("mt4") => 1,
        _ => -1,
    };
    unsafe {
        let current = windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            app.controls.platform,
            windows_sys::Win32::UI::WindowsAndMessaging::CB_GETCURSEL,
            0,
            0,
        ) as i32;
        if current != platform_index {
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                app.controls.platform,
                windows_sys::Win32::UI::WindowsAndMessaging::CB_SETCURSEL,
                platform_index as usize,
                0,
            );
        }
    }
    let fingerprint = app
        .view
        .terminal_choices
        .iter()
        .map(|choice| {
            format!(
                "{}\u{1f}{}",
                choice.terminal_instance_id, choice.display_name
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1e}");
    if fingerprint != app.terminal_choices_fingerprint {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                app.controls.terminal,
                windows_sys::Win32::UI::WindowsAndMessaging::CB_RESETCONTENT,
                0,
                0,
            );
        }
        for choice in &app.view.terminal_choices {
            send_combo_text(app.controls.terminal, &choice.display_name);
        }
        app.terminal_choices_fingerprint = fingerprint;
    }
    let selected_terminal_index = app
        .view
        .selected_terminal_instance_id
        .as_deref()
        .and_then(|selected| {
            app.view
                .terminal_choices
                .iter()
                .position(|choice| choice.terminal_instance_id == selected)
        })
        .map_or(-1, |index| index as i32);
    unsafe {
        let current = windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            app.controls.terminal,
            windows_sys::Win32::UI::WindowsAndMessaging::CB_GETCURSEL,
            0,
            0,
        ) as i32;
        if current != selected_terminal_index {
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                app.controls.terminal,
                windows_sys::Win32::UI::WindowsAndMessaging::CB_SETCURSEL,
                selected_terminal_index as usize,
                0,
            );
        }
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
    for (account, card_bounds) in app
        .view
        .accounts
        .iter()
        .zip(account_card_rects(&app.view.accounts, bounds))
    {
        if card_bounds.top >= bounds.bottom {
            break;
        }
        draw_account_card(hdc, app, account, card_bounds);
    }
}

fn account_card_rects(accounts: &[AccountCardView], bounds: RECT) -> Vec<RECT> {
    const GAP: i32 = 8;
    let available_width = bounds.right - bounds.left;
    let columns = resolve_account_column_count(available_width).max(1);
    let card_width = ((available_width - GAP * (columns - 1)) / columns).max(240);
    let mut result = Vec::with_capacity(accounts.len());
    let mut row_top = bounds.top;
    for row in accounts.chunks(columns as usize) {
        let row_height = row.iter().map(account_card_height).max().unwrap_or(70);
        for (column, account) in row.iter().enumerate() {
            let left = bounds.left + column as i32 * (card_width + GAP);
            let height = account_card_height(account);
            result.push(rect(left, row_top, left + card_width, row_top + height));
        }
        row_top += row_height + GAP;
    }
    result
}

fn account_card_height(account: &AccountCardView) -> i32 {
    if account.permission.is_none() {
        70
    } else if account.mt4_expert_update.is_some() {
        112
    } else {
        88
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
            bounds.top + (bounds.bottom - bounds.top - 8) / 2,
            bounds.left + 24,
            bounds.top + (bounds.bottom - bounds.top - 8) / 2 + 8,
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
        let badge = permission_badge_rect(bounds);
        fill(hdc, badge, permission.background);
        draw_text(
            hdc,
            &permission.summary,
            rect(badge.left + 8, badge.top, badge.right - 6, badge.bottom),
            app.fonts.small,
            permission.foreground,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
    }
    if let Some(expert_update) = &account.mt4_expert_update {
        let badge = rect(
            bounds.left + 34,
            bounds.top + 85,
            (bounds.left + 244).min(copy_right),
            bounds.top + 109,
        );
        fill(hdc, badge, Rgb(254, 243, 199));
        draw_text(
            hdc,
            expert_update,
            rect(badge.left + 8, badge.top, badge.right - 6, badge.bottom),
            app.fonts.small,
            Rgb(146, 64, 14),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
    }
    let button_top = bounds.top + (bounds.bottom - bounds.top - 34) / 2;
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
                button_top,
                button_left + 73,
                button_top + 34,
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
                button_top,
                button_left + 73,
                button_top + 34,
            ),
            "设置",
            false,
            account.actions_busy,
        );
    }
}

fn permission_badge_rect(card: RECT) -> RECT {
    rect(
        card.left + 34,
        card.top + 58,
        card.left + 134,
        card.top + 82,
    )
}

fn accounts_bounds(client: RECT, app: &AppState) -> RECT {
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    let mut y = 96;
    if app.view.update_banner.is_some() {
        y += 76;
    }
    y += 52;
    if app.view.terminal_selector_visible {
        y += 52;
    }
    if app.view.show_mt4_setup {
        y += 72;
    }
    rect(52, y + 154, width - 52, height - 112)
}

fn point_in_rect(point: POINT, bounds: RECT) -> bool {
    point.x >= bounds.left
        && point.x < bounds.right
        && point.y >= bounds.top
        && point.y < bounds.bottom
}

fn point_from_lparam(lparam: LPARAM) -> POINT {
    POINT {
        x: (lparam as u16 as i16) as i32,
        y: ((lparam >> 16) as u16 as i16) as i32,
    }
}

unsafe fn handle_mouse_move(hwnd: HWND, app: &mut AppState, point: POINT) {
    if !app.tracking_mouse_leave {
        let mut tracking = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        app.tracking_mouse_leave = unsafe { TrackMouseEvent(&mut tracking) } != 0;
    }
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let bounds = accounts_bounds(client, app);
    let cards = account_card_rects(&app.view.accounts, bounds);
    let hovered =
        app.view
            .accounts
            .iter()
            .zip(cards)
            .enumerate()
            .find_map(|(index, (account, card))| {
                account
                    .permission
                    .as_ref()
                    .filter(|_| point_in_rect(point, permission_badge_rect(card)))
                    .map(|permission| (index, permission, permission_badge_rect(card)))
            });
    match hovered {
        Some((index, permission, badge)) if app.hovered_permission_account != Some(index) => {
            match unsafe {
                permission_tooltip::show_or_update(
                    app.permission_tooltip,
                    hwnd,
                    permission,
                    badge,
                    app.brand_icon_small,
                )
            } {
                Ok(tooltip) => {
                    app.permission_tooltip = tooltip;
                    app.hovered_permission_account = Some(index);
                }
                Err(_) => {
                    app.hovered_permission_account = None;
                    unsafe { permission_tooltip::hide(app.permission_tooltip) };
                }
            }
        }
        Some(_) => {}
        None => {
            app.hovered_permission_account = None;
            unsafe { permission_tooltip::hide(app.permission_tooltip) };
        }
    }
}

unsafe fn handle_account_click(hwnd: HWND, app: &mut AppState, point: POINT) {
    if app.inbox.action_running.load(Ordering::Acquire) {
        return;
    }
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let cards = account_card_rects(&app.view.accounts, accounts_bounds(client, app));
    let clicked = app
        .view
        .accounts
        .iter()
        .zip(cards)
        .find_map(|(account, bounds)| {
            if account.actions_busy {
                return None;
            }
            if account_primary_action_rect(account, bounds)
                .is_some_and(|region| point_in_rect(point, region))
            {
                return Some((account, account.primary_action));
            }
            if account_settings_action_rect(account, bounds)
                .is_some_and(|region| point_in_rect(point, region))
            {
                return Some((account, Some(ObserverAction::Configure)));
            }
            None
        });
    let Some((account, Some(action))) = clicked else {
        return;
    };
    let profile_id = account.role.clone();
    let Some(local_action) = observer_local_action(&profile_id, action) else {
        show_error(hwnd, "bridge_local_control_action_unavailable");
        return;
    };
    app.busy_observer_profiles.insert(profile_id);
    if let Ok(view) =
        build_main_window_view(&app.state, &app.busy_observer_profiles, format_local_time)
    {
        app.view = view;
        unsafe { apply_layout(hwnd, app) };
    }
    unsafe { begin_action(hwnd, app, local_action) };
}

fn observer_local_action(profile_id: &str, action: ObserverAction) -> Option<LocalControlAction> {
    match action {
        ObserverAction::Start => Some(LocalControlAction::ObserverStart {
            observer_profile_id: profile_id.to_owned(),
        }),
        ObserverAction::Pause => Some(LocalControlAction::ObserverPause {
            observer_profile_id: profile_id.to_owned(),
        }),
        ObserverAction::Retry => Some(LocalControlAction::ObserverRetry {
            observer_profile_id: profile_id.to_owned(),
        }),
        ObserverAction::Bind | ObserverAction::Configure => None,
    }
}

fn account_primary_action_rect(account: &AccountCardView, bounds: RECT) -> Option<RECT> {
    account.primary_action?;
    let action_count =
        i32::from(account.settings_visible) + i32::from(account.primary_action.is_some());
    let action_left = bounds.right - action_count * 76;
    let top = bounds.top + (bounds.bottom - bounds.top - 34) / 2;
    Some(rect(action_left + 3, top, action_left + 73, top + 34))
}

fn account_settings_action_rect(account: &AccountCardView, bounds: RECT) -> Option<RECT> {
    if !account.settings_visible {
        return None;
    }
    let action_count =
        i32::from(account.settings_visible) + i32::from(account.primary_action.is_some());
    let action_left = bounds.right - action_count * 76;
    let settings_left = action_left + i32::from(account.primary_action.is_some()) * 76;
    let top = bounds.top + (bounds.bottom - bounds.top - 34) / 2;
    Some(rect(settings_left + 3, top, settings_left + 73, top + 34))
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
        Rgb(194, 150, 35)
    } else if primary {
        Rgb(212, 175, 55)
    } else if selected {
        Rgb(241, 245, 249)
    } else {
        Rgb(255, 255, 255)
    };
    fill(item.hDC, item.rcItem, background);
    draw_border(
        item.hDC,
        item.rcItem,
        if primary {
            Rgb(212, 175, 55)
        } else {
            Rgb(203, 213, 225)
        },
    );
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
        Rgb(15, 23, 42)
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

unsafe fn handle_command(hwnd: HWND, app: &mut AppState, id: i32, notification: u32) {
    match id {
        CONTROL_PLATFORM if notification == CBN_SELCHANGE => {
            let selected = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                    app.controls.platform,
                    windows_sys::Win32::UI::WindowsAndMessaging::CB_GETCURSEL,
                    0,
                    0,
                )
            } as i32;
            let platform = match selected {
                0 => Some("mt5"),
                1 => Some("mt4"),
                _ => None,
            };
            if let Some(platform) = platform {
                unsafe {
                    begin_action(
                        hwnd,
                        app,
                        LocalControlAction::SelectPlatform {
                            platform: platform.to_owned(),
                        },
                    )
                };
            }
        }
        CONTROL_TERMINAL if notification == CBN_SELCHANGE => {
            let selected = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                    app.controls.terminal,
                    windows_sys::Win32::UI::WindowsAndMessaging::CB_GETCURSEL,
                    0,
                    0,
                )
            } as i32;
            if selected >= 0
                && let Some(choice) = app.view.terminal_choices.get(selected as usize)
            {
                unsafe {
                    begin_action(
                        hwnd,
                        app,
                        LocalControlAction::SelectTerminal {
                            terminal_instance_id: choice.terminal_instance_id.clone(),
                        },
                    )
                };
            }
        }
        CONTROL_DETECT => unsafe { begin_action(hwnd, app, LocalControlAction::Redetect) },
        CONTROL_LOGS => match default_data_directory(&app.profile_id) {
            Ok(data_directory) => match unsafe {
                log_viewer::show_or_refresh(
                    app.log_window,
                    hwnd,
                    &data_directory.join("logs"),
                    app.brand_icon,
                )
            } {
                Ok(log_window) => app.log_window = log_window,
                Err(code) => show_error(hwnd, code),
            },
            Err(code) => show_error(hwnd, code),
        },
        CONTROL_SETTINGS => match unsafe {
            settings::show_or_focus(app.settings_window, hwnd, &app.profile_id, app.brand_icon)
        } {
            Ok(settings_window) => app.settings_window = settings_window,
            Err(code) => show_error(hwnd, code),
        },
        CONTROL_PAIR => unsafe { begin_action(hwnd, app, LocalControlAction::Pair) },
        CONTROL_LOGOUT => unsafe { begin_action(hwnd, app, LocalControlAction::Logout) },
        CONTROL_EXIT | MENU_EXIT_COMMAND => unsafe {
            begin_action(hwnd, app, LocalControlAction::BridgeExit)
        },
        MENU_OPEN_COMMAND => unsafe {
            ShowWindow(hwnd, SW_SHOWNORMAL);
            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        },
        MENU_AUTOSTART_COMMAND => unsafe {
            begin_action(
                hwnd,
                app,
                LocalControlAction::AutostartSet {
                    enabled: !app.state.autostart_enabled,
                },
            )
        },
        MENU_SETTINGS_COMMAND => match unsafe {
            settings::show_or_focus(app.settings_window, hwnd, &app.profile_id, app.brand_icon)
        } {
            Ok(settings_window) => app.settings_window = settings_window,
            Err(code) => show_error(hwnd, code),
        },
        MENU_RECOVER_OFFICIAL_COMMAND
            if show_confirmation(
                hwnd,
                "确定恢复更新包携带的官方服务器地址？\n\n旧服务器授权将被清除，恢复后桥接会自动重启。",
                "恢复官方连接",
            ) =>
        unsafe { begin_action(hwnd, app, LocalControlAction::SettingsRestoreOfficial) },
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
        if let Ok(mut messages) = inbox.messages.lock() {
            messages.push_back(UiMessage::State(Box::new(result)));
        }
        inbox.poll_running.store(false, Ordering::Release);
        unsafe { PostMessageW(hwnd_value as HWND, WM_STATE_READY, 0, 0) };
    });
}

unsafe fn begin_action(hwnd: HWND, app: &AppState, action: LocalControlAction) {
    if app.inbox.action_running.swap(true, Ordering::AcqRel) {
        return;
    }
    let profile_id = app.profile_id.clone();
    let inbox = Arc::clone(&app.inbox);
    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        let result = run_local_request(&profile_id, &inbox, action.clone(), Duration::from_secs(2));
        if let Ok(mut messages) = inbox.messages.lock() {
            messages.push_back(UiMessage::Action { action, result });
        }
        inbox.action_running.store(false, Ordering::Release);
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
        .messages
        .lock()
        .ok()
        .and_then(|mut messages| messages.pop_front());
    if let Some(UiMessage::Action { action, .. }) = &message
        && let Some(profile_id) = observer_profile_id(action)
    {
        app.busy_observer_profiles.remove(profile_id);
        if let Ok(view) =
            build_main_window_view(&app.state, &app.busy_observer_profiles, format_local_time)
        {
            app.view = view;
            unsafe { apply_layout(hwnd, app) };
        }
    }
    match message {
        Some(UiMessage::State(result)) => {
            if let Ok(state) = *result
                && let Ok(view) =
                    build_main_window_view(&state, &app.busy_observer_profiles, format_local_time)
            {
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
        None => {}
        Some(UiMessage::Action { result: Ok(_), .. }) => {}
    }
}

fn observer_profile_id(action: &LocalControlAction) -> Option<&str> {
    match action {
        LocalControlAction::ObserverStart {
            observer_profile_id,
        }
        | LocalControlAction::ObserverPause {
            observer_profile_id,
        }
        | LocalControlAction::ObserverRetry {
            observer_profile_id,
        }
        | LocalControlAction::ObserverBind {
            observer_profile_id,
            ..
        } => Some(observer_profile_id),
        LocalControlAction::ObserverUpdate { observer }
        | LocalControlAction::ObserverCreate { observer } => Some(&observer.observer_profile_id),
        _ => None,
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

fn show_confirmation(hwnd: HWND, message: &str, title: &str) -> bool {
    let text = wide(message);
    let title = wide(title);
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            hwnd,
            text.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_YESNO
                | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONWARNING
                | windows_sys::Win32::UI::WindowsAndMessaging::MB_DEFBUTTON2,
        ) == windows_sys::Win32::UI::WindowsAndMessaging::IDYES
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
    let view = build_tray_menu_view(
        &app.profile_id,
        &app.state,
        app.view.show_settings,
        app.inbox.action_running.load(Ordering::Acquire),
    );
    let open = wide("打开量见智桥");
    let autostart = wide("开机自动启动（推荐）");
    let settings = wide(view.settings_text);
    let recover = wide("恢复官方连接");
    let exit = wide("退出桥接");
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
            menu,
            MF_STRING,
            MENU_OPEN,
            open.as_ptr(),
        );
        if view.show_administration {
            windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(menu, MF_SEPARATOR, 0, null());
            let disabled = if view.actions_enabled { 0 } else { MF_GRAYED };
            windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
                menu,
                MF_STRING
                    | disabled
                    | if view.autostart_checked {
                        MF_CHECKED
                    } else {
                        0
                    },
                MENU_AUTOSTART,
                autostart.as_ptr(),
            );
            if view.show_settings {
                windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
                    menu,
                    MF_STRING | disabled,
                    MENU_SETTINGS,
                    settings.as_ptr(),
                );
            }
            if view.show_recovery {
                windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
                    menu,
                    MF_STRING | disabled,
                    MENU_RECOVER_OFFICIAL,
                    recover.as_ptr(),
                );
            }
        }
        windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(menu, MF_SEPARATOR, 0, null());
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
    use bridge_ui_model::{PermissionDetailView, PermissionView};

    #[test]
    fn formats_current_timestamp_in_local_time() {
        assert_ne!(format_local_time(now_utc_msc()), "--:--:--");
    }

    #[test]
    fn loads_the_same_embedded_brand_icon_as_dotnet() {
        assert!(load_brand_icon(16).is_some());
        assert!(load_brand_icon(32).is_some());
    }

    #[test]
    fn account_cards_follow_dotnet_heights_and_responsive_rows() {
        let accounts = vec![
            account_fixture(true, false, false),
            account_fixture(true, true, true),
            account_fixture(false, false, false),
        ];
        let narrow = account_card_rects(&accounts, rect(0, 0, 516, 500))
            .into_iter()
            .map(rect_coordinates)
            .collect::<Vec<_>>();
        assert_eq!(
            narrow,
            vec![(0, 0, 516, 88), (0, 96, 516, 208), (0, 216, 516, 286)]
        );
        let wide = account_card_rects(&accounts, rect(0, 0, 824, 500))
            .into_iter()
            .map(rect_coordinates)
            .collect::<Vec<_>>();
        assert_eq!(
            wide,
            vec![(0, 0, 408, 88), (416, 0, 824, 112), (0, 120, 408, 190)]
        );
    }

    #[test]
    fn account_hit_regions_match_the_drawn_badge_and_buttons() {
        let account = account_fixture(true, false, true);
        let bounds = rect(0, 0, 408, 88);
        assert_eq!(
            rect_coordinates(permission_badge_rect(bounds)),
            (34, 58, 134, 82)
        );
        assert_eq!(
            account_primary_action_rect(&account, bounds).map(rect_coordinates),
            Some((259, 27, 329, 61))
        );
        assert_eq!(
            account_settings_action_rect(&account, bounds).map(rect_coordinates),
            Some((335, 27, 405, 61))
        );
    }

    #[test]
    fn observer_runtime_buttons_dispatch_the_matching_local_actions() {
        assert!(matches!(
            observer_local_action("source-1", ObserverAction::Start),
            Some(LocalControlAction::ObserverStart { observer_profile_id })
                if observer_profile_id == "source-1"
        ));
        assert!(matches!(
            observer_local_action("source-1", ObserverAction::Pause),
            Some(LocalControlAction::ObserverPause { observer_profile_id })
                if observer_profile_id == "source-1"
        ));
        assert!(matches!(
            observer_local_action("source-1", ObserverAction::Retry),
            Some(LocalControlAction::ObserverRetry { observer_profile_id })
                if observer_profile_id == "source-1"
        ));
        assert!(observer_local_action("source-1", ObserverAction::Bind).is_none());
        assert!(observer_local_action("source-1", ObserverAction::Configure).is_none());
    }

    #[test]
    fn tray_menu_matches_dotnet_visibility_and_recovery_rules() {
        let mut state = demo_state(DEFAULT_PROFILE_ID);
        let connected = build_tray_menu_view(DEFAULT_PROFILE_ID, &state, true, false);
        assert_eq!(
            connected,
            TrayMenuView {
                show_administration: true,
                autostart_checked: true,
                settings_text: "连接设置",
                show_settings: true,
                show_recovery: false,
                actions_enabled: true,
            }
        );
        state.server_connected = false;
        state.custom_endpoint_active = true;
        let recovering = build_tray_menu_view(DEFAULT_PROFILE_ID, &state, true, true);
        assert_eq!(recovering.settings_text, "切换服务器");
        assert!(recovering.show_recovery);
        assert!(!recovering.actions_enabled);
        let observer = build_tray_menu_view("source-1", &state, true, false);
        assert!(!observer.show_administration);
        assert!(!observer.show_settings);
        assert!(!observer.show_recovery);
    }

    fn account_fixture(
        has_permission: bool,
        expert_update: bool,
        observer_actions: bool,
    ) -> AccountCardView {
        AccountCardView {
            role: if observer_actions {
                "source-1"
            } else {
                "主账户"
            }
            .to_owned(),
            title: "账户".to_owned(),
            state: "运行中".to_owned(),
            state_color: Rgb(5, 150, 105),
            permission: has_permission.then(|| PermissionView {
                summary: "交易权限正常".to_owned(),
                accessible_description: "账户交易权限：已开启".to_owned(),
                action: "交易所需开关均已开启。".to_owned(),
                foreground: Rgb(4, 120, 87),
                background: Rgb(209, 250, 229),
                details: vec![PermissionDetailView {
                    label: "账户交易权限".to_owned(),
                    allowed: Some(true),
                    color: Rgb(4, 120, 87),
                }],
            }),
            mt4_expert_update: expert_update.then(|| "EA 已更新，重启 MT4 后生效".to_owned()),
            primary_action: observer_actions.then_some(ObserverAction::Pause),
            primary_action_text: observer_actions.then(|| "暂停".to_owned()),
            settings_visible: observer_actions,
            actions_busy: false,
        }
    }

    fn rect_coordinates(bounds: RECT) -> (i32, i32, i32, i32) {
        (bounds.left, bounds.top, bounds.right, bounds.bottom)
    }
}
