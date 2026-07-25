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
            BridgeApplicationPhase.DetectingTerminal => State("正在检测 MT5", "请保持 MT5 已打开并登录交易账户。", 0x2563EB),
            BridgeApplicationPhase.TerminalNotFound => State(
                "等待 MT5",
                DescribeCode(status.DetailCode, "未发现可用的已登录 MT5，程序会自动重试。"),
                0xD97706),
            BridgeApplicationPhase.PairingRequired => State(
                "需要连接 AURUM 账号",
                "点击“连接账号”，在浏览器中确认本机设备。",
                0x7C3AED),
            BridgeApplicationPhase.Connecting => State(
                "正在连接服务器",
                DescribeCode(status.DetailCode, "本地终端已就绪，正在建立安全连接。"),
                0x2563EB),
            BridgeApplicationPhase.Online => State(
                "桥接运行中",
                "账户数据与交易指令通道均已连接。",
                0x15803D),
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
            "未找到 MT5 Python 运行组件，请重新安装或修复 AURUM Bridge。",
        FileNotFoundException fileError when fileError.Message == "mt5_worker_script_not_found" =>
            "未找到 MT5 桥接模块，请重新安装或修复 AURUM Bridge。",
        BridgeApiException apiError => DescribeCode(apiError.Code, "服务器暂时无法完成请求，请稍后重试。"),
        _ => "AURUM Bridge 启动失败，请重新启动；若问题持续，请联系支持。",
    };

    public static string DescribeCode(string? code, string fallback) => code switch
    {
        "mt5_terminal_not_found" => "未发现 MT5，请先打开并登录 MT5。",
        "mt5_account_unavailable" => "已发现 MT5，但尚未登录交易账户。",
        "mt5_terminal_disconnected" => "MT5 当前未连接交易服务器。",
        "trading_terminal_not_found" => "未发现 MT5，也未收到 MT4 EA 连接；程序会自动重试。",
        "mt4_terminal_data_path_not_found" => "一个已绑定的 MT4 已不存在，请重新挂载 EA。",
        "mt4_registration_invalid" => "MT4 EA 尚未连接或账户信息不完整。",
        "mt5_probe_identity_mismatch" => "MT5 账号、Server 或终端与已绑定信息不匹配，请登录正确账号后重试。",
        "mt4_ea_identity_mismatch" => "MT4 EA 的账号、Server 或终端与已绑定信息不匹配，请确认账号后重新挂载 EA。",
        "terminal_runtime_identity_mismatch" => "交易终端身份与绑定信息不匹配，桥接已拒绝连接，请确认账号和 Server。",
        "mt5_probe_timeout" => "MT5 响应超时，程序会自动重试。",
        "bridge_not_paired" => "需要先连接 AURUM 账号。",
        "bridge_server_unreachable" => "暂时无法连接服务器，程序会自动重试。",
        "bridge_connection_lost" => "服务器连接中断，程序正在自动恢复。",
        "membership_required" => "当前账号需要有效的专业版会员。",
        _ => fallback,
    };

    private static BridgeUiStateText State(string title, string description, int rgb) =>
        new(title, description, Color.FromArgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF));
}
