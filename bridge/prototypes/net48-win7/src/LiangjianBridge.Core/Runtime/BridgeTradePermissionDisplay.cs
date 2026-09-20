using System;
using System.Collections.Generic;

namespace Liangjian.BridgeV4.Runtime
{
    // Display only. Never used to authorize execution or included in hello facts.
    // Each connection owns one instance, fed only after account-route validation.
    public sealed class BridgeTradePermissionDisplay
    {
        public const int MaximumAgeMilliseconds = 25000;
        private readonly object gate = new object();
        private readonly string platform;
        private readonly Func<long> utcNow;
        private readonly Func<int> tickNow;
        private bool observed;
        private int expiresAt;
        private string permission;
        private string details;

        public BridgeTradePermissionDisplay(string platformValue)
            : this(platformValue, delegate { return (long)(DateTime.UtcNow
                - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; },
                delegate { return Environment.TickCount; }) { }

        public BridgeTradePermissionDisplay(string platformValue, Func<long> utcNowValue, Func<int> tickNowValue)
        {
            if ((platformValue != "mt4" && platformValue != "mt5") || utcNowValue == null || tickNowValue == null)
                throw new ArgumentException("bridge_trade_permission_display_configuration_invalid");
            platform = platformValue; utcNow = utcNowValue; tickNow = tickNowValue;
        }

        public void Clear() { lock (gate) observed = false; }

        public void Observe(IDictionary<string, object> data, long observedAtUtcMsc)
        {
            lock (gate)
            {
                observed = false;
                long age = utcNow() - observedAtUtcMsc;
                if (data == null || observedAtUtcMsc < 1 || age < -1000 || age >= MaximumAgeMilliseconds) return;
                bool blocked = false, unknown = false;
                List<string> lines = new List<string>();
                Add(lines, platform.ToUpperInvariant() + " 工具栏“" + (platform == "mt4" ? "自动交易" : "算法交易") + "”",
                    Flag(data, "terminal_trade_allowed"), ref blocked, ref unknown);
                if (platform == "mt4") Add(lines, "桥接 EA“允许实时自动交易”", Flag(data, "ea_trade_allowed"), ref blocked, ref unknown);
                Add(lines, "账户 EA 权限", Flag(data, "trade_expert"), ref blocked, ref unknown);
                Add(lines, "账户交易权限", Flag(data, "trade_allowed"), ref blocked, ref unknown);
                if (platform == "mt5")
                {
                    bool? disabled = Flag(data, "terminal_tradeapi_disabled");
                    Add(lines, "外部 Python 交易接口权限", disabled.HasValue ? (bool?)!disabled.Value : null,
                        ref blocked, ref unknown);
                }
                permission = blocked ? "restricted" : unknown ? "unknown" : "allowed";
                lines.Add(blocked ? "请开启上方标为“未开启”的项目。" : unknown ? "部分权限未能读取，暂不能确认全部开启。" : "交易所需开关均已开启。");
                details = string.Join("\r\n", lines.ToArray());
                expiresAt = unchecked(tickNow() + MaximumAgeMilliseconds - (int)Math.Max(0, age));
                observed = true;
            }
        }

        public void Read(bool connected, out string tradePermission, out string tradePermissionDetails)
        {
            lock (gate)
            {
                tradePermission = "unknown";
                if (!connected) tradePermissionDetails = "交易权限未知：连接尚未就绪或已断开。";
                else if (!observed) tradePermissionDetails = "交易权限未知：尚未取得当前账户的权限快照。";
                else if (unchecked(tickNow() - expiresAt) >= 0)
                    tradePermissionDetails = "交易权限未知：权限快照已过期，等待重新读取。";
                else { tradePermission = permission; tradePermissionDetails = details; }
            }
        }

        private static bool? Flag(IDictionary<string, object> data, string name)
        {
            object value;
            return data.TryGetValue(name, out value) && value is bool ? (bool?)value : null;
        }

        private static void Add(List<string> lines, string label, bool? allowed, ref bool blocked, ref bool unknown)
        {
            if (!allowed.HasValue) unknown = true;
            else if (!allowed.Value) blocked = true;
            lines.Add(label + "：" + (!allowed.HasValue ? "未能读取" : allowed.Value ? "已开启" : "未开启"));
        }
    }
}
