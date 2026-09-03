using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public interface ITerminalCommandSource
    {
        TerminalCommandExecutionResult Execute(ProfileRuntime runtime,
            BridgeCommandRequest request, long nowUtcMsc);
        TerminalCommandExecutionResult Reconcile(ProfileRuntime runtime,
            BridgeCommandReconcile request, CommandLedgerRecord original, long nowUtcMsc);
    }

    public sealed class TerminalCommandExecutionResult
    {
        private TerminalCommandExecutionResult(string status, IDictionary<string, object> result,
            string errorCode, object terminalCode)
        {
            if (status != "succeeded" && status != "rejected" && status != "failed" && status != "uncertain")
                throw new InvalidDataException("bridge_terminal_command_status_invalid");
            Status = status;
            Result = result;
            ErrorCode = errorCode;
            TerminalCode = terminalCode;
        }

        public string Status { get; private set; }
        public IDictionary<string, object> Result { get; private set; }
        public string ErrorCode { get; private set; }
        public object TerminalCode { get; private set; }

        public static TerminalCommandExecutionResult Create(string status,
            IDictionary<string, object> result, string errorCode, object terminalCode)
        {
            return new TerminalCommandExecutionResult(status, result, errorCode, terminalCode);
        }

        public static TerminalCommandExecutionResult Rejected(string code)
        {
            return Create("rejected", null, code, null);
        }

        public static TerminalCommandExecutionResult Failed(string code)
        {
            return Create("failed", null, code, null);
        }

        public static TerminalCommandExecutionResult Uncertain(string code,
            IDictionary<string, object> result)
        {
            return Create("uncertain", result, code, null);
        }
    }

    internal static class TerminalCommandSourceSupport
    {
        public static TerminalRequest BuildTerminalRequest(ProfileRuntime runtime,
            BridgeCommandRequest request, long terminalSessionEpoch)
        {
            if (runtime == null || request == null || terminalSessionEpoch < 1)
                throw new InvalidDataException("bridge_terminal_command_request_invalid");
            ProfileRuntimeConfiguration route = runtime.Configuration;
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = PipeFrameCodec.MaximumPayloadBytes;
            return TerminalRequest.Parse(serializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "v", 1 }, { "type", "command_request" }, { "request_id", request.CommandId },
                { "terminal_instance_id", route.TerminalInstanceId },
                { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                    { { "broker_server", route.BrokerServer }, { "login", route.Login } } },
                { "session_epoch", terminalSessionEpoch }, { "issued_at_utc_msc", request.IssuedAtUtcMsc },
                { "deadline_utc_msc", request.DeadlineUtcMsc }, { "action", request.Action },
                { "command_id", request.CommandId }, { "idempotency_key", request.IdempotencyKey },
                { "params", request.Parameters }, { "expected_state", request.ExpectedState }
            }));
        }

        public static TerminalCommandExecutionResult FromMt4(TerminalCommandResult terminal)
        {
            if (terminal == null) return TerminalCommandExecutionResult.Failed("bridge_terminal_result_missing");
            string status;
            switch (terminal.Status)
            {
                case TerminalCommandStatusCode.Succeeded: status = "succeeded"; break;
                case TerminalCommandStatusCode.Rejected: status = "rejected"; break;
                case TerminalCommandStatusCode.Failed: status = "failed"; break;
                default: status = "uncertain"; break;
            }
            Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "ticket", terminal.Ticket.ToString(CultureInfo.InvariantCulture) },
                { "resource_state", terminal.ResourceState.ToString().ToLowerInvariant() },
                { "observed_at_utc_msc", terminal.ObservedAtUtcMsc }, { "symbol", terminal.ActualSymbol },
                { "direction", terminal.ActualDirection.ToString().ToLowerInvariant() },
                { "order_type", OrderTypeText(terminal.ActualOrderType) },
                { "magic", terminal.ActualMagic }, { "volume", EmptyToNull(terminal.ActualVolume) },
                { "price", EmptyToNull(terminal.ActualPrice) },
                { "stop_loss", terminal.ActualStopLossSpecified ? terminal.ActualStopLoss : null },
                { "take_profit", terminal.ActualTakeProfitSpecified ? terminal.ActualTakeProfit : null },
                { "expiration_utc_msc", terminal.ActualExpirationSpecified ? (object)terminal.ActualExpirationUtcMsc : null },
                { "open_time_utc_msc", terminal.ActualOpenTimeUtcMsc }, { "comment", terminal.ActualComment },
                { "already_absent", (terminal.Flags & TerminalCommandResultFlags.AlreadyAbsent) != 0 },
                { "already_applied", (terminal.Flags & TerminalCommandResultFlags.AlreadyApplied) != 0 }
            };
            return TerminalCommandExecutionResult.Create(status, result,
                string.IsNullOrEmpty(terminal.ErrorCode) ? null : terminal.ErrorCode,
                terminal.TerminalCode);
        }

        public static TerminalCommandExecutionResult FromMt5(Mt5WorkerResponse response)
        {
            if (response == null) return TerminalCommandExecutionResult.Failed("bridge_mt5_result_missing");
            if (response.IsError)
                return TerminalCommandExecutionResult.Failed(
                    ReadOptionalText(response.Payload, "error_code") ?? "bridge_mt5_worker_error");
            if (response.Outcome != "command_result")
                return TerminalCommandExecutionResult.Uncertain("bridge_mt5_result_outcome_invalid", null);
            IDictionary<string, object> result = ReadObject(response.Payload, "result");
            string status = ReadText(result, "status");
            string errorCode = ReadOptionalText(result, "error_code");
            object terminalCode = null;
            object evidenceRaw;
            IDictionary<string, object> evidence;
            if (result.TryGetValue("evidence", out evidenceRaw)
                && (evidence = evidenceRaw as IDictionary<string, object>) != null)
                evidence.TryGetValue("broker_retcode", out terminalCode);
            Dictionary<string, object> publicResult = new Dictionary<string, object>(StringComparer.Ordinal);
            object value;
            if (result.TryGetValue("raw_result", out value)) publicResult["raw_result"] = value;
            if (result.TryGetValue("evidence", out value)) publicResult["evidence"] = value;
            return TerminalCommandExecutionResult.Create(status, publicResult, errorCode, terminalCode);
        }

        public static string ReadText(IDictionary<string, object> values, string key)
        {
            object value;
            string text;
            if (values == null || !values.TryGetValue(key, out value)
                || (text = value as string) == null || text.Length == 0)
                throw new InvalidDataException("bridge_terminal_command_result_invalid");
            return text;
        }

        public static string ReadOptionalText(IDictionary<string, object> values, string key)
        {
            object value;
            if (values == null || !values.TryGetValue(key, out value) || value == null) return null;
            string text = value as string;
            return string.IsNullOrEmpty(text) ? null : text;
        }

        public static IDictionary<string, object> ReadObject(IDictionary<string, object> values, string key)
        {
            object value;
            IDictionary<string, object> result;
            if (values == null || !values.TryGetValue(key, out value)
                || (result = value as IDictionary<string, object>) == null)
                throw new InvalidDataException("bridge_terminal_command_result_invalid");
            return result;
        }

        private static object EmptyToNull(string value)
        {
            return string.IsNullOrEmpty(value) ? null : (object)value;
        }

        private static string OrderTypeText(TerminalCommandOrderTypeCode value)
        {
            switch (value)
            {
                case TerminalCommandOrderTypeCode.Market: return "market";
                case TerminalCommandOrderTypeCode.BuyLimit: return "buy_limit";
                case TerminalCommandOrderTypeCode.BuyStop: return "buy_stop";
                case TerminalCommandOrderTypeCode.SellLimit: return "sell_limit";
                case TerminalCommandOrderTypeCode.SellStop: return "sell_stop";
                default: return null;
            }
        }
    }
}
