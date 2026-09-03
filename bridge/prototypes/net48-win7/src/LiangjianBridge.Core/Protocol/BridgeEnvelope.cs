using System;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Protocol
{
    public sealed class BridgeEnvelope
    {
        private static readonly HashSet<string> KnownFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "v", "message_id", "type", "sent_at_utc_msc", "correlation_id", "route", "payload"
        };

        private static readonly HashSet<string> KnownTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "session.hello", "session.welcome", "system.heartbeat", "system.heartbeat_ack",
            "query.request", "query.response", "query.error", "stream.subscribe", "stream.unsubscribe",
            "stream.event", "stream.ack", "command.request", "command.accepted", "command.result",
            "command.result_ack", "command.reconcile", "data.persisted.ack", "release.available", "release.status", "protocol.error"
        };

        private BridgeEnvelope()
        {
        }

        public int ProtocolVersion { get; private set; }
        public string MessageType { get; private set; }
        public string MessageId { get; private set; }
        public long SentAtUtcMsc { get; private set; }
        public string TerminalInstanceId { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public long ConnectionEpoch { get; private set; }
        public string CorrelationId { get; private set; }
        public IDictionary<string, object> Payload { get; private set; }

        public static BridgeEnvelope Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > 1024 * 1024)
            {
                throw new BridgeProtocolException("bridge_envelope_size_invalid");
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 1024 * 1024;
            IDictionary<string, object> root;
            try
            {
                root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                throw new BridgeProtocolException("bridge_json_invalid");
            }
            catch (InvalidOperationException)
            {
                throw new BridgeProtocolException("bridge_json_invalid");
            }

            if (root == null)
            {
                throw new BridgeProtocolException("bridge_envelope_invalid");
            }

            foreach (string field in root.Keys)
            {
                if (!KnownFields.Contains(field))
                {
                    throw new BridgeProtocolException("bridge_envelope_unknown_field");
                }
            }

            int protocolVersion = ReadInt(root, "v");
            string messageType = ReadText(root, "type", 64);
            if (protocolVersion != 4)
            {
                throw new BridgeProtocolException("bridge_protocol_version_unsupported");
            }
            if (!KnownTypes.Contains(messageType))
            {
                throw new BridgeProtocolException("bridge_message_type_unsupported");
            }

            long sentAtUtcMsc = ReadLong(root, "sent_at_utc_msc");
            if (sentAtUtcMsc < 1 || sentAtUtcMsc > 9007199254740991L)
            {
                throw new BridgeProtocolException("bridge_sent_at_utc_msc_invalid");
            }

            BridgeEnvelope envelope = new BridgeEnvelope();
            envelope.ProtocolVersion = protocolVersion;
            envelope.MessageType = messageType;
            envelope.MessageId = ReadText(root, "message_id", 128);
            envelope.SentAtUtcMsc = sentAtUtcMsc;
            envelope.CorrelationId = ReadOptionalText(root, "correlation_id", 191);
            envelope.Payload = ReadPayload(root);
            ReadOptionalRoute(root, envelope);
            return envelope;
        }

        private static void ReadOptionalRoute(IDictionary<string, object> root, BridgeEnvelope envelope)
        {
            object routeValue;
            if (!root.TryGetValue("route", out routeValue) || routeValue == null)
            {
                return;
            }
            IDictionary<string, object> route = routeValue as IDictionary<string, object>;
            if (route == null || route.Count != 3)
            {
                throw new BridgeProtocolException("bridge_route_invalid");
            }
            foreach (string field in route.Keys)
            {
                if (field != "terminal_instance_id" && field != "account_ref" && field != "connection_epoch")
                {
                    throw new BridgeProtocolException("bridge_route_unknown_field");
                }
            }
            object accountValue;
            IDictionary<string, object> account;
            if (!route.TryGetValue("account_ref", out accountValue)
                || (account = accountValue as IDictionary<string, object>) == null
                || account.Count != 2)
            {
                throw new BridgeProtocolException("bridge_account_ref_invalid");
            }
            foreach (string field in account.Keys)
            {
                if (field != "broker_server" && field != "login")
                {
                    throw new BridgeProtocolException("bridge_account_ref_unknown_field");
                }
            }
            envelope.TerminalInstanceId = ReadText(route, "terminal_instance_id", 191);
            envelope.BrokerServer = ReadText(account, "broker_server", 128);
            envelope.Login = ReadText(account, "login", 64);
            envelope.ConnectionEpoch = ReadLong(route, "connection_epoch");
            if (envelope.ConnectionEpoch < 1)
            {
                throw new BridgeProtocolException("bridge_connection_epoch_invalid");
            }
        }

        private static IDictionary<string, object> ReadPayload(IDictionary<string, object> root)
        {
            object value;
            if (!root.TryGetValue("payload", out value) || value == null)
            {
                return new Dictionary<string, object>(StringComparer.Ordinal);
            }
            IDictionary<string, object> payload = value as IDictionary<string, object>;
            if (payload == null)
            {
                throw new BridgeProtocolException("bridge_payload_invalid");
            }
            return payload;
        }

        private static int ReadInt(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value) || !(value is int))
            {
                throw new BridgeProtocolException("bridge_" + field + "_invalid");
            }
            return (int)value;
        }

        private static long ReadLong(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value))
            {
                throw new BridgeProtocolException("bridge_" + field + "_invalid");
            }
            if (value is int)
            {
                return (int)value;
            }
            if (value is long)
            {
                return (long)value;
            }
            throw new BridgeProtocolException("bridge_" + field + "_invalid");
        }

        private static string ReadText(IDictionary<string, object> root, string field, int maxLength)
        {
            object value;
            string text;
            if (!root.TryGetValue(field, out value) || (text = value as string) == null || text.Length == 0 || text.Length > maxLength)
            {
                throw new BridgeProtocolException("bridge_" + field + "_invalid");
            }
            return text;
        }

        private static string ReadOptionalText(IDictionary<string, object> root, string field, int maxLength)
        {
            object value;
            if (!root.TryGetValue(field, out value) || value == null)
            {
                return null;
            }
            string text = value as string;
            if (string.IsNullOrEmpty(text) || text.Length > maxLength)
            {
                throw new BridgeProtocolException("bridge_" + field + "_invalid");
            }
            return text;
        }
    }

    public sealed class BridgeProtocolException : Exception
    {
        public BridgeProtocolException(string code)
            : base(code)
        {
        }
    }
}
