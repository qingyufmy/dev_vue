using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class Mt5QuerySourceSmokeTests
    {
        public static void TestQuoteAndAccountMapping()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-v4-mt5-query-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                using (ProfileRuntime runtime = new ProfileRuntime(new ProfileRuntimeConfiguration(
                    Path.Combine(root, "profile.db"), "profile-a", "terminal-a", "mt5", "Demo", "10001", 1)))
                {
                    FakeHost host = new FakeHost();
                    Mt5WorkerQuerySource source = new Mt5WorkerQuerySource(host);
                    TerminalQueryResult quote = source.Query(runtime, Request(runtime, "market.quote",
                        new Dictionary<string, object> { { "symbols", new object[] { "XAUUSD" } } }), Now);
                    IDictionary<string, object> quoteData = Parse(quote.DataJson);
                    Assert(quote.Succeeded && quote.ClockStatus == "calibrated" && quote.ServerOffsetMinutes == 180,
                        "mt5_quote_metadata_not_mapped");
                    Assert(((object[])quoteData["items"]).Length == 1, "mt5_quote_items_not_mapped");

                    TerminalQueryResult account = source.Query(runtime, Request(runtime, "account.snapshot",
                        new Dictionary<string, object>()), Now + 1);
                    IDictionary<string, object> accountData = Parse(account.DataJson);
                    Assert(account.Succeeded && Convert.ToDouble(accountData["balance"]) == 1000.0,
                        "mt5_account_not_mapped");
                    Assert(host.Operations.Count == 2 && host.Operations[0] == "quote"
                        && host.Operations[1] == "collect_snapshot", "mt5_query_operation_route_wrong");
                    IDictionary<string, object> facts = BridgeAccountFacts.Read(runtime, source, Now + 2);
                    Assert((string)facts["currency"] == "EUR" && (string)facts["login"] == "10001"
                        && (string)facts["broker_server"] == "Demo", "mt5_account_facts_adapter_not_mapped");
                    TerminalQueryResult clock = source.Query(runtime, Request(runtime, "terminal.clock",
                        new Dictionary<string, object>()), Now + 3);
                    IDictionary<string, object> clockData = Parse(clock.DataJson);
                    Assert(clock.Succeeded && clock.ClockStatus == "unavailable"
                        && clockData["timezone_offset_minutes"] == null
                        && Convert.ToInt64(clockData["raw_tick_time_msc"]) == Now,
                        "mt5_clock_sample_promoted_or_lost");
                    host.ForgeClock = true;
                    Assert(!source.Query(runtime, Request(runtime, "terminal.clock",
                        new Dictionary<string, object>()), Now + 4).Succeeded,
                        "mt5_clock_unverified_sample_promoted");
                }
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        private const long Now = 1788307200000;

        private static BridgeQueryRequest Request(ProfileRuntime runtime, string resource,
            IDictionary<string, object> parameters)
        {
            string json = new JavaScriptSerializer().Serialize(new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", "message-" + resource }, { "type", "query.request" },
                { "sent_at_utc_msc", Now }, { "correlation_id", null },
                { "route", new Dictionary<string, object>
                    {
                        { "terminal_instance_id", runtime.Configuration.TerminalInstanceId },
                        { "account_ref", new Dictionary<string, object>
                            { { "broker_server", runtime.Configuration.BrokerServer }, { "login", runtime.Configuration.Login } } },
                        { "connection_epoch", runtime.ConnectionEpoch }
                    }
                },
                { "payload", new Dictionary<string, object>
                    {
                        { "request_id", "request-" + resource }, { "resource", resource },
                        { "params", parameters }, { "deadline_utc_msc", Now + 10000 }
                    }
                }
            });
            return BridgeQueryRequest.Parse(BridgeEnvelope.Parse(json));
        }

        private static IDictionary<string, object> Parse(string json)
        {
            return (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private sealed class FakeHost : IMt5WorkerRequestHost
        {
            public readonly List<string> Operations = new List<string>();
            public bool ForgeClock;

            public Mt5WorkerResponse Request(string terminalInstanceId, string brokerServer, string login,
                string expectedRole, string operation, IDictionary<string, object> payload)
            {
                if (terminalInstanceId != "terminal-a" || brokerServer != "Demo" || login != "10001"
                    || expectedRole != "live") throw new InvalidOperationException("fake_mt5_route_wrong");
                Operations.Add(operation);
                if (operation == "data")
                {
                    Assert((string)payload["action"] == "terminal_clock", "mt5_clock_action_wrong");
                    return Mt5WorkerResponse.FromAdapter("request-terminal.clock", "data",
                        new Dictionary<string, object> { { "data", new Dictionary<string, object>
                        {
                            { "action", "terminal_clock" }, { "observed_at_utc_msc", Now },
                            { "payload", new Dictionary<string, object>
                            {
                                { "server_time_utc_msc", null }, { "sampled_at_utc_msc", Now },
                                { "sampling_started_at_utc_msc", Now }, { "sample_status", "captured" },
                                { "timezone_offset_minutes", null }, { "clock_status", ForgeClock ? "calibrated" : "unavailable" },
                                { "source_kind", "mt5_tick_time_unverified" }, { "symbol", "XAUUSD" },
                                { "raw_tick_time_msc", Now }
                            } }
                        } } });
                }
                if (operation == "quote")
                {
                    return Mt5WorkerResponse.FromAdapter("request-market.quote", "quote",
                        new Dictionary<string, object>
                        {
                            { "quote", new Dictionary<string, object>
                                {
                                    { "symbol", "XAUUSD" }, { "bid", 4500.1 }, { "ask", 4500.3 },
                                    { "last", 4500.2 }, { "observed_at_utc_msc", Now },
                                    { "timezone_offset_minutes", 180 }, { "clock_status", "verified" }
                                }
                            }
                        });
                }
                return Mt5WorkerResponse.FromAdapter("request-account.snapshot", "snapshot",
                    new Dictionary<string, object>
                    {
                        { "snapshot", new Dictionary<string, object>
                            {
                                { "source_time_msc", Now + 1 },
                                { "streams", new Dictionary<string, object>
                                    { { "account", new Dictionary<string, object>
                                        { { "balance", 1000.0 }, { "login", 10001 }, { "server", "Demo" },
                                          { "currency", "EUR" }, { "terminal_connected", true } } } } }
                            }
                        }
                    });
            }
        }
    }
}
