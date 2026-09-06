using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class BridgeAccountFactsSmokeTests
    {
        private const long Now = 1788307200000;

        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-account-facts-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                foreach (string platform in new[] { "mt4", "mt5" })
                using (ProfileRuntime runtime = new ProfileRuntime(new ProfileRuntimeConfiguration(
                    Path.Combine(root, platform + ".db"), "profile-facts", "terminal-facts", platform, "Broker-Demo", "10001", 1)))
                {
                    Source source = new Source(platform);
                    BridgeSessionController controller = new BridgeSessionController(runtime,
                        new BridgeProfileSession(runtime, source), new BridgeSessionConfiguration
                        {
                            InstallationId = "installation-facts", BridgeVersion = "4.0.0", TerminalVersion = "1",
                            TradePermission = "unknown", ClockStatus = "unavailable",
                            AccountFactsProvider = delegate(long now) { return BridgeAccountFacts.Read(runtime, source, now); }
                        });
                    IDictionary<string, object> first = Facts(controller.Begin(Now));
                    Assert((string)first["currency"] == "EUR" && source.Calls == 1, "facts_not_from_terminal");
                    Assert((string)first["broker_server"] == "Broker-Demo" && (string)first["login"] == "10001",
                        "facts_route_not_exact");
                    source.Data["currency"] = "USCent";
                    controller.MarkDisconnected(Now + 1);
                    IDictionary<string, object> second = Facts(controller.Begin(Now + 1001));
                    Assert((string)second["currency"] == "USCent" && source.Calls == 2, "facts_reconnect_reused_old_snapshot");
                    source.Data["currency"] = "";
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                    source.Data["currency"] = "USD\n";
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                    source.Data["currency"] = "EUR";
                    source.Data["login"] = "10002";
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                    source.Data["login"] = "10001";
                    source.Data[platform == "mt5" ? "server" : "broker_server"] = "Other-Demo";
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                    source.Data[platform == "mt5" ? "server" : "broker_server"] = "Broker-Demo";
                    source.Data[platform == "mt5" ? "terminal_connected" : "connected"] = false;
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                    source.Data[platform == "mt5" ? "terminal_connected" : "connected"] = true;
                    source.Age = 60001;
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                    source.Age = 0;
                    source.WrongCorrelation = true;
                    Reject(delegate { BridgeAccountFacts.Read(runtime, source, Now); });
                }
            }
            finally { Directory.Delete(root, true); }
        }

        private static IDictionary<string, object> Facts(string json)
        {
            IDictionary<string, object> root = (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
            IDictionary<string, object> payload = (IDictionary<string, object>)root["payload"];
            IDictionary<string, object> terminal = (IDictionary<string, object>)((object[])payload["terminals"])[0];
            return (IDictionary<string, object>)terminal["account_facts"];
        }

        private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
        private static void Reject(Action action)
        {
            try { action(); } catch (InvalidDataException) { return; }
            throw new Exception("invalid_account_facts_accepted");
        }

        private sealed class Source : ITerminalQuerySource
        {
            public readonly IDictionary<string, object> Data;
            public int Calls;
            public long Age;
            public bool WrongCorrelation;
            public Source(string platform)
            {
                Data = new Dictionary<string, object>
                {
                    { "login", platform == "mt5" ? (object)10001 : "10001" },
                    { platform == "mt5" ? "server" : "broker_server", "Broker-Demo" },
                    { "currency", "EUR" }, { platform == "mt5" ? "terminal_connected" : "connected", true }
                };
            }
            public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
            {
                Calls++;
                Assert(request.Resource == "account.snapshot", "facts_query_not_read_only");
                TerminalWireWriter writer = new TerminalWireWriter();
                writer.WriteInt32((int)TerminalWireMessageType.QueryResponse);
                writer.WriteString(WrongCorrelation ? "wrong-request" : request.RequestId);
                writer.WriteInt32((int)TerminalQueryTranslator.ResourceCode(request.Resource));
                writer.WriteInt64(nowUtcMsc - Age);
                writer.WriteInt32(0);
                writer.WriteString("unavailable");
                writer.WriteString(new JavaScriptSerializer().Serialize(Data));
                writer.WriteString(string.Empty);
                writer.WriteInt32(0);
                return TerminalQueryResult.Parse(writer.ToArray());
            }
        }
    }
}
