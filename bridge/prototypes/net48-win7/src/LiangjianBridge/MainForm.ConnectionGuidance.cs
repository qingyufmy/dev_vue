using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.App
{
    internal sealed partial class MainForm
    {
        private static string ConnectionGuidance(BridgeProfileSettings profile, BridgeProfileConnectionSnapshot state, string error)
        {
            if (state.State == "capacity_wait")
                return "连接额度已满，已暂停重连。其他连接断开或额度增加后，将自动继续连接。";
            if (error == "bridge_terminal_authorization_invalid")
                return "该终端档案的授权已失效。请在当前账号下重新添加终端；旧档案需先移除，本地账本与服务端历史会保留。";
            if (state.TerminalState != "connected")
                return profile.Platform == "mt4"
                    ? "尚未连接 MT4 适配器。请确认 MT4 正在运行，并在一张图表上加载量见智桥 EA；桥接重启后会自动恢复连接。"
                    : "尚未连接 MT5。请启动对应终端并登录账户，再右键选择连接；无法识别时可在编辑窗口指定终端路径。";
            if (!string.IsNullOrEmpty(error))
            {
                if (error.Contains("quota") || error.Contains("limit")) return "终端已在线，但服务器连接额度不足。请检查右上角额度，或断开其他占用连接。";
                if (error.Contains("token") || error.Contains("unauthorized") || error.Contains("credential"))
                    return "终端已在线，但账号授权需要检查。请查看账号状态；详细原因可在诊断详情中复制。";
                if (error.Contains("mismatch")) return "终端账号与档案不一致。请核对交易账号和券商服务器，再编辑对应终端档案。";
                return "终端已在线，服务器连接暂未恢复。请检查网络和账号状态；若持续异常，可打开诊断详情。";
            }
            if (state.TradePermission == "restricted") return "终端存在未开启的交易开关。将鼠标移到状态列，查看具体需要开启的项目。";
            if (state.TradePermission == "unknown") return "正在等待终端权限信息。将鼠标移到状态列，可查看哪些项目尚未读取。";
            return state.State == "active" ? "终端与服务器已连接，交易开关均已开启。" : "终端已在线，交易开关均已开启。可右键管理服务器连接。";
        }
    }
}
