using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class CommandSessionContractSmokeTests
    {
        private const long Now = 1788307200000;

        public static void TestCommandContractAndCanonicalHash()
        {
            IDictionary<string, object> first = CommandPayload();
            IDictionary<string, object> second = new Dictionary<string, object>
            {
                { "expected_state", null }, { "params", first["params"] },
                { "deadline_utc_msc", Now + 5000 }, { "issued_at_utc_msc", Now },
                { "action", "order.place" }, { "idempotency_key", "idempotency-command-0001" },
                { "command_id", "command-0001" }
            };
            BridgeCommandRequest left = BridgeCommandRequest.Parse(BridgeEnvelope.Parse(Envelope(
                "command.request", "message-command-1", 1, first)));
            BridgeCommandRequest right = BridgeCommandRequest.Parse(BridgeEnvelope.Parse(Envelope(
                "command.request", "message-command-2", 1, second)));
            Assert(left.RequestHash == right.RequestHash && left.RequestHash.StartsWith("sha256:"),
                "command_hash_not_canonical");

            first["unknown"] = true;
            AssertThrows<InvalidDataException>(delegate
            {
                BridgeCommandRequest.Parse(BridgeEnvelope.Parse(Envelope(
                    "command.request", "message-command-3", 1, first)));
            }, "command_unknown_field_accepted");
        }

        public static void TestCommandAckAndReconcileAreStrict()
        {
            BridgeCommandResultAck ack = BridgeCommandResultAck.Parse(BridgeEnvelope.Parse(Envelope(
                "command.result_ack", "message-ack", 1, new Dictionary<string, object>
                {
                    { "command_id", "command-0001" }, { "status", "persisted" }
                })));
            Assert(ack.CommandId == "command-0001", "command_ack_not_parsed");
            BridgeCommandReconcile reconcile = BridgeCommandReconcile.Parse(BridgeEnvelope.Parse(Envelope(
                "command.reconcile", "message-reconcile", 1, new Dictionary<string, object>
                {
                    { "command_id", "command-0001" }, { "action", "position.close" },
                    { "terminal_ticket", "9007199254740993" }
                })));
            Assert(reconcile.TerminalTicket == "9007199254740993", "reconcile_ticket_lost_precision");
            AssertThrows<InvalidDataException>(delegate
            {
                BridgeCommandReconcile.Parse(BridgeEnvelope.Parse(Envelope(
                    "command.reconcile", "message-reconcile-bad", 1, new Dictionary<string, object>
                    {
                        { "command_id", "command-0001" }, { "action", "position.close" },
                        { "terminal_ticket", "ticket-1" }
                    })));
            }, "reconcile_non_decimal_ticket_accepted");
        }

        public static void TestDurableOutboxSurvivesEpochChange()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-command-outbox-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                using (ProfileRuntime runtime = new ProfileRuntime(new ProfileRuntimeConfiguration(
                    Path.Combine(root, "profile.db"), "profile-a", "terminal-a", "mt5", "Demo", "10001", 1)))
                {
                    ProfileOutboxCoordinator outbox = new ProfileOutboxCoordinator();
                    string payload = Envelope("command.result", "bridge-result-fixed", 1,
                        new Dictionary<string, object> { { "command_id", "command-0001" } });
                    Assert(outbox.Enqueue(runtime, "bridge-result-fixed", "command.result", payload, 100, Now),
                        "durable_result_not_enqueued");
                    runtime.RebindEpoch(2);
                    CapturingSink sink = new CapturingSink();
                    Assert(outbox.FlushOne(runtime, sink, Now + 1), "old_epoch_result_not_flushed");
                    BridgeEnvelope replayed = BridgeEnvelope.Parse(sink.Message);
                    Assert(replayed.ConnectionEpoch == 2 && replayed.MessageId == "bridge-result-fixed",
                        "durable_result_route_not_refreshed");
                    Assert(outbox.AcknowledgeDurableMessage(runtime, "bridge-result-fixed", Now + 2),
                        "durable_result_ack_failed");
                }
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        public static void TestCommandExecutesAfterAcceptedAndDeduplicates()
        {
            string root = NewRoot("execute");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    FakeCommandSource commands = new FakeCommandSource(
                        TerminalCommandExecutionResult.Create("succeeded",
                            new Dictionary<string, object> { { "ticket", "501" } }, null, 10009));
                    BridgeProfileSession session = new BridgeProfileSession(runtime,
                        new UnusedQuerySource(), commands);
                    string commandJson = Envelope("command.request", "message-command-execute", 1, CommandPayload());
                    IDictionary<string, object> accepted = Parse(session.Handle(commandJson, Now));
                    Assert((string)accepted["type"] == "command.accepted" && commands.ExecuteCalls == 0,
                        "command_executed_before_accepted_send");
                    session.AfterResponseSent(Now + 1);
                    Assert(commands.ExecuteCalls == 1
                        && runtime.CommandLedger.ReadState("profile-a", "idempotency-command-0001") == "succeeded",
                        "command_not_executed_after_accepted");
                    Assert(runtime.DataStore.ReadNextUnacknowledgedOutbox(Now + 2) != null,
                        "command_result_not_durable");

                    IDictionary<string, object> duplicate = Parse(session.Handle(commandJson, Now + 3));
                    Assert((string)Object(duplicate, "payload")["status"] == "duplicate",
                        "duplicate_command_not_acknowledged");
                    session.AfterResponseSent(Now + 4);
                    Assert(commands.ExecuteCalls == 1, "duplicate_command_reexecuted");
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestExpiredAndInterruptedCommandsNeverExecute()
        {
            string root = NewRoot("safe-states");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    FakeCommandSource commands = new FakeCommandSource(
                        TerminalCommandExecutionResult.Create("succeeded", null, null, null));
                    BridgeProfileSession session = new BridgeProfileSession(runtime,
                        new UnusedQuerySource(), commands);
                    IDictionary<string, object> expiredPayload = CommandPayload();
                    expiredPayload["deadline_utc_msc"] = Now;
                    session.Handle(Envelope("command.request", "message-expired", 1, expiredPayload), Now);
                    session.AfterResponseSent(Now + 1);
                    Assert(commands.ExecuteCalls == 0
                        && runtime.CommandLedger.ReadState("profile-a", "idempotency-command-0001") == "rejected",
                        "expired_command_reached_terminal");
                }
                using (ProfileRuntime runtime = Runtime(Path.Combine(root, "recover"), "profile-b"))
                {
                    runtime.CommandLedger.Accept("profile-b", "command-0002", "idempotency-command-0002",
                        "position.close", "sha256:recover", Now);
                    runtime.CommandLedger.TryMarkDispatched("profile-b", "idempotency-command-0002");
                    FakeCommandSource commands = new FakeCommandSource(
                        TerminalCommandExecutionResult.Create("succeeded", null, null, null));
                    BridgeProfileSession session = new BridgeProfileSession(runtime,
                        new UnusedQuerySource(), commands);
                    session.PrepareReconnect(Now + 10);
                    Assert(commands.ExecuteCalls == 0
                        && runtime.CommandLedger.ReadState("profile-b", "idempotency-command-0002") == "uncertain",
                        "interrupted_dispatch_reexecuted_or_not_quarantined");
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestUncertainResultCanReconcileWithoutReplay()
        {
            string root = NewRoot("reconcile");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    FakeCommandSource commands = new FakeCommandSource(
                        TerminalCommandExecutionResult.Uncertain("transport_lost", null));
                    commands.ReconcileResult = TerminalCommandExecutionResult.Create("succeeded",
                        new Dictionary<string, object> { { "ticket", "501" } }, null, null);
                    BridgeProfileSession session = new BridgeProfileSession(runtime,
                        new UnusedQuerySource(), commands);
                    session.Handle(Envelope("command.request", "message-uncertain", 1, CommandPayload()), Now);
                    session.AfterResponseSent(Now + 1);
                    Assert(runtime.CommandLedger.ReadState("profile-a", "idempotency-command-0001") == "uncertain",
                        "uncertain_result_not_recorded");
                    session.Handle(Envelope("command.reconcile", "message-reconcile-final", 1,
                        new Dictionary<string, object>
                        {
                            { "command_id", "command-0001" }, { "action", "order.place" },
                            { "terminal_ticket", "501" }
                        }), Now + 20000);
                    Assert(commands.ExecuteCalls == 1 && commands.ReconcileCalls == 1
                        && runtime.CommandLedger.ReadState("profile-a", "idempotency-command-0001") == "succeeded",
                        "reconcile_replayed_trade_or_did_not_settle");
                }
            }
            finally { DeleteRoot(root); }
        }

        private static IDictionary<string, object> CommandPayload()
        {
            return new Dictionary<string, object>
            {
                { "command_id", "command-0001" },
                { "idempotency_key", "idempotency-command-0001" },
                { "action", "order.place" }, { "issued_at_utc_msc", Now },
                { "deadline_utc_msc", Now + 5000 },
                { "params", new Dictionary<string, object>
                    {
                        { "symbol", "XAUUSD" }, { "direction", "buy" },
                        { "order_type", "market" }, { "volume", "0.01" },
                        { "magic", 234000 }, { "deviation", 20 }
                    }
                },
                { "expected_state", null }
            };
        }

        private static string NewRoot(string suffix)
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-command-" + suffix + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static ProfileRuntime Runtime(string root)
        {
            return Runtime(root, "profile-a");
        }

        private static ProfileRuntime Runtime(string root, string profileId)
        {
            Directory.CreateDirectory(root);
            return new ProfileRuntime(new ProfileRuntimeConfiguration(Path.Combine(root, "profile.db"),
                profileId, "terminal-a", "mt5", "Demo", "10001", 1));
        }

        private static IDictionary<string, object> Parse(string json)
        {
            return (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
        }

        private static IDictionary<string, object> Object(IDictionary<string, object> root, string key)
        {
            return (IDictionary<string, object>)root[key];
        }

        private static void DeleteRoot(string root)
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }

        private static string Envelope(string type, string messageId, long epoch,
            IDictionary<string, object> payload)
        {
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", messageId }, { "type", type },
                { "sent_at_utc_msc", Now }, { "correlation_id", null },
                { "route", new Dictionary<string, object>
                    {
                        { "terminal_instance_id", "terminal-a" },
                        { "account_ref", new Dictionary<string, object>
                            { { "broker_server", "Demo" }, { "login", "10001" } } },
                        { "connection_epoch", epoch }
                    }
                },
                { "payload", payload }
            });
        }

        private sealed class CapturingSink : IBridgeMessageSink
        {
            public string Message { get; private set; }
            public void Send(string envelopeJson) { Message = envelopeJson; }
        }

        private sealed class UnusedQuerySource : ITerminalQuerySource
        {
            public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
            {
                throw new InvalidOperationException("query_not_expected");
            }
        }

        private sealed class FakeCommandSource : ITerminalCommandSource
        {
            private readonly TerminalCommandExecutionResult executeResult;
            public FakeCommandSource(TerminalCommandExecutionResult result) { executeResult = result; }
            public int ExecuteCalls { get; private set; }
            public int ReconcileCalls { get; private set; }
            public TerminalCommandExecutionResult ReconcileResult { get; set; }
            public TerminalCommandExecutionResult Execute(ProfileRuntime runtime,
                BridgeCommandRequest request, long nowUtcMsc)
            {
                ExecuteCalls++;
                return executeResult;
            }
            public TerminalCommandExecutionResult Reconcile(ProfileRuntime runtime,
                BridgeCommandReconcile request, Liangjian.BridgeV4.Storage.CommandLedgerRecord original,
                long nowUtcMsc)
            {
                ReconcileCalls++;
                return ReconcileResult ?? TerminalCommandExecutionResult.Uncertain("still_unknown", null);
            }
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try { action(); } catch (T) { return; }
            throw new InvalidOperationException(message);
        }
    }
}
