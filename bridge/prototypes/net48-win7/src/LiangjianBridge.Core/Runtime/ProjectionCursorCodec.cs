using System;
using System.Globalization;
using System.IO;
using System.Text;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class ProjectionCursorState
    {
        public string SnapshotId { get; set; }
        public CandleCursor CandleCursor { get; set; }
        public HistoryCursor HistoryCursor { get; set; }
    }

    public static class ProjectionCursorCodec
    {
        public static string EncodeCandles(string snapshotId, CandleCursor cursor)
        {
            return cursor == null ? null : Encode("c", snapshotId,
                cursor.OpenTimeUtcMsc.ToString(CultureInfo.InvariantCulture), string.Empty);
        }

        public static string EncodeHistory(string snapshotId, HistoryCursor cursor)
        {
            return cursor == null ? null : Encode("h", snapshotId,
                cursor.EventTimeUtcMsc.ToString(CultureInfo.InvariantCulture), cursor.ItemId);
        }

        public static ProjectionCursorState Decode(string value, bool candles)
        {
            if (string.IsNullOrEmpty(value))
            {
                return new ProjectionCursorState();
            }
            if (value.Length > 2048)
            {
                throw new InvalidDataException("bridge_projection_cursor_invalid");
            }
            string normalized = value.Replace('-', '+').Replace('_', '/');
            while ((normalized.Length & 3) != 0)
            {
                normalized += "=";
            }
            string decoded;
            try
            {
                decoded = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(normalized));
            }
            catch (Exception error)
            {
                if (!(error is FormatException) && !(error is DecoderFallbackException))
                {
                    throw;
                }
                throw new InvalidDataException("bridge_projection_cursor_invalid");
            }
            string[] parts = decoded.Split(new[] { '|' }, 5);
            long time;
            string expectedKind = candles ? "c" : "h";
            if (parts.Length != 5 || parts[0] != "1" || parts[1] != expectedKind
                || string.IsNullOrWhiteSpace(parts[2])
                || !long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out time)
                || time < 1 || (!candles && string.IsNullOrWhiteSpace(parts[4])))
            {
                throw new InvalidDataException("bridge_projection_cursor_invalid");
            }
            return new ProjectionCursorState
            {
                SnapshotId = parts[2],
                CandleCursor = candles ? new CandleCursor(time) : null,
                HistoryCursor = candles ? null : new HistoryCursor(time, parts[4])
            };
        }

        private static string Encode(string kind, string snapshotId, string time, string itemId)
        {
            if (string.IsNullOrWhiteSpace(snapshotId) || snapshotId.IndexOf('|') >= 0
                || (itemId ?? string.Empty).IndexOf('|') >= 0)
            {
                throw new InvalidDataException("bridge_projection_cursor_invalid");
            }
            byte[] bytes = Encoding.UTF8.GetBytes("1|" + kind + "|" + snapshotId + "|" + time + "|" + (itemId ?? string.Empty));
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
    }
}
