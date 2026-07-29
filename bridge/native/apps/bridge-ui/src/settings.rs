use bridge_foundation::default_root_data_directory;
use bridge_local_control::{
    EndpointSettingsSelection, LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction,
    LocalControlPipeClient, LocalControlRequest, LocalControlResult,
};
use bridge_transport::{
    ENDPOINT_SETTINGS_FILE_NAME, PACKAGED_SERVER_ENDPOINTS_FILE_NAME, ServerEndpoints,
    load_packaged_server_endpoints, resolve_server_endpoints,
};
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    CreateSolidBrush, DT_LEFT, DT_SINGLELINE, DT_VCENTER, DeleteObject, FW_BOLD, FW_NORMAL, HBRUSH,
    HGDIOBJ, InvalidateRect, SetBkColor, SetTextColor,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{BST_CHECKED, BST_UNCHECKED, EM_SETLIMITTEXT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BM_GETCHECK, BM_SETCHECK, BN_CLICKED, BS_AUTORADIOBUTTON, BS_OWNERDRAW,
    CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow,
    ES_AUTOHSCROLL, GWLP_USERDATA, GetClientRect, GetWindowLongPtrW, GetWindowTextLengthW,
    GetWindowTextW, HICON, HMENU, IDC_ARROW, IsWindow, LoadCursorW, MINMAXINFO, MoveWindow,
    PostMessageW, RegisterClassExW, SW_SHOW, SW_SHOWNORMAL, SendMessageW, SetForegroundWindow,
    SetWindowLongPtrW, SetWindowTextW, ShowWindow, WM_APP, WM_CLOSE, WM_COMMAND, WM_CTLCOLOREDIT,
    WM_CTLCOLORSTATIC, WM_DRAWITEM, WM_GETMINMAXINFO, WM_NCCREATE, WM_NCDESTROY, WM_PAINT,
    WM_SETFONT, WM_SIZE, WNDCLASSEXW, WS_BORDER, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_GROUP,
    WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME, WS_VISIBLE,
};

use super::{PRODUCT_NAME, Rgb, color_ref, create_font, draw_border, draw_text, fill, rect, wide};

const WINDOW_CLASS: &str = "LiangJianBridgeNativeSettings";
const WINDOW_CLIENT_WIDTH: i32 = 620;
const WINDOW_CLIENT_HEIGHT: i32 = 490;
const WINDOW_MIN_WIDTH: i32 = 580;
const WINDOW_MIN_HEIGHT: i32 = 470;
const CONTROL_OFFICIAL: i32 = 3000;
const CONTROL_CUSTOM: i32 = 3001;
const CONTROL_SERVER_URL: i32 = 3002;
const CONTROL_TEST: i32 = 3003;
const CONTROL_RESTORE: i32 = 3004;
const CONTROL_CANCEL: i32 = 3005;
const CONTROL_SAVE: i32 = 3006;
const WM_SETTINGS_RESULT: u32 = WM_APP + 30;
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(8);
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestKind {
    Test,
    Save,
}

struct RequestResult {
    kind: RequestKind,
    result: Result<LocalControlResult, String>,
}

struct SettingsState {
    owner: HWND,
    profile_id: String,
    official_url: String,
    custom_url: String,
    last_mode_custom: bool,
    last_successful_test: Option<String>,
    pending_save: bool,
    request_running: Arc<AtomicBool>,
    inbox: Arc<Mutex<Option<RequestResult>>>,
    official: HWND,
    custom: HWND,
    server_url: HWND,
    test: HWND,
    restore: HWND,
    cancel: HWND,
    save: HWND,
    body_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    body_bold_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    heading_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    background_brush: HBRUSH,
    white_brush: HBRUSH,
    disabled_brush: HBRUSH,
    test_status: String,
    test_status_color: Rgb,
}

pub(super) unsafe fn show_or_focus(
    existing: HWND,
    owner: HWND,
    profile_id: &str,
    icon: HICON,
) -> Result<HWND, &'static str> {
    if !existing.is_null() && unsafe { IsWindow(existing) } != 0 {
        unsafe {
            ShowWindow(existing, SW_SHOWNORMAL);
            SetForegroundWindow(existing);
        }
        return Ok(existing);
    }
    let application_directory = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .ok_or("bridge_application_directory_invalid")?;
    let root_data_directory = default_root_data_directory()?;
    let official = load_packaged_server_endpoints(
        application_directory.join(PACKAGED_SERVER_ENDPOINTS_FILE_NAME),
    )
    .map_err(|_| "bridge_server_endpoints_missing")?;
    let effective = resolve_server_endpoints(&application_directory, &root_data_directory)
        .map_err(|_| "bridge_server_endpoints_missing")?;
    let custom_active = root_data_directory
        .join(ENDPOINT_SETTINGS_FILE_NAME)
        .is_file();
    let official_url = normalized_url(&official);
    let effective_url = normalized_url(&effective);
    let instance = unsafe { GetModuleHandleW(null()) };
    register_window_class(instance, icon)?;
    let state = Box::new(SettingsState {
        owner,
        profile_id: profile_id.to_owned(),
        official_url,
        custom_url: effective_url,
        last_mode_custom: custom_active,
        last_successful_test: None,
        pending_save: false,
        request_running: Arc::new(AtomicBool::new(false)),
        inbox: Arc::new(Mutex::new(None)),
        official: null_mut(),
        custom: null_mut(),
        server_url: null_mut(),
        test: null_mut(),
        restore: null_mut(),
        cancel: null_mut(),
        save: null_mut(),
        body_font: create_font(14, FW_NORMAL as i32),
        body_bold_font: create_font(14, FW_BOLD as i32),
        heading_font: create_font(22, FW_BOLD as i32),
        background_brush: unsafe { CreateSolidBrush(color_ref(Rgb(248, 250, 252))) },
        white_brush: unsafe { CreateSolidBrush(color_ref(Rgb(255, 255, 255))) },
        disabled_brush: unsafe { CreateSolidBrush(color_ref(Rgb(245, 247, 250))) },
        test_status: "保存前需要完成一次连接测试。".to_owned(),
        test_status_color: Rgb(71, 85, 105),
    });
    let state_pointer = Box::into_raw(state);
    let style = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_CLIPCHILDREN;
    let mut outer = RECT {
        left: 0,
        top: 0,
        right: WINDOW_CLIENT_WIDTH,
        bottom: WINDOW_CLIENT_HEIGHT,
    };
    unsafe { AdjustWindowRectEx(&mut outer, style, 0, 0) };
    let width = outer.right - outer.left;
    let height = outer.bottom - outer.top;
    let (x, y) = centered_position(owner, width, height);
    let class_name = wide(WINDOW_CLASS);
    let title = wide(&format!("{PRODUCT_NAME} · 连接设置"));
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
        unsafe { drop(Box::from_raw(state_pointer)) };
        return Err("bridge_settings_window_create_failed");
    }
    unsafe {
        EnableWindow(owner, 0);
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
        hbrBackground: null_mut(),
        lpszMenuName: null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: icon,
    };
    if unsafe { RegisterClassExW(&class) } != 0
        || unsafe { GetLastError() } == ERROR_CLASS_ALREADY_EXISTS
    {
        Ok(())
    } else {
        Err("bridge_settings_window_class_failed")
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
    let state_pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut SettingsState;
    if state_pointer.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    if message == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
        let state = unsafe { Box::from_raw(state_pointer) };
        unsafe {
            EnableWindow(state.owner, 1);
            SetForegroundWindow(state.owner);
        }
        cleanup_state(*state);
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    let state = unsafe { &mut *state_pointer };
    match message {
        windows_sys::Win32::UI::WindowsAndMessaging::WM_CREATE => {
            unsafe {
                create_controls(hwnd, state);
                layout_controls(hwnd, state);
                apply_mode(hwnd, state, false);
            }
            0
        }
        WM_SIZE => {
            unsafe { layout_controls(hwnd, state) };
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
        WM_COMMAND => {
            let id = (wparam & 0xffff) as i32;
            let notification = ((wparam >> 16) & 0xffff) as u32;
            if notification == BN_CLICKED {
                unsafe { handle_command(hwnd, state, id) };
            }
            0
        }
        WM_SETTINGS_RESULT => {
            unsafe { receive_request(hwnd, state) };
            0
        }
        WM_CTLCOLOREDIT => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            let enabled = unsafe { IsWindowEnabled(state.server_url) } != 0;
            let color = if enabled {
                Rgb(255, 255, 255)
            } else {
                Rgb(245, 247, 250)
            };
            unsafe {
                SetBkColor(hdc, color_ref(color));
                SetTextColor(hdc, color_ref(Rgb(15, 23, 42)));
            }
            (if enabled {
                state.white_brush
            } else {
                state.disabled_brush
            }) as LRESULT
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            unsafe {
                SetBkColor(hdc, color_ref(Rgb(248, 250, 252)));
                SetTextColor(hdc, color_ref(Rgb(30, 41, 59)));
            }
            state.background_brush as LRESULT
        }
        WM_DRAWITEM => unsafe { draw_settings_button(lparam) },
        WM_PAINT => {
            unsafe { paint_window(hwnd, state) };
            0
        }
        WM_CLOSE => {
            if !state.request_running.load(Ordering::Acquire) {
                unsafe { DestroyWindow(hwnd) };
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut SettingsState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    let button_class = wide("BUTTON");
    state.official = create_control(
        hwnd,
        instance,
        &button_class,
        CONTROL_OFFICIAL,
        "跟随官方配置",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_GROUP | BS_AUTORADIOBUTTON as u32,
    );
    state.custom = create_control(
        hwnd,
        instance,
        &button_class,
        CONTROL_CUSTOM,
        "使用管理员自定义地址",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTORADIOBUTTON as u32,
    );
    let edit_class = wide("EDIT");
    state.server_url = create_control(
        hwnd,
        instance,
        &edit_class,
        CONTROL_SERVER_URL,
        "",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
    );
    state.test = create_owner_button(hwnd, instance, CONTROL_TEST, "测试连接");
    state.restore = create_owner_button(hwnd, instance, CONTROL_RESTORE, "恢复官方配置");
    state.cancel = create_owner_button(hwnd, instance, CONTROL_CANCEL, "取消");
    state.save = create_owner_button(hwnd, instance, CONTROL_SAVE, "保存并重启");
    for control in [
        state.official,
        state.custom,
        state.server_url,
        state.test,
        state.restore,
        state.cancel,
        state.save,
    ] {
        unsafe { SendMessageW(control, WM_SETFONT, state.body_font as usize, 1) };
    }
    unsafe { SendMessageW(state.server_url, EM_SETLIMITTEXT, 2_048, 0) };
    let custom_active = state.last_mode_custom;
    unsafe {
        SendMessageW(
            state.official,
            BM_SETCHECK,
            if custom_active {
                BST_UNCHECKED
            } else {
                BST_CHECKED
            } as usize,
            0,
        );
        SendMessageW(
            state.custom,
            BM_SETCHECK,
            if custom_active {
                BST_CHECKED
            } else {
                BST_UNCHECKED
            } as usize,
            0,
        );
    }
    let initial_url = if custom_active {
        state.custom_url.as_str()
    } else {
        state.official_url.as_str()
    };
    set_text(state.server_url, initial_url);
}

fn create_control(
    hwnd: HWND,
    instance: HINSTANCE,
    class: &[u16],
    id: i32,
    text: &str,
    style: u32,
) -> HWND {
    let value = wide(text);
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            value.as_ptr(),
            style,
            0,
            0,
            100,
            36,
            hwnd,
            id as HMENU,
            instance,
            null(),
        )
    }
}

fn create_owner_button(hwnd: HWND, instance: HINSTANCE, id: i32, text: &str) -> HWND {
    let class = wide("BUTTON");
    create_control(
        hwnd,
        instance,
        &class,
        id,
        text,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW as u32,
    )
}

unsafe fn layout_controls(hwnd: HWND, state: &SettingsState) {
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    unsafe {
        MoveWindow(state.official, 28, 96, 120, 28, 1);
        MoveWindow(state.custom, 150, 96, 190, 28, 1);
        MoveWindow(state.server_url, 46, 180, (width - 92).max(100), 36, 1);
        MoveWindow(state.test, width - 124, 270, 96, 36, 1);
        MoveWindow(state.save, width - 140, height - 58, 112, 36, 1);
        MoveWindow(state.cancel, width - 244, height - 58, 96, 36, 1);
        MoveWindow(state.restore, width - 380, height - 58, 128, 36, 1);
    }
    unsafe { InvalidateRect(hwnd, null(), 1) };
}

unsafe fn handle_command(hwnd: HWND, state: &mut SettingsState, id: i32) {
    match id {
        CONTROL_OFFICIAL | CONTROL_CUSTOM => unsafe { apply_mode(hwnd, state, true) },
        CONTROL_TEST => unsafe { begin_test(hwnd, state, false) },
        CONTROL_RESTORE => unsafe {
            SendMessageW(state.official, BM_SETCHECK, BST_CHECKED as usize, 0);
            SendMessageW(state.custom, BM_SETCHECK, BST_UNCHECKED as usize, 0);
            apply_mode(hwnd, state, true);
        },
        CONTROL_CANCEL => unsafe {
            DestroyWindow(hwnd);
        },
        CONTROL_SAVE => unsafe { begin_save(hwnd, state) },
        _ => {}
    }
}

unsafe fn apply_mode(hwnd: HWND, state: &mut SettingsState, preserve_custom: bool) {
    let custom = is_checked(state.custom);
    if preserve_custom && state.last_mode_custom && !custom {
        state.custom_url = get_text(state.server_url);
        set_text(state.server_url, &state.official_url);
    } else if preserve_custom && !state.last_mode_custom && custom {
        set_text(state.server_url, &state.custom_url);
    }
    state.last_mode_custom = custom;
    state.last_successful_test = None;
    state.pending_save = false;
    state.test_status = "保存前需要完成一次连接测试。".to_owned();
    state.test_status_color = Rgb(71, 85, 105);
    unsafe {
        EnableWindow(state.server_url, i32::from(custom));
        EnableWindow(state.restore, i32::from(custom));
        InvalidateRect(hwnd, null(), 1);
    }
}

unsafe fn begin_save(hwnd: HWND, state: &mut SettingsState) {
    let Some(selection) = read_selection(state) else {
        show_invalid_address(hwnd, state);
        return;
    };
    let fingerprint = fingerprint(&selection);
    if state.last_successful_test.as_deref() != Some(fingerprint.as_str()) {
        state.pending_save = true;
        unsafe { begin_request(hwnd, state, RequestKind::Test, selection) };
        return;
    }
    unsafe { begin_request(hwnd, state, RequestKind::Save, selection) };
}

unsafe fn begin_test(hwnd: HWND, state: &mut SettingsState, pending_save: bool) {
    let Some(selection) = read_selection(state) else {
        show_invalid_address(hwnd, state);
        return;
    };
    state.pending_save = pending_save;
    unsafe { begin_request(hwnd, state, RequestKind::Test, selection) };
}

unsafe fn begin_request(
    hwnd: HWND,
    state: &mut SettingsState,
    kind: RequestKind,
    selection: EndpointSettingsSelection,
) {
    if state.request_running.swap(true, Ordering::AcqRel) {
        return;
    }
    set_busy(state, true, kind);
    let profile_id = state.profile_id.clone();
    let running = Arc::clone(&state.request_running);
    let inbox = Arc::clone(&state.inbox);
    let hwnd_value = hwnd as usize;
    std::thread::spawn(move || {
        let action = match kind {
            RequestKind::Test => LocalControlAction::SettingsTest {
                settings: selection,
            },
            RequestKind::Save => LocalControlAction::SettingsSave {
                settings: selection,
            },
        };
        let result = run_local_request(&profile_id, action);
        if let Ok(mut slot) = inbox.lock() {
            *slot = Some(RequestResult { kind, result });
        }
        running.store(false, Ordering::Release);
        unsafe { PostMessageW(hwnd_value as HWND, WM_SETTINGS_RESULT, 0, 0) };
    });
}

unsafe fn receive_request(hwnd: HWND, state: &mut SettingsState) {
    let result = state.inbox.lock().ok().and_then(|mut slot| slot.take());
    let Some(result) = result else {
        return;
    };
    set_busy(state, false, result.kind);
    match (result.kind, result.result) {
        (
            RequestKind::Test,
            Ok(LocalControlResult::ConnectivityTest {
                success,
                description,
            }),
        ) => {
            state.test_status = if success {
                format!("✓ {description}")
            } else {
                format!("! {description}")
            };
            state.test_status_color = if success {
                Rgb(4, 120, 87)
            } else {
                Rgb(185, 28, 28)
            };
            if success {
                if let Some(selection) = read_selection(state) {
                    state.last_successful_test = Some(fingerprint(&selection));
                    if state.pending_save {
                        state.pending_save = false;
                        unsafe { begin_request(hwnd, state, RequestKind::Save, selection) };
                    }
                }
            } else {
                state.pending_save = false;
                state.last_successful_test = None;
            }
            unsafe { InvalidateRect(hwnd, null(), 1) };
        }
        (RequestKind::Save, Ok(LocalControlResult::Accepted)) => unsafe {
            DestroyWindow(hwnd);
        },
        (_, Ok(LocalControlResult::Rejected { .. }) | Err(_)) | (_, Ok(_)) => {
            state.pending_save = false;
            state.last_successful_test = None;
            state.test_status = "! 连接设置未保存，请检查地址和网络后重试。".to_owned();
            state.test_status_color = Rgb(185, 28, 28);
            unsafe { InvalidateRect(hwnd, null(), 1) };
        }
    }
}

fn run_local_request(
    profile_id: &str,
    action: LocalControlAction,
) -> Result<LocalControlResult, String> {
    let request_id = format!(
        "settings-{}-{}",
        now_utc_msc(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "bridge_local_control_runtime_failed".to_owned())?;
    runtime.block_on(async {
        let mut client = LocalControlPipeClient::connect(profile_id, SETTINGS_TIMEOUT)
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

fn read_selection(state: &SettingsState) -> Option<EndpointSettingsSelection> {
    let server_url = get_text(state.server_url);
    let endpoints = ServerEndpoints::from_server_url(&server_url).ok()?;
    Some(EndpointSettingsSelection {
        follow_official: !is_checked(state.custom),
        server_url: normalized_url(&endpoints),
    })
}

fn show_invalid_address(hwnd: HWND, state: &mut SettingsState) {
    state.pending_save = false;
    state.last_successful_test = None;
    state.test_status =
        "! 远程地址必须使用 HTTPS（本机测试可使用 HTTP），且不能包含路径或参数。".to_owned();
    state.test_status_color = Rgb(185, 28, 28);
    unsafe { InvalidateRect(hwnd, null(), 1) };
}

fn set_busy(state: &SettingsState, busy: bool, kind: RequestKind) {
    unsafe {
        for control in [state.official, state.custom, state.test, state.save] {
            EnableWindow(control, i32::from(!busy));
        }
        EnableWindow(
            state.server_url,
            i32::from(!busy && is_checked(state.custom)),
        );
        EnableWindow(state.restore, i32::from(!busy && is_checked(state.custom)));
    }
    set_text(
        state.test,
        if busy && kind == RequestKind::Test {
            "正在测试…"
        } else {
            "测试连接"
        },
    );
}

unsafe fn paint_window(hwnd: HWND, state: &SettingsState) {
    let mut paint = windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT::default();
    let hdc = unsafe { windows_sys::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint) };
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    fill(hdc, client, Rgb(248, 250, 252));
    draw_text(
        hdc,
        "连接设置",
        rect(28, 18, width - 28, 51),
        state.heading_font,
        Rgb(15, 23, 42),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        "统一设置桥接服务器地址，行情、交易指令和授权通道会自动完成配置。",
        rect(28, 51, width - 28, 80),
        state.body_font,
        Rgb(71, 85, 105),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    fill(hdc, rect(28, 136, width - 28, 250), Rgb(255, 255, 255));
    draw_text(
        hdc,
        "服务器地址",
        rect(46, 147, width - 46, 175),
        state.body_bold_font,
        Rgb(51, 65, 85),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        "远程地址需使用 HTTPS；本机测试可使用 HTTP。实时通道会自动配置。",
        rect(46, 218, width - 46, 246),
        state.body_font,
        Rgb(71, 85, 105),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    draw_text(
        hdc,
        &state.test_status,
        rect(32, 269, width - 138, 306),
        state.body_font,
        state.test_status_color,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    fill(hdc, rect(28, 316, width - 28, 352), Rgb(255, 251, 235));
    draw_text(
        hdc,
        "切换控制服务时会清除旧服务器授权，重启后需在新服务器重新授权一次。",
        rect(40, 316, width - 40, 352),
        state.body_font,
        Rgb(146, 64, 14),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let _ = height;
    unsafe { windows_sys::Win32::Graphics::Gdi::EndPaint(hwnd, &paint) };
}

unsafe fn draw_settings_button(lparam: LPARAM) -> LRESULT {
    let item = lparam as *const windows_sys::Win32::UI::Controls::DRAWITEMSTRUCT;
    if item.is_null() {
        return 0;
    }
    let item = unsafe { &*item };
    let primary = item.CtlID as i32 == CONTROL_SAVE;
    let disabled = item.itemState & windows_sys::Win32::UI::Controls::ODS_DISABLED != 0;
    let selected = item.itemState & windows_sys::Win32::UI::Controls::ODS_SELECTED != 0;
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
    let text = get_text(item.hwndItem);
    draw_text(
        item.hDC,
        &text,
        item.rcItem,
        null_mut(),
        if disabled {
            Rgb(148, 163, 184)
        } else {
            Rgb(30, 41, 59)
        },
        windows_sys::Win32::Graphics::Gdi::DT_CENTER | DT_SINGLELINE | DT_VCENTER,
    );
    1
}

fn normalized_url(endpoints: &ServerEndpoints) -> String {
    endpoints
        .control_base()
        .as_str()
        .trim_end_matches('/')
        .to_owned()
}

fn fingerprint(selection: &EndpointSettingsSelection) -> String {
    format!("{}|{}", selection.follow_official, selection.server_url)
}

fn is_checked(control: HWND) -> bool {
    unsafe { SendMessageW(control, BM_GETCHECK, 0, 0) == BST_CHECKED as isize }
}

fn get_text(control: HWND) -> String {
    let length = unsafe { GetWindowTextLengthW(control) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer = vec![0_u16; length as usize + 1];
    let copied = unsafe { GetWindowTextW(control, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
}

fn set_text(control: HWND, text: &str) {
    let value = wide(text);
    unsafe { SetWindowTextW(control, value.as_ptr()) };
}

fn centered_position(owner: HWND, width: i32, height: i32) -> (i32, i32) {
    let mut owner_bounds = RECT::default();
    if unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect(owner, &mut owner_bounds)
    } != 0
    {
        return (
            owner_bounds.left + ((owner_bounds.right - owner_bounds.left - width) / 2).max(0),
            owner_bounds.top + ((owner_bounds.bottom - owner_bounds.top - height) / 2).max(0),
        );
    }
    (0, 0)
}

fn cleanup_state(state: SettingsState) {
    for object in [
        state.body_font as HGDIOBJ,
        state.body_bold_font as HGDIOBJ,
        state.heading_font as HGDIOBJ,
        state.background_brush as HGDIOBJ,
        state.white_brush as HGDIOBJ,
        state.disabled_brush as HGDIOBJ,
    ] {
        if !object.is_null() {
            unsafe { DeleteObject(object) };
        }
    }
}

fn now_utc_msc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}
