using System;
using System.Collections.Generic;
using System.Globalization;

namespace Liangjian.BridgeV4.Runtime
{
    // V3 quote classifier, evaluated by the bridge that owns the terminal.
    public static class BridgeMarketState
    {
        public static IDictionary<string, object> Classify(int? mode, long? tickUtcMsc, long nowUtcMsc, bool connected)
        {
            string state = "unknown", reason = "quote_unavailable";
            if (!connected) reason = "terminal_disconnected";
            else if (mode == 0) { state = "closed"; reason = "symbol_trade_disabled"; }
            else if (mode >= 1 && mode <= 3) { state = "restricted"; reason = "symbol_trade_restricted"; }
            else if (tickUtcMsc.HasValue && tickUtcMsc.Value > 0 && tickUtcMsc.Value <= nowUtcMsc + 15000)
            {
                if (nowUtcMsc - tickUtcMsc.Value > 120000)
                {
                    DayOfWeek day = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(nowUtcMsc).DayOfWeek;
                    bool weekend = day == DayOfWeek.Saturday || day == DayOfWeek.Sunday;
                    state = weekend ? "closed" : "stale";
                    reason = weekend ? "weekend_tick_stale" : "tick_stale";
                }
                else if (mode == 4) { state = "open"; reason = "quote_fresh"; }
                else reason = "trade_mode_unavailable";
            }
            return new Dictionary<string, object> { { "state", state }, { "reason", reason }, { "checked_at_utc_msc", nowUtcMsc } };
        }

        public static int? Mode(IDictionary<string, object> instrument)
        {
            object raw; int value;
            return instrument.TryGetValue("trade_mode", out raw) && Int32.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out value)
                && value >= 0 && value <= 4 ? (int?)value : null;
        }
    }
}
