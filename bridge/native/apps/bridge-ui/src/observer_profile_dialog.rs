use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};

use bridge_foundation::{DEFAULT_PROFILE_ID, validate_profile_id};
use bridge_local_control::{ObserverProfileMutation, UiObserverSource};
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    COLOR_BTNFACE, FW_BOLD, FW_NORMAL, GetSysColorBrush, HFONT, SetBkMode, SetTextColor,
    TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{EM_SETCUEBANNER, EM_SETLIMITTEXT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BN_CLICKED, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CB_ADDSTRING, CB_GETCURSEL,
    CB_SETCURSEL, CBN_SELCHANGE, CBS_DROPDOWNLIST, CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW,
    CreateWindowExW, DefWindowProcW, DestroyWindow, ES_AUTOHSCROLL, ES_READONLY, GWLP_USERDATA,
    GetClientRect, GetMessageW, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, HICON,
    HMENU, IDC_ARROW, IsDialogMessageW, IsWindow, LoadCursorW, MB_ICONWARNING, MB_OK, MINMAXINFO,
    MSG, MessageBoxW, MoveWindow, PostQuitMessage, RegisterClassExW, SW_SHOW, SendMessageW,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowTextW, ShowWindow, TranslateMessage, WM_CLOSE,
    WM_COMMAND, WM_CREATE, WM_CTLCOLORSTATIC, WM_DPICHANGED, WM_GETMINMAXINFO, WM_NCCREATE,
    WM_NCDESTROY, WM_SETFONT, WM_SIZE, WNDCLASSEXW, WS_BORDER, WS_CAPTION, WS_CHILD,
    WS_CLIPCHILDREN, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME,
    WS_VISIBLE,
};

use super::{create_point_font, scale, terminal_directory, wide, window_dpi};

const WINDOW_CLASS: &str = "LiangJianBridgeNativeObserverProfile";
const WINDOW_CLIENT_WIDTH: i32 = 560;
const WINDOW_CLIENT_HEIGHT: i32 = 500;
const WINDOW_MIN_WIDTH: i32 = 540;
const WINDOW_MIN_HEIGHT: i32 = 480;
const CONTROL_PROFILE: i32 = 4300;
const CONTROL_SOURCE: i32 = 4301;
const CONTROL_PLATFORM: i32 = 4302;
const CONTROL_DIRECTORY: i32 = 4303;
const CONTROL_BROWSE: i32 = 4304;
const CONTROL_CONFIRM: i32 = 1;
const CONTROL_CANCEL: i32 = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ExistingObserverProfile {
    pub observer_profile_id: String,
    pub bridge_user_id: Option<i64>,
    pub platform: String,
    pub terminal_directory: String,
}

struct ObserverDialogState {
    dpi: u32,
    result: Arc<Mutex<Option<ObserverProfileMutation>>>,
    sources: Vec<UiObserverSource>,
    existing: Option<ExistingObserverProfile>,
    profile: HWND,
    source: HWND,
    platform: HWND,
    directory: HWND,
    browse: HWND,
    confirm: HWND,
    cancel: HWND,
    labels: Vec<HWND>,
    body_font: HFONT,
    heading_font: HFONT,
    mt5_path: String,
    mt4_path: String,
    icon: HICON,
}

pub(super) unsafe fn show_modal(
    owner: HWND,
    icon: HICON,
    sources: &[UiObserverSource],
    existing: Option<ExistingObserverProfile>,
) -> Result<Option<ObserverProfileMutation>, &'static str> {
    if sources.is_empty() {
        return Err("bridge_observer_sources_empty");
    }
    let instance = unsafe { GetModuleHandleW(null()) };
    register_window_class(instance, icon)?;
    let result = Arc::new(Mutex::new(None));
    let initial_is_mt4 = existing
        .as_ref()
        .is_some_and(|value| value.platform == "mt4");
    let initial_path = existing
        .as_ref()
        .map(|value| value.terminal_directory.clone())
        .unwrap_or_default();
    let dpi = window_dpi(owner);
    let state = Box::new(ObserverDialogState {
        dpi,
        result: Arc::clone(&result),
        sources: sources.to_vec(),
        existing,
        profile: null_mut(),
        source: null_mut(),
        platform: null_mut(),
        directory: null_mut(),
        browse: null_mut(),
        confirm: null_mut(),
        cancel: null_mut(),
        labels: Vec::new(),
        body_font: create_point_font(90, dpi, FW_NORMAL as i32),
        heading_font: create_point_font(100, dpi, FW_BOLD as i32),
        mt5_path: if !initial_is_mt4 {
            initial_path.clone()
        } else {
            String::new()
        },
        mt4_path: if initial_is_mt4 {
            initial_path
        } else {
            String::new()
        },
        icon,
    });
    let editing = state.existing.is_some();
    let state_pointer = Box::into_raw(state);
    let style = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_CLIPCHILDREN;
    let mut outer = RECT {
        left: 0,
        top: 0,
        right: scale(WINDOW_CLIENT_WIDTH, dpi),
        bottom: scale(WINDOW_CLIENT_HEIGHT, dpi),
    };
    unsafe { AdjustWindowRectEx(&mut outer, style, 0, WS_EX_DLGMODALFRAME) };
    let width = outer.right - outer.left;
    let height = outer.bottom - outer.top;
    let (x, y) = centered_position(owner, width, height);
    let class_name = wide(WINDOW_CLASS);
    let title = wide(if editing {
        "设置观摩源"
    } else {
        "新增观摩源"
    });
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_DLGMODALFRAME,
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
        unsafe { drop(Box::from_raw(state_pointer)) };
        return Err("bridge_observer_profile_window_create_failed");
    }
    unsafe {
        EnableWindow(owner, 0);
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
    }
    let mut quit_seen = false;
    let mut message = MSG::default();
    while unsafe { IsWindow(hwnd) } != 0 {
        let status = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
        if status <= 0 {
            quit_seen = status == 0;
            break;
        }
        if unsafe { IsDialogMessageW(hwnd, &message) } == 0 {
            unsafe {
                TranslateMessage(&message);
                windows_sys::Win32::UI::WindowsAndMessaging::DispatchMessageW(&message);
            }
        }
    }
    unsafe {
        EnableWindow(owner, 1);
        SetForegroundWindow(owner);
    }
    if quit_seen {
        unsafe { PostQuitMessage(0) };
    }
    Ok(result.lock().ok().and_then(|value| value.clone()))
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
        hbrBackground: unsafe { GetSysColorBrush(COLOR_BTNFACE) },
        lpszMenuName: null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: icon,
    };
    if unsafe { RegisterClassExW(&class) } != 0
        || unsafe { GetLastError() } == ERROR_CLASS_ALREADY_EXISTS
    {
        Ok(())
    } else {
        Err("bridge_observer_profile_window_class_failed")
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
    let state_pointer =
        unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut ObserverDialogState;
    if state_pointer.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    if message == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
        cleanup_state(unsafe { *Box::from_raw(state_pointer) });
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    let state = unsafe { &mut *state_pointer };
    match message {
        WM_CREATE => {
            unsafe {
                create_controls(hwnd, state);
                layout_controls(hwnd, state);
                apply_platform_copy(state);
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
        WM_COMMAND => {
            let id = (wparam & 0xffff) as i32;
            let notification = ((wparam >> 16) & 0xffff) as u32;
            match (id, notification) {
                (CONTROL_PLATFORM, value) if value == CBN_SELCHANGE => unsafe {
                    apply_platform_copy(state)
                },
                (CONTROL_BROWSE, BN_CLICKED) => unsafe { browse_directory(hwnd, state) },
                (CONTROL_CONFIRM, BN_CLICKED) => unsafe { confirm(hwnd, state) },
                (CONTROL_CANCEL, BN_CLICKED) => unsafe {
                    DestroyWindow(hwnd);
                },
                _ => {}
            }
            0
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            let control = lparam as HWND;
            let is_help = state
                .labels
                .iter()
                .enumerate()
                .any(|(index, label)| matches!(index, 1 | 3 | 6) && *label == control);
            unsafe {
                SetBkMode(hdc, TRANSPARENT as i32);
                SetTextColor(hdc, if is_help { 0x0069_5547 } else { 0 });
            }
            (unsafe { GetSysColorBrush(COLOR_BTNFACE) }) as LRESULT
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut ObserverDialogState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    state.labels = [
        "观摩源名称",
        "例如 source-1。每个观摩源独立保存终端和账号数据。",
        "绑定观摩账户",
        "数据和服务器指令将归属于这个观摩账户。绑定后无需再次登录。",
        "交易平台",
        "MT5 安装目录",
        "选择该观摩源专用的 MT5 安装目录，不能与其它观摩源共用。",
    ]
    .into_iter()
    .enumerate()
    .map(|(index, text)| {
        create_static(
            hwnd,
            instance,
            4400 + index as i32,
            text,
            if matches!(index, 0 | 2 | 4 | 5) {
                state.heading_font
            } else {
                state.body_font
            },
        )
    })
    .collect();
    let edit_class = wide("EDIT");
    state.profile = create_control(
        hwnd,
        instance,
        &edit_class,
        CONTROL_PROFILE,
        "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        0,
    );
    state.directory = create_control(
        hwnd,
        instance,
        &edit_class,
        CONTROL_DIRECTORY,
        "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
        0,
    );
    let combo_class = wide("COMBOBOX");
    state.source = create_control(
        hwnd,
        instance,
        &combo_class,
        CONTROL_SOURCE,
        "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST as u32,
        WS_EX_CLIENTEDGE,
    );
    state.platform = create_control(
        hwnd,
        instance,
        &combo_class,
        CONTROL_PLATFORM,
        "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST as u32,
        WS_EX_CLIENTEDGE,
    );
    state.browse = create_button(
        hwnd,
        instance,
        CONTROL_BROWSE,
        "浏览…",
        BS_PUSHBUTTON as u32,
    );
    state.confirm = create_button(
        hwnd,
        instance,
        CONTROL_CONFIRM,
        if state.existing.is_some() {
            "保存并连接"
        } else {
            "创建并连接"
        },
        BS_DEFPUSHBUTTON as u32,
    );
    state.cancel = create_button(hwnd, instance, CONTROL_CANCEL, "取消", BS_PUSHBUTTON as u32);
    for control in [
        state.profile,
        state.source,
        state.platform,
        state.directory,
        state.browse,
        state.confirm,
        state.cancel,
    ] {
        unsafe { SendMessageW(control, WM_SETFONT, state.body_font as usize, 1) };
    }
    unsafe { SendMessageW(state.profile, EM_SETLIMITTEXT, 40, 0) };
    set_cue_banner(state.profile, "source-1");
    for source in &state.sources {
        add_combo_item(
            state.source,
            &format!("{}  ·  {}", source.display_name, source.account_summary),
        );
    }
    add_combo_item(state.platform, "MT5");
    add_combo_item(state.platform, "MT4");
    let source_index = state
        .existing
        .as_ref()
        .and_then(|existing| existing.bridge_user_id)
        .and_then(|id| {
            state
                .sources
                .iter()
                .position(|source| source.bridge_user_id == id)
        })
        .or((state.sources.len() == 1).then_some(0))
        .map_or(-1, |value| value as i32);
    let platform_index = i32::from(
        state
            .existing
            .as_ref()
            .is_some_and(|value| value.platform == "mt4"),
    );
    unsafe {
        SendMessageW(state.source, CB_SETCURSEL, source_index as usize, 0);
        SendMessageW(state.platform, CB_SETCURSEL, platform_index as usize, 0);
    }
    if let Some(existing) = &state.existing {
        set_window_text(state.profile, &existing.observer_profile_id);
        let style = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(
                state.profile,
                windows_sys::Win32::UI::WindowsAndMessaging::GWL_STYLE,
            )
        } as u32;
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                state.profile,
                windows_sys::Win32::UI::WindowsAndMessaging::GWL_STYLE,
                (style | ES_READONLY as u32) as isize,
            );
        }
    }
}

fn create_static(owner: HWND, instance: HINSTANCE, id: i32, text: &str, font: HFONT) -> HWND {
    let class = wide("STATIC");
    let copy = wide(text);
    let control = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            copy.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            0,
            0,
            100,
            24,
            owner,
            id as HMENU,
            instance,
            null(),
        )
    };
    unsafe { SendMessageW(control, WM_SETFONT, font as usize, 1) };
    control
}

fn create_control(
    owner: HWND,
    instance: HINSTANCE,
    class: &[u16],
    id: i32,
    text: &str,
    style: u32,
    extended_style: u32,
) -> HWND {
    let copy = wide(text);
    unsafe {
        CreateWindowExW(
            extended_style,
            class.as_ptr(),
            copy.as_ptr(),
            style,
            0,
            0,
            100,
            28,
            owner,
            id as HMENU,
            instance,
            null(),
        )
    }
}

fn create_button(owner: HWND, instance: HINSTANCE, id: i32, text: &str, button_style: u32) -> HWND {
    let class = wide("BUTTON");
    create_control(
        owner,
        instance,
        &class,
        id,
        text,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | button_style,
        0,
    )
}

unsafe fn layout_controls(hwnd: HWND, state: &ObserverDialogState) {
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    let s = |value| scale(value, state.dpi);
    let content_width = (width - s(40)).max(s(300));
    let positions = [
        (s(20), s(18), content_width, s(24)),
        (s(20), s(42), content_width, s(24)),
        (s(20), s(112), content_width, s(24)),
        (s(20), s(136), content_width, s(24)),
        (s(20), s(206), content_width, s(24)),
        (s(20), s(270), content_width, s(24)),
        (s(20), s(294), content_width, s(40)),
    ];
    for (control, (x, y, control_width, control_height)) in state.labels.iter().zip(positions) {
        unsafe { MoveWindow(*control, x, y, control_width, control_height, 1) };
    }
    unsafe {
        MoveWindow(state.profile, s(20), s(72), content_width, s(28), 1);
        MoveWindow(state.source, s(20), s(164), content_width, s(220), 1);
        MoveWindow(state.platform, s(20), s(232), content_width, s(140), 1);
        MoveWindow(
            state.directory,
            s(20),
            s(340),
            content_width - s(88),
            s(28),
            1,
        );
        MoveWindow(state.browse, width - s(100), s(340), s(80), s(28), 1);
        MoveWindow(
            state.confirm,
            width - s(132),
            height - s(52),
            s(112),
            s(32),
            1,
        );
        MoveWindow(
            state.cancel,
            width - s(236),
            height - s(52),
            s(96),
            s(32),
            1,
        );
    }
}

unsafe fn apply_dpi(state: &mut ObserverDialogState, dpi: u32) {
    let body = create_point_font(90, dpi, FW_NORMAL as i32);
    let heading = create_point_font(100, dpi, FW_BOLD as i32);
    for (index, label) in state.labels.iter().enumerate() {
        let font = if matches!(index, 0 | 2 | 4 | 5) {
            heading
        } else {
            body
        };
        unsafe { SendMessageW(*label, WM_SETFONT, font as usize, 1) };
    }
    for control in [
        state.profile,
        state.source,
        state.platform,
        state.directory,
        state.browse,
        state.confirm,
        state.cancel,
    ] {
        unsafe { SendMessageW(control, WM_SETFONT, body as usize, 1) };
    }
    let previous = [state.body_font, state.heading_font];
    state.dpi = dpi;
    state.body_font = body;
    state.heading_font = heading;
    for font in previous {
        if !font.is_null() {
            unsafe { windows_sys::Win32::Graphics::Gdi::DeleteObject(font as _) };
        }
    }
}

unsafe fn apply_platform_copy(state: &ObserverDialogState) {
    let mt4 = selected_platform(state) == "mt4";
    set_window_text(
        state.labels[5],
        if mt4 {
            "MT4 目录"
        } else {
            "MT5 安装目录"
        },
    );
    set_window_text(
        state.labels[6],
        if mt4 {
            "选择该观摩源专用的 MT4 安装目录或数据目录。保存后会自动安装 EA。"
        } else {
            "选择该观摩源专用的 MT5 安装目录，不能与其它观摩源共用。"
        },
    );
    set_cue_banner(
        state.directory,
        if mt4 {
            r"例如 C:\Program Files\Broker MT4"
        } else {
            r"例如 C:\Program Files\Broker MT5"
        },
    );
    set_window_text(
        state.directory,
        if mt4 {
            &state.mt4_path
        } else {
            &state.mt5_path
        },
    );
}

unsafe fn browse_directory(hwnd: HWND, state: &mut ObserverDialogState) {
    let platform = selected_platform(state);
    let current = window_text(state.directory);
    let suggestions = discover_suggested_directories(platform);
    match unsafe {
        terminal_directory::show_modal(
            hwnd,
            state.icon,
            platform,
            (!current.trim().is_empty()).then_some(current.as_str()),
            &suggestions,
        )
    } {
        Ok(Some(path)) => set_window_text(state.directory, &path.display().to_string()),
        Ok(None) => {}
        Err(code) => show_validation_error(hwnd, "目录选择器暂时无法打开，请重试。", code),
    }
}

unsafe fn confirm(hwnd: HWND, state: &ObserverDialogState) {
    match validate_selection(state) {
        Ok(mutation) => {
            if let Ok(mut result) = state.result.lock() {
                *result = Some(mutation);
            }
            unsafe { DestroyWindow(hwnd) };
        }
        Err((message, title)) => show_validation_error(hwnd, message, title),
    }
}

fn validate_selection(
    state: &ObserverDialogState,
) -> Result<ObserverProfileMutation, (&'static str, &'static str)> {
    let profile = window_text(state.profile);
    let validated = validate_profile_id(Some(profile.trim())).map_err(|_| {
        (
            "请输入 1-40 位英文字母、数字、横线或下划线。",
            "观摩源名称无效",
        )
    })?;
    if validated == DEFAULT_PROFILE_ID {
        return Err((
            "请输入 1-40 位英文字母、数字、横线或下划线。",
            "观摩源名称无效",
        ));
    }
    let source_index = combo_selection(state.source)
        .ok_or(("请选择该本地档案对应的观摩账户。", "需要绑定观摩账户"))?;
    let source = state
        .sources
        .get(source_index)
        .ok_or(("请选择该本地档案对应的观摩账户。", "需要绑定观摩账户"))?;
    let platform = selected_platform(state);
    let selected_directory = window_text(state.directory);
    let terminal_directory = if platform == "mt4" {
        resolve_mt4_directory(&selected_directory).ok_or((
            "未找到对应的 MT4。请先启动一次 MT4，再选择它的安装目录或数据目录。",
            "MT4 目录无效",
        ))?
    } else {
        resolve_mt5_directory(&selected_directory)
            .and_then(|executable| executable.parent().map(Path::to_path_buf))
            .ok_or((
                "所选目录中没有 terminal64.exe 或 terminal.exe，请重新选择 MT5 安装目录。",
                "MT5 目录无效",
            ))?
    };
    Ok(ObserverProfileMutation {
        observer_profile_id: validated,
        bridge_user_id: source.bridge_user_id,
        platform: platform.to_owned(),
        terminal_directory: terminal_directory.display().to_string(),
    })
}

fn selected_platform(state: &ObserverDialogState) -> &'static str {
    if combo_selection(state.platform) == Some(1) {
        "mt4"
    } else {
        "mt5"
    }
}

fn combo_selection(combo: HWND) -> Option<usize> {
    let selected = unsafe { SendMessageW(combo, CB_GETCURSEL, 0, 0) } as i32;
    (selected >= 0).then_some(selected as usize)
}

fn add_combo_item(combo: HWND, value: &str) {
    let copy = wide(value);
    unsafe { SendMessageW(combo, CB_ADDSTRING, 0, copy.as_ptr() as isize) };
}

fn set_cue_banner(edit: HWND, value: &str) {
    let copy = wide(value);
    unsafe { SendMessageW(edit, EM_SETCUEBANNER, 0, copy.as_ptr() as isize) };
}

fn set_window_text(window: HWND, value: &str) {
    let copy = wide(value);
    unsafe { SetWindowTextW(window, copy.as_ptr()) };
}

fn window_text(window: HWND) -> String {
    let length = unsafe { GetWindowTextLengthW(window) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer = vec![0_u16; length as usize + 1];
    let copied = unsafe {
        GetWindowTextW(
            window,
            buffer.as_mut_ptr(),
            i32::try_from(buffer.len()).unwrap_or(i32::MAX),
        )
    };
    String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
}

fn discover_suggested_directories(platform: &str) -> Vec<PathBuf> {
    if platform == "mt4" {
        let mut paths = discover_mt4_installations()
            .into_iter()
            .flat_map(|installation| [installation.data_path, installation.installation_path])
            .collect::<Vec<_>>();
        sort_and_deduplicate(&mut paths);
        paths
    } else {
        discover_mt5_common_directories()
    }
}

#[derive(Clone)]
struct Mt4Installation {
    data_path: PathBuf,
    installation_path: PathBuf,
}

fn discover_mt4_installations() -> Vec<Mt4Installation> {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let terminal_root = PathBuf::from(app_data).join("MetaQuotes").join("Terminal");
    let Ok(entries) = std::fs::read_dir(terminal_root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let data_path = entry.path();
            if !data_path.join("MQL4").is_dir() {
                return None;
            }
            let origin = read_terminal_origin(&data_path.join("origin.txt"))?;
            let installation_path = if origin.is_file() {
                origin.parent()?.to_path_buf()
            } else {
                origin
            };
            contains_terminal_executable(&installation_path).then_some(Mt4Installation {
                data_path,
                installation_path,
            })
        })
        .collect()
}

fn discover_mt5_common_directories() -> Vec<PathBuf> {
    let mt4_installation_paths = discover_mt4_installations()
        .into_iter()
        .map(|installation| installation.installation_path)
        .collect::<Vec<_>>();
    let mut candidates = discover_mt5_terminal_data_directories();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = std::env::var_os(variable) else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        candidates.extend(
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| resolve_mt5_directory(&path.display().to_string()).is_some())
                .filter(|path| {
                    !mt4_installation_paths
                        .iter()
                        .any(|mt4_path| paths_equal(path, mt4_path))
                }),
        );
    }
    sort_and_deduplicate(&mut candidates);
    candidates
}

fn discover_mt5_terminal_data_directories() -> Vec<PathBuf> {
    let Some(app_data) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let terminal_root = PathBuf::from(app_data).join("MetaQuotes").join("Terminal");
    let Ok(entries) = std::fs::read_dir(terminal_root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let data_path = entry.path();
            if !data_path.join("MQL5").is_dir() {
                return None;
            }
            let origin = read_terminal_origin(&data_path.join("origin.txt"))?;
            resolve_mt5_directory(&origin.display().to_string())
                .and_then(|executable| executable.parent().map(user_facing_path))
        })
        .collect()
}

fn read_terminal_origin(path: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(path).ok()?;
    let text = decode_terminal_origin(&bytes)?;
    let value = text.trim().trim_matches('\0').trim();
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn decode_terminal_origin(bytes: &[u8]) -> Option<String> {
    if let Some(content) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let words = content
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).ok();
    }
    if let Some(content) = bytes.strip_prefix(&[0xfe, 0xff]) {
        let words = content
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).ok();
    }
    std::str::from_utf8(bytes)
        .ok()
        .map(|value| value.trim_start_matches('\u{feff}').to_owned())
}

fn resolve_mt4_directory(value: &str) -> Option<PathBuf> {
    let selected = canonical_directory(value)?;
    if selected.join("MQL4").is_dir() {
        return Some(selected);
    }
    discover_mt4_installations()
        .into_iter()
        .find(|installation| {
            paths_equal(&installation.data_path, &selected)
                || paths_equal(&installation.installation_path, &selected)
        })
        .map(|installation| installation.data_path)
}

fn resolve_mt5_directory(value: &str) -> Option<PathBuf> {
    let selected = PathBuf::from(value.trim());
    if selected.is_file()
        && selected
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(is_terminal_executable)
    {
        return Some(user_facing_path(&selected));
    }
    let directory = canonical_directory(value)?;
    ["terminal64.exe", "terminal.exe"]
        .into_iter()
        .map(|name| directory.join(name))
        .find(|path| path.is_file())
        .map(|path| user_facing_path(&path))
}

fn canonical_directory(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value.trim());
    path.is_dir().then(|| user_facing_path(&path))
}

fn user_facing_path(path: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy();
    if let Some(value) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{value}"));
    }
    text.strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or(resolved)
}

fn contains_terminal_executable(path: &Path) -> bool {
    path.join("terminal.exe").is_file() || path.join("terminal64.exe").is_file()
}

fn is_terminal_executable(value: &str) -> bool {
    value.eq_ignore_ascii_case("terminal.exe") || value.eq_ignore_ascii_case("terminal64.exe")
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

fn sort_and_deduplicate(paths: &mut Vec<PathBuf>) {
    paths.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    paths.dedup_by(|left, right| paths_equal(left, right));
}

fn show_validation_error(owner: HWND, message: &str, title: &str) {
    let message = wide(message);
    let title = wide(title);
    unsafe {
        MessageBoxW(
            owner,
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONWARNING,
        );
    }
}

fn centered_position(owner: HWND, width: i32, height: i32) -> (i32, i32) {
    let mut bounds = RECT::default();
    if owner.is_null()
        || unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(owner, &mut bounds) }
            == 0
    {
        return (100, 100);
    }
    (
        bounds.left + ((bounds.right - bounds.left - width) / 2).max(0),
        bounds.top + ((bounds.bottom - bounds.top - height) / 2).max(0),
    )
}

fn cleanup_state(state: ObserverDialogState) {
    for font in [state.body_font, state.heading_font] {
        if !font.is_null() {
            unsafe {
                windows_sys::Win32::Graphics::Gdi::DeleteObject(font as _);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observer_dialog_geometry_tracks_dotnet_dpi_scaling() {
        assert_eq!(scale(WINDOW_CLIENT_WIDTH, 120), 700);
        assert_eq!(scale(WINDOW_CLIENT_HEIGHT, 144), 750);
        assert_eq!(scale(WINDOW_MIN_WIDTH, 120), 675);
        assert_eq!(scale(WINDOW_MIN_HEIGHT, 144), 720);
    }

    #[test]
    fn terminal_executable_names_match_the_dotnet_dialog() {
        assert!(is_terminal_executable("terminal64.exe"));
        assert!(is_terminal_executable("TERMINAL.EXE"));
        assert!(!is_terminal_executable("metaeditor64.exe"));
    }

    #[test]
    fn terminal_origin_supports_the_utf16_encoding_used_by_metaquotes() {
        let mut bytes = vec![0xff, 0xfe];
        for word in r"C:\Program Files\Broker MT4".encode_utf16() {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        assert_eq!(
            decode_terminal_origin(&bytes).as_deref(),
            Some(r"C:\Program Files\Broker MT4")
        );
    }

    #[test]
    fn path_comparison_is_case_insensitive_and_ignores_the_trailing_separator() {
        assert!(paths_equal(
            Path::new(r"C:\Broker\MT4"),
            Path::new(r"c:\broker\mt4\")
        ));
    }
}
