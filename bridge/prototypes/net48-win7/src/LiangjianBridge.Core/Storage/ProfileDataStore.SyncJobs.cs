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
        public bool EnqueueSyncJob(long expectedConnectionEpoch, SyncJobRecord job)
        {
            ValidateSyncJob(job, expectedConnectionEpoch, false);
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "INSERT OR IGNORE INTO sync_jobs (profile_id, job_id, connection_epoch, resource, scope_key, range_start_utc_msc, range_end_utc_msc, cursor, state, lease_owner, lease_expires_at_utc_msc, attempt, next_attempt_at_utc_msc, last_error_code, last_error_detail, created_at_utc_msc, updated_at_utc_msc) VALUES (@profile_id, @job_id, @epoch, @resource, @scope_key, @range_start, @range_end, @cursor, @state, NULL, NULL, @attempt, @next_attempt, @error_code, @error_detail, @created_at, @updated_at)";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@job_id", job.JobId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddParameter(command, "@resource", job.Resource);
                    AddParameter(command, "@scope_key", job.ScopeKey);
                    AddParameter(command, "@range_start", job.RangeStartUtcMsc);
                    AddParameter(command, "@range_end", job.RangeEndUtcMsc);
                    AddNullableParameter(command, "@cursor", job.Cursor);
                    AddParameter(command, "@state", string.IsNullOrEmpty(job.State) ? "queued" : job.State);
                    AddParameter(command, "@attempt", job.Attempt);
                    AddParameter(command, "@next_attempt", job.NextAttemptAtUtcMsc);
                    AddNullableParameter(command, "@error_code", job.LastErrorCode);
                    AddNullableParameter(command, "@error_detail", job.LastErrorDetail);
                    AddParameter(command, "@created_at", job.CreatedAtUtcMsc);
                    AddParameter(command, "@updated_at", job.UpdatedAtUtcMsc);
                    int inserted = command.ExecuteNonQuery();
                    if (inserted == 0)
                    {
                        using (SQLiteCommand select = connection.CreateCommand())
                        {
                            select.Transaction = transaction;
                            select.CommandText = "SELECT connection_epoch, resource, scope_key, range_start_utc_msc, range_end_utc_msc, cursor FROM sync_jobs WHERE profile_id = @profile_id AND job_id = @job_id LIMIT 1";
                            AddParameter(select, "@profile_id", profileId);
                            AddParameter(select, "@job_id", job.JobId);
                            using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                            {
                                if (!reader.Read() || !SyncJobMatches(reader, expectedConnectionEpoch, job))
                                {
                                    throw new InvalidDataException("bridge_cache_sync_job_conflict");
                                }
                            }
                        }
                    }
                    transaction.Commit();
                    return inserted == 1;
                }
            }
        }

        public SyncJobRecord ReadSyncJob(string jobId)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT job_id, connection_epoch, resource, scope_key, range_start_utc_msc, range_end_utc_msc, cursor, state, lease_owner, lease_expires_at_utc_msc, attempt, next_attempt_at_utc_msc, last_error_code, last_error_detail, created_at_utc_msc, updated_at_utc_msc FROM sync_jobs WHERE profile_id = @profile_id AND job_id = @job_id LIMIT 1";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@job_id", jobId);
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        return reader.Read() ? ReadSyncJob(reader) : null;
                    }
                }
            }
        }

        public bool RestartSyncJob(long expectedConnectionEpoch, string jobId, long nowUtcMsc)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_sync_job_time_invalid");
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "UPDATE sync_jobs SET cursor = NULL, state = 'queued', lease_owner = NULL, lease_expires_at_utc_msc = NULL, attempt = 0, next_attempt_at_utc_msc = @now, last_error_code = NULL, last_error_detail = NULL, updated_at_utc_msc = @now WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state IN ('completed', 'superseded')";
                    AddParameter(command, "@now", nowUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@job_id", jobId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    return command.ExecuteNonQuery() == 1;
                }
            }
        }

        public SyncJobPage ReadSyncJobs(int limit, SyncJobCursor cursor)
        {
            int pageSize = NormalizePageSize(limit);
            if (cursor != null)
            {
                RequireText(cursor.JobId, "bridge_cache_cursor_invalid", 191);
                if (cursor.UpdatedAtUtcMsc < 1)
                {
                    throw new InvalidDataException("bridge_cache_cursor_invalid");
                }
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<SyncJobRecord> rows = new List<SyncJobRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT job_id, connection_epoch, resource, scope_key, range_start_utc_msc, range_end_utc_msc, cursor, state, lease_owner, lease_expires_at_utc_msc, attempt, next_attempt_at_utc_msc, last_error_code, last_error_detail, created_at_utc_msc, updated_at_utc_msc FROM sync_jobs WHERE profile_id = @profile_id AND (@has_cursor = 0 OR updated_at_utc_msc > @cursor_time OR (updated_at_utc_msc = @cursor_time AND job_id > @cursor_id)) ORDER BY updated_at_utc_msc ASC, job_id ASC LIMIT @limit_value";
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@has_cursor", cursor == null ? 0 : 1);
                    AddParameter(command, "@cursor_time", cursor == null ? 0 : cursor.UpdatedAtUtcMsc);
                    AddParameter(command, "@cursor_id", cursor == null ? string.Empty : cursor.JobId);
                    AddParameter(command, "@limit_value", pageSize + 1);
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            rows.Add(ReadSyncJob(reader));
                        }
                    }
                }
                bool hasMore = rows.Count > pageSize;
                if (hasMore)
                {
                    rows.RemoveAt(rows.Count - 1);
                }
                return new SyncJobPage
                {
                    Items = rows,
                    HasMore = hasMore,
                    NextCursor = rows.Count == 0 ? null : new SyncJobCursor(rows[rows.Count - 1].UpdatedAtUtcMsc, rows[rows.Count - 1].JobId)
                };
            }
        }

        public SyncJobRecord ClaimSyncJob(long expectedConnectionEpoch, string leaseOwner, long nowUtcMsc, long leaseDurationMsc)
        {
            RequireEpoch(expectedConnectionEpoch, "bridge_cache_epoch_invalid");
            RequireText(leaseOwner, "bridge_cache_sync_lease_owner_invalid", 128);
            if (nowUtcMsc < 1 || leaseDurationMsc < 1 || leaseDurationMsc > 24L * 60L * 60L * 1000L)
            {
                throw new InvalidDataException("bridge_cache_sync_lease_invalid");
            }
            long leaseExpires = AddMilliseconds(nowUtcMsc, leaseDurationMsc, "bridge_cache_sync_lease_invalid");

            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    SyncJobRecord candidate = null;
                    using (SQLiteCommand select = connection.CreateCommand())
                    {
                        select.Transaction = transaction;
                        select.CommandText = "SELECT job_id, connection_epoch, resource, scope_key, range_start_utc_msc, range_end_utc_msc, cursor, state, lease_owner, lease_expires_at_utc_msc, attempt, next_attempt_at_utc_msc, last_error_code, last_error_detail, created_at_utc_msc, updated_at_utc_msc FROM sync_jobs WHERE profile_id = @profile_id AND connection_epoch = @epoch AND ((state IN ('queued', 'retry_wait') AND next_attempt_at_utc_msc <= @now) OR (state = 'running' AND lease_expires_at_utc_msc IS NOT NULL AND lease_expires_at_utc_msc <= @now)) ORDER BY next_attempt_at_utc_msc ASC, updated_at_utc_msc ASC, job_id ASC LIMIT 1";
                        AddParameter(select, "@profile_id", profileId);
                        AddParameter(select, "@epoch", expectedConnectionEpoch);
                        AddParameter(select, "@now", nowUtcMsc);
                        using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                        {
                            if (reader.Read())
                            {
                                candidate = ReadSyncJob(reader);
                            }
                        }
                    }
                    if (candidate == null)
                    {
                        transaction.Commit();
                        return null;
                    }

                    using (SQLiteCommand claim = connection.CreateCommand())
                    {
                        claim.Transaction = transaction;
                        claim.CommandText = "UPDATE sync_jobs SET state = 'running', lease_owner = @lease_owner, lease_expires_at_utc_msc = @lease_expires, attempt = attempt + 1, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND ((state IN ('queued', 'retry_wait') AND next_attempt_at_utc_msc <= @now) OR (state = 'running' AND lease_expires_at_utc_msc IS NOT NULL AND lease_expires_at_utc_msc <= @now))";
                        AddParameter(claim, "@lease_owner", leaseOwner);
                        AddParameter(claim, "@lease_expires", leaseExpires);
                        AddParameter(claim, "@updated_at", nowUtcMsc);
                        AddParameter(claim, "@profile_id", profileId);
                        AddParameter(claim, "@job_id", candidate.JobId);
                        AddParameter(claim, "@epoch", expectedConnectionEpoch);
                        AddParameter(claim, "@now", nowUtcMsc);
                        if (claim.ExecuteNonQuery() != 1)
                        {
                            transaction.Commit();
                            return null;
                        }
                    }
                    candidate.State = "running";
                    candidate.LeaseOwner = leaseOwner;
                    candidate.LeaseExpiresAtUtcMsc = leaseExpires;
                    candidate.Attempt++;
                    candidate.UpdatedAtUtcMsc = nowUtcMsc;
                    transaction.Commit();
                    return candidate;
                }
            }
        }

        public bool RenewSyncJobLease(long expectedConnectionEpoch, string jobId, string leaseOwner, long nowUtcMsc, long leaseExpiresAtUtcMsc)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            RequireText(leaseOwner, "bridge_cache_lease_owner_invalid", 128);
            if (nowUtcMsc < 1 || leaseExpiresAtUtcMsc <= nowUtcMsc)
            {
                throw new InvalidDataException("bridge_cache_sync_lease_invalid");
            }
            return ExecuteSyncJobCas(expectedConnectionEpoch, jobId, leaseOwner, nowUtcMsc, "UPDATE sync_jobs SET lease_expires_at_utc_msc = @lease_expires, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state = 'running' AND lease_owner = @lease_owner AND lease_expires_at_utc_msc > @now", new Action<SQLiteCommand>(delegate(SQLiteCommand command)
            {
                AddParameter(command, "@lease_expires", leaseExpiresAtUtcMsc);
            }));
        }

        public bool CompleteSyncJob(long expectedConnectionEpoch, string jobId, string leaseOwner, long completedAtUtcMsc)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            RequireText(leaseOwner, "bridge_cache_lease_owner_invalid", 128);
            if (completedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            return ExecuteSyncJobCas(expectedConnectionEpoch, jobId, leaseOwner, completedAtUtcMsc, "UPDATE sync_jobs SET state = 'completed', lease_owner = NULL, lease_expires_at_utc_msc = NULL, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state = 'running' AND lease_owner = @lease_owner AND lease_expires_at_utc_msc > @now", null);
        }

        public bool ContinueSyncJob(
            long expectedConnectionEpoch,
            string jobId,
            string leaseOwner,
            long nowUtcMsc,
            string nextCursor)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            RequireText(leaseOwner, "bridge_cache_lease_owner_invalid", 128);
            RequireText(nextCursor, "bridge_cache_sync_cursor_invalid", 1024);
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            return ExecuteSyncJobCas(expectedConnectionEpoch, jobId, leaseOwner, nowUtcMsc,
                "UPDATE sync_jobs SET state = 'queued', cursor = @next_cursor, lease_owner = NULL, lease_expires_at_utc_msc = NULL, next_attempt_at_utc_msc = @updated_at, last_error_code = NULL, last_error_detail = NULL, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state = 'running' AND lease_owner = @lease_owner AND lease_expires_at_utc_msc > @now",
                new Action<SQLiteCommand>(delegate(SQLiteCommand command)
                {
                    AddParameter(command, "@next_cursor", nextCursor);
                }));
        }

        public bool RetrySyncJob(long expectedConnectionEpoch, string jobId, string leaseOwner, long nowUtcMsc, long nextAttemptAtUtcMsc, string errorCode, string errorDetail)
        {
            ValidateSyncResult(jobId, leaseOwner, nowUtcMsc, nextAttemptAtUtcMsc, errorCode, errorDetail);
            return ExecuteSyncJobCas(expectedConnectionEpoch, jobId, leaseOwner, nowUtcMsc, "UPDATE sync_jobs SET state = 'retry_wait', lease_owner = NULL, lease_expires_at_utc_msc = NULL, next_attempt_at_utc_msc = @next_attempt, last_error_code = @error_code, last_error_detail = @error_detail, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state = 'running' AND lease_owner = @lease_owner AND lease_expires_at_utc_msc > @now", new Action<SQLiteCommand>(delegate(SQLiteCommand command)
            {
                AddParameter(command, "@next_attempt", nextAttemptAtUtcMsc);
                AddParameter(command, "@error_code", errorCode);
                AddNullableParameter(command, "@error_detail", errorDetail);
            }));
        }

        public bool BlockSyncJob(long expectedConnectionEpoch, string jobId, string leaseOwner, long nowUtcMsc, string errorCode, string errorDetail)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            RequireText(leaseOwner, "bridge_cache_lease_owner_invalid", 128);
            RequireText(errorCode, "bridge_cache_sync_error_invalid", 128);
            RequireOptionalText(errorDetail, "bridge_cache_sync_error_detail_invalid", 4096);
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            return ExecuteSyncJobCas(expectedConnectionEpoch, jobId, leaseOwner, nowUtcMsc, "UPDATE sync_jobs SET state = 'blocked', lease_owner = NULL, lease_expires_at_utc_msc = NULL, last_error_code = @error_code, last_error_detail = @error_detail, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state = 'running' AND lease_owner = @lease_owner AND lease_expires_at_utc_msc > @now", new Action<SQLiteCommand>(delegate(SQLiteCommand command)
            {
                AddParameter(command, "@error_code", errorCode);
                AddNullableParameter(command, "@error_detail", errorDetail);
            }));
        }

        public bool SupersedeSyncJob(long expectedConnectionEpoch, string jobId, long nowUtcMsc, string errorCode, string errorDetail)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            RequireText(errorCode, "bridge_cache_sync_error_invalid", 128);
            RequireOptionalText(errorDetail, "bridge_cache_sync_error_detail_invalid", 4096);
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_time_invalid");
            }
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE sync_jobs SET state = 'superseded', lease_owner = NULL, lease_expires_at_utc_msc = NULL, last_error_code = @error_code, last_error_detail = @error_detail, updated_at_utc_msc = @updated_at WHERE profile_id = @profile_id AND job_id = @job_id AND connection_epoch = @epoch AND state NOT IN ('completed', 'blocked', 'superseded')";
                    AddParameter(command, "@error_code", errorCode);
                    AddNullableParameter(command, "@error_detail", errorDetail);
                    AddParameter(command, "@updated_at", nowUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@job_id", jobId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    int changed = command.ExecuteNonQuery();
                    transaction.Commit();
                    return changed == 1;
                }
            }
        }

        private bool ExecuteSyncJobCas(long expectedConnectionEpoch, string jobId, string leaseOwner, long nowUtcMsc, string updateSql, Action<SQLiteCommand> bindExtra)
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                EnsureExpectedEpoch(expectedConnectionEpoch);
                using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = updateSql;
                    if (bindExtra != null)
                    {
                        bindExtra(command);
                    }
                    AddParameter(command, "@updated_at", nowUtcMsc);
                    AddParameter(command, "@profile_id", profileId);
                    AddParameter(command, "@job_id", jobId);
                    AddParameter(command, "@epoch", expectedConnectionEpoch);
                    AddParameter(command, "@lease_owner", leaseOwner);
                    AddParameter(command, "@now", nowUtcMsc);
                    int changed = command.ExecuteNonQuery();
                    transaction.Commit();
                    return changed == 1;
                }
            }
        }

        private static SyncJobRecord ReadSyncJob(SQLiteDataReader reader)
        {
            return new SyncJobRecord
            {
                JobId = reader.GetString(0),
                ConnectionEpoch = Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                Resource = reader.GetString(2),
                ScopeKey = reader.GetString(3),
                RangeStartUtcMsc = Convert.ToInt64(reader.GetValue(4), CultureInfo.InvariantCulture),
                RangeEndUtcMsc = Convert.ToInt64(reader.GetValue(5), CultureInfo.InvariantCulture),
                Cursor = ReadNullableString(reader, 6),
                State = reader.GetString(7),
                LeaseOwner = ReadNullableString(reader, 8),
                LeaseExpiresAtUtcMsc = reader.IsDBNull(9) ? (long?)null : Convert.ToInt64(reader.GetValue(9), CultureInfo.InvariantCulture),
                Attempt = Convert.ToInt32(reader.GetValue(10), CultureInfo.InvariantCulture),
                NextAttemptAtUtcMsc = Convert.ToInt64(reader.GetValue(11), CultureInfo.InvariantCulture),
                LastErrorCode = ReadNullableString(reader, 12),
                LastErrorDetail = ReadNullableString(reader, 13),
                CreatedAtUtcMsc = Convert.ToInt64(reader.GetValue(14), CultureInfo.InvariantCulture),
                UpdatedAtUtcMsc = Convert.ToInt64(reader.GetValue(15), CultureInfo.InvariantCulture)
            };
        }

        private static void ValidateSyncJob(SyncJobRecord job, long expectedConnectionEpoch, bool allowRunning)
        {
            if (job == null)
            {
                throw new InvalidDataException("bridge_cache_sync_job_invalid");
            }
            RequireText(job.JobId, "bridge_cache_sync_job_id_invalid", 191);
            if (job.ConnectionEpoch != 0 && job.ConnectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
            RequireText(job.Resource, "bridge_cache_resource_invalid", 64);
            if (job.Resource != "market.candles" && job.Resource != "history.orders" && job.Resource != "history.trades" && job.Resource != "history.deals")
            {
                throw new InvalidDataException("bridge_cache_sync_resource_invalid");
            }
            RequireText(job.ScopeKey, "bridge_cache_scope_invalid", 256);
            ValidateRange(job.RangeStartUtcMsc, job.RangeEndUtcMsc, "bridge_cache_sync_job_range_invalid");
            RequireOptionalText(job.Cursor, "bridge_cache_sync_cursor_invalid", 1024);
            if (string.IsNullOrEmpty(job.State))
            {
                job.State = "queued";
            }
            if (!IsSyncState(job.State) || (!allowRunning && job.State != "queued" && job.State != "retry_wait"))
            {
                throw new InvalidDataException("bridge_cache_sync_state_invalid");
            }
            if (job.Attempt < 0 || job.Attempt > 1000000 || job.NextAttemptAtUtcMsc < 1 || job.CreatedAtUtcMsc < 1 || job.UpdatedAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_cache_sync_job_invalid");
            }
            RequireOptionalText(job.LeaseOwner, "bridge_cache_sync_lease_owner_invalid", 128);
            RequireOptionalTime(job.LeaseExpiresAtUtcMsc, "bridge_cache_sync_lease_invalid");
            RequireOptionalText(job.LastErrorCode, "bridge_cache_sync_error_invalid", 128);
            RequireOptionalText(job.LastErrorDetail, "bridge_cache_sync_error_detail_invalid", 4096);
        }

        private static bool IsSyncState(string state)
        {
            return state == "queued" || state == "running" || state == "retry_wait" || state == "completed" || state == "blocked" || state == "superseded";
        }

        private static void ValidateSyncResult(string jobId, string leaseOwner, long nowUtcMsc, long nextAttemptAtUtcMsc, string errorCode, string errorDetail)
        {
            RequireText(jobId, "bridge_cache_sync_job_id_invalid", 191);
            RequireText(leaseOwner, "bridge_cache_lease_owner_invalid", 128);
            RequireText(errorCode, "bridge_cache_sync_error_invalid", 128);
            RequireOptionalText(errorDetail, "bridge_cache_sync_error_detail_invalid", 4096);
            if (nowUtcMsc < 1 || nextAttemptAtUtcMsc < nowUtcMsc)
            {
                throw new InvalidDataException("bridge_cache_sync_retry_invalid");
            }
        }

        private static bool SyncJobMatches(SQLiteDataReader reader, long expectedConnectionEpoch, SyncJobRecord job)
        {
            string existingCursor = ReadNullableString(reader, 5);
            return Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture) == expectedConnectionEpoch
                && string.Equals(reader.GetString(1), job.Resource, StringComparison.Ordinal)
                && string.Equals(reader.GetString(2), job.ScopeKey, StringComparison.Ordinal)
                && Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture) == job.RangeStartUtcMsc
                && Convert.ToInt64(reader.GetValue(4), CultureInfo.InvariantCulture) == job.RangeEndUtcMsc
                && string.Equals(existingCursor, job.Cursor, StringComparison.Ordinal);
        }
    }
}
