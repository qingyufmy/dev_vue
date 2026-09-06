using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static partial class SessionLifecycleSmokeTests
    {
        public static void TestWorkerPauseDuringConnectResumes()
        {
            string root = NewRoot("pause-during-connect");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                using (BlockingConnectFactory factory = new BlockingConnectFactory())
                {
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), factory);
                    Thread pause = null;
                    bool paused = false;
                    Exception pauseError = null;
                    try
                    {
                        worker.Start();
                        Assert(factory.Entered.WaitOne(3000), "pause_connect_not_entered");
                        pause = new Thread(delegate()
                        {
                            try { paused = worker.PauseForUpdate(3000); }
                            catch (Exception error) { pauseError = error; }
                        });
                        pause.Start();
                        WaitUntil(delegate { return worker.State == "update_wait"; }, 1000, "connect_pause_not_requested");
                        factory.Release.Set();
                        Assert(pause.Join(4000) && paused && pauseError == null, "connect_pause_not_completed");
                        Assert(factory.Channel.Sends == 0, "paused_connect_sent_hello");
                        worker.ResumeAfterUpdate();
                        WaitUntil(delegate { return factory.Connects >= 2 && factory.Channel.Sends > 0; }, 4000,
                            "resume_stuck_awaiting_welcome_after_paused_connect");
                    }
                    finally { factory.Release.Set(); if (pause != null) pause.Join(); worker.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestWorkerStopRejectsLateConnect()
        {
            string root = NewRoot("stop-late-connect");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                using (BlockingConnectFactory factory = new BlockingConnectFactory())
                {
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), factory);
                    try
                    {
                        worker.Start();
                        Assert(factory.Entered.WaitOne(3000), "connect_not_entered");
                        bool pending = false;
                        try { worker.Dispose(); } catch (TimeoutException) { pending = true; }
                        Assert(pending && worker.State == "stopping" && worker.ConnectionId == null,
                            "long_connect_not_retained_as_stopping");
                        factory.Release.Set();
                        worker.Dispose();
                        Assert(factory.Channel.Sends == 0 && factory.Channel.CloseCalls > 0,
                            "late_connection_sent_hello_or_leaked");
                        Assert(worker.State == "stopped", "stop_retry_not_completed");
                    }
                    finally { factory.Release.Set(); worker.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestWorkerStopRetainsRuntimeAndLease()
        {
            string root = NewRoot("stop-long-query");
            try
            {
                BridgeProfileSettings settings = ShutdownSettings("profile-a");
                ProfileRuntime runtime = Runtime(root);
                using (BlockingQuerySource source = new BlockingQuerySource())
                {
                    BridgeSessionController controller = new BridgeSessionController(runtime,
                        new BridgeProfileSession(runtime, source), new BridgeSessionConfiguration
                        {
                            InstallationId = "installation-123", BridgeVersion = "4.0.0", TerminalVersion = "1441",
                            TradePermission = "read_only", TimezoneOffsetMinutes = 180, ClockStatus = "calibrated"
                        });
                    ShutdownChannel channel = new ShutdownChannel(true, runtime);
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, controller, new SingleChannelFactory(channel));
                    IDisposable lease = ProfileAccountDataLocation.AcquireLease(root, settings);
                    IDisposable connection = Managed(runtime, worker, lease);
                    try
                    {
                        worker.Start();
                        Assert(source.Entered.WaitOne(3000), "query_not_entered");
                        bool pending = false;
                        try { connection.Dispose(); } catch (TimeoutException) { pending = true; }
                        Assert(pending && worker.ActiveOperations > 0 && worker.State == "stopping",
                            "long_query_stop_not_bounded");
                        bool locked = false;
                        try { using (ProfileAccountDataLocation.AcquireLease(root, settings)) { } }
                        catch (IOException) { locked = true; }
                        Assert(locked, "profile_lease_released_while_query_active");
                        Assert(runtime.ConnectionEpoch == 2, "runtime_released_while_query_active");
                        source.Release.Set();
                        connection.Dispose();
                        Assert(channel.QueryResponses == 0, "late_query_response_sent_after_stop");
                        using (ProfileAccountDataLocation.AcquireLease(root, settings)) { }
                        Assert(worker.State == "stopped", "query_stop_retry_failed");
                    }
                    finally { source.Release.Set(); connection.Dispose(); runtime.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestManagerRetriesFailedCloseAndCleansOtherProfiles()
        {
            string root = NewRoot("stop-close-failure");
            try
            {
                using (TerminalSessionHost host = new TerminalSessionHost("offline-unused"))
                {
                    BridgeProfileStore store = new BridgeProfileStore(Path.Combine(root, "profiles.json"), new CurrentUserSecretProtector());
                    BridgeProfileConnectionManager manager = new BridgeProfileConnectionManager(host, store,
                        "installation-test", root, new UnusedTokens());
                    ProfileRuntime runtime = Runtime(root);
                    ShutdownChannel channel = new ShutdownChannel(false, runtime) { FailClose = true };
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), new SingleChannelFactory(channel));
                    CountingLease firstLease = new CountingLease();
                    CountingLease otherLease = new CountingLease();
                    IDictionary connections = (IDictionary)typeof(BridgeProfileConnectionManager)
                        .GetField("connections", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(manager);
                    connections.Add("profile-a", Managed(runtime, worker, firstLease));
                    ProfileRuntime otherRuntime = Runtime(Path.Combine(root, "other"));
                    connections.Add("profile-other", Managed(otherRuntime,
                        new BridgeProfileWorker(otherRuntime, Controller(otherRuntime), new SingleChannelFactory(new ShutdownChannel(false, otherRuntime))), otherLease));
                    try
                    {
                        // Pause at the registration boundary: Stop must fence a creation
                        // that completed after cancellation without starting its worker.
                        Type attemptType = typeof(BridgeProfileConnectionManager).GetNestedType("StartAttempt", BindingFlags.NonPublic);
                        object attempt = Activator.CreateInstance(attemptType, true);
                        IDictionary pendingStarts = (IDictionary)typeof(BridgeProfileConnectionManager)
                            .GetField("pendingStarts", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(manager);
                        pendingStarts.Add("pending-profile", attempt);
                        Assert(manager.Stop("pending-profile"), "pending_start_not_cancelled");
                        bool registered = (bool)typeof(BridgeProfileConnectionManager)
                            .GetMethod("RegisterAndStart", BindingFlags.Instance | BindingFlags.NonPublic)
                            .Invoke(manager, new object[] { "pending-profile", attempt, connections["profile-other"] });
                        Assert(!registered && connections.Count == 2, "cancelled_creation_started_late");
                        pendingStarts.Remove("pending-profile");
                        ProfileRuntime cancelledRuntime = Runtime(Path.Combine(root, "cancelled"));
                        CountingLease cancelledLease = new CountingLease { FailClose = true };
                        IDisposable cancelled = Managed(cancelledRuntime,
                            new BridgeProfileWorker(cancelledRuntime, Controller(cancelledRuntime),
                                new SingleChannelFactory(new ShutdownChannel(false, cancelledRuntime))), cancelledLease);
                        MethodInfo cleanup = typeof(BridgeProfileConnectionManager)
                            .GetMethod("DisposeAfterStartFailure", BindingFlags.Instance | BindingFlags.NonPublic);
                        bool retained = false;
                        try { cleanup.Invoke(manager, new object[] { "cancelled-profile", cancelled }); }
                        catch (TargetInvocationException error) { retained = error.InnerException is IOException; }
                        Assert(retained && connections.Contains("cancelled-profile"), "unregistered_cleanup_failure_lost_lease");
                        cancelledLease.FailClose = false;
                        Assert(manager.Stop("cancelled-profile") && !connections.Contains("cancelled-profile")
                            && cancelledLease.Closes == 1, "unregistered_cleanup_not_retryable");
                        BridgeProfileSettings partialSettings = ShutdownSettings("partial-profile");
                        string corrupt = Path.Combine(root, "profiles", partialSettings.ProfileId, "bridge.db");
                        Directory.CreateDirectory(Path.GetDirectoryName(corrupt));
                        File.WriteAllText(corrupt, "invalid sqlite");
                        CountingLease partialLease = new CountingLease { FailClose = true };
                        MethodInfo create = typeof(BridgeProfileConnectionManager).GetMethod("Create",
                            BindingFlags.Instance | BindingFlags.NonPublic, null,
                            new[] { typeof(BridgeProfileSettings), typeof(IDisposable) }, null);
                        retained = false;
                        try { create.Invoke(manager, new object[] { partialSettings, partialLease }); }
                        catch (TargetInvocationException error) { retained = error.InnerException is IOException; }
                        Assert(retained && connections.Contains("partial-profile") && partialLease.Closes == 0,
                            "partial_creation_cleanup_lost_lease");
                        Assert(manager.Snapshot(partialSettings).State == "stopping"
                            && manager.ReadUpdateActivity().PendingCriticalWrites > 0,
                            "partial_cleanup_not_observable");
                        manager.ReadObservedReleases();
                        partialLease.FailClose = false;
                        Assert(manager.Stop("partial-profile") && partialLease.Closes == 1,
                            "partial_creation_cleanup_retry_failed");
                        worker.Start();
                        WaitUntil(delegate { return worker.State == "active"; }, 3000, "close_test_not_active");
                        bool failed = false;
                        try { manager.Stop("profile-a"); } catch (IOException) { failed = true; }
                        Assert(failed && connections.Count == 2 && firstLease.Closes == 0,
                            "failed_stop_forgot_connection_or_released_lease");
                        failed = false;
                        try { manager.Dispose(); } catch (AggregateException) { failed = true; }
                        Assert(failed && connections.Count == 1 && otherLease.Closes == 1 && firstLease.Closes == 0,
                            "one_close_failure_blocked_independent_cleanup");
                        channel.FailClose = false;
                        manager.Dispose();
                        manager.Dispose();
                        Assert(connections.Count == 0 && firstLease.Closes == 1, "manager_close_retry_failed");
                    }
                    finally { channel.FailClose = false; manager.Dispose(); runtime.Dispose(); otherRuntime.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        private static IDisposable Managed(ProfileRuntime runtime, BridgeProfileWorker worker, IDisposable lease)
        {
            Type type = typeof(BridgeProfileWorker).Assembly.GetType("Liangjian.BridgeV4.Runtime.ManagedProfileConnection", true);
            return (IDisposable)Activator.CreateInstance(type, new object[] { runtime, worker, "terminal-a", null, null, lease });
        }

        private static BridgeProfileSettings ShutdownSettings(string profileId)
        {
            return new BridgeProfileSettings { ProfileId = profileId, DisplayName = "test", Platform = "mt4",
                TerminalInstanceId = "terminal-a", BrokerServer = "Demo", Login = "10001",
                ServerUri = "wss://bridge.example.test/bridge/v4/ws", ProtectedRefreshToken = "protected" };
        }

        private sealed class CountingLease : IDisposable
        {
            public int Closes;
            public bool FailClose;
            public void Dispose() { if (FailClose) throw new IOException("simulated_lease_close_failure"); Closes++; }
        }

        private sealed class UnusedTokens : IBridgeSessionTokenProvider
        {
            public BridgeSessionToken Acquire(BridgeProfileSettings profile, string refreshToken)
            { throw new InvalidOperationException("offline_test_must_not_connect"); }
        }

        private sealed class SingleChannelFactory : IBridgeMessageChannelFactory
        {
            private readonly IBridgeMessageChannel channel;
            public SingleChannelFactory(IBridgeMessageChannel value) { channel = value; }
            public IBridgeMessageChannel Connect() { return channel; }
        }

        private sealed class BlockingConnectFactory : IBridgeMessageChannelFactory, IDisposable
        {
            public readonly ManualResetEvent Entered = new ManualResetEvent(false);
            public readonly ManualResetEvent Release = new ManualResetEvent(false);
            public readonly ShutdownChannel Channel = new ShutdownChannel(false, null);
            public int Connects;
            public IBridgeMessageChannel Connect() { Interlocked.Increment(ref Connects); Entered.Set(); Release.WaitOne(); return Channel; }
            public void Dispose() { Entered.Dispose(); Release.Dispose(); }
        }

        private sealed class BlockingQuerySource : ITerminalQuerySource, IDisposable
        {
            public readonly ManualResetEvent Entered = new ManualResetEvent(false);
            public readonly ManualResetEvent Release = new ManualResetEvent(false);
            public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
            {
                Entered.Set(); Release.WaitOne();
                return new StaticTerminalSource().Query(runtime, request, nowUtcMsc);
            }
            public void Dispose() { Entered.Dispose(); Release.Dispose(); }
        }

        private sealed class ShutdownChannel : IBridgeMessageChannel
        {
            private readonly bool query;
            private readonly ProfileRuntime runtime;
            private readonly ManualResetEvent closed = new ManualResetEvent(false);
            private string sessionId;
            private int reads;
            public int Sends;
            public int CloseCalls;
            public int QueryResponses;
            public volatile bool FailClose;
            public ShutdownChannel(bool queryValue, ProfileRuntime runtimeValue) { query = queryValue; runtime = runtimeValue; }
            public void Send(string json)
            {
                Interlocked.Increment(ref Sends);
                IDictionary<string, object> envelope = Parse(json);
                if ((string)envelope["type"] == "session.hello") sessionId = (string)Object(envelope, "payload")["session_id"];
                if ((string)envelope["type"] == "query.response") Interlocked.Increment(ref QueryResponses);
            }
            public string Receive()
            {
                int count = Interlocked.Increment(ref reads);
                if (count == 1) return Welcome(sessionId, "shutdown-connection");
                if (count == 2 && query)
                {
                    long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    return Query(runtime.ConnectionEpoch, now);
                }
                closed.WaitOne(); return null;
            }
            public void Dispose()
            {
                Interlocked.Increment(ref CloseCalls);
                closed.Set();
                if (FailClose) throw new IOException("simulated_channel_close_failure");
            }
        }
    }
}
