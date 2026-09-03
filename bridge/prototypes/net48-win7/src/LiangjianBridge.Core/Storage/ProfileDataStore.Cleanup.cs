using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SQLite;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Storage
{
    public sealed partial class ProfileDataStore
    {
        public CacheCleanupResult Cleanup(long expectedConnectionEpoch, long nowUtcMsc, int requestedBatchSize)
        {
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            if (requestedBatchSize < 1)
            {
                throw new InvalidDataException("bridge_cache_batch_invalid");
            }
            int batchSize = Math.Min(MaxBatchSize, requestedBatchSize);
            long candleAccessCutoff = SubtractDays(nowUtcMsc, DefaultCandleAccessDays);
            long candleAgeCutoff = SubtractDays(nowUtcMsc, DefaultCandleAgeDays);
            long historyCutoff = SubtractDays(nowUtcMsc, DefaultHistoryAgeDays);
            long snapshotCutoff = SubtractDays(nowUtcMsc, DefaultSnapshotRetentionDays);
            long projectionCutoff = SubtractDays(nowUtcMsc, DefaultProjectionRetentionDays);
            long syncJobCutoff = SubtractDays(nowUtcMsc, DefaultSyncJobRetentionDays);
            long outboxCutoff = SubtractDays(nowUtcMsc, DefaultOutboxRetentionDays);
            long instrumentAccessCutoff = SubtractDays(nowUtcMsc, DefaultInstrumentAccessDays);

            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    int cleanupCursor = ReadCleanupCursor(transaction);
                    int[] quotas = BuildCleanupQuotas(batchSize, cleanupCursor);
                    int querySnapshotsDeleted = DeleteExpiredQuerySnapshots(transaction, quotas[CleanupBucketSnapshots], snapshotCutoff);
                    List<CandleCleanupKey> candleKeys = ReadCleanupCandleKeys(transaction, quotas[CleanupBucketCandles], candleAccessCutoff, candleAgeCutoff, nowUtcMsc);
                    List<HistoryCleanupKey> historyKeys = ReadCleanupHistoryKeys(transaction, quotas[CleanupBucketHistory], historyCutoff, nowUtcMsc);
                    DeleteCandles(transaction, candleKeys);
                    DeleteHistoryItems(transaction, historyKeys);
                    MarkCandleCoverageIncomplete(transaction, candleKeys, nowUtcMsc);
                    MarkHistoryCoverageIncomplete(transaction, historyKeys, nowUtcMsc);
                    int instrumentsDeleted = DeleteExpiredInstruments(transaction, quotas[CleanupBucketInstruments], nowUtcMsc, instrumentAccessCutoff);
                    int staleProjectionsDeleted = DeleteStaleLatestProjections(transaction, quotas[CleanupBucketProjections], projectionCutoff);
                    int syncJobsDeleted = DeleteOldSyncJobs(transaction, quotas[CleanupBucketSyncJobs], syncJobCutoff);
                    int outboxMessagesDeleted = DeleteAckedOutbox(transaction, quotas[CleanupBucketOutbox], outboxCutoff);
                    WriteCleanupMaintenance(transaction, nowUtcMsc, (cleanupCursor + 1) % CleanupBucketCount);
                    transaction.Commit();
                    return new CacheCleanupResult
                    {
                        QuerySnapshotsDeleted = querySnapshotsDeleted,
                        CandlesDeleted = candleKeys.Count,
                        HistoryItemsDeleted = historyKeys.Count,
                        InstrumentsDeleted = instrumentsDeleted,
                        StaleProjectionsDeleted = staleProjectionsDeleted,
                        SyncJobsDeleted = syncJobsDeleted,
                        OutboxMessagesDeleted = outboxMessagesDeleted
                    };
                }
            }
        }

        private int DeleteExpiredQuerySnapshots(SQLiteTransaction transaction, int limit, long expiresBeforeUtcMsc)
        {
            if (limit <= 0)
            {
                return 0;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM query_snapshots WHERE rowid IN (SELECT rowid FROM query_snapshots WHERE profile_id = @profile_id AND expires_at_utc_msc < @expires_before ORDER BY expires_at_utc_msc ASC, snapshot_id ASC LIMIT @limit_value)";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@expires_before", expiresBeforeUtcMsc);
                AddParameter(command, "@limit_value", limit);
                return command.ExecuteNonQuery();
            }
        }

        private List<CandleCleanupKey> ReadCleanupCandleKeys(SQLiteTransaction transaction, int limit, long accessCutoff, long ageCutoff, long nowUtcMsc)
        {
            List<CandleCleanupKey> keys = new List<CandleCleanupKey>();
            if (limit <= 0)
            {
                return keys;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT c.symbol, c.timeframe, c.open_time_utc_msc FROM market_candles c WHERE c.profile_id = @profile_id AND c.closed = 1 AND c.last_accessed_utc_msc < @access_cutoff AND c.open_time_utc_msc < @age_cutoff AND NOT EXISTS (SELECT 1 FROM query_snapshots s WHERE s.profile_id = c.profile_id AND s.connection_epoch = @epoch AND s.resource = 'market.candles' AND s.scope_key = c.symbol || '|' || c.timeframe AND s.expires_at_utc_msc > @now AND s.range_start_utc_msc <= c.open_time_utc_msc AND s.range_end_utc_msc > c.open_time_utc_msc) ORDER BY c.last_accessed_utc_msc ASC, c.open_time_utc_msc ASC LIMIT @limit_value";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@epoch", connectionEpoch);
                AddParameter(command, "@access_cutoff", accessCutoff);
                AddParameter(command, "@age_cutoff", ageCutoff);
                AddParameter(command, "@now", nowUtcMsc);
                AddParameter(command, "@limit_value", limit);
                using (SQLiteDataReader reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        keys.Add(new CandleCleanupKey
                        {
                            Symbol = reader.GetString(0),
                            Timeframe = reader.GetString(1),
                            OpenTimeUtcMsc = Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture)
                        });
                    }
                }
            }
            return keys;
        }

        private List<HistoryCleanupKey> ReadCleanupHistoryKeys(SQLiteTransaction transaction, int limit, long ageCutoff, long nowUtcMsc)
        {
            List<HistoryCleanupKey> keys = new List<HistoryCleanupKey>();
            if (limit <= 0)
            {
                return keys;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT h.item_kind, h.item_id, h.symbol, h.event_time_utc_msc FROM history_items h WHERE h.profile_id = @profile_id AND h.event_time_utc_msc < @age_cutoff AND EXISTS (SELECT 1 FROM server_coverage_acks a WHERE a.profile_id = h.profile_id AND (a.resource = 'history.' || h.item_kind OR a.resource = 'history.items') AND (a.scope_key = h.item_kind OR a.scope_key = 'all' OR a.scope_key = h.symbol OR a.scope_key = h.item_kind || '|' || COALESCE(h.symbol, '')) AND a.range_start_utc_msc <= h.event_time_utc_msc AND a.range_end_utc_msc > h.event_time_utc_msc AND a.source_revision = h.source_revision) AND NOT EXISTS (SELECT 1 FROM query_snapshots s WHERE s.profile_id = h.profile_id AND s.connection_epoch = @epoch AND (s.resource = 'history.' || h.item_kind OR s.resource = 'history.items') AND (s.scope_key = h.item_kind OR s.scope_key = 'all' OR s.scope_key = h.symbol OR s.scope_key = h.item_kind || '|' || COALESCE(h.symbol, '')) AND s.expires_at_utc_msc > @now AND s.range_start_utc_msc <= h.event_time_utc_msc AND s.range_end_utc_msc > h.event_time_utc_msc) ORDER BY h.event_time_utc_msc ASC, h.item_id ASC LIMIT @limit_value";
                AddParameter(command, "@profile_id", profileId);
                AddParameter(command, "@epoch", connectionEpoch);
                AddParameter(command, "@age_cutoff", ageCutoff);
                AddParameter(command, "@now", nowUtcMsc);
                AddParameter(command, "@limit_value", limit);
                using (SQLiteDataReader reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        keys.Add(new HistoryCleanupKey
                        {
                            ItemKind = reader.GetString(0),
                            ItemId = reader.GetString(1),
                            Symbol = ReadNullableString(reader, 2),
                            EventTimeUtcMsc = Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture)
                        });
                    }
                }
            }
            return keys;
        }

        private void DeleteCandles(SQLiteTransaction transaction, IList<CandleCleanupKey> keys)
        {
            if (keys.Count == 0)
            {
                return;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM market_candles WHERE profile_id = @profile_id AND symbol = @symbol AND timeframe = @timeframe AND open_time_utc_msc = @open_time";
                SQLiteParameter profile = AddParameter(command, "@profile_id", profileId);
                SQLiteParameter symbol = AddParameter(command, "@symbol", null);
                SQLiteParameter timeframe = AddParameter(command, "@timeframe", null);
                SQLiteParameter openTime = AddParameter(command, "@open_time", 0L);
                for (int i = 0; i < keys.Count; i++)
                {
                    profile.Value = profileId;
                    symbol.Value = keys[i].Symbol;
                    timeframe.Value = keys[i].Timeframe;
                    openTime.Value = keys[i].OpenTimeUtcMsc;
                    command.ExecuteNonQuery();
                }
            }
        }

        private void DeleteHistoryItems(SQLiteTransaction transaction, IList<HistoryCleanupKey> keys)
        {
            if (keys.Count == 0)
            {
                return;
            }
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM history_items WHERE profile_id = @profile_id AND item_kind = @item_kind AND item_id = @item_id";
                SQLiteParameter profile = AddParameter(command, "@profile_id", profileId);
                SQLiteParameter itemKind = AddParameter(command, "@item_kind", null);
                SQLiteParameter itemId = AddParameter(command, "@item_id", null);
                for (int i = 0; i < keys.Count; i++)
                {
                    profile.Value = profileId;
                    itemKind.Value = keys[i].ItemKind;
                    itemId.Value = keys[i].ItemId;
                    command.ExecuteNonQuery();
                }
            }
        }

        private void MarkCandleCoverageIncomplete(SQLiteTransaction transaction, IList<CandleCleanupKey> keys, long nowUtcMsc)
        {
            Dictionary<string, CleanupBounds> bounds = new Dictionary<string, CleanupBounds>(StringComparer.Ordinal);
            for (int i = 0; i < keys.Count; i++)
            {
                string scope = CandleScopeKey(keys[i].Symbol, keys[i].Timeframe);
                CleanupBounds current;
                if (!bounds.TryGetValue(scope, out current))
                {
                    current = new CleanupBounds { Kind = "market.candles", ScopeSymbol = scope, MinimumUtcMsc = keys[i].OpenTimeUtcMsc, MaximumUtcMsc = keys[i].OpenTimeUtcMsc };
                    bounds.Add(scope, current);
                }
                current.MinimumUtcMsc = Math.Min(current.MinimumUtcMsc, keys[i].OpenTimeUtcMsc);
                current.MaximumUtcMsc = Math.Max(current.MaximumUtcMsc, keys[i].OpenTimeUtcMsc);
            }
            foreach (CleanupBounds bound in bounds.Values)
            {
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE coverage_ranges SET completeness = 'incomplete', source_revision = NULL, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND resource = 'market.candles' AND scope_key = @scope_key AND range_start_utc_msc <= @maximum_time AND range_end_utc_msc > @minimum_time";
                    AddParameter(command, "@updated_at", nowUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@scope_key", bound.ScopeSymbol);
                    AddParameter(command, "@minimum_time", bound.MinimumUtcMsc);
                    AddParameter(command, "@maximum_time", bound.MaximumUtcMsc);
                    command.ExecuteNonQuery();
                }
            }
        }

        private void MarkHistoryCoverageIncomplete(SQLiteTransaction transaction, IList<HistoryCleanupKey> keys, long nowUtcMsc)
        {
            Dictionary<string, CleanupBounds> bounds = new Dictionary<string, CleanupBounds>(StringComparer.Ordinal);
            for (int i = 0; i < keys.Count; i++)
            {
                string symbol = keys[i].Symbol ?? string.Empty;
                string key = keys[i].ItemKind + "\u0000" + symbol;
                CleanupBounds current;
                if (!bounds.TryGetValue(key, out current))
                {
                    current = new CleanupBounds { Kind = keys[i].ItemKind, ScopeSymbol = symbol, MinimumUtcMsc = keys[i].EventTimeUtcMsc, MaximumUtcMsc = keys[i].EventTimeUtcMsc };
                    bounds.Add(key, current);
                }
                current.MinimumUtcMsc = Math.Min(current.MinimumUtcMsc, keys[i].EventTimeUtcMsc);
                current.MaximumUtcMsc = Math.Max(current.MaximumUtcMsc, keys[i].EventTimeUtcMsc);
            }
            foreach (CleanupBounds bound in bounds.Values)
            {
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE coverage_ranges SET completeness = 'incomplete', source_revision = NULL, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND (resource = 'history.' || @item_kind OR resource = 'history.items') AND range_start_utc_msc <= @maximum_time AND range_end_utc_msc > @minimum_time AND (scope_key = @item_kind OR scope_key = 'all' OR (@symbol <> '' AND (scope_key = @symbol OR scope_key = @item_kind || '|' || @symbol)))";
                    AddParameter(command, "@updated_at", nowUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@item_kind", bound.Kind);
                    AddParameter(command, "@symbol", bound.ScopeSymbol);
                    AddParameter(command, "@minimum_time", bound.MinimumUtcMsc);
                    AddParameter(command, "@maximum_time", bound.MaximumUtcMsc);
                    command.ExecuteNonQuery();
                }
            }
        }
    }
}
