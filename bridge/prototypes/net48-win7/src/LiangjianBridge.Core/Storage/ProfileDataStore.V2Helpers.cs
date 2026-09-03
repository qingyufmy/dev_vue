using System;
using System.Data.SQLite;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Storage
{
    public sealed partial class ProfileDataStore
    {
        private static void RequireOptionalText(string value, string error, int maxLength)
        {
            if (value != null && (string.IsNullOrWhiteSpace(value) || value.Length > maxLength))
            {
                throw new InvalidDataException(error);
            }
        }

        private static void RequireOptionalTime(long? value, string error)
        {
            if (value.HasValue && value.Value < 1)
            {
                throw new InvalidDataException(error);
            }
        }

        private static void RequireDecimal(decimal? value, string error)
        {
            if (value.HasValue && (value.Value < decimal.MinValue || value.Value > decimal.MaxValue))
            {
                throw new InvalidDataException(error);
            }
        }

        private static string DecimalText(decimal? value)
        {
            return value.HasValue ? value.Value.ToString("G29", CultureInfo.InvariantCulture) : null;
        }

        private static decimal? DecimalValue(SQLiteDataReader reader, int index)
        {
            string value = ReadNullableString(reader, index);
            decimal parsed;
            return string.IsNullOrEmpty(value) || !decimal.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out parsed)
                ? (decimal?)null
                : parsed;
        }

        private static void ValidateFactJson(string value, string error)
        {
            RequireText(value, error, 1024 * 1024);
        }

        private static void ValidatePriority(int priority, string error)
        {
            if (priority < -100 || priority > 100)
            {
                throw new InvalidDataException(error);
            }
        }

        private static long AddMilliseconds(long start, long delta, string error)
        {
            try
            {
                return checked(start + delta);
            }
            catch (OverflowException)
            {
                throw new InvalidDataException(error);
            }
        }
    }
}
