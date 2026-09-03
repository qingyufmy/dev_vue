using System;
using System.Data;
using System.Data.SQLite;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Storage
{
    public sealed partial class ProfileDataStore
    {
        public void RecordMaintenanceState(long expectedConnectionEpoch, MaintenanceStateRecord state)
        {
            ValidateMaintenanceState(state, expectedConnectionEpoch);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO maintenance_state (profile_id, last_cleanup_at_utc_msc, last_checkpoint_at_utc_msc, last_disk_check_at_utc_msc, disk_used_bytes, disk_free_bytes, disk_watermark, last_error_code, last_error_at_utc_msc, cleanup_cursor, updated_at_utc_msc) VALUES (@profile_id, @last_cleanup, @last_checkpoint, @last_disk_check, @disk_used, @disk_free, @disk_watermark, @last_error_code, @last_error_at, @cleanup_cursor, @updated_at); UPDATE maintenance_state SET last_cleanup_at_utc_msc = @last_cleanup, last_checkpoint_at_utc_msc = @last_checkpoint, last_disk_check_at_utc_msc = @last_disk_check, disk_used_bytes = @disk_used, disk_free_bytes = @disk_free, disk_watermark = @disk_watermark, last_error_code = @last_error_code, last_error_at_utc_msc = @last_error_at, cleanup_cursor = @cleanup_cursor, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND updated_at_utc_msc <= @updated_at";
                    AddParameter(command, "@profile_id", profileId);
                    AddNullableParameter(command, "@last_cleanup", state.LastCleanupAtUtcMsc);
                    AddNullableParameter(command, "@last_checkpoint", state.LastCheckpointAtUtcMsc);
                    AddNullableParameter(command, "@last_disk_check", state.LastDiskCheckAtUtcMsc);
                    AddNullableParameter(command, "@disk_used", state.DiskUsedBytes);
                    AddNullableParameter(command, "@disk_free", state.DiskFreeBytes);
                    AddNullableParameter(command, "@disk_watermark", state.DiskWatermark);
                    AddNullableParameter(command, "@last_error_code", state.LastErrorCode);
                    AddNullableParameter(command, "@last_error_at", state.LastErrorAtUtcMsc);
                    AddParameter(command, "@cleanup_cursor", state.CleanupCursor);
                    AddParameter(command, "@updated_at", state.UpdatedAtUtcMsc);
                    command.ExecuteNonQuery();
                    transaction.Commit();
                }
            }
        }

        public MaintenanceStateRecord ReadMaintenanceState()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT last_cleanup_at_utc_msc, last_checkpoint_at_utc_msc, last_disk_check_at_utc_msc, disk_used_bytes, disk_free_bytes, disk_watermark, last_error_code, last_error_at_utc_msc, cleanup_cursor, updated_at_utc_msc FROM maintenance_state WHERE profile_id = @profile_id LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        if (!reader.Read())
                        {
                            return null;
                        }
                        return new MaintenanceStateRecord
                        {
                            LastCleanupAtUtcMsc = ReadNullableLong(reader, 0),
                            LastCheckpointAtUtcMsc = ReadNullableLong(reader, 1),
                            LastDiskCheckAtUtcMsc = ReadNullableLong(reader, 2),
                            DiskUsedBytes = ReadNullableLong(reader, 3),
                            DiskFreeBytes = ReadNullableLong(reader, 4),
                            DiskWatermark = ReadNullableString(reader, 5),
                            LastErrorCode = ReadNullableString(reader, 6),
                            LastErrorAtUtcMsc = ReadNullableLong(reader, 7),
                            CleanupCursor = Convert.ToInt32(reader.GetValue(8), CultureInfo.InvariantCulture),
                            UpdatedAtUtcMsc = Convert.ToInt64(reader.GetValue(9), CultureInfo.InvariantCulture)
                        };
                    }
                }
            }
        }

        private static void ValidateMaintenanceState(MaintenanceStateRecord state, long expectedConnectionEpoch)
        {
            if (state == null)
            {
                throw new InvalidDataException("bridge_cache_maintenance_state_invalid");
            }
            RequireEpoch(expectedConnectionEpoch, "bridge_cache_epoch_invalid");
            ValidateOptionalNonNegative(state.DiskUsedBytes, "bridge_cache_disk_value_invalid");
            ValidateOptionalNonNegative(state.DiskFreeBytes, "bridge_cache_disk_value_invalid");
            RequireOptionalTime(state.LastCleanupAtUtcMsc, "bridge_cache_maintenance_time_invalid");
            RequireOptionalTime(state.LastCheckpointAtUtcMsc, "bridge_cache_maintenance_time_invalid");
            RequireOptionalTime(state.LastDiskCheckAtUtcMsc, "bridge_cache_maintenance_time_invalid");
            RequireOptionalTime(state.LastErrorAtUtcMsc, "bridge_cache_maintenance_time_invalid");
            RequireOptionalText(state.DiskWatermark, "bridge_cache_disk_watermark_invalid", 32);
            RequireOptionalText(state.LastErrorCode, "bridge_cache_maintenance_error_invalid", 128);
            if (state.CleanupCursor < 0 || state.CleanupCursor > 6 || state.UpdatedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_maintenance_state_invalid");
            }
        }

        private static void ValidateOptionalNonNegative(long? value, string error)
        {
            if (value.HasValue && value.Value < 0)
            {
                throw new InvalidDataException(error);
            }
        }

        private static long? ReadNullableLong(SQLiteDataReader reader, int index)
        {
            return reader.IsDBNull(index) ? (long?)null : Convert.ToInt64(reader.GetValue(index), CultureInfo.InvariantCulture);
        }
    }
}
