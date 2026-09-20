using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static partial class SessionLifecycleSmokeTests
    {
        public static void TestIdentityObservationAgeAndPolling()
        {
            long utc = Now;
            int tick = 0;
            long observed = Now;
            BridgeTerminalIdentityMonitor monitor = new BridgeTerminalIdentityMonitor(
                delegate(long request) { return IdentityFacts(observed); }, delegate { return utc; }, delegate { return tick; });
            monitor.Read(utc);
            tick = 999;
            Assert(!monitor.ProbeDue() && !monitor.IsExpired(), "identity_probe_not_throttled");
            tick = 1000;
            Assert(monitor.ProbeDue(), "identity_probe_not_due_after_one_second");
            utc += 24000; tick = 24000;
            monitor.Read(utc);
            Assert(!monitor.IsExpired(), "recent_identity_expired_early");
            tick = 25000;
            Assert(monitor.IsExpired(), "delayed_identity_response_renewed_old_observation");
            utc += 1000;
            bool rejected = false;
            try { monitor.Read(utc); } catch (InvalidDataException) { rejected = true; }
            Assert(rejected, "stale_identity_read_accepted");
            // TickCount rollover must not extend the freshness window.
            observed = utc; tick = int.MaxValue - 100;
            monitor.Read(utc);
            tick = unchecked(tick + 25000);
            Assert(monitor.IsExpired(), "tick_wrap_extended_identity_lease");
        }

        public static void TestIdentityChangeClosesIdleRoute()
        {
            string root = NewRoot("identity-change");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    int tick = 0;
                    int reads = 0;
                    BridgeTerminalIdentityMonitor monitor = new BridgeTerminalIdentityMonitor(delegate(long now)
                    {
                        if (Interlocked.Increment(ref reads) > 1) throw new InvalidDataException("bridge_account_facts_route_mismatch");
                        return IdentityFacts(Now);
                    }, delegate { return Now; }, delegate { return Volatile.Read(ref tick); });
                    ShutdownChannel channel = new ShutdownChannel(false, runtime);
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, IdentityController(runtime, monitor, null),
                        new SingleChannelFactory(channel), null, monitor);
                    try
                    {
                        worker.Start();
                        WaitUntil(delegate { return worker.State == "active"; }, 3000, "identity_test_not_active");
                        Volatile.Write(ref tick, 10000);
                        WaitUntil(delegate { return channel.CloseCalls > 0 && worker.ConnectionId == null; }, 2000,
                            "identity_change_kept_idle_route_online");
                        Assert(reads == 2, "identity_check_not_account_only_poll");
                    }
                    finally { worker.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestBlockedIdentityProbeExpiresWithoutHeartbeatLock()
        {
            string root = NewRoot("identity-blocked");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                using (ManualResetEvent entered = new ManualResetEvent(false))
                using (ManualResetEvent release = new ManualResetEvent(false))
                using (BlockingQuerySource longQuery = new BlockingQuerySource())
                {
                    int tick = 0;
                    int reads = 0;
                    BridgeTerminalIdentityMonitor monitor = new BridgeTerminalIdentityMonitor(delegate(long now)
                    {
                        if (Interlocked.Increment(ref reads) > 1) { entered.Set(); release.WaitOne(); }
                        return IdentityFacts(Now);
                    }, delegate { return Now; }, delegate { return Volatile.Read(ref tick); });
                    ShutdownChannel channel = new ShutdownChannel(true, runtime);
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, IdentityController(runtime, monitor, null, longQuery),
                        new SingleChannelFactory(channel), null, monitor);
                    try
                    {
                        worker.Start();
                        WaitUntil(delegate { return worker.State == "active"; }, 3000, "identity_block_test_not_active");
                        Assert(longQuery.Entered.WaitOne(2000), "identity_test_long_query_not_entered");
                        Volatile.Write(ref tick, 10000);
                        Assert(entered.WaitOne(2000), "identity_probe_not_entered");
                        Volatile.Write(ref tick, 25000);
                        WaitUntil(delegate { return channel.CloseCalls > 0 && worker.ConnectionId == null; }, 2000,
                            "blocked_identity_probe_prevented_expiration");
                        bool pending = false;
                        try { worker.Dispose(); } catch (TimeoutException) { pending = true; }
                        Assert(pending && worker.ActiveOperations > 0 && runtime.ConnectionEpoch == 2,
                            "identity_probe_released_runtime_before_exit");
                        release.Set(); longQuery.Release.Set(); worker.Dispose();
                    }
                    finally { release.Set(); longQuery.Release.Set(); worker.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestIdentityInvalidationBeforeAcceptedSendNeverExecutes()
        {
            string root = NewRoot("identity-command-fence");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                using (AcceptedIdentityChannel channel = new AcceptedIdentityChannel(runtime))
                {
                    int tick = 0;
                    int reads = 0;
                    BridgeTerminalIdentityMonitor monitor = new BridgeTerminalIdentityMonitor(delegate(long now)
                    {
                        if (Interlocked.Increment(ref reads) > 1) throw new InvalidDataException("bridge_account_facts_route_mismatch");
                        return IdentityFacts(Now);
                    }, delegate { return Now; }, delegate { return Volatile.Read(ref tick); });
                    NeverExecuteCommands commands = new NeverExecuteCommands();
                    BridgeProfileWorker worker = new BridgeProfileWorker(runtime, IdentityController(runtime, monitor, commands),
                        new SingleChannelFactory(channel), null, monitor);
                    try
                    {
                        worker.Start();
                        Assert(channel.Accepted.WaitOne(3000), "accepted_response_not_entered");
                        Volatile.Write(ref tick, 25000);
                        WaitUntil(delegate { return worker.ConnectionId == null; }, 2000, "command_route_not_invalidated");
                        channel.ReleaseAccepted.Set();
                        worker.Dispose();
                        Assert(commands.Executions == 0
                            && runtime.CommandLedger.ReadState("profile-a", "identity-command-key") == "recorded",
                            "invalidated_route_dispatched_after_accepted");
                    }
                    finally { channel.ReleaseAccepted.Set(); worker.Dispose(); }
                }
            }
            finally { DeleteRoot(root); }
        }

        private static IDictionary<string, object> IdentityFacts(long observed)
        {
            return new Dictionary<string, object> { { "currency", "USD" }, { "login", "10001" },
                { "broker_server", "Demo" }, { "observed_at_utc_msc", observed } };
        }

        private static BridgeSessionController IdentityController(ProfileRuntime runtime,
            BridgeTerminalIdentityMonitor monitor, ITerminalCommandSource commands, ITerminalQuerySource terminal = null)
        {
            return new BridgeSessionController(runtime, new BridgeProfileSession(runtime, terminal ?? new StaticTerminalSource(), commands),
                new BridgeSessionConfiguration { InstallationId = "installation-123", BridgeVersion = "4.0.0",
                    TerminalVersion = "1441", TradePermission = "read_only", TimezoneOffsetMinutes = 180,
                    ClockStatus = "calibrated", AccountFactsProvider = monitor.Read });
        }

        private sealed class NeverExecuteCommands : ITerminalCommandSource
        {
            public int Executions;
            public TerminalCommandExecutionResult Execute(ProfileRuntime runtime, BridgeCommandRequest request, long now)
            { Interlocked.Increment(ref Executions); throw new InvalidOperationException("offline_command_must_not_execute"); }
            public TerminalCommandExecutionResult Reconcile(ProfileRuntime runtime, BridgeCommandReconcile request,
                CommandLedgerRecord record, long now)
            { throw new InvalidOperationException("offline_reconcile_must_not_execute"); }
        }

        private sealed class AcceptedIdentityChannel : IBridgeMessageChannel
        {
            private readonly ProfileRuntime runtime;
            private string sessionId;
            private int received;
            private readonly ManualResetEvent closed = new ManualResetEvent(false);
            public readonly ManualResetEvent Accepted = new ManualResetEvent(false);
            public readonly ManualResetEvent ReleaseAccepted = new ManualResetEvent(false);
            public AcceptedIdentityChannel(ProfileRuntime value) { runtime = value; }
            public void Send(string json)
            {
                IDictionary<string, object> envelope = Parse(json);
                if ((string)envelope["type"] == "session.hello") sessionId = (string)Object(envelope, "payload")["session_id"];
                if ((string)envelope["type"] == "command.accepted") { Accepted.Set(); ReleaseAccepted.WaitOne(); }
            }
            public string Receive()
            {
                int count = Interlocked.Increment(ref received);
                if (count == 1) return Welcome(sessionId, "identity-command-connection");
                if (count == 2)
                {
                    long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    return Envelope("command.request", "identity-command-message", new Dictionary<string, object>
                    {
                        { "command_id", "identity-command" }, { "idempotency_key", "identity-command-key" },
                        { "action", "order.place" }, { "issued_at_utc_msc", now }, { "deadline_utc_msc", now + 30000 },
                        { "params", new Dictionary<string, object> { { "symbol", "XAUUSD" }, { "direction", "buy" },
                            { "order_type", "market" }, { "volume", "0.01" }, { "magic", 234000 }, { "deviation", 20 } } },
                        { "expected_state", null }
                    }, now, new Dictionary<string, object> { { "terminal_instance_id", "terminal-a" },
                        { "account_ref", new Dictionary<string, object> { { "broker_server", "Demo" }, { "login", "10001" } } },
                        { "connection_epoch", runtime.ConnectionEpoch } });
                }
                closed.WaitOne(); return null;
            }
            public void Dispose() { closed.Set(); }
        }
    }
}
