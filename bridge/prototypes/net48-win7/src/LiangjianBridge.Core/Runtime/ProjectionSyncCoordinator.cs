using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.Runtime
{
    public interface ITerminalProjectionSource
    {
        ProjectionSyncBatch Fetch(ProjectionSyncRequest request);
    }

    public sealed class ProjectionSyncRequest
    {
        public string ProfileId { get; set; }
        public string TerminalInstanceId { get; set; }
        public string Platform { get; set; }
        public string BrokerServer { get; set; }
        public string Login { get; set; }
        public long ConnectionEpoch { get; set; }
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public long RangeStartUtcMsc { get; set; }
        public long RangeEndUtcMsc { get; set; }
        public string Cursor { get; set; }
        public int Limit { get; set; }
    }

    public sealed class ProjectionSyncBatch
    {
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public long CoveredRangeStartUtcMsc { get; set; }
        public long CoveredRangeEndUtcMsc { get; set; }
        public string SourceRevision { get; set; }
        public IList<CandleRecord> Candles { get; set; }
        public IList<HistoryItemRecord> History { get; set; }
        public bool PublishCoverage { get; set; }
        public bool HasMore { get; set; }
        public string NextCursor { get; set; }
    }

    public sealed class ProjectionSyncRunResult
    {
        public string Status { get; set; }
        public string JobId { get; set; }
        public int ItemCount { get; set; }
    }

    public sealed class ProjectionSyncCoordinator
    {
        private const long LeaseDurationMsc = 30000;
        private const long RetryDelayMsc = 5000;

        public ProjectionSyncRunResult RunOne(
            ProfileRuntime runtime,
            ITerminalProjectionSource source,
            string leaseOwner,
            long nowUtcMsc)
        {
            if (runtime == null || source == null || string.IsNullOrWhiteSpace(leaseOwner) || nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_projection_sync_invalid");
            }
            SyncJobRecord job = runtime.DataStore.ClaimSyncJob(runtime.ConnectionEpoch, leaseOwner, nowUtcMsc, LeaseDurationMsc);
            if (job == null)
            {
                return new ProjectionSyncRunResult { Status = "idle" };
            }

            Stopwatch elapsed = Stopwatch.StartNew();
            ProjectionSyncBatch batch;
            try
            {
                ProfileRuntimeConfiguration route = runtime.Configuration;
                batch = source.Fetch(new ProjectionSyncRequest
                {
                    ProfileId = route.ProfileId,
                    TerminalInstanceId = route.TerminalInstanceId,
                    Platform = route.Platform,
                    BrokerServer = route.BrokerServer,
                    Login = route.Login,
                    ConnectionEpoch = runtime.ConnectionEpoch,
                    Resource = job.Resource,
                    ScopeKey = job.ScopeKey,
                    RangeStartUtcMsc = job.RangeStartUtcMsc,
                    RangeEndUtcMsc = job.RangeEndUtcMsc,
                    Cursor = job.Cursor,
                    Limit = ProfileDataStore.MaxBatchSize
                });
            }
            catch (Exception error)
            {
                long failedAtUtcMsc = checked(nowUtcMsc + elapsed.ElapsedMilliseconds);
                if (!runtime.DataStore.RetrySyncJob(runtime.ConnectionEpoch, job.JobId, leaseOwner,
                    failedAtUtcMsc, checked(failedAtUtcMsc + RetryDelayMsc), "terminal_projection_fetch_failed", Limit(error.Message, 1024)))
                {
                    throw new InvalidDataException("bridge_projection_sync_lease_lost");
                }
                return new ProjectionSyncRunResult { Status = "retry_wait", JobId = job.JobId };
            }

            long workAtUtcMsc = checked(nowUtcMsc + elapsed.ElapsedMilliseconds);
            if (!runtime.DataStore.RenewSyncJobLease(runtime.ConnectionEpoch, job.JobId, leaseOwner,
                workAtUtcMsc, checked(workAtUtcMsc + LeaseDurationMsc)))
            {
                throw new InvalidDataException("bridge_projection_sync_lease_lost");
            }

            int itemCount;
            try
            {
                ValidateBatch(job, batch);
                itemCount = PersistBatch(runtime, batch);
                if (batch.PublishCoverage)
                {
                    runtime.DataStore.UpsertCoverage(runtime.ConnectionEpoch, new CoverageRangeRecord
                    {
                        Resource = batch.Resource,
                        ScopeKey = batch.ScopeKey,
                        RangeStartUtcMsc = batch.CoveredRangeStartUtcMsc,
                        RangeEndUtcMsc = batch.CoveredRangeEndUtcMsc,
                        Completeness = "complete",
                        SourceRevision = batch.SourceRevision,
                        UpdatedAtUtcMsc = workAtUtcMsc
                    });
                }
            }
            catch (InvalidDataException error)
            {
                runtime.DataStore.BlockSyncJob(runtime.ConnectionEpoch, job.JobId, leaseOwner,
                    workAtUtcMsc, "terminal_projection_batch_invalid", Limit(error.Message, 1024));
                return new ProjectionSyncRunResult { Status = "blocked", JobId = job.JobId };
            }

            bool advanced = batch.HasMore
                ? runtime.DataStore.ContinueSyncJob(runtime.ConnectionEpoch, job.JobId, leaseOwner, workAtUtcMsc, batch.NextCursor)
                : runtime.DataStore.CompleteSyncJob(runtime.ConnectionEpoch, job.JobId, leaseOwner, workAtUtcMsc);
            if (!advanced)
            {
                throw new InvalidDataException("bridge_projection_sync_lease_lost");
            }
            return new ProjectionSyncRunResult
            {
                Status = batch.HasMore ? "continued" : "completed",
                JobId = job.JobId,
                ItemCount = itemCount
            };
        }

        private static int PersistBatch(ProfileRuntime runtime, ProjectionSyncBatch batch)
        {
            if (batch.Resource == "market.candles")
            {
                int count = batch.Candles == null ? 0 : batch.Candles.Count;
                if (count > 0)
                {
                    runtime.DataStore.UpsertClosedCandles(runtime.ConnectionEpoch, batch.Candles);
                }
                return count;
            }
            int historyCount = batch.History == null ? 0 : batch.History.Count;
            if (historyCount > 0)
            {
                runtime.DataStore.UpsertHistoryItems(runtime.ConnectionEpoch, batch.History);
            }
            return historyCount;
        }

        private static void ValidateBatch(SyncJobRecord job, ProjectionSyncBatch batch)
        {
            if (batch == null
                || !string.Equals(batch.Resource, job.Resource, StringComparison.Ordinal)
                || !string.Equals(batch.ScopeKey, job.ScopeKey, StringComparison.Ordinal)
                || batch.CoveredRangeStartUtcMsc < job.RangeStartUtcMsc
                || batch.CoveredRangeEndUtcMsc > job.RangeEndUtcMsc
                || batch.CoveredRangeEndUtcMsc <= batch.CoveredRangeStartUtcMsc
                || string.IsNullOrWhiteSpace(batch.SourceRevision)
                || (batch.HasMore && string.IsNullOrWhiteSpace(batch.NextCursor))
                || (!batch.HasMore && !batch.PublishCoverage))
            {
                throw new InvalidDataException("bridge_projection_sync_batch_invalid");
            }
            int candleCount = batch.Candles == null ? 0 : batch.Candles.Count;
            int historyCount = batch.History == null ? 0 : batch.History.Count;
            if (candleCount > ProfileDataStore.MaxBatchSize || historyCount > ProfileDataStore.MaxBatchSize
                || (batch.Resource == "market.candles" && historyCount != 0)
                || (batch.Resource != "market.candles" && candleCount != 0))
            {
                throw new InvalidDataException("bridge_projection_sync_batch_invalid");
            }
        }

        private static string Limit(string value, int maxLength)
        {
            if (string.IsNullOrEmpty(value))
            {
                return null;
            }
            return value.Length <= maxLength ? value : value.Substring(0, maxLength);
        }
    }
}
