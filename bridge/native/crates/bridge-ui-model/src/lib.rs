use bridge_foundation::DEFAULT_PROFILE_ID;
use bridge_local_control::{UiObserverProfile, UiStateSnapshot, UiTerminalStatus, UiUpdateNotice};
use std::collections::BTreeSet;

pub const PRODUCT_NAME: &str = "量见智桥";
pub const PRODUCT_SUBTITLE: &str = "连接交易终端与量见 AI交易实验室";
pub const OBSERVER_SUBTITLE: &str = "连接观摩终端与量见 AI交易实验室";
pub const SAFETY_COPY: &str = "关闭窗口后仍会在托盘运行。退出桥接不会撤单、平仓或关闭 MT。";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rgb(pub u8, pub u8, pub u8);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusCopy {
    pub title: String,
    pub description: String,
    pub accent: Rgb,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateBannerView {
    pub title: String,
    pub description: String,
    pub button_text: String,
    pub button_visible: bool,
    pub button_enabled: bool,
    pub background: Rgb,
    pub title_color: Rgb,
    pub description_color: Rgb,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObserverAction {
    Start,
    Pause,
    Retry,
    Bind,
    Configure,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionDetailView {
    pub label: String,
    pub allowed: Option<bool>,
    pub color: Rgb,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionView {
    pub summary: String,
    pub accessible_description: String,
    pub action: String,
    pub foreground: Rgb,
    pub background: Rgb,
    pub details: Vec<PermissionDetailView>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountCardView {
    pub role: String,
    pub title: String,
    pub state: String,
    pub state_color: Rgb,
    pub permission: Option<PermissionView>,
    pub mt4_expert_update: Option<String>,
    pub primary_action: Option<ObserverAction>,
    pub primary_action_text: Option<String>,
    pub settings_visible: bool,
    pub actions_busy: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalChoiceView {
    pub terminal_instance_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MainWindowView {
    pub window_title: String,
    pub heading: String,
    pub subtitle: String,
    pub update_banner: Option<UpdateBannerView>,
    pub status: StatusCopy,
    pub runtime_summary: String,
    pub selected_platform_label: Option<String>,
    pub show_logout: bool,
    pub show_observer_sources: bool,
    pub show_settings: bool,
    pub show_pair: bool,
    pub show_mt4_setup: bool,
    pub terminal_selector_visible: bool,
    pub terminal_selector_label: String,
    pub terminal_choices: Vec<TerminalChoiceView>,
    pub selected_terminal_instance_id: Option<String>,
    pub account_count_text: String,
    pub accounts: Vec<AccountCardView>,
    pub empty_accounts_text: Option<String>,
}

pub fn build_main_window_view<F>(
    state: &UiStateSnapshot,
    busy_observer_profiles: &BTreeSet<String>,
    format_local_time: F,
) -> Result<MainWindowView, &'static str>
where
    F: Fn(i64) -> String,
{
    state.validate(&state.profile_id)?;
    let default_profile = state.profile_id == DEFAULT_PROFILE_ID;
    let mut accounts = state
        .terminals
        .iter()
        .filter(|terminal| terminal.observer_profile_id.is_none())
        .map(|terminal| account_card(Some(terminal), "主账户", None, false))
        .collect::<Vec<_>>();
    if state.can_manage_observer_sources {
        for observer in &state.observer_profiles {
            let terminal = state.terminals.iter().find(|terminal| {
                terminal.observer_profile_id.as_deref()
                    == Some(observer.observer_profile_id.as_str())
            });
            accounts.push(account_card(
                terminal,
                &observer.observer_profile_id,
                Some(observer),
                busy_observer_profiles.contains(&observer.observer_profile_id),
            ));
        }
    }
    let account_count_text = if accounts.is_empty() {
        "暂无账户".to_owned()
    } else {
        format!("{} 个", accounts.len())
    };
    let selected_platform_label = state
        .selected_platform
        .as_deref()
        .map(platform_display_name)
        .map(str::to_owned);
    let terminal_selector_label = if state.selected_platform.as_deref() == Some("mt4") {
        "MT4 终端"
    } else {
        "MT5 账户"
    }
    .to_owned();
    let terminal_choices = state
        .terminal_candidates
        .iter()
        .map(|candidate| TerminalChoiceView {
            terminal_instance_id: candidate.terminal_instance_id.clone(),
            display_name: candidate
                .display_name
                .clone()
                .unwrap_or_else(|| format!("{}  ·  {}", candidate.login, candidate.broker_server)),
        })
        .collect::<Vec<_>>();
    Ok(MainWindowView {
        window_title: if default_profile {
            PRODUCT_NAME.to_owned()
        } else {
            format!("{PRODUCT_NAME} · 观摩源 {}", state.profile_id)
        },
        heading: if default_profile {
            PRODUCT_NAME.to_owned()
        } else {
            format!("{PRODUCT_NAME} · {}", state.profile_id)
        },
        subtitle: if default_profile {
            PRODUCT_SUBTITLE.to_owned()
        } else {
            OBSERVER_SUBTITLE.to_owned()
        },
        update_banner: state.update_notice.as_ref().map(describe_update_notice),
        status: describe_status(state),
        runtime_summary: describe_runtime_summary(state, format_local_time),
        selected_platform_label,
        show_logout: state.selected_platform.is_some()
            && !matches!(
                state.phase.as_str(),
                "pairing_required" | "platform_selection_required"
            ),
        show_observer_sources: default_profile && state.can_manage_observer_sources,
        show_settings: default_profile && (state.is_administrator || !state.server_connected),
        show_pair: state.phase == "pairing_required",
        show_mt4_setup: state.selected_platform.as_deref() == Some("mt4"),
        terminal_selector_visible: terminal_choices.len() > 1,
        terminal_selector_label,
        terminal_choices,
        selected_terminal_instance_id: state.selected_terminal_instance_id.clone(),
        account_count_text,
        empty_accounts_text: accounts.is_empty().then(|| "尚未识别到交易账户".to_owned()),
        accounts,
    })
}

pub fn resolve_account_column_count(available_width: i32) -> i32 {
    const MINIMUM_WIDTH: i32 = 400;
    const GAP: i32 = 8;
    if available_width <= 0 {
        1
    } else {
        ((available_width + GAP) / (MINIMUM_WIDTH + GAP)).max(1)
    }
}

pub fn describe_status(state: &UiStateSnapshot) -> StatusCopy {
    let platform = state
        .selected_platform
        .as_deref()
        .map(platform_display_name)
        .unwrap_or("交易终端");
    match state.phase.as_str() {
        "starting" => status("正在启动", "正在准备安全连接。", Rgb(100, 116, 139)),
        "platform_selection_required" => status(
            "请选择交易平台",
            "选择 MT5 或 MT4 后，桥接会自动检测对应终端。",
            Rgb(217, 119, 6),
        ),
        "terminal_selection_required" if state.selected_platform.as_deref() == Some("mt4") => {
            status(
                "请选择 MT4 终端",
                "检测到多个 MT4，请选择需要安装 EA 并连接的终端。",
                Rgb(217, 119, 6),
            )
        }
        "terminal_selection_required" => status(
            "请选择 MT5 账户",
            "检测到多个已登录 MT5，请选择需要桥接的账户。",
            Rgb(217, 119, 6),
        ),
        "detecting_terminal" => status(
            &format!("正在检测 {platform}"),
            &format!("请保持 {platform} 已打开并登录交易账户。"),
            Rgb(37, 99, 235),
        ),
        "terminal_not_found" => status(
            &format!("等待 {platform}"),
            &describe_code(
                state.detail_code.as_deref(),
                &format!("未发现可用的已登录 {platform}，程序会自动重试。"),
            ),
            Rgb(217, 119, 6),
        ),
        "pairing_required" => status(
            "需要连接量见账号",
            "请手动点击“连接账号”；浏览器授权成功后会长期保持登录。",
            Rgb(124, 58, 237),
        ),
        "connecting" => status(
            "正在连接服务器",
            &describe_code(
                state.detail_code.as_deref(),
                "本地终端已就绪，正在建立安全连接。",
            ),
            Rgb(37, 99, 235),
        ),
        "online" => status(
            "量见智桥运行中",
            "账户数据与交易指令通道均已连接。",
            Rgb(21, 128, 61),
        ),
        "degraded" if state.detail_code.as_deref() == Some("mt4_ea_reconnecting") => status(
            "正在恢复 MT4 连接",
            &describe_code(
                state.detail_code.as_deref(),
                "MT4 EA 连接短暂中断，程序正在自动恢复。",
            ),
            Rgb(217, 119, 6),
        ),
        "degraded" => status(
            "部分连接异常",
            &describe_code(
                state.detail_code.as_deref(),
                "程序正在自动恢复，不影响 MT 中已有订单。",
            ),
            Rgb(220, 38, 38),
        ),
        _ => status(
            "桥接已停止",
            "停止桥接不会撤单、平仓或关闭 MT。",
            Rgb(100, 116, 139),
        ),
    }
}

pub fn describe_runtime_summary<F>(state: &UiStateSnapshot, format_local_time: F) -> String
where
    F: Fn(i64) -> String,
{
    let server = if state.server_connected {
        "服务器已连接"
    } else {
        "服务器未连接"
    };
    let synchronization = state
        .last_data_sync_utc_msc
        .map(|timestamp| format!("最近同步 {}", format_local_time(timestamp)))
        .unwrap_or_else(|| "等待首次同步".to_owned());
    format!(
        "{server}  ·  {synchronization}  ·  版本 {}",
        state.bridge_version
    )
}

pub fn describe_update_notice(notice: &UiUpdateNotice) -> UpdateBannerView {
    let (title, description, button_text, button_visible, button_enabled) =
        match notice.phase.as_str() {
            "downloading" => (
                format!("发现新版本 {}", notice.version),
                "正在后台下载并校验，当前桥接和交易不受影响。".to_owned(),
                "重启更新".to_owned(),
                false,
                false,
            ),
            "waiting" => (
                format!("正在为版本 {} 申请安全更新窗口", notice.version),
                "桥接仍在运行；系统会等待当前交易指令和相关任务安全结束。".to_owned(),
                "等待安全窗口".to_owned(),
                true,
                false,
            ),
            "activating" => (
                format!("正在更新到版本 {}", notice.version),
                "正在排空交易通道并准备重启，请勿关闭程序或交易终端。".to_owned(),
                "正在重启".to_owned(),
                true,
                false,
            ),
            "failed" => (
                if notice.version.trim().is_empty() {
                    "更新检查暂时失败".to_owned()
                } else {
                    format!("版本 {} 暂时无法准备", notice.version)
                },
                "当前桥接和交易不受影响，系统会在稍后自动重新检查。".to_owned(),
                String::new(),
                false,
                false,
            ),
            "rolled_back" => (
                format!("版本 {} 启动失败，已恢复上一版本", notice.version),
                "账户连接已按上一稳定版本恢复；你可以稍后重新尝试更新。".to_owned(),
                "重新尝试".to_owned(),
                true,
                true,
            ),
            "healthy" => (
                format!("已更新到版本 {}", notice.version),
                "主账户与更新前在线的观摩源均已恢复。".to_owned(),
                String::new(),
                false,
                false,
            ),
            _ => (
                if notice.urgent {
                    format!("紧急修复 {} 已准备好", notice.version)
                } else {
                    format!("新版本 {} 已准备好", notice.version)
                },
                if notice.manual_activation_requested {
                    "已收到更新请求，将在当前操作结束后的安全时机重启。".to_owned()
                } else if notice.urgent {
                    "修复包已通过安全校验，可请求在最近的安全空闲时机更新。".to_owned()
                } else {
                    "更新包已通过安全校验，将在休市安全时段自动更新。".to_owned()
                },
                if notice.manual_activation_requested {
                    "已请求".to_owned()
                } else {
                    "重启更新".to_owned()
                },
                true,
                !notice.manual_activation_requested,
            ),
        };
    let failure = matches!(notice.phase.as_str(), "failed" | "rolled_back");
    let healthy = notice.phase == "healthy";
    let (background, title_color, description_color) = if failure {
        (Rgb(254, 242, 242), Rgb(153, 27, 27), Rgb(185, 28, 28))
    } else if healthy {
        (Rgb(236, 253, 245), Rgb(4, 120, 87), Rgb(5, 150, 105))
    } else if notice.urgent {
        (Rgb(255, 251, 235), Rgb(120, 53, 15), Rgb(146, 64, 14))
    } else {
        (Rgb(239, 246, 255), Rgb(30, 64, 175), Rgb(37, 99, 235))
    };
    UpdateBannerView {
        title,
        description,
        button_text,
        button_visible,
        button_enabled,
        background,
        title_color,
        description_color,
    }
}

fn account_card(
    terminal: Option<&UiTerminalStatus>,
    role: &str,
    observer: Option<&UiObserverProfile>,
    busy: bool,
) -> AccountCardView {
    let platform = terminal
        .map(|value| value.platform.as_str())
        .or_else(|| observer.and_then(|value| value.platform.as_deref()))
        .unwrap_or("terminal");
    let identity = terminal
        .filter(|value| !value.login.trim().is_empty())
        .map(|value| format!("{} · {}", platform.to_uppercase(), value.login))
        .unwrap_or_else(|| platform.to_uppercase());
    let observer_identity = observer.and_then(|value| value.observer_account_label.as_deref());
    let title = match observer_identity {
        None if observer.is_none() => format!("主账户  ·  {identity}"),
        None => format!("{role}  ·  {identity}"),
        Some(value) if value.trim().is_empty() => format!("{role}  ·  {identity}"),
        Some(value) => format!("{value}  ·  {identity}"),
    };
    let primary_action = observer.and_then(|profile| resolve_observer_action(profile, terminal));
    AccountCardView {
        role: role.to_owned(),
        title,
        state: describe_account_state(terminal, observer),
        state_color: account_state_color(terminal, observer),
        permission: terminal.map(permission_view),
        mt4_expert_update: terminal
            .filter(|value| value.platform == "mt4" && value.mt4_expert_restart_required)
            .map(|_| "EA 已更新，重启 MT4 后生效".to_owned()),
        primary_action,
        primary_action_text: primary_action.map(|action| {
            if busy {
                "处理中…".to_owned()
            } else {
                observer_action_text(action).to_owned()
            }
        }),
        settings_visible: observer.is_some(),
        actions_busy: busy,
    }
}

fn resolve_observer_action(
    profile: &UiObserverProfile,
    terminal: Option<&UiTerminalStatus>,
) -> Option<ObserverAction> {
    if profile.bridge_user_id.is_none() {
        Some(ObserverAction::Bind)
    } else if !profile.configured {
        None
    } else if !profile.enabled {
        Some(ObserverAction::Start)
    } else if terminal.is_none_or(|value| value.runtime_state == "stopped") {
        Some(ObserverAction::Retry)
    } else {
        Some(ObserverAction::Pause)
    }
}

fn observer_action_text(action: ObserverAction) -> &'static str {
    match action {
        ObserverAction::Start => "启动",
        ObserverAction::Pause => "暂停",
        ObserverAction::Retry => "重试",
        ObserverAction::Bind => "绑定",
        ObserverAction::Configure => "设置",
    }
}

fn describe_account_state(
    terminal: Option<&UiTerminalStatus>,
    observer: Option<&UiObserverProfile>,
) -> String {
    if observer.is_some_and(|profile| profile.bridge_user_id.is_none()) {
        return "待绑定观摩账户 · 点击“绑定”完成归属".to_owned();
    }
    if observer.is_some_and(|profile| !profile.configured) {
        return "观摩源 · 需要设置交易终端".to_owned();
    }
    if observer.is_some_and(|profile| !profile.enabled) {
        return "观摩源 · 已暂停，终端配置已保留".to_owned();
    }
    let Some(terminal) = terminal else {
        if observer.and_then(|profile| profile.runtime_phase.as_deref()) == Some("pairing_required")
        {
            return "观摩源授权已失效 · 请重新绑定".to_owned();
        }
        if observer.and_then(|profile| profile.runtime_phase.as_deref())
            == Some("terminal_not_found")
        {
            return "未找到配置的交易终端 · 请检查设置".to_owned();
        }
        return match observer {
            None => "等待识别账户".to_owned(),
            Some(profile) => profile
                .trading_account_label
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|account| format!("观摩源 · {account} · 正在连接"))
                .unwrap_or_else(|| "观摩源 · 正在连接交易终端".to_owned()),
        };
    };
    let broker = if terminal.broker_server.trim().is_empty() {
        "交易终端"
    } else {
        &terminal.broker_server
    };
    let prefix = if observer.is_some() {
        "观摩源 · "
    } else {
        ""
    };
    format!("{prefix}{broker} · {}", terminal_state_text(terminal))
}

fn account_state_color(
    terminal: Option<&UiTerminalStatus>,
    observer: Option<&UiObserverProfile>,
) -> Rgb {
    if observer.is_some_and(|profile| !profile.enabled) {
        return Rgb(100, 116, 139);
    }
    if observer.is_some_and(|profile| profile.bridge_user_id.is_none())
        || observer.is_some_and(|profile| !profile.configured)
        || terminal.is_none()
    {
        return Rgb(217, 119, 6);
    }
    match terminal.map(|value| value.runtime_state.as_str()) {
        Some("running") => Rgb(5, 150, 105),
        Some("stopped") => Rgb(220, 38, 38),
        _ => Rgb(37, 99, 235),
    }
}

fn permission_view(terminal: &UiTerminalStatus) -> PermissionView {
    let values = relevant_permissions(terminal);
    let summary = if values.iter().any(|value| value.is_none()) {
        "权限检测中"
    } else if values.contains(&Some(false)) {
        "交易权限异常"
    } else {
        "交易权限正常"
    };
    let (foreground, background) = match summary {
        "交易权限异常" => (Rgb(153, 27, 27), Rgb(254, 226, 226)),
        "交易权限正常" => (Rgb(4, 120, 87), Rgb(209, 250, 229)),
        _ => (Rgb(146, 64, 14), Rgb(254, 243, 199)),
    };
    let raw_details: Vec<(&str, Option<bool>)> = if terminal.platform == "mt4" {
        vec![
            ("MT4 顶部“自动交易”", terminal.terminal_trading_allowed),
            ("EA“允许实时自动交易”", terminal.program_trading_allowed),
            ("账户 EA 权限", terminal.account_expert_trading_allowed),
            ("账户交易权限", terminal.account_trading_allowed),
        ]
    } else {
        vec![
            ("MT5 工具栏“算法交易”", terminal.terminal_trading_allowed),
            ("账户 EA 权限", terminal.account_expert_trading_allowed),
            ("账户交易权限", terminal.account_trading_allowed),
        ]
    };
    let action = permission_action(terminal);
    let accessible_description = raw_details
        .iter()
        .map(|(label, allowed)| format!("{label}：{}", permission_text(*allowed)))
        .chain(std::iter::once(String::new()))
        .chain(std::iter::once(action.clone()))
        .collect::<Vec<_>>()
        .join("\n");
    PermissionView {
        summary: summary.to_owned(),
        accessible_description,
        action,
        foreground,
        background,
        details: raw_details
            .into_iter()
            .map(|(label, allowed)| PermissionDetailView {
                label: label.to_owned(),
                allowed,
                color: permission_color(allowed),
            })
            .collect(),
    }
}

fn permission_action(terminal: &UiTerminalStatus) -> String {
    let values = relevant_permissions(terminal);
    if values.iter().any(|value| value.is_none()) {
        "权限仍在检测，请稍后点击“重新检测”。".to_owned()
    } else if values.iter().all(|value| *value == Some(true)) {
        "交易所需开关均已开启。".to_owned()
    } else if terminal.account_trading_allowed == Some(false)
        || terminal.account_expert_trading_allowed == Some(false)
    {
        "账户级权限已关闭；请检查账户设置，必要时联系经纪商，然后点击“重新检测”。".to_owned()
    } else if terminal.platform == "mt4" {
        "请在 MT4 和 EA 中开启上方关闭的开关，然后点击“重新检测”。".to_owned()
    } else {
        "请在 MT5 中开启上方关闭的开关，然后点击“重新检测”。".to_owned()
    }
}

fn relevant_permissions(terminal: &UiTerminalStatus) -> Vec<Option<bool>> {
    if terminal.platform == "mt4" {
        vec![
            terminal.terminal_trading_allowed,
            terminal.program_trading_allowed,
            terminal.account_trading_allowed,
            terminal.account_expert_trading_allowed,
        ]
    } else {
        vec![
            terminal.terminal_trading_allowed,
            terminal.account_trading_allowed,
            terminal.account_expert_trading_allowed,
        ]
    }
}

fn permission_text(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "已开启",
        Some(false) => "已关闭",
        None => "检测中",
    }
}

fn permission_color(value: Option<bool>) -> Rgb {
    match value {
        Some(true) => Rgb(4, 120, 87),
        Some(false) => Rgb(185, 28, 28),
        None => Rgb(161, 98, 7),
    }
}

fn terminal_state_text(terminal: &UiTerminalStatus) -> &'static str {
    match terminal.runtime_state.as_str() {
        "running" => "运行中",
        "restarting" => "自动恢复中",
        "stopped" if terminal.error_code.as_deref() == Some("terminal_worker_failure_limit") => {
            "已暂停，请重新检测"
        }
        "stopped" => "已停止",
        _ => "连接中",
    }
}

fn describe_code(code: Option<&str>, fallback: &str) -> String {
    match code {
        Some("mt5_terminal_not_found") => "未发现 MT5，请先打开并登录 MT5。",
        Some("mt5_account_unavailable") => "已发现 MT5，但尚未登录交易账户。",
        Some("mt5_terminal_disconnected") => "MT5 当前未连接交易服务器。",
        Some("trading_terminal_not_found") => {
            "未发现 MT5，也未收到 MT4 EA 连接；程序会自动重试。"
        }
        Some("mt4_terminal_not_found") => "未发现 MT4，请先打开一次 MT4，程序会自动安装 EA。",
        Some("mt4_platform_not_selected") => "请先将交易平台切换为 MT4。",
        Some("mt4_terminal_selection_required") => {
            "检测到多个 MT4，请先选择需要安装 EA 的终端。"
        }
        Some("mt4_terminal_data_path_not_found") => {
            "一个已绑定的 MT4 已不存在，请重新挂载 EA。"
        }
        Some("mt4_ea_attach_required") => {
            "EA 已安装。请在 MT4 的导航器中刷新，然后将 AURUMBridgeEA 挂到任意图表一次。"
        }
        Some("mt4_ea_package_not_found" | "mt4_ea_package_invalid") => {
            "MT4 EA 组件不完整，请重新安装或修复量见智桥。"
        }
        Some("mt4_ea_install_access_denied") => {
            "无法写入 MT4 数据目录，请关闭 MT4 后重试，或检查当前 Windows 账户权限。"
        }
        Some("mt4_ea_install_io_failed" | "mt4_ea_install_failed") => {
            "MT4 EA 暂时无法安装，请关闭 MT4 后点击“重新检测”。"
        }
        Some("mt4_registration_invalid") => "MT4 EA 尚未连接或账户信息不完整。",
        Some("mt5_probe_identity_mismatch") => {
            "MT5 账号、Server 或终端与已绑定信息不匹配，请登录正确账号后重试。"
        }
        Some("mt4_ea_identity_mismatch") => {
            "MT4 EA 的账号、Server 或终端与已绑定信息不匹配，请确认账号后重新挂载 EA。"
        }
        Some("mt4_ea_protocol_incompatible") => {
            "当前 MT4 EA 版本与桥接不兼容。请点击“安装 / 修复 EA”，然后在 MT4 中重新加载 EA；其他账户不受影响。"
        }
        Some("mt4_ea_reconnecting") => {
            "MT4 EA 连接短暂中断，程序正在等待 EA 自动重连；无需重新登录或退出桥接。"
        }
        Some("terminal_runtime_identity_mismatch") => {
            "交易终端身份与绑定信息不匹配，桥接已拒绝连接，请确认账号和 Server。"
        }
        Some("terminal_worker_failure_limit") => {
            "交易终端连续恢复失败，已暂停该终端；请确认 MT 正常后点击“重新检测”。"
        }
        Some("mt5_probe_timeout") => "MT5 响应超时，程序会自动重试。",
        Some("mt5_terminal_already_in_use") => {
            "该 MT5 已被另一个桥接档案使用；每个观摩源需要独立的 MT5 安装目录。"
        }
        Some("bridge_not_paired") => "需要先连接量见账号。",
        Some("bridge_server_unreachable") => "暂时无法连接服务器，程序会自动重试。",
        Some("bridge_server_unavailable") => "服务器正在启动或维护，程序会保留授权并自动重试。",
        Some("bridge_server_endpoint_unavailable") => {
            "服务器桥接接口暂不可用，请检查服务器地址或等待服务恢复。"
        }
        Some("bridge_server_protocol_error") => {
            "服务器响应格式异常，程序会自动重试；若持续出现请联系支持。"
        }
        Some("bridge_connection_lost") => "服务器连接中断，程序正在自动恢复。",
        Some("membership_required" | "bridge_membership_required") => {
            "当前账号暂时不能使用桥接；恢复有效会员后程序会自动重连，无需重新授权。"
        }
        Some("bridge_refresh_unavailable") => {
            "服务器暂时不可用，程序会保留账号授权并自动重试。"
        }
        Some("bridge_refresh_revoked") => "当前设备授权已被撤销，需要重新连接量见账号。",
        _ => fallback,
    }
    .to_owned()
}

fn platform_display_name(platform: &str) -> &'static str {
    if platform == "mt4" { "MT4" } else { "MT5" }
}

fn status(title: &str, description: &str, accent: Rgb) -> StatusCopy {
    StatusCopy {
        title: title.to_owned(),
        description: description.to_owned(),
        accent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_local_control::{
        LOCAL_CONTROL_SCHEMA_VERSION, UiObserverProfile, UiTerminalCandidate, UiTerminalStatus,
        UiUpdateNotice,
    };

    fn base_state() -> UiStateSnapshot {
        UiStateSnapshot {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            revision: 1,
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            observed_at_utc_msc: 1_800_000_000_000,
            phase: "online".to_owned(),
            detail_code: None,
            selected_platform: Some("mt5".to_owned()),
            selected_terminal_instance_id: Some("mt5-main".to_owned()),
            terminal_candidates: vec![UiTerminalCandidate {
                terminal_instance_id: "mt5-main".to_owned(),
                platform: "mt5".to_owned(),
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
                display_name: None,
            }],
            terminals: vec![UiTerminalStatus {
                terminal_instance_id: "mt5-main".to_owned(),
                platform: "mt5".to_owned(),
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
                runtime_state: "running".to_owned(),
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
            autostart_enabled: false,
            custom_endpoint_active: false,
        }
    }

    #[test]
    fn ordinary_online_state_matches_the_dotnet_main_window_contract() {
        let state = base_state();
        let view = build_main_window_view(&state, &BTreeSet::new(), |_| "13:19:09".to_owned())
            .expect("main window");
        assert_eq!(view.window_title, "量见智桥");
        assert_eq!(view.heading, "量见智桥");
        assert_eq!(view.subtitle, "连接交易终端与量见 AI交易实验室");
        assert_eq!(view.status.title, "量见智桥运行中");
        assert_eq!(view.status.accent, Rgb(21, 128, 61));
        assert_eq!(
            view.runtime_summary,
            "服务器已连接  ·  最近同步 13:19:09  ·  版本 3.0.0"
        );
        assert_eq!(view.account_count_text, "1 个");
        assert_eq!(view.accounts[0].title, "主账户  ·  MT5 · 123456");
        assert_eq!(view.accounts[0].state, "Broker-Demo · 运行中");
        assert_eq!(
            view.accounts[0]
                .permission
                .as_ref()
                .map(|value| value.summary.as_str()),
            Some("交易权限正常")
        );
        assert!(!view.show_observer_sources);
        assert!(!view.show_settings);
        assert!(!view.show_pair);
        assert!(view.show_logout);
    }

    #[test]
    fn pairing_state_keeps_browser_action_manual_and_offline_settings_recoverable() {
        let mut state = base_state();
        state.phase = "pairing_required".to_owned();
        state.server_connected = false;
        state.selected_platform = Some("mt4".to_owned());
        state.terminals.clear();
        state.terminal_candidates.clear();
        state.selected_terminal_instance_id = None;
        state.last_data_sync_utc_msc = None;
        let view = build_main_window_view(&state, &BTreeSet::new(), |_| unreachable!())
            .expect("pairing window");
        assert_eq!(view.status.title, "需要连接量见账号");
        assert_eq!(
            view.status.description,
            "请手动点击“连接账号”；浏览器授权成功后会长期保持登录。"
        );
        assert!(view.show_pair);
        assert!(!view.show_logout);
        assert!(view.show_settings);
        assert!(view.show_mt4_setup);
        assert_eq!(
            view.empty_accounts_text.as_deref(),
            Some("尚未识别到交易账户")
        );
    }

    #[test]
    fn administrator_observer_rows_keep_binding_actions_permissions_and_order() {
        let mut state = base_state();
        state.is_administrator = true;
        state.can_manage_observer_sources = true;
        state.observer_profiles.push(UiObserverProfile {
            observer_profile_id: "source-1".to_owned(),
            platform: Some("mt4".to_owned()),
            terminal_directory: Some(r"C:\Broker MT4".to_owned()),
            configured: true,
            enabled: false,
            terminal_instance_id: None,
            bridge_user_id: Some(7),
            observer_account_label: Some("一号观摩源".to_owned()),
            trading_account_label: Some("654321 · Broker-Demo".to_owned()),
            runtime_phase: Some("stopped".to_owned()),
            runtime_detail_code: None,
        });
        let view = build_main_window_view(&state, &BTreeSet::new(), |_| "00:00:00".to_owned())
            .expect("administrator window");
        assert!(view.show_observer_sources);
        assert!(view.show_settings);
        assert_eq!(view.accounts.len(), 2);
        assert!(view.accounts[0].title.starts_with("主账户"));
        assert_eq!(view.accounts[1].title, "一号观摩源  ·  MT4");
        assert_eq!(view.accounts[1].primary_action, Some(ObserverAction::Start));
        assert_eq!(
            view.accounts[1].primary_action_text.as_deref(),
            Some("启动")
        );
        assert!(view.accounts[1].settings_visible);
    }

    #[test]
    fn update_and_responsive_rules_match_the_dotnet_form() {
        let banner = describe_update_notice(&UiUpdateNotice {
            version: "3.0.1".to_owned(),
            urgent: true,
            phase: "ready".to_owned(),
            manual_activation_requested: false,
        });
        assert_eq!(banner.title, "紧急修复 3.0.1 已准备好");
        assert_eq!(banner.button_text, "重启更新");
        assert!(banner.button_visible && banner.button_enabled);
        assert_eq!(banner.background, Rgb(255, 251, 235));
        assert_eq!(resolve_account_column_count(0), 1);
        assert_eq!(resolve_account_column_count(407), 1);
        assert_eq!(resolve_account_column_count(808), 2);
    }
}
