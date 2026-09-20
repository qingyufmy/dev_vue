using System;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Protocol;
using Liangjian.BridgeV4.Storage;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class Mt5TerminalCommandSource : ITerminalCommandSource
    {
        private readonly IMt5WorkerRequestHost host;
        private readonly Func<ProfileRuntimeConfiguration, long> epochResolver;

        public Mt5TerminalCommandSource(Mt5WorkerHost value)
            : this(value, delegate(ProfileRuntimeConfiguration route)
            {
                foreach (Mt5WorkerSessionSnapshot session in value.Snapshot())
                    if (session.TerminalInstanceId == route.TerminalInstanceId
                        && session.BrokerServer == route.BrokerServer && session.Login == route.Login
                        && session.Role == "live" && session.Connected) return session.ConnectionEpoch;
                throw new InvalidOperationException("bridge_mt5_worker_session_not_found");
            })
        {
        }

        public Mt5TerminalCommandSource(IMt5WorkerRequestHost value,
            Func<ProfileRuntimeConfiguration, long> connectionEpochResolver)
        {
            if (value == null) throw new ArgumentNullException("value");
            if (connectionEpochResolver == null) throw new ArgumentNullException("connectionEpochResolver");
            host = value;
            epochResolver = connectionEpochResolver;
        }

        public TerminalCommandExecutionResult Execute(ProfileRuntime runtime,
            BridgeCommandRequest request, long nowUtcMsc)
        {
            IDictionary<string, object> command;
            string operation;
            try
            {
                long workerEpoch = epochResolver(runtime.Configuration);
                ValidateRequest(request);
                bool lookup = request.Action == "execution.lookup";
                operation = lookup ? "query_execution" : "execute_command";
                command = BuildCommand(runtime.Configuration, request, workerEpoch, lookup);
            }
            catch (InvalidDataException error)
            {
                return TerminalCommandExecutionResult.Rejected(SafeCode(error.Message, "bridge_mt5_command_invalid"));
            }
            catch (InvalidOperationException error)
            {
                return TerminalCommandExecutionResult.Failed(SafeCode(error.Message, "bridge_mt5_terminal_unavailable"));
            }
            try
            {
                return TerminalCommandSourceSupport.FromMt5(host.Request(
                    runtime.Configuration.TerminalInstanceId, runtime.Configuration.BrokerServer,
                    runtime.Configuration.Login, "live", operation, command));
            }
            catch (Exception error)
            {
                return TerminalCommandExecutionResult.Uncertain(
                    SafeCode(error.Message, "bridge_mt5_execution_interrupted"), null);
            }
        }

        public TerminalCommandExecutionResult Reconcile(ProfileRuntime runtime,
            BridgeCommandReconcile request, CommandLedgerRecord original, long nowUtcMsc)
        {
            IDictionary<string, object> reconcile = ReadReconcileContext(original.ResultJson);
            if (reconcile == null) return TerminalCommandExecutionResult.Uncertain(
                "bridge_reconcile_context_missing", null);
            long workerEpoch;
            try { workerEpoch = epochResolver(runtime.Configuration); }
            catch (Exception error) { return TerminalCommandExecutionResult.Uncertain(
                SafeCode(error.Message, "bridge_mt5_terminal_unavailable"), null); }
            IDictionary<string, object> parameters;
            try { parameters = ReconcileParameters(reconcile, request.TerminalTicket); }
            catch (InvalidDataException error) { return TerminalCommandExecutionResult.Uncertain(
                SafeCode(error.Message, "bridge_reconcile_context_invalid"), null); }
            IDictionary<string, object> command = CommandEnvelope(runtime.Configuration, workerEpoch,
                original.CommandId, original.AcceptedAtUtcMsc, checked(nowUtcMsc + 30000L),
                "query_execution", parameters);
            try
            {
                TerminalCommandExecutionResult observed = TerminalCommandSourceSupport.FromMt5(host.Request(
                    runtime.Configuration.TerminalInstanceId, runtime.Configuration.BrokerServer,
                    runtime.Configuration.Login, "live", "query_execution", command));
                return ResolveReconciliation(observed);
            }
            catch (Exception error)
            {
                return TerminalCommandExecutionResult.Uncertain(
                    SafeCode(error.Message, "bridge_mt5_reconciliation_interrupted"), null);
            }
        }

        private static IDictionary<string, object> BuildCommand(ProfileRuntimeConfiguration route,
            BridgeCommandRequest request, long workerEpoch, bool lookup)
        {
            IDictionary<string, object> parameters = lookup
                ? LookupParameters(request.Parameters) : MutationParameters(request);
            return CommandEnvelope(route, workerEpoch, request.CommandId, request.IssuedAtUtcMsc,
                request.DeadlineUtcMsc, lookup ? "query_execution" : Action(request.Action), parameters);
        }

        private static IDictionary<string, object> CommandEnvelope(ProfileRuntimeConfiguration route,
            long workerEpoch, string commandId, long issuedAtUtcMsc, long deadlineUtcMsc,
            string action, IDictionary<string, object> parameters)
        {
            return new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "v", 3 }, { "type", "command" }, { "message_id", "bridge-" + commandId },
                { "sent_at_utc_msc", issuedAtUtcMsc }, { "command_id", commandId },
                { "terminal_instance_id", route.TerminalInstanceId },
                { "account_ref", new Dictionary<string, object>(StringComparer.Ordinal)
                    { { "broker_server", route.BrokerServer }, { "login", route.Login } } },
                { "connection_epoch", workerEpoch }, { "issued_at_utc_msc", issuedAtUtcMsc },
                { "deadline_utc_msc", deadlineUtcMsc }, { "action", action }, { "params", parameters }
            };
        }

        private static IDictionary<string, object> MutationParameters(BridgeCommandRequest request)
        {
            return MutationParameters(request.Parameters, request.ExpectedState);
        }

        private static IDictionary<string, object> MutationParameters(IDictionary<string, object> input,
            IDictionary<string, object> expectedState)
        {
            Dictionary<string, object> output = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object> item in input) output[item.Key] = item.Value;
            object direction;
            if (output.TryGetValue("direction", out direction))
            {
                output.Remove("direction"); output["side"] = direction;
            }
            object orderType;
            if (output.TryGetValue("order_type", out orderType))
            {
                output.Remove("order_type");
                string value = (string)orderType;
                output["order_kind"] = value == "market" ? "market" :
                    value.EndsWith("_stop_limit", StringComparison.Ordinal) ? "stop_limit" :
                    value.EndsWith("_limit", StringComparison.Ordinal) ? "limit" : "stop";
            }
            MoveExpiration(output);
            if (expectedState != null) output["expected_state"] = expectedState;
            return output;
        }

        private static IDictionary<string, object> ReconcileParameters(
            IDictionary<string, object> context, string terminalTicket)
        {
            string bridgeAction = TerminalCommandSourceSupport.ReadText(context, "bridge_action");
            IDictionary<string, object> publicParams = TerminalCommandSourceSupport.ReadObject(context, "params");
            object expectedRaw;
            IDictionary<string, object> expected = context.TryGetValue("expected_state", out expectedRaw)
                ? expectedRaw as IDictionary<string, object> : null;
            IDictionary<string, object> original = MutationParameters(publicParams, expected);
            string originalAction = Action(bridgeAction);
            string expectedKind = bridgeAction.StartsWith("pending_order.", StringComparison.Ordinal)
                ? "pending" : "trade";
            object orderType;
            if (bridgeAction == "order.place" && publicParams.TryGetValue("order_type", out orderType)
                && !string.Equals(orderType as string, "market", StringComparison.Ordinal)) expectedKind = "pending";
            Dictionary<string, object> output = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "expected_kind", expectedKind }, { "lookback_seconds", 172800 },
                { "original_action", originalAction }, { "original_params", original },
                { "original_command_id", TerminalCommandSourceSupport.ReadText(context, "original_command_id") },
                { "original_issued_at_utc_msc", ReadLong(context, "original_issued_at_utc_msc") },
                { "settle_after_msc", 15000 }
            };
            object value;
            if (publicParams.TryGetValue("symbol", out value)) output["symbol"] = value;
            else if (expected != null && expected.TryGetValue("symbol", out value)) output["symbol"] = value;
            if (publicParams.TryGetValue("magic", out value)) output["magic"] = value;
            else if (expected != null && expected.TryGetValue("magic", out value)) output["magic"] = value;
            if (string.IsNullOrEmpty(terminalTicket) && publicParams.TryGetValue("ticket", out value))
                terminalTicket = value as string;
            if (!string.IsNullOrEmpty(terminalTicket))
                output[expectedKind == "pending" ? "pending_ticket" : "trade_ticket"] = terminalTicket;
            else
                output["bridge_command_ref"] = "AURUM:" + Last20((string)output["original_command_id"]);
            return output;
        }

        private static IDictionary<string, object> LookupParameters(IDictionary<string, object> input)
        {
            Dictionary<string, object> output = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "expected_kind", "trade" }, { "lookback_seconds", 172800 }
            };
            object value;
            if (input.TryGetValue("ticket", out value)) output["trade_ticket"] = value;
            if (input.TryGetValue("symbol", out value)) output["symbol"] = value;
            if (input.TryGetValue("magic", out value)) output["magic"] = value;
            if (input.TryGetValue("idempotency_key", out value)) output["bridge_command_ref"] = value;
            return output;
        }

        private static void MoveExpiration(IDictionary<string, object> values)
        {
            object value;
            if (values.TryGetValue("expiration_utc_msc", out value))
            {
                values.Remove("expiration_utc_msc");
                long milliseconds = value is int ? (int)value : (long)value;
                values["expiration"] = milliseconds / 1000L;
            }
        }

        private static string Action(string action)
        {
            switch (action)
            {
                case "order.place": return "place_order";
                case "position.protection.set": return "modify_position";
                case "position.close": return "close_position";
                case "pending_order.modify": return "modify_order";
                case "pending_order.cancel": return "cancel_order";
                default: throw new InvalidDataException("bridge_mt5_command_action_invalid");
            }
        }

        private static void ValidateRequest(BridgeCommandRequest request)
        {
            IDictionary<string, object> values = request.Parameters;
            switch (request.Action)
            {
                case "order.place":
                    RequireOnly(values, "symbol", "direction", "order_type", "volume", "price",
                        "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc", "magic", "deviation");
                    Require(values, "symbol", "direction", "order_type", "volume", "magic", "deviation");
                    string direction = Text(values, "direction");
                    string orderType = Text(values, "order_type");
                    Text(values, "symbol", 64);
                    PositiveDecimal(values, "volume");
                    OptionalPositiveDecimal(values, "price");
                    OptionalPositiveDecimal(values, "stop_limit_price");
                    OptionalPositiveDecimal(values, "stop_loss");
                    OptionalPositiveDecimal(values, "take_profit");
                    Integer(values, "magic", 0, int.MaxValue);
                    Integer(values, "deviation", 0, 100000);
                    OptionalUtcMsc(values, "expiration_utc_msc");
                    if (!IsOrderTypeForDirection(direction, orderType))
                        throw new InvalidDataException("bridge_mt5_order_direction_invalid");
                    bool market = orderType == "market";
                    bool stopLimit = orderType == "buy_stop_limit" || orderType == "sell_stop_limit";
                    if (market && (values.ContainsKey("price") || values.ContainsKey("stop_limit_price")
                        || values.ContainsKey("expiration_utc_msc")))
                        throw new InvalidDataException("bridge_mt5_market_params_invalid");
                    if (!market && !values.ContainsKey("price"))
                        throw new InvalidDataException("bridge_mt5_pending_price_required");
                    if (stopLimit != values.ContainsKey("stop_limit_price"))
                        throw new InvalidDataException("bridge_mt5_stop_limit_params_invalid");
                    break;
                case "position.protection.set":
                    RequireOnly(values, "ticket", "stop_loss", "remove_stop_loss", "take_profit", "remove_take_profit");
                    Require(values, "ticket");
                    RequireAny(values, "stop_loss", "remove_stop_loss", "take_profit", "remove_take_profit");
                    RejectPair(values, "stop_loss", "remove_stop_loss");
                    RejectPair(values, "take_profit", "remove_take_profit");
                    Ticket(values, "ticket");
                    OptionalPositiveDecimal(values, "stop_loss");
                    OptionalPositiveDecimal(values, "take_profit");
                    OptionalTrue(values, "remove_stop_loss");
                    OptionalTrue(values, "remove_take_profit");
                    break;
                case "position.close":
                    RequireOnly(values, "ticket", "volume", "deviation");
                    Require(values, "ticket", "deviation");
                    Ticket(values, "ticket");
                    OptionalPositiveDecimal(values, "volume");
                    Integer(values, "deviation", 0, 100000);
                    break;
                case "pending_order.modify":
                    RequireOnly(values, "ticket", "price", "stop_limit_price", "stop_loss", "remove_stop_loss",
                        "take_profit", "remove_take_profit", "expiration_utc_msc", "remove_expiration");
                    Require(values, "ticket");
                    RequireAny(values, "price", "stop_limit_price", "stop_loss", "remove_stop_loss",
                        "take_profit", "remove_take_profit", "expiration_utc_msc", "remove_expiration");
                    RejectPair(values, "stop_loss", "remove_stop_loss");
                    RejectPair(values, "take_profit", "remove_take_profit");
                    RejectPair(values, "expiration_utc_msc", "remove_expiration");
                    Ticket(values, "ticket");
                    OptionalPositiveDecimal(values, "price");
                    OptionalPositiveDecimal(values, "stop_limit_price");
                    OptionalPositiveDecimal(values, "stop_loss");
                    OptionalPositiveDecimal(values, "take_profit");
                    OptionalUtcMsc(values, "expiration_utc_msc");
                    OptionalTrue(values, "remove_stop_loss");
                    OptionalTrue(values, "remove_take_profit");
                    OptionalTrue(values, "remove_expiration");
                    break;
                case "pending_order.cancel":
                    RequireOnly(values, "ticket"); Require(values, "ticket");
                    Ticket(values, "ticket"); break;
                case "execution.lookup":
                    RequireOnly(values, "ticket", "idempotency_key", "symbol", "magic");
                    bool byTicket = values.ContainsKey("ticket");
                    bool byKey = values.ContainsKey("idempotency_key") && values.ContainsKey("symbol") && values.ContainsKey("magic");
                    if (byTicket == byKey) throw new InvalidDataException("bridge_mt5_lookup_selector_invalid");
                    if (byTicket) Ticket(values, "ticket");
                    else
                    {
                        Text(values, "idempotency_key", 191, 16);
                        Text(values, "symbol", 64);
                        Integer(values, "magic", 0, int.MaxValue);
                    }
                    break;
                default: throw new InvalidDataException("bridge_mt5_command_action_invalid");
            }
            ValidateExpected(request);
        }

        private static void ValidateExpected(BridgeCommandRequest request)
        {
            if (request.ExpectedState == null) return;
            RequireOnly(request.ExpectedState, "ticket", "symbol", "direction", "order_type", "magic", "volume",
                "open_price", "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc");
            Require(request.ExpectedState, "ticket", "symbol", "direction", "order_type", "magic", "volume",
                "open_price");
            foreach (string field in new[] { "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc" })
                if (!request.ExpectedState.ContainsKey(field))
                    throw new InvalidDataException("bridge_mt5_command_field_required");
            Ticket(request.ExpectedState, "ticket");
            Text(request.ExpectedState, "symbol", 64);
            string direction = Text(request.ExpectedState, "direction");
            string orderType = Text(request.ExpectedState, "order_type");
            if (!IsOrderTypeForDirection(direction, orderType))
                throw new InvalidDataException("bridge_mt5_expected_state_invalid");
            Integer(request.ExpectedState, "magic", 0, int.MaxValue);
            PositiveDecimal(request.ExpectedState, "volume");
            PositiveDecimal(request.ExpectedState, "open_price");
            NullablePositiveDecimal(request.ExpectedState, "stop_limit_price");
            NullablePositiveDecimal(request.ExpectedState, "stop_loss");
            NullablePositiveDecimal(request.ExpectedState, "take_profit");
            NullableUtcMsc(request.ExpectedState, "expiration_utc_msc");
        }

        private static void RequireOnly(IDictionary<string, object> values, params string[] allowed)
        {
            HashSet<string> set = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in values.Keys)
                if (!set.Contains(key)) throw new InvalidDataException("bridge_mt5_command_unknown_field");
        }

        private static void Require(IDictionary<string, object> values, params string[] required)
        {
            for (int index = 0; index < required.Length; index++)
                if (!values.ContainsKey(required[index]) || values[required[index]] == null)
                    throw new InvalidDataException("bridge_mt5_command_field_required");
        }

        private static void RequireAny(IDictionary<string, object> values, params string[] fields)
        {
            for (int index = 0; index < fields.Length; index++) if (values.ContainsKey(fields[index])) return;
            throw new InvalidDataException("bridge_mt5_command_change_required");
        }

        private static void RejectPair(IDictionary<string, object> values, string first, string second)
        {
            if (values.ContainsKey(first) && values.ContainsKey(second))
                throw new InvalidDataException("bridge_mt5_command_field_conflict");
        }

        private static string Text(IDictionary<string, object> values, string key)
        {
            return Text(values, key, 64, 1);
        }

        private static string Text(IDictionary<string, object> values, string key, int maximum)
        {
            return Text(values, key, maximum, 1);
        }

        private static string Text(IDictionary<string, object> values, string key, int maximum, int minimum)
        {
            object value;
            string text;
            if (!values.TryGetValue(key, out value) || (text = value as string) == null
                || text.Length < minimum || text.Length > maximum
                || text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0)
                throw new InvalidDataException("bridge_mt5_command_text_invalid");
            return text;
        }

        private static void Ticket(IDictionary<string, object> values, string key)
        {
            string value = Text(values, key, 20);
            if (value[0] == '0') throw new InvalidDataException("bridge_mt5_command_ticket_invalid");
            for (int index = 0; index < value.Length; index++)
                if (value[index] < '0' || value[index] > '9')
                    throw new InvalidDataException("bridge_mt5_command_ticket_invalid");
        }

        private static void PositiveDecimal(IDictionary<string, object> values, string key)
        {
            string value = Text(values, key, 128);
            decimal number;
            if (!decimal.TryParse(value, NumberStyles.AllowDecimalPoint,
                    CultureInfo.InvariantCulture, out number) || number <= 0
                || !IsDecimalText(value))
                throw new InvalidDataException("bridge_mt5_command_decimal_invalid");
        }

        private static void OptionalPositiveDecimal(IDictionary<string, object> values, string key)
        {
            if (values.ContainsKey(key)) PositiveDecimal(values, key);
        }

        private static void NullablePositiveDecimal(IDictionary<string, object> values, string key)
        {
            if (values[key] != null) PositiveDecimal(values, key);
        }

        private static void Integer(IDictionary<string, object> values, string key, int minimum, int maximum)
        {
            object raw = values[key];
            if (!(raw is int) || (int)raw < minimum || (int)raw > maximum)
                throw new InvalidDataException("bridge_mt5_command_integer_invalid");
        }

        private static void OptionalUtcMsc(IDictionary<string, object> values, string key)
        {
            if (values.ContainsKey(key)) UtcMsc(values, key);
        }

        private static void NullableUtcMsc(IDictionary<string, object> values, string key)
        {
            if (values[key] != null) UtcMsc(values, key);
        }

        private static void UtcMsc(IDictionary<string, object> values, string key)
        {
            object raw = values[key];
            long value = raw is int ? (int)raw : raw is long ? (long)raw : 0;
            if (value < 1 || value > 9007199254740991L)
                throw new InvalidDataException("bridge_mt5_command_time_invalid");
        }

        private static void OptionalTrue(IDictionary<string, object> values, string key)
        {
            object value;
            if (values.TryGetValue(key, out value) && (!(value is bool) || !(bool)value))
                throw new InvalidDataException("bridge_mt5_command_flag_invalid");
        }

        private static bool IsOrderType(string value)
        {
            return value == "market" || value == "buy_limit" || value == "buy_stop"
                || value == "buy_stop_limit" || value == "sell_limit" || value == "sell_stop"
                || value == "sell_stop_limit";
        }

        private static bool IsOrderTypeForDirection(string direction, string orderType)
        {
            if ((direction != "buy" && direction != "sell") || !IsOrderType(orderType)) return false;
            return orderType == "market" || orderType.StartsWith(direction + "_", StringComparison.Ordinal);
        }

        private static bool IsDecimalText(string value)
        {
            int separator = value.IndexOf('.');
            if (separator != value.LastIndexOf('.')) return false;
            int wholeLength = separator < 0 ? value.Length : separator;
            if (wholeLength < 1 || (wholeLength > 1 && value[0] == '0')
                || (separator >= 0 && separator == value.Length - 1)) return false;
            for (int index = 0; index < value.Length; index++)
            {
                if (index == separator) continue;
                if (value[index] < '0' || value[index] > '9') return false;
            }
            return true;
        }

        private static IDictionary<string, object> ReadReconcileContext(string resultJson)
        {
            if (string.IsNullOrEmpty(resultJson)) return null;
            IDictionary<string, object> root = new JavaScriptSerializer().DeserializeObject(resultJson)
                as IDictionary<string, object>;
            object resultRaw;
            IDictionary<string, object> result;
            object context;
            return root != null && root.TryGetValue("result", out resultRaw)
                && (result = resultRaw as IDictionary<string, object>) != null
                && result.TryGetValue("reconcile", out context)
                ? context as IDictionary<string, object> : null;
        }

        private static TerminalCommandExecutionResult ResolveReconciliation(
            TerminalCommandExecutionResult observed)
        {
            if (observed.Status != "succeeded" || observed.Result == null) return observed;
            object rawValue;
            IDictionary<string, object> raw;
            object resolutionValue;
            IDictionary<string, object> resolution;
            if (!observed.Result.TryGetValue("raw_result", out rawValue)
                || (raw = rawValue as IDictionary<string, object>) == null
                || !raw.TryGetValue("resolution", out resolutionValue)
                || (resolution = resolutionValue as IDictionary<string, object>) == null)
                return TerminalCommandExecutionResult.Uncertain("bridge_reconciliation_inconclusive", observed.Result);
            string status = TerminalCommandSourceSupport.ReadText(resolution, "status");
            string code = TerminalCommandSourceSupport.ReadOptionalText(resolution, "error_code");
            return status == "succeeded" ? TerminalCommandExecutionResult.Create("succeeded", observed.Result, null, observed.TerminalCode)
                : status == "failed" ? TerminalCommandExecutionResult.Create("failed", observed.Result, code, observed.TerminalCode)
                : TerminalCommandExecutionResult.Uncertain(code ?? "bridge_reconciliation_pending", observed.Result);
        }

        private static string SafeCode(string value, string fallback)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128) return fallback;
            for (int index = 0; index < value.Length; index++)
            {
                char item = value[index];
                if (!((item >= 'a' && item <= 'z') || (item >= '0' && item <= '9') || item == '_')) return fallback;
            }
            return value;
        }

        private static long ReadLong(IDictionary<string, object> values, string key)
        {
            object value;
            if (!values.TryGetValue(key, out value)) throw new InvalidDataException("bridge_reconcile_context_invalid");
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            throw new InvalidDataException("bridge_reconcile_context_invalid");
        }

        private static string Last20(string value)
        {
            return value.Length <= 20 ? value : value.Substring(value.Length - 20);
        }
    }
}
