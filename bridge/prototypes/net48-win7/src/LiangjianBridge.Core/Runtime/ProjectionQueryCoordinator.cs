using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class ProjectionQueryRequest
    {
        public string Resource { get; set; }
        public string ScopeKey { get; set; }
        public long RangeStartUtcMsc { get; set; }
        public long RangeEndUtcMsc { get; set; }
        public int Limit { get; set; }
        public string SnapshotId { get; set; }
        public CandleCursor CandleCursor { get; set; }
        public HistoryCursor HistoryCursor { get; set; }
    }

    public sealed class ProjectionQueryResult
    {
        public string Status { get; set; }
        public string Source { get; set; }
        public string Completeness { get; set; }
        public string SnapshotId { get; set; }
        public string SourceRevision { get; set; }
        public long ObservedAtUtcMsc { get; set; }
        public string SyncJobId { get; set; }
        public CandlePage Candles { get; set; }
        public HistoryPage History { get; set; }
    }

    public sealed class ProjectionQueryCoordinator
    {
        private const long SnapshotLifetimeMsc = 15L * 60L * 1000L;

        public ProjectionQueryResult Query(ProfileRuntime runtime, ProjectionQueryRequest request, long nowUtcMsc)
        {
            Validate(runtime, request, nowUtcMsc);
            string queryHash = ComputeQueryHash(request);
            IList<CoverageRangeRecord> coverage = runtime.DataStore.ReadCoverage(request.Resource, request.ScopeKey);
            string coverageFingerprint;
            if (!TryGetCompleteFingerprint(coverage, request.RangeStartUtcMsc, request.RangeEndUtcMsc, out coverageFingerprint))
            {
                string jobId = "sync-" + Hash(queryHash + "|" + runtime.ConnectionEpoch.ToString(CultureInfo.InvariantCulture));
                SyncJobRecord existing = runtime.DataStore.ReadSyncJob(jobId);
                if (existing == null)
                {
                    long syncStart = request.RangeStartUtcMsc;
                    if (request.Resource.StartsWith("history.", StringComparison.Ordinal))
                    {
                        foreach (CoverageRangeRecord row in coverage)
                        {
                            if (row.Completeness != "complete" || row.RangeEndUtcMsc <= syncStart) continue;
                            if (row.RangeStartUtcMsc > syncStart) break;
                            syncStart = Math.Min(request.RangeEndUtcMsc, row.RangeEndUtcMsc);
                        }
                    }
                    runtime.DataStore.EnqueueSyncJob(runtime.ConnectionEpoch, new SyncJobRecord
                    {
                        JobId = jobId,
                        ConnectionEpoch = runtime.ConnectionEpoch,
                        Resource = request.Resource,
                        ScopeKey = request.ScopeKey,
                        RangeStartUtcMsc = syncStart,
                        RangeEndUtcMsc = request.RangeEndUtcMsc,
                        State = "queued",
                        Attempt = 0,
                        NextAttemptAtUtcMsc = nowUtcMsc,
                        CreatedAtUtcMsc = nowUtcMsc,
                        UpdatedAtUtcMsc = nowUtcMsc
                    });
                }
                else
                {
                    ValidateExistingJob(runtime, request, existing);
                    if (existing.State == "blocked")
                    {
                        return new ProjectionQueryResult
                        {
                            Status = "blocked",
                            Source = "terminal_sync_queue",
                            Completeness = "blocked",
                            SyncJobId = jobId
                        };
                    }
                    if (existing.State == "completed" || existing.State == "superseded")
                    {
                        runtime.DataStore.RestartSyncJob(runtime.ConnectionEpoch, jobId, nowUtcMsc);
                    }
                }
                return new ProjectionQueryResult
                {
                    Status = "refreshing",
                    Source = "terminal_sync_queue",
                    Completeness = "refreshing",
                    SyncJobId = jobId
                };
            }

            QuerySnapshotRecord snapshot = ResolveSnapshot(runtime, request, queryHash, coverageFingerprint, nowUtcMsc);
            ProjectionQueryResult result = ReadPage(runtime, request, snapshot);
            string afterFingerprint;
            if (!TryGetCompleteFingerprint(runtime.DataStore.ReadCoverage(request.Resource, request.ScopeKey), request.RangeStartUtcMsc, request.RangeEndUtcMsc, out afterFingerprint)
                || !string.Equals(snapshot.FrozenRevision, afterFingerprint, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_projection_snapshot_stale");
            }
            return result;
        }

        private static void ValidateExistingJob(ProfileRuntime runtime, ProjectionQueryRequest request, SyncJobRecord job)
        {
            if (job.ConnectionEpoch != runtime.ConnectionEpoch
                || job.Resource != request.Resource || job.ScopeKey != request.ScopeKey
                || job.RangeStartUtcMsc < request.RangeStartUtcMsc || job.RangeStartUtcMsc >= request.RangeEndUtcMsc
                || (request.Resource == "market.candles" && job.RangeStartUtcMsc != request.RangeStartUtcMsc)
                || job.RangeEndUtcMsc != request.RangeEndUtcMsc)
            {
                throw new InvalidDataException("bridge_projection_sync_job_conflict");
            }
        }

        private static QuerySnapshotRecord ResolveSnapshot(
            ProfileRuntime runtime,
            ProjectionQueryRequest request,
            string queryHash,
            string coverageFingerprint,
            long nowUtcMsc)
        {
            QuerySnapshotRecord snapshot;
            if (string.IsNullOrEmpty(request.SnapshotId))
            {
                snapshot = new QuerySnapshotRecord
                {
                    SnapshotId = "snapshot-" + Guid.NewGuid().ToString("N"),
                    ConnectionEpoch = runtime.ConnectionEpoch,
                    Resource = request.Resource,
                    ScopeKey = request.ScopeKey,
                    QueryHash = queryHash,
                    FrozenRevision = coverageFingerprint,
                    RangeStartUtcMsc = request.RangeStartUtcMsc,
                    RangeEndUtcMsc = request.RangeEndUtcMsc,
                    CreatedAtUtcMsc = nowUtcMsc,
                    ExpiresAtUtcMsc = checked(nowUtcMsc + SnapshotLifetimeMsc)
                };
                return runtime.DataStore.CreateQuerySnapshot(runtime.ConnectionEpoch, snapshot);
            }

            snapshot = runtime.DataStore.ReadQuerySnapshot(request.SnapshotId);
            if (snapshot == null)
            {
                throw new InvalidDataException("bridge_projection_snapshot_missing");
            }
            if (snapshot.ConnectionEpoch != runtime.ConnectionEpoch
                || snapshot.ExpiresAtUtcMsc <= nowUtcMsc
                || !string.Equals(snapshot.Resource, request.Resource, StringComparison.Ordinal)
                || !string.Equals(snapshot.ScopeKey, request.ScopeKey, StringComparison.Ordinal)
                || !string.Equals(snapshot.QueryHash, queryHash, StringComparison.Ordinal)
                || !string.Equals(snapshot.FrozenRevision, coverageFingerprint, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_projection_snapshot_stale");
            }
            return snapshot;
        }

        private static ProjectionQueryResult ReadPage(ProfileRuntime runtime, ProjectionQueryRequest request, QuerySnapshotRecord snapshot)
        {
            ProjectionQueryResult result = new ProjectionQueryResult
            {
                Status = "ready",
                Source = "local_projection",
                Completeness = "complete",
                SnapshotId = snapshot.SnapshotId,
                SourceRevision = snapshot.FrozenRevision,
                ObservedAtUtcMsc = snapshot.CreatedAtUtcMsc
            };
            if (request.Resource == "market.candles")
            {
                string[] scope = request.ScopeKey.Split('|');
                result.Candles = runtime.DataStore.ReadCandles(
                    scope[0], scope[1], request.RangeStartUtcMsc, request.RangeEndUtcMsc,
                    request.Limit, request.CandleCursor);
                if (result.Candles.Items.Count > 0)
                {
                    result.ObservedAtUtcMsc = result.Candles.Items[result.Candles.Items.Count - 1].ObservedAtUtcMsc;
                }
            }
            else
            {
                result.History = runtime.DataStore.ReadHistory(
                    HistoryKind(request.Resource), request.RangeStartUtcMsc, request.RangeEndUtcMsc,
                    request.Limit, request.HistoryCursor);
                // History completeness belongs to the frozen query snapshot, not its last trade.
                // All pages (including empty ones) retain the same observation time.
            }
            return result;
        }

        private static void Validate(ProfileRuntime runtime, ProjectionQueryRequest request, long nowUtcMsc)
        {
            if (runtime == null || request == null || nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_projection_query_invalid");
            }
            if (request.RangeStartUtcMsc < 1 || request.RangeEndUtcMsc <= request.RangeStartUtcMsc
                || request.Limit < 1 || request.Limit > ProfileDataStore.MaxPageSize)
            {
                throw new InvalidDataException("bridge_projection_query_invalid");
            }
            bool candles = request.Resource == "market.candles";
            bool history = request.Resource == "history.orders" || request.Resource == "history.trades" || request.Resource == "history.deals";
            if (!candles && !history)
            {
                throw new InvalidDataException("bridge_projection_resource_invalid");
            }
            if (candles)
            {
                string[] scope = (request.ScopeKey ?? string.Empty).Split('|');
                if (scope.Length != 2 || string.IsNullOrWhiteSpace(scope[0]) || string.IsNullOrWhiteSpace(scope[1]) || request.HistoryCursor != null)
                {
                    throw new InvalidDataException("bridge_projection_scope_invalid");
                }
            }
            else if (request.ScopeKey != "*" || request.CandleCursor != null)
            {
                throw new InvalidDataException("bridge_projection_scope_invalid");
            }
        }

        private static string ComputeQueryHash(ProjectionQueryRequest request)
        {
            return Hash(request.Resource + "|" + request.ScopeKey + "|"
                + request.RangeStartUtcMsc.ToString(CultureInfo.InvariantCulture) + "|"
                + request.RangeEndUtcMsc.ToString(CultureInfo.InvariantCulture));
        }

        private static bool TryGetCompleteFingerprint(
            IList<CoverageRangeRecord> coverage,
            long rangeStartUtcMsc,
            long rangeEndUtcMsc,
            out string fingerprint)
        {
            long coveredUntil = rangeStartUtcMsc;
            StringBuilder evidence = new StringBuilder();
            for (int i = 0; i < coverage.Count; i++)
            {
                CoverageRangeRecord row = coverage[i];
                if (row.Completeness != "complete" || row.RangeEndUtcMsc <= rangeStartUtcMsc || row.RangeStartUtcMsc >= rangeEndUtcMsc)
                {
                    continue;
                }
                if (row.RangeStartUtcMsc > coveredUntil && coveredUntil < rangeEndUtcMsc)
                {
                    fingerprint = null;
                    return false;
                }
                if (row.RangeEndUtcMsc > coveredUntil)
                {
                    coveredUntil = row.RangeEndUtcMsc;
                }
                evidence.Append(row.RangeStartUtcMsc.ToString(CultureInfo.InvariantCulture)).Append(':')
                    .Append(row.RangeEndUtcMsc.ToString(CultureInfo.InvariantCulture)).Append(':')
                    .Append(row.SourceRevision ?? string.Empty).Append(':')
                    .Append(row.UpdatedAtUtcMsc.ToString(CultureInfo.InvariantCulture)).Append(';');
            }
            if (coveredUntil >= rangeEndUtcMsc)
            {
                fingerprint = Hash(evidence.ToString());
                return true;
            }
            fingerprint = null;
            return false;
        }

        private static string HistoryKind(string resource)
        {
            return resource.Substring("history.".Length);
        }

        internal static string Hash(string value)
        {
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] bytes = algorithm.ComputeHash(Encoding.UTF8.GetBytes(value));
                StringBuilder text = new StringBuilder(bytes.Length * 2);
                for (int i = 0; i < bytes.Length; i++)
                {
                    text.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
                }
                return text.ToString();
            }
        }
    }
}
