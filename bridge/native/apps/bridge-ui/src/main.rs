#![windows_subsystem = "windows"]

mod core_host;
mod log_viewer;
mod observer_profile_dialog;
mod permission_tooltip;
mod settings;
mod terminal_directory;

use bridge_foundation::{
    CliMode, DEFAULT_PROFILE_ID, default_root_data_directory, parse_cli, profile_instance_id,
    validate_profile_id,
};
use bridge_local_control::{
    LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlPipeClient, LocalControlRequest,
    LocalControlResult, UiObserverProfile, UiStateSnapshot,
};
use bridge_runtime_win::{
    InstanceAcquireResult, InstanceSignal, SingleInstanceGuard, default_lock_directory,
};
use bridge_transport::realtime_compatibility_enabled;
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
    BitBlt, CLIP_DEFAULT_PRECIS, COLOR_HIGHLIGHT, COLOR_HIGHLIGHTTEXT, CreateCompatibleBitmap,
    CreateCompatibleDC, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH,
    DEFAULT_QUALITY, DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, DT_WORDBREAK, DeleteDC,
    DeleteObject, DrawFocusRect, DrawTextW, FF_DONTCARE, FW_BOLD, FW_NORMAL, FillRect, GetDC,
    GetDeviceCaps, GetSysColor, HDC, HFONT, HGDIOBJ, IntersectClipRect, InvalidateRect, LOGPIXELSX,
    OUT_DEFAULT_PRECIS, ReleaseDC, RestoreDC, SRCCOPY, SaveDC, ScreenToClient, SelectObject,
    SetBkMode, SetTextColor, TRANSPARENT,
};
use windows_sys::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::System::Time::FileTimeToSystemTime;
use windows_sys::Win32::UI::Controls::{
    DRAWITEMSTRUCT, InitCommonControls, ODS_COMBOBOXEDIT, ODS_DISABLED, ODS_FOCUS, ODS_SELECTED,
    ODT_BUTTON, ODT_COMBOBOX, SetScrollInfo, WC_COMBOBOXW, WC_SCROLLBARW, WM_MOUSELEAVE,
};
use windows_sys::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    EnableWindow, IsWindowEnabled, TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent, VK_DOWN, VK_END,
    VK_HOME, VK_NEXT, VK_PRIOR, VK_UP,
};
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
    ShellExecuteW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BS_OWNERDRAW, CB_SETITEMHEIGHT, CBN_SELCHANGE, CBS_DROPDOWNLIST,
    CBS_OWNERDRAWFIXED, CREATESTRUCTW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW,
    DefWindowProcW, DestroyMenu, DestroyWindow, DispatchMessageW, GA_ROOT, GWLP_USERDATA,
    GetAncestor, GetClientRect, GetDlgCtrlID, GetMessageW, GetParent, GetScrollInfo,
    GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    HICON, HMENU, HTCLIENT, IDC_ARROW, IDC_HAND, IDI_APPLICATION, IsDialogMessageW,
    IsWindowVisible, LR_DEFAULTCOLOR, LoadCursorW, LoadIconW, MF_CHECKED, MF_GRAYED, MF_SEPARATOR,
    MF_STRING, MINMAXINFO, MSG, MoveWindow, PostMessageW, RegisterClassExW, RegisterWindowMessageW,
    SB_BOTTOM, SB_CTL, SB_LINEDOWN, SB_LINEUP, SB_PAGEDOWN, SB_PAGEUP, SB_THUMBPOSITION,
    SB_THUMBTRACK, SB_TOP, SBS_VERT, SCROLLINFO, SIF_PAGE, SIF_POS, SIF_RANGE, SIF_TRACKPOS,
    SM_CXSCREEN, SM_CYSCREEN, SW_HIDE, SW_MINIMIZE, SW_SHOW, SW_SHOWNORMAL, SetCursor,
    SetWindowLongPtrW, SetWindowTextW, ShowWindow, TPM_BOTTOMALIGN, TPM_LEFTALIGN, TrackPopupMenu,
    TranslateMessage, WHEEL_DELTA, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE, WM_DESTROY,
    WM_DPICHANGED, WM_DRAWITEM, WM_ENDSESSION, WM_ERASEBKGND, WM_GETMINMAXINFO, WM_KEYDOWN,
    WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCCREATE, WM_NCDESTROY,
    WM_NULL, WM_PAINT, WM_QUERYENDSESSION, WM_RBUTTONUP, WM_SETCURSOR, WM_SETFONT, WM_SIZE,
    WM_TIMER, WM_VSCROLL, WNDCLASSEXW, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_EX_APPWINDOW,
    WS_EX_CONTROLPARENT, WS_MINIMIZEBOX, WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME, WS_VISIBLE,
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
const CONTROL_ACCOUNT_SCROLL: i32 = 115;
const CONTROL_ACCOUNT_ACTION_BASE: i32 = 2_000;
const MENU_OPEN: usize = 201;
const MENU_EXIT: usize = 202;
const MENU_AUTOSTART: usize = 203;
const MENU_SETTINGS: usize = 204;
const MENU_RECOVER_OFFICIAL: usize = 205;
const MENU_REALTIME_COMPATIBILITY: usize = 206;
const MENU_OPEN_COMMAND: i32 = MENU_OPEN as i32;
const MENU_EXIT_COMMAND: i32 = MENU_EXIT as i32;
const MENU_AUTOSTART_COMMAND: i32 = MENU_AUTOSTART as i32;
const MENU_SETTINGS_COMMAND: i32 = MENU_SETTINGS as i32;
const MENU_RECOVER_OFFICIAL_COMMAND: i32 = MENU_RECOVER_OFFICIAL as i32;
const MENU_REALTIME_COMPATIBILITY_COMMAND: i32 = MENU_REALTIME_COMPATIBILITY as i32;
const TIMER_POLL: usize = 1;
const WM_STATE_READY: u32 = WM_APP + 1;
const WM_ACTION_READY: u32 = WM_APP + 2;
const WM_TRAY: u32 = WM_APP + 3;
const WM_OPEN_OBSERVER_DEMO: u32 = WM_APP + 4;

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
    platform: HFONT,
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
    account_scroll: HWND,
}

#[derive(Clone, Copy)]
struct AccountActionControl {
    hwnd: HWND,
    id: i32,
    account_index: usize,
    action: ObserverAction,
    primary: bool,
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
    taskbar_created_message: u32,
    terminal_choices_fingerprint: String,
    account_action_controls: Vec<AccountActionControl>,
    account_action_fingerprint: String,
    account_scroll_offset: i32,
    account_scroll_max: i32,
    account_wheel_remainder: i32,
    log_window: HWND,
    settings_window: HWND,
    permission_tooltip: HWND,
    hovered_permission_account: Option<usize>,
    tracking_mouse_leave: bool,
    busy_observer_profiles: BTreeSet<String>,
    open_observer_demo: bool,
    demo_mode: bool,
    start_minimized: bool,
    core_host: Option<core_host::CoreProcessHost>,
    ui_instance: Option<SingleInstanceGuard>,
    dpi: u32,
}

#[cfg(debug_assertions)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DemoScenario {
    OrdinaryMt5,
    AdminMultiAccount,
    AdminManyAccounts,
    PairingRequired,
    ServerOffline,
    UpdateDownloading,
    UpdateReady,
    UpdateWaiting,
    UpdateActivating,
    UpdateFailed,
    UpdateRolledBack,
    UpdateHealthy,
}

#[cfg(debug_assertions)]
impl DemoScenario {
    const ALL: [Self; 12] = [
        Self::OrdinaryMt5,
        Self::AdminMultiAccount,
        Self::AdminManyAccounts,
        Self::PairingRequired,
        Self::ServerOffline,
        Self::UpdateDownloading,
        Self::UpdateReady,
        Self::UpdateWaiting,
        Self::UpdateActivating,
        Self::UpdateFailed,
        Self::UpdateRolledBack,
        Self::UpdateHealthy,
    ];

    fn from_slug(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|scenario| scenario.slug() == value)
    }

    fn slug(self) -> &'static str {
        match self {
            Self::OrdinaryMt5 => "ordinary-mt5",
            Self::AdminMultiAccount => "admin-multi-account",
            Self::AdminManyAccounts => "admin-many-accounts",
            Self::PairingRequired => "pairing-required",
            Self::ServerOffline => "server-offline",
            Self::UpdateDownloading => "update-downloading",
            Self::UpdateReady => "update-ready",
            Self::UpdateWaiting => "update-waiting",
            Self::UpdateActivating => "update-activating",
            Self::UpdateFailed => "update-failed",
            Self::UpdateRolledBack => "update-rolled-back",
            Self::UpdateHealthy => "update-healthy",
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
struct TrayMenuView {
    show_administration: bool,
    autostart_checked: bool,
    realtime_compatibility_checked: bool,
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
    realtime_compatibility_checked: bool,
) -> TrayMenuView {
    let show_administration = profile_id == DEFAULT_PROFILE_ID;
    TrayMenuView {
        show_administration,
        autostart_checked: state.autostart_enabled,
        realtime_compatibility_checked,
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

fn register_taskbar_created_message() -> u32 {
    let name = wide("TaskbarCreated");
    unsafe { RegisterWindowMessageW(name.as_ptr()) }
}

fn initial_window_show_command(start_minimized: bool, tray_added: bool) -> i32 {
    if !start_minimized {
        SW_SHOW
    } else if tray_added {
        SW_HIDE
    } else {
        SW_MINIMIZE
    }
}

fn close_window_show_command(tray_added: bool) -> i32 {
    if tray_added { SW_HIDE } else { SW_MINIMIZE }
}

fn is_user_exit_command(id: i32) -> bool {
    matches!(id, CONTROL_EXIT | MENU_EXIT_COMMAND)
}

fn user_exit_confirmation_message() -> String {
    format!("确定退出{PRODUCT_NAME}？\n\n退出只会停止数据与指令转发，不会撤单、平仓或关闭 MT。")
}

fn confirm_user_exit(hwnd: HWND) -> bool {
    show_confirmation(hwnd, &user_exit_confirmation_message(), "退出桥接")
}

unsafe fn complete_bridge_exit(hwnd: HWND, app: &mut AppState) {
    if let Some(core_host) = app.core_host.as_mut() {
        core_host.disable_restart();
    }
    if !app.demo_mode
        && let Ok(instance_id) = profile_instance_id(&app.profile_id)
    {
        // BridgeExit remains in the local-control contract for backward compatibility, but
        // process shutdown itself is intentionally idempotent. The Core can close its pipe
        // immediately after accepting an exit request, so the UI must not depend on receiving
        // that final pipe frame before honoring the user's explicit exit intent.
        let _ = SingleInstanceGuard::request_shutdown(&instance_id);
    }
    unsafe { DestroyWindow(hwnd) };
}

fn dialog_message_root(main_window: HWND, message_window: HWND) -> HWND {
    if message_window.is_null() {
        return main_window;
    }
    let root = unsafe { GetAncestor(message_window, GA_ROOT) };
    if root.is_null() { main_window } else { root }
}

fn is_main_action_button(control_id: i32) -> bool {
    matches!(
        control_id,
        CONTROL_OBSERVER
            | CONTROL_LOGOUT
            | CONTROL_MT4_EXPERT
            | CONTROL_UPDATE
            | CONTROL_PAIR
            | CONTROL_DETECT
            | CONTROL_LOGS
            | CONTROL_SETTINGS
            | CONTROL_EXIT
    )
}

unsafe fn apply_hand_cursor<F>(wparam: WPARAM, lparam: LPARAM, is_action: F) -> bool
where
    F: FnOnce(i32) -> bool,
{
    if (lparam as usize & 0xffff) as u32 != HTCLIENT {
        return false;
    }
    let control = wparam as HWND;
    if control.is_null() || unsafe { IsWindowEnabled(control) } == 0 {
        return false;
    }
    let control_id = unsafe { GetDlgCtrlID(control) };
    if !is_action(control_id) {
        return false;
    }
    let cursor = unsafe { LoadCursorW(null_mut(), IDC_HAND) };
    if cursor.is_null() {
        return false;
    }
    unsafe { SetCursor(cursor) };
    true
}

fn main() {
    let raw_arguments: Vec<_> = std::env::args_os().skip(1).collect();
    let profile_id = parse_profile_id();
    #[cfg(debug_assertions)]
    let open_observer_demo = std::env::args().any(|argument| argument == "--observer-dialog-demo");
    #[cfg(not(debug_assertions))]
    let open_observer_demo = false;
    #[cfg(debug_assertions)]
    let demo_scenario = if open_observer_demo {
        Some(DemoScenario::AdminMultiAccount)
    } else {
        parse_demo_scenario(std::env::args().skip(1))
    };
    #[cfg(not(debug_assertions))]
    let demo_scenario: Option<()> = None;
    let demo_mode = demo_scenario.is_some();
    let (start_minimized, core_host, ui_instance) = if demo_mode {
        (false, None, None)
    } else {
        let mode = match parse_cli(raw_arguments.clone()) {
            Ok(mode) => mode,
            Err(_) => return,
        };
        let executable = match std::env::current_exe() {
            Ok(executable) => executable,
            Err(_) => return,
        };
        let Some(application_directory) = executable.parent() else {
            return;
        };
        if matches!(mode, CliMode::HealthCheck { .. }) {
            let healthy =
                core_host::run_health_check(application_directory, &raw_arguments).unwrap_or(false);
            std::process::exit(if healthy { 0 } else { 1 });
        }
        let CliMode::Run {
            ref profile_id,
            start_minimized,
            ..
        } = mode
        else {
            return;
        };
        let ui_instance_id = match profile_instance_id(profile_id) {
            Ok(instance_id) => format!("{instance_id}.ui"),
            Err(_) => return,
        };
        let ui_instance = match default_lock_directory().and_then(|directory| {
            SingleInstanceGuard::try_acquire(&ui_instance_id, directory, true)
        }) {
            Ok(InstanceAcquireResult::Acquired(instance)) => instance,
            Ok(InstanceAcquireResult::Duplicate) | Err(_) => return,
        };
        let core_host =
            match core_host::CoreProcessHost::start(application_directory, raw_arguments, &mode) {
                Ok(host) => host,
                Err(_) => return,
            };
        (start_minimized, core_host, Some(ui_instance))
    };
    #[cfg(debug_assertions)]
    let state = demo_scenario
        .map(|scenario| demo_state(&profile_id, scenario))
        .unwrap_or_else(|| initial_state(&profile_id));
    #[cfg(not(debug_assertions))]
    let state = initial_state(&profile_id);
    let view = if demo_mode {
        build_main_window_view(&state, &BTreeSet::new(), demo_format_local_time)
    } else {
        build_main_window_view(&state, &BTreeSet::new(), format_local_time)
    }
    .expect("bridge_ui_initial_state_invalid");
    // SAFETY: the Win32 UI is created and driven on this thread only.
    unsafe {
        SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
        InitCommonControls();
        let dpi = system_dpi();
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
            fonts: create_fonts(dpi),
            controls: Controls::empty(),
            brand_icon: null_mut(),
            brand_icon_small: null_mut(),
            tray_added: false,
            taskbar_created_message: 0,
            terminal_choices_fingerprint: String::new(),
            account_action_controls: Vec::new(),
            account_action_fingerprint: String::new(),
            account_scroll_offset: 0,
            account_scroll_max: 0,
            account_wheel_remainder: 0,
            log_window: null_mut(),
            settings_window: null_mut(),
            permission_tooltip: null_mut(),
            hovered_permission_account: None,
            tracking_mouse_leave: false,
            busy_observer_profiles: BTreeSet::new(),
            open_observer_demo,
            demo_mode,
            start_minimized,
            core_host,
            ui_instance,
            dpi,
        });
    }
}

#[cfg(debug_assertions)]
fn demo_state(profile_id: &str, scenario: DemoScenario) -> UiStateSnapshot {
    use bridge_local_control::{
        UiObserverProfile, UiObserverSource, UiTerminalCandidate, UiTerminalStatus, UiUpdateNotice,
    };

    let mut state = UiStateSnapshot {
        schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
        revision: 7,
        profile_id: profile_id.to_owned(),
        observed_at_utc_msc: 1_800_000_000_000,
        phase: "online".to_owned(),
        detail_code: None,
        selected_platform: Some("mt5".to_owned()),
        selected_terminal_instance_id: Some("mt5-main".to_owned()),
        terminal_candidates: vec![UiTerminalCandidate {
            terminal_instance_id: "mt5-main".to_owned(),
            platform: "mt5".to_owned(),
            broker_server: "DooTechnology-Demo".to_owned(),
            login: "596520".to_owned(),
            display_name: Some("596520 · DooTechnology-Demo".to_owned()),
        }],
        terminals: vec![UiTerminalStatus {
            terminal_instance_id: "mt5-main".to_owned(),
            platform: "mt5".to_owned(),
            broker_server: "DooTechnology-Demo".to_owned(),
            login: "596520".to_owned(),
            runtime_state: "running".to_owned(),
            initialization_state: "ready".to_owned(),
            local_operational_ready: true,
            history_backfill_pending: true,
            history_attention_required: false,
            error_code: None,
            observer_profile_id: None,
            terminal_trading_allowed: Some(true),
            program_trading_allowed: None,
            account_trading_allowed: Some(true),
            account_expert_trading_allowed: Some(true),
            mt4_expert_restart_required: false,
        }],
        server_connected: true,
        last_data_sync_utc_msc: Some(1_800_000_000_000),
        bridge_version: "3.0.0".to_owned(),
        can_manage_observer_sources: false,
        is_administrator: false,
        observer_sources: Vec::new(),
        observer_profiles: Vec::new(),
        update_notice: None,
        autostart_enabled: true,
        custom_endpoint_active: false,
    };

    match scenario {
        DemoScenario::OrdinaryMt5 => {}
        DemoScenario::AdminMultiAccount => {
            state.selected_platform = Some("mt4".to_owned());
            state.selected_terminal_instance_id = Some("mt4-main".to_owned());
            state.terminal_candidates = vec![UiTerminalCandidate {
                terminal_instance_id: "mt4-main".to_owned(),
                platform: "mt4".to_owned(),
                broker_server: "DPrimeVU-Demo 5".to_owned(),
                login: "8950701".to_owned(),
                display_name: Some("8950701 · DPrimeVU-Demo 5".to_owned()),
            }];
            state.terminals = vec![
                UiTerminalStatus {
                    terminal_instance_id: "mt4-main".to_owned(),
                    platform: "mt4".to_owned(),
                    broker_server: "DPrimeVU-Demo 5".to_owned(),
                    login: "8950701".to_owned(),
                    runtime_state: "running".to_owned(),
                    initialization_state: "ready".to_owned(),
                    local_operational_ready: true,
                    history_backfill_pending: false,
                    history_attention_required: false,
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
                    initialization_state: "ready".to_owned(),
                    local_operational_ready: true,
                    history_backfill_pending: true,
                    history_attention_required: false,
                    error_code: None,
                    observer_profile_id: Some("source-1".to_owned()),
                    terminal_trading_allowed: Some(false),
                    program_trading_allowed: None,
                    account_trading_allowed: Some(true),
                    account_expert_trading_allowed: Some(true),
                    mt4_expert_restart_required: false,
                },
            ];
            state.can_manage_observer_sources = true;
            state.is_administrator = true;
            state.observer_sources = vec![UiObserverSource {
                bridge_user_id: 9,
                display_name: "一号观摩源".to_owned(),
                account_summary: "596520 · DooTechnology-Demo".to_owned(),
            }];
            state.observer_profiles = vec![UiObserverProfile {
                observer_profile_id: "source-1".to_owned(),
                platform: Some("mt5".to_owned()),
                terminal_directory: Some(r"C:\Broker MT5".to_owned()),
                configured: true,
                enabled: true,
                terminal_instance_id: Some("observer-1-terminal".to_owned()),
                bridge_user_id: Some(9),
                observer_account_label: Some("一号观摩源".to_owned()),
                trading_account_label: Some("596520 · DooTechnology-Demo".to_owned()),
                runtime_phase: Some("online".to_owned()),
                runtime_detail_code: None,
            }];
        }
        DemoScenario::AdminManyAccounts => {
            state = demo_state(profile_id, DemoScenario::AdminMultiAccount);
            for index in 2_i64..=7 {
                let profile_id = format!("source-{index}");
                let terminal_instance_id = format!("observer-{index}-terminal");
                let platform = if index % 2 == 0 { "mt5" } else { "mt4" };
                let login = format!("5965{index:02}");
                let source_name = format!("{index}号观摩源");
                let running = index != 7;
                state.observer_sources.push(UiObserverSource {
                    bridge_user_id: index + 8,
                    display_name: source_name.clone(),
                    account_summary: format!("{login} · DooTechnology-Demo"),
                });
                state.observer_profiles.push(UiObserverProfile {
                    observer_profile_id: profile_id.clone(),
                    platform: Some(platform.to_owned()),
                    terminal_directory: Some(format!(r"C:\Broker {platform}-{index}")),
                    configured: true,
                    enabled: running,
                    terminal_instance_id: running.then_some(terminal_instance_id.clone()),
                    bridge_user_id: Some(index + 8),
                    observer_account_label: Some(source_name),
                    trading_account_label: Some(format!("{login} · DooTechnology-Demo")),
                    runtime_phase: Some(if running { "online" } else { "stopped" }.to_owned()),
                    runtime_detail_code: None,
                });
                if running {
                    state.terminals.push(UiTerminalStatus {
                        terminal_instance_id,
                        platform: platform.to_owned(),
                        broker_server: "DooTechnology-Demo".to_owned(),
                        login,
                        runtime_state: "running".to_owned(),
                        initialization_state: "ready".to_owned(),
                        local_operational_ready: true,
                        history_backfill_pending: platform == "mt5",
                        history_attention_required: false,
                        error_code: None,
                        observer_profile_id: Some(profile_id),
                        terminal_trading_allowed: Some(true),
                        program_trading_allowed: (platform == "mt4").then_some(true),
                        account_trading_allowed: Some(true),
                        account_expert_trading_allowed: Some(true),
                        mt4_expert_restart_required: false,
                    });
                }
            }
        }
        DemoScenario::PairingRequired => {
            state.phase = "pairing_required".to_owned();
            state.selected_terminal_instance_id = None;
            state.terminal_candidates.clear();
            state.terminals.clear();
            state.server_connected = false;
            state.last_data_sync_utc_msc = None;
        }
        DemoScenario::ServerOffline => {
            state.phase = "degraded".to_owned();
            state.detail_code = Some("bridge_connection_failure".to_owned());
            state.server_connected = false;
            state.last_data_sync_utc_msc = None;
            state.custom_endpoint_active = true;
        }
        scenario => {
            let (phase, urgent) = match scenario {
                DemoScenario::UpdateDownloading => ("downloading", false),
                DemoScenario::UpdateReady => ("ready", true),
                DemoScenario::UpdateWaiting => ("waiting", true),
                DemoScenario::UpdateActivating => ("activating", true),
                DemoScenario::UpdateFailed => ("failed", false),
                DemoScenario::UpdateRolledBack => ("rolled_back", false),
                DemoScenario::UpdateHealthy => ("healthy", false),
                _ => unreachable!(),
            };
            state.update_notice = Some(UiUpdateNotice {
                version: "3.0.1".to_owned(),
                urgent,
                phase: phase.to_owned(),
                manual_activation_requested: false,
            });
        }
    }
    state
}

#[cfg(debug_assertions)]
fn parse_demo_scenario<I, S>(arguments: I) -> Option<DemoScenario>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_ref() {
            "--demo" => return Some(DemoScenario::AdminMultiAccount),
            "--ui-demo" => {
                return arguments
                    .next()
                    .and_then(|value| DemoScenario::from_slug(value.as_ref()));
            }
            _ => {}
        }
    }
    None
}

fn demo_format_local_time(_: i64) -> String {
    "13:19:09".to_owned()
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
        selected_platform: Some("mt5".to_owned()),
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
            account_scroll: null_mut(),
        }
    }
}

unsafe fn run_window(mut state: AppState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    state.taskbar_created_message = register_taskbar_created_message();
    state.brand_icon =
        load_brand_icon(32).unwrap_or_else(|| unsafe { LoadIconW(null_mut(), IDI_APPLICATION) });
    state.brand_icon_small =
        load_brand_icon(16).unwrap_or_else(|| unsafe { LoadIconW(null_mut(), IDI_APPLICATION) });
    let class_name = wide(WINDOW_CLASS);
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: state.brand_icon,
        hCursor: unsafe { LoadCursorW(null_mut(), IDC_ARROW) },
        hbrBackground: null_mut(),
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
    let window_ex_style = WS_EX_APPWINDOW | WS_EX_CONTROLPARENT;
    let mut outer = RECT {
        left: 0,
        top: 0,
        right: scale(WINDOW_WIDTH, unsafe { &*state_ptr }.dpi),
        bottom: scale(WINDOW_HEIGHT, unsafe { &*state_ptr }.dpi),
    };
    unsafe { AdjustWindowRectEx(&mut outer, window_style, 0, window_ex_style) };
    let hwnd = unsafe {
        CreateWindowExW(
            window_ex_style,
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
    unsafe {
        ShowWindow(
            hwnd,
            initial_window_show_command((*state_ptr).start_minimized, (*state_ptr).tray_added),
        )
    };
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } > 0 {
        unsafe {
            let handled_log_input = log_viewer::handle_dialog_tab(
                (*state_ptr).log_window,
                message.hwnd,
                message.message,
                message.wParam,
            );
            let handled_account_input = match message.message {
                WM_MOUSEWHEEL => handle_account_mouse_wheel(
                    hwnd,
                    &mut *state_ptr,
                    message.wParam,
                    message.lParam,
                ),
                WM_KEYDOWN => {
                    handle_account_scroll_key(hwnd, &mut *state_ptr, message.hwnd, message.wParam)
                }
                _ => false,
            };
            let dialog_root = dialog_message_root(hwnd, message.hwnd);
            if !handled_log_input
                && !handled_account_input
                && IsDialogMessageW(dialog_root, &message) == 0
            {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
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
    if state.taskbar_created_message != 0 && message == state.taskbar_created_message {
        unsafe {
            remove_tray_icon(hwnd, state);
            add_tray_icon(hwnd, state);
        }
        return 0;
    }
    match message {
        WM_CREATE => {
            unsafe {
                create_controls(hwnd, state);
                add_tray_icon(hwnd, state);
                if !state.demo_mode {
                    windows_sys::Win32::UI::WindowsAndMessaging::SetTimer(
                        hwnd, TIMER_POLL, 500, None,
                    );
                    begin_state_poll(hwnd, state);
                }
                apply_layout(hwnd, state);
                if state.open_observer_demo {
                    PostMessageW(hwnd, WM_OPEN_OBSERVER_DEMO, 0, 0);
                }
            }
            0
        }
        WM_SIZE => {
            unsafe { apply_layout(hwnd, state) };
            0
        }
        WM_DPICHANGED => {
            let new_dpi = (wparam & 0xffff) as u32;
            let suggested = lparam as *const RECT;
            if new_dpi >= 96 && !suggested.is_null() {
                state.account_scroll_offset =
                    rescale_scroll_offset(state.account_scroll_offset, state.dpi, new_dpi);
                state.dpi = new_dpi;
                state.fonts = unsafe { create_fonts(new_dpi) };
                unsafe {
                    if !state.permission_tooltip.is_null() {
                        DestroyWindow(state.permission_tooltip);
                        state.permission_tooltip = null_mut();
                        state.hovered_permission_account = None;
                    }
                    apply_control_fonts(state);
                    let bounds = *suggested;
                    windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
                        hwnd,
                        null_mut(),
                        bounds.left,
                        bounds.top,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE
                            | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER,
                    );
                    apply_layout(hwnd, state);
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
        WM_TIMER if wparam == TIMER_POLL => {
            if !state.demo_mode {
                let mut update_handoff = None;
                let mut update_handoff_error = None;
                if let Some(core_host) = state.core_host.as_mut() {
                    match core_host.poll() {
                        Ok(core_host::CoreProcessPoll::UpdateHandoff(launcher)) => {
                            update_handoff = Some(launcher);
                        }
                        Ok(
                            core_host::CoreProcessPoll::Running | core_host::CoreProcessPoll::Idle,
                        ) => {}
                        Err(code @ "bridge_ui_update_handoff_invalid") => {
                            update_handoff_error = Some(code);
                        }
                        Err(_) => {}
                    }
                }
                if let Some(code) = update_handoff_error {
                    if let Some(core_host) = state.core_host.as_mut() {
                        core_host.disable_restart();
                    }
                    state.ui_instance.take();
                    show_error(hwnd, code);
                    unsafe { DestroyWindow(hwnd) };
                    return 0;
                }
                if let Some(launcher) = update_handoff {
                    if let Some(core_host) = state.core_host.as_mut() {
                        core_host.disable_restart();
                    }
                    state.ui_instance.take();
                    if let Err(code) = core_host::start_launcher(&launcher) {
                        show_error(hwnd, code);
                    }
                    unsafe { DestroyWindow(hwnd) };
                    return 0;
                }
                if let Some(ui_instance) = state.ui_instance.as_ref() {
                    match ui_instance.wait_for_signal(Duration::ZERO) {
                        Ok(InstanceSignal::Activation) => unsafe {
                            ShowWindow(hwnd, SW_SHOWNORMAL);
                            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
                        },
                        Ok(InstanceSignal::Shutdown) => unsafe {
                            complete_bridge_exit(hwnd, state);
                        },
                        Ok(InstanceSignal::Timeout) | Err(_) => {}
                    }
                }
                unsafe { begin_state_poll(hwnd, state) };
            }
            0
        }
        WM_STATE_READY | WM_ACTION_READY => {
            unsafe { receive_background_message(hwnd, state) };
            0
        }
        WM_OPEN_OBSERVER_DEMO => {
            state.open_observer_demo = false;
            unsafe { open_observer_dialog(hwnd, state) };
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
        WM_VSCROLL => {
            unsafe {
                handle_account_vertical_scroll(hwnd, state, wparam, lparam as HWND);
            }
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
        WM_DRAWITEM => unsafe { draw_control(state, lparam) },
        WM_ERASEBKGND => 1,
        WM_SETCURSOR
            if unsafe {
                apply_hand_cursor(wparam, lparam, |control_id| {
                    is_main_action_button(control_id)
                        || state
                            .account_action_controls
                            .iter()
                            .any(|control| control.id == control_id)
                })
            } =>
        {
            1
        }
        WM_PAINT => {
            unsafe { paint_window(hwnd, state) };
            0
        }
        WM_CLOSE => {
            state.hovered_permission_account = None;
            unsafe { permission_tooltip::hide(state.permission_tooltip) };
            unsafe { ShowWindow(hwnd, close_window_show_command(state.tray_added)) };
            0
        }
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wparam != 0 {
                if let Some(core_host) = state.core_host.as_mut() {
                    core_host.disable_restart();
                }
                state.ui_instance.take();
                unsafe { DestroyWindow(hwnd) };
            }
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
            WS_CHILD
                | WS_VISIBLE
                | WS_TABSTOP
                | CBS_DROPDOWNLIST as u32
                | CBS_OWNERDRAWFIXED as u32,
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
    state.controls.account_scroll = unsafe {
        CreateWindowExW(
            0,
            WC_SCROLLBARW,
            null(),
            WS_CHILD | WS_TABSTOP | SBS_VERT as u32,
            0,
            0,
            17,
            100,
            hwnd,
            CONTROL_ACCOUNT_SCROLL as HMENU,
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
    unsafe { apply_control_fonts(state) };
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

unsafe fn apply_control_fonts(state: &AppState) {
    for control in control_handles(&state.controls) {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                control,
                WM_SETFONT,
                state.fonts.body as usize,
                1,
            );
        }
    }
    for control in &state.account_action_controls {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
                control.hwnd,
                WM_SETFONT,
                state.fonts.body as usize,
                1,
            );
        }
    }
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            state.controls.platform,
            WM_SETFONT,
            state.fonts.platform as usize,
            1,
        );
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            state.controls.platform,
            CB_SETITEMHEIGHT,
            0,
            scale(28, state.dpi) as isize,
        );
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
            state.controls.platform,
            CB_SETITEMHEIGHT,
            usize::MAX,
            scale(28, state.dpi) as isize,
        );
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

fn account_action_code(action: ObserverAction) -> &'static str {
    match action {
        ObserverAction::Start => "start",
        ObserverAction::Pause => "pause",
        ObserverAction::Retry => "retry",
        ObserverAction::Bind => "bind",
        ObserverAction::Configure => "configure",
    }
}

fn account_action_fingerprint(accounts: &[AccountCardView]) -> String {
    account_action_bindings(accounts)
        .into_iter()
        .map(|(_, index, action, _)| {
            format!(
                "{index}:{}:{}",
                accounts[index].role,
                account_action_code(action)
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn account_action_bindings(
    accounts: &[AccountCardView],
) -> Vec<(i32, usize, ObserverAction, bool)> {
    let mut bindings = Vec::new();
    for (account_index, account) in accounts.iter().enumerate() {
        if let Some(action) = account.primary_action {
            bindings.push((
                CONTROL_ACCOUNT_ACTION_BASE + account_index as i32 * 2,
                account_index,
                action,
                matches!(
                    action,
                    ObserverAction::Start | ObserverAction::Retry | ObserverAction::Bind
                ),
            ));
        }
        if account.settings_visible {
            bindings.push((
                CONTROL_ACCOUNT_ACTION_BASE + account_index as i32 * 2 + 1,
                account_index,
                ObserverAction::Configure,
                false,
            ));
        }
    }
    bindings
}

unsafe fn sync_account_action_controls(hwnd: HWND, app: &mut AppState) {
    let fingerprint = account_action_fingerprint(&app.view.accounts);
    if app.account_action_fingerprint != fingerprint {
        for control in app.account_action_controls.drain(..) {
            unsafe { DestroyWindow(control.hwnd) };
        }
        let instance = unsafe { GetModuleHandleW(null()) };
        for (id, account_index, action, primary) in account_action_bindings(&app.view.accounts) {
            let account = &app.view.accounts[account_index];
            let text = if action == ObserverAction::Configure {
                "设置"
            } else {
                account.primary_action_text.as_deref().unwrap_or("处理中…")
            };
            app.account_action_controls.push(AccountActionControl {
                hwnd: create_button(hwnd, instance, id, text),
                id,
                account_index,
                action,
                primary,
            });
        }
        app.account_action_fingerprint = fingerprint;
        unsafe { apply_control_fonts(app) };
    }
}

unsafe fn sync_account_scrollbar(app: &mut AppState, viewport: RECT) -> AccountScrollMetrics {
    let metrics = account_scroll_metrics(&app.view.accounts, viewport, app.dpi);
    app.account_scroll_max = metrics.max_offset;
    app.account_scroll_offset = app.account_scroll_offset.clamp(0, metrics.max_offset);
    if !metrics.scrollbar_visible {
        app.account_wheel_remainder = 0;
    }
    unsafe {
        move_show(
            app.controls.account_scroll,
            metrics.scrollbar.left,
            metrics.scrollbar.top,
            metrics.scrollbar.right - metrics.scrollbar.left,
            metrics.scrollbar.bottom - metrics.scrollbar.top,
            metrics.scrollbar_visible,
        );
        let info = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_RANGE | SIF_PAGE | SIF_POS,
            nMin: 0,
            nMax: (metrics.content_height - 1).max(0),
            nPage: (metrics.content.bottom - metrics.content.top).max(0) as u32,
            nPos: app.account_scroll_offset,
            nTrackPos: 0,
        };
        SetScrollInfo(app.controls.account_scroll, SB_CTL, &info, 1);
    }
    metrics
}

unsafe fn sync_tab_order(app: &AppState) {
    let mut handles = vec![
        app.controls.platform,
        app.controls.observer,
        app.controls.logout,
        app.controls.terminal,
        app.controls.mt4_expert,
    ];
    handles.extend(
        app.account_action_controls
            .iter()
            .map(|control| control.hwnd),
    );
    handles.extend([
        app.controls.account_scroll,
        app.controls.pair,
        app.controls.detect,
        app.controls.logs,
        app.controls.settings,
        app.controls.exit,
    ]);
    let mut insert_after = windows_sys::Win32::UI::WindowsAndMessaging::HWND_TOP;
    for handle in handles.into_iter().filter(|handle| !handle.is_null()) {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
                handle,
                insert_after,
                0,
                0,
                0,
                0,
                windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE
                    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                    | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOSIZE,
            );
        }
        insert_after = handle;
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
    unsafe { sync_account_action_controls(hwnd, app) };
    let dpi = app.dpi;
    let s = |value| scale(value, dpi);
    let width = (client.right - client.left).max(s(WINDOW_MIN_WIDTH));
    let height = (client.bottom - client.top).max(s(WINDOW_MIN_HEIGHT));
    let content_width = width - s(64);
    let mut y = s(96);
    if let Some(banner) = &app.view.update_banner {
        unsafe {
            set_window_text_if_changed(app.controls.update, &banner.button_text);
            move_show(
                app.controls.update,
                width - s(148),
                y + s(14),
                s(104),
                s(36),
                banner.button_visible,
            );
        };
        y += s(76);
    } else {
        unsafe { ShowWindow(app.controls.update, SW_HIDE) };
    }
    unsafe {
        move_show(app.controls.platform, s(156), y, s(136), s(240), true);
        move_show(
            app.controls.observer,
            width - s(264),
            y,
            s(108),
            s(36),
            app.view.show_observer_sources,
        );
        move_show(
            app.controls.logout,
            width - s(148),
            y,
            s(96),
            s(36),
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
            app.controls.update,
            i32::from(
                idle && app
                    .view
                    .update_banner
                    .as_ref()
                    .is_some_and(|banner| banner.button_enabled),
            ),
        );
        EnableWindow(
            app.controls.settings,
            i32::from(idle && app.view.show_settings),
        );
        EnableWindow(
            app.controls.terminal,
            i32::from(idle && app.view.terminal_selector_visible),
        );
    }
    y += s(52);
    unsafe {
        move_show(
            app.controls.terminal,
            s(112),
            y,
            content_width - s(80),
            s(240),
            app.view.terminal_selector_visible,
        );
    }
    if app.view.terminal_selector_visible {
        y += s(52);
    }
    unsafe {
        move_show(
            app.controls.mt4_expert,
            width - s(180),
            y + s(10),
            s(128),
            s(36),
            app.view.show_mt4_setup,
        );
    }
    if app.view.show_mt4_setup {
        y += s(56);
    }
    let account_bounds = accounts_bounds(client, app);
    let account_scroll = unsafe { sync_account_scrollbar(app, account_bounds) };
    let account_cards = account_card_rects_scrolled(
        &app.view.accounts,
        account_scroll,
        app.dpi,
        app.account_scroll_offset,
    );
    let idle = !app.inbox.action_running.load(Ordering::Acquire);
    for control in &app.account_action_controls {
        let account = &app.view.accounts[control.account_index];
        let card = account_cards[control.account_index];
        let target = if control.action == ObserverAction::Configure {
            account_settings_action_rect(account, card, app.dpi)
        } else {
            account_primary_action_rect(account, card, app.dpi)
        };
        let visible = target.is_some_and(|target| {
            target.top >= account_bounds.top && target.bottom <= account_bounds.bottom
        });
        if let Some(target) = target {
            unsafe {
                move_show(
                    control.hwnd,
                    target.left,
                    target.top,
                    target.right - target.left,
                    target.bottom - target.top,
                    visible,
                );
                let text = if control.action == ObserverAction::Configure {
                    "设置"
                } else {
                    account.primary_action_text.as_deref().unwrap_or("处理中…")
                };
                set_window_text_if_changed(control.hwnd, text);
                EnableWindow(
                    control.hwnd,
                    i32::from(idle && !account.actions_busy && visible),
                );
            }
        } else {
            unsafe { ShowWindow(control.hwnd, SW_HIDE) };
        }
    }
    let bottom_y = height - s(60);
    let mut right = width - s(32);
    for (handle, visible, button_width) in [
        (app.controls.pair, app.view.show_pair, 104),
        (app.controls.detect, true, 104),
        (app.controls.logs, true, 104),
        (app.controls.settings, app.view.show_settings, 104),
        (app.controls.exit, true, 104),
    ] {
        if visible {
            let button_width = s(button_width);
            right -= button_width;
            unsafe { move_show(handle, right, bottom_y, button_width, s(36), true) };
            right -= s(8);
        } else {
            unsafe { ShowWindow(handle, SW_HIDE) };
        }
    }
    unsafe { sync_tab_order(app) };
    let _ = y;
    unsafe { InvalidateRect(hwnd, null(), 0) };
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
    let width = width.max(0);
    let mut current = RECT::default();
    let mut current_top_left = POINT::default();
    let mut current_bottom_right = POINT::default();
    let parent = unsafe { GetParent(hwnd) };
    let position_changed = if !parent.is_null() && unsafe { GetWindowRect(hwnd, &mut current) } != 0
    {
        current_top_left.x = current.left;
        current_top_left.y = current.top;
        current_bottom_right.x = current.right;
        current_bottom_right.y = current.bottom;
        unsafe {
            ScreenToClient(parent, &mut current_top_left);
            ScreenToClient(parent, &mut current_bottom_right);
        }
        current_top_left.x != x
            || current_top_left.y != y
            || current_bottom_right.x - current_top_left.x != width
            || current_bottom_right.y - current_top_left.y != height
    } else {
        true
    };
    unsafe {
        if position_changed {
            MoveWindow(hwnd, x, y, width, height, 1);
        }
        if (IsWindowVisible(hwnd) != 0) != visible {
            ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
        }
    }
}

unsafe fn set_window_text_if_changed(hwnd: HWND, text: &str) {
    let length = unsafe { GetWindowTextLengthW(hwnd) }.max(0) as usize;
    let mut current = vec![0_u16; length + 1];
    let copied =
        unsafe { GetWindowTextW(hwnd, current.as_mut_ptr(), current.len() as i32) }.max(0) as usize;
    let requested = wide(text);
    if current[..copied] != requested[..requested.len().saturating_sub(1)] {
        unsafe { SetWindowTextW(hwnd, requested.as_ptr()) };
    }
}

unsafe fn paint_window(hwnd: HWND, app: &AppState) {
    let mut paint = windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT::default();
    let paint_hdc = unsafe { windows_sys::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint) };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let client_width = (client.right - client.left).max(1);
    let client_height = (client.bottom - client.top).max(1);
    let memory_dc = unsafe { CreateCompatibleDC(paint_hdc) };
    let memory_bitmap = if memory_dc.is_null() {
        null_mut()
    } else {
        unsafe { CreateCompatibleBitmap(paint_hdc, client_width, client_height) }
    };
    let previous_bitmap = if memory_bitmap.is_null() {
        null_mut()
    } else {
        unsafe { SelectObject(memory_dc, memory_bitmap as HGDIOBJ) }
    };
    let hdc = if previous_bitmap.is_null() {
        paint_hdc
    } else {
        memory_dc
    };
    fill(hdc, client, Rgb(248, 250, 252));
    let s = |value| scale(value, app.dpi);
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    draw_text(
        hdc,
        &app.view.heading,
        rect(s(32), s(22), width - s(32), s(52)),
        app.fonts.heading,
        Rgb(15, 23, 42),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        &app.view.subtitle,
        rect(s(32), s(54), width - s(32), s(78)),
        app.fonts.body,
        Rgb(71, 85, 105),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let mut y = s(96);
    if let Some(banner) = &app.view.update_banner {
        fill(
            hdc,
            rect(s(32), y, width - s(32), y + s(64)),
            banner.background,
        );
        draw_text(
            hdc,
            &banner.title,
            rect(s(46), y + s(8), width - s(166), y + s(30)),
            app.fonts.body_bold,
            banner.title_color,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
        draw_text(
            hdc,
            &banner.description,
            rect(s(46), y + s(30), width - s(166), y + s(57)),
            app.fonts.small,
            banner.description_color,
            DT_LEFT | DT_WORDBREAK,
        );
        y += s(76);
    }
    draw_text(
        hdc,
        "选择交易平台",
        rect(s(32), y, s(148), y + s(36)),
        app.fonts.body_bold,
        Rgb(51, 65, 85),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    y += s(52);
    if app.view.terminal_selector_visible {
        draw_text(
            hdc,
            &app.view.terminal_selector_label,
            rect(s(32), y, s(104), y + s(36)),
            app.fonts.body,
            Rgb(51, 65, 85),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        y += s(52);
    }
    if app.view.show_mt4_setup {
        fill(
            hdc,
            rect(s(32), y, width - s(32), y + s(56)),
            Rgb(239, 246, 255),
        );
        draw_text(
            hdc,
            "MT4 重装或 EA 丢失时，可随时重新安装。",
            rect(s(44), y + s(10), width - s(190), y + s(46)),
            app.fonts.body,
            Rgb(30, 64, 175),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        y += s(72);
    }
    let card_bottom = height - s(104);
    let card = rect(s(32), y, width - s(32), card_bottom);
    fill(hdc, card, Rgb(255, 255, 255));
    fill(
        hdc,
        rect(s(52), y + s(28), s(60), y + s(36)),
        app.view.status.accent,
    );
    draw_text(
        hdc,
        &app.view.status.title,
        rect(s(72), y + s(18), width - s(52), y + s(46)),
        app.fonts.title,
        Rgb(15, 23, 42),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    draw_text(
        hdc,
        &app.view.status.description,
        rect(s(72), y + s(48), width - s(52), y + s(82)),
        app.fonts.body,
        Rgb(71, 85, 105),
        DT_LEFT | DT_WORDBREAK,
    );
    draw_text(
        hdc,
        &app.view.runtime_summary,
        rect(s(72), y + s(82), width - s(52), y + s(108)),
        app.fonts.small,
        Rgb(100, 116, 139),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    fill(
        hdc,
        rect(s(52), y + s(116), width - s(52), y + s(117)),
        Rgb(226, 232, 240),
    );
    draw_text(
        hdc,
        "账户连接",
        rect(s(52), y + s(124), width - s(120), y + s(148)),
        app.fonts.body_bold,
        Rgb(51, 65, 85),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        &app.view.account_count_text,
        rect(width - s(120), y + s(124), width - s(52), y + s(148)),
        app.fonts.body,
        Rgb(100, 116, 139),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let accounts_top = y + s(154);
    if app.view.accounts.is_empty() {
        draw_text(
            hdc,
            app.view
                .empty_accounts_text
                .as_deref()
                .unwrap_or("尚未识别到交易账户"),
            rect(s(52), accounts_top, width - s(52), accounts_top + s(40)),
            app.fonts.body,
            Rgb(100, 116, 139),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
    } else {
        draw_account_cards(
            hdc,
            app,
            rect(s(52), accounts_top, width - s(52), card_bottom - s(8)),
        );
    }
    draw_text(
        hdc,
        SAFETY_COPY,
        rect(s(32), height - s(100), width - s(32), height - s(68)),
        app.fonts.small,
        Rgb(100, 116, 139),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    if !previous_bitmap.is_null() {
        unsafe {
            BitBlt(
                paint_hdc,
                0,
                0,
                client_width,
                client_height,
                memory_dc,
                0,
                0,
                SRCCOPY,
            );
            SelectObject(memory_dc, previous_bitmap);
            DeleteObject(memory_bitmap as HGDIOBJ);
        }
    }
    if !memory_dc.is_null() {
        unsafe { DeleteDC(memory_dc) };
    }
    unsafe { windows_sys::Win32::Graphics::Gdi::EndPaint(hwnd, &paint) };
}

fn draw_account_cards(hdc: HDC, app: &AppState, bounds: RECT) {
    let metrics = account_scroll_metrics(&app.view.accounts, bounds, app.dpi);
    let saved = unsafe { SaveDC(hdc) };
    if saved == 0 {
        return;
    }
    unsafe {
        IntersectClipRect(hdc, bounds.left, bounds.top, bounds.right, bounds.bottom);
    }
    for (account, card_bounds) in app.view.accounts.iter().zip(account_card_rects_scrolled(
        &app.view.accounts,
        metrics,
        app.dpi,
        app.account_scroll_offset,
    )) {
        if card_bounds.bottom > bounds.top && card_bounds.top < bounds.bottom {
            draw_account_card(hdc, app, account, card_bounds);
        }
    }
    unsafe { RestoreDC(hdc, saved) };
}

fn account_card_rects(accounts: &[AccountCardView], bounds: RECT, dpi: u32) -> Vec<RECT> {
    let gap = scale(8, dpi);
    let available_width = bounds.right - bounds.left;
    let logical_available_width = ((i64::from(available_width) * 96) / i64::from(dpi)) as i32;
    let columns = resolve_account_column_count(logical_available_width).max(1);
    let card_width = ((available_width - gap * (columns - 1)) / columns).max(scale(240, dpi));
    let mut result = Vec::with_capacity(accounts.len());
    let mut row_top = bounds.top;
    for row in accounts.chunks(columns as usize) {
        let row_height = row
            .iter()
            .map(|account| account_card_height(account, dpi))
            .max()
            .unwrap_or_else(|| scale(70, dpi));
        for (column, account) in row.iter().enumerate() {
            let left = bounds.left + column as i32 * (card_width + gap);
            let height = account_card_height(account, dpi);
            result.push(rect(left, row_top, left + card_width, row_top + height));
        }
        row_top += row_height + gap;
    }
    result
}

#[derive(Clone, Copy)]
struct AccountScrollMetrics {
    content: RECT,
    scrollbar: RECT,
    content_height: i32,
    max_offset: i32,
    scrollbar_visible: bool,
}

fn account_scroll_metrics(
    accounts: &[AccountCardView],
    viewport: RECT,
    dpi: u32,
) -> AccountScrollMetrics {
    let scrollbar_width = scale(17, dpi);
    let scrollbar_gap = scale(4, dpi);
    let content = rect(
        viewport.left,
        viewport.top,
        (viewport.right - scrollbar_width - scrollbar_gap).max(viewport.left),
        viewport.bottom,
    );
    let scrollbar = rect(
        content.right + scrollbar_gap,
        viewport.top,
        viewport.right,
        viewport.bottom,
    );
    let cards = account_card_rects(accounts, content, dpi);
    let content_height = cards
        .iter()
        .map(|card| card.bottom)
        .max()
        .map(|bottom| bottom - content.top)
        .unwrap_or(0)
        .max(0);
    let viewport_height = (content.bottom - content.top).max(0);
    let max_offset = (content_height - viewport_height).max(0);
    AccountScrollMetrics {
        content,
        scrollbar,
        content_height,
        max_offset,
        scrollbar_visible: max_offset > 0,
    }
}

fn account_card_rects_scrolled(
    accounts: &[AccountCardView],
    metrics: AccountScrollMetrics,
    dpi: u32,
    offset: i32,
) -> Vec<RECT> {
    let offset = offset.clamp(0, metrics.max_offset);
    account_card_rects(accounts, metrics.content, dpi)
        .into_iter()
        .map(|card| {
            rect(
                card.left,
                card.top - offset,
                card.right,
                card.bottom - offset,
            )
        })
        .collect()
}

fn rescale_scroll_offset(offset: i32, old_dpi: u32, new_dpi: u32) -> i32 {
    if old_dpi == 0 {
        return offset.max(0);
    }
    ((i64::from(offset.max(0)) * i64::from(new_dpi)) / i64::from(old_dpi)) as i32
}

fn account_card_height(account: &AccountCardView, dpi: u32) -> i32 {
    scale(
        if account.permission.is_none() {
            70
        } else if account.mt4_expert_update.is_some() {
            112
        } else {
            88
        },
        dpi,
    )
}

fn draw_account_card(hdc: HDC, app: &AppState, account: &AccountCardView, bounds: RECT) {
    let s = |value| scale(value, app.dpi);
    fill(hdc, bounds, Rgb(248, 250, 252));
    let action_count =
        usize::from(account.settings_visible) + usize::from(account.primary_action.is_some());
    let action_left = bounds.right - action_count as i32 * s(76);
    let copy_right = if action_count == 0 {
        bounds.right - s(8)
    } else {
        action_left - s(8)
    };
    fill(
        hdc,
        rect(
            bounds.left + s(16),
            bounds.top + (bounds.bottom - bounds.top - s(8)) / 2,
            bounds.left + s(24),
            bounds.top + (bounds.bottom - bounds.top - s(8)) / 2 + s(8),
        ),
        account.state_color,
    );
    draw_text(
        hdc,
        &account.title,
        rect(
            bounds.left + s(34),
            bounds.top + s(7),
            copy_right,
            bounds.top + s(30),
        ),
        app.fonts.body_bold,
        Rgb(30, 41, 59),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    draw_text(
        hdc,
        &account.state,
        rect(
            bounds.left + s(34),
            bounds.top + s(30),
            copy_right,
            bounds.top + s(54),
        ),
        app.fonts.body,
        Rgb(71, 85, 105),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
    if let Some(permission) = &account.permission {
        let badge = permission_badge_rect(bounds, app.dpi);
        fill(hdc, badge, permission.background);
        draw_text(
            hdc,
            &permission.summary,
            rect(
                badge.left + s(8),
                badge.top,
                badge.right - s(6),
                badge.bottom,
            ),
            app.fonts.small,
            permission.foreground,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
    }
    if let Some(expert_update) = &account.mt4_expert_update {
        let badge = rect(
            bounds.left + s(34),
            bounds.top + s(85),
            (bounds.left + s(244)).min(copy_right),
            bounds.top + s(109),
        );
        fill(hdc, badge, Rgb(254, 243, 199));
        draw_text(
            hdc,
            expert_update,
            rect(
                badge.left + s(8),
                badge.top,
                badge.right - s(6),
                badge.bottom,
            ),
            app.fonts.small,
            Rgb(146, 64, 14),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
        );
    }
}

fn permission_badge_rect(card: RECT, dpi: u32) -> RECT {
    rect(
        card.left + scale(34, dpi),
        card.top + scale(58, dpi),
        card.left + scale(134, dpi),
        card.top + scale(82, dpi),
    )
}

fn accounts_bounds(client: RECT, app: &AppState) -> RECT {
    let s = |value| scale(value, app.dpi);
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    let mut y = s(96);
    if app.view.update_banner.is_some() {
        y += s(76);
    }
    y += s(52);
    if app.view.terminal_selector_visible {
        y += s(52);
    }
    if app.view.show_mt4_setup {
        y += s(72);
    }
    rect(s(52), y + s(154), width - s(52), height - s(112))
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

fn account_scroll_target(
    current: i32,
    max_offset: i32,
    viewport_height: i32,
    line_height: i32,
    command: i32,
    thumb_position: i32,
) -> i32 {
    let page = (viewport_height - line_height).max(line_height);
    let target = match command {
        SB_LINEUP => current - line_height,
        SB_LINEDOWN => current + line_height,
        SB_PAGEUP => current - page,
        SB_PAGEDOWN => current + page,
        SB_THUMBPOSITION | SB_THUMBTRACK => thumb_position,
        SB_TOP => 0,
        SB_BOTTOM => max_offset,
        _ => current,
    };
    target.clamp(0, max_offset.max(0))
}

unsafe fn scroll_accounts_to(hwnd: HWND, app: &mut AppState, target: i32) -> bool {
    let target = target.clamp(0, app.account_scroll_max.max(0));
    if app.account_scroll_offset == target {
        return false;
    }
    app.account_scroll_offset = target;
    app.hovered_permission_account = None;
    unsafe {
        permission_tooltip::hide(app.permission_tooltip);
        apply_layout(hwnd, app);
    }
    true
}

unsafe fn handle_account_vertical_scroll(
    hwnd: HWND,
    app: &mut AppState,
    wparam: WPARAM,
    source: HWND,
) -> bool {
    if source != app.controls.account_scroll || app.account_scroll_max <= 0 {
        return false;
    }
    let command = (wparam & 0xffff) as i32;
    let mut scroll_info = SCROLLINFO {
        cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
        fMask: SIF_TRACKPOS,
        ..SCROLLINFO::default()
    };
    unsafe { GetScrollInfo(app.controls.account_scroll, SB_CTL, &mut scroll_info) };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let metrics = account_scroll_metrics(&app.view.accounts, accounts_bounds(client, app), app.dpi);
    let target = account_scroll_target(
        app.account_scroll_offset,
        metrics.max_offset,
        metrics.content.bottom - metrics.content.top,
        scale(40, app.dpi),
        command,
        scroll_info.nTrackPos,
    );
    unsafe { scroll_accounts_to(hwnd, app, target) };
    true
}

unsafe fn handle_account_mouse_wheel(
    hwnd: HWND,
    app: &mut AppState,
    wparam: WPARAM,
    lparam: LPARAM,
) -> bool {
    if app.account_scroll_max <= 0 {
        return false;
    }
    let mut point = point_from_lparam(lparam);
    unsafe { ScreenToClient(hwnd, &mut point) };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    if !point_in_rect(point, accounts_bounds(client, app)) {
        return false;
    }
    let delta = ((wparam >> 16) as u16 as i16) as i32;
    app.account_wheel_remainder += delta;
    let steps = app.account_wheel_remainder / WHEEL_DELTA as i32;
    app.account_wheel_remainder %= WHEEL_DELTA as i32;
    if steps != 0 {
        let target = app.account_scroll_offset - steps * scale(120, app.dpi);
        unsafe { scroll_accounts_to(hwnd, app, target) };
    }
    true
}

unsafe fn handle_account_scroll_key(
    hwnd: HWND,
    app: &mut AppState,
    source: HWND,
    key: WPARAM,
) -> bool {
    if app.account_scroll_max <= 0
        || (source != app.controls.account_scroll
            && !app
                .account_action_controls
                .iter()
                .any(|control| control.hwnd == source))
    {
        return false;
    }
    let command = match key as u16 {
        VK_UP => SB_LINEUP,
        VK_DOWN => SB_LINEDOWN,
        VK_PRIOR => SB_PAGEUP,
        VK_NEXT => SB_PAGEDOWN,
        VK_HOME => SB_TOP,
        VK_END => SB_BOTTOM,
        _ => return false,
    };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let metrics = account_scroll_metrics(&app.view.accounts, accounts_bounds(client, app), app.dpi);
    let target = account_scroll_target(
        app.account_scroll_offset,
        metrics.max_offset,
        metrics.content.bottom - metrics.content.top,
        scale(40, app.dpi),
        command,
        0,
    );
    unsafe { scroll_accounts_to(hwnd, app, target) };
    true
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
    if !point_in_rect(point, bounds) {
        app.hovered_permission_account = None;
        unsafe { permission_tooltip::hide(app.permission_tooltip) };
        return;
    }
    let metrics = account_scroll_metrics(&app.view.accounts, bounds, app.dpi);
    let cards = account_card_rects_scrolled(
        &app.view.accounts,
        metrics,
        app.dpi,
        app.account_scroll_offset,
    );
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
                    .filter(|_| point_in_rect(point, permission_badge_rect(card, app.dpi)))
                    .map(|permission| (index, permission, permission_badge_rect(card, app.dpi)))
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
                    app.dpi,
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
    let bounds = accounts_bounds(client, app);
    if !point_in_rect(point, bounds) {
        return;
    }
    let metrics = account_scroll_metrics(&app.view.accounts, bounds, app.dpi);
    let cards = account_card_rects_scrolled(
        &app.view.accounts,
        metrics,
        app.dpi,
        app.account_scroll_offset,
    );
    let clicked = app.view.accounts.iter().zip(cards).enumerate().find_map(
        |(account_index, (account, bounds))| {
            if account.actions_busy {
                return None;
            }
            if account_primary_action_rect(account, bounds, app.dpi)
                .is_some_and(|region| point_in_rect(point, region))
            {
                return account.primary_action.map(|action| (account_index, action));
            }
            if account_settings_action_rect(account, bounds, app.dpi)
                .is_some_and(|region| point_in_rect(point, region))
            {
                return Some((account_index, ObserverAction::Configure));
            }
            None
        },
    );
    let Some((account_index, action)) = clicked else {
        return;
    };
    unsafe { handle_account_action(hwnd, app, account_index, action) };
}

unsafe fn handle_account_action(
    hwnd: HWND,
    app: &mut AppState,
    account_index: usize,
    action: ObserverAction,
) {
    if app.inbox.action_running.load(Ordering::Acquire) {
        return;
    }
    let Some(account) = app.view.accounts.get(account_index) else {
        return;
    };
    if account.actions_busy {
        return;
    }
    let profile_id = account.role.clone();
    if matches!(action, ObserverAction::Bind | ObserverAction::Configure) {
        unsafe { open_existing_observer_dialog(hwnd, app, &profile_id) };
        return;
    }
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

fn account_primary_action_rect(account: &AccountCardView, bounds: RECT, dpi: u32) -> Option<RECT> {
    account.primary_action?;
    let action_count =
        i32::from(account.settings_visible) + i32::from(account.primary_action.is_some());
    let action_left = bounds.right - action_count * scale(76, dpi);
    let top = bounds.top + (bounds.bottom - bounds.top - scale(34, dpi)) / 2;
    Some(rect(
        action_left + scale(3, dpi),
        top,
        action_left + scale(73, dpi),
        top + scale(34, dpi),
    ))
}

fn account_settings_action_rect(account: &AccountCardView, bounds: RECT, dpi: u32) -> Option<RECT> {
    if !account.settings_visible {
        return None;
    }
    let action_count =
        i32::from(account.settings_visible) + i32::from(account.primary_action.is_some());
    let action_left = bounds.right - action_count * scale(76, dpi);
    let settings_left = action_left + i32::from(account.primary_action.is_some()) * scale(76, dpi);
    let top = bounds.top + (bounds.bottom - bounds.top - scale(34, dpi)) / 2;
    Some(rect(
        settings_left + scale(3, dpi),
        top,
        settings_left + scale(73, dpi),
        top + scale(34, dpi),
    ))
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

unsafe fn draw_control(app: &AppState, lparam: LPARAM) -> LRESULT {
    let item = lparam as *const DRAWITEMSTRUCT;
    if item.is_null() {
        return 0;
    }
    let item = unsafe { &*item };
    if item.CtlType == ODT_COMBOBOX && item.CtlID as i32 == CONTROL_PLATFORM {
        draw_platform_item(app, item);
        return 1;
    }
    let control_id = item.CtlID as i32;
    let primary = matches!(control_id, CONTROL_PAIR | CONTROL_UPDATE)
        || app
            .account_action_controls
            .iter()
            .any(|control| control.id == control_id && control.primary);
    unsafe { draw_button(lparam, primary) }
}

unsafe fn draw_button(lparam: LPARAM, primary: bool) -> LRESULT {
    let item = lparam as *const DRAWITEMSTRUCT;
    if item.is_null() {
        return 0;
    }
    let item = unsafe { &*item };
    if item.CtlType != ODT_BUTTON {
        return 0;
    }
    let disabled = item.itemState & ODS_DISABLED != 0;
    let selected = item.itemState & ODS_SELECTED != 0;
    let (background, foreground) = button_colors(primary, disabled, selected);
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

fn button_colors(primary: bool, disabled: bool, selected: bool) -> (Rgb, Rgb) {
    if disabled {
        return (Rgb(226, 232, 240), Rgb(148, 163, 184));
    }
    if primary {
        return (
            if selected {
                Rgb(29, 78, 216)
            } else {
                Rgb(37, 99, 235)
            },
            Rgb(255, 255, 255),
        );
    }
    (
        if selected {
            Rgb(241, 245, 249)
        } else {
            Rgb(255, 255, 255)
        },
        Rgb(30, 41, 59),
    )
}

fn draw_platform_item(app: &AppState, item: &DRAWITEMSTRUCT) {
    let edit_surface = item.itemState & ODS_COMBOBOXEDIT != 0;
    let selected = !edit_surface && item.itemState & ODS_SELECTED != 0;
    let disabled = item.itemState & ODS_DISABLED != 0;
    let background = if disabled {
        Rgb(248, 250, 252)
    } else if selected {
        system_color(COLOR_HIGHLIGHT)
    } else {
        Rgb(255, 255, 255)
    };
    let foreground = if disabled {
        Rgb(100, 116, 139)
    } else if selected {
        system_color(COLOR_HIGHLIGHTTEXT)
    } else {
        Rgb(30, 41, 59)
    };
    fill(item.hDC, item.rcItem, background);
    let text = match item.itemID {
        0 => "MT5",
        1 => "MT4",
        _ => "",
    };
    let mut text_bounds = item.rcItem;
    text_bounds.left += scale(8, app.dpi);
    text_bounds.right -= scale(12, app.dpi);
    draw_text(
        item.hDC,
        text,
        text_bounds,
        app.fonts.platform,
        foreground,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    if item.itemState & ODS_FOCUS != 0 && !edit_surface {
        unsafe { DrawFocusRect(item.hDC, &item.rcItem) };
    }
}

fn system_color(index: i32) -> Rgb {
    let value = unsafe { GetSysColor(index) };
    Rgb(
        (value & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        ((value >> 16) & 0xff) as u8,
    )
}

unsafe fn handle_command(hwnd: HWND, app: &mut AppState, id: i32, notification: u32) {
    if notification == 0
        && let Some((account_index, action)) = app
            .account_action_controls
            .iter()
            .find(|control| control.id == id)
            .map(|control| (control.account_index, control.action))
    {
        unsafe { handle_account_action(hwnd, app, account_index, action) };
        return;
    }
    if app.demo_mode
        && matches!(
            id,
            CONTROL_SETTINGS
                | MENU_SETTINGS_COMMAND
                | MENU_RECOVER_OFFICIAL_COMMAND
                | MENU_REALTIME_COMPATIBILITY_COMMAND
        )
    {
        return;
    }
    if let Some(action) = fixed_button_action(id) {
        unsafe { begin_action(hwnd, app, action) };
        return;
    }
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
        CONTROL_OBSERVER => unsafe { open_observer_dialog(hwnd, app) },
        CONTROL_DETECT => unsafe { begin_action(hwnd, app, LocalControlAction::Redetect) },
        CONTROL_LOGS => match default_root_data_directory() {
            Ok(root_data_directory) => {
                match log_viewer::profile_log_directories(&root_data_directory) {
                    Ok(log_directories) => match unsafe {
                        log_viewer::show_or_refresh(
                            app.log_window,
                            hwnd,
                            &log_directories,
                            app.brand_icon,
                        )
                    } {
                        Ok(log_window) => app.log_window = log_window,
                        Err(code) => show_error(hwnd, code),
                    },
                    Err(code) => show_error(hwnd, code),
                }
            }
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
        id if is_user_exit_command(id) && confirm_user_exit(hwnd) => unsafe {
            complete_bridge_exit(hwnd, app)
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
        MENU_REALTIME_COMPATIBILITY_COMMAND => {
            let enabled = default_root_data_directory()
                .map(|directory| !realtime_compatibility_enabled(directory))
                .unwrap_or(true);
            unsafe {
                begin_action(
                    hwnd,
                    app,
                    LocalControlAction::RealtimeCompatibilitySet { enabled },
                )
            }
        }
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

fn fixed_button_action(id: i32) -> Option<LocalControlAction> {
    match id {
        CONTROL_MT4_EXPERT => Some(LocalControlAction::InstallMt4Ea),
        CONTROL_UPDATE => Some(LocalControlAction::UpdateActivate),
        _ => None,
    }
}

unsafe fn open_observer_dialog(hwnd: HWND, app: &mut AppState) {
    match unsafe {
        observer_profile_dialog::show_modal(hwnd, app.brand_icon, &app.state.observer_sources, None)
    } {
        Ok(Some(observer)) => unsafe {
            begin_action(hwnd, app, LocalControlAction::ObserverCreate { observer })
        },
        Ok(None) => {}
        Err(code) => show_error(hwnd, code),
    }
}

unsafe fn open_existing_observer_dialog(hwnd: HWND, app: &mut AppState, profile_id: &str) {
    let Some(profile) = app
        .state
        .observer_profiles
        .iter()
        .find(|profile| profile.observer_profile_id == profile_id)
        .cloned()
    else {
        show_error(hwnd, "bridge_observer_profile_not_found");
        return;
    };
    let existing = observer_dialog_existing(&profile);
    match unsafe {
        observer_profile_dialog::show_modal(
            hwnd,
            app.brand_icon,
            &app.state.observer_sources,
            Some(existing),
        )
    } {
        Ok(Some(observer)) => {
            app.busy_observer_profiles
                .insert(observer.observer_profile_id.clone());
            if let Ok(view) =
                build_main_window_view(&app.state, &app.busy_observer_profiles, format_local_time)
            {
                app.view = view;
                unsafe { apply_layout(hwnd, app) };
            }
            unsafe { begin_action(hwnd, app, LocalControlAction::ObserverUpdate { observer }) };
        }
        Ok(None) => {}
        Err(code) => show_error(hwnd, code),
    }
}

fn observer_dialog_existing(
    profile: &UiObserverProfile,
) -> observer_profile_dialog::ExistingObserverProfile {
    observer_profile_dialog::ExistingObserverProfile {
        observer_profile_id: profile.observer_profile_id.clone(),
        bridge_user_id: profile.bridge_user_id,
        platform: profile.platform.clone().unwrap_or_else(|| "mt5".to_owned()),
        terminal_directory: profile.terminal_directory.clone().unwrap_or_default(),
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
    if app.demo_mode {
        if action == LocalControlAction::BridgeExit {
            unsafe { DestroyWindow(hwnd) };
        }
        return;
    }
    if app.inbox.action_running.swap(true, Ordering::AcqRel) {
        return;
    }
    let profile_id = app.profile_id.clone();
    let inbox = Arc::clone(&app.inbox);
    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        let result = run_local_request(
            &profile_id,
            &inbox,
            action.clone(),
            local_action_timeout(&action),
        );
        if let Ok(mut messages) = inbox.messages.lock() {
            messages.push_back(UiMessage::Action { action, result });
        }
        inbox.action_running.store(false, Ordering::Release);
        unsafe { PostMessageW(hwnd_value as HWND, WM_ACTION_READY, 0, 0) };
    });
}

fn local_action_timeout(action: &LocalControlAction) -> Duration {
    match action {
        LocalControlAction::ObserverCreate { .. }
        | LocalControlAction::ObserverUpdate { .. }
        | LocalControlAction::ObserverBind { .. }
        | LocalControlAction::ObserverStart { .. }
        | LocalControlAction::ObserverPause { .. }
        | LocalControlAction::ObserverRetry { .. } => Duration::from_secs(30),
        LocalControlAction::SettingsTest { .. } => Duration::from_secs(20),
        LocalControlAction::SettingsSave { .. } | LocalControlAction::SettingsRestoreOfficial => {
            Duration::from_secs(10)
        }
        _ => Duration::from_secs(2),
    }
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
                if app.view != view {
                    app.view = view;
                    unsafe { apply_layout(hwnd, app) };
                }
            }
        }
        Some(UiMessage::Action {
            result: Ok(LocalControlResult::PairingUrl { url }),
            ..
        }) => {
            open_browser(&url);
        }
        Some(UiMessage::Action {
            result: Ok(LocalControlResult::Mt4EaDeployment { status }),
            ..
        }) => {
            show_mt4_expert_deployment(hwnd, &status);
            unsafe { begin_state_poll(hwnd, app) };
        }
        Some(UiMessage::Action {
            action: LocalControlAction::BridgeExit,
            ..
        }) => unsafe {
            complete_bridge_exit(hwnd, app);
        },
        Some(UiMessage::Action {
            result: Ok(LocalControlResult::Accepted),
            ..
        }) => {
            unsafe { begin_state_poll(hwnd, app) };
        }
        Some(UiMessage::Action {
            result: Ok(LocalControlResult::Rejected { code }),
            ..
        }) if code == "bridge_pair_in_progress" => {
            let restart = show_confirmation(
                hwnd,
                "授权页面可能仍在打开。\n\n如果页面还在，请继续完成授权，不会再打开新页面。\n\n如果页面已经关闭，点击“是”作废旧授权码并重新打开；点击“否”保留当前授权。",
                "重新打开授权页面？",
            );
            if restart {
                unsafe { begin_action(hwnd, app, LocalControlAction::PairRestart) };
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
    let text = wide(error_message(code));
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

fn error_message(code: &str) -> &'static str {
    match code {
        "bridge_local_control_action_unavailable" => "该功能正在迁移到新版核心，当前尚不可用。",
        "bridge_pair_in_progress" => {
            "正在准备新的授权页面，请稍候；如果浏览器没有打开，请再次点击“连接账号”。"
        }
        "bridge_pair_start_rate_limited" => {
            "授权请求过于频繁，请稍等几分钟后再试，请勿反复点击“连接账号”。"
        }
        "mt4_platform_not_selected" => "请先将交易平台切换为 MT4。",
        "mt4_terminal_not_found" => "未发现 MT4，请先打开一次 MT4，然后点击“重新检测”。",
        "mt4_terminal_selection_required" => "检测到多个 MT4，请先选择需要安装 EA 的终端。",
        "mt4_terminal_data_path_not_found" => "当前 MT4 数据目录已不存在，请重新选择 MT4。",
        "mt4_ea_package_not_found" | "mt4_ea_package_invalid" => {
            "MT4 EA 组件不完整，请重新安装或修复量见智桥。"
        }
        "mt4_ea_install_access_denied" => {
            "无法写入 MT4 数据目录，请关闭 MT4 后重试，或检查当前 Windows 账户权限。"
        }
        "mt4_ea_install_io_failed" | "mt4_ea_install_failed" => {
            "MT4 EA 暂时无法安装，请关闭 MT4 后重新尝试。"
        }
        "bridge_observer_management_forbidden" => "只有管理员账号可以管理观摩源。",
        "bridge_observer_sources_empty" => "当前没有可绑定的观摩账户，请先在管理后台创建。",
        "bridge_pair_source_invalid" => "所选观摩账户已不可用，请刷新后重新选择。",
        "bridge_observer_profile_exists" => "该观摩源名称已经存在，请直接打开已有观摩源。",
        "bridge_observer_profile_not_found" => "该观摩源已不存在，请刷新后重试。",
        "bridge_observer_profile_limit_exceeded" => {
            "观摩源数量已达到上限，请先删除不再使用的观摩源。"
        }
        "bridge_observer_profile_not_configured" => "请先设置观摩账户和独立交易终端。",
        "observer_terminal_already_assigned" => {
            "该交易终端已被主账户或其他观摩源使用，请选择独立终端。"
        }
        "bridge_observer_mt4_directory_invalid" => {
            "未找到对应的 MT4，请选择它的安装目录或数据目录。"
        }
        "bridge_observer_mt5_directory_invalid" => {
            "所选目录中没有 MT5 终端程序，请重新选择安装目录。"
        }
        "bridge_observer_runtime_stop_timeout" => "旧观摩源进程未能及时退出，请稍后重试。",
        "bridge_update_runtime_unavailable" => "当前运行方式不支持自动更新，请使用正式安装版本。",
        "bridge_update_not_ready" => "当前没有已下载并通过校验的更新。",
        "bridge_ui_update_launcher_invalid" | "bridge_ui_update_handoff_invalid" => {
            "更新启动信息无效，请重新打开量见智桥后再试。"
        }
        "bridge_ui_update_launcher_start_failed" => "无法启动更新程序，请手动重新打开量见智桥。",
        "update_state_invalid" | "update_state_io_failed" => {
            "更新状态暂时不可用，当前桥接和交易不受影响。"
        }
        _ => "量见智桥暂时无法完成操作，请稍后重试。",
    }
}

fn show_mt4_expert_deployment(hwnd: HWND, status: &str) {
    let summary = if status == "installed" {
        "EA 已安装到当前 MT4。"
    } else {
        "EA 已经是最新版本。"
    };
    let message = format!(
        "{summary}\n\n接下来请在 MT4 中完成：\n\n\
         1. 打开“导航器 → 智能交易系统”，右键刷新。\n\
         2. 将 AURUMBridgeEA 拖到任意一个保持打开的图表。\n\
         3. 在 EA 属性的“常用”页勾选“允许实时自动交易”。\n\
         4. 确认 MT4 顶部“自动交易”按钮已开启。\n\n\
         无需开启 DLL 导入或 WebRequest。"
    );
    let text = wide(&message);
    let title = wide("安装 / 修复 MT4 EA");
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            hwnd,
            text.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_OK
                | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION,
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
        default_root_data_directory()
            .map(realtime_compatibility_enabled)
            .unwrap_or(false),
    );
    let open = wide("打开量见智桥");
    let autostart = wide("开机自动启动（推荐）");
    let realtime_compatibility = wide("旧系统兼容模式（WS）");
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
            windows_sys::Win32::UI::WindowsAndMessaging::AppendMenuW(
                menu,
                MF_STRING
                    | disabled
                    | if view.realtime_compatibility_checked {
                        MF_CHECKED
                    } else {
                        0
                    },
                MENU_REALTIME_COMPATIBILITY,
                realtime_compatibility.as_ptr(),
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
        PostMessageW(hwnd, WM_NULL, 0, 0);
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

unsafe fn create_fonts(dpi: u32) -> Fonts {
    Fonts {
        body: create_point_font(90, dpi, FW_NORMAL as i32),
        body_bold: create_point_font(90, dpi, FW_BOLD as i32),
        platform: create_point_font(95, dpi, FW_NORMAL as i32),
        heading: create_point_font(180, dpi, FW_BOLD as i32),
        title: create_point_font(120, dpi, FW_BOLD as i32),
        small: create_point_font(85, dpi, FW_NORMAL as i32),
    }
}

fn create_point_font(point_size_tenths: i32, dpi: u32, weight: i32) -> HFONT {
    create_point_font_family("Microsoft YaHei UI", point_size_tenths, dpi, weight)
}

fn create_point_font_family(family: &str, point_size_tenths: i32, dpi: u32, weight: i32) -> HFONT {
    let face = wide(family);
    let pixel_height = ((point_size_tenths as i64 * i64::from(dpi) + 360) / 720) as i32;
    create_named_font(&face, pixel_height, weight)
}

fn create_named_font(face: &[u16], pixel_height: i32, weight: i32) -> HFONT {
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

fn scale(value: i32, dpi: u32) -> i32 {
    ((i64::from(value) * i64::from(dpi) + 48) / 96) as i32
}

fn system_dpi() -> u32 {
    let screen = unsafe { GetDC(null_mut()) };
    if screen.is_null() {
        return 96;
    }
    let dpi = unsafe { GetDeviceCaps(screen, LOGPIXELSX as i32) };
    unsafe { ReleaseDC(null_mut(), screen) };
    u32::try_from(dpi)
        .ok()
        .filter(|value| *value >= 96)
        .unwrap_or(96)
}

fn window_dpi(hwnd: HWND) -> u32 {
    if hwnd.is_null() {
        return system_dpi();
    }
    let module_name = wide("user32.dll");
    let module = unsafe { GetModuleHandleW(module_name.as_ptr()) };
    if !module.is_null()
        && let Some(procedure) =
            unsafe { GetProcAddress(module, c"GetDpiForWindow".as_ptr().cast()) }
    {
        let get_dpi_for_window: unsafe extern "system" fn(HWND) -> u32 =
            unsafe { std::mem::transmute(procedure) };
        let dpi = unsafe { get_dpi_for_window(hwnd) };
        if dpi >= 96 {
            return dpi;
        }
    }
    system_dpi()
}

impl Drop for Fonts {
    fn drop(&mut self) {
        for font in [
            self.body,
            self.body_bold,
            self.platform,
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
    use bridge_local_control::{EndpointSettingsSelection, ObserverProfileMutation};
    use bridge_ui_model::{PermissionDetailView, PermissionView};

    #[test]
    fn pairing_in_progress_has_an_actionable_chinese_message() {
        let message = error_message("bridge_pair_in_progress");
        assert!(message.contains("授权页面"));
        assert!(message.contains("连接账号"));
        assert_ne!(message, error_message("unknown_error"));
    }

    #[test]
    fn pairing_rate_limit_has_an_actionable_chinese_message() {
        let message = error_message("bridge_pair_start_rate_limited");
        assert!(message.contains("过于频繁"));
        assert!(message.contains("请勿反复点击"));
        assert_ne!(message, error_message("unknown_error"));
    }

    #[test]
    fn formats_current_timestamp_in_local_time() {
        assert_ne!(format_local_time(now_utc_msc()), "--:--:--");
    }

    #[test]
    fn window_lifecycle_preserves_dotnet_tray_and_exit_semantics() {
        assert_eq!(initial_window_show_command(false, false), SW_SHOW);
        assert_eq!(initial_window_show_command(true, true), SW_HIDE);
        assert_eq!(initial_window_show_command(true, false), SW_MINIMIZE);
        assert_eq!(close_window_show_command(true), SW_HIDE);
        assert_eq!(close_window_show_command(false), SW_MINIMIZE);
        assert!(is_user_exit_command(CONTROL_EXIT));
        assert!(is_user_exit_command(MENU_EXIT_COMMAND));
        assert!(!is_user_exit_command(CONTROL_LOGOUT));
        assert_eq!(
            user_exit_confirmation_message(),
            format!(
                "确定退出{PRODUCT_NAME}？\n\n退出只会停止数据与指令转发，不会撤单、平仓或关闭 MT。"
            )
        );
    }

    #[test]
    fn taskbar_restart_message_is_registered_for_tray_recovery() {
        assert!(register_taskbar_created_message() >= 0xC000);
    }

    #[test]
    fn dialog_routing_falls_back_to_the_main_window_for_thread_messages() {
        let main_window = 1_usize as HWND;
        assert_eq!(dialog_message_root(main_window, null_mut()), main_window);
    }

    #[test]
    fn only_main_action_buttons_use_the_dotnet_hand_cursor() {
        for control_id in [
            CONTROL_OBSERVER,
            CONTROL_LOGOUT,
            CONTROL_MT4_EXPERT,
            CONTROL_UPDATE,
            CONTROL_PAIR,
            CONTROL_DETECT,
            CONTROL_LOGS,
            CONTROL_SETTINGS,
            CONTROL_EXIT,
        ] {
            assert!(is_main_action_button(control_id));
        }
        assert!(!is_main_action_button(CONTROL_PLATFORM));
        assert!(!is_main_action_button(CONTROL_TERMINAL));
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
        let narrow = account_card_rects(&accounts, rect(0, 0, 516, 500), 96)
            .into_iter()
            .map(rect_coordinates)
            .collect::<Vec<_>>();
        assert_eq!(
            narrow,
            vec![(0, 0, 516, 88), (0, 96, 516, 208), (0, 216, 516, 286)]
        );
        let wide = account_card_rects(&accounts, rect(0, 0, 824, 500), 96)
            .into_iter()
            .map(rect_coordinates)
            .collect::<Vec<_>>();
        assert_eq!(
            wide,
            vec![(0, 0, 408, 88), (416, 0, 824, 112), (0, 120, 408, 190)]
        );
    }

    #[test]
    fn account_scroll_matches_dotnet_gutter_overflow_and_dynamic_clamping() {
        let accounts = vec![account_fixture(true, false, false); 6];
        let narrow = account_scroll_metrics(&accounts, rect(0, 0, 516, 180), 96);
        assert_eq!(rect_coordinates(narrow.content), (0, 0, 495, 180));
        assert_eq!(rect_coordinates(narrow.scrollbar), (499, 0, 516, 180));
        assert_eq!(narrow.content_height, 568);
        assert_eq!(narrow.max_offset, 388);
        assert!(narrow.scrollbar_visible);
        let scrolled = account_card_rects_scrolled(&accounts, narrow, 96, narrow.max_offset)
            .into_iter()
            .map(rect_coordinates)
            .collect::<Vec<_>>();
        assert_eq!(scrolled.first(), Some(&(0, -388, 495, -300)));
        assert_eq!(scrolled.last(), Some(&(0, 92, 495, 180)));

        let wide = account_scroll_metrics(&accounts, rect(0, 0, 900, 500), 96);
        assert_eq!(rect_coordinates(wide.content), (0, 0, 879, 500));
        assert_eq!(wide.content_height, 280);
        assert_eq!(wide.max_offset, 0);
        assert!(!wide.scrollbar_visible);
        assert_eq!(
            account_scroll_target(388, wide.max_offset, 500, 40, SB_PAGEDOWN, 0),
            0
        );
    }

    #[test]
    fn account_scroll_commands_and_dpi_changes_remain_bounded() {
        assert_eq!(account_scroll_target(100, 500, 180, 40, SB_LINEUP, 0), 60);
        assert_eq!(
            account_scroll_target(100, 500, 180, 40, SB_LINEDOWN, 0),
            140
        );
        assert_eq!(account_scroll_target(100, 500, 180, 40, SB_PAGEUP, 0), 0);
        assert_eq!(
            account_scroll_target(100, 500, 180, 40, SB_PAGEDOWN, 0),
            240
        );
        assert_eq!(
            account_scroll_target(100, 500, 180, 40, SB_THUMBTRACK, 377),
            377
        );
        assert_eq!(account_scroll_target(100, 500, 180, 40, SB_TOP, 0), 0);
        assert_eq!(account_scroll_target(100, 500, 180, 40, SB_BOTTOM, 0), 500);
        assert_eq!(rescale_scroll_offset(160, 96, 120), 200);
        assert_eq!(rescale_scroll_offset(200, 120, 96), 160);
    }

    #[test]
    fn account_hit_regions_match_the_drawn_badge_and_buttons() {
        let account = account_fixture(true, false, true);
        let bounds = rect(0, 0, 408, 88);
        assert_eq!(
            rect_coordinates(permission_badge_rect(bounds, 96)),
            (34, 58, 134, 82)
        );
        assert_eq!(
            account_primary_action_rect(&account, bounds, 96).map(rect_coordinates),
            Some((259, 27, 329, 61))
        );
        assert_eq!(
            account_settings_action_rect(&account, bounds, 96).map(rect_coordinates),
            Some((335, 27, 405, 61))
        );
    }

    #[test]
    fn observer_actions_use_stable_native_button_ids_and_primary_roles() {
        let main = account_fixture(true, false, false);
        let pause = account_fixture(true, false, true);
        let mut start = account_fixture(false, false, true);
        start.role = "source-2".to_owned();
        start.primary_action = Some(ObserverAction::Start);
        start.primary_action_text = Some("启动".to_owned());
        let accounts = vec![main, pause, start];
        assert_eq!(
            account_action_bindings(&accounts),
            vec![
                (2_002, 1, ObserverAction::Pause, false),
                (2_003, 1, ObserverAction::Configure, false),
                (2_004, 2, ObserverAction::Start, true),
                (2_005, 2, ObserverAction::Configure, false),
            ]
        );
        let fingerprint = account_action_fingerprint(&accounts);
        let mut busy_accounts = accounts.clone();
        busy_accounts[1].actions_busy = true;
        busy_accounts[1].primary_action_text = Some("处理中…".to_owned());
        assert_eq!(fingerprint, account_action_fingerprint(&busy_accounts));
        busy_accounts[1].primary_action = Some(ObserverAction::Retry);
        assert_ne!(fingerprint, account_action_fingerprint(&busy_accounts));
    }

    #[test]
    fn dotnet_logical_geometry_scales_at_common_windows_dpi_values() {
        assert_eq!(scale(620, 96), 620);
        assert_eq!(scale(700, 96), 700);
        assert_eq!(scale(620, 120), 775);
        assert_eq!(scale(700, 120), 875);
        assert_eq!(scale(620, 144), 930);
        assert_eq!(scale(700, 144), 1_050);

        let accounts = vec![account_fixture(true, false, false)];
        let card = account_card_rects(&accounts, rect(0, 0, 645, 625), 120)[0];
        assert_eq!(rect_coordinates(card), (0, 0, 645, 110));
        assert_eq!(
            rect_coordinates(permission_badge_rect(card, 120)),
            (43, 73, 168, 103)
        );
    }

    #[test]
    fn main_button_palette_matches_the_dotnet_flat_button_contract() {
        assert_eq!(
            button_colors(true, false, false),
            (Rgb(37, 99, 235), Rgb(255, 255, 255))
        );
        assert_eq!(
            button_colors(true, false, true),
            (Rgb(29, 78, 216), Rgb(255, 255, 255))
        );
        assert_eq!(
            button_colors(false, false, false),
            (Rgb(255, 255, 255), Rgb(30, 41, 59))
        );
        assert_eq!(
            button_colors(false, false, true),
            (Rgb(241, 245, 249), Rgb(30, 41, 59))
        );
        assert_eq!(
            button_colors(true, true, false),
            (Rgb(226, 232, 240), Rgb(148, 163, 184))
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
    fn observer_editing_reuses_the_current_binding_terminal_and_long_running_timeout() {
        let state = demo_state(DEFAULT_PROFILE_ID, DemoScenario::AdminMultiAccount);
        let observer = state.observer_profiles.first().expect("observer profile");
        let existing = observer_dialog_existing(observer);
        assert_eq!(existing.observer_profile_id, observer.observer_profile_id);
        assert_eq!(existing.bridge_user_id, observer.bridge_user_id);
        assert_eq!(existing.platform, "mt5");
        assert_eq!(
            existing.terminal_directory,
            observer.terminal_directory.clone().unwrap_or_default()
        );
        assert_eq!(
            local_action_timeout(&LocalControlAction::ObserverUpdate {
                observer: ObserverProfileMutation {
                    observer_profile_id: "source-1".to_owned(),
                    bridge_user_id: 7,
                    platform: "mt5".to_owned(),
                    terminal_directory: r"C:\Broker MT5".to_owned(),
                },
            }),
            Duration::from_secs(30)
        );
        assert_eq!(
            local_action_timeout(&LocalControlAction::SettingsTest {
                settings: EndpointSettingsSelection {
                    follow_official: false,
                    server_url: "http://127.0.0.1:3000/".to_owned(),
                },
            }),
            Duration::from_secs(20)
        );
    }

    #[test]
    fn mt4_repair_and_update_buttons_dispatch_their_local_actions() {
        assert_eq!(
            fixed_button_action(CONTROL_MT4_EXPERT),
            Some(LocalControlAction::InstallMt4Ea)
        );
        assert_eq!(
            fixed_button_action(CONTROL_UPDATE),
            Some(LocalControlAction::UpdateActivate)
        );
        assert_eq!(fixed_button_action(CONTROL_LOGS), None);
    }

    #[test]
    fn tray_menu_matches_dotnet_visibility_and_recovery_rules() {
        let mut state = demo_state(DEFAULT_PROFILE_ID, DemoScenario::AdminMultiAccount);
        let connected = build_tray_menu_view(DEFAULT_PROFILE_ID, &state, true, false, false);
        assert_eq!(
            connected,
            TrayMenuView {
                show_administration: true,
                autostart_checked: true,
                realtime_compatibility_checked: false,
                settings_text: "连接设置",
                show_settings: true,
                show_recovery: false,
                actions_enabled: true,
            }
        );
        state.server_connected = false;
        state.custom_endpoint_active = true;
        let recovering = build_tray_menu_view(DEFAULT_PROFILE_ID, &state, true, true, true);
        assert!(recovering.realtime_compatibility_checked);
        assert_eq!(recovering.settings_text, "切换服务器");
        assert!(recovering.show_recovery);
        assert!(!recovering.actions_enabled);
        let observer = build_tray_menu_view("source-1", &state, true, false, false);
        assert!(!observer.show_administration);
        assert!(!observer.show_settings);
        assert!(!observer.show_recovery);
    }

    #[test]
    fn debug_demo_argument_contract_is_explicit_and_backward_compatible() {
        assert_eq!(
            parse_demo_scenario(["--ui-demo", "ordinary-mt5"]),
            Some(DemoScenario::OrdinaryMt5)
        );
        assert_eq!(
            parse_demo_scenario(["--demo"]),
            Some(DemoScenario::AdminMultiAccount)
        );
        assert_eq!(parse_demo_scenario(["--ui-demo", "unknown"]), None);
        assert_eq!(parse_demo_scenario(["--profile", "default"]), None);
        for scenario in DemoScenario::ALL {
            assert_eq!(DemoScenario::from_slug(scenario.slug()), Some(scenario));
        }
    }

    #[test]
    fn every_debug_demo_scenario_is_a_valid_renderable_snapshot() {
        for scenario in DemoScenario::ALL {
            let state = demo_state(DEFAULT_PROFILE_ID, scenario);
            state
                .validate(DEFAULT_PROFILE_ID)
                .unwrap_or_else(|_| panic!("{}", scenario.slug()));
            let view = build_main_window_view(&state, &BTreeSet::new(), demo_format_local_time)
                .unwrap_or_else(|_| panic!("{}", scenario.slug()));
            assert_eq!(
                view.runtime_summary.contains("13:19:09"),
                state.last_data_sync_utc_msc.is_some(),
                "{}",
                scenario.slug()
            );
        }
    }

    #[test]
    fn startup_state_selects_mt5_before_the_core_snapshot_arrives() {
        let state = initial_state(DEFAULT_PROFILE_ID);
        assert_eq!(state.selected_platform.as_deref(), Some("mt5"));
    }

    #[test]
    fn golden_demo_states_cover_permissions_recovery_pairing_and_updates() {
        let ordinary = demo_state(DEFAULT_PROFILE_ID, DemoScenario::OrdinaryMt5);
        let ordinary_view =
            build_main_window_view(&ordinary, &BTreeSet::new(), demo_format_local_time)
                .expect("ordinary");
        assert_eq!(
            ordinary_view.selected_platform_label.as_deref(),
            Some("MT5")
        );
        assert_eq!(ordinary_view.accounts.len(), 1);
        assert!(!ordinary_view.show_observer_sources);
        assert!(!ordinary_view.show_settings);

        let administrator = demo_state(DEFAULT_PROFILE_ID, DemoScenario::AdminMultiAccount);
        let administrator_view =
            build_main_window_view(&administrator, &BTreeSet::new(), demo_format_local_time)
                .expect("administrator");
        assert_eq!(administrator_view.accounts.len(), 2);
        assert!(administrator_view.show_observer_sources);
        assert!(administrator_view.show_settings);

        let pairing = demo_state(DEFAULT_PROFILE_ID, DemoScenario::PairingRequired);
        let pairing_view =
            build_main_window_view(&pairing, &BTreeSet::new(), demo_format_local_time)
                .expect("pairing");
        assert!(pairing_view.show_pair);
        assert!(!pairing_view.show_logout);

        let offline = demo_state(DEFAULT_PROFILE_ID, DemoScenario::ServerOffline);
        let offline_view =
            build_main_window_view(&offline, &BTreeSet::new(), demo_format_local_time)
                .expect("offline");
        assert_eq!(offline_view.status.title, "部分连接异常");
        assert!(offline_view.show_settings);
        assert!(offline.custom_endpoint_active);

        for scenario in [
            DemoScenario::UpdateDownloading,
            DemoScenario::UpdateReady,
            DemoScenario::UpdateWaiting,
            DemoScenario::UpdateActivating,
            DemoScenario::UpdateFailed,
            DemoScenario::UpdateRolledBack,
            DemoScenario::UpdateHealthy,
        ] {
            let state = demo_state(DEFAULT_PROFILE_ID, scenario);
            let banner = build_main_window_view(&state, &BTreeSet::new(), demo_format_local_time)
                .unwrap_or_else(|_| panic!("{}", scenario.slug()))
                .update_banner
                .unwrap_or_else(|| panic!("{}", scenario.slug()));
            assert_eq!(
                banner.button_enabled,
                matches!(
                    scenario,
                    DemoScenario::UpdateReady | DemoScenario::UpdateRolledBack
                ),
                "{}",
                scenario.slug()
            );
        }
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
            mt4_expert_update: expert_update.then(|| "EA 版本已更新，请重启 MT4".to_owned()),
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
