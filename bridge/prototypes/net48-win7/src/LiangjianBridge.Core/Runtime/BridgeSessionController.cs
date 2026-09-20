using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class BridgeSessionConfiguration
    {
        public string InstallationId { get; set; }
        public string BridgeVersion { get; set; }
        public string TerminalVersion { get; set; }
        public string TradePermission { get; set; }
        public int? TimezoneOffsetMinutes { get; set; }
        public string ClockStatus { get; set; }
        public Func<long, IDictionary<string, object>> AccountFactsProvider { get; set; }
        public Func<long, string> AccountStreamProvider { get; set; }
        public Func<long, string[]> TradeStreamsProvider { get; set; }
        public Func<long, string[]> MarketStreamsProvider { get; set; }
        public Func<long, string[]> MarketQuotesProvider { get; set; }
    }

    public sealed class BridgeSessionController
    {
        private static readonly string[] Capabilities =
        {
            "query_v4", "command_v4", "projection_cache_v1", "release_v4"
        };

        private readonly ProfileRuntime runtime;
        private readonly BridgeProfileSession profileSession;
        private readonly BridgeSessionConfiguration configuration;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private string sessionId;
        private string lastReceivedMessageId;
        private int retryAttempt;

        public BridgeSessionController(ProfileRuntime runtimeValue, BridgeProfileSession profileSessionValue,
            BridgeSessionConfiguration configurationValue)
        {
            if (runtimeValue == null || profileSessionValue == null || configurationValue == null)
            {
                throw new ArgumentNullException("runtimeValue");
            }
            ValidateConfiguration(configurationValue);
            runtime = runtimeValue;
            profileSession = profileSessionValue;
            configuration = configurationValue;
            State = "disconnected";
            serializer.MaxJsonLength = 1024 * 1024;
            Updates = new UpdateRestartCoordinator();
        }

        public string State { get; private set; }
        public string ConnectionId { get; private set; }
        public long NextConnectAtUtcMsc { get; private set; }
        public long NextHeartbeatAtUtcMsc { get; private set; }
        public int HeartbeatIntervalMsc { get; private set; }
        public long HeartbeatAckDeadlineUtcMsc { get; private set; }
        public UpdateRestartCoordinator Updates { get; private set; }

        public bool CanConnect(long nowUtcMsc)
        {
            return (State == "disconnected" || State == "backoff") && nowUtcMsc >= NextConnectAtUtcMsc;
        }

        public string Begin(long nowUtcMsc)
        {
            if (!CanConnect(nowUtcMsc) || nowUtcMsc < 1)
            {
                throw new InvalidOperationException("bridge_session_connect_not_due");
            }
            runtime.RebindEpoch(checked(runtime.ConnectionEpoch + 1));
            profileSession.PrepareReconnect(nowUtcMsc);
            sessionId = "session-" + Guid.NewGuid().ToString("N");
            ConnectionId = null;
            lastReceivedMessageId = null;
            HeartbeatIntervalMsc = 0;
            NextHeartbeatAtUtcMsc = 0;
            HeartbeatAckDeadlineUtcMsc = 0;
            IDictionary<string, object> payload = HelloPayload(nowUtcMsc);
            State = "awaiting_welcome";
            return Envelope("session.hello", null, payload, nowUtcMsc);
        }

        public string Handle(string json, long nowUtcMsc)
        {
            BridgeEnvelope envelope = BridgeEnvelope.Parse(json);
            lastReceivedMessageId = envelope.MessageId;
            if (State == "awaiting_welcome")
            {
                AcceptWelcome(envelope, nowUtcMsc);
                return null;
            }
            if (State != "active")
            {
                throw new InvalidOperationException("bridge_session_not_active");
            }
            if (envelope.MessageType == "system.heartbeat")
            {
                ValidateHeartbeat(envelope);
                return Envelope("system.heartbeat_ack", envelope.MessageId, HeartbeatPayload(nowUtcMsc), nowUtcMsc);
            }
            if (envelope.MessageType == "system.heartbeat_ack")
            {
                ValidateHeartbeat(envelope);
                HeartbeatAckDeadlineUtcMsc = 0;
                return null;
            }
            if (envelope.MessageType == "release.available")
            {
                Updates.Observe(envelope);
                return null;
            }
            return profileSession.Handle(json, nowUtcMsc);
        }

        public string[] ReadMarketQuotes(long nowUtcMsc) { return configuration.MarketQuotesProvider == null ? new string[0] : configuration.MarketQuotesProvider(nowUtcMsc); }
        public string[] ReadMarketStreams(long nowUtcMsc) { return configuration.MarketStreamsProvider == null ? new string[0] : configuration.MarketStreamsProvider(nowUtcMsc); }
        public string[] ReadTradeStreams(long nowUtcMsc) { return configuration.TradeStreamsProvider == null ? new string[0] : configuration.TradeStreamsProvider(nowUtcMsc); }

        public string CreateAccountStream(long nowUtcMsc) { return State == "active" && configuration.AccountStreamProvider != null ? configuration.AccountStreamProvider(nowUtcMsc) : null; }

        public string CreateHeartbeat(long nowUtcMsc)
        {
            if (State != "active" || nowUtcMsc < NextHeartbeatAtUtcMsc)
            {
                return null;
            }
            NextHeartbeatAtUtcMsc = checked(nowUtcMsc + HeartbeatIntervalMsc);
            HeartbeatAckDeadlineUtcMsc = checked(nowUtcMsc + (HeartbeatIntervalMsc * 2L));
            return Envelope("system.heartbeat", null, HeartbeatPayload(nowUtcMsc), nowUtcMsc);
        }

        public string CreateReleaseStatus(ReleaseActivationStatus status, long nowUtcMsc)
        {
            if (State != "active" || status == null || nowUtcMsc < 1)
                throw new InvalidOperationException("bridge_release_status_not_ready");
            return Envelope("release.status", null, new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "release_id", status.ReleaseId }, { "target_version", status.TargetVersion },
                { "state", status.State }, { "reported_at_utc_msc", status.ReportedAtUtcMsc },
                { "error_code", status.ErrorCode }
            }, nowUtcMsc);
        }

        public void AfterResponseSent(long nowUtcMsc)
        {
            if (State != "active" || nowUtcMsc < 1)
                throw new InvalidOperationException("bridge_session_not_active");
            profileSession.AfterResponseSent(nowUtcMsc);
        }

        public bool HeartbeatExpired(long nowUtcMsc)
        {
            return State == "active" && HeartbeatAckDeadlineUtcMsc > 0 && nowUtcMsc >= HeartbeatAckDeadlineUtcMsc;
        }

        public void MarkDisconnected(long nowUtcMsc)
        {
            if (nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_session_time_invalid");
            }
            retryAttempt = Math.Min(retryAttempt + 1, 6);
            long delay = Math.Min(30000L, 1000L << (retryAttempt - 1));
            State = "backoff";
            ConnectionId = null;
            NextHeartbeatAtUtcMsc = 0;
            HeartbeatAckDeadlineUtcMsc = 0;
            NextConnectAtUtcMsc = checked(nowUtcMsc + delay);
        }

        private void AcceptWelcome(BridgeEnvelope envelope, long nowUtcMsc)
        {
            if (envelope.MessageType != "session.welcome")
            {
                throw new InvalidDataException("bridge_session_welcome_required");
            }
            RequireOnly(envelope.Payload, "session_id", "connection_id", "accepted_protocol_version", "heartbeat_interval_ms", "limits");
            string receivedSessionId = ReadText(envelope.Payload, "session_id", 191);
            int version = ReadInt(envelope.Payload, "accepted_protocol_version", 4, 4);
            int interval = ReadInt(envelope.Payload, "heartbeat_interval_ms", 5000, 60000);
            IDictionary<string, object> limits = ReadObject(envelope.Payload, "limits");
            RequireOnly(limits, "max_frame_bytes", "max_page_size", "max_inflight_queries", "max_inflight_commands");
            ReadInt(limits, "max_frame_bytes", 65536, 524288);
            ReadInt(limits, "max_page_size", 1, 500);
            ReadInt(limits, "max_inflight_queries", 1, 64);
            ReadInt(limits, "max_inflight_commands", 1, 32);
            if (receivedSessionId != sessionId || version != 4)
            {
                throw new InvalidDataException("bridge_session_welcome_mismatch");
            }
            ConnectionId = ReadText(envelope.Payload, "connection_id", 191);
            HeartbeatIntervalMsc = interval;
            NextHeartbeatAtUtcMsc = checked(nowUtcMsc + interval);
            HeartbeatAckDeadlineUtcMsc = 0;
            NextConnectAtUtcMsc = 0;
            retryAttempt = 0;
            State = "active";
        }

        private IDictionary<string, object> HelloPayload(long nowUtcMsc)
        {
            ProfileRuntimeConfiguration route = runtime.Configuration;
            Dictionary<string, object> account = new Dictionary<string, object>
                { { "broker_server", route.BrokerServer }, { "login", route.Login } };
            Dictionary<string, object> terminal = new Dictionary<string, object>
            {
                { "route", new Dictionary<string, object> { { "terminal_instance_id", route.TerminalInstanceId },
                    { "account_ref", account }, { "connection_epoch", runtime.ConnectionEpoch } } },
                { "platform", route.Platform.ToLowerInvariant() }, { "terminal_version", configuration.TerminalVersion },
                { "trade_permission", configuration.TradePermission }, { "timezone_offset_minutes", configuration.TimezoneOffsetMinutes },
                { "clock_status", configuration.ClockStatus }
            };
            // Compatibility callers may omit facts; production supplies a fresh
            // terminal query on every Begin, including reconnects.
            if (configuration.AccountFactsProvider != null)
                terminal.Add("account_facts", configuration.AccountFactsProvider(nowUtcMsc));
            return new Dictionary<string, object>
            {
                { "session_id", sessionId }, { "installation_id", configuration.InstallationId },
                { "profile_id", route.ProfileId }, { "bridge_version", configuration.BridgeVersion },
                { "protocol_versions", new object[] { 4 } }, { "platforms", new object[] { route.Platform.ToLowerInvariant() } },
                { "capabilities", Capabilities },
                { "limits", new Dictionary<string, object> { { "max_frame_bytes", 262144 }, { "max_page_size", 500 },
                    { "max_inflight_queries", 16 }, { "max_inflight_commands", 8 } } },
                { "terminals", new object[] { terminal } }
            };
        }

        private IDictionary<string, object> HeartbeatPayload(long nowUtcMsc)
        {
            int results = runtime.DataStore.ReadPendingOutbox(nowUtcMsc, 500, null).Items.Count;
            return new Dictionary<string, object>
            {
                { "session_id", sessionId }, { "last_received_message_id", lastReceivedMessageId },
                { "queue", new Dictionary<string, object> { { "commands", 0 }, { "results", results }, { "queries", 0 }, { "stream_events", 0 } } }
            };
        }

        private void ValidateHeartbeat(BridgeEnvelope envelope)
        {
            RequireOnly(envelope.Payload, "session_id", "last_received_message_id", "queue");
            if (ReadText(envelope.Payload, "session_id", 191) != sessionId)
            {
                throw new InvalidDataException("bridge_session_heartbeat_mismatch");
            }
            object lastReceived;
            if (!envelope.Payload.TryGetValue("last_received_message_id", out lastReceived)
                || (lastReceived != null && (!(lastReceived is string) || ((string)lastReceived).Length == 0 || ((string)lastReceived).Length > 191)))
            {
                throw new InvalidDataException("bridge_session_heartbeat_invalid");
            }
            IDictionary<string, object> queue = ReadObject(envelope.Payload, "queue");
            RequireOnly(queue, "commands", "results", "queries", "stream_events");
            ReadInt(queue, "commands", 0, int.MaxValue);
            ReadInt(queue, "results", 0, int.MaxValue);
            ReadInt(queue, "queries", 0, int.MaxValue);
            ReadInt(queue, "stream_events", 0, int.MaxValue);
        }

        private string Envelope(string type, string correlationId, IDictionary<string, object> payload, long nowUtcMsc)
        {
            return serializer.Serialize(new Dictionary<string, object>
            {
                { "v", 4 }, { "message_id", "bridge-" + Guid.NewGuid().ToString("N") }, { "type", type },
                { "sent_at_utc_msc", nowUtcMsc }, { "correlation_id", correlationId }, { "payload", payload }
            });
        }

        private static void ValidateConfiguration(BridgeSessionConfiguration value)
        {
            if (string.IsNullOrWhiteSpace(value.InstallationId) || string.IsNullOrWhiteSpace(value.BridgeVersion)
                || string.IsNullOrWhiteSpace(value.TerminalVersion)
                || (value.TradePermission != "full" && value.TradePermission != "read_only" && value.TradePermission != "disabled" && value.TradePermission != "unknown")
                || (value.ClockStatus != "calibrated" && value.ClockStatus != "observer_bootstrap" && value.ClockStatus != "stale" && value.ClockStatus != "unavailable"))
            {
                throw new InvalidDataException("bridge_session_configuration_invalid");
            }
        }

        private static void RequireOnly(IDictionary<string, object> values, params string[] fields)
        {
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string key in values.Keys) if (!expected.Remove(key)) throw new InvalidDataException("bridge_session_payload_invalid");
            if (expected.Count != 0) throw new InvalidDataException("bridge_session_payload_invalid");
        }
        private static IDictionary<string, object> ReadObject(IDictionary<string, object> values, string key)
        {
            object raw; IDictionary<string, object> result;
            if (!values.TryGetValue(key, out raw) || (result = raw as IDictionary<string, object>) == null) throw new InvalidDataException("bridge_session_payload_invalid");
            return result;
        }
        private static string ReadText(IDictionary<string, object> values, string key, int max)
        {
            object raw; string result;
            if (!values.TryGetValue(key, out raw) || (result = raw as string) == null || result.Length == 0 || result.Length > max) throw new InvalidDataException("bridge_session_payload_invalid");
            return result;
        }
        private static int ReadInt(IDictionary<string, object> values, string key, int min, int max)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || !(raw is int) || (int)raw < min || (int)raw > max) throw new InvalidDataException("bridge_session_payload_invalid");
            return (int)raw;
        }
    }
}
