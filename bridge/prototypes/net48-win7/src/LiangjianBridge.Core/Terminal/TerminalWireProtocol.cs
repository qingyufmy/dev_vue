using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Terminal
{
    public enum TerminalWireMessageType
    {
        Hello = 1,
        Welcome = 2,
        QueryRequest = 10,
        QueryResponse = 11,
        QueryError = 12,
        Ping = 90,
        Pong = 91
    }

    public enum TerminalResourceCode
    {
        TerminalInfo = 1,
        TerminalClock = 2,
        AccountSnapshot = 3,
        MarketSymbols = 4,
        MarketInstrument = 5,
        MarketQuote = 6,
        MarketCandles = 7,
        TradingPositions = 8,
        TradingPendingOrders = 9,
        HistoryOrders = 10,
        HistoryTrades = 11,
        HistoryDeals = 12,
        ExecutionLookup = 13,
        DiagnosticsHealth = 14
    }

    public enum TerminalTimeframeCode
    {
        M1 = 1,
        M5 = 2,
        M15 = 3,
        M30 = 4,
        H1 = 5,
        H4 = 6,
        D1 = 7,
        W1 = 8,
        MN1 = 9
    }

    public sealed class TerminalHello
    {
        private static readonly HashSet<string> ClockStatuses = new HashSet<string>(StringComparer.Ordinal)
        {
            "calibrated", "observer_bootstrap", "stale", "unavailable"
        };

        private TerminalHello()
        {
        }

        public string AdapterVersion { get; private set; }
        public string Platform { get; private set; }
        public string DataPath { get; private set; }
        public string ProgramPath { get; private set; }
        public string BrokerServer { get; private set; }
        public string Login { get; private set; }
        public int TerminalBuild { get; private set; }
        public bool Connected { get; private set; }
        public bool TradeAllowed { get; private set; }
        public int ServerOffsetMinutes { get; private set; }
        public string ClockStatus { get; private set; }
        public long SampledAtUtcMsc { get; private set; }

        public static TerminalHello Parse(byte[] payload)
        {
            TerminalWireReader reader = new TerminalWireReader(payload);
            reader.ExpectMessageType(TerminalWireMessageType.Hello);
            if (reader.ReadInt32() != 1)
            {
                throw new InvalidDataException("bridge_terminal_wire_protocol_unsupported");
            }

            TerminalHello hello = new TerminalHello();
            hello.AdapterVersion = reader.ReadString(64);
            hello.Platform = reader.ReadString(8);
            hello.DataPath = reader.ReadString(1024);
            hello.ProgramPath = reader.ReadString(1024);
            hello.BrokerServer = reader.ReadString(128);
            hello.Login = reader.ReadString(64);
            hello.TerminalBuild = reader.ReadInt32();
            hello.Connected = reader.ReadBooleanInt32();
            hello.TradeAllowed = reader.ReadBooleanInt32();
            hello.ServerOffsetMinutes = reader.ReadInt32();
            hello.ClockStatus = reader.ReadString(32);
            hello.SampledAtUtcMsc = reader.ReadInt64();
            reader.EnsureEnd();

            if ((hello.Platform != "mt4" && hello.Platform != "mt5")
                || hello.TerminalBuild < 1
                || hello.ServerOffsetMinutes < -840
                || hello.ServerOffsetMinutes > 840
                || !ClockStatuses.Contains(hello.ClockStatus)
                || hello.SampledAtUtcMsc < 1)
            {
                throw new InvalidDataException("bridge_terminal_hello_invalid");
            }
            return hello;
        }
    }

    public static class TerminalWelcome
    {
        public static byte[] Create(string terminalInstanceId, long sessionEpoch)
        {
            if (string.IsNullOrWhiteSpace(terminalInstanceId) || terminalInstanceId.Length > 191 || sessionEpoch < 1)
            {
                throw new ArgumentException("bridge_terminal_welcome_invalid");
            }
            TerminalWireWriter writer = new TerminalWireWriter();
            writer.WriteInt32((int)TerminalWireMessageType.Welcome);
            writer.WriteString(terminalInstanceId);
            writer.WriteInt64(sessionEpoch);
            return writer.ToArray();
        }
    }

    public static class TerminalQueryPayload
    {
        public static byte[] NoParameters(string requestId, TerminalResourceCode resource, long deadlineUtcMsc)
        {
            if (resource != TerminalResourceCode.TerminalInfo
                && resource != TerminalResourceCode.TerminalClock
                && resource != TerminalResourceCode.AccountSnapshot
                && resource != TerminalResourceCode.DiagnosticsHealth)
            {
                throw new ArgumentException("bridge_terminal_parameterless_resource_invalid", "resource");
            }
            return Create(requestId, resource, deadlineUtcMsc, null);
        }

        public static byte[] Symbols(string requestId, int limit, int offset, long deadlineUtcMsc)
        {
            ValidatePage(limit, offset);
            return Create(requestId, TerminalResourceCode.MarketSymbols, deadlineUtcMsc, delegate(TerminalWireWriter writer)
            {
                writer.WriteInt32(limit);
                writer.WriteInt32(offset);
            });
        }

        public static byte[] Symbol(string requestId, TerminalResourceCode resource, string symbol, long deadlineUtcMsc)
        {
            if (resource != TerminalResourceCode.MarketInstrument)
            {
                throw new ArgumentException("bridge_terminal_symbol_resource_invalid", "resource");
            }
            ValidateSymbol(symbol);
            return Create(requestId, resource, deadlineUtcMsc, delegate(TerminalWireWriter writer)
            {
                writer.WriteString(symbol);
            });
        }

        public static byte[] Quote(string requestId, IList<string> symbols, long deadlineUtcMsc)
        {
            if (symbols == null || symbols.Count < 1 || symbols.Count > 64)
            {
                throw new ArgumentException("bridge_terminal_quote_symbols_invalid", "symbols");
            }
            return Create(requestId, TerminalResourceCode.MarketQuote, deadlineUtcMsc, delegate(TerminalWireWriter writer)
            {
                writer.WriteInt32(symbols.Count);
                for (int index = 0; index < symbols.Count; index++)
                {
                    ValidateSymbol(symbols[index]);
                    writer.WriteString(symbols[index]);
                }
            });
        }

        public static byte[] Candles(string requestId, string symbol, TerminalTimeframeCode timeframe, int count, long rangeStartUtcMsc, long rangeEndUtcMsc, long deadlineUtcMsc)
        {
            ValidateSymbol(symbol);
            bool countMode = count >= 1 && count <= 500 && rangeStartUtcMsc == 0 && rangeEndUtcMsc == 0;
            bool rangeMode = count == 0 && rangeStartUtcMsc > 0 && rangeEndUtcMsc > rangeStartUtcMsc;
            if (!Enum.IsDefined(typeof(TerminalTimeframeCode), timeframe) || (!countMode && !rangeMode))
            {
                throw new ArgumentException("bridge_terminal_candles_params_invalid");
            }
            return Create(requestId, TerminalResourceCode.MarketCandles, deadlineUtcMsc, delegate(TerminalWireWriter writer)
            {
                writer.WriteString(symbol);
                writer.WriteInt32((int)timeframe);
                writer.WriteInt32(count);
                writer.WriteInt64(rangeStartUtcMsc);
                writer.WriteInt64(rangeEndUtcMsc);
            });
        }

        public static byte[] TradingCollection(string requestId, TerminalResourceCode resource, int limit, int offset, string symbol, long deadlineUtcMsc)
        {
            if (resource != TerminalResourceCode.TradingPositions && resource != TerminalResourceCode.TradingPendingOrders)
            {
                throw new ArgumentException("bridge_terminal_collection_resource_invalid", "resource");
            }
            ValidatePage(limit, offset);
            if (!string.IsNullOrEmpty(symbol))
            {
                ValidateSymbol(symbol);
            }
            return Create(requestId, resource, deadlineUtcMsc, delegate(TerminalWireWriter writer)
            {
                writer.WriteInt32(limit);
                writer.WriteInt32(offset);
                writer.WriteString(symbol ?? string.Empty);
            });
        }

        public static byte[] History(string requestId, TerminalResourceCode resource, long rangeStartUtcMsc, long rangeEndUtcMsc, int limit, long cursor, long deadlineUtcMsc)
        {
            if ((resource != TerminalResourceCode.HistoryOrders
                    && resource != TerminalResourceCode.HistoryTrades
                    && resource != TerminalResourceCode.HistoryDeals)
                || rangeStartUtcMsc < 1 || rangeEndUtcMsc <= rangeStartUtcMsc
                || limit < 1 || limit > 500 || cursor < 0)
            {
                throw new ArgumentException("bridge_terminal_history_params_invalid");
            }
            return Create(requestId, resource, deadlineUtcMsc, delegate(TerminalWireWriter writer)
            {
                writer.WriteInt64(rangeStartUtcMsc);
                writer.WriteInt64(rangeEndUtcMsc);
                writer.WriteInt32(limit);
                writer.WriteInt64(cursor);
            });
        }

        private static byte[] Create(string requestId, TerminalResourceCode resource, long deadlineUtcMsc, Action<TerminalWireWriter> writeParameters)
        {
            if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 191
                || !Enum.IsDefined(typeof(TerminalResourceCode), resource)
                || deadlineUtcMsc < 1)
            {
                throw new ArgumentException("bridge_terminal_query_invalid");
            }
            TerminalWireWriter writer = new TerminalWireWriter();
            writer.WriteInt32((int)TerminalWireMessageType.QueryRequest);
            writer.WriteString(requestId);
            writer.WriteInt32((int)resource);
            writer.WriteInt64(deadlineUtcMsc);
            if (writeParameters != null)
            {
                writeParameters(writer);
            }
            return writer.ToArray();
        }

        private static void ValidatePage(int limit, int offset)
        {
            if (limit < 1 || limit > 500 || offset < 0)
            {
                throw new ArgumentException("bridge_terminal_page_invalid");
            }
        }

        private static void ValidateSymbol(string symbol)
        {
            if (string.IsNullOrWhiteSpace(symbol) || symbol.Length > 64 || symbol.IndexOf('\r') >= 0 || symbol.IndexOf('\n') >= 0)
            {
                throw new ArgumentException("bridge_terminal_symbol_invalid", "symbol");
            }
        }
    }

    public sealed class TerminalQueryResult
    {
        private static readonly HashSet<string> ClockStatuses = new HashSet<string>(StringComparer.Ordinal)
        {
            "calibrated", "observer_bootstrap", "stale", "unavailable"
        };

        private TerminalQueryResult()
        {
        }

        public bool Succeeded { get; private set; }
        public string RequestId { get; private set; }
        public TerminalResourceCode Resource { get; private set; }
        public long ObservedAtUtcMsc { get; private set; }
        public int ServerOffsetMinutes { get; private set; }
        public string ClockStatus { get; private set; }
        public string DataJson { get; private set; }
        public string NextCursor { get; private set; }
        public bool HasMore { get; private set; }
        public string ErrorCode { get; private set; }
        public string ErrorMessage { get; private set; }

        internal static TerminalQueryResult FromAdapterSuccess(string requestId, TerminalResourceCode resource,
            long observedAtUtcMsc, int serverOffsetMinutes, string clockStatus, string dataJson,
            string nextCursor, bool hasMore)
        {
            TerminalWireWriter writer = new TerminalWireWriter();
            writer.WriteInt32((int)TerminalWireMessageType.QueryResponse);
            writer.WriteString(requestId);
            writer.WriteInt32((int)resource);
            writer.WriteInt64(observedAtUtcMsc);
            writer.WriteInt32(serverOffsetMinutes);
            writer.WriteString(clockStatus);
            writer.WriteString(dataJson);
            writer.WriteString(nextCursor ?? string.Empty);
            writer.WriteInt32(hasMore ? 1 : 0);
            return Parse(writer.ToArray());
        }

        internal static TerminalQueryResult FromAdapterError(string requestId, TerminalResourceCode resource,
            string errorCode, string errorMessage)
        {
            TerminalWireWriter writer = new TerminalWireWriter();
            writer.WriteInt32((int)TerminalWireMessageType.QueryError);
            writer.WriteString(requestId);
            writer.WriteInt32((int)resource);
            writer.WriteString(errorCode);
            writer.WriteString(errorMessage);
            return Parse(writer.ToArray());
        }

        public static TerminalQueryResult Parse(byte[] payload)
        {
            TerminalWireReader reader = new TerminalWireReader(payload);
            TerminalWireMessageType messageType = (TerminalWireMessageType)reader.ReadInt32();
            if (messageType == TerminalWireMessageType.QueryError)
            {
                TerminalQueryResult failed = new TerminalQueryResult();
                failed.Succeeded = false;
                failed.RequestId = reader.ReadString(191);
                failed.Resource = ReadResource(reader);
                failed.ErrorCode = reader.ReadString(128);
                failed.ErrorMessage = reader.ReadString(512);
                reader.EnsureEnd();
                return failed;
            }
            if (messageType != TerminalWireMessageType.QueryResponse)
            {
                throw new InvalidDataException("bridge_terminal_response_type_invalid");
            }

            TerminalQueryResult result = new TerminalQueryResult();
            result.Succeeded = true;
            result.RequestId = reader.ReadString(191);
            result.Resource = ReadResource(reader);
            result.ObservedAtUtcMsc = reader.ReadInt64();
            result.ServerOffsetMinutes = reader.ReadInt32();
            result.ClockStatus = reader.ReadString(32);
            result.DataJson = reader.ReadString(PipeFrameCodec.MaximumPayloadBytes);
            result.NextCursor = reader.ReadString(2048);
            result.HasMore = reader.ReadBooleanInt32();
            reader.EnsureEnd();

            if (result.ObservedAtUtcMsc < 1
                || result.ServerOffsetMinutes < -840 || result.ServerOffsetMinutes > 840
                || !ClockStatuses.Contains(result.ClockStatus)
                || result.DataJson.Length == 0)
            {
                throw new InvalidDataException("bridge_terminal_response_invalid");
            }
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = PipeFrameCodec.MaximumPayloadBytes;
                if ((serializer.DeserializeObject(result.DataJson) as IDictionary<string, object>) == null)
                {
                    throw new InvalidDataException("bridge_terminal_response_json_invalid");
                }
            }
            catch (ArgumentException)
            {
                throw new InvalidDataException("bridge_terminal_response_json_invalid");
            }
            catch (InvalidOperationException)
            {
                throw new InvalidDataException("bridge_terminal_response_json_invalid");
            }
            return result;
        }

        private static TerminalResourceCode ReadResource(TerminalWireReader reader)
        {
            TerminalResourceCode resource = (TerminalResourceCode)reader.ReadInt32();
            if (!Enum.IsDefined(typeof(TerminalResourceCode), resource))
            {
                throw new InvalidDataException("bridge_terminal_resource_invalid");
            }
            return resource;
        }
    }

    public sealed class TerminalWireWriter
    {
        private readonly MemoryStream stream = new MemoryStream();
        private readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);

        public void WriteInt32(int value)
        {
            byte[] bytes = BitConverter.GetBytes(value);
            stream.Write(bytes, 0, bytes.Length);
        }

        public void WriteInt64(long value)
        {
            byte[] bytes = BitConverter.GetBytes(value);
            stream.Write(bytes, 0, bytes.Length);
        }

        public void WriteString(string value)
        {
            byte[] bytes = utf8.GetBytes(value ?? string.Empty);
            if (bytes.Length > PipeFrameCodec.MaximumPayloadBytes)
            {
                throw new InvalidDataException("bridge_terminal_string_too_large");
            }
            WriteInt32(bytes.Length);
            stream.Write(bytes, 0, bytes.Length);
        }

        public byte[] ToArray()
        {
            byte[] payload = stream.ToArray();
            if (payload.Length == 0 || payload.Length > PipeFrameCodec.MaximumPayloadBytes)
            {
                throw new InvalidDataException("bridge_terminal_wire_payload_size_invalid");
            }
            return payload;
        }
    }

    public sealed class TerminalWireReader
    {
        private readonly byte[] payload;
        private readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
        private int offset;

        public TerminalWireReader(byte[] payloadValue)
        {
            if (payloadValue == null || payloadValue.Length == 0 || payloadValue.Length > PipeFrameCodec.MaximumPayloadBytes)
            {
                throw new InvalidDataException("bridge_terminal_wire_payload_size_invalid");
            }
            payload = payloadValue;
        }

        public int ReadInt32()
        {
            EnsureAvailable(4);
            int value = BitConverter.ToInt32(payload, offset);
            offset += 4;
            return value;
        }

        public long ReadInt64()
        {
            EnsureAvailable(8);
            long value = BitConverter.ToInt64(payload, offset);
            offset += 8;
            return value;
        }

        public bool ReadBooleanInt32()
        {
            int value = ReadInt32();
            if (value != 0 && value != 1)
            {
                throw new InvalidDataException("bridge_terminal_boolean_invalid");
            }
            return value == 1;
        }

        public string ReadString(int maximumBytes)
        {
            int length = ReadInt32();
            if (length < 0 || length > maximumBytes)
            {
                throw new InvalidDataException("bridge_terminal_string_size_invalid");
            }
            EnsureAvailable(length);
            string value;
            try
            {
                value = utf8.GetString(payload, offset, length);
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("bridge_terminal_string_utf8_invalid");
            }
            offset += length;
            return value;
        }

        public void ExpectMessageType(TerminalWireMessageType expected)
        {
            if (ReadInt32() != (int)expected)
            {
                throw new InvalidDataException("bridge_terminal_message_type_invalid");
            }
        }

        public void EnsureEnd()
        {
            if (offset != payload.Length)
            {
                throw new InvalidDataException("bridge_terminal_wire_trailing_bytes");
            }
        }

        private void EnsureAvailable(int count)
        {
            if (count < 0 || offset > payload.Length - count)
            {
                throw new EndOfStreamException("bridge_terminal_wire_truncated");
            }
        }
    }
}
