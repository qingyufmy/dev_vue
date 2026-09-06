using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class Mt5WorkerQuerySource : ITerminalQuerySource
    {
        private readonly IMt5WorkerRequestHost host;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();

        public Mt5WorkerQuerySource(IMt5WorkerRequestHost hostValue)
        {
            if (hostValue == null) throw new ArgumentNullException("hostValue");
            host = hostValue;
            serializer.MaxJsonLength = Mt5WorkerFrameCodec.MaximumFrameBytes;
            serializer.RecursionLimit = 128;
        }

        public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
        {
            if (runtime == null || request == null || nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_mt5_query_source_invalid");
            }
            ProfileRuntimeConfiguration route = runtime.Configuration;
            TerminalResourceCode resource = TerminalQueryTranslator.ResourceCode(request.Resource);
            try
            {
                QueryPayload result = Fetch(route, request, nowUtcMsc);
                return TerminalQueryResult.FromAdapterSuccess(request.RequestId, resource,
                    result.ObservedAtUtcMsc, result.OffsetMinutes, result.ClockStatus,
                    serializer.Serialize(result.Data), result.NextCursor, result.HasMore);
            }
            catch (Mt5WorkerQueryException error)
            {
                return TerminalQueryResult.FromAdapterError(request.RequestId, resource,
                    error.Code, "MT5 worker could not complete the query.");
            }
        }

        private QueryPayload Fetch(ProfileRuntimeConfiguration route, BridgeQueryRequest request, long nowUtcMsc)
        {
            switch (request.Resource)
            {
                case "terminal.info":
                case "diagnostics.health":
                    return Data(route, "diagnostics", new Dictionary<string, object>(), nowUtcMsc);
                case "terminal.clock":
                    return ClockEvidence(route, nowUtcMsc);
                case "account.snapshot":
                    return Snapshot(route, "account", request.Parameters, nowUtcMsc);
                case "trading.positions":
                    return Snapshot(route, "positions", request.Parameters, nowUtcMsc);
                case "trading.pending_orders":
                    return Snapshot(route, "orders", request.Parameters, nowUtcMsc);
                case "market.symbols":
                    return Symbols(route, request.Parameters, nowUtcMsc);
                case "market.instrument":
                    return Instrument(route, request.Parameters, nowUtcMsc);
                case "market.quote":
                    return Quotes(route, request.Parameters, nowUtcMsc);
                default:
                    throw new Mt5WorkerQueryException("bridge_mt5_query_resource_unsupported");
            }
        }

        private QueryPayload Snapshot(ProfileRuntimeConfiguration route, string stream,
            IDictionary<string, object> parameters, long nowUtcMsc)
        {
            Mt5WorkerResponse response = Request(route, "collect_snapshot", new Dictionary<string, object>
            {
                { "streams", new object[] { stream } }
            });
            IDictionary<string, object> snapshot = Object(response.Payload, "snapshot");
            IDictionary<string, object> streams = Object(snapshot, "streams");
            long observed = Long(snapshot, "source_time_msc", 0);
            if (stream == "account")
            {
                return new QueryPayload(Object(streams, stream), observed, 0, "unavailable", null, false);
            }
            object[] source = Array(streams, stream);
            string symbol = OptionalText(parameters, "symbol");
            List<object> filtered = new List<object>();
            foreach (object item in source)
            {
                IDictionary<string, object> row = item as IDictionary<string, object>;
                if (row == null) throw new Mt5WorkerQueryException("bridge_mt5_worker_snapshot_invalid");
                object rawSymbol;
                if (string.IsNullOrEmpty(symbol)
                    || (row.TryGetValue("symbol", out rawSymbol) && string.Equals(rawSymbol as string, symbol, StringComparison.Ordinal)))
                {
                    filtered.Add(row);
                }
            }
            return Page(filtered, parameters, observed);
        }

        private QueryPayload Symbols(ProfileRuntimeConfiguration route, IDictionary<string, object> parameters,
            long nowUtcMsc)
        {
            QueryPayload payload = Data(route, "symbols", new Dictionary<string, object>(), nowUtcMsc);
            IDictionary<string, object> root = payload.Data as IDictionary<string, object>;
            object[] values = root == null ? null : Array(root, "symbols");
            List<object> items = new List<object>();
            foreach (object value in values)
            {
                IDictionary<string, object> source = value as IDictionary<string, object>;
                if (source == null) throw new Mt5WorkerQueryException("bridge_mt5_worker_symbols_invalid");
                Dictionary<string, object> item = new Dictionary<string, object>(StringComparer.Ordinal);
                object name;
                if (!source.TryGetValue("name", out name)) throw new Mt5WorkerQueryException("bridge_mt5_worker_symbols_invalid");
                item["symbol"] = name;
                object description;
                item["description"] = source.TryGetValue("description", out description) ? description : string.Empty;
                item["selected"] = true;
                item["visible"] = true;
                items.Add(item);
            }
            return Page(items, parameters, payload.ObservedAtUtcMsc);
        }

        private QueryPayload Instrument(ProfileRuntimeConfiguration route, IDictionary<string, object> parameters,
            long nowUtcMsc)
        {
            string symbol = RequiredText(parameters, "symbol");
            QueryPayload payload = Data(route, "symbol_snapshot", new Dictionary<string, object>
            {
                { "symbol", symbol }
            }, nowUtcMsc);
            IDictionary<string, object> root = payload.Data as IDictionary<string, object>;
            return new QueryPayload(Object(root, "instrument"), payload.ObservedAtUtcMsc,
                payload.OffsetMinutes, payload.ClockStatus, null, false);
        }

        private QueryPayload Quotes(ProfileRuntimeConfiguration route, IDictionary<string, object> parameters,
            long nowUtcMsc)
        {
            object[] symbols = Array(parameters, "symbols");
            if (symbols.Length < 1 || symbols.Length > 64) throw new Mt5WorkerQueryException("bridge_mt5_query_symbols_invalid");
            List<object> items = new List<object>(symbols.Length);
            long observed = nowUtcMsc;
            int offset = 0;
            string status = "unavailable";
            foreach (object value in symbols)
            {
                string symbol = value as string;
                if (string.IsNullOrWhiteSpace(symbol)) throw new Mt5WorkerQueryException("bridge_mt5_query_symbols_invalid");
                Mt5WorkerResponse response = Request(route, "quote", new Dictionary<string, object> { { "symbol", symbol } });
                IDictionary<string, object> quote = Object(response.Payload, "quote");
                observed = Math.Max(observed, Long(quote, "observed_at_utc_msc", observed));
                offset = (int)Long(quote, "timezone_offset_minutes", offset);
                object clock;
                if (quote.TryGetValue("clock_status", out clock)) status = NormalizeClockStatus(clock as string);
                Dictionary<string, object> item = new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "symbol", Text(quote, "symbol") }, { "bid", Value(quote, "bid") },
                    { "ask", Value(quote, "ask") }, { "last", Value(quote, "last") },
                    { "volume", null }, { "time_utc_msc", observed }
                };
                items.Add(item);
            }
            return new QueryPayload(new Dictionary<string, object> { { "items", items.ToArray() } },
                observed, offset, status, null, false);
        }

        private QueryPayload ClockEvidence(ProfileRuntimeConfiguration route, long nowUtcMsc)
        {
            QueryPayload response = Data(route, "terminal_clock", new Dictionary<string, object>(), nowUtcMsc);
            IDictionary<string, object> data = response.Data as IDictionary<string, object>;
            if (data == null || Text(data, "clock_status") != "unavailable"
                || Text(data, "source_kind") != "mt5_tick_time_unverified"
                || Value(data, "timezone_offset_minutes") != null || Value(data, "server_time_utc_msc") != null)
                throw new Mt5WorkerQueryException("bridge_mt5_clock_evidence_invalid");
            long sampled = Long(data, "sampled_at_utc_msc", 0);
            long started = Long(data, "sampling_started_at_utc_msc", 0);
            string status = Text(data, "sample_status");
            if (sampled < 1 || sampled > 253402300799999L || started < 1
                || (status != "captured" && status != "unavailable"))
                throw new Mt5WorkerQueryException("bridge_mt5_clock_evidence_invalid");
            if (status == "captured")
            {
                long raw = Long(data, "raw_tick_time_msc", 0);
                string symbol = Text(data, "symbol");
                if (sampled < started || sampled - started > 5000 || raw < 1
                    || raw > 253402300799999L || string.IsNullOrWhiteSpace(symbol) || symbol.Length > 64)
                    throw new Mt5WorkerQueryException("bridge_mt5_clock_evidence_invalid");
            }
            else if (Value(data, "symbol") != null || Value(data, "raw_tick_time_msc") != null)
                throw new Mt5WorkerQueryException("bridge_mt5_clock_evidence_invalid");
            return new QueryPayload(data, sampled, 0, "unavailable", null, false);
        }

        private QueryPayload Data(ProfileRuntimeConfiguration route, string action,
            IDictionary<string, object> parameters, long nowUtcMsc)
        {
            Mt5WorkerResponse response = Request(route, "data", new Dictionary<string, object>
            {
                { "action", action }, { "params", parameters }
            });
            IDictionary<string, object> data = Object(response.Payload, "data");
            if (action == "terminal_clock" && Text(data, "action") != action)
                throw new Mt5WorkerQueryException("bridge_mt5_clock_evidence_invalid");
            long observed = Long(data, "observed_at_utc_msc", nowUtcMsc);
            return new QueryPayload(Value(data, "payload"), observed, 0, "unavailable", null, false);
        }

        private Mt5WorkerResponse Request(ProfileRuntimeConfiguration route, string operation,
            IDictionary<string, object> payload)
        {
            Mt5WorkerResponse response = host.Request(route.TerminalInstanceId, route.BrokerServer,
                route.Login, "live", operation, payload);
            if (response.IsError)
            {
                object code;
                throw new Mt5WorkerQueryException(response.Payload.TryGetValue("error_code", out code)
                    ? Convert.ToString(code, CultureInfo.InvariantCulture) : "bridge_mt5_worker_query_failed");
            }
            return response;
        }

        private static QueryPayload Page(IList<object> source, IDictionary<string, object> parameters, long observed)
        {
            int limit = (int)Long(parameters, "limit", 500);
            int offset = Cursor(parameters);
            if (limit < 1 || limit > 500 || offset < 0) throw new Mt5WorkerQueryException("bridge_mt5_query_page_invalid");
            List<object> items = new List<object>();
            for (int index = offset; index < source.Count && items.Count < limit; index++) items.Add(source[index]);
            bool more = offset + items.Count < source.Count;
            return new QueryPayload(new Dictionary<string, object> { { "items", items.ToArray() } },
                observed, 0, "unavailable", more ? (offset + items.Count).ToString(CultureInfo.InvariantCulture) : null, more);
        }

        private static int Cursor(IDictionary<string, object> parameters)
        {
            object raw;
            if (!parameters.TryGetValue("cursor", out raw) || raw == null || string.IsNullOrEmpty(raw as string)) return 0;
            int result;
            if (!int.TryParse((string)raw, NumberStyles.None, CultureInfo.InvariantCulture, out result))
                throw new Mt5WorkerQueryException("bridge_mt5_query_cursor_invalid");
            return result;
        }

        private static string OptionalText(IDictionary<string, object> values, string key)
        {
            object raw;
            return !values.TryGetValue(key, out raw) || raw == null ? string.Empty : raw as string ?? string.Empty;
        }

        private static string RequiredText(IDictionary<string, object> values, string key)
        {
            string result = OptionalText(values, key);
            if (string.IsNullOrWhiteSpace(result)) throw new Mt5WorkerQueryException("bridge_mt5_query_text_invalid");
            return result;
        }

        private static IDictionary<string, object> Object(IDictionary<string, object> values, string key)
        {
            object raw;
            IDictionary<string, object> result;
            if (values == null || !values.TryGetValue(key, out raw)
                || (result = raw as IDictionary<string, object>) == null)
                throw new Mt5WorkerQueryException("bridge_mt5_worker_payload_invalid");
            return result;
        }

        private static object[] Array(IDictionary<string, object> values, string key)
        {
            object raw;
            object[] result;
            if (values == null || !values.TryGetValue(key, out raw) || (result = raw as object[]) == null)
                throw new Mt5WorkerQueryException("bridge_mt5_worker_payload_invalid");
            return result;
        }

        private static object Value(IDictionary<string, object> values, string key)
        {
            object raw;
            if (values == null || !values.TryGetValue(key, out raw))
                throw new Mt5WorkerQueryException("bridge_mt5_worker_payload_invalid");
            return raw;
        }

        private static string Text(IDictionary<string, object> values, string key)
        {
            string result = Value(values, key) as string;
            if (result == null) throw new Mt5WorkerQueryException("bridge_mt5_worker_payload_invalid");
            return result;
        }

        private static long Long(IDictionary<string, object> values, string key, long fallback)
        {
            object raw;
            if (values == null || !values.TryGetValue(key, out raw) || raw == null) return fallback;
            if (raw is int) return (int)raw;
            if (raw is long) return (long)raw;
            throw new Mt5WorkerQueryException("bridge_mt5_worker_payload_invalid");
        }

        private static string NormalizeClockStatus(string value)
        {
            if (value == "verified") return "calibrated";
            if (value == "persisted_stale") return "stale";
            return value == "calibrated" || value == "observer_bootstrap" || value == "stale" ? value : "unavailable";
        }

        private sealed class QueryPayload
        {
            public QueryPayload(object data, long observed, int offset, string status, string cursor, bool more)
            {
                Data = data; ObservedAtUtcMsc = observed; OffsetMinutes = offset;
                ClockStatus = status; NextCursor = cursor; HasMore = more;
            }
            public object Data { get; private set; }
            public long ObservedAtUtcMsc { get; private set; }
            public int OffsetMinutes { get; private set; }
            public string ClockStatus { get; private set; }
            public string NextCursor { get; private set; }
            public bool HasMore { get; private set; }
        }

        private sealed class Mt5WorkerQueryException : Exception
        {
            public Mt5WorkerQueryException(string code) : base(code) { Code = code; }
            public string Code { get; private set; }
        }
    }
}
