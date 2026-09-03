using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Terminal
{
    // The terminal command wire is intentionally separate from the public JSON
    // envelope.  It contains a fixed field order and only the values needed by
    // the terminal API.  It is not a JSON/script execution channel.
    public enum TerminalCommandActionCode
    {
        OrderPlace = 1,
        PositionProtectionSet = 2,
        PositionClose = 3,
        PendingOrderModify = 4,
        PendingOrderCancel = 5,
        ExecutionLookup = 6
    }

    public enum TerminalCommandDirectionCode
    {
        None = 0,
        Buy = 1,
        Sell = 2
    }

    public enum TerminalCommandOrderTypeCode
    {
        None = 0,
        Market = 1,
        BuyLimit = 2,
        BuyStop = 3,
        SellLimit = 4,
        SellStop = 5
    }

    public enum TerminalCommandStatusCode
    {
        Succeeded = 1,
        Rejected = 2,
        Failed = 3,
        Uncertain = 4
    }

    public enum TerminalCommandResourceStateCode
    {
        Unknown = 0,
        Absent = 1,
        Position = 2,
        Pending = 3,
        Closed = 4,
        Filled = 5
    }

    [Flags]
    public enum TerminalCommandResultFlags
    {
        None = 0,
        AlreadyAbsent = 1,
        AlreadyApplied = 2
    }

    public sealed class TerminalCommandExpectedState
    {
        public long Ticket { get; internal set; }
        public string Symbol { get; internal set; }
        public TerminalCommandDirectionCode Direction { get; internal set; }
        public TerminalCommandOrderTypeCode OrderType { get; internal set; }
        public int Magic { get; internal set; }
        public string Volume { get; internal set; }
        public bool OpenPriceSpecified { get; internal set; }
        public string OpenPrice { get; internal set; }
        public bool StopLossSpecified { get; internal set; }
        public string StopLoss { get; internal set; }
        public bool TakeProfitSpecified { get; internal set; }
        public string TakeProfit { get; internal set; }
        public bool ExpirationSpecified { get; internal set; }
        public long ExpirationUtcMsc { get; internal set; }
    }

    public sealed class TerminalCommandSpec
    {
        internal TerminalCommandSpec(
            string requestId,
            string commandId,
            string idempotencyKey,
            TerminalCommandActionCode action,
            long issuedAtUtcMsc,
            long deadlineUtcMsc,
            string terminalInstanceId,
            string brokerServer,
            string login,
            long sessionEpoch,
            long ticket,
            string symbol,
            TerminalCommandDirectionCode direction,
            TerminalCommandOrderTypeCode orderType,
            int magic,
            string volume,
            bool priceSpecified,
            string price,
            bool stopLossSpecified,
            string stopLoss,
            bool takeProfitSpecified,
            string takeProfit,
            bool expirationSpecified,
            long expirationUtcMsc,
            int deviation,
            string comment,
            string lookupReference,
            TerminalCommandExpectedState expectedState)
        {
            RequestId = requestId;
            CommandId = commandId;
            IdempotencyKey = idempotencyKey;
            Action = action;
            IssuedAtUtcMsc = issuedAtUtcMsc;
            DeadlineUtcMsc = deadlineUtcMsc;
            TerminalInstanceId = terminalInstanceId;
            BrokerServer = brokerServer;
            Login = login;
            SessionEpoch = sessionEpoch;
            Ticket = ticket;
            Symbol = symbol;
            Direction = direction;
            OrderType = orderType;
            Magic = magic;
            Volume = volume;
            PriceSpecified = priceSpecified;
            Price = price;
            StopLossSpecified = stopLossSpecified;
            StopLoss = stopLoss;
            TakeProfitSpecified = takeProfitSpecified;
            TakeProfit = takeProfit;
            ExpirationSpecified = expirationSpecified;
            ExpirationUtcMsc = expirationUtcMsc;
            Deviation = deviation;
            Comment = comment;
            LookupReference = lookupReference;
            ExpectedState = expectedState;
        }

        public string RequestId { get; private set; }
        public string CommandId { get; private set; }
        public string IdempotencyKey { get; private set; }
        public TerminalCommandActionCode Action { get; private set; }
        public long IssuedAtUtcMsc { get; private set; }
        public long DeadlineUtcMsc { get; private set; }
        public string TerminalInstanceId { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public long SessionEpoch { get; private set; }
        public long Ticket { get; private set; }
        public string Symbol { get; private set; }
        public TerminalCommandDirectionCode Direction { get; private set; }
        public TerminalCommandOrderTypeCode OrderType { get; private set; }
        public int Magic { get; private set; }
        public string Volume { get; private set; }
        public bool PriceSpecified { get; private set; }
        public string Price { get; private set; }
        public bool StopLossSpecified { get; private set; }
        public string StopLoss { get; private set; }
        public bool TakeProfitSpecified { get; private set; }
        public string TakeProfit { get; private set; }
        public bool ExpirationSpecified { get; private set; }
        public long ExpirationUtcMsc { get; private set; }
        public int Deviation { get; private set; }
        public string Comment { get; private set; }
        public string LookupReference { get; private set; }
        public TerminalCommandExpectedState ExpectedState { get; private set; }
    }

    public static class TerminalCommandPayload
    {
        public const int MessageType = 20;
        public const int ResultMessageType = 21;
        public const int ErrorMessageType = 22;
        public const int MaximumDecimalBytes = 32;
        public const int MaximumCommentBytes = 64;

        public static byte[] Create(TerminalCommandSpec command)
        {
            if (command == null)
            {
                throw new ArgumentNullException("command");
            }
            ValidateCommand(command);

            TerminalWireWriter writer = new TerminalWireWriter();
            writer.WriteInt32(MessageType);
            writer.WriteString(command.RequestId);
            writer.WriteString(command.CommandId);
            writer.WriteString(command.IdempotencyKey);
            writer.WriteInt32((int)command.Action);
            writer.WriteInt64(command.IssuedAtUtcMsc);
            writer.WriteInt64(command.DeadlineUtcMsc);
            writer.WriteString(command.TerminalInstanceId);
            writer.WriteString(command.BrokerServer);
            writer.WriteString(command.Login);
            writer.WriteInt64(command.SessionEpoch);

            writer.WriteInt64(command.Ticket);
            writer.WriteString(command.Symbol);
            writer.WriteInt32((int)command.Direction);
            writer.WriteInt32((int)command.OrderType);
            writer.WriteInt32(command.Magic);
            writer.WriteString(command.Volume);
            WriteDecimal(writer, command.PriceSpecified, command.Price);
            WriteDecimal(writer, command.StopLossSpecified, command.StopLoss);
            WriteDecimal(writer, command.TakeProfitSpecified, command.TakeProfit);
            writer.WriteInt32(command.ExpirationSpecified ? 1 : 0);
            writer.WriteInt64(command.ExpirationUtcMsc);
            writer.WriteInt32(command.Deviation);
            writer.WriteString(command.Comment);
            writer.WriteString(command.LookupReference);

            TerminalCommandExpectedState expected = command.ExpectedState;
            if (expected == null)
            {
                expected = new TerminalCommandExpectedState();
            }
            writer.WriteInt64(expected.Ticket);
            writer.WriteString(expected.Symbol ?? string.Empty);
            writer.WriteInt32((int)expected.Direction);
            writer.WriteInt32((int)expected.OrderType);
            writer.WriteInt32(expected.Magic);
            writer.WriteString(expected.Volume ?? string.Empty);
            WriteDecimal(writer, expected.OpenPriceSpecified, expected.OpenPrice);
            WriteDecimal(writer, expected.StopLossSpecified, expected.StopLoss);
            WriteDecimal(writer, expected.TakeProfitSpecified, expected.TakeProfit);
            writer.WriteInt32(expected.ExpirationSpecified ? 1 : 0);
            writer.WriteInt64(expected.ExpirationUtcMsc);
            // MT4 has no broker-side resource revision.  A non-zero value is
            // rejected by the adapter instead of being silently ignored.
            writer.WriteInt64(0);
            return writer.ToArray();
        }

        private static void WriteDecimal(TerminalWireWriter writer, bool specified, string value)
        {
            writer.WriteInt32(specified ? 1 : 0);
            writer.WriteString(value ?? string.Empty);
        }

        private static void ValidateCommand(TerminalCommandSpec command)
        {
            RequireText(command.RequestId, 191, "request_id");
            RequireText(command.CommandId, 191, "command_id");
            RequireText(command.IdempotencyKey, 191, "idempotency_key");
            if (command.IdempotencyKey.Length < 16)
            {
                throw new InvalidDataException("bridge_terminal_command_idempotency_key_invalid");
            }
            if (!Enum.IsDefined(typeof(TerminalCommandActionCode), command.Action)
                || command.IssuedAtUtcMsc < 1 || command.DeadlineUtcMsc < command.IssuedAtUtcMsc)
            {
                throw new InvalidDataException("bridge_terminal_command_header_invalid");
            }
            RequireText(command.TerminalInstanceId, 191, "terminal_instance_id");
            RequireText(command.BrokerServer, 128, "broker_server");
            RequireText(command.Login, 64, "login");
            if (command.SessionEpoch < 1 || command.Ticket < 0
                || !Enum.IsDefined(typeof(TerminalCommandDirectionCode), command.Direction)
                || !Enum.IsDefined(typeof(TerminalCommandOrderTypeCode), command.OrderType)
                || command.Deviation < 0 || command.Deviation > 100000)
            {
                throw new InvalidDataException("bridge_terminal_command_target_invalid");
            }
            RequireText(command.Symbol, 64, "symbol", true);
            RequireDecimal(command.Volume, false, "volume");
            RequireDecimal(command.Price, command.PriceSpecified, "price");
            RequireDecimal(command.StopLoss, command.StopLossSpecified, "stop_loss", true);
            RequireDecimal(command.TakeProfit, command.TakeProfitSpecified, "take_profit", true);
            if (command.ExpirationUtcMsc < 0)
            {
                throw new InvalidDataException("bridge_terminal_command_expiration_invalid");
            }
            RequireText(command.Comment, MaximumCommentBytes, "comment", true);
            RequireText(command.LookupReference, 191, "lookup_reference", true);
            ValidateExpectedState(command.ExpectedState);
        }

        private static void ValidateExpectedState(TerminalCommandExpectedState expected)
        {
            if (expected == null)
            {
                return;
            }
            if (expected.Ticket < 0 || !Enum.IsDefined(typeof(TerminalCommandDirectionCode), expected.Direction)
                || !Enum.IsDefined(typeof(TerminalCommandOrderTypeCode), expected.OrderType)
                || expected.ExpirationUtcMsc < 0)
            {
                throw new InvalidDataException("bridge_terminal_expected_state_invalid");
            }
            RequireText(expected.Symbol, 64, "expected_symbol", true);
            RequireDecimal(expected.Volume, false, "expected_volume");
            RequireDecimal(expected.OpenPrice, expected.OpenPriceSpecified, "expected_open_price");
            RequireDecimal(expected.StopLoss, expected.StopLossSpecified, "expected_stop_loss");
            RequireDecimal(expected.TakeProfit, expected.TakeProfitSpecified, "expected_take_profit");
        }

        private static void RequireText(string value, int maximumLength, string field)
        {
            RequireText(value, maximumLength, field, false);
        }

        private static void RequireText(string value, int maximumLength, string field, bool allowEmpty)
        {
            if (value == null || value.Length > maximumLength
                || (!allowEmpty && value.Length == 0)
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
        }

        internal static string ValidateDecimalText(string value, bool allowEmpty, string field)
        {
            if (value == null)
            {
                value = string.Empty;
            }
            if (value.Length == 0)
            {
                if (allowEmpty)
                {
                    return string.Empty;
                }
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            if (value.Length > MaximumDecimalBytes)
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            for (int index = 0; index < value.Length; index++)
            {
                char digit = value[index];
                if (digit == '.')
                {
                    if (index == 0 || index == value.Length - 1 || value.IndexOf('.', index + 1) >= 0)
                    {
                        throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
                    }
                    continue;
                }
                if (digit < '0' || digit > '9')
                {
                    throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
                }
            }
            int dotIndex = value.IndexOf('.');
            int integerLength = dotIndex < 0 ? value.Length : dotIndex;
            if (integerLength > 1 && value[0] == '0')
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            decimal parsed;
            if (!decimal.TryParse(value, NumberStyles.AllowDecimalPoint,
                CultureInfo.InvariantCulture, out parsed)
                || parsed < 0)
            {
                throw new InvalidDataException("bridge_terminal_" + field + "_invalid");
            }
            return value;
        }

        private static void RequireDecimal(string value, bool specified, string field)
        {
            RequireDecimal(value, specified, field, false);
        }

        private static void RequireDecimal(string value, bool specified, string field,
            bool allowExplicitEmpty)
        {
            ValidateDecimalText(value, !specified || allowExplicitEmpty, field);
        }
    }

    public sealed class TerminalCommandResult
    {
        private TerminalCommandResult()
        {
        }

        public bool Succeeded { get; private set; }
        public string RequestId { get; private set; }
        public string CommandId { get; private set; }
        public TerminalCommandActionCode Action { get; private set; }
        public TerminalCommandStatusCode Status { get; private set; }
        public int TerminalCode { get; private set; }
        public long Ticket { get; private set; }
        public TerminalCommandResourceStateCode ResourceState { get; private set; }
        public long ObservedAtUtcMsc { get; private set; }
        public string ActualSymbol { get; private set; }
        public TerminalCommandDirectionCode ActualDirection { get; private set; }
        public TerminalCommandOrderTypeCode ActualOrderType { get; private set; }
        public int ActualMagic { get; private set; }
        public string ActualVolume { get; private set; }
        public string ActualPrice { get; private set; }
        public bool ActualStopLossSpecified { get; private set; }
        public string ActualStopLoss { get; private set; }
        public bool ActualTakeProfitSpecified { get; private set; }
        public string ActualTakeProfit { get; private set; }
        public bool ActualExpirationSpecified { get; private set; }
        public long ActualExpirationUtcMsc { get; private set; }
        public long ActualOpenTimeUtcMsc { get; private set; }
        public string ActualComment { get; private set; }
        public TerminalCommandResultFlags Flags { get; private set; }
        public string ErrorCode { get; private set; }
        public string ErrorMessage { get; private set; }

        public static TerminalCommandResult Parse(byte[] payload)
        {
            TerminalWireReader reader = new TerminalWireReader(payload);
            int messageType = reader.ReadInt32();
            if (messageType != TerminalCommandPayload.ResultMessageType
                && messageType != TerminalCommandPayload.ErrorMessageType)
            {
                throw new InvalidDataException("bridge_terminal_command_response_type_invalid");
            }

            TerminalCommandResult result = new TerminalCommandResult();
            result.RequestId = reader.ReadString(191);
            result.CommandId = reader.ReadString(191);
            result.Action = ReadAction(reader.ReadInt32());
            result.Status = ReadStatus(reader.ReadInt32());
            result.TerminalCode = reader.ReadInt32();
            result.Ticket = reader.ReadInt64();
            result.ResourceState = ReadResourceState(reader.ReadInt32());
            result.ObservedAtUtcMsc = reader.ReadInt64();
            result.ActualSymbol = reader.ReadString(64);
            result.ActualDirection = ReadDirection(reader.ReadInt32());
            result.ActualOrderType = ReadOrderType(reader.ReadInt32());
            result.ActualMagic = reader.ReadInt32();
            result.ActualVolume = ReadDecimal(reader, "actual_volume");
            result.ActualPrice = ReadDecimal(reader, "actual_price");
            bool actualStopLossSpecified;
            string actualStopLoss;
            ReadNullableDecimal(reader, out actualStopLossSpecified, out actualStopLoss, "actual_stop_loss");
            result.ActualStopLossSpecified = actualStopLossSpecified;
            result.ActualStopLoss = actualStopLoss;
            bool actualTakeProfitSpecified;
            string actualTakeProfit;
            ReadNullableDecimal(reader, out actualTakeProfitSpecified, out actualTakeProfit, "actual_take_profit");
            result.ActualTakeProfitSpecified = actualTakeProfitSpecified;
            result.ActualTakeProfit = actualTakeProfit;
            int expirationSpecified = reader.ReadInt32();
            if (expirationSpecified != 0 && expirationSpecified != 1)
            {
                throw new InvalidDataException("bridge_terminal_command_expiration_flag_invalid");
            }
            result.ActualExpirationSpecified = expirationSpecified == 1;
            result.ActualExpirationUtcMsc = reader.ReadInt64();
            result.ActualOpenTimeUtcMsc = reader.ReadInt64();
            result.ActualComment = reader.ReadString(TerminalCommandPayload.MaximumCommentBytes);
            result.Flags = (TerminalCommandResultFlags)reader.ReadInt32();
            if ((result.Flags & ~(TerminalCommandResultFlags.AlreadyAbsent | TerminalCommandResultFlags.AlreadyApplied)) != 0)
            {
                throw new InvalidDataException("bridge_terminal_command_result_flags_invalid");
            }
            result.ErrorCode = reader.ReadString(128);
            result.ErrorMessage = reader.ReadString(512);
            reader.EnsureEnd();

            if (string.IsNullOrWhiteSpace(result.RequestId) || string.IsNullOrWhiteSpace(result.CommandId)
                || result.Ticket < 0 || result.ObservedAtUtcMsc < 1 || result.ActualExpirationUtcMsc < 0
                || result.ActualOpenTimeUtcMsc < 0)
            {
                throw new InvalidDataException("bridge_terminal_command_result_invalid");
            }
            result.Succeeded = result.Status == TerminalCommandStatusCode.Succeeded;
            if (messageType == TerminalCommandPayload.ErrorMessageType && result.Succeeded)
            {
                throw new InvalidDataException("bridge_terminal_command_error_status_invalid");
            }
            return result;
        }

        private static string ReadDecimal(TerminalWireReader reader, string field)
        {
            string value = reader.ReadString(TerminalCommandPayload.MaximumDecimalBytes);
            return TerminalCommandPayload.ValidateDecimalText(value, true, field);
        }

        private static void ReadNullableDecimal(TerminalWireReader reader, out bool specified, out string value, string field)
        {
            int flag = reader.ReadInt32();
            if (flag != 0 && flag != 1)
            {
                throw new InvalidDataException("bridge_terminal_command_decimal_flag_invalid");
            }
            specified = flag == 1;
            value = TerminalCommandPayload.ValidateDecimalText(
                reader.ReadString(TerminalCommandPayload.MaximumDecimalBytes), !specified, field);
        }

        private static TerminalCommandActionCode ReadAction(int value)
        {
            if (!Enum.IsDefined(typeof(TerminalCommandActionCode), value))
            {
                throw new InvalidDataException("bridge_terminal_command_action_invalid");
            }
            return (TerminalCommandActionCode)value;
        }

        private static TerminalCommandDirectionCode ReadDirection(int value)
        {
            if (!Enum.IsDefined(typeof(TerminalCommandDirectionCode), value))
            {
                throw new InvalidDataException("bridge_terminal_command_direction_invalid");
            }
            return (TerminalCommandDirectionCode)value;
        }

        private static TerminalCommandOrderTypeCode ReadOrderType(int value)
        {
            if (!Enum.IsDefined(typeof(TerminalCommandOrderTypeCode), value))
            {
                throw new InvalidDataException("bridge_terminal_command_order_type_invalid");
            }
            return (TerminalCommandOrderTypeCode)value;
        }

        private static TerminalCommandStatusCode ReadStatus(int value)
        {
            if (!Enum.IsDefined(typeof(TerminalCommandStatusCode), value))
            {
                throw new InvalidDataException("bridge_terminal_command_status_invalid");
            }
            return (TerminalCommandStatusCode)value;
        }

        private static TerminalCommandResourceStateCode ReadResourceState(int value)
        {
            if (!Enum.IsDefined(typeof(TerminalCommandResourceStateCode), value))
            {
                throw new InvalidDataException("bridge_terminal_command_resource_state_invalid");
            }
            return (TerminalCommandResourceStateCode)value;
        }
    }
}
