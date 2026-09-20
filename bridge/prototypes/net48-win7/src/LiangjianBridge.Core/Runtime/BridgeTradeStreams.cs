using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;
namespace Liangjian.BridgeV4.Runtime
{
    // A bounded, read-only full collection. Partial pages never replace a full projection.
    public sealed class BridgeTradeStreams
    {
        private readonly ProfileRuntime runtime;
        private readonly ITerminalQuerySource terminal;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        public BridgeTradeStreams(ProfileRuntime value, ITerminalQuerySource source) { runtime = value; terminal = source; json.MaxJsonLength = 1024 * 1024; }
        public string[] Read(long now)
        {
            BridgeAccountFacts.Read(runtime, terminal, now);
            string positions = ReadCollection("positions", "trading.positions", now);
            string orders = ReadCollection("pending_orders", "trading.pending_orders", now);
            // A terminal account switch during reads cannot publish the previous account's rows.
            BridgeAccountFacts.Read(runtime, terminal, UtcNow());
            return new[] { positions, orders };
        }
        private string ReadCollection(string stream, string resource, long now)
        {
            string id = "trades-" + Guid.NewGuid().ToString("N");
            var request = new Dictionary<string, object> { { "request_id", id }, { "resource", resource },
                { "params", new Dictionary<string, object> { { "limit", 500 }, { "cursor", null } } }, { "deadline_utc_msc", now + 15000 } };
            var result = terminal.Query(runtime, BridgeQueryRequest.Parse(BridgeEnvelope.Parse(Envelope("query.request", id, now, request))), now);
            if (result == null || !result.Succeeded || result.RequestId != id || result.Resource != TerminalQueryTranslator.ResourceCode(resource)
                || result.HasMore || !String.IsNullOrEmpty(result.NextCursor) || result.ObservedAtUtcMsc < now - 15000 || result.ObservedAtUtcMsc > UtcNow() + 5000)
                throw new InvalidDataException("bridge_trade_stream_snapshot_incomplete");
            var data = json.DeserializeObject(result.DataJson) as IDictionary<string, object>;
            object value;
            if (data == null || !data.TryGetValue("items", out value) || !(value is object[])) throw new InvalidDataException("bridge_trade_stream_items_invalid");
            var items = new List<object>();
            foreach (object raw in (object[])value) items.Add(Normalize(raw as IDictionary<string, object>, runtime.Configuration.Platform, stream == "positions"));
            long observed = result.ObservedAtUtcMsc;
            return Envelope("stream.event", id, UtcNow(), new Dictionary<string, object> {
                { "subscription_id", "terminal-" + stream }, { "stream", stream }, { "revision", observed }, { "base_revision", 0 },
                { "full_snapshot", true }, { "observed_at_utc_msc", observed }, { "source_time_msc", null }, { "upserts", items.ToArray() }, { "deletes", new string[0] } });
        }
        private string Envelope(string type, string id, long at, object payload)
        {
            var config = runtime.Configuration;
            return json.Serialize(new Dictionary<string, object> { { "v", 4 }, { "message_id", id }, { "type", type }, { "sent_at_utc_msc", at }, { "correlation_id", null },
                { "route", new Dictionary<string, object> { { "terminal_instance_id", config.TerminalInstanceId }, { "connection_epoch", runtime.ConnectionEpoch },
                    { "account_ref", new Dictionary<string, object> { { "broker_server", config.BrokerServer }, { "login", config.Login } } } } }, { "payload", payload } });
        }
        public static IDictionary<string, object> Normalize(IDictionary<string, object> row, string platform, bool position)
        {
            if (row == null) throw new InvalidDataException("bridge_trade_stream_item_invalid");
            bool mt5 = platform == "mt5";
            string type = position ? "market" : mt5 ? OrderType(Number(row, "type")) : Text(row, "order_type");
            string direction = mt5 ? (position ? Number(row, "type") == 0 ? "buy" : Number(row, "type") == 1 ? "sell" : "unknown" : type.StartsWith("buy_", StringComparison.Ordinal) ? "buy" : "sell") : Text(row, "side");
            if (direction != "buy" && direction != "sell") throw new InvalidDataException("bridge_trade_stream_direction_invalid");
            var result = new Dictionary<string, object> {
                { "ticket", Text(row, "ticket") }, { "symbol", Text(row, "symbol") }, { "direction", direction }, { "order_type", type }, { "magic", Number(row, "magic") },
                { "volume", Money(row, mt5 ? position ? "volume" : "volume_current" : position ? "volume" : "volume_current", false) },
                { "open_price", Money(row, mt5 ? "price_open" : position ? "open_price" : "price", false) },
                { "stop_limit_price", position || !mt5 ? null : Money(row, "price_stoplimit", true) },
                { "stop_loss", Money(row, mt5 ? "sl" : "stop_loss", true) }, { "take_profit", Money(row, mt5 ? "tp" : "take_profit", true) },
                { "expiration_utc_msc", position ? null : OptionalTime(row, "expiration_time_utc_msc") }
            };
            if (position) {
                result["current_price"] = Money(row, mt5 ? "price_current" : "current_price", false);
                result["profit"] = Money(row, "profit", false);
                result["opened_at_utc_msc"] = Number(row, "open_time_utc_msc");
                if (mt5) result["position_identifier"] = Text(row, "identifier");
            } else result["created_at_utc_msc"] = Number(row, "create_time_utc_msc");
            return result;
        }
        private static object OptionalTime(IDictionary<string, object> row, string key) { object value; return !row.TryGetValue(key, out value) || value == null ? null : (object)Number(row, key); }
        private static string OrderType(long type) { switch(type) { case 2:return "buy_limit"; case 3:return "sell_limit"; case 4:return "buy_stop"; case 5:return "sell_stop"; case 6:return "buy_stop_limit"; case 7:return "sell_stop_limit"; default:throw new InvalidDataException("bridge_trade_stream_type_invalid"); } }
        private static string Text(IDictionary<string, object> row, string key) { object value; if (!row.TryGetValue(key, out value) || value == null || value is bool) throw new InvalidDataException("bridge_trade_stream_field_invalid"); return Convert.ToString(value, CultureInfo.InvariantCulture); }
        private static long Number(IDictionary<string, object> row, string key) { long value; if (!Int64.TryParse(Text(row,key), NumberStyles.None, CultureInfo.InvariantCulture, out value)) throw new InvalidDataException("bridge_trade_stream_integer_invalid"); return value; }
        private static object Money(IDictionary<string, object> row, string key, bool nullable) { object value; if (nullable && row.TryGetValue(key,out value) && value == null) return null; decimal amount; if (!Decimal.TryParse(Text(row,key), NumberStyles.Float, CultureInfo.InvariantCulture,out amount)) throw new InvalidDataException("bridge_trade_stream_decimal_invalid"); return nullable && amount == 0 ? null : (object)amount.ToString("0.########", CultureInfo.InvariantCulture); }
        private static long UtcNow() { return (long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds; }
    }
}
