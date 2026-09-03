using System;
using System.Data;
using System.Data.SQLite;

namespace Liangjian.BridgeV4.Storage
{
    public sealed partial class ProfileDataStore
    {
        private const int CleanupBucketSnapshots = 0;
        private const int CleanupBucketCandles = 1;
        private const int CleanupBucketHistory = 2;
        private const int CleanupBucketInstruments = 3;
        private const int CleanupBucketProjections = 4;
        private const int CleanupBucketSyncJobs = 5;
        private const int CleanupBucketOutbox = 6;
        private const int CleanupBucketCount = 7;

        private static int[] BuildCleanupQuotas(int batchSize, int cursor)
        {
            int[] quotas = new int[CleanupBucketCount];
            int each = batchSize / CleanupBucketCount;
            int remainder = batchSize % CleanupBucketCount;
            for (int i = 0; i < quotas.Length; i++)
            {
                quotas[i] = each;
            }
            int start = cursor < 0 || cursor >= CleanupBucketCount ? 0 : cursor;
            for (int i = 0; i < remainder; i++)
            {
                quotas[(start + i) % CleanupBucketCount]++;
            }
            return quotas;
        }

        private int ReadCleanupCursor(SQLiteTransaction transaction)
        {
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT cleanup_cursor FROM maintenance_state WHERE profile_id = @profile_id LIMIT 1";
                AddParameter(command, "@profile_id", profileId);
                object value = command.ExecuteScalar();
                if (value == null || value == DBNull.Value)
                {
                    return 0;
                }
                int cursor = Convert.ToInt32(value);
                return cursor >= 0 && cursor < CleanupBucketCount ? cursor : 0;
            }
        }

        private int DeleteExpiredInstruments(SQLiteTransaction transaction, int limit, long nowUtcMsc, long accessCutoff)
        {
            if (limit <= 0)
            {
                return 0;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM instrument_cache WHERE rowid IN (SELECT rowid FROM instrument_cache WHERE profile_id = @profile_id AND expires_at_utc_msc < @now AND last_accessed_utc_msc < @access_cutoff ORDER BY last_accessed_utc_msc ASC, symbol ASC LIMIT @limit_value)";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@now", nowUtcMsc);
                AddParameter(command, "@access_cutoff", accessCutoff);
                AddParameter(command, "@limit_value", limit);
                return command.ExecuteNonQuery();
            }
        }

        private int DeleteStaleLatestProjections(SQLiteTransaction transaction, int limit, long observedCutoff)
        {
            if (limit <= 0)
            {
                return 0;
            }
            int each = limit / 3;
            int remainder = limit % 3;
            int accountLimit = each + (remainder > 0 ? 1 : 0);
            int positionsLimit = each + (remainder > 1 ? 1 : 0);
            int ordersLimit = each;
            int deleted = 0;
            deleted += DeleteStaleProjectionRows(transaction, "account_latest", accountLimit, observedCutoff, "profile_id = @profile_id AND connection_epoch <> @epoch");
            deleted += DeleteStaleProjectionRows(transaction, "positions_latest", positionsLimit, observedCutoff, "profile_id = @profile_id AND connection_epoch <> @epoch");
            deleted += DeleteStaleProjectionRows(transaction, "pending_orders_latest", ordersLimit, observedCutoff, "profile_id = @profile_id AND connection_epoch <> @epoch");
            return deleted;
        }

        private int DeleteStaleProjectionRows(SQLiteTransaction transaction, string tableName, int limit, long observedCutoff, string predicate)
        {
            if (limit <= 0)
            {
                return 0;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM " + tableName + " WHERE rowid IN (SELECT rowid FROM " + tableName + " WHERE " + predicate + " AND observed_at_utc_msc < @observed_cutoff ORDER BY observed_at_utc_msc ASC LIMIT @limit_value)";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@epoch", connectionEpoch);
                AddParameter(command, "@observed_cutoff", observedCutoff);
                AddParameter(command, "@limit_value", limit);
                return command.ExecuteNonQuery();
            }
        }

        private int DeleteOldSyncJobs(SQLiteTransaction transaction, int limit, long updatedCutoff)
        {
            if (limit <= 0)
            {
                return 0;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM sync_jobs WHERE rowid IN (SELECT rowid FROM sync_jobs WHERE profile_id = @profile_id AND state IN ('completed', 'superseded') AND updated_at_utc_msc < @updated_cutoff ORDER BY updated_at_utc_msc ASC, job_id ASC LIMIT @limit_value)";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@updated_cutoff", updatedCutoff);
                AddParameter(command, "@limit_value", limit);
                return command.ExecuteNonQuery();
            }
        }

        private int DeleteAckedOutbox(SQLiteTransaction transaction, int limit, long ackedCutoff)
        {
            if (limit <= 0)
            {
                return 0;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM outbox_messages WHERE rowid IN (SELECT rowid FROM outbox_messages WHERE profile_id = @profile_id AND acked_at_utc_msc IS NOT NULL AND acked_at_utc_msc < @acked_cutoff ORDER BY acked_at_utc_msc ASC, message_id ASC LIMIT @limit_value)";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@acked_cutoff", ackedCutoff);
                AddParameter(command, "@limit_value", limit);
                return command.ExecuteNonQuery();
            }
        }

        private void WriteCleanupMaintenance(SQLiteTransaction transaction, long nowUtcMsc, int nextCursor)
        {
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "INSERT OR IGNORE INTO maintenance_state (profile_id, last_cleanup_at_utc_msc, cleanup_cursor, updated_at_utc_msc) VALUES (@profile_id, @last_cleanup, @cleanup_cursor, @updated_at); UPDATE maintenance_state SET last_cleanup_at_utc_msc = @last_cleanup, cleanup_cursor = @cleanup_cursor, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND updated_at_utc_msc <= @updated_at";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@last_cleanup", nowUtcMsc);
                AddParameter(command, "@cleanup_cursor", nextCursor);
                AddParameter(command, "@updated_at", nowUtcMsc);
                command.ExecuteNonQuery();
            }
        }
    }
}
