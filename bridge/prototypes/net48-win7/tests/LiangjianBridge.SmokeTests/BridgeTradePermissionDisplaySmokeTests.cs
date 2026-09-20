using System;
using System.Collections.Generic;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class BridgeTradePermissionDisplaySmokeTests
    {
        public static void RunAll()
        {
            const long now = 1788307200000;
            int tick = int.MaxValue - 100;
            BridgeTradePermissionDisplay mt4 = new BridgeTradePermissionDisplay("mt4", delegate { return now; }, delegate { return tick; });
            Dictionary<string, object> data = new Dictionary<string, object>();
            Check(mt4, true, "unknown");
            mt4.Observe(data, now); Check(mt4, true, "unknown");
            data["trade_allowed"] = true;
            mt4.Observe(data, now); Check(mt4, true, "unknown");
            data["terminal_trade_allowed"] = true;
            data["ea_trade_allowed"] = true;
            data["trade_expert"] = true;
            mt4.Observe(data, now); Check(mt4, true, "allowed"); Check(mt4, false, "unknown");
            foreach (string key in new[] { "terminal_trade_allowed", "ea_trade_allowed", "trade_expert", "trade_allowed" })
            {
                data[key] = false;
                mt4.Observe(data, now); Check(mt4, true, "restricted");
                data[key] = true;
            }
            mt4.Observe(data, now);
            data["trade_allowed"] = false;
            Check(mt4, true, "allowed"); // Caller mutation cannot change a captured observation.
            mt4.Observe(data, now); Check(mt4, true, "restricted");
            data["trade_allowed"] = "true";
            mt4.Observe(data, now); Check(mt4, true, "unknown");
            data["trade_allowed"] = true;
            mt4.Observe(data, now - 24000); Check(mt4, true, "allowed");
            tick = unchecked(tick + 1000); Check(mt4, true, "unknown");
            mt4.Observe(data, now - 25000); Check(mt4, true, "unknown");
            mt4.Observe(data, now + 1001); Check(mt4, true, "unknown");
            mt4.Observe(data, now); mt4.Clear(); Check(mt4, true, "unknown");
            BridgeTradePermissionDisplay mt5 = new BridgeTradePermissionDisplay("mt5", delegate { return now; }, delegate { return tick; });
            data["trade_expert"] = true; data["terminal_trade_allowed"] = true;
            mt5.Observe(data, now); Check(mt5, true, "unknown");
            data["terminal_tradeapi_disabled"] = false;
            mt5.Observe(data, now); Check(mt5, true, "allowed");
            Check(mt4, true, "unknown"); // Each connection has independent state.
            foreach (string key in new[] { "trade_allowed", "trade_expert", "terminal_trade_allowed", "terminal_tradeapi_disabled" })
            {
                data[key] = key == "terminal_tradeapi_disabled";
                mt5.Observe(data, now); Check(mt5, true, "restricted");
                data[key] = key != "terminal_tradeapi_disabled";
            }
            data.Remove("terminal_tradeapi_disabled"); data["trade_allowed"] = false;
            mt5.Observe(data, now); Check(mt5, true, "restricted");
            tick = unchecked(tick + 25000); Check(mt5, true, "unknown");
        }

        private static void Check(BridgeTradePermissionDisplay display, bool connected, string expected)
        {
            string permission, details;
            display.Read(connected, out permission, out details);
            if (permission != expected || string.IsNullOrWhiteSpace(details))
                throw new Exception("trade_permission_display_" + expected);
        }
    }
}
