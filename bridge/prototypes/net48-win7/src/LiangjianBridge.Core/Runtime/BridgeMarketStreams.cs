using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;
namespace Liangjian.BridgeV4.Runtime
{
    // Ephemeral, exact-route market demand. No terminal reads occur on the receive thread.
    public sealed class BridgeMarketStreams
    {
        private sealed class Lease { public string Id, Symbol, Timeframe; public long Expires, Epoch; public Dictionary<string,string> LastRows = new Dictionary<string,string>(); }
        private readonly object gate = new object();
        private readonly Dictionary<string, Lease> leases = new Dictionary<string, Lease>();
        private readonly ProfileRuntime runtime;
        private readonly ITerminalQuerySource terminal;
        private readonly ITerminalProjectionSource projections;
        private long revision;
        public BridgeMarketStreams(ProfileRuntime value, ITerminalQuerySource source, ITerminalProjectionSource candles) { runtime = value; terminal = source; projections = candles; }
        public void Control(BridgeEnvelope envelope, long now)
        {
            runtime.ValidateRoute(envelope.TerminalInstanceId, envelope.BrokerServer, envelope.Login, envelope.ConnectionEpoch);
            var payload = envelope.Payload;
            string id = Text(payload, "subscription_id");
            if (!Regex.IsMatch(id, "^market-[a-f0-9]{32}$")) throw new InvalidDataException("bridge_market_subscription_invalid");
            lock (gate)
            {
                Prune(now);
                if (envelope.MessageType == "stream.unsubscribe") { leases.Remove(id); return; }
                object value;
                if (!payload.TryGetValue("filter", out value) || !(value is IDictionary<string, object>)) throw new InvalidDataException("bridge_market_filter_invalid");
                var filter = (IDictionary<string, object>)value;
                string symbol = Text(filter, "symbol");
                string stream = Text(payload, "stream");
                object timeframe;
                if (!filter.TryGetValue("timeframe", out timeframe)) throw new InvalidDataException("bridge_market_timeframe_invalid");
                string tf = timeframe as string;
                if (!Regex.IsMatch(symbol, "^[A-Za-z0-9._-]{1,64}$") || !(stream == "quotes" && timeframe == null || stream == "current_candle" && tf != null && Regex.IsMatch(tf, "^(M1|M5|M15|M30|H1|H4|D1)$"))) throw new InvalidDataException("bridge_market_scope_invalid");
                long expiry = Integer(filter, "expires_at_utc_msc");
                if (expiry <= now) { leases.Remove(id); return; }
                if (expiry > now + 95000) throw new InvalidDataException("bridge_market_expiry_invalid");
                Lease lease;
                if (leases.TryGetValue(id, out lease)) {
                    if (lease.Symbol != symbol || lease.Timeframe != tf) throw new InvalidDataException("bridge_market_scope_changed");
                    lease.Expires = expiry; return;
                }
                if (leases.Count >= 16) throw new InvalidDataException("bridge_market_subscription_limit");
                leases[id] = new Lease { Id = id, Symbol = symbol, Timeframe = tf, Expires = expiry, Epoch = envelope.ConnectionEpoch };
            }
        }
        // Acks can arrive after cancellation; they never recreate a lease or trigger collection.
        public static bool IsMarketAck(object subscription, object stream) { return subscription is string && Regex.IsMatch((string)subscription, "^market-[a-f0-9]{32}$") && (Equals(stream, "quotes") || Equals(stream, "current_candle")); }
        private void Prune(long now) { foreach (var key in leases.Where(pair => pair.Value.Expires <= now || pair.Value.Epoch != runtime.ConnectionEpoch).Select(pair => pair.Key).ToArray()) leases.Remove(key); }
        public string[] Read(long now) { return ReadFiltered(now, null); }
        public string[] ReadQuotes(long now) { return ReadFiltered(now, true); }
        public string[] ReadCandles(long now) { return ReadFiltered(now, false); }
        private string[] ReadFiltered(long now, bool? quotes)
        {
            Lease[] targets;
            lock (gate) { Prune(now); targets = leases.Values.Where(lease => !quotes.HasValue || (lease.Timeframe == null) == quotes.Value).ToArray(); }
            if (targets.Length == 0) return new string[0];
            var messages = new List<string>();
            Exception failed = null;
            // Stage the whole batch; publish only after the final identity check succeeds.
            // This preserves before/after validation without two extra pipe requests per timeframe.
            var collected = new Dictionary<Lease, List<object>>();
            BridgeAccountFacts.Read(runtime, terminal, UtcNow());
            foreach (Lease lease in targets)
            {
                try
                {
                    collected[lease] = lease.Timeframe == null ? Quote(lease, UtcNow()) : Candles(lease, UtcNow());
                }
                catch (InvalidDataException error) { failed = error; }
                catch (InvalidOperationException error) { failed = error; }
            }
            BridgeAccountFacts.Read(runtime, terminal, UtcNow());
            foreach (Lease lease in targets)
            {
                List<object> rows;
                if (!collected.TryGetValue(lease, out rows)) continue;
                try
                {
                lock (gate)
                {
                    Prune(UtcNow());
                    Lease current;
                    if (!leases.TryGetValue(lease.Id, out current) || !Object.ReferenceEquals(current, lease)) continue;
                    var currentRows = new Dictionary<string,string>();
                    foreach (object row in rows)
                    {
                        var item = (IDictionary<string, object>)row;
                        string key = lease.Timeframe == null ? "quote" : Text(item, "open_time_utc_msc");
                        string fingerprint = new JavaScriptSerializer().Serialize(row), previous;
                        currentRows[key] = fingerprint;
                        if (lease.LastRows.TryGetValue(key, out previous) && previous == fingerprint) continue;
                        long at = UtcNow(); revision = Math.Max(at, revision + 1);
                        messages.Add(Envelope("stream.event", Guid.NewGuid().ToString("N"), at, new Dictionary<string, object> {
                            { "subscription_id", lease.Id }, { "stream", lease.Timeframe == null ? "quotes" : "current_candle" }, { "revision", revision }, { "base_revision", 0 }, { "full_snapshot", true },
                            { "observed_at_utc_msc", at }, { "source_time_msc", null }, { "upserts", new[] { row } }, { "deletes", new string[0] } }));
                    }
                    lease.LastRows = currentRows;
                }
                }
                catch (InvalidDataException error) { failed = error; }
                catch (InvalidOperationException error) { failed = error; }
            }
            // One missing symbol/timeframe cannot starve other valid subscriptions.
            if (messages.Count == 0 && failed != null) throw failed;
            return messages.ToArray();
        }
        private List<object> Quote(Lease lease, long now)
        {
            string id = Guid.NewGuid().ToString("N");
            var request = new Dictionary<string, object> { { "request_id", id }, { "resource", "market.quote" }, { "params", new Dictionary<string, object> { { "symbols", new[] { lease.Symbol } } } }, { "deadline_utc_msc", now + 15000 } };
            var result = terminal.Query(runtime, BridgeQueryRequest.Parse(BridgeEnvelope.Parse(Envelope("query.request", id, now, request))), now);
            if (result == null || !result.Succeeded || result.RequestId != id || result.Resource != TerminalQueryTranslator.ResourceCode("market.quote") || result.ObservedAtUtcMsc < now - 15000) throw new InvalidDataException("bridge_market_quote_unavailable");
            var data = new JavaScriptSerializer().DeserializeObject(result.DataJson) as IDictionary<string, object>;
            object items;
            if (data == null || !data.TryGetValue("items", out items) || !(items is object[]) || ((object[])items).Length != 1) throw new InvalidDataException("bridge_market_quote_invalid");
            var row = ((object[])items)[0] as IDictionary<string, object>;
            if (row == null || Text(row, "symbol") != lease.Symbol) throw new InvalidDataException("bridge_market_symbol_mismatch");
            decimal bid = Amount(row, "bid"), ask = Amount(row, "ask");
            if (bid <= 0 || ask < bid) throw new InvalidDataException("bridge_market_price_invalid");
            object last;
            decimal lastPrice = row.TryGetValue("last", out last) && last != null ? Amount(row, "last") : 0;
            return new List<object> { new Dictionary<string, object> { { "symbol", lease.Symbol }, { "bid", Money(bid) }, { "ask", Money(ask) }, { "last", lastPrice > 0 ? Money(lastPrice) : null }, { "spread", Money(ask - bid) }, { "time_utc_msc", Integer(row, "time_utc_msc") } } };
        }
        private List<object> Candles(Lease lease, long now)
        {
            var c = runtime.Configuration;
            long duration = ProjectionSourceSupport.CandleWindowMsc(lease.Timeframe, 1);
            var batch = projections.Fetch(new ProjectionSyncRequest { ProfileId = c.ProfileId, TerminalInstanceId = c.TerminalInstanceId, Platform = c.Platform, BrokerServer = c.BrokerServer, Login = c.Login, ConnectionEpoch = runtime.ConnectionEpoch,
                Resource = "market.candles", ScopeKey = lease.Symbol + "|" + lease.Timeframe, RangeStartUtcMsc = now - duration * 2, RangeEndUtcMsc = now + 1, Limit = 4, AllowOpenCandles = true });
            if (batch == null || batch.Candles == null || batch.HasMore) throw new InvalidDataException("bridge_market_candles_incomplete");
            var rows = new List<object>();
            foreach (var row in batch.Candles.OrderBy(item => item.OpenTimeUtcMsc))
            {
                if (row.Symbol != lease.Symbol || row.Timeframe != lease.Timeframe || row.ObservedAtUtcMsc < now - 15000 || row.OpenTimeUtcMsc > now) throw new InvalidDataException("bridge_market_candle_invalid");
                rows.Add(new Dictionary<string, object> { { "symbol", row.Symbol }, { "timeframe", row.Timeframe }, { "open_time_utc_msc", row.OpenTimeUtcMsc }, { "open", Money((decimal)row.Open) }, { "high", Money((decimal)row.High) }, { "low", Money((decimal)row.Low) }, { "close", Money((decimal)row.Close) }, { "tick_volume", row.TickVolume.ToString(CultureInfo.InvariantCulture) }, { "closed", row.Closed } });
            }
            return rows;
        }
        private string Envelope(string type, string id, long at, object payload)
        {
            var c = runtime.Configuration;
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "v", 4 }, { "message_id", id }, { "type", type }, { "sent_at_utc_msc", at }, { "correlation_id", null },
                { "route", new Dictionary<string, object> { { "terminal_instance_id", c.TerminalInstanceId }, { "connection_epoch", runtime.ConnectionEpoch }, { "account_ref", new Dictionary<string, object> { { "broker_server", c.BrokerServer }, { "login", c.Login } } } } }, { "payload", payload } });
        }
        private static string Text(IDictionary<string, object> row, string key) { object value; if (!row.TryGetValue(key, out value) || value == null) throw new InvalidDataException("bridge_market_field_invalid"); return Convert.ToString(value, CultureInfo.InvariantCulture); }
        private static long Integer(IDictionary<string, object> row, string key) { long value; if (!Int64.TryParse(Text(row, key), NumberStyles.None, CultureInfo.InvariantCulture, out value) || value < 1) throw new InvalidDataException("bridge_market_integer_invalid"); return value; }
        private static decimal Amount(IDictionary<string, object> row, string key) { decimal value; if (!Decimal.TryParse(Text(row, key), NumberStyles.Float, CultureInfo.InvariantCulture, out value)) throw new InvalidDataException("bridge_market_decimal_invalid"); return value; }
        private static string Money(decimal value) { return value.ToString("0.########", CultureInfo.InvariantCulture); }
        private static long UtcNow() { return (long)(DateTime.UtcNow - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds; }
    }
}
