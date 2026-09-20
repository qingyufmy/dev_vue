using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class TerminalCommandSourceSmokeTests
    {
        private const long Now = 1788307200000;

        public static void TestMt5MappingAndOutcomeClassification()
        {
            string root = NewRoot();
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    FakeMt5Host host = new FakeMt5Host();
                    Mt5WorkerResponse success = Mt5WorkerResponse.FromAdapter("command-0001", "command_result",
                        new Dictionary<string, object>
                        {
                            { "result", new Dictionary<string, object>
                                {
                                    { "status", "succeeded" }, { "error_code", null },
                                    { "raw_result", new Dictionary<string, object> { { "order", 501 } } },
                                    { "evidence", new Dictionary<string, object> { { "broker_retcode", 10009 } } }
                                }
                            }
                        });
                    host.Response = success;
                    Mt5TerminalCommandSource source = new Mt5TerminalCommandSource(host, delegate { return 7; });
                    TerminalCommandExecutionResult result = source.Execute(runtime, Request("0.01"), Now);
                    Assert(result.Status == "succeeded" && (int)result.TerminalCode == 10009,
                        "mt5_success_not_mapped");
                    Assert(host.Operation == "execute_command"
                        && (string)host.Payload["action"] == "place_order",
                        "mt5_action_not_mapped");
                    IDictionary<string, object> parameters = Object(host.Payload, "params");
                    Assert((string)parameters["side"] == "buy"
                        && (string)parameters["order_kind"] == "market",
                        "mt5_params_not_normalized");

                    result = source.Execute(runtime, StopLimitRequest(), Now);
                    parameters = Object(host.Payload, "params");
                    Assert(result.Status == "succeeded"
                        && (string)parameters["order_kind"] == "stop_limit"
                        && (string)parameters["stop_limit_price"] == "99.50",
                        "mt5_stop_limit_not_preserved");

                    host.Response = Mt5WorkerResponse.FromAdapter("command-0001", "error",
                        new Dictionary<string, object> { { "error_code", "worker_route_mismatch" } });
                    result = source.Execute(runtime, Request("0.01"), Now);
                    Assert(result.Status == "failed" && result.ErrorCode == "worker_route_mismatch",
                        "mt5_worker_error_code_not_preserved");
                    host.Response = success;

                    host.ThrowAfterCall = true;
                    result = source.Execute(runtime, Request("0.01"), Now);
                    Assert(result.Status == "uncertain", "mt5_post_send_exception_not_uncertain");
                    host.ThrowAfterCall = false;
                    int calls = host.Calls;
                    result = source.Execute(runtime, Request("0"), Now);
                    Assert(result.Status == "rejected" && host.Calls == calls,
                        "mt5_invalid_command_reached_terminal");
                    TestNullableManagementState(runtime, source, host);
                }
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        public static void TestMt4MissingSessionIsPreSendFailure()
        {
            string root = NewRoot();
            try
            {
                using (ProfileRuntime runtime = new ProfileRuntime(new ProfileRuntimeConfiguration(
                    Path.Combine(root, "profile.db"), "profile-a", "terminal-a", "mt4", "Demo", "10001", 1)))
                using (TerminalSessionHost host = new TerminalSessionHost("missing-" + Guid.NewGuid().ToString("N")))
                {
                    TerminalCommandExecutionResult result = new Mt4TerminalCommandSource(host)
                        .Execute(runtime, Request("0.01"), Now);
                    Assert(result.Status == "failed", "mt4_missing_session_not_pre_send_failure");
                }
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        private static BridgeCommandRequest Request(string volume)
        {
            return Request(new Dictionary<string, object>
            {
                { "symbol", "XAUUSD" }, { "direction", "buy" }, { "order_type", "market" },
                { "volume", volume }, { "magic", 234000 }, { "deviation", 20 }
            });
        }

        private static BridgeCommandRequest StopLimitRequest()
        {
            return Request(new Dictionary<string, object>
            {
                { "symbol", "XAUUSD" }, { "direction", "buy" },
                { "order_type", "buy_stop_limit" }, { "volume", "0.01" },
                { "price", "100.00" }, { "stop_limit_price", "99.50" },
                { "magic", 234000 }, { "deviation", 20 }
            });
        }

        private static BridgeCommandRequest Request(IDictionary<string, object> parameters)
        {
            return Request(parameters, "order.place", null);
        }

        private static void TestNullableManagementState(ProfileRuntime runtime,
            Mt5TerminalCommandSource source, FakeMt5Host host)
        {
            IDictionary<string, object> state = new Dictionary<string, object>
            {
                { "ticket", "501" }, { "symbol", "XAUUSD" }, { "direction", "buy" },
                { "order_type", "market" }, { "magic", 234000 }, { "volume", "0.01" },
                { "open_price", "100.00" }, { "stop_limit_price", null },
                { "stop_loss", null }, { "take_profit", null }, { "expiration_utc_msc", null }
            };
            string[] actions = { "position.close", "position.protection.set", "pending_order.modify", "pending_order.cancel" };
            foreach (string action in actions)
            {
                state["order_type"] = action.StartsWith("pending_order.") ? "buy_limit" : "market";
                IDictionary<string, object> parameters = new Dictionary<string, object> { { "ticket", "501" } };
                if (action == "position.close") parameters["deviation"] = 20;
                if (action == "position.protection.set") parameters["stop_loss"] = "90.00";
                if (action == "pending_order.modify") parameters["price"] = "95.00";
                int calls = host.Calls;
                Assert(source.Execute(runtime, Request(parameters, action, state), Now).Status == "succeeded"
                    && host.Calls == calls + 1, "mt5_nullable_management_state_rejected_" + action);
                Assert(Object(host.Payload, "params").ContainsKey("expected_state"), "mt5_expected_state_dropped");
                foreach (string field in new[] { "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc" })
                {
                    state.Remove(field);
                    calls = host.Calls;
                    Assert(source.Execute(runtime, Request(parameters, action, state), Now).Status == "rejected"
                        && host.Calls == calls, "mt5_missing_nullable_field_accepted_" + field);
                    state[field] = null;
                }
                state["volume"] = null;
                calls = host.Calls;
                Assert(source.Execute(runtime, Request(parameters, action, state), Now).Status == "rejected"
                    && host.Calls == calls, "mt5_required_nonnull_field_accepted");
                state["volume"] = "0.01";
            }
        }

        private static BridgeCommandRequest Request(IDictionary<string, object> parameters,
            string action, IDictionary<string, object> expectedState)
        {
            IDictionary<string, object> payload = new Dictionary<string, object>
            {
                { "command_id", "command-0001" }, { "idempotency_key", "idempotency-command-0001" },
                { "action", action }, { "issued_at_utc_msc", Now },
                { "deadline_utc_msc", Now + 10000 },
                { "params", parameters },
                { "expected_state", expectedState }
            };
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string envelope = serializer.Serialize(new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", "message-command" }, { "type", "command.request" },
                { "sent_at_utc_msc", Now }, { "correlation_id", null },
                { "route", new Dictionary<string, object>
                    {
                        { "terminal_instance_id", "terminal-a" },
                        { "account_ref", new Dictionary<string, object>
                            { { "broker_server", "Demo" }, { "login", "10001" } } },
                        { "connection_epoch", 1 }
                    }
                },
                { "payload", payload }
            });
            return BridgeCommandRequest.Parse(BridgeEnvelope.Parse(envelope));
        }

        private static ProfileRuntime Runtime(string root)
        {
            return new ProfileRuntime(new ProfileRuntimeConfiguration(Path.Combine(root, "profile.db"),
                "profile-a", "terminal-a", "mt5", "Demo", "10001", 1));
        }

        private static string NewRoot()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-terminal-command-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static IDictionary<string, object> Object(IDictionary<string, object> root, string key)
        {
            return (IDictionary<string, object>)root[key];
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private sealed class FakeMt5Host : IMt5WorkerRequestHost
        {
            public int Calls { get; private set; }
            public string Operation { get; private set; }
            public IDictionary<string, object> Payload { get; private set; }
            public Mt5WorkerResponse Response { get; set; }
            public bool ThrowAfterCall { get; set; }

            public Mt5WorkerResponse Request(string terminalInstanceId, string brokerServer, string login,
                string expectedRole, string operation, IDictionary<string, object> payload)
            {
                Calls++;
                Operation = operation;
                Payload = payload;
                if (ThrowAfterCall) throw new TimeoutException("worker_timeout");
                return Response;
            }
        }
    }
}
