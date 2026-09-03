using System;
using System.Collections.Generic;
using System.IO;

namespace Liangjian.BridgeV4.Protocol
{
    public sealed class BridgeQueryRequest
    {
        private static readonly HashSet<string> Timeframes = new HashSet<string>(StringComparer.Ordinal)
        {
            "M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"
        };

        private BridgeQueryRequest()
        {
        }

        public string RequestId { get; private set; }
        public string Resource { get; private set; }
        public long DeadlineUtcMsc { get; private set; }
        public IDictionary<string, object> Parameters { get; private set; }
        public bool UsesLocalProjection { get; private set; }

        public static BridgeQueryRequest Parse(BridgeEnvelope envelope)
        {
            if (envelope == null || envelope.MessageType != "query.request")
            {
                throw new InvalidDataException("bridge_query_request_invalid");
            }
            RequireOnly(envelope.Payload, "request_id", "resource", "params", "deadline_utc_msc");
            BridgeQueryRequest request = new BridgeQueryRequest
            {
                RequestId = ReadText(envelope.Payload, "request_id", 191),
                Resource = ReadText(envelope.Payload, "resource", 64),
                DeadlineUtcMsc = ReadLong(envelope.Payload, "deadline_utc_msc"),
                Parameters = ReadObject(envelope.Payload, "params")
            };
            if (!ProtocolCatalog.IsQueryResource(request.Resource) || request.DeadlineUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_query_request_invalid");
            }
            request.ValidateParameters();
            return request;
        }

        private void ValidateParameters()
        {
            switch (Resource)
            {
                case "terminal.info":
                case "terminal.clock":
                case "account.snapshot":
                    RequireOnly(Parameters);
                    return;
                case "market.symbols":
                    RequireOnly(Parameters, "limit", "cursor");
                    ReadInt(Parameters, "limit", 1, 500);
                    ReadOptionalText(Parameters, "cursor", 2048);
                    return;
                case "market.instrument":
                    RequireOnly(Parameters, "symbol");
                    ReadText(Parameters, "symbol", 64);
                    return;
                case "market.quote":
                    RequireOnly(Parameters, "symbols");
                    ReadTextArray(Parameters, "symbols", 64, 64);
                    return;
                case "market.candles":
                    ValidateCandles();
                    return;
                case "trading.positions":
                case "trading.pending_orders":
                    RequireFields(Parameters, new[] { "limit", "cursor" }, "limit", "cursor", "symbol");
                    ReadInt(Parameters, "limit", 1, 500);
                    ReadOptionalText(Parameters, "cursor", 2048);
                    ReadOptionalText(Parameters, "symbol", 64);
                    return;
                case "history.orders":
                case "history.trades":
                case "history.deals":
                    RequireOnly(Parameters, "range_start_utc_msc", "range_end_utc_msc", "limit", "cursor");
                    ValidateRange();
                    ReadInt(Parameters, "limit", 1, 500);
                    ReadOptionalText(Parameters, "cursor", 2048);
                    UsesLocalProjection = true;
                    return;
                case "execution.lookup":
                    ValidateExecutionLookup();
                    return;
                case "diagnostics.health":
                    RequireOnly(Parameters, "level");
                    string level = ReadText(Parameters, "level", 8);
                    if (level != "basic" && level != "full")
                    {
                        throw new InvalidDataException("bridge_query_params_invalid");
                    }
                    return;
                default:
                    throw new InvalidDataException("bridge_query_resource_invalid");
            }
        }

        private void ValidateCandles()
        {
            string symbol = ReadText(Parameters, "symbol", 64);
            string timeframe = ReadText(Parameters, "timeframe", 4);
            if (string.IsNullOrEmpty(symbol) || !Timeframes.Contains(timeframe))
            {
                throw new InvalidDataException("bridge_query_params_invalid");
            }
            if (Parameters.ContainsKey("count"))
            {
                RequireOnly(Parameters, "symbol", "timeframe", "count");
                ReadInt(Parameters, "count", 1, 500);
                return;
            }
            RequireOnly(Parameters, "symbol", "timeframe", "range_start_utc_msc", "range_end_utc_msc", "limit", "cursor");
            ValidateRange();
            ReadInt(Parameters, "limit", 1, 500);
            ReadOptionalText(Parameters, "cursor", 2048);
            UsesLocalProjection = true;
        }

        private void ValidateRange()
        {
            long start = ReadLong(Parameters, "range_start_utc_msc");
            long end = ReadLong(Parameters, "range_end_utc_msc");
            if (start < 1 || end <= start)
            {
                throw new InvalidDataException("bridge_query_range_invalid");
            }
        }

        private void ValidateExecutionLookup()
        {
            if (Parameters.ContainsKey("ticket"))
            {
                RequireOnly(Parameters, "ticket");
                ReadNumericText(Parameters, "ticket", 20);
                return;
            }
            RequireOnly(Parameters, "idempotency_key", "symbol", "magic");
            string key = ReadText(Parameters, "idempotency_key", 191);
            if (key.Length < 16)
            {
                throw new InvalidDataException("bridge_query_params_invalid");
            }
            ReadText(Parameters, "symbol", 64);
            ReadInt(Parameters, "magic", 0, int.MaxValue);
        }

        internal static int ReadInt(IDictionary<string, object> values, string key, int minimum, int maximum)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || !(raw is int) || (int)raw < minimum || (int)raw > maximum)
            {
                throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
            }
            return (int)raw;
        }

        internal static long ReadLong(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw))
            {
                throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
            }
            if (raw is int)
            {
                return (int)raw;
            }
            if (raw is long)
            {
                return (long)raw;
            }
            throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
        }

        internal static string ReadText(IDictionary<string, object> values, string key, int maximumLength)
        {
            object raw;
            string value;
            if (!values.TryGetValue(key, out raw) || (value = raw as string) == null
                || value.Length == 0 || value.Length > maximumLength
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
            }
            return value;
        }

        internal static string ReadOptionalText(IDictionary<string, object> values, string key, int maximumLength)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return null;
            }
            return ReadText(values, key, maximumLength);
        }

        private static IDictionary<string, object> ReadObject(IDictionary<string, object> values, string key)
        {
            object raw;
            IDictionary<string, object> result;
            if (!values.TryGetValue(key, out raw) || (result = raw as IDictionary<string, object>) == null)
            {
                throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
            }
            return result;
        }

        private static void ReadTextArray(IDictionary<string, object> values, string key, int maximumItems, int maximumLength)
        {
            object raw;
            object[] array;
            if (!values.TryGetValue(key, out raw) || (array = raw as object[]) == null || array.Length < 1 || array.Length > maximumItems)
            {
                throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
            }
            HashSet<string> unique = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < array.Length; i++)
            {
                string value = array[i] as string;
                if (string.IsNullOrEmpty(value) || value.Length > maximumLength || !unique.Add(value))
                {
                    throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
                }
            }
        }

        private static void ReadNumericText(IDictionary<string, object> values, string key, int maximumLength)
        {
            string value = ReadText(values, key, maximumLength);
            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    throw new InvalidDataException("bridge_query_param_" + key + "_invalid");
                }
            }
        }

        private static void RequireOnly(IDictionary<string, object> values, params string[] fields)
        {
            RequireFields(values, fields, fields);
        }

        private static void RequireFields(IDictionary<string, object> values, string[] required, params string[] allowed)
        {
            HashSet<string> accepted = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in values.Keys)
            {
                if (!accepted.Contains(key))
                {
                    throw new InvalidDataException("bridge_query_params_unknown_field");
                }
            }
            for (int index = 0; index < required.Length; index++)
            {
                if (!values.ContainsKey(required[index]))
                {
                    throw new InvalidDataException("bridge_query_params_missing_field");
                }
            }
        }
    }
}
