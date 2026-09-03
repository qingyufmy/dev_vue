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
        public void UpsertCoverage(long expectedConnectionEpoch, CoverageRangeRecord range)
        {
            ValidateCoverage(range);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO coverage_ranges (profile_id, resource, scope_key, range_start_utc_msc, range_end_utc_msc, completeness, source_revision, updated_at_utc_msc) VALUES (@profile_id, @resource, @scope_key, @range_start, @range_end, @completeness, @source_revision, @updated_at); UPDATE coverage_ranges SET range_end_utc_msc = @range_end, completeness = @completeness, source_revision = @source_revision, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND resource = @resource AND scope_key = @scope_key AND range_start_utc_msc = @range_start AND (updated_at_utc_msc < @updated_at OR (updated_at_utc_msc = @updated_at AND COALESCE(source_revision, '') = COALESCE(@source_revision, '')))";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@resource", range.Resource);
                    AddParameter(command, "@scope_key", range.ScopeKey);
                    AddParameter(command, "@range_start", range.RangeStartUtcMsc);
                    AddParameter(command, "@range_end", range.RangeEndUtcMsc);
                    AddParameter(command, "@completeness", range.Completeness);
                    AddNullableParameter(command, "@source_revision", range.SourceRevision);
                    AddParameter(command, "@updated_at", range.UpdatedAtUtcMsc);
                    command.ExecuteNonQuery();
                    transaction.Commit();
                }
            }
        }

        public IList<CoverageRangeRecord> ReadCoverage(string resource, string scopeKey)
        {
            RequireText(resource, "bridge_cache_resource_invalid", 64);
            RequireText(scopeKey, "bridge_cache_scope_invalid", 256);
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<CoverageRangeRecord> rows = new List<CoverageRangeRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT resource, scope_key, range_start_utc_msc, range_end_utc_msc, completeness, source_revision, updated_at_utc_msc FROM coverage_ranges WHERE profile_id = @profile_id AND resource = @resource AND scope_key = @scope_key ORDER BY range_start_utc_msc ASC";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@resource", resource);
                    AddParameter(command, "@scope_key", scopeKey);
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(new CoverageRangeRecord
                            {
                                Resource = reader.GetString(0),
                                ScopeKey = reader.GetString(1),
                                RangeStartUtcMsc = Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture),
                                RangeEndUtcMsc = Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture),
                                Completeness = reader.GetString(4),
                                SourceRevision = ReadNullableString(reader, 5),
                                UpdatedAtUtcMsc = Convert.ToInt64(reader.GetValue(6), CultureInfo.InvariantCulture)
                            });
                        }
                    }
                }
                return rows;
            }
        }

        public void RecordServerCoverageAck(long expectedConnectionEpoch, ServerCoverageAckRecord ack)
        {
            ValidateServerAck(ack);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO server_coverage_acks (profile_id, resource, scope_key, range_start_utc_msc, range_end_utc_msc, source_revision, acked_at_utc_msc) VALUES (@profile_id, @resource, @scope_key, @range_start, @range_end, @source_revision, @acked_at); UPDATE server_coverage_acks SET acked_at_utc_msc = @acked_at WHERE profile_id = @profile_id AND resource = @resource AND scope_key = @scope_key AND range_start_utc_msc = @range_start AND range_end_utc_msc = @range_end AND source_revision = @source_revision AND acked_at_utc_msc <= @acked_at";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@resource", ack.Resource);
                    AddParameter(command, "@scope_key", ack.ScopeKey);
                    AddParameter(command, "@range_start", ack.RangeStartUtcMsc);
                    AddParameter(command, "@range_end", ack.RangeEndUtcMsc);
                    AddParameter(command, "@source_revision", ack.SourceRevision);
                    AddParameter(command, "@acked_at", ack.AckedAtUtcMsc);
                    command.ExecuteNonQuery();
                    transaction.Commit();
                }
            }
        }

        public QuerySnapshotRecord CreateQuerySnapshot(long expectedConnectionEpoch, QuerySnapshotRecord snapshot)
        {
            ValidateSnapshot(snapshot);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                if (snapshot.ConnectionEpoch != 0 && snapshot.ConnectionEpoch != expectedConnectionEpoch)
                {
                    throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
                }
                snapshot.ConnectionEpoch = expectedConnectionEpoch;
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO query_snapshots (profile_id, snapshot_id, connection_epoch, resource, scope_key, query_hash, frozen_revision, range_start_utc_msc, range_end_utc_msc, created_at_utc_msc, expires_at_utc_msc) VALUES (@profile_id, @snapshot_id, @epoch, @resource, @scope_key, @query_hash, @frozen_revision, @range_start, @range_end, @created_at, @expires_at)";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@snapshot_id", snapshot.SnapshotId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddParameter(command, "@resource", snapshot.Resource);
                    AddParameter(command, "@scope_key", snapshot.ScopeKey);
                    AddParameter(command, "@query_hash", snapshot.QueryHash);
                    AddNullableParameter(command, "@frozen_revision", snapshot.FrozenRevision);
                    AddParameter(command, "@range_start", snapshot.RangeStartUtcMsc);
                    AddParameter(command, "@range_end", snapshot.RangeEndUtcMsc);
                    AddParameter(command, "@created_at", snapshot.CreatedAtUtcMsc);
                    AddParameter(command, "@expires_at", snapshot.ExpiresAtUtcMsc);
                    int inserted = command.ExecuteNonQuery();
                    if (inserted == 0)
                    {
                        using (SQLiteCommand existing = connection.CreateCommand())
                        {
                            existing.Transaction = transaction;
                            existing.CommandText = "SELECT connection_epoch, resource, scope_key, query_hash, frozen_revision, range_start_utc_msc, range_end_utc_msc, created_at_utc_msc, expires_at_utc_msc FROM query_snapshots WHERE profile_id = @profile_id AND snapshot_id = @snapshot_id LIMIT 1";
                            AddParameter(existing, "@profile_id", profileId);
                            AddParameter(existing, "@snapshot_id", snapshot.SnapshotId);
                            using (SQLiteDataReader reader = existing.ExecuteReader(CommandBehavior.SingleRow))
                            {
                                if (!reader.Read() || !QuerySnapshotMatches(reader, expectedConnectionEpoch, snapshot))
                                {
                                    throw new InvalidDataException("bridge_cache_snapshot_conflict");
                                }
                            }
                        }
                    }
                    transaction.Commit();
                }
                return snapshot;
            }
        }

        public QuerySnapshotRecord ReadQuerySnapshot(string snapshotId)
        {
            RequireText(snapshotId, "bridge_cache_snapshot_id_invalid", 191);
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT snapshot_id, connection_epoch, resource, scope_key, query_hash, frozen_revision, range_start_utc_msc, range_end_utc_msc, created_at_utc_msc, expires_at_utc_msc FROM query_snapshots WHERE profile_id = @profile_id AND snapshot_id = @snapshot_id LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@snapshot_id", snapshotId);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        if (!reader.Read())
                        {
                            return null;
                        }
                        return new QuerySnapshotRecord
                        {
                            SnapshotId = reader.GetString(0),
                            ConnectionEpoch = Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                            Resource = reader.GetString(2),
                            ScopeKey = reader.GetString(3),
                            QueryHash = reader.GetString(4),
                            FrozenRevision = ReadNullableString(reader, 5),
                            RangeStartUtcMsc = Convert.ToInt64(reader.GetValue(6), CultureInfo.InvariantCulture),
                            RangeEndUtcMsc = Convert.ToInt64(reader.GetValue(7), CultureInfo.InvariantCulture),
                            CreatedAtUtcMsc = Convert.ToInt64(reader.GetValue(8), CultureInfo.InvariantCulture),
                            ExpiresAtUtcMsc = Convert.ToInt64(reader.GetValue(9), CultureInfo.InvariantCulture)
                        };
                    }
                }
            }
        }

        public bool IsServerRangeAcknowledged(
            string resource,
            string scopeKey,
            long rangeStartUtcMsc,
            long rangeEndUtcMsc,
            string sourceRevision)
        {
            RequireText(resource, "bridge_cache_resource_invalid", 64);
            RequireText(scopeKey, "bridge_cache_scope_invalid", 256);
            RequireText(sourceRevision, "bridge_cache_ack_revision_invalid", 191);
            ValidateRange(rangeStartUtcMsc, rangeEndUtcMsc, "bridge_cache_ack_invalid");
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT 1 FROM server_coverage_acks WHERE profile_id = @profile_id AND resource = @resource AND scope_key = @scope_key AND range_start_utc_msc <= @range_start AND range_end_utc_msc >= @range_end AND source_revision = @source_revision LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@resource", resource);
                    AddParameter(command, "@scope_key", scopeKey);
                    AddParameter(command, "@range_start", rangeStartUtcMsc);
                    AddParameter(command, "@range_end", rangeEndUtcMsc);
                    AddParameter(command, "@source_revision", sourceRevision);
                    return command.ExecuteScalar() != null;
                }
            }
        }

        public bool IsRangeProtected(
            string resource,
            string scopeKey,
            long rangeStartUtcMsc,
            long rangeEndUtcMsc,
            long atUtcMsc)
        {
            RequireText(resource, "bridge_cache_resource_invalid", 64);
            RequireText(scopeKey, "bridge_cache_scope_invalid", 256);
            ValidateRange(rangeStartUtcMsc, rangeEndUtcMsc, "bridge_cache_snapshot_range_invalid");
            if (atUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT 1 FROM query_snapshots WHERE profile_id = @profile_id AND connection_epoch = @epoch AND resource = @resource AND scope_key = @scope_key AND expires_at_utc_msc > @at AND range_start_utc_msc < @range_end AND range_end_utc_msc > @range_start LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@epoch", connectionEpoch);
                    AddParameter(command, "@resource", resource);
                    AddParameter(command, "@scope_key", scopeKey);
                    AddParameter(command, "@at", atUtcMsc);
                    AddParameter(command, "@range_start", rangeStartUtcMsc);
                    AddParameter(command, "@range_end", rangeEndUtcMsc);
                    return command.ExecuteScalar() != null;
                }
            }
        }

        private static void ValidateCoverage(CoverageRangeRecord range)
        {
            if (range == null)
            {
                throw new InvalidDataException("bridge_cache_coverage_invalid");
            }
            RequireText(range.Resource, "bridge_cache_resource_invalid", 64);
            RequireText(range.ScopeKey, "bridge_cache_scope_invalid", 256);
            ValidateRange(range.RangeStartUtcMsc, range.RangeEndUtcMsc, "bridge_cache_coverage_invalid");
            RequireText(range.Completeness, "bridge_cache_completeness_invalid", 16);
            if (range.Completeness != "complete" && range.Completeness != "incomplete" && range.Completeness != "refreshing")
            {
                throw new InvalidDataException("bridge_cache_completeness_invalid");
            }
            if (range.UpdatedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_coverage_invalid");
            }
        }

        private static void ValidateServerAck(ServerCoverageAckRecord ack)
        {
            if (ack == null)
            {
                throw new InvalidDataException("bridge_cache_ack_invalid");
            }
            RequireText(ack.Resource, "bridge_cache_resource_invalid", 64);
            if (ack.Resource != "market.candles" && ack.Resource != "history.orders" && ack.Resource != "history.trades" && ack.Resource != "history.deals")
            {
                throw new InvalidDataException("bridge_cache_ack_resource_invalid");
            }
            RequireText(ack.ScopeKey, "bridge_cache_scope_invalid", 256);
            RequireText(ack.SourceRevision, "bridge_cache_ack_revision_invalid", 191);
            ValidateRange(ack.RangeStartUtcMsc, ack.RangeEndUtcMsc, "bridge_cache_ack_invalid");
            if (ack.AckedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_ack_invalid");
            }
        }

        private static void ValidateSnapshot(QuerySnapshotRecord snapshot)
        {
            if (snapshot == null)
            {
                throw new InvalidDataException("bridge_cache_snapshot_invalid");
            }
            RequireText(snapshot.SnapshotId, "bridge_cache_snapshot_id_invalid", 191);
            if (snapshot.ConnectionEpoch < 0)
            {
                throw new InvalidDataException("bridge_cache_snapshot_epoch_invalid");
            }
            RequireText(snapshot.Resource, "bridge_cache_resource_invalid", 64);
            RequireText(snapshot.ScopeKey, "bridge_cache_scope_invalid", 256);
            RequireText(snapshot.QueryHash, "bridge_cache_query_hash_invalid", 191);
            ValidateRange(snapshot.RangeStartUtcMsc, snapshot.RangeEndUtcMsc, "bridge_cache_snapshot_invalid");
            if (snapshot.CreatedAtUtcMsc < 1 || snapshot.ExpiresAtUtcMsc <= snapshot.CreatedAtUtcMsc)
            {
                throw new InvalidDataException("bridge_cache_snapshot_invalid");
            }
        }

        private static bool QuerySnapshotMatches(SQLiteDataReader reader, long expectedConnectionEpoch, QuerySnapshotRecord snapshot)
        {
            return Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture) == expectedConnectionEpoch
                && string.Equals(reader.GetString(1), snapshot.Resource, StringComparison.Ordinal)
                && string.Equals(reader.GetString(2), snapshot.ScopeKey, StringComparison.Ordinal)
                && string.Equals(reader.GetString(3), snapshot.QueryHash, StringComparison.Ordinal)
                && string.Equals(ReadNullableString(reader, 4), snapshot.FrozenRevision, StringComparison.Ordinal)
                && Convert.ToInt64(reader.GetValue(5), CultureInfo.InvariantCulture) == snapshot.RangeStartUtcMsc
                && Convert.ToInt64(reader.GetValue(6), CultureInfo.InvariantCulture) == snapshot.RangeEndUtcMsc
                && Convert.ToInt64(reader.GetValue(7), CultureInfo.InvariantCulture) == snapshot.CreatedAtUtcMsc
                && Convert.ToInt64(reader.GetValue(8), CultureInfo.InvariantCulture) == snapshot.ExpiresAtUtcMsc;
        }
    }
}
