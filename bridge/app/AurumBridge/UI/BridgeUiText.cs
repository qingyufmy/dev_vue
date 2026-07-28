using AurumBridge.Runtime;

namespace AurumBridge.UI;

public sealed record BridgeUiStateText(string Title, string Description, Color AccentColor);

public static class BridgeUiText
{
    public static BridgeUiStateText ForStatus(BridgeApplicationStatus status)
    {
        ArgumentNullException.ThrowIfNull(status);
        return status.Phase switch
        {
            BridgeApplicationPhase.Starting => State("正在启动", "正在准备安全连接。", 0x64748B),
            BridgeApplicationPhase.PlatformSelectionRequired => State(
                "请选择交易平台", "选择 MT5 或 MT4 后，桥接会自动检测对应终端。", 0xD97706),
            BridgeApplicationPhase.TerminalSelectionRequired when
                status.SelectedPlatform == BridgePlatform.Mt4 => State(
                    "请选择 MT4 终端",
                    "检测到多个 MT4，请选择需要安装 EA 并连接的终端。",
                    0xD97706),
            BridgeApplicationPhase.TerminalSelectionRequired => State(
                "请选择 MT5 账户", "检测到多个已登录 MT5，请选择需要桥接的账户。", 0xD97706),
            BridgeApplicationPhase.DetectingTerminal => State(
                $"正在检测 {PlatformName(status)}",
                $"请保持 {PlatformName(status)} 已打开并登录交易账户。",
                0x2563EB),
            BridgeApplicationPhase.TerminalNotFound => State(
                $"等待 {PlatformName(status)}",
                DescribeCode(status.DetailCode, $"未发现可用的已登录 {PlatformName(status)}，程序会自动重试。"),
                0xD97706),
            BridgeApplicationPhase.PairingRequired => State(
                "需要连接量见账号",
                "请手动点击“连接账号”；浏览器授权成功后会长期保持登录。",
                0x7C3AED),
            BridgeApplicationPhase.Connecting => State(
                "正在连接服务器",
                DescribeCode(status.DetailCode, "本地终端已就绪，正在建立安全连接。"),
                0x2563EB),
            BridgeApplicationPhase.Online => State(
                "量见智桥运行中",
                "账户数据与交易指令通道均已连接。",
                0x15803D),
            BridgeApplicationPhase.Degraded when status.DetailCode == "mt4_ea_reconnecting" => State(
                "正在恢复 MT4 连接",
                DescribeCode(status.DetailCode, "MT4 EA 连接短暂中断，程序正在自动恢复。"),
                0xD97706),
            BridgeApplicationPhase.Degraded => State(
                "部分连接异常",
                DescribeCode(status.DetailCode, "程序正在自动恢复，不影响 MT 中已有订单。"),
                0xDC2626),
            _ => State("桥接已停止", "停止桥接不会撤单、平仓或关闭 MT。", 0x64748B),
        };
    }

    public static string DescribeError(Exception error) => error switch
    {
        FileNotFoundException fileError when fileError.Message == "mt5_python_runtime_not_found" =>
            $"未找到 MT5 Python 运行组件，请重新安装或修复{BridgeBrand.ProductName}。",
        FileNotFoundException fileError when fileError.Message == "mt5_worker_script_not_found" =>
            $"未找到 MT5 桥接模块，请重新安装或修复{BridgeBrand.ProductName}。",
        FileNotFoundException fileError when fileError.Message == "mt4_ea_package_not_found" =>
            $"未找到 MT4 EA，请重新安装或修复{BridgeBrand.ProductName}。",
        BridgeApiException apiError => DescribeCode(apiError.Code, "服务器暂时无法完成请求，请稍后重试。"),
        _ => $"{BridgeBrand.ProductName}启动失败，请重新启动；若问题持续，请联系支持。",
    };

    public static string DescribeTerminalState(BridgeTerminalStatus terminal) => terminal.RuntimeState switch
    {
        TerminalRuntimeState.Running => "运行中",
        TerminalRuntimeState.Restarting => "自动恢复中",
        TerminalRuntimeState.Stopped when terminal.ErrorCode == "terminal_worker_failure_limit" =>
            "已暂停，请重新检测",
        TerminalRuntimeState.Stopped => "已停止",
        _ => "连接中",
    };

    public static string DescribeRuntimeSummary(BridgeApplicationStatus status)
    {
        ArgumentNullException.ThrowIfNull(status);
        var server = status.ServerConnected ? "服务器已连接" : "服务器未连接";
        var synchronization = status.LastDataSyncUtcMsc is long synchronizedAt
            ? $"最近同步 {DateTimeOffset.FromUnixTimeMilliseconds(synchronizedAt).ToLocalTime():HH:mm:ss}"
            : "等待首次同步";
        return $"{server}  ·  {synchronization}  ·  版本 {status.BridgeVersion}";
    }

    public static string Mt4ExpertSetupInstructions =>
        "接下来请在 MT4 中完成：\n\n"
        + "1. 打开“导航器 → 智能交易系统”，右键刷新。\n"
        + "2. 将 AURUMBridgeEA 拖到任意一个保持打开的图表。\n"
        + "3. 在 EA 属性的“常用”页勾选“允许实时自动交易”。\n"
        + "4. 确认 MT4 顶部“自动交易”按钮已开启。\n\n"
        + "无需开启 DLL 导入或 WebRequest。";

    public static string DescribeCode(string? code, string fallback) => code switch
    {
        "mt5_terminal_not_found" => "未发现 MT5，请先打开并登录 MT5。",
        "mt5_account_unavailable" => "已发现 MT5，但尚未登录交易账户。",
        "mt5_terminal_disconnected" => "MT5 当前未连接交易服务器。",
        "trading_terminal_not_found" => "未发现 MT5，也未收到 MT4 EA 连接；程序会自动重试。",
        "mt4_terminal_not_found" => "未发现 MT4，请先打开一次 MT4，程序会自动安装 EA。",
        "mt4_platform_not_selected" => "请先将交易平台切换为 MT4。",
        "mt4_terminal_selection_required" => "检测到多个 MT4，请先选择需要安装 EA 的终端。",
        "mt4_terminal_data_path_not_found" => "一个已绑定的 MT4 已不存在，请重新挂载 EA。",
        "mt4_ea_attach_required" =>
            "EA 已安装。请在 MT4 的导航器中刷新，然后将 AURUMBridgeEA 挂到任意图表一次。",
        "mt4_ea_package_not_found" or "mt4_ea_package_invalid" =>
            $"MT4 EA 组件不完整，请重新安装或修复{BridgeBrand.ProductName}。",
        "mt4_ea_install_access_denied" =>
            "无法写入 MT4 数据目录，请关闭 MT4 后重试，或检查当前 Windows 账户权限。",
        "mt4_ea_install_io_failed" or "mt4_ea_install_failed" =>
            "MT4 EA 暂时无法安装，请关闭 MT4 后点击“重新检测”。",
        "mt4_registration_invalid" => "MT4 EA 尚未连接或账户信息不完整。",
        "mt5_probe_identity_mismatch" => "MT5 账号、Server 或终端与已绑定信息不匹配，请登录正确账号后重试。",
        "mt4_ea_identity_mismatch" => "MT4 EA 的账号、Server 或终端与已绑定信息不匹配，请确认账号后重新挂载 EA。",
        "mt4_ea_protocol_incompatible" =>
            "当前 MT4 EA 版本与桥接不兼容。请点击“安装 / 修复 EA”，然后在 MT4 中重新加载 EA；其他账户不受影响。",
        "mt4_ea_reconnecting" =>
            "MT4 EA 连接短暂中断，程序正在等待 EA 自动重连；无需重新登录或退出桥接。",
        "terminal_runtime_identity_mismatch" => "交易终端身份与绑定信息不匹配，桥接已拒绝连接，请确认账号和 Server。",
        "terminal_worker_failure_limit" => "交易终端连续恢复失败，已暂停该终端；请确认 MT 正常后点击“重新检测”。",
            "mt5_probe_timeout" => "MT5 响应超时，程序会自动重试。",
            "mt5_terminal_already_in_use" => "该 MT5 已被另一个桥接档案使用；每个观摩源需要独立的 MT5 安装目录。",
        "bridge_not_paired" => "需要先连接量见账号。",
        "bridge_server_unreachable" => "暂时无法连接服务器，程序会自动重试。",
        "bridge_server_unavailable" => "服务器正在启动或维护，程序会保留授权并自动重试。",
        "bridge_server_endpoint_unavailable" => "服务器桥接接口暂不可用，请检查服务器地址或等待服务恢复。",
        "bridge_server_protocol_error" => "服务器响应格式异常，程序会自动重试；若持续出现请联系支持。",
        "bridge_connection_lost" => "服务器连接中断，程序正在自动恢复。",
        "membership_required" or "bridge_membership_required" =>
            "当前账号暂时不能使用桥接；恢复有效会员后程序会自动重连，无需重新授权。",
        "bridge_refresh_unavailable" =>
            "服务器暂时不可用，程序会保留账号授权并自动重试。",
        "bridge_refresh_revoked" =>
            "当前设备授权已被撤销，需要重新连接量见账号。",
        _ => fallback,
    };

    private static BridgeUiStateText State(string title, string description, int rgb) =>
        new(title, description, Color.FromArgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF));

    private static string PlatformName(BridgeApplicationStatus status) =>
        status.SelectedPlatform is null ? "交易终端" : BridgePlatform.DisplayName(status.SelectedPlatform);
}
