using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Protocol
{
    public sealed class BridgeCommandRequest
    {
        private BridgeCommandRequest() { }

        public string CommandId { get; private set; }
        public string IdempotencyKey { get; private set; }
        public string Action { get; private set; }
        public long IssuedAtUtcMsc { get; private set; }
        public long DeadlineUtcMsc { get; private set; }
        public IDictionary<string, object> Parameters { get; private set; }
        public IDictionary<string, object> ExpectedState { get; private set; }
        public string RequestHash { get; private set; }

        public static BridgeCommandRequest Parse(BridgeEnvelope envelope)
        {
            if (envelope == null || envelope.MessageType != "command.request")
            {
                throw new InvalidDataException("bridge_command_request_invalid");
            }
            RequireOnly(envelope.Payload, "command_id", "idempotency_key", "action",
                "issued_at_utc_msc", "deadline_utc_msc", "params", "expected_state");

            BridgeCommandRequest request = new BridgeCommandRequest();
            request.CommandId = ReadText(envelope.Payload, "command_id", 191);
            request.IdempotencyKey = ReadText(envelope.Payload, "idempotency_key", 191);
            request.Action = ReadText(envelope.Payload, "action", 64);
            request.IssuedAtUtcMsc = ReadLong(envelope.Payload, "issued_at_utc_msc");
            request.DeadlineUtcMsc = ReadLong(envelope.Payload, "deadline_utc_msc");
            request.Parameters = ReadObject(envelope.Payload, "params", 64, false);
            request.ExpectedState = ReadObject(envelope.Payload, "expected_state", 32, true);

            if (request.IdempotencyKey.Length < 16 || !ProtocolCatalog.IsCommandAction(request.Action)
                || request.IssuedAtUtcMsc < 1 || request.DeadlineUtcMsc < request.IssuedAtUtcMsc)
            {
                throw new InvalidDataException("bridge_command_request_invalid");
            }
            bool requiresExpected = request.Action != "order.place" && request.Action != "execution.lookup";
            if (requiresExpected == (request.ExpectedState == null))
            {
                throw new InvalidDataException("bridge_command_expected_state_invalid");
            }
            request.RequestHash = CanonicalHash(envelope.Payload);
            return request;
        }

        private static string CanonicalHash(IDictionary<string, object> payload)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 1024 * 1024;
            string canonical = serializer.Serialize(Canonicalize(payload));
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(Encoding.UTF8.GetBytes(canonical));
                StringBuilder output = new StringBuilder(71);
                output.Append("sha256:");
                for (int index = 0; index < digest.Length; index++)
                {
                    output.Append(digest[index].ToString("x2", CultureInfo.InvariantCulture));
                }
                return output.ToString();
            }
        }

        private static object Canonicalize(object value)
        {
            IDictionary<string, object> objectValue = value as IDictionary<string, object>;
            if (objectValue != null)
            {
                SortedDictionary<string, object> sorted = new SortedDictionary<string, object>(StringComparer.Ordinal);
                foreach (KeyValuePair<string, object> item in objectValue)
                {
                    sorted.Add(item.Key, Canonicalize(item.Value));
                }
                return sorted;
            }
            object[] array = value as object[];
            if (array != null)
            {
                object[] result = new object[array.Length];
                for (int index = 0; index < array.Length; index++) result[index] = Canonicalize(array[index]);
                return result;
            }
            ArrayList list = value as ArrayList;
            if (list != null)
            {
                object[] result = new object[list.Count];
                for (int index = 0; index < list.Count; index++) result[index] = Canonicalize(list[index]);
                return result;
            }
            return value;
        }

        internal static void RequireOnly(IDictionary<string, object> values, params string[] fields)
        {
            if (values == null || values.Count != fields.Length)
            {
                throw new InvalidDataException("bridge_command_payload_invalid");
            }
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string key in values.Keys)
            {
                if (!expected.Remove(key)) throw new InvalidDataException("bridge_command_payload_invalid");
            }
        }

        internal static string ReadText(IDictionary<string, object> values, string key, int maximum)
        {
            object raw;
            string text;
            if (!values.TryGetValue(key, out raw) || (text = raw as string) == null
                || text.Length == 0 || text.Length > maximum
                || text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_command_payload_invalid");
            }
            return text;
        }

        internal static long ReadLong(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)) throw new InvalidDataException("bridge_command_payload_invalid");
            if (raw is int) return (int)raw;
            if (raw is long) return (long)raw;
            throw new InvalidDataException("bridge_command_payload_invalid");
        }

        private static IDictionary<string, object> ReadObject(IDictionary<string, object> values,
            string key, int maximumProperties, bool allowNull)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)) throw new InvalidDataException("bridge_command_payload_invalid");
            if (raw == null && allowNull) return null;
            IDictionary<string, object> result = raw as IDictionary<string, object>;
            if (result == null || result.Count > maximumProperties)
            {
                throw new InvalidDataException("bridge_command_payload_invalid");
            }
            return result;
        }
    }

    public sealed class BridgeCommandResultAck
    {
        private BridgeCommandResultAck() { }
        public string CommandId { get; private set; }
        public string Status { get; private set; }

        public static BridgeCommandResultAck Parse(BridgeEnvelope envelope)
        {
            if (envelope == null || envelope.MessageType != "command.result_ack")
                throw new InvalidDataException("bridge_command_result_ack_invalid");
            BridgeCommandRequest.RequireOnly(envelope.Payload, "command_id", "status");
            BridgeCommandResultAck ack = new BridgeCommandResultAck
            {
                CommandId = BridgeCommandRequest.ReadText(envelope.Payload, "command_id", 191),
                Status = BridgeCommandRequest.ReadText(envelope.Payload, "status", 16)
            };
            if (ack.Status != "persisted" && ack.Status != "duplicate")
                throw new InvalidDataException("bridge_command_result_ack_invalid");
            return ack;
        }
    }

    public sealed class BridgeCommandReconcile
    {
        private BridgeCommandReconcile() { }
        public string CommandId { get; private set; }
        public string Action { get; private set; }
        public string TerminalTicket { get; private set; }

        public static BridgeCommandReconcile Parse(BridgeEnvelope envelope)
        {
            if (envelope == null || envelope.MessageType != "command.reconcile")
                throw new InvalidDataException("bridge_command_reconcile_invalid");
            if (envelope.Payload.Count != 2 && envelope.Payload.Count != 3)
                throw new InvalidDataException("bridge_command_reconcile_invalid");
            foreach (string key in envelope.Payload.Keys)
            {
                if (key != "command_id" && key != "action" && key != "terminal_ticket")
                    throw new InvalidDataException("bridge_command_reconcile_invalid");
            }
            BridgeCommandReconcile request = new BridgeCommandReconcile
            {
                CommandId = BridgeCommandRequest.ReadText(envelope.Payload, "command_id", 191),
                Action = BridgeCommandRequest.ReadText(envelope.Payload, "action", 64)
            };
            object ticket;
            if (envelope.Payload.TryGetValue("terminal_ticket", out ticket) && ticket != null)
            {
                request.TerminalTicket = ticket as string;
                if (string.IsNullOrEmpty(request.TerminalTicket) || request.TerminalTicket.Length > 64)
                    throw new InvalidDataException("bridge_command_reconcile_invalid");
                for (int index = 0; index < request.TerminalTicket.Length; index++)
                    if (request.TerminalTicket[index] < '0' || request.TerminalTicket[index] > '9')
                        throw new InvalidDataException("bridge_command_reconcile_invalid");
            }
            if (!ProtocolCatalog.IsCommandAction(request.Action))
                throw new InvalidDataException("bridge_command_reconcile_invalid");
            return request;
        }
    }
}
