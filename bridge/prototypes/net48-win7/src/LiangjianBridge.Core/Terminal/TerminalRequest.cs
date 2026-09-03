using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class TerminalRequest
    {
        private static readonly HashSet<string> KnownFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "v", "type", "request_id", "terminal_instance_id", "account_ref", "session_epoch",
            "deadline_utc_msc", "issued_at_utc_msc", "resource", "action", "command_id",
            "idempotency_key", "params", "expected_state"
        };

        private TerminalRequest()
        {
        }

        public string Type { get; private set; }
        public string RequestId { get; private set; }
        public string TerminalInstanceId { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public long SessionEpoch { get; private set; }
        public long IssuedAtUtcMsc { get; private set; }
        public long DeadlineUtcMsc { get; private set; }
        public string Resource { get; private set; }
        public string Action { get; private set; }
        public string CommandId { get; private set; }
        public string IdempotencyKey { get; private set; }
        public IDictionary<string, object> Parameters { get; private set; }
        public IDictionary<string, object> ExpectedState { get; private set; }

        public static TerminalRequest Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > PipeFrameCodec.MaximumPayloadBytes)
            {
                throw new InvalidDataException("bridge_terminal_request_size_invalid");
            }
            IDictionary<string, object> root;
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = PipeFrameCodec.MaximumPayloadBytes;
                root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (Exception error)
            {
                if (error is ArgumentException || error is InvalidOperationException)
                {
                    throw new InvalidDataException("bridge_terminal_json_invalid");
                }
                throw;
            }
            if (root == null)
            {
                throw new InvalidDataException("bridge_terminal_request_invalid");
            }
            foreach (string field in root.Keys)
            {
                if (!KnownFields.Contains(field))
                {
                    throw new InvalidDataException("bridge_terminal_unknown_field");
                }
            }
            if (ReadLong(root, "v") != 1)
            {
                throw new InvalidDataException("bridge_terminal_protocol_unsupported");
            }

            TerminalRequest request = new TerminalRequest();
            request.Type = ReadText(root, "type", 32);
            request.RequestId = ReadText(root, "request_id", 191);
            request.TerminalInstanceId = ReadText(root, "terminal_instance_id", 191);
            request.SessionEpoch = ReadLong(root, "session_epoch");
            request.IssuedAtUtcMsc = ReadOptionalLong(root, "issued_at_utc_msc", 0);
            request.DeadlineUtcMsc = ReadLong(root, "deadline_utc_msc");
            if (request.SessionEpoch < 1 || request.DeadlineUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_terminal_route_invalid");
            }
            ReadAccount(root, request);
            request.Parameters = ReadObject(root, "params");
            request.ExpectedState = ReadOptionalObject(root, "expected_state");

            if (request.Type == "query_request")
            {
                request.Resource = ReadText(root, "resource", 64);
                if (!ProtocolCatalog.IsQueryResource(request.Resource)
                    || root.ContainsKey("action") || root.ContainsKey("command_id")
                    || root.ContainsKey("idempotency_key") || root.ContainsKey("issued_at_utc_msc")
                    || root.ContainsKey("expected_state"))
                {
                    throw new InvalidDataException("bridge_terminal_query_invalid");
                }
            }
            else if (request.Type == "command_request")
            {
                request.Action = ReadText(root, "action", 64);
                request.CommandId = ReadText(root, "command_id", 191);
                request.IdempotencyKey = ReadText(root, "idempotency_key", 191);
                if (request.IssuedAtUtcMsc < 1 || request.IssuedAtUtcMsc > request.DeadlineUtcMsc)
                {
                    throw new InvalidDataException("bridge_terminal_command_time_invalid");
                }
                if (!root.ContainsKey("expected_state"))
                {
                    throw new InvalidDataException("bridge_terminal_expected_state_missing");
                }
                if (!ProtocolCatalog.IsCommandAction(request.Action)
                    || request.IdempotencyKey.Length < 16 || root.ContainsKey("resource"))
                {
                    throw new InvalidDataException("bridge_terminal_command_invalid");
                }
            }
            else
            {
                throw new InvalidDataException("bridge_terminal_type_unsupported");
            }
            return request;
        }

        private static void ReadAccount(IDictionary<string, object> root, TerminalRequest request)
        {
            IDictionary<string, object> account = ReadObject(root, "account_ref");
            if (account.Count != 2)
            {
                throw new InvalidDataException("bridge_terminal_account_ref_invalid");
            }
            foreach (string field in account.Keys)
            {
                if (field != "broker_server" && field != "login")
                {
                    throw new InvalidDataException("bridge_terminal_account_ref_unknown_field");
                }
            }
            request.BrokerServer = ReadText(account, "broker_server", 128);
            request.Login = ReadText(account, "login", 64);
        }

        private static IDictionary<string, object> ReadObject(IDictionary<string, object> root, string field)
        {
            object value;
            IDictionary<string, object> result;
            if (!root.TryGetValue(field, out value) || (result = value as IDictionary<string, object>) == null)
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            return result;
        }

        private static IDictionary<string, object> ReadOptionalObject(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value) || value == null)
            {
                return null;
            }
            IDictionary<string, object> result = value as IDictionary<string, object>;
            if (result == null)
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            return result;
        }

        private static long ReadLong(IDictionary<string, object> root, string field)
        {
            object value;
            if (!root.TryGetValue(field, out value))
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            if (value is int)
            {
                return (int)value;
            }
            if (value is long)
            {
                return (long)value;
            }
            throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
        }

        private static long ReadOptionalLong(IDictionary<string, object> root, string field, long fallback)
        {
            object value;
            if (!root.TryGetValue(field, out value) || value == null)
            {
                return fallback;
            }
            if (value is int)
            {
                return (int)value;
            }
            if (value is long)
            {
                return (long)value;
            }
            throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
        }

        private static string ReadText(IDictionary<string, object> root, string field, int maxLength)
        {
            object value;
            string result;
            if (!root.TryGetValue(field, out value)
                || (result = value as string) == null
                || result.Length == 0
                || result.Length > maxLength
                || result.IndexOf('\r') >= 0
                || result.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            return result;
        }
    }
}
