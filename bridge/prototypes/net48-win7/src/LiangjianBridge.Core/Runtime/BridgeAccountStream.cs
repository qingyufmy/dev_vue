using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Runtime
{
    // Reuses exact-account identity observations; no additional terminal I/O on the heartbeat thread.
    public sealed class BridgeAccountStream
    {
        private readonly object gate = new object();
        private readonly ProfileRuntime runtime;
        private readonly string platform;
        private IDictionary<string, object> latest;
        private long observed, sent, epoch;
        public BridgeAccountStream(ProfileRuntime value) { runtime = value; platform = value.Configuration.Platform; }
        public void Observe(IDictionary<string, object> data, long at)
        {
            var item = new Dictionary<string, object> {
                { "balance", Money(data, "balance") }, { "equity", Money(data, "equity") },
                { "margin", Money(data, "margin") }, { "free_margin", Money(data, platform == "mt5" ? "margin_free" : "free_margin") },
                { "floating_profit", Money(data, "profit") }, { "currency", data["currency"] },
                { "leverage", data.ContainsKey("leverage") ? data["leverage"] : null },
                { "trade_permission", True(data, "trade_allowed") && (platform != "mt5" ||
                    (True(data, "trade_expert") && True(data, "terminal_trade_allowed") && data.ContainsKey("terminal_tradeapi_disabled") && data["terminal_tradeapi_disabled"] is bool && !(bool)data["terminal_tradeapi_disabled"])) }
            };
            object clockSample;
            if (platform == "mt5" && data.TryGetValue("clock_sample", out clockSample)
                && clockSample is IDictionary<string, object>) item["clock_sample"] = clockSample;
            lock (gate) { latest = item; observed = at; }
        }
        public string Create(long now)
        {
            lock (gate)
            {
                if (latest == null || now - observed > 25000 || observed > now + 5000) return null;
                if (epoch == runtime.ConnectionEpoch && sent == observed) return null;
                var route = runtime.Configuration;
                string result = new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "v", 4 }, { "message_id", "account-" + Guid.NewGuid().ToString("N") }, { "type", "stream.event" },
                    { "sent_at_utc_msc", now }, { "correlation_id", null },
                    { "route", new Dictionary<string, object> {
                        { "terminal_instance_id", route.TerminalInstanceId }, { "connection_epoch", runtime.ConnectionEpoch },
                        { "account_ref", new Dictionary<string, object> { { "broker_server", route.BrokerServer }, { "login", route.Login } } } } },
                    { "payload", new Dictionary<string, object> {
                        { "subscription_id", "account-snapshot" }, { "stream", "account" }, { "revision", observed },
                        { "base_revision", 0 }, { "full_snapshot", true }, { "observed_at_utc_msc", observed },
                        { "source_time_msc", null }, { "upserts", new object[] { latest } }, { "deletes", new string[0] } } }
                });
                epoch = runtime.ConnectionEpoch; sent = observed;
                return result;
            }
        }
        private static bool True(IDictionary<string, object> data, string key)
        { object value; return data.TryGetValue(key, out value) && value is bool && (bool)value; }
        private static string Money(IDictionary<string, object> data, string key)
        {
            object value;
            if (!data.TryGetValue(key, out value) || value == null || value is bool) throw new InvalidDataException("bridge_account_metric_invalid");
            string text = value is double ? ((double)value).ToString("R", CultureInfo.InvariantCulture) : Convert.ToString(value, CultureInfo.InvariantCulture);
            decimal amount;
            if (!decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out amount)) throw new InvalidDataException("bridge_account_metric_invalid");
            return amount.ToString("0.########", CultureInfo.InvariantCulture);
        }
    }
}
