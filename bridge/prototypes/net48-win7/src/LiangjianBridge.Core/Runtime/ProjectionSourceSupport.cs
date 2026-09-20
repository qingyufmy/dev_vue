using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.Runtime
{
    internal sealed class ProjectionSourceCursor
    {
        public long WindowStartUtcMsc { get; set; }
        public long WindowEndUtcMsc { get; set; }
        public long NativeTimeUtcMsc { get; set; }
        public string NativeTicket { get; set; }
        public long NativeOffset { get; set; }
    }

    internal static class ProjectionSourceSupport
    {
        public const long HistoryWindowMsc = 30L * 24L * 60L * 60L * 1000L;

        internal static bool ShrinkFreshHistoryWindow(ProjectionSourceCursor cursor)
        {
            long width = cursor.WindowEndUtcMsc - cursor.WindowStartUtcMsc;
            if (width <= 1000 || cursor.NativeTimeUtcMsc != cursor.WindowStartUtcMsc || cursor.NativeTicket != "0") return false;
            cursor.WindowEndUtcMsc = cursor.WindowStartUtcMsc + width / 2;
            return true;
        }

        public static ProjectionSourceCursor DecodeCursor(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return null;
            }
            try
            {
                string padded = value.Replace('-', '+').Replace('_', '/');
                while (padded.Length % 4 != 0)
                {
                    padded += "=";
                }
                string raw = Encoding.UTF8.GetString(Convert.FromBase64String(padded));
                string[] fields = raw.Split('|');
                long start;
                long end;
                long nativeTime;
                long offset;
                if (fields.Length != 6 || fields[0] != "1"
                    || !long.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out start)
                    || !long.TryParse(fields[2], NumberStyles.None, CultureInfo.InvariantCulture, out end)
                    || !long.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out nativeTime)
                    || !IsNumericIdentifier(fields[4])
                    || !long.TryParse(fields[5], NumberStyles.None, CultureInfo.InvariantCulture, out offset)
                    || start < 1 || end <= start || nativeTime < 0 || offset < 0)
                {
                    throw new InvalidDataException("bridge_projection_source_cursor_invalid");
                }
                return new ProjectionSourceCursor
                {
                    WindowStartUtcMsc = start,
                    WindowEndUtcMsc = end,
                    NativeTimeUtcMsc = nativeTime,
                    NativeTicket = fields[4],
                    NativeOffset = offset
                };
            }
            catch (FormatException)
            {
                throw new InvalidDataException("bridge_projection_source_cursor_invalid");
            }
        }

        public static string EncodeCursor(ProjectionSourceCursor cursor)
        {
            if (cursor == null || cursor.WindowStartUtcMsc < 1
                || cursor.WindowEndUtcMsc <= cursor.WindowStartUtcMsc
                || cursor.NativeTimeUtcMsc < 0 || cursor.NativeOffset < 0
                || !IsNumericIdentifier(cursor.NativeTicket ?? "0"))
            {
                throw new InvalidDataException("bridge_projection_source_cursor_invalid");
            }
            string raw = string.Join("|", new[]
            {
                "1",
                cursor.WindowStartUtcMsc.ToString(CultureInfo.InvariantCulture),
                cursor.WindowEndUtcMsc.ToString(CultureInfo.InvariantCulture),
                cursor.NativeTimeUtcMsc.ToString(CultureInfo.InvariantCulture),
                cursor.NativeTicket ?? "0",
                cursor.NativeOffset.ToString(CultureInfo.InvariantCulture)
            });
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(raw))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        public static ProjectionSourceCursor ResolveWindow(
            ProjectionSyncRequest request, long maximumWindowMsc)
        {
            ProjectionSourceCursor cursor = DecodeCursor(request.Cursor);
            if (cursor == null)
            {
                long end = Math.Min(request.RangeEndUtcMsc,
                    checked(request.RangeStartUtcMsc + maximumWindowMsc));
                return new ProjectionSourceCursor
                {
                    WindowStartUtcMsc = request.RangeStartUtcMsc,
                    WindowEndUtcMsc = end,
                    NativeTimeUtcMsc = request.RangeStartUtcMsc,
                    NativeTicket = "0",
                    NativeOffset = 0
                };
            }
            if (cursor.WindowStartUtcMsc < request.RangeStartUtcMsc
                || cursor.WindowEndUtcMsc > request.RangeEndUtcMsc
                || cursor.NativeTimeUtcMsc < cursor.WindowStartUtcMsc
                || cursor.NativeTimeUtcMsc > cursor.WindowEndUtcMsc)
            {
                throw new InvalidDataException("bridge_projection_source_cursor_range_invalid");
            }
            return cursor;
        }

        public static ProjectionSourceCursor NextWindow(
            ProjectionSyncRequest request, long completedWindowEndUtcMsc, long maximumWindowMsc)
        {
            long end = Math.Min(request.RangeEndUtcMsc,
                checked(completedWindowEndUtcMsc + maximumWindowMsc));
            return new ProjectionSourceCursor
            {
                WindowStartUtcMsc = completedWindowEndUtcMsc,
                WindowEndUtcMsc = end,
                NativeTimeUtcMsc = completedWindowEndUtcMsc,
                NativeTicket = "0",
                NativeOffset = 0
            };
        }

        public static long CandleWindowMsc(string timeframe, int limit)
        {
            if (limit < 1)
            {
                throw new InvalidDataException("bridge_projection_limit_invalid");
            }
            long duration;
            switch (timeframe)
            {
                case "M1": duration = 60L * 1000L; break;
                case "M5": duration = 5L * 60L * 1000L; break;
                case "M15": duration = 15L * 60L * 1000L; break;
                case "M30": duration = 30L * 60L * 1000L; break;
                case "H1": duration = 60L * 60L * 1000L; break;
                case "H4": duration = 4L * 60L * 60L * 1000L; break;
                case "D1": duration = 24L * 60L * 60L * 1000L; break;
                case "W1": duration = 7L * 24L * 60L * 60L * 1000L; break;
                case "MN1": duration = 28L * 24L * 60L * 60L * 1000L; break;
                default: throw new InvalidDataException("bridge_projection_timeframe_invalid");
            }
            return checked(duration * limit);
        }

        public static bool IsClosedCandle(string timeframe, long openTimeUtcMsc, long observedAtUtcMsc)
        {
            long closeTime;
            if (timeframe == "MN1")
            {
                DateTimeOffset epoch = new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero);
                closeTime = (long)(epoch.AddMilliseconds(openTimeUtcMsc).AddMonths(1) - epoch).TotalMilliseconds;
            }
            else
            {
                closeTime = checked(openTimeUtcMsc + CandleWindowMsc(timeframe, 1));
            }
            return closeTime <= observedAtUtcMsc;
        }

        public static string SourceRevision(ProjectionSyncRequest request)
        {
            string value = string.Join("|", new[]
            {
                request.Platform, request.TerminalInstanceId, request.BrokerServer, request.Login,
                request.ConnectionEpoch.ToString(CultureInfo.InvariantCulture), request.Resource,
                request.ScopeKey, request.RangeStartUtcMsc.ToString(CultureInfo.InvariantCulture),
                request.RangeEndUtcMsc.ToString(CultureInfo.InvariantCulture)
            });
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] hash = algorithm.ComputeHash(Encoding.UTF8.GetBytes(value));
                StringBuilder text = new StringBuilder(hash.Length * 2);
                foreach (byte item in hash)
                {
                    text.Append(item.ToString("x2", CultureInfo.InvariantCulture));
                }
                return text.ToString();
            }
        }

        public static IList<CandleRecord> MapCandles(
            IDictionary<string, object> root, string expectedSymbol, string expectedTimeframe,
            long rangeStartUtcMsc, long rangeEndUtcMsc, long observedAtUtcMsc, string revision, bool allowOpenCandles = false)
        {
            if (ReadText(root, "symbol", true) != expectedSymbol
                || ReadText(root, "timeframe", true) != expectedTimeframe)
            {
                throw new InvalidDataException("bridge_projection_candle_route_mismatch");
            }
            object[] items = ReadArray(root, root.ContainsKey("items") ? "items" : "rates");
            List<CandleRecord> result = new List<CandleRecord>(items.Length);
            foreach (object value in items)
            {
                IDictionary<string, object> row = RequireObject(value);
                long openTime = ReadLong(row, row.ContainsKey("time_utc_msc") ? "time_utc_msc" : "time_msc");
                if (openTime < rangeStartUtcMsc || openTime >= rangeEndUtcMsc)
                {
                    continue;
                }
                if (!allowOpenCandles && !IsClosedCandle(expectedTimeframe, openTime, observedAtUtcMsc))
                {
                    throw new InvalidDataException("bridge_projection_open_candle_pending");
                }
                double open = ReadDouble(row, "open");
                double high = ReadDouble(row, "high");
                double low = ReadDouble(row, "low");
                double close = ReadDouble(row, "close");
                if (high < Math.Max(open, close) || low > Math.Min(open, close) || high < low)
                {
                    throw new InvalidDataException("bridge_projection_candle_ohlc_invalid");
                }
                result.Add(new CandleRecord
                {
                    Symbol = expectedSymbol,
                    Timeframe = expectedTimeframe,
                    OpenTimeUtcMsc = openTime,
                    Open = open,
                    High = high,
                    Low = low,
                    Close = close,
                    TickVolume = ReadLong(row, "tick_volume"),
                    RealVolume = ReadOptionalLong(row, "real_volume", 0),
                    Spread = ReadDouble(row, "spread"),
                    Closed = IsClosedCandle(expectedTimeframe, openTime, observedAtUtcMsc),
                    SourceRevision = revision,
                    ObservedAtUtcMsc = observedAtUtcMsc,
                    LastAccessedUtcMsc = observedAtUtcMsc
                });
            }
            return result;
        }

        public static IList<HistoryItemRecord> MapHistory(
            object[] items, string itemKind, long rangeStartUtcMsc, long rangeEndUtcMsc,
            long observedAtUtcMsc, string revision)
        {
            JavaScriptSerializer serializer = Serializer();
            List<HistoryItemRecord> result = new List<HistoryItemRecord>(items.Length);
            foreach (object value in items)
            {
                IDictionary<string, object> row = RequireObject(value);
                long eventTime = EventTime(row, itemKind);
                if (eventTime < rangeStartUtcMsc || eventTime >= rangeEndUtcMsc)
                {
                    continue;
                }
                string ticket = Identifier(row, itemKind == "deals" ? "deal_ticket" : "ticket", "ticket");
                string itemId = itemKind == "trades"
                    ? Identifier(row, "close_deal_ticket", "deal_ticket", "ticket")
                    : ticket;
                if (string.IsNullOrEmpty(itemId))
                {
                    throw new InvalidDataException("bridge_projection_history_id_invalid");
                }
                string fundsKind;
                decimal? amount;
                ReadFunds(row, itemKind, out fundsKind, out amount);
                result.Add(new HistoryItemRecord
                {
                    ItemKind = itemKind,
                    ItemId = itemId,
                    EventTimeUtcMsc = eventTime,
                    Ticket = ticket,
                    OrderId = Identifier(row, "order_ticket", "order"),
                    PositionId = Identifier(row, "position_id", "position_ticket"),
                    Symbol = OptionalText(row, "symbol"),
                    FundsKind = fundsKind,
                    Amount = amount,
                    FactJson = serializer.Serialize(row),
                    SourceRevision = revision,
                    ObservedAtUtcMsc = observedAtUtcMsc,
                    LastAccessedUtcMsc = observedAtUtcMsc
                });
            }
            return result;
        }

        public static IDictionary<string, object> DeserializeObject(string json)
        {
            try
            {
                IDictionary<string, object> result = Serializer().DeserializeObject(json) as IDictionary<string, object>;
                if (result == null)
                {
                    throw new InvalidDataException("bridge_projection_json_invalid");
                }
                return result;
            }
            catch (ArgumentException)
            {
                throw new InvalidDataException("bridge_projection_json_invalid");
            }
        }

        public static IDictionary<string, object> ReadObject(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value))
            {
                throw new InvalidDataException("bridge_projection_field_missing");
            }
            return RequireObject(value);
        }

        public static object[] ReadArray(IDictionary<string, object> root, string field)
        {
            object value;
            object[] result;
            if (!root.TryGetValue(field, out value) || (result = value as object[]) == null)
            {
                throw new InvalidDataException("bridge_projection_array_invalid");
            }
            return result;
        }

        public static bool ReadBoolean(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value) || !(value is bool))
            {
                throw new InvalidDataException("bridge_projection_boolean_invalid");
            }
            return (bool)value;
        }

        public static long ReadLong(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value))
            {
                throw new InvalidDataException("bridge_projection_number_invalid");
            }
            return ConvertLong(value);
        }

        private static long EventTime(IDictionary<string, object> row, string itemKind)
        {
            if (itemKind == "trades" && row.ContainsKey("close_time_utc_msc"))
            {
                return ReadLong(row, "close_time_utc_msc");
            }
            return ReadLong(row, row.ContainsKey("time_utc_msc") ? "time_utc_msc" : "time_msc");
        }

        private static void ReadFunds(IDictionary<string, object> row, string itemKind,
            out string fundsKind, out decimal? amount)
        {
            fundsKind = null;
            amount = null;
            if (itemKind != "deals")
            {
                return;
            }
            object rawType;
            if (!row.TryGetValue("type", out rawType) || rawType == null)
            {
                return;
            }
            string typeText = Convert.ToString(rawType, CultureInfo.InvariantCulture).ToLowerInvariant();
            decimal net = ReadOptionalDecimal(row, "profit", 0)
                + ReadOptionalDecimal(row, "commission", 0)
                + ReadOptionalDecimal(row, "swap", 0)
                + ReadOptionalDecimal(row, "fee", 0);
            if (typeText == "2" || typeText == "balance")
            {
                fundsKind = net < 0 ? "withdrawal" : "deposit";
                amount = net;
            }
            else if (typeText == "3" || typeText == "credit")
            {
                fundsKind = "credit";
                amount = net;
            }
        }

        private static IDictionary<string, object> RequireObject(object value)
        {
            IDictionary<string, object> result = value as IDictionary<string, object>;
            if (result == null)
            {
                throw new InvalidDataException("bridge_projection_object_invalid");
            }
            return result;
        }

        private static string ReadText(IDictionary<string, object> root, string field, bool required)
        {
            object value;
            string result;
            if (!root.TryGetValue(field, out value) || value == null)
            {
                if (!required)
                {
                    return null;
                }
                throw new InvalidDataException("bridge_projection_text_invalid");
            }
            result = value as string;
            if (result == null || (required && result.Length == 0) || result.Length > 191)
            {
                throw new InvalidDataException("bridge_projection_text_invalid");
            }
            return result;
        }

        private static string OptionalText(IDictionary<string, object> root, string field)
        {
            string value = ReadText(root, field, false);
            return string.IsNullOrEmpty(value) ? null : value;
        }

        private static string Identifier(IDictionary<string, object> root, params string[] fields)
        {
            foreach (string field in fields)
            {
                object value;
                if (!root.TryGetValue(field, out value) || value == null)
                {
                    continue;
                }
                string text = Convert.ToString(value, CultureInfo.InvariantCulture);
                if (text != "0" && IsNumericIdentifier(text))
                {
                    return text;
                }
            }
            return null;
        }

        private static bool IsNumericIdentifier(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 20)
            {
                return false;
            }
            foreach (char item in value)
            {
                if (item < '0' || item > '9')
                {
                    return false;
                }
            }
            return true;
        }

        private static long ReadOptionalLong(IDictionary<string, object> root, string field, long fallback)
        {
            object value;
            return !root.TryGetValue(field, out value) || value == null ? fallback : ConvertLong(value);
        }

        private static long ConvertLong(object value)
        {
            try
            {
                if (value is bool)
                {
                    throw new InvalidCastException();
                }
                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
            catch (Exception error)
            {
                if (error is FormatException || error is InvalidCastException || error is OverflowException)
                {
                    throw new InvalidDataException("bridge_projection_number_invalid");
                }
                throw;
            }
        }

        private static double ReadDouble(IDictionary<string, object> root, string field)
        {
            object value;
            double result;
            try
            {
                if (!root.TryGetValue(field, out value) || value is bool)
                {
                    throw new InvalidCastException();
                }
                result = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch (Exception error)
            {
                if (error is FormatException || error is InvalidCastException || error is OverflowException)
                {
                    throw new InvalidDataException("bridge_projection_number_invalid");
                }
                throw;
            }
            if (double.IsNaN(result) || double.IsInfinity(result))
            {
                throw new InvalidDataException("bridge_projection_number_invalid");
            }
            return result;
        }

        private static decimal ReadOptionalDecimal(
            IDictionary<string, object> root, string field, decimal fallback)
        {
            object value;
            decimal result;
            if (!root.TryGetValue(field, out value) || value == null)
            {
                return fallback;
            }
            if (value is bool || !decimal.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture),
                NumberStyles.Float, CultureInfo.InvariantCulture, out result))
            {
                throw new InvalidDataException("bridge_projection_decimal_invalid");
            }
            return result;
        }

        private static JavaScriptSerializer Serializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 4 * 1024 * 1024;
            serializer.RecursionLimit = 128;
            return serializer;
        }
    }
}
