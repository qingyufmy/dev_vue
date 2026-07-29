use std::collections::{HashMap, HashSet};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};

use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    COLOR_BTNFACE, FW_BOLD, FW_NORMAL, GetSysColorBrush, HFONT, SetBkMode, SetTextColor,
    TRANSPARENT,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, GetDriveTypeW, GetLogicalDrives,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    EM_SETLIMITTEXT, EM_SETREADONLY, HTREEITEM, NMHDR, NMTREEVIEWW, TVE_EXPAND, TVGN_CHILD,
    TVI_LAST, TVI_ROOT, TVIF_TEXT, TVINSERTSTRUCTW, TVITEMEXW, TVM_DELETEITEM, TVM_EXPAND,
    TVM_GETNEXTITEM, TVM_INSERTITEMW, TVN_ITEMEXPANDINGW, TVN_SELCHANGEDW, TVS_HASBUTTONS,
    TVS_HASLINES, TVS_LINESATROOT, TVS_SHOWSELALWAYS, WC_TREEVIEWW,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, BN_CLICKED, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CREATESTRUCTW, CS_HREDRAW,
    CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, ES_AUTOHSCROLL, GWLP_USERDATA,
    GetClientRect, GetMessageW, GetWindowLongPtrW, HICON, HMENU, IDC_ARROW, IsDialogMessageW,
    IsWindow, LoadCursorW, MINMAXINFO, MSG, MoveWindow, PostMessageW, PostQuitMessage,
    RegisterClassExW, SW_SHOW, SendMessageW, SetForegroundWindow, SetWindowLongPtrW,
    SetWindowTextW, ShowWindow, TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE,
    WM_CTLCOLORSTATIC, WM_GETMINMAXINFO, WM_NCCREATE, WM_NCDESTROY, WM_NOTIFY, WM_SETFONT, WM_SIZE,
    WNDCLASSEXW, WS_BORDER, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_EX_CLIENTEDGE,
    WS_EX_DLGMODALFRAME, WS_SYSMENU, WS_TABSTOP, WS_THICKFRAME, WS_VISIBLE,
};

use super::{create_font, wide};

const WINDOW_CLASS: &str = "LiangJianBridgeNativeTerminalDirectory";
const WINDOW_CLIENT_WIDTH: i32 = 620;
const WINDOW_CLIENT_HEIGHT: i32 = 470;
const WINDOW_MIN_WIDTH: i32 = 560;
const WINDOW_MIN_HEIGHT: i32 = 420;
const CONTROL_TREE: i32 = 4200;
const CONTROL_SELECTED_PATH: i32 = 4201;
const CONTROL_CONFIRM: i32 = 1;
const CONTROL_CANCEL: i32 = 2;
const WM_DIRECTORY_READY: u32 = WM_APP + 42;
const DRIVE_FIXED: u32 = 3;
const MAXIMUM_CHILD_DIRECTORIES: usize = 500;

struct DirectoryReadResult {
    parent: HTREEITEM,
    children: Vec<PathBuf>,
}

struct DirectoryState {
    result: Arc<Mutex<Option<PathBuf>>>,
    tree: HWND,
    help: HWND,
    selected_heading: HWND,
    selected_path: HWND,
    confirm: HWND,
    cancel: HWND,
    nodes: HashMap<usize, Option<PathBuf>>,
    loaded: HashSet<usize>,
    body_font: HFONT,
    body_bold_font: HFONT,
}

pub(super) unsafe fn show_modal(
    owner: HWND,
    icon: HICON,
    platform: &str,
    current_path: Option<&str>,
    suggested_directories: &[PathBuf],
) -> Result<Option<PathBuf>, &'static str> {
    let instance = unsafe { GetModuleHandleW(null()) };
    register_window_class(instance, icon)?;
    let result = Arc::new(Mutex::new(None));
    let state = Box::new(DirectoryState {
        result: Arc::clone(&result),
        tree: null_mut(),
        help: null_mut(),
        selected_heading: null_mut(),
        selected_path: null_mut(),
        confirm: null_mut(),
        cancel: null_mut(),
        nodes: HashMap::new(),
        loaded: HashSet::new(),
        body_font: create_font(14, FW_NORMAL as i32),
        body_bold_font: create_font(14, FW_BOLD as i32),
    });
    let state_pointer = Box::into_raw(state);
    let style = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_CLIPCHILDREN;
    let mut outer = RECT {
        left: 0,
        top: 0,
        right: WINDOW_CLIENT_WIDTH,
        bottom: WINDOW_CLIENT_HEIGHT,
    };
    unsafe { AdjustWindowRectEx(&mut outer, style, 0, WS_EX_DLGMODALFRAME) };
    let width = outer.right - outer.left;
    let height = outer.bottom - outer.top;
    let (x, y) = centered_position(owner, width, height);
    let class_name = wide(WINDOW_CLASS);
    let title = wide(&format!("选择 {} 目录", display_platform(platform)));
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
        return Err("bridge_terminal_directory_window_create_failed");
    }
    unsafe {
        populate_roots(hwnd, &mut *state_pointer, suggested_directories);
        if let Some(path) = current_path.and_then(existing_directory) {
            select_directory(&mut *state_pointer, Some(path));
        }
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
        Err("bridge_terminal_directory_window_class_failed")
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
    let state_pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut DirectoryState;
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
                match id {
                    CONTROL_CONFIRM => unsafe { confirm_selection(hwnd, state) },
                    CONTROL_CANCEL => unsafe {
                        DestroyWindow(hwnd);
                    },
                    _ => {}
                }
            }
            0
        }
        WM_NOTIFY => {
            unsafe { handle_tree_notification(hwnd, state, lparam) };
            0
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as windows_sys::Win32::Graphics::Gdi::HDC;
            unsafe {
                SetBkMode(hdc, TRANSPARENT as i32);
                SetTextColor(
                    hdc,
                    if lparam as HWND == state.help {
                        0x0069_5547
                    } else {
                        0
                    },
                );
            }
            (unsafe { GetSysColorBrush(COLOR_BTNFACE) }) as LRESULT
        }
        WM_DIRECTORY_READY => {
            let result = unsafe { Box::from_raw(lparam as *mut DirectoryReadResult) };
            unsafe { apply_directory_result(state, *result) };
            0
        }
        WM_CLOSE => {
            unsafe { DestroyWindow(hwnd) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn create_controls(hwnd: HWND, state: &mut DirectoryState) {
    let instance = unsafe { GetModuleHandleW(null()) };
    state.help = create_static(
        hwnd,
        instance,
        "选择自动检测到的终端，或展开本机磁盘查找目录。",
        state.body_font,
    );
    state.tree = unsafe {
        CreateWindowExW(
            WS_EX_CLIENTEDGE,
            WC_TREEVIEWW,
            null(),
            WS_CHILD
                | WS_VISIBLE
                | WS_TABSTOP
                | TVS_HASBUTTONS
                | TVS_HASLINES
                | TVS_LINESATROOT
                | TVS_SHOWSELALWAYS,
            0,
            0,
            100,
            100,
            hwnd,
            CONTROL_TREE as HMENU,
            instance,
            null(),
        )
    };
    let edit_class = wide("EDIT");
    state.selected_path = unsafe {
        CreateWindowExW(
            0,
            edit_class.as_ptr(),
            null(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL as u32,
            0,
            0,
            100,
            26,
            hwnd,
            CONTROL_SELECTED_PATH as HMENU,
            instance,
            null(),
        )
    };
    state.confirm = create_button(
        hwnd,
        instance,
        CONTROL_CONFIRM,
        "选择此目录",
        BS_DEFPUSHBUTTON as u32,
    );
    state.cancel = create_button(hwnd, instance, CONTROL_CANCEL, "取消", BS_PUSHBUTTON as u32);
    state.selected_heading = create_static(hwnd, instance, "已选择目录", state.body_bold_font);
    for control in [state.tree, state.selected_path, state.confirm, state.cancel] {
        unsafe { SendMessageW(control, WM_SETFONT, state.body_font as usize, 1) };
    }
    unsafe {
        SendMessageW(state.selected_path, EM_SETREADONLY, 1, 0);
        SendMessageW(state.selected_path, EM_SETLIMITTEXT, 32_767, 0);
        EnableWindow(state.confirm, 0);
    }
}

fn create_static(owner: HWND, instance: HINSTANCE, text: &str, font: HFONT) -> HWND {
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
            null_mut(),
            instance,
            null(),
        )
    };
    unsafe { SendMessageW(control, WM_SETFONT, font as usize, 1) };
    control
}

fn create_button(owner: HWND, instance: HINSTANCE, id: i32, text: &str, button_style: u32) -> HWND {
    let class = wide("BUTTON");
    let copy = wide(text);
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            copy.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | button_style,
            0,
            0,
            96,
            32,
            owner,
            id as HMENU,
            instance,
            null(),
        )
    }
}

unsafe fn layout_controls(hwnd: HWND, state: &DirectoryState) {
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) };
    let width = client.right - client.left;
    let height = client.bottom - client.top;
    let content_width = (width - 32).max(200);
    unsafe {
        MoveWindow(state.help, 16, 16, content_width, 22, 1);
        MoveWindow(
            state.tree,
            16,
            48,
            content_width,
            (height - 168).max(180),
            1,
        );
        MoveWindow(
            state.selected_heading,
            16,
            height - 122,
            content_width,
            22,
            1,
        );
        MoveWindow(state.selected_path, 16, height - 90, content_width, 28, 1);
        MoveWindow(state.confirm, width - 120, height - 48, 104, 32, 1);
        MoveWindow(state.cancel, width - 224, height - 48, 96, 32, 1);
    }
    invalidate(hwnd);
}

unsafe fn populate_roots(
    hwnd: HWND,
    state: &mut DirectoryState,
    suggested_directories: &[PathBuf],
) {
    let mut suggestions = suggested_directories
        .iter()
        .filter_map(|path| existing_directory(path.to_str()?))
        .collect::<Vec<_>>();
    sort_and_deduplicate_paths(&mut suggestions);
    if !suggestions.is_empty() {
        let root = unsafe { insert_node(state, TVI_ROOT, "自动检测到的终端", None, true) };
        for path in suggestions {
            unsafe { insert_directory_node(state, root, &path, true) };
        }
        unsafe { SendMessageW(state.tree, TVM_EXPAND, TVE_EXPAND as usize, root as isize) };
    }
    let drives_root = unsafe { insert_node(state, TVI_ROOT, "本机磁盘", None, true) };
    for path in local_fixed_drives() {
        unsafe { insert_directory_node(state, drives_root, &path, true) };
    }
    unsafe {
        SendMessageW(
            state.tree,
            TVM_EXPAND,
            TVE_EXPAND as usize,
            drives_root as isize,
        )
    };
    invalidate(hwnd);
}

unsafe fn insert_directory_node(
    state: &mut DirectoryState,
    parent: HTREEITEM,
    path: &Path,
    show_full_path: bool,
) -> HTREEITEM {
    let label = if show_full_path {
        path.display().to_string()
    } else {
        path.file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| path.display().to_string())
    };
    let item = unsafe { insert_node(state, parent, &label, Some(path.to_path_buf()), true) };
    unsafe { insert_node(state, item, "正在读取…", None, false) };
    item
}

unsafe fn insert_node(
    state: &mut DirectoryState,
    parent: HTREEITEM,
    label: &str,
    path: Option<PathBuf>,
    has_children: bool,
) -> HTREEITEM {
    let mut label = wide(label);
    let mut insert = TVINSERTSTRUCTW {
        hParent: parent,
        hInsertAfter: TVI_LAST,
        ..TVINSERTSTRUCTW::default()
    };
    insert.Anonymous.itemex = TVITEMEXW {
        mask: TVIF_TEXT,
        pszText: label.as_mut_ptr(),
        cchTextMax: i32::try_from(label.len().saturating_sub(1)).unwrap_or(i32::MAX),
        cChildren: i32::from(has_children),
        ..TVITEMEXW::default()
    };
    let item = unsafe {
        SendMessageW(
            state.tree,
            TVM_INSERTITEMW,
            0,
            (&insert as *const TVINSERTSTRUCTW) as isize,
        ) as HTREEITEM
    };
    if item != 0 {
        state.nodes.insert(item as usize, path);
    }
    item
}

unsafe fn handle_tree_notification(hwnd: HWND, state: &mut DirectoryState, lparam: LPARAM) {
    let header = lparam as *const NMHDR;
    if header.is_null() || unsafe { (*header).hwndFrom } != state.tree {
        return;
    }
    match unsafe { (*header).code } {
        TVN_SELCHANGEDW => {
            let notification = lparam as *const NMTREEVIEWW;
            if notification.is_null() {
                return;
            }
            let item = unsafe { (*notification).itemNew.hItem };
            let path = state.nodes.get(&(item as usize)).and_then(Clone::clone);
            unsafe { select_directory(state, path) };
        }
        TVN_ITEMEXPANDINGW => {
            let notification = lparam as *const NMTREEVIEWW;
            if notification.is_null() || unsafe { (*notification).action } != TVE_EXPAND {
                return;
            }
            let item = unsafe { (*notification).itemNew.hItem };
            let key = item as usize;
            let Some(path) = state.nodes.get(&key).and_then(Clone::clone) else {
                return;
            };
            if !state.loaded.insert(key) {
                return;
            }
            spawn_directory_read(hwnd, item, path);
        }
        _ => {}
    }
}

fn spawn_directory_read(hwnd: HWND, parent: HTREEITEM, path: PathBuf) {
    let hwnd_value = hwnd as usize;
    let parent_value = parent as usize;
    std::thread::spawn(move || {
        let result = Box::new(DirectoryReadResult {
            parent: parent_value as HTREEITEM,
            children: read_child_directories(&path),
        });
        let pointer = Box::into_raw(result);
        if unsafe { PostMessageW(hwnd_value as HWND, WM_DIRECTORY_READY, 0, pointer as isize) } == 0
        {
            unsafe { drop(Box::from_raw(pointer)) };
        }
    });
}

unsafe fn apply_directory_result(state: &mut DirectoryState, result: DirectoryReadResult) {
    loop {
        let child = unsafe {
            SendMessageW(
                state.tree,
                TVM_GETNEXTITEM,
                TVGN_CHILD as usize,
                result.parent,
            )
        } as HTREEITEM;
        if child == 0 {
            break;
        }
        state.nodes.remove(&(child as usize));
        unsafe { SendMessageW(state.tree, TVM_DELETEITEM, 0, child as isize) };
    }
    if result.children.is_empty() {
        unsafe { insert_node(state, result.parent, "没有可访问的子目录", None, false) };
    } else {
        for path in result.children {
            unsafe { insert_directory_node(state, result.parent, &path, false) };
        }
    }
}

unsafe fn select_directory(state: &mut DirectoryState, path: Option<PathBuf>) {
    let selected = path.filter(|value| value.is_dir());
    let text = selected
        .as_ref()
        .map(|value| value.display().to_string())
        .unwrap_or_default();
    let copy = wide(&text);
    unsafe {
        SetWindowTextW(state.selected_path, copy.as_ptr());
        EnableWindow(state.confirm, i32::from(selected.is_some()));
    }
}

unsafe fn confirm_selection(hwnd: HWND, state: &DirectoryState) {
    let path = selected_path_text(state.selected_path).and_then(|value| existing_directory(&value));
    if let Some(path) = path {
        if let Ok(mut result) = state.result.lock() {
            *result = Some(path);
        }
        unsafe { DestroyWindow(hwnd) };
    }
}

fn selected_path_text(edit: HWND) -> Option<String> {
    let length = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextLengthW(edit) };
    if length <= 0 {
        return None;
    }
    let mut buffer = vec![0_u16; length as usize + 1];
    let copied = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
            edit,
            buffer.as_mut_ptr(),
            i32::try_from(buffer.len()).ok()?,
        )
    };
    (copied > 0).then(|| String::from_utf16_lossy(&buffer[..copied as usize]))
}

fn existing_directory(value: &str) -> Option<PathBuf> {
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

fn local_fixed_drives() -> Vec<PathBuf> {
    let mask = unsafe { GetLogicalDrives() };
    (0_u8..26)
        .filter(|index| mask & (1_u32 << index) != 0)
        .filter_map(|index| {
            let drive = format!("{}:\\", char::from(b'A' + index));
            let wide_drive = wide(&drive);
            (unsafe { GetDriveTypeW(wide_drive.as_ptr()) } == DRIVE_FIXED)
                .then(|| PathBuf::from(drive))
        })
        .collect()
}

fn read_child_directories(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut children = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            (metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
                .then(|| entry.path())
        })
        .take(MAXIMUM_CHILD_DIRECTORIES)
        .collect::<Vec<_>>();
    children.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    children
}

fn sort_and_deduplicate_paths(paths: &mut Vec<PathBuf>) {
    paths.sort_by_key(|path| path.to_string_lossy().to_lowercase());
    paths.dedup_by(|left, right| {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    });
}

fn display_platform(platform: &str) -> &'static str {
    if platform.eq_ignore_ascii_case("mt4") {
        "MT4"
    } else {
        "MT5"
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

fn invalidate(hwnd: HWND) {
    unsafe {
        windows_sys::Win32::Graphics::Gdi::InvalidateRect(hwnd, null(), 1);
    }
}

fn cleanup_state(state: DirectoryState) {
    for font in [state.body_font, state.body_bold_font] {
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
    fn platform_titles_match_the_dotnet_directory_dialog() {
        assert_eq!(display_platform("mt4"), "MT4");
        assert_eq!(display_platform("MT5"), "MT5");
    }

    #[test]
    fn child_enumeration_skips_missing_paths_and_is_bounded() {
        assert!(
            read_child_directories(Path::new("Z:\\bridge-path-that-does-not-exist")).is_empty()
        );
        assert_eq!(MAXIMUM_CHILD_DIRECTORIES, 500);
    }

    #[test]
    fn user_facing_paths_do_not_show_the_windows_verbatim_prefix() {
        assert_eq!(
            user_facing_path(Path::new(r"\\?\C:\Program Files\Broker MT5")),
            PathBuf::from(r"C:\Program Files\Broker MT5")
        );
    }
}
