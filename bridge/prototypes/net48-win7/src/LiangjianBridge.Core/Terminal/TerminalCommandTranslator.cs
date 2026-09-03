using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class TerminalTranslatedCommand
    {
        internal TerminalTranslatedCommand(string requestId, string commandId,
            TerminalCommandActionCode action, byte[] payload)
        {
            RequestId = requestId;
            CommandId = commandId;
            Action = action;
            Payload = payload;
        }

        public string RequestId { get; private set; }
        public string CommandId { get; private set; }
        public TerminalCommandActionCode Action { get; private set; }
        public byte[] Payload { get; private set; }
    }

    // Converts the public command envelope to the deliberately small terminal
    // command wire.  Business idempotency, risk decisions and the durable
    // ledger stay on the server/Bridge side; this translator only projects
    // typed terminal arguments and expected identity fields.
    public static class TerminalCommandTranslator
    {
        private static readonly HashSet<string> ExpectedStateFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "ticket", "symbol", "direction", "order_type", "magic", "volume",
            "open_price", "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc"
        };

        public static TerminalTranslatedCommand Translate(TerminalRequest request, TerminalReadOnlySession session)
        {
            if (request == null || session == null)
            {
                throw new ArgumentNullException(request == null ? "request" : "session");
            }
            if (request.Type != "command_request"
                || !string.Equals(request.TerminalInstanceId, session.TerminalInstanceId, StringComparison.Ordinal)
                || request.SessionEpoch != session.SessionEpoch
                || !string.Equals(request.BrokerServer, session.Hello.BrokerServer, StringComparison.Ordinal)
                || !string.Equals(request.Login, session.Hello.Login, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_terminal_command_route_mismatch");
            }

            TerminalCommandSpec translated = TranslateSpec(request);
            return new TerminalTranslatedCommand(request.RequestId, request.CommandId,
                translated.Action, TerminalCommandPayload.Create(translated));
        }

        public static TerminalCommandSpec TranslateSpec(TerminalRequest request)
        {
            if (request == null) throw new ArgumentNullException("request");
            if (request.Type != "command_request")
                throw new InvalidDataException("bridge_terminal_command_type_invalid");

            TerminalCommandActionCode action = ActionCode(request.Action);
            IDictionary<string, object> parameters = request.Parameters;
            if (parameters == null || parameters.Count > 64)
            {
                throw new InvalidDataException("bridge_terminal_command_params_invalid");
            }

            TerminalCommandExpectedState expected = ReadExpectedState(request.ExpectedState, action);
            bool expectedRequired = action == TerminalCommandActionCode.PositionProtectionSet
                || action == TerminalCommandActionCode.PositionClose
                || action == TerminalCommandActionCode.PendingOrderModify
                || action == TerminalCommandActionCode.PendingOrderCancel;
            if (expectedRequired && expected == null)
            {
                throw new InvalidDataException("bridge_terminal_expected_state_required");
            }
            if (!expectedRequired && expected != null)
            {
                throw new InvalidDataException("bridge_terminal_expected_state_not_allowed");
            }
            TerminalCommandSpec spec;
            switch (action)
            {
                case TerminalCommandActionCode.OrderPlace:
                    spec = TranslatePlace(request, parameters);
                    break;
                case TerminalCommandActionCode.PositionProtectionSet:
                    spec = TranslateProtection(request, parameters, expected);
                    break;
                case TerminalCommandActionCode.PositionClose:
                    spec = TranslateClose(request, parameters, expected);
                    break;
                case TerminalCommandActionCode.PendingOrderModify:
                    spec = TranslatePendingModify(request, parameters, expected);
                    break;
                case TerminalCommandActionCode.PendingOrderCancel:
                    spec = TranslatePendingCancel(request, parameters, expected);
                    break;
                case TerminalCommandActionCode.ExecutionLookup:
                    spec = TranslateLookup(request, parameters);
                    break;
                default:
                    throw new InvalidDataException("bridge_terminal_command_action_unsupported");
            }
            return spec;
        }

        private static TerminalCommandSpec TranslatePlace(TerminalRequest request,
            IDictionary<string, object> values)
        {
            RequireOnly(values, "symbol", "direction", "order_type", "volume", "price",
                "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc",
                "deviation", "magic");
            string symbol = ReadString(values, "symbol", 64, false, true);
            TerminalCommandDirectionCode direction = ReadDirection(values, true);
            TerminalCommandOrderTypeCode orderType = ReadOrderType(values, direction, true);
            if (values.ContainsKey("stop_limit_price"))
            {
                throw new InvalidDataException("bridge_terminal_stop_limit_unsupported");
            }
            string volume = ReadDecimal(values, "volume", true, false);
            bool priceSpecified;
            string price = ReadOptionalDecimal(values, "price", false, out priceSpecified, false);
            if (orderType == TerminalCommandOrderTypeCode.Market && priceSpecified)
            {
                throw new InvalidDataException("bridge_terminal_market_price_not_allowed");
            }
            if (orderType != TerminalCommandOrderTypeCode.Market && !priceSpecified)
            {
                throw new InvalidDataException("bridge_terminal_pending_price_required");
            }
            bool stopLossSpecified;
            string stopLoss = ReadOptionalDecimal(values, "stop_loss", false, out stopLossSpecified, false);
            bool takeProfitSpecified;
            string takeProfit = ReadOptionalDecimal(values, "take_profit", false, out takeProfitSpecified, false);
            bool expirationSpecified;
            long expiration = ReadOptionalTimestamp(values, "expiration_utc_msc", out expirationSpecified, false);
            if (orderType == TerminalCommandOrderTypeCode.Market && expirationSpecified)
            {
                throw new InvalidDataException("bridge_terminal_market_expiration_not_allowed");
            }
            return NewSpec(request, TerminalCommandActionCode.OrderPlace, 0, symbol, direction, orderType,
                ReadRequiredInt32(values, "magic", 0, int.MaxValue), volume, priceSpecified, price,
                stopLossSpecified, stopLoss, takeProfitSpecified, takeProfit, expirationSpecified,
                expiration, ReadRequiredInt32(values, "deviation", 0, 100000),
                string.Empty, string.Empty, null);
        }

        private static TerminalCommandSpec TranslateProtection(TerminalRequest request,
            IDictionary<string, object> values, TerminalCommandExpectedState expected)
        {
            RequireOnly(values, "ticket", "stop_loss", "take_profit", "remove_stop_loss",
                "remove_take_profit");
            RequireExpected(expected, TerminalCommandActionCode.PositionProtectionSet);
            if (expected.OrderType != TerminalCommandOrderTypeCode.Market)
            {
                throw new InvalidDataException("bridge_terminal_position_type_required");
            }
            EnsureTicket(values, expected);
            bool stopLossSpecified;
            string stopLoss = ReadProtectionTarget(values, "stop_loss", "remove_stop_loss", out stopLossSpecified);
            bool takeProfitSpecified;
            string takeProfit = ReadProtectionTarget(values, "take_profit", "remove_take_profit", out takeProfitSpecified);
            if (!stopLossSpecified && !takeProfitSpecified)
            {
                throw new InvalidDataException("bridge_terminal_protection_target_required");
            }
            return NewSpec(request, TerminalCommandActionCode.PositionProtectionSet,
                ReadTicket(values), expected.Symbol, expected.Direction, ExpectedMarketType(expected), expected.Magic,
                expected.Volume, false, string.Empty, stopLossSpecified, stopLoss, takeProfitSpecified, takeProfit,
                false, 0, 0, string.Empty, string.Empty, expected);
        }

        private static TerminalCommandSpec TranslateClose(TerminalRequest request,
            IDictionary<string, object> values, TerminalCommandExpectedState expected)
        {
            RequireOnly(values, "ticket", "volume", "deviation");
            RequireExpected(expected, TerminalCommandActionCode.PositionClose);
            if (expected.OrderType != TerminalCommandOrderTypeCode.Market)
            {
                throw new InvalidDataException("bridge_terminal_position_type_required");
            }
            EnsureTicket(values, expected);
            bool volumeSpecified;
            string volume = ReadOptionalDecimal(values, "volume", false, out volumeSpecified, false);
            if (!volumeSpecified)
            {
                volume = expected.Volume;
            }
            return NewSpec(request, TerminalCommandActionCode.PositionClose, ReadTicket(values), expected.Symbol,
                expected.Direction, ExpectedMarketType(expected), expected.Magic, volume, false, string.Empty,
                false, string.Empty, false, string.Empty, false, 0,
                ReadRequiredInt32(values, "deviation", 0, 100000), string.Empty, string.Empty, expected);
        }

        private static TerminalCommandSpec TranslatePendingModify(TerminalRequest request,
            IDictionary<string, object> values, TerminalCommandExpectedState expected)
        {
            RequireOnly(values, "ticket", "price", "stop_limit_price", "stop_loss", "take_profit", "expiration_utc_msc",
                "remove_stop_loss", "remove_take_profit", "remove_expiration");
            RequireExpected(expected, TerminalCommandActionCode.PendingOrderModify);
            if (expected.OrderType == TerminalCommandOrderTypeCode.None
                || expected.OrderType == TerminalCommandOrderTypeCode.Market)
            {
                throw new InvalidDataException("bridge_terminal_pending_order_type_required");
            }
            EnsureTicket(values, expected);
            if (values.ContainsKey("stop_limit_price"))
            {
                throw new InvalidDataException("bridge_terminal_stop_limit_unsupported");
            }
            bool priceSpecified;
            string price = ReadOptionalDecimal(values, "price", false, out priceSpecified, false);
            bool stopLossSpecified;
            string stopLoss = ReadProtectionTarget(values, "stop_loss", "remove_stop_loss", out stopLossSpecified);
            bool takeProfitSpecified;
            string takeProfit = ReadProtectionTarget(values, "take_profit", "remove_take_profit", out takeProfitSpecified);
            bool expirationSpecified;
            long expiration = ReadOptionalTimestamp(values, "expiration_utc_msc", out expirationSpecified, false);
            bool removeExpiration = ReadOptionalBool(values, "remove_expiration");
            if (removeExpiration)
            {
                if (expirationSpecified)
                {
                    throw new InvalidDataException("bridge_terminal_expiration_remove_conflict");
                }
                expirationSpecified = true;
                expiration = 0;
            }
            if (!priceSpecified && !stopLossSpecified && !takeProfitSpecified && !expirationSpecified)
            {
                throw new InvalidDataException("bridge_terminal_pending_modify_target_required");
            }
            return NewSpec(request, TerminalCommandActionCode.PendingOrderModify, ReadTicket(values), expected.Symbol,
                expected.Direction, expected.OrderType, expected.Magic, expected.Volume, priceSpecified, price,
                stopLossSpecified, stopLoss, takeProfitSpecified, takeProfit, expirationSpecified, expiration,
                0, string.Empty, string.Empty, expected);
        }

        private static TerminalCommandSpec TranslatePendingCancel(TerminalRequest request,
            IDictionary<string, object> values, TerminalCommandExpectedState expected)
        {
            RequireOnly(values, "ticket");
            RequireExpected(expected, TerminalCommandActionCode.PendingOrderCancel);
            if (expected.OrderType == TerminalCommandOrderTypeCode.None
                || expected.OrderType == TerminalCommandOrderTypeCode.Market)
            {
                throw new InvalidDataException("bridge_terminal_pending_order_type_required");
            }
            EnsureTicket(values, expected);
            return NewSpec(request, TerminalCommandActionCode.PendingOrderCancel, ReadTicket(values), expected.Symbol,
                expected.Direction, expected.OrderType, expected.Magic, expected.Volume, false, string.Empty,
                false, string.Empty, false, string.Empty, false, 0, 0, string.Empty, string.Empty, expected);
        }

        private static TerminalCommandSpec TranslateLookup(TerminalRequest request,
            IDictionary<string, object> values)
        {
            RequireOnly(values, "ticket", "idempotency_key", "symbol", "magic");
            bool hasTicket = values.ContainsKey("ticket") && values["ticket"] != null;
            bool hasKey = values.ContainsKey("idempotency_key") && values["idempotency_key"] != null;
            if (hasTicket == hasKey)
            {
                throw new InvalidDataException("bridge_terminal_lookup_selector_invalid");
            }
            long ticket = hasTicket ? ReadTicket(values) : 0;
            string lookupReference = hasKey ? ReadString(values, "idempotency_key", 191, false, true) : string.Empty;
            if (hasKey && lookupReference.Length < 16)
            {
                throw new InvalidDataException("bridge_terminal_lookup_idempotency_key_invalid");
            }
            string symbol = hasKey ? ReadString(values, "symbol", 64, false, true) : string.Empty;
            int magic = hasKey ? ReadRequiredInt32(values, "magic", int.MinValue, int.MaxValue) : 0;
            return NewSpec(request, TerminalCommandActionCode.ExecutionLookup, ticket, symbol,
                TerminalCommandDirectionCode.None, TerminalCommandOrderTypeCode.None, magic, string.Empty,
                false, string.Empty, false, string.Empty, false, string.Empty, false, 0, 0,
                string.Empty, lookupReference, null);
        }

        private static TerminalCommandSpec NewSpec(TerminalRequest request, TerminalCommandActionCode action,
            long ticket, string symbol, TerminalCommandDirectionCode direction,
            TerminalCommandOrderTypeCode orderType, int magic, string volume,
            bool priceSpecified, string price, bool stopLossSpecified, string stopLoss,
            bool takeProfitSpecified, string takeProfit, bool expirationSpecified, long expiration,
            int deviation, string comment, string lookupReference, TerminalCommandExpectedState expected)
        {
            return new TerminalCommandSpec(request.RequestId, request.CommandId, request.IdempotencyKey, action,
                request.IssuedAtUtcMsc, request.DeadlineUtcMsc, request.TerminalInstanceId,
                request.BrokerServer, request.Login, request.SessionEpoch, ticket, symbol, direction, orderType,
                magic, volume, priceSpecified, price, stopLossSpecified, stopLoss, takeProfitSpecified, takeProfit,
                expirationSpecified, expiration, deviation, comment, lookupReference, expected);
        }

        private static TerminalCommandActionCode ActionCode(string action)
        {
            switch (action)
            {
                case "order.place": return TerminalCommandActionCode.OrderPlace;
                case "position.protection.set": return TerminalCommandActionCode.PositionProtectionSet;
                case "position.close": return TerminalCommandActionCode.PositionClose;
                case "pending_order.modify": return TerminalCommandActionCode.PendingOrderModify;
                case "pending_order.cancel": return TerminalCommandActionCode.PendingOrderCancel;
                case "execution.lookup": return TerminalCommandActionCode.ExecutionLookup;
                default: throw new InvalidDataException("bridge_terminal_command_action_unsupported");
            }
        }

        private static TerminalCommandExpectedState ReadExpectedState(IDictionary<string, object> value,
            TerminalCommandActionCode action)
        {
            if (value == null)
            {
                return null;
            }
            if (value.Count > 32)
            {
                throw new InvalidDataException("bridge_terminal_expected_state_size_invalid");
            }
            foreach (string field in value.Keys)
            {
                if (!ExpectedStateFields.Contains(field))
                {
                    throw new InvalidDataException("bridge_terminal_expected_state_unknown_field");
                }
            }
            TerminalCommandExpectedState expected = new TerminalCommandExpectedState();
            expected.Ticket = ReadTicket(value, "ticket", true);
            expected.Symbol = ReadString(value, "symbol", 64, false, true);
            expected.Direction = ReadDirection(value, true);
            expected.OrderType = ReadOrderType(value, expected.Direction, true);
            expected.Magic = ReadRequiredInt32(value, "magic", 0, int.MaxValue);
            expected.Volume = ReadDecimal(value, "volume", true, false);
            if (!value.ContainsKey("stop_limit_price"))
            {
                throw new InvalidDataException("bridge_terminal_expected_stop_limit_price_missing");
            }
            if (value["stop_limit_price"] != null)
            {
                bool stopLimitSpecified;
                ReadOptionalDecimal(value, "stop_limit_price", false, out stopLimitSpecified, false);
                throw new InvalidDataException("bridge_terminal_stop_limit_unsupported");
            }
            expected.OpenPrice = ReadDecimal(value, "open_price", true, false);
            expected.OpenPriceSpecified = true;
            bool stopLossSpecified;
            string stopLoss;
            ReadRequiredNullableDecimal(value, "stop_loss", out stopLossSpecified, out stopLoss);
            expected.StopLossSpecified = stopLossSpecified;
            expected.StopLoss = stopLoss;
            bool takeProfitSpecified;
            string takeProfit;
            ReadRequiredNullableDecimal(value, "take_profit", out takeProfitSpecified, out takeProfit);
            expected.TakeProfitSpecified = takeProfitSpecified;
            expected.TakeProfit = takeProfit;
            bool expirationSpecified;
            expected.ExpirationUtcMsc = ReadRequiredNullableTimestamp(value, "expiration_utc_msc", out expirationSpecified);
            expected.ExpirationSpecified = expirationSpecified;
            if ((action == TerminalCommandActionCode.PendingOrderModify
                    || action == TerminalCommandActionCode.PendingOrderCancel)
                && (expected.OrderType == TerminalCommandOrderTypeCode.Market
                    || expected.OrderType == TerminalCommandOrderTypeCode.None))
            {
                throw new InvalidDataException("bridge_terminal_pending_order_type_required");
            }
            return expected;
        }

        private static void RequireExpected(TerminalCommandExpectedState expected,
            TerminalCommandActionCode action)
        {
            if (expected == null || expected.Ticket <= 0 || string.IsNullOrEmpty(expected.Symbol)
                || expected.Direction == TerminalCommandDirectionCode.None || expected.Volume == null)
            {
                throw new InvalidDataException("bridge_terminal_expected_state_required");
            }
        }

        private static TerminalCommandOrderTypeCode ExpectedMarketType(TerminalCommandExpectedState expected)
        {
            return TerminalCommandOrderTypeCode.Market;
        }

        private static void EnsureTicket(IDictionary<string, object> values,
            TerminalCommandExpectedState expected)
        {
            long ticket = ReadTicket(values);
            if (ticket != expected.Ticket)
            {
                throw new InvalidDataException("bridge_terminal_expected_ticket_mismatch");
            }
        }

        private static long ReadTicket(IDictionary<string, object> values)
        {
            return ReadTicket(values, "ticket", true);
        }

        private static long ReadTicket(IDictionary<string, object> values, string key, bool required)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                if (!required) return 0;
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            long value;
            if (raw is string)
            {
                if (!long.TryParse((string)raw, NumberStyles.None, CultureInfo.InvariantCulture, out value))
                {
                    throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
                }
            }
            else throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            if (value <= 0)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return value;
        }

        private static TerminalCommandDirectionCode ReadDirection(IDictionary<string, object> values, bool required)
        {
            if (!values.ContainsKey("direction"))
            {
                if (!required) return TerminalCommandDirectionCode.None;
                throw new InvalidDataException("bridge_terminal_direction_required");
            }
            string value = ReadString(values, "direction", 8, false, true).ToLowerInvariant();
            if (value == "buy") return TerminalCommandDirectionCode.Buy;
            if (value == "sell") return TerminalCommandDirectionCode.Sell;
            throw new InvalidDataException("bridge_terminal_direction_invalid");
        }

        private static TerminalCommandOrderTypeCode ReadOrderType(
            IDictionary<string, object> values, TerminalCommandDirectionCode direction, bool required)
        {
            if (!values.ContainsKey("order_type"))
            {
                if (required) throw new InvalidDataException("bridge_terminal_order_type_required");
                return TerminalCommandOrderTypeCode.Market;
            }
            string value = ReadString(values, "order_type", 32, false, true).ToLowerInvariant();
            if (value == "market") return TerminalCommandOrderTypeCode.Market;
            if (value == "buy_stop_limit" || value == "sell_stop_limit")
            {
                throw new InvalidDataException("bridge_terminal_stop_limit_unsupported");
            }
            if (value == "buy_limit" && direction == TerminalCommandDirectionCode.Buy)
                return TerminalCommandOrderTypeCode.BuyLimit;
            if (value == "buy_stop" && direction == TerminalCommandDirectionCode.Buy)
                return TerminalCommandOrderTypeCode.BuyStop;
            if (value == "sell_limit" && direction == TerminalCommandDirectionCode.Sell)
                return TerminalCommandOrderTypeCode.SellLimit;
            if (value == "sell_stop" && direction == TerminalCommandDirectionCode.Sell)
                return TerminalCommandOrderTypeCode.SellStop;
            throw new InvalidDataException("bridge_terminal_order_type_invalid");
        }

        private static int ReadOptionalInt32(IDictionary<string, object> values, string key,
            int fallback, int minimum, int maximum)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null) return fallback;
            int value;
            if (raw is int) value = (int)raw;
            else if (raw is long && (long)raw >= int.MinValue && (long)raw <= int.MaxValue) value = (int)(long)raw;
            else throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            if (value < minimum || value > maximum) throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            return value;
        }

        private static int ReadRequiredInt32(IDictionary<string, object> values, string key,
            int minimum, int maximum)
        {
            if (!values.ContainsKey(key) || values[key] == null)
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            return ReadOptionalInt32(values, key, 0, minimum, maximum);
        }

        private static long ReadOptionalTimestamp(IDictionary<string, object> values, string key,
            out bool specified, bool allowNull)
        {
            specified = values.ContainsKey(key);
            if (!specified) return 0;
            object raw = values[key];
            if (raw == null)
            {
                if (allowNull)
                {
                    specified = false;
                    return 0;
                }
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            long value;
            if (raw is long) value = (long)raw;
            else if (raw is int) value = (int)raw;
            else if (raw is string && long.TryParse((string)raw, NumberStyles.None, CultureInfo.InvariantCulture, out value)) { }
            else throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            if (value < 1) throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            return value;
        }

        private static string ReadDecimal(IDictionary<string, object> values, string key,
            bool required, bool allowZero)
        {
            bool specified;
            string value = ReadOptionalDecimal(values, key, allowZero, out specified, false);
            if (!specified && required) throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            return value;
        }

        private static string ReadOptionalDecimal(IDictionary<string, object> values, string key,
            bool allowZero, out bool specified, bool allowNull)
        {
            specified = values.ContainsKey(key);
            if (!specified) return string.Empty;
            if (values[key] == null)
            {
                if (allowNull)
                {
                    specified = false;
                    return string.Empty;
                }
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            string text = NumberText(values[key], key);
            string validated = TerminalCommandPayload.ValidateDecimalText(text, false, key);
            decimal parsed = decimal.Parse(validated, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            if (!allowZero && parsed <= 0) throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            return validated;
        }

        private static void ReadRequiredNullableDecimal(IDictionary<string, object> values, string key,
            out bool specified, out string value)
        {
            if (!values.ContainsKey(key))
            {
                throw new InvalidDataException("bridge_terminal_expected_" + key + "_missing");
            }
            if (values[key] == null)
            {
                specified = true;
                value = "0";
                return;
            }
            value = ReadOptionalDecimal(values, key, false, out specified, false);
        }

        private static long ReadRequiredNullableTimestamp(IDictionary<string, object> values, string key,
            out bool specified)
        {
            if (!values.ContainsKey(key))
            {
                throw new InvalidDataException("bridge_terminal_expected_" + key + "_missing");
            }
            if (values[key] == null)
            {
                specified = true;
                return 0;
            }
            return ReadOptionalTimestamp(values, key, out specified, false);
        }

        private static string ReadProtectionTarget(IDictionary<string, object> values, string valueKey,
            string removeKey, out bool specified)
        {
            bool remove = ReadOptionalBool(values, removeKey);
            if (remove && values.ContainsKey(valueKey))
            {
                throw new InvalidDataException("bridge_terminal_" + valueKey + "_remove_conflict");
            }
            if (remove)
            {
                specified = true;
                return string.Empty;
            }
            return ReadOptionalDecimal(values, valueKey, false, out specified, false);
        }

        private static bool ReadOptionalBool(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)) return false;
            if (!(raw is bool))
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return (bool)raw;
        }

        private static string NumberText(object raw, string key)
        {
            string text = raw as string;
            if (text != null) return text;
            throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
        }

        private static string ReadString(IDictionary<string, object> values, string key,
            int maximumLength, bool allowEmpty, bool required)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                if (!required) return string.Empty;
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            string value = raw as string;
            if (value == null || value.Length > maximumLength || (!allowEmpty && value.Length == 0)
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_terminal_param_" + key + "_invalid");
            }
            return value;
        }

        private static void RequireOnly(IDictionary<string, object> values, params string[] allowed)
        {
            HashSet<string> names = new HashSet<string>(allowed, StringComparer.Ordinal);
            foreach (string key in values.Keys)
            {
                if (!names.Contains(key)) throw new InvalidDataException("bridge_terminal_command_params_unknown_field");
            }
        }
    }
}
