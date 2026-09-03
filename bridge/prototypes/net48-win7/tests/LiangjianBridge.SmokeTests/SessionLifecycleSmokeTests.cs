using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Terminal;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class SessionLifecycleSmokeTests
    {
        private const long Now = 1788307200000;

        public static void TestHelloHeartbeatAndBackoff()
        {
            string root = NewRoot("lifecycle");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    BridgeSessionController controller = Controller(runtime);
                    string helloJson = controller.Begin(Now);
                    IDictionary<string, object> hello = Parse(helloJson);
                    IDictionary<string, object> helloPayload = Object(hello, "payload");
                    Assert((string)hello["type"] == "session.hello" && runtime.ConnectionEpoch == 2,
                        "session_hello_or_epoch_wrong");
                    string sessionId = (string)helloPayload["session_id"];
                    controller.Handle(Welcome(sessionId, "connection-a"), Now + 1);
                    Assert(controller.State == "active" && controller.ConnectionId == "connection-a",
                        "session_welcome_not_accepted");
                    Assert(controller.CreateHeartbeat(Now + 4999) == null, "heartbeat_sent_too_early");
                    string heartbeat = controller.CreateHeartbeat(Now + 5001);
                    Assert((string)Parse(heartbeat)["type"] == "system.heartbeat", "heartbeat_not_sent");
                    Assert(!controller.HeartbeatExpired(Now + 15000) && controller.HeartbeatExpired(Now + 15001),
                        "heartbeat_timeout_wrong");

                    controller.Handle(Heartbeat(sessionId, "heartbeat-ack", Now + 5002, "system.heartbeat_ack"), Now + 5002);
                    Assert(!controller.HeartbeatExpired(Now + 20000), "heartbeat_ack_not_recorded");

                    string serverHeartbeat = Heartbeat(sessionId, "server-heartbeat", Now + 5002, "system.heartbeat");
                    string heartbeatAck = controller.Handle(serverHeartbeat, Now + 5002);
                    Assert((string)Parse(heartbeatAck)["type"] == "system.heartbeat_ack", "heartbeat_not_acknowledged");

                    string query = Query(runtime.ConnectionEpoch, Now + 5003);
                    string response = controller.Handle(query, Now + 5003);
                    Assert((string)Parse(response)["type"] == "query.response", "active_query_not_routed");
                    controller.MarkDisconnected(Now + 6000);
                    Assert(controller.State == "backoff" && !controller.CanConnect(Now + 6999)
                        && controller.CanConnect(Now + 7000), "first_backoff_wrong");
                    controller.Begin(Now + 7000);
                    Assert(runtime.ConnectionEpoch == 3, "reconnect_epoch_not_advanced");
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestWorkerReconnects()
        {
            string root = NewRoot("worker-reconnect");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    ReconnectFactory factory = new ReconnectFactory();
                    using (BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), factory))
                    {
                        worker.Start();
                        worker.Start();
                        int started = Environment.TickCount;
                        while ((factory.ConnectCount < 2 || factory.HelloCount < 1)
                            && unchecked(Environment.TickCount - started) < 5000)
                        {
                            Thread.Sleep(25);
                        }
                        Assert(factory.ConnectCount >= 2, "profile_worker_did_not_reconnect");
                        Assert(factory.HelloCount >= 1, "profile_worker_did_not_send_hello");
                    }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestUpdateRestartGate()
        {
            string root = NewRoot("update-gate");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    BridgeSessionController controller = Controller(runtime);
                    string hello = controller.Begin(Now);
                    string sessionId = (string)Object(Parse(hello), "payload")["session_id"];
                    controller.Handle(Welcome(sessionId, "connection-update"), Now + 1);
                    controller.Handle(Release(Now + 10000), Now + 2);
                    UpdateRestartCoordinator updates = controller.Updates;
                    Assert(updates.Pending != null && !updates.Pending.Staged, "release_not_observed");
                    Assert(updates.ReadyVersion(Now + 20000, Idle()) == null, "unstaged_release_restart_allowed");
                    updates.MarkStaged("release-123");
                    Assert(updates.ReadyVersion(Now + 9999, Idle()) == null, "release_restarted_before_server_time");
                    Assert(updates.ReadyVersion(Now + 10000, new UpdateActivitySnapshot { ActiveCommands = 1 }) == null,
                        "release_restarted_during_command");
                    Assert(updates.ReadyVersion(Now + 10000, new UpdateActivitySnapshot { UncertainCommands = 1 }) == null,
                        "release_restarted_with_uncertain_command");
                    Assert(updates.ReadyVersion(Now + 10000, new UpdateActivitySnapshot { PendingCriticalWrites = 1 }) == null,
                        "release_restarted_during_critical_write");
                    Assert(updates.ReadyVersion(Now + 10000, Idle()) == "4.1.0", "idle_staged_release_not_ready");
                    string activated = null;
                    Assert(updates.TryActivateAndRestart(Now + 10000, Idle(), delegate(string version)
                    {
                        activated = version;
                        return true;
                    }), "ready_release_not_activated");
                    Assert(activated == "4.1.0" && updates.Pending == null, "activated_release_not_cleared");
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestWorkerPauseAndResumeForUpdate()
        {
            string root = NewRoot("worker-update-pause");
            try
            {
                using (ProfileRuntime runtime = Runtime(root))
                {
                    PauseFactory factory = new PauseFactory();
                    using (BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), factory))
                    {
                        worker.Start();
                        WaitUntil(delegate { return worker.State == "active"; }, 3000,
                            "profile_worker_never_became_active");
                        Assert(worker.PauseForUpdate(3000), "profile_worker_pause_failed");
                        int pausedConnects = factory.ConnectCount;
                        Assert(worker.State == "update_wait" && worker.ActiveOperations == 0,
                            "profile_worker_not_idle_while_paused");
                        Thread.Sleep(1200);
                        Assert(factory.ConnectCount == pausedConnects, "profile_worker_reconnected_while_paused");
                        worker.ResumeAfterUpdate();
                        WaitUntil(delegate { return factory.ConnectCount > pausedConnects; }, 4000,
                            "profile_worker_did_not_resume");
                    }
                }
            }
            finally { DeleteRoot(root); }
        }

        public static void TestWorkerReportsReleaseStatus()
        {
            string root = NewRoot("worker-release-status");
            try
            {
                ReleaseActivationStatusStore store = new ReleaseActivationStatusStore(
                    Path.Combine(root, "activation-status.json"));
                store.Write(new ReleaseActivationStatus
                {
                    ReleaseId = "release-status-1", TargetVersion = "4.2.0", State = "healthy",
                    ReportedAtUtcMsc = Now, ErrorCode = null
                });
                using (ProfileRuntime runtime = Runtime(root))
                {
                    StatusFactory factory = new StatusFactory();
                    using (BridgeProfileWorker worker = new BridgeProfileWorker(runtime, Controller(runtime), factory, store))
                    {
                        worker.Start();
                        WaitUntil(delegate { return factory.StatusJson != null; }, 4000,
                            "release_status_not_sent");
                        IDictionary<string, object> envelope = Parse(factory.StatusJson);
                        IDictionary<string, object> payload = Object(envelope, "payload");
                        Assert((string)envelope["type"] == "release.status"
                            && (string)payload["release_id"] == "release-status-1"
                            && (string)payload["target_version"] == "4.2.0"
                            && (string)payload["state"] == "healthy",
                            "release_status_envelope_invalid");
                    }
                }
            }
            finally { DeleteRoot(root); }
        }

        private static BridgeSessionController Controller(ProfileRuntime runtime)
        {
            BridgeProfileSession profile = new BridgeProfileSession(runtime, new StaticTerminalSource());
            return new BridgeSessionController(runtime, profile, new BridgeSessionConfiguration
            {
                InstallationId = "installation-123", BridgeVersion = "4.0.0", TerminalVersion = "1441",
                TradePermission = "read_only", TimezoneOffsetMinutes = 180, ClockStatus = "calibrated"
            });
        }

        private static string Welcome(string sessionId, string connectionId)
        {
            return Envelope("session.welcome", "welcome-message", new Dictionary<string, object>
            {
                { "session_id", sessionId }, { "connection_id", connectionId }, { "accepted_protocol_version", 4 },
                { "heartbeat_interval_ms", 5000 }, { "limits", Limits() }
            }, Now + 1, null);
        }

        private static string Heartbeat(string sessionId, string messageId, long now, string type)
        {
            return Envelope(type, messageId, new Dictionary<string, object>
            {
                { "session_id", sessionId }, { "last_received_message_id", null },
                { "queue", new Dictionary<string, object> { { "commands", 0 }, { "results", 0 }, { "queries", 0 }, { "stream_events", 0 } } }
            }, now, null);
        }

        private static string Query(long epoch, long now)
        {
            Dictionary<string, object> route = new Dictionary<string, object>
            {
                { "terminal_instance_id", "terminal-a" },
                { "account_ref", new Dictionary<string, object> { { "broker_server", "Demo" }, { "login", "10001" } } },
                { "connection_epoch", epoch }
            };
            return Envelope("query.request", "query-message", new Dictionary<string, object>
            {
                { "request_id", "query-request" }, { "resource", "account.snapshot" },
                { "params", new Dictionary<string, object>() }, { "deadline_utc_msc", now + 10000 }
            }, now, route);
        }

        private static string Release(long restartNotBefore)
        {
            return Envelope("release.available", "release-message", new Dictionary<string, object>
            {
                { "release_id", "release-123" }, { "release_version", "4.1.0" }, { "rollout_channel", "stable" },
                { "reason", "published" }, { "manifest_url", "https://download.example.test/manifest.json" },
                { "restart_not_before_utc_msc", restartNotBefore }
            }, Now + 2, null);
        }

        private static string Envelope(string type, string messageId, IDictionary<string, object> payload,
            long now, IDictionary<string, object> route)
        {
            Dictionary<string, object> root = new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", messageId }, { "type", type }, { "sent_at_utc_msc", now },
                { "correlation_id", null }, { "payload", payload }
            };
            if (route != null) root.Add("route", route);
            return new JavaScriptSerializer().Serialize(root);
        }

        private static IDictionary<string, object> Limits()
        {
            return new Dictionary<string, object> { { "max_frame_bytes", 262144 }, { "max_page_size", 500 },
                { "max_inflight_queries", 16 }, { "max_inflight_commands", 8 } };
        }
        private static UpdateActivitySnapshot Idle() { return new UpdateActivitySnapshot(); }
        private static ProfileRuntime Runtime(string root) { return new ProfileRuntime(new ProfileRuntimeConfiguration(
            Path.Combine(root, "profile.db"), "profile-a", "terminal-a", "mt4", "Demo", "10001", 1)); }
        private static IDictionary<string, object> Parse(string json) { return (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json); }
        private static IDictionary<string, object> Object(IDictionary<string, object> value, string key) { return (IDictionary<string, object>)value[key]; }
        private static string NewRoot(string suffix) { string path = Path.Combine(Path.GetTempPath(), "bridge-v4-" + suffix + "-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path); return path; }
        private static void DeleteRoot(string root) { if (Directory.Exists(root)) Directory.Delete(root, true); }
        private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        private static void WaitUntil(Func<bool> condition, int timeoutMilliseconds, string message)
        {
            int started = Environment.TickCount;
            while (!condition())
            {
                if (unchecked(Environment.TickCount - started) >= timeoutMilliseconds)
                    throw new TimeoutException(message);
                Thread.Sleep(25);
            }
        }

        private sealed class StaticTerminalSource : ITerminalQuerySource
        {
            public TerminalQueryResult Query(ProfileRuntime runtime, BridgeQueryRequest request, long nowUtcMsc)
            {
                TerminalWireWriter writer = new TerminalWireWriter();
                writer.WriteInt32((int)TerminalWireMessageType.QueryResponse); writer.WriteString(request.RequestId);
                writer.WriteInt32((int)TerminalQueryTranslator.ResourceCode(request.Resource)); writer.WriteInt64(nowUtcMsc);
                writer.WriteInt32(180); writer.WriteString("calibrated"); writer.WriteString("{\"balance\":1000}");
                writer.WriteString(string.Empty); writer.WriteInt32(0);
                return TerminalQueryResult.Parse(writer.ToArray());
            }
        }

        private sealed class ReconnectFactory : IBridgeMessageChannelFactory
        {
            private int connects;
            private int hellos;
            public int ConnectCount { get { return Volatile.Read(ref connects); } }
            public int HelloCount { get { return Volatile.Read(ref hellos); } }
            public IBridgeMessageChannel Connect()
            {
                int current = Interlocked.Increment(ref connects);
                if (current == 1) throw new IOException("simulated_connect_failure");
                return new WelcomeThenCloseChannel(delegate { Interlocked.Increment(ref hellos); });
            }
        }

        private sealed class WelcomeThenCloseChannel : IBridgeMessageChannel
        {
            private readonly Action helloSeen;
            private string sessionId;
            private int reads;
            public WelcomeThenCloseChannel(Action action) { helloSeen = action; }
            public void Send(string json)
            {
                IDictionary<string, object> root = Parse(json);
                if ((string)root["type"] == "session.hello")
                {
                    sessionId = (string)Object(root, "payload")["session_id"];
                    helloSeen();
                }
            }
            public string Receive()
            {
                if (Interlocked.Increment(ref reads) == 1) return Welcome(sessionId, "worker-connection");
                return null;
            }
            public void Dispose() { }
        }

        private sealed class PauseFactory : IBridgeMessageChannelFactory
        {
            private int connects;
            public int ConnectCount { get { return Volatile.Read(ref connects); } }
            public IBridgeMessageChannel Connect()
            {
                Interlocked.Increment(ref connects);
                return new PauseChannel();
            }
        }

        private sealed class PauseChannel : IBridgeMessageChannel
        {
            private readonly ManualResetEvent closed = new ManualResetEvent(false);
            private string sessionId;
            private int reads;
            public void Send(string json)
            {
                IDictionary<string, object> root = Parse(json);
                if ((string)root["type"] == "session.hello")
                    sessionId = (string)Object(root, "payload")["session_id"];
            }
            public string Receive()
            {
                if (Interlocked.Increment(ref reads) == 1)
                    return Welcome(sessionId, "pause-worker-connection");
                closed.WaitOne();
                return null;
            }
            public void Dispose() { closed.Set(); }
        }

        private sealed class StatusFactory : IBridgeMessageChannelFactory
        {
            private volatile string statusJson;
            public string StatusJson { get { return statusJson; } }
            public IBridgeMessageChannel Connect() { return new StatusChannel(this); }
            public void Capture(string value) { statusJson = value; }
        }

        private sealed class StatusChannel : IBridgeMessageChannel
        {
            private readonly StatusFactory owner;
            private readonly ManualResetEvent closed = new ManualResetEvent(false);
            private string sessionId;
            private int reads;
            public StatusChannel(StatusFactory value) { owner = value; }
            public void Send(string json)
            {
                IDictionary<string, object> root = Parse(json);
                string type = (string)root["type"];
                if (type == "session.hello") sessionId = (string)Object(root, "payload")["session_id"];
                if (type == "release.status") owner.Capture(json);
            }
            public string Receive()
            {
                if (Interlocked.Increment(ref reads) == 1)
                    return Welcome(sessionId, "status-worker-connection");
                closed.WaitOne();
                return null;
            }
            public void Dispose() { closed.Set(); }
        }
    }
}
