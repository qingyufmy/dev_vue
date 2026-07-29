use bridge_ui_model::{PermissionDetailView, PermissionView, Rgb};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    ClientToScreen, DT_LEFT, DT_SINGLELINE, DT_TOP, DT_VCENTER, DT_WORDBREAK, DeleteObject,
    FW_BOLD, FW_NORMAL, HGDIOBJ, InvalidateRect, UpdateWindow,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CREATESTRUCTW, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, GWLP_USERDATA,
    GetSystemMetrics, GetWindowLongPtrW, HICON, HTTRANSPARENT, IDC_ARROW, IsWindow, LoadCursorW,
    MA_NOACTIVATE, RegisterClassExW, SM_CXSCREEN, SM_CYSCREEN, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, ShowWindow, WM_MOUSEACTIVATE,
    WM_NCCREATE, WM_NCDESTROY, WM_NCHITTEST, WM_PAINT, WNDCLASSEXW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use super::{create_point_font, draw_border, draw_text, fill, rect, scale, wide};

const WINDOW_CLASS: &str = "LiangJianBridgePermissionTooltip";
const TOOLTIP_WIDTH: i32 = 360;
const HORIZONTAL_PADDING: i32 = 14;
const TITLE_HEIGHT: i32 = 25;
const DETAIL_LINE_HEIGHT: i32 = 23;
const ACTION_HEIGHT: i32 = 46;

struct TooltipState {
    permission: PermissionView,
    body_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    bold_font: windows_sys::Win32::Graphics::Gdi::HFONT,
    dpi: u32,
}

pub(super) unsafe fn show_or_update(
    existing: HWND,
    owner: HWND,
    permission: &PermissionView,
    badge_bounds: RECT,
    icon: HICON,
    dpi: u32,
) -> Result<HWND, &'static str> {
    let hwnd = if !existing.is_null() && unsafe { IsWindow(existing) } != 0 {
        let pointer = unsafe { GetWindowLongPtrW(existing, GWLP_USERDATA) } as *mut TooltipState;
        if pointer.is_null() {
            return Err("bridge_permission_tooltip_state_invalid");
        }
        unsafe { (*pointer).permission = permission.clone() };
        existing
    } else {
        create_tooltip(owner, permission.clone(), icon, dpi)?
    };
    let height = tooltip_height(permission, dpi);
    let width = scale(TOOLTIP_WIDTH, dpi);
    let mut position = POINT {
        x: badge_bounds.left,
        y: badge_bounds.bottom + scale(4, dpi),
    };
    unsafe { ClientToScreen(owner, &mut position) };
    let screen_width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    position.x = position
        .x
        .min((screen_width - width - scale(8, dpi)).max(0));
    if position.y + height > screen_height - scale(8, dpi) {
        let mut above = POINT {
            x: badge_bounds.left,
            y: badge_bounds.top - height - scale(4, dpi),
        };
        unsafe { ClientToScreen(owner, &mut above) };
        position.y = above.y.max(scale(8, dpi));
    }
    unsafe {
        SetWindowPos(
            hwnd,
            -1_isize as HWND,
            position.x,
            position.y,
            width,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        InvalidateRect(hwnd, null(), 1);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        UpdateWindow(hwnd);
    }
    Ok(hwnd)
}

pub(super) unsafe fn hide(hwnd: HWND) {
    if !hwnd.is_null() && unsafe { IsWindow(hwnd) } != 0 {
        unsafe { ShowWindow(hwnd, SW_HIDE) };
    }
}

fn create_tooltip(
    owner: HWND,
    permission: PermissionView,
    icon: HICON,
    dpi: u32,
) -> Result<HWND, &'static str> {
    let instance = unsafe { GetModuleHandleW(null()) };
    register_window_class(instance, icon)?;
    let height = tooltip_height(&permission, dpi);
    let state = Box::new(TooltipState {
        permission,
        body_font: create_point_font(90, dpi, FW_NORMAL as i32),
        bold_font: create_point_font(90, dpi, FW_BOLD as i32),
        dpi,
    });
    let state_pointer = Box::into_raw(state);
    let class_name = wide(WINDOW_CLASS);
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            null(),
            WS_POPUP,
            0,
            0,
            scale(TOOLTIP_WIDTH, dpi),
            height,
            owner,
            null_mut(),
            instance,
            state_pointer.cast(),
        )
    };
    if hwnd.is_null() {
        unsafe { drop(Box::from_raw(state_pointer)) };
        Err("bridge_permission_tooltip_create_failed")
    } else {
        Ok(hwnd)
    }
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
        Err("bridge_permission_tooltip_class_failed")
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
    let state_pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut TooltipState;
    if state_pointer.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    if message == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
        let state = unsafe { Box::from_raw(state_pointer) };
        cleanup_state(*state);
        return 0;
    }
    let state = unsafe { &mut *state_pointer };
    match message {
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
        WM_PAINT => {
            unsafe { paint_window(hwnd, state) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn paint_window(hwnd: HWND, state: &TooltipState) {
    let mut paint = windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT::default();
    let hdc = unsafe { windows_sys::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut paint) };
    let s = |value| scale(value, state.dpi);
    let width = s(TOOLTIP_WIDTH);
    let height = tooltip_height(&state.permission, state.dpi);
    let bounds = rect(0, 0, width, height);
    fill(hdc, bounds, Rgb(255, 255, 255));
    draw_border(hdc, bounds, Rgb(203, 213, 225));
    draw_text(
        hdc,
        "交易权限详情",
        rect(
            s(HORIZONTAL_PADDING),
            s(11),
            width - s(HORIZONTAL_PADDING),
            s(11 + TITLE_HEIGHT),
        ),
        state.bold_font,
        Rgb(15, 23, 42),
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );
    let detail_top = s(11 + TITLE_HEIGHT);
    let label_width = permission_label_width(&state.permission.details, state.dpi);
    for (index, detail) in state.permission.details.iter().enumerate() {
        let top = detail_top + index as i32 * s(DETAIL_LINE_HEIGHT);
        draw_text(
            hdc,
            &format!("{}：", detail.label),
            rect(
                s(HORIZONTAL_PADDING),
                top,
                s(HORIZONTAL_PADDING) + label_width,
                top + s(DETAIL_LINE_HEIGHT),
            ),
            state.body_font,
            Rgb(71, 85, 105),
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        draw_text(
            hdc,
            &format!("● {}", permission_state_text(detail.allowed)),
            rect(
                s(HORIZONTAL_PADDING) + label_width + s(8),
                top,
                width - s(HORIZONTAL_PADDING),
                top + s(DETAIL_LINE_HEIGHT),
            ),
            state.bold_font,
            detail.color,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
    }
    let divider_top =
        detail_top + state.permission.details.len() as i32 * s(DETAIL_LINE_HEIGHT) + s(5);
    fill(
        hdc,
        rect(
            s(HORIZONTAL_PADDING),
            divider_top,
            width - s(HORIZONTAL_PADDING),
            divider_top + s(1),
        ),
        Rgb(226, 232, 240),
    );
    draw_text(
        hdc,
        &state.permission.action,
        rect(
            s(HORIZONTAL_PADDING),
            divider_top + s(8),
            width - s(HORIZONTAL_PADDING),
            height - s(HORIZONTAL_PADDING),
        ),
        state.body_font,
        Rgb(51, 65, 85),
        DT_LEFT | DT_TOP | DT_WORDBREAK,
    );
    unsafe { windows_sys::Win32::Graphics::Gdi::EndPaint(hwnd, &paint) };
}

fn tooltip_height(permission: &PermissionView, dpi: u32) -> i32 {
    scale(
        HORIZONTAL_PADDING
            + TITLE_HEIGHT
            + permission.details.len() as i32 * DETAIL_LINE_HEIGHT
            + 13
            + ACTION_HEIGHT
            + HORIZONTAL_PADDING,
        dpi,
    )
}

fn permission_label_width(details: &[PermissionDetailView], dpi: u32) -> i32 {
    scale(
        if details
            .iter()
            .any(|detail| detail.label.contains("允许实时自动交易"))
        {
            178
        } else {
            156
        },
        dpi,
    )
}

fn permission_state_text(allowed: Option<bool>) -> &'static str {
    match allowed {
        Some(true) => "已开启",
        Some(false) => "已关闭",
        None => "检测中",
    }
}

fn cleanup_state(state: TooltipState) {
    for font in [state.body_font, state.bold_font] {
        if !font.is_null() {
            unsafe { DeleteObject(font as HGDIOBJ) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_ui_model::PermissionDetailView;

    #[test]
    fn tooltip_height_tracks_the_dotnet_permission_rows() {
        let permission = PermissionView {
            summary: "交易权限异常".to_owned(),
            accessible_description: String::new(),
            action: "请开启对应开关。".to_owned(),
            foreground: Rgb(153, 27, 27),
            background: Rgb(254, 226, 226),
            details: vec![
                PermissionDetailView {
                    label: "MT4 顶部“自动交易”".to_owned(),
                    allowed: Some(true),
                    color: Rgb(4, 120, 87),
                },
                PermissionDetailView {
                    label: "EA“允许实时自动交易”".to_owned(),
                    allowed: Some(false),
                    color: Rgb(185, 28, 28),
                },
                PermissionDetailView {
                    label: "账户 EA 权限".to_owned(),
                    allowed: Some(true),
                    color: Rgb(4, 120, 87),
                },
                PermissionDetailView {
                    label: "账户交易权限".to_owned(),
                    allowed: None,
                    color: Rgb(161, 98, 7),
                },
            ],
        };
        assert_eq!(tooltip_height(&permission, 96), 204);
        assert_eq!(permission_label_width(&permission.details, 96), 178);
        assert_eq!(tooltip_height(&permission, 120), 255);
        assert_eq!(permission_label_width(&permission.details, 120), 223);
    }
}
