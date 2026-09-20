using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class RuntimeSmokeTests
    {
        public static void TestProfileRegistryIsolation()
        {
            string root = NewRoot("registry");
            try
            {
                ProfileRuntimeConfiguration first = Configuration(root, "profile-a", "terminal-a", "10001", 1);
                ProfileRuntimeConfiguration second = Configuration(root, "profile-b", "terminal-b", "10002", 1);
                using (ProfileRuntimeRegistry registry = new ProfileRuntimeRegistry())
                {
                    ProfileRuntime runtimeA = registry.Open(first);
                    ProfileRuntime runtimeB = registry.Open(second);
                    Assert(registry.Count == 2 && !object.ReferenceEquals(runtimeA.DataStore, runtimeB.DataStore), "runtime_profiles_not_isolated");
                    ProfileOutboxCoordinator outbox = new ProfileOutboxCoordinator();
                    outbox.Enqueue(runtimeA, "epoch-1-message", "query.response", "{}", 1, 1788307200000);
                    ProfileRuntime rebound = registry.Open(Configuration(root, "profile-a", "terminal-a", "10001", 2));
                    Assert(object.ReferenceEquals(runtimeA, rebound) && runtimeA.ConnectionEpoch == 2, "runtime_epoch_not_rebound");
                    Assert(outbox.ReadPending(runtimeA, 1788307200001, 10, null).Items.Count == 0, "old_epoch_outbox_leaked");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        registry.Open(Configuration(root, "profile-a", "terminal-other", "10001", 3));
                    }, "runtime_identity_changed_without_replace");
                    ProfileRuntime replaced = registry.Replace(Configuration(root, "profile-a", "terminal-c", "10003", 1));
                    Assert(replaced.Configuration.TerminalInstanceId == "terminal-c" && registry.Count == 2, "runtime_profile_replace_failed");
                    Assert(registry.Remove("profile-b") && registry.Count == 1, "runtime_profile_remove_failed");
                }
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        public static void TestProjectionGapHitAndSnapshot()
        {
            string root = NewRoot("projection");
            long now = 1788307200000;
            try
            {
                using (ProfileRuntime runtime = new ProfileRuntime(Configuration(root, "profile-a", "terminal-a", "10001", 1)))
                {
                    ProjectionQueryCoordinator queries = new ProjectionQueryCoordinator();
                    ProjectionQueryRequest request = CandleRequest(null, null);
                    ProjectionQueryResult gap = queries.Query(runtime, request, now);
                    Assert(gap.Status == "refreshing" && gap.SyncJobId.StartsWith("sync-", StringComparison.Ordinal), "projection_gap_not_queued");

                    ProjectionSyncCoordinator sync = new ProjectionSyncCoordinator();
                    CandleSource source = new CandleSource(now);
                    ProjectionSyncRunResult firstSync = sync.RunOne(runtime, source, "worker-a", now + 1);
                    Assert(firstSync.Status == "continued" && firstSync.ItemCount == 1, "projection_sync_not_continued");
                    Assert(runtime.DataStore.ReadSyncJob(gap.SyncJobId).Cursor == "page-2", "projection_sync_cursor_not_saved");
                    Assert(runtime.DataStore.ReadCoverage("market.candles", "XAUUSD|M5").Count == 0,
                        "partial_projection_published_coverage");
                    Assert(queries.Query(runtime, CandleRequest(null, null), now + 1).Status == "refreshing",
                        "partial_projection_exposed_as_complete");
                    ProjectionSyncRunResult synced = sync.RunOne(runtime, source, "worker-a", now + 2);
                    Assert(synced.Status == "completed" && synced.ItemCount == 1, "projection_sync_not_completed");

                    ProjectionQueryResult first = queries.Query(runtime, CandleRequest(null, null), now + 3);
                    Assert(first.Status == "ready" && first.Source == "local_projection" && first.Candles.Items.Count == 1 && first.Candles.HasMore, "projection_cache_hit_wrong");
                    ProjectionQueryResult second = queries.Query(runtime, CandleRequest(first.SnapshotId, first.Candles.NextCursor), now + 4);
                    Assert(second.Candles.Items.Count == 1 && second.Candles.Items[0].OpenTimeUtcMsc == now + 1000, "projection_cursor_wrong");

                    runtime.DataStore.UpsertCoverage(1, new CoverageRangeRecord
                    {
                        Resource = "market.candles",
                        ScopeKey = "XAUUSD|M5",
                        RangeStartUtcMsc = now,
                        RangeEndUtcMsc = now + 2000,
                        Completeness = "complete",
                        SourceRevision = "revision-2",
                        UpdatedAtUtcMsc = now + 5
                    });
                    AssertThrows<InvalidDataException>(delegate
                    {
                        queries.Query(runtime, CandleRequest(first.SnapshotId, first.Candles.NextCursor), now + 6);
                    }, "projection_stale_snapshot_accepted");
                    runtime.DataStore.UpsertCoverage(1, new CoverageRangeRecord {
                        Resource = "history.orders", ScopeKey = "*", RangeStartUtcMsc = now,
                        RangeEndUtcMsc = now + 2000, Completeness = "complete", SourceRevision = "history-1", UpdatedAtUtcMsc = now + 5 });
                    var history = new ProjectionQueryRequest { Resource = "history.orders", ScopeKey = "*",
                        RangeStartUtcMsc = now, RangeEndUtcMsc = now + 3000, Limit = 1 };
                    var tail = queries.Query(runtime, history, now + 6);
                    Assert(runtime.DataStore.ReadSyncJob(tail.SyncJobId).RangeStartUtcMsc == now + 2000, "history_rescanned_cached_prefix");
                    Assert(queries.Query(runtime, history, now + 7).SyncJobId == tail.SyncJobId, "history_tail_job_not_reused");
                }
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        public static void TestProjectionFetchDoesNotBlockCommands()
        {
            string root = NewRoot("nonblocking");
            long now = 1788307200000;
            try
            {
                using (ProfileRuntime runtime = new ProfileRuntime(Configuration(root, "profile-a", "terminal-a", "10001", 1)))
                {
                    ProjectionQueryCoordinator queries = new ProjectionQueryCoordinator();
                    ProjectionQueryRequest request = new ProjectionQueryRequest
                    {
                        Resource = "history.orders",
                        ScopeKey = "*",
                        RangeStartUtcMsc = now,
                        RangeEndUtcMsc = now + 1000,
                        Limit = 100
                    };
                    queries.Query(runtime, request, now);
                    BlockingSource source = new BlockingSource(now);
                    Exception workerError = null;
                    Thread worker = new Thread(new ThreadStart(delegate
                    {
                        try
                        {
                            new ProjectionSyncCoordinator().RunOne(runtime, source, "worker-a", now + 1);
                        }
                        catch (Exception error)
                        {
                            workerError = error;
                        }
                    }));
                    worker.Start();
                    Assert(source.Entered.WaitOne(5000), "projection_source_not_entered");
                    Stopwatch elapsed = Stopwatch.StartNew();
                    CommandAcceptance accepted = runtime.CommandLedger.Accept(
                        "profile-a", "command-1", "idempotency-1", "position.close", "hash-1", now + 2);
                    elapsed.Stop();
                    Assert(!accepted.Duplicate && elapsed.ElapsedMilliseconds < 1000, "terminal_fetch_blocked_command_ledger");
                    source.Release.Set();
                    Assert(worker.Join(5000) && workerError == null, "projection_worker_failed");
                }
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        public static void TestOutboxAndPersistedAck()
        {
            string root = NewRoot("outbox");
            long now = 1788307200000;
            try
            {
                using (ProfileRuntime runtime = new ProfileRuntime(Configuration(root, "profile-a", "terminal-a", "10001", 1)))
                {
                    ProfileOutboxCoordinator outbox = new ProfileOutboxCoordinator();
                    const string envelopeJson = "{\"v\":4,\"message_id\":\"response-1\",\"type\":\"query.response\",\"sent_at_utc_msc\":1788307200000,\"correlation_id\":\"request-1\",\"route\":{\"terminal_instance_id\":\"terminal-a\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"connection_epoch\":1},\"payload\":{}}";
                    Assert(outbox.Enqueue(runtime, "response-1", "query.response", envelopeJson, 5, now), "outbox_enqueue_failed");
                    RecordingSink sink = new RecordingSink();
                    Assert(outbox.FlushOne(runtime, sink, now) && sink.Messages.Count == 1, "outbox_flush_failed");
                    Assert(outbox.ReadPending(runtime, now, 10, null).Items.Count == 0, "outbox_immediate_resend_not_delayed");
                    Assert(outbox.AcknowledgeMessage(runtime, "response-1", now + 1), "outbox_ack_failed");

                    const string ackJson = "{\"v\":4,\"message_id\":\"ack-1\",\"type\":\"data.persisted.ack\",\"sent_at_utc_msc\":1788307200002,\"correlation_id\":null,\"route\":{\"terminal_instance_id\":\"terminal-a\",\"account_ref\":{\"broker_server\":\"Demo\",\"login\":\"10001\"},\"connection_epoch\":1},\"payload\":{\"resource\":\"market.candles\",\"scope_key\":\"XAUUSD|M5\",\"range_start_utc_msc\":1788307200000,\"range_end_utc_msc\":1788307202000,\"source_revision\":\"revision-1\",\"status\":\"duplicate\",\"persisted_at_utc_msc\":1788307200002}}";
                    outbox.ApplyPersistedAck(runtime, BridgeEnvelope.Parse(ackJson));
                    Assert(runtime.DataStore.IsServerRangeAcknowledged("market.candles", "XAUUSD|M5", now, now + 2000, "revision-1"), "persisted_ack_not_recorded");
                }
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        private static ProjectionQueryRequest CandleRequest(string snapshotId, CandleCursor cursor)
        {
            return new ProjectionQueryRequest
            {
                Resource = "market.candles",
                ScopeKey = "XAUUSD|M5",
                RangeStartUtcMsc = 1788307200000,
                RangeEndUtcMsc = 1788307202000,
                Limit = 1,
                SnapshotId = snapshotId,
                CandleCursor = cursor
            };
        }

        private static ProfileRuntimeConfiguration Configuration(
            string root, string profileId, string terminalId, string login, long epoch)
        {
            return new ProfileRuntimeConfiguration(
                Path.Combine(root, profileId + "-" + terminalId + ".sqlite3"),
                profileId, terminalId, "mt5", "Demo", login, epoch);
        }

        private static string NewRoot(string name)
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-runtime-" + name + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static void DeleteRoot(string root)
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, true);
            }
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try
            {
                action();
            }
            catch (T)
            {
                return;
            }
            throw new InvalidOperationException(message);
        }

        private sealed class CandleSource : ITerminalProjectionSource
        {
            private readonly long now;

            public CandleSource(long nowUtcMsc)
            {
                now = nowUtcMsc;
            }

            public ProjectionSyncBatch Fetch(ProjectionSyncRequest request)
            {
                bool secondPage = request.Cursor == "page-2";
                return new ProjectionSyncBatch
                {
                    Resource = request.Resource,
                    ScopeKey = request.ScopeKey,
                    CoveredRangeStartUtcMsc = now,
                    CoveredRangeEndUtcMsc = secondPage ? now + 2000 : now + 1000,
                    SourceRevision = "revision-1",
                    PublishCoverage = secondPage,
                    Candles = new List<CandleRecord>
                    {
                        NewCandle(secondPage ? now + 1000 : now)
                    },
                    HasMore = !secondPage,
                    NextCursor = secondPage ? null : "page-2"
                };
            }

            private static CandleRecord NewCandle(long openTime)
            {
                return new CandleRecord
                {
                    Symbol = "XAUUSD",
                    Timeframe = "M5",
                    OpenTimeUtcMsc = openTime,
                    Open = 1,
                    High = 2,
                    Low = 0.5,
                    Close = 1.5,
                    TickVolume = 10,
                    RealVolume = 0,
                    Spread = 0.2,
                    Closed = true,
                    SourceRevision = "revision-1",
                    ObservedAtUtcMsc = openTime + 1,
                    LastAccessedUtcMsc = openTime + 1
                };
            }
        }

        private sealed class BlockingSource : ITerminalProjectionSource
        {
            private readonly long now;

            public BlockingSource(long nowUtcMsc)
            {
                now = nowUtcMsc;
                Entered = new ManualResetEvent(false);
                Release = new ManualResetEvent(false);
            }

            public ManualResetEvent Entered { get; private set; }
            public ManualResetEvent Release { get; private set; }

            public ProjectionSyncBatch Fetch(ProjectionSyncRequest request)
            {
                Entered.Set();
                if (!Release.WaitOne(5000))
                {
                    throw new TimeoutException("test_release_timeout");
                }
                return new ProjectionSyncBatch
                {
                    Resource = request.Resource,
                    ScopeKey = request.ScopeKey,
                    CoveredRangeStartUtcMsc = request.RangeStartUtcMsc,
                    CoveredRangeEndUtcMsc = request.RangeEndUtcMsc,
                    SourceRevision = "revision-1",
                    PublishCoverage = true,
                    History = new List<HistoryItemRecord>()
                };
            }
        }

        private sealed class RecordingSink : IBridgeMessageSink
        {
            public RecordingSink()
            {
                Messages = new List<string>();
            }

            public IList<string> Messages { get; private set; }

            public void Send(string envelopeJson)
            {
                Messages.Add(envelopeJson);
            }
        }
    }
}
