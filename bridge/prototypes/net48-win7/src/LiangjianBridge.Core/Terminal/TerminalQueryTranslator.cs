using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Terminal
{
    public static class TerminalQueryTranslator
    {
        public static TerminalTranslatedQuery Translate(TerminalRequest request, TerminalReadOnlySession session)
        {
            if (request == null || session == null)
            {
                throw new ArgumentNullException(request == null ? "request" : "session");
            }
            if (request.Type != "query_request"
                || !string.Equals(request.TerminalInstanceId, session.TerminalInstanceId, StringComparison.Ordinal)
                || request.SessionEpoch != session.SessionEpoch
                || !string.Equals(request.BrokerServer, session.Hello.BrokerServer, StringComparison.Ordinal)
                || !string.Equals(request.Login, session.Hello.Login, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_terminal_query_route_mismatch");
            }

            TerminalResourceCode resource = ResourceCode(request.Resource);
            IDictionary<string, object> parameters = request.Parameters;
            byte[] payload;
            switch (resource)
            {
                case TerminalResourceCode.TerminalInfo:
                case TerminalResourceCode.TerminalClock:
                case TerminalResourceCode.AccountSnapshot:
                    RequireOnly(parameters);
                    payload = TerminalQueryPayload.NoParameters(request.RequestId, resource, request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.MarketSymbols:
                    RequireOnly(parameters, "limit", "cursor");
                    payload = TerminalQueryPayload.Symbols(
                        request.RequestId,
                        ReadInt32(parameters, "limit", 1, 500),
                        ReadCursorOffset(parameters, "cursor"),
                        request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.MarketInstrument:
                    RequireOnly(parameters, "symbol");
                    payload = TerminalQueryPayload.Symbol(
                        request.RequestId,
                        resource,
                        ReadString(parameters, "symbol", 64, false),
                        request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.MarketQuote:
                    RequireOnly(parameters, "symbols");
                    payload = TerminalQueryPayload.Quote(
                        request.RequestId,
                        ReadStringArray(parameters, "symbols", 64, 64),
                        request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.MarketCandles:
                    RequireOnly(parameters, "symbol", "timeframe", "count", "range_start_utc_msc", "range_end_utc_msc");
                    payload = TerminalQueryPayload.Candles(
                        request.RequestId,
                        ReadString(parameters, "symbol", 64, false),
                        TimeframeCode(ReadString(parameters, "timeframe", 4, false)),
                        ReadOptionalInt32(parameters, "count", 0, 1, 5000),
                        ReadOptionalInt64(parameters, "range_start_utc_msc", 0),
                        ReadOptionalInt64(parameters, "range_end_utc_msc", 0),
                        request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.TradingPositions:
                case TerminalResourceCode.TradingPendingOrders:
                    RequireOnly(parameters, "limit", "cursor", "symbol");
                    payload = TerminalQueryPayload.TradingCollection(
                        request.RequestId,
                        resource,
                        ReadInt32(parameters, "limit", 1, 500),
                        ReadCursorOffset(parameters, "cursor"),
                        ReadOptionalString(parameters, "symbol", 64),
                        request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.HistoryOrders:
                case TerminalResourceCode.HistoryTrades:
                case TerminalResourceCode.HistoryDeals:
                    RequireOnly(parameters, "range_start_utc_msc", "range_end_utc_msc", "limit", "cursor");
                    payload = TerminalQueryPayload.History(
                        request.RequestId,
                        resource,
                        ReadInt64(parameters, "range_start_utc_msc"),
                        ReadInt64(parameters, "range_end_utc_msc"),
                        ReadInt32(parameters, "limit", 1, 500),
                        ReadCursorLong(parameters, "cursor"),
                        request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.DiagnosticsHealth:
                    RequireOnly(parameters, "level");
                    string level = ReadString(parameters, "level", 8, false);
                    if (level != "basic" && level != "full")
                    {
                        throw new InvalidDataException("bridge_terminal_diagnostics_level_invalid");
                    }
                    payload = TerminalQueryPayload.NoParameters(request.RequestId, resource, request.DeadlineUtcMsc);
                    break;
                case TerminalResourceCode.ExecutionLookup:
                    throw new InvalidDataException("bridge_terminal_execution_lookup_not_enabled");
                default:
                    throw new InvalidDataException("bridge_terminal_query_resource_unsupported");
            }
            return new TerminalTranslatedQuery(request.RequestId, resource, payload);
        }

        public static TerminalResourceCode ResourceCode(string resource)
        {
            switch (resource)
            {
                case "terminal.info": return TerminalResourceCode.TerminalInfo;
                case "terminal.clock": return TerminalResourceCode.TerminalClock;
                case "account.snapshot": return TerminalResourceCode.AccountSnapshot;
                case "market.symbols": return TerminalResourceCode.MarketSymbols;
                case "market.instrument": return TerminalResourceCode.MarketInstrument;
                case "market.quote": return TerminalResourceCode.MarketQuote;
                case "market.candles": return TerminalResourceCode.MarketCandles;
                case "trading.positions": return TerminalResourceCode.TradingPositions;
                case "trading.pending_orders": return TerminalResourceCode.TradingPendingOrders;
                case "history.orders": return TerminalResourceCode.HistoryOrders;
                case "history.trades": return TerminalResourceCode.HistoryTrades;
                case "history.deals": return TerminalResourceCode.HistoryDeals;
                case "execution.lookup": return TerminalResourceCode.ExecutionLookup;
                case "diagnostics.health": return TerminalResourceCode.DiagnosticsHealth;
                default: throw new InvalidDataException("bridge_terminal_query_resource_unsupported");
            }
        }

        private static TerminalTimeframeCode TimeframeCode(string timeframe)
        {
            TerminalTimeframeCode result;
            if (!Enum.TryParse<TerminalTimeframeCode>(timeframe, false, out result)
                || !Enum.IsDefined(typeof(TerminalTimeframeCode), result))
            {
                throw new InvalidDataException("bridge_terminal_timeframe_invalid");
            }
            return result;
        }

        private static void RequireOnly(IDictionary<string, object> values, params string[] allowed)
        {
            HashSet<string> names = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in values.Keys)
            {
                if (!names.Contains(key))
                {
                    throw new InvalidDataException("bridge_terminal_params_unknown_field");
                }
            }
        }

        private static int ReadInt32(IDictionary<string, object> values, string key, int minimum, int maximum)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || !(raw is int))
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            int value = (int)raw;
            if (value < minimum || value > maximum)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return value;
        }

        private static int ReadOptionalInt32(IDictionary<string, object> values, string key, int fallback, int minimum, int maximum)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return fallback;
            }
            return ReadInt32(values, key, minimum, maximum);
        }

        private static long ReadInt64(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw))
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            if (raw is int)
            {
                return (int)raw;
            }
            if (raw is long)
            {
                return (long)raw;
            }
            throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
        }

        private static long ReadOptionalInt64(IDictionary<string, object> values, string key, long fallback)
        {
            object raw;
            return !values.TryGetValue(key, out raw) || raw == null ? fallback : ReadInt64(values, key);
        }

        private static string ReadString(IDictionary<string, object> values, string key, int maximumLength, bool allowEmpty)
        {
            object raw;
            string value;
            if (!values.TryGetValue(key, out raw)
                || (value = raw as string) == null
                || (!allowEmpty && value.Length == 0)
                || value.Length > maximumLength
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return value;
        }

        private static string ReadOptionalString(IDictionary<string, object> values, string key, int maximumLength)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return string.Empty;
            }
            return ReadString(values, key, maximumLength, false);
        }

        private static IList<string> ReadStringArray(IDictionary<string, object> values, string key, int maximumItems, int maximumLength)
        {
            object raw;
            object[] array;
            if (!values.TryGetValue(key, out raw) || (array = raw as object[]) == null || array.Length < 1 || array.Length > maximumItems)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            List<string> result = new List<string>(array.Length);
            foreach (object item in array)
            {
                string value = item as string;
                if (string.IsNullOrEmpty(value) || value.Length > maximumLength)
                {
                    throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
                }
                result.Add(value);
            }
            return result;
        }

        private static int ReadCursorOffset(IDictionary<string, object> values, string key)
        {
            long cursor = ReadCursorLong(values, key);
            if (cursor > int.MaxValue)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return (int)cursor;
        }

        private static long ReadCursorLong(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return 0;
            }
            string text = raw as string;
            long cursor;
            if (string.IsNullOrEmpty(text)
                || !long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out cursor)
                || cursor < 0)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return cursor;
        }
    }

    public sealed class TerminalTranslatedQuery
    {
        internal TerminalTranslatedQuery(string requestId, TerminalResourceCode resource, byte[] payload)
        {
            RequestId = requestId;
            Resource = resource;
            Payload = payload;
        }

        public string RequestId { get; private set; }
        public TerminalResourceCode Resource { get; private set; }
        public byte[] Payload { get; private set; }
    }
}
