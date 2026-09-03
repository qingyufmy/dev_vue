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
    internal static class SessionSmokeTests
    {
        private const long Now = 1788307200000;

        public static void TestQueryContractIsStrict()
        {
            BridgeQueryRequest trading = BridgeQueryRequest.Parse(BridgeEnvelope.Parse(
                Request("trading.positions", new Dictionary<string, object> { { "limit", 50 }, { "cursor", null } }, "request-trading", 1)));
            Assert(trading.Resource == "trading.positions", "optional_trading_symbol_required");
            AssertThrows<InvalidDataException>(delegate
            {
                BridgeQueryRequest.Parse(BridgeEnvelope.Parse(Request("market.candles", new Dictionary<string, object>
                {
                    { "symbol", "XAUUSD" }, { "timeframe", "M5" }, { "count", 501 }
                }, "request-candles", 1)));
            }, "oversized_candle_page_accepted");
            AssertThrows<InvalidDataException>(delegate
            {
                BridgeQueryRequest.Parse(BridgeEnvelope.Parse(Request("history.deals", new Dictionary<string, object>
                {
                    { "range_start_utc_msc", Now }, { "range_end_utc_msc", Now + 2000 }
                }, "request-history", 1)));
            }, "unpaged_history_range_accepted");
        }

        public static void TestDirectTerminalQuery()
        {
            string root = NewRoot("direct");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    BridgeProfileSession session = new BridgeProfileSession(runtime,
                        new FakeTerminalSource("{\"balance\":1000,\"equity\":1001}"));
                    string response = session.Handle(Request("account.snapshot", new Dictionary<string, object>(), "request-direct", 1), Now);
                    IDictionary<string, object> envelope = Parse(response);
                    IDictionary<string, object> payload = Object(envelope, "payload");
                    Assert((string)envelope["type"] == "query.response", "direct_query_not_response");
                    Assert((string)payload["source"] == "terminal", "direct_query_source_wrong");
                    Assert(((object[])payload["items"]).Length == 1, "direct_single_object_not_wrapped");
                    Assert(runtime.DataStore.ReadPendingOutbox(Now + 1, 10, null).Items.Count == 0,
                        "query_response_persisted_without_ack_contract");
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestProjectionCursorFlow()
        {
            string root = NewRoot("projection-session");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    BridgeProfileSession session = new BridgeProfileSession(runtime, new FakeTerminalSource("{}"));
                    IDictionary<string, object> parameters = new Dictionary<string, object>
                    {
                        { "symbol", "XAUUSD" }, { "timeframe", "M5" },
                        { "range_start_utc_msc", Now }, { "range_end_utc_msc", Now + 2000 },
                        { "limit", 1 }, { "cursor", null }
                    };
                    string refreshing = session.Handle(Request("market.candles", parameters, "request-gap", 1), Now);
                    Assert((string)Object(Parse(refreshing), "payload")["code"] == "bridge_projection_refreshing",
                        "projection_gap_not_refreshing");
                    ProjectionSyncCoordinator sync = new ProjectionSyncCoordinator();
                    ProjectionSyncRunResult synced = sync.RunOne(runtime, new TwoCandleSource(), "lease-a", Now + 1);
                    Assert(synced.Status == "completed", "projection_sync_failed");

                    string firstJson = session.Handle(Request("market.candles", parameters, "request-page-1", 1), Now + 2);
                    IDictionary<string, object> first = Object(Parse(firstJson), "payload");
                    Assert(((object[])first["items"]).Length == 1 && (bool)first["has_more"], "projection_first_page_wrong");
                    string cursor = (string)first["next_cursor"];
                    parameters["cursor"] = cursor;
                    string secondJson = session.Handle(Request("market.candles", parameters, "request-page-2", 1), Now + 3);
                    IDictionary<string, object> second = Object(Parse(secondJson), "payload");
                    Assert(((object[])second["items"]).Length == 1 && !(bool)second["has_more"] && second["next_cursor"] == null,
                        "projection_second_page_wrong");
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestConnectionPump()
        {
            string root = NewRoot("pump");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                using (FakeChannel channel = new FakeChannel(Request("terminal.info", new Dictionary<string, object>(), "request-pump", 1)))
                {
                    BridgeProfileConnection connection = new BridgeProfileConnection(
                        new BridgeProfileSession(runtime, new FakeTerminalSource("{\"platform\":\"mt4\"}")), channel);
                    Assert(connection.ProcessNext(Now) && channel.Sent.Count == 1, "connection_did_not_send_response");
                    Assert(!connection.ProcessNext(Now + 1), "connection_did_not_stop_at_eof");
                }
            }
            finally { DeleteRoot(root); }
        }

        private static string Request(string resource, IDictionary<string, object> parameters, string requestId, long epoch)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            return serializer.Serialize(new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", "message-" + requestId }, { "type", "query.request" },
                { "sent_at_utc_msc", Now }, { "correlation_id", null },
                { "route", new Dictionary<string, object> { { "terminal_instance_id", "terminal-a" },
                    { "account_ref", new Dictionary<string, object> { { "broker_server", "Demo" }, { "login", "10001" } } },
                    { "connection_epoch", epoch } } },
                { "payload", new Dictionary<string, object> { { "request_id", requestId }, { "resource", resource },
                    { "params", parameters }, { "deadline_utc_msc", Now + 10000 } } }
            });
        }

        private static ProfileRuntime Runtime(string root)
        {
            return new ProfileRuntime(new ProfileRuntimeConfiguration(Path.Combine(root, "profile.db"),
                "profile-a", "terminal-a", "mt4", "Demo", "10001", 1));
        }

        private static IDictionary<string, object> Parse(string json)
        {
            return (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
        }

        private static IDictionary<string, object> Object(IDictionary<string, object> root, string key)
        {
            return (IDictionary<string, object>)root[key];
        }

        private static string NewRoot(string suffix)
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-" + suffix + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static void DeleteRoot(string root) { if (Directory.Exists(root)) Directory.Delete(root, true); }
        private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try { action(); } catch (T) { return; }
            throw new InvalidOperationException(message);
        }

        private sealed class FakeTerminalSource : ITerminalQuerySource
        {
            private readonly string dataJson;
            public FakeTerminalSource(string value) { dataJson = value; }
            public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
            {
                TerminalWireWriter writer = new TerminalWireWriter();
                writer.WriteInt32((int)TerminalWireMessageType.QueryResponse);
                writer.WriteString(request.RequestId);
                writer.WriteInt32((int)TerminalQueryTranslator.ResourceCode(request.Resource));
                writer.WriteInt64(nowUtcMsc);
                writer.WriteInt32(180);
                writer.WriteString("calibrated");
                writer.WriteString(dataJson);
                writer.WriteString(string.Empty);
                writer.WriteInt32(0);
                return TerminalQueryResult.Parse(writer.ToArray());
            }
        }

        private sealed class TwoCandleSource : ITerminalProjectionSource
        {
            public ProjectionSyncBatch Fetch(ProjectionSyncRequest request)
            {
                List<CandleRecord> candles = new List<CandleRecord>();
                for (int i = 0; i < 2; i++)
                {
                    candles.Add(new CandleRecord { Symbol = "XAUUSD", Timeframe = "M5", OpenTimeUtcMsc = Now + i,
                        Open = 1, High = 2, Low = 0.5, Close = 1.5, TickVolume = 10, RealVolume = 0,
                        Spread = 0.2, Closed = true, SourceRevision = "terminal-revision", ObservedAtUtcMsc = Now + i,
                        LastAccessedUtcMsc = Now + i });
                }
                return new ProjectionSyncBatch { Resource = request.Resource, ScopeKey = request.ScopeKey,
                    CoveredRangeStartUtcMsc = request.RangeStartUtcMsc, CoveredRangeEndUtcMsc = request.RangeEndUtcMsc,
                    SourceRevision = "terminal-revision", Candles = candles, History = new List<HistoryItemRecord>(), PublishCoverage = true, HasMore = false };
            }
        }

        private sealed class FakeChannel : IBridgeMessageChannel
        {
            private string incoming;
            public FakeChannel(string value) { incoming = value; Sent = new List<string>(); }
            public IList<string> Sent { get; private set; }
            public string Receive() { string value = incoming; incoming = null; return value; }
            public void Send(string value) { Sent.Add(value); }
            public void Dispose() { }
        }
    }
}
