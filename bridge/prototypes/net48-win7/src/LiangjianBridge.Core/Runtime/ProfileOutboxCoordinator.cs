using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.Runtime
{
    public interface IBridgeMessageSink
    {
        void Send(string envelopeJson);
    }

    public sealed class ProfileOutboxCoordinator
    {
        private const long AwaitingAckDelayMsc = 15000;
        private const long FailureRetryDelayMsc = 5000;

        public bool Enqueue(
            ProfileRuntime runtime,
            string messageId,
            string messageKind,
            string envelopeJson,
            int priority,
            long nowUtcMsc)
        {
            if (runtime == null)
            {
                throw new ArgumentNullException("runtime");
            }
            return runtime.DataStore.EnqueueOutboxMessage(runtime.ConnectionEpoch, new OutboxMessageRecord
            {
                MessageId = messageId,
                ConnectionEpoch = runtime.ConnectionEpoch,
                MessageKind = messageKind,
                PayloadJson = envelopeJson,
                Priority = priority,
                NextAttemptAtUtcMsc = nowUtcMsc,
                Attempt = 0,
                CreatedAtUtcMsc = nowUtcMsc
            });
        }

        public OutboxPage ReadPending(ProfileRuntime runtime, long nowUtcMsc, int limit, OutboxCursor cursor)
        {
            if (runtime == null)
            {
                throw new ArgumentNullException("runtime");
            }
            return runtime.DataStore.ReadPendingOutbox(nowUtcMsc, limit, cursor);
        }

        public bool FlushOne(ProfileRuntime runtime, IBridgeMessageSink sink, long nowUtcMsc)
        {
            if (runtime == null || sink == null || nowUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_outbox_flush_invalid");
            }
            OutboxMessageRecord message = runtime.DataStore.ReadNextUnacknowledgedOutbox(nowUtcMsc);
            if (message == null)
            {
                return false;
            }
            try
            {
                sink.Send(RefreshRoute(runtime, message.PayloadJson, nowUtcMsc));
                runtime.DataStore.MarkDurableOutboxAttempt(message.ConnectionEpoch, message.MessageId, message.Attempt,
                    nowUtcMsc, checked(nowUtcMsc + AwaitingAckDelayMsc), "awaiting_server_ack", null);
            }
            catch (Exception error)
            {
                runtime.DataStore.MarkDurableOutboxAttempt(message.ConnectionEpoch, message.MessageId, message.Attempt,
                    nowUtcMsc, checked(nowUtcMsc + FailureRetryDelayMsc), "transport_send_failed", Limit(error.Message, 1024));
            }
            return true;
        }

        public bool AcknowledgeMessage(ProfileRuntime runtime, string messageId, long ackedAtUtcMsc)
        {
            if (runtime == null)
            {
                throw new ArgumentNullException("runtime");
            }
            return runtime.DataStore.AckOutboxMessage(runtime.ConnectionEpoch, messageId, ackedAtUtcMsc);
        }

        public bool AcknowledgeDurableMessage(ProfileRuntime runtime, string messageId, long ackedAtUtcMsc)
        {
            if (runtime == null) throw new ArgumentNullException("runtime");
            return runtime.DataStore.AckDurableOutboxMessage(messageId, ackedAtUtcMsc);
        }

        public int AcknowledgeDurableKind(ProfileRuntime runtime, string messageKind, long ackedAtUtcMsc)
        {
            if (runtime == null) throw new ArgumentNullException("runtime");
            return runtime.DataStore.AckDurableOutboxKind(messageKind, ackedAtUtcMsc);
        }

        public void ApplyPersistedAck(ProfileRuntime runtime, BridgeEnvelope envelope)
        {
            if (runtime == null || envelope == null || envelope.MessageType != "data.persisted.ack")
            {
                throw new InvalidDataException("bridge_persisted_ack_invalid");
            }
            runtime.ValidateRoute(envelope.TerminalInstanceId, envelope.BrokerServer, envelope.Login, envelope.ConnectionEpoch);
            HashSet<string> expected = new HashSet<string>(StringComparer.Ordinal)
            {
                "resource", "scope_key", "range_start_utc_msc", "range_end_utc_msc",
                "source_revision", "status", "persisted_at_utc_msc"
            };
            foreach (string key in envelope.Payload.Keys)
            {
                if (!expected.Remove(key))
                {
                    throw new InvalidDataException("bridge_persisted_ack_payload_invalid");
                }
            }
            string status = ReadText(envelope.Payload, "status");
            if (expected.Count != 0 || (status != "persisted" && status != "duplicate"))
            {
                throw new InvalidDataException("bridge_persisted_ack_payload_invalid");
            }
            runtime.DataStore.RecordServerCoverageAck(runtime.ConnectionEpoch, new ServerCoverageAckRecord
            {
                Resource = ReadText(envelope.Payload, "resource"),
                ScopeKey = ReadText(envelope.Payload, "scope_key"),
                RangeStartUtcMsc = ReadLong(envelope.Payload, "range_start_utc_msc"),
                RangeEndUtcMsc = ReadLong(envelope.Payload, "range_end_utc_msc"),
                SourceRevision = ReadText(envelope.Payload, "source_revision"),
                AckedAtUtcMsc = ReadLong(envelope.Payload, "persisted_at_utc_msc")
            });
        }

        private static string ReadText(IDictionary<string, object> payload, string key)
        {
            object value;
            string text;
            if (!payload.TryGetValue(key, out value) || (text = value as string) == null || text.Length == 0)
            {
                throw new InvalidDataException("bridge_persisted_ack_payload_invalid");
            }
            return text;
        }

        private static long ReadLong(IDictionary<string, object> payload, string key)
        {
            object value;
            if (!payload.TryGetValue(key, out value))
            {
                throw new InvalidDataException("bridge_persisted_ack_payload_invalid");
            }
            if (value is int)
            {
                return (int)value;
            }
            if (value is long)
            {
                return (long)value;
            }
            throw new InvalidDataException("bridge_persisted_ack_payload_invalid");
        }

        private static string Limit(string value, int maxLength)
        {
            if (string.IsNullOrEmpty(value))
            {
                return null;
            }
            return value.Length <= maxLength ? value : value.Substring(0, maxLength);
        }

        private static string RefreshRoute(ProfileRuntime runtime, string json, long nowUtcMsc)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 1024 * 1024;
            IDictionary<string, object> root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            if (root == null) throw new InvalidDataException("bridge_outbox_payload_invalid");
            object rawRoute;
            if (!root.TryGetValue("route", out rawRoute) || rawRoute == null) return json;
            ProfileRuntimeConfiguration route = runtime.Configuration;
            root["sent_at_utc_msc"] = nowUtcMsc;
            root["route"] = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "terminal_instance_id", route.TerminalInstanceId },
                { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                    { { "broker_server", route.BrokerServer }, { "login", route.Login } } },
                { "connection_epoch", runtime.ConnectionEpoch }
            };
            return serializer.Serialize(root);
        }
    }
}
