using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using AurumBridge.Protocol;

namespace AurumBridge.Workers;

public enum Mt4MessageType
{
    Hello = 1,
    Welcome = 2,
    Collect = 10,
    Snapshot = 11,
    QuoteRequest = 12,
    Quote = 13,
    Command = 20,
    CommandResult = 21,
    Shutdown = 90,
    ShutdownAck = 91,
}

[Flags]
public enum Mt4CollectionStreams
{
    None = 0,
    Account = 1,
    Positions = 2,
    Orders = 4,
    All = Account | Positions | Orders,
}

public sealed record Mt4Hello(
    int ProtocolVersion,
    string AdapterVersion,
    string TerminalDataPath,
    string BrokerServer,
    string Login,
    bool Connected,
    bool TradeAllowed);

public sealed record Mt4Welcome(
    string TerminalInstanceId,
    long ConnectionEpoch,
    string ReconnectPipeName);

public sealed record Mt4Snapshot(
    long ObservedAtUtcMsc,
    JsonElement Account,
    IReadOnlyList<JsonElement> Positions,
    IReadOnlyList<JsonElement> Orders);

public sealed record Mt4QuoteRequest(
    string RequestId,
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    string Symbol);

public sealed record Mt4Quote(
    string RequestId,
    string Symbol,
    long ObservedAtUtcMsc,
    string Status,
    double? Bid,
    double? Ask,
    string? ErrorCode);

public enum Mt4TradeAction
{
    PlaceOrder = 1,
    CancelOrder = 2,
    ModifyOrder = 3,
    ClosePosition = 4,
    QueryExecution = 5,
}

public enum Mt4OrderSide
{
    None = 0,
    Buy = 1,
    Sell = 2,
}

public enum Mt4OrderKind
{
    None = 0,
    Market = 1,
    Limit = 2,
    Stop = 3,
}

public sealed record Mt4TradeCommand(
    string CommandId,
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    long DeadlineUtcMsc,
    Mt4TradeAction Action,
    string Symbol,
    Mt4OrderSide Side,
    Mt4OrderKind OrderKind,
    long Ticket,
    double Volume,
    double? Price,
    double? StopLoss,
    double? TakeProfit,
    int Deviation,
    int Magic,
    long Expiration);

public sealed record Mt4TradeResult(
    string CommandId,
    string Status,
    string? ErrorCode,
    string? ErrorMessage,
    int BrokerRetcode,
    long Ticket,
    long ObservedAtUtcMsc);

public static class Mt4PipeProtocol
{
    public const int MaxFrameBytes = 4 * 1024 * 1024;
    private const int MaxStringBytes = 2 * 1024 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static byte[] EncodeHello(Mt4Hello hello)
    {
        ArgumentNullException.ThrowIfNull(hello);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Hello);
            writer.Write(hello.ProtocolVersion);
            WriteString(writer, hello.AdapterVersion);
            WriteString(writer, hello.TerminalDataPath);
            WriteString(writer, hello.BrokerServer);
            WriteString(writer, hello.Login);
            writer.Write(hello.Connected ? 1 : 0);
            writer.Write(hello.TradeAllowed ? 1 : 0);
        });
    }

    public static Mt4Hello DecodeHello(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Hello);
        var result = new Mt4Hello(
            reader.ReadInt32(),
            ReadString(reader, 64),
            ReadString(reader, 32_768),
            ReadString(reader, 128),
            ReadString(reader, 64),
            ReadBoolean(reader),
            ReadBoolean(reader));
        EnsureFullyRead(reader);
        if (result.ProtocolVersion != 3
            || string.IsNullOrWhiteSpace(result.TerminalDataPath)
            || string.IsNullOrWhiteSpace(result.BrokerServer)
            || string.IsNullOrWhiteSpace(result.Login))
        {
            throw new InvalidDataException("mt4_hello_invalid");
        }
        return result;
    }

    public static byte[] EncodeWelcome(Mt4Welcome welcome)
    {
        ArgumentNullException.ThrowIfNull(welcome);
        if (welcome.ConnectionEpoch <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(welcome));
        }
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Welcome);
            WriteString(writer, welcome.TerminalInstanceId);
            writer.Write(welcome.ConnectionEpoch);
            WriteString(writer, welcome.ReconnectPipeName);
        });
    }

    public static Mt4Welcome DecodeWelcome(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Welcome);
        var result = new Mt4Welcome(
            ReadString(reader, 128),
            reader.ReadInt64(),
            ReadString(reader, 128));
        EnsureFullyRead(reader);
        if (string.IsNullOrWhiteSpace(result.TerminalInstanceId)
            || result.ConnectionEpoch <= 0
            || string.IsNullOrWhiteSpace(result.ReconnectPipeName))
        {
            throw new InvalidDataException("mt4_welcome_invalid");
        }
        return result;
    }

    public static byte[] EncodeCollect(Mt4CollectionStreams streams) => Encode(writer =>
    {
        writer.Write((int)Mt4MessageType.Collect);
        writer.Write((int)streams);
    });

    public static Mt4CollectionStreams DecodeCollect(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Collect);
        var streams = (Mt4CollectionStreams)reader.ReadInt32();
        EnsureFullyRead(reader);
        if ((streams & ~Mt4CollectionStreams.All) != 0)
        {
            throw new InvalidDataException("mt4_collect_streams_invalid");
        }
        return streams;
    }

    public static byte[] EncodeSnapshot(Mt4Snapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        if (snapshot.ObservedAtUtcMsc <= 0
            || snapshot.Account.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("mt4_snapshot_invalid");
        }
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Snapshot);
            writer.Write(snapshot.ObservedAtUtcMsc);
            WriteString(writer, snapshot.Account.GetRawText());
            WriteString(writer, JsonSerializer.Serialize(snapshot.Positions));
            WriteString(writer, JsonSerializer.Serialize(snapshot.Orders));
        });
    }

    public static Mt4Snapshot DecodeSnapshot(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Snapshot);
        var observedAt = reader.ReadInt64();
        var account = ParseObject(ReadString(reader, MaxStringBytes), "mt4_account_snapshot_invalid");
        var positions = ParseArray(ReadString(reader, MaxStringBytes), "mt4_positions_snapshot_invalid");
        var orders = ParseArray(ReadString(reader, MaxStringBytes), "mt4_orders_snapshot_invalid");
        EnsureFullyRead(reader);
        if (observedAt <= 0)
        {
            throw new InvalidDataException("mt4_snapshot_time_invalid");
        }
        return new(observedAt, account, positions, orders);
    }

    public static Mt4QuoteRequest CreateQuoteRequest(QuoteRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var local = new Mt4QuoteRequest(
            request.RequestId,
            request.TerminalInstanceId,
            request.AccountRef.BrokerServer,
            request.AccountRef.Login,
            request.ConnectionEpoch,
            request.Symbol);
        ValidateQuoteRequest(local);
        return local;
    }

    public static byte[] EncodeQuoteRequest(Mt4QuoteRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateQuoteRequest(request);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.QuoteRequest);
            WriteString(writer, request.RequestId);
            WriteString(writer, request.TerminalInstanceId);
            WriteString(writer, request.BrokerServer);
            WriteString(writer, request.Login);
            writer.Write(request.ConnectionEpoch);
            WriteString(writer, request.Symbol);
        });
    }

    public static Mt4QuoteRequest DecodeQuoteRequest(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.QuoteRequest);
        var request = new Mt4QuoteRequest(
            ReadString(reader, 128),
            ReadString(reader, 128),
            ReadString(reader, 128),
            ReadString(reader, 64),
            reader.ReadInt64(),
            ReadString(reader, 64));
        EnsureFullyRead(reader);
        ValidateQuoteRequest(request);
        return request;
    }

    public static byte[] EncodeQuote(Mt4Quote quote)
    {
        ArgumentNullException.ThrowIfNull(quote);
        ValidateQuote(quote);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Quote);
            WriteString(writer, quote.RequestId);
            WriteString(writer, quote.Symbol);
            writer.Write(quote.ObservedAtUtcMsc);
            writer.Write(quote.Status == "succeeded" ? 1 : 2);
            WriteNullableDouble(writer, quote.Bid);
            WriteNullableDouble(writer, quote.Ask);
            WriteString(writer, quote.ErrorCode ?? string.Empty);
        });
    }

    public static Mt4Quote DecodeQuote(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Quote);
        var requestId = ReadString(reader, 128);
        var symbol = ReadString(reader, 64);
        var observedAt = reader.ReadInt64();
        var status = reader.ReadInt32() switch
        {
            1 => "succeeded",
            2 => "rejected",
            _ => throw new InvalidDataException("mt4_quote_status_invalid"),
        };
        var quote = new Mt4Quote(
            requestId,
            symbol,
            observedAt,
            status,
            ReadDoubleString(reader, required: false),
            ReadDoubleString(reader, required: false),
            NullIfEmpty(ReadString(reader, 128)));
        EnsureFullyRead(reader);
        ValidateQuote(quote);
        return quote;
    }

    public static Mt4TradeCommand CreateTradeCommand(CommandMessage command)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (command.Version != 3 || command.Type != "command")
        {
            throw new InvalidDataException("mt4_command_envelope_invalid");
        }
        var action = command.Action switch
        {
            "place_order" => Mt4TradeAction.PlaceOrder,
            "cancel_order" => Mt4TradeAction.CancelOrder,
            "modify_order" => Mt4TradeAction.ModifyOrder,
            "close_position" => Mt4TradeAction.ClosePosition,
            "query_execution" => Mt4TradeAction.QueryExecution,
            _ => throw new InvalidDataException("command_action_unsupported"),
        };
        var symbol = ReadOptionalString(command.Params, "symbol") ?? string.Empty;
        var side = (ReadOptionalString(command.Params, "side") ?? string.Empty).ToLowerInvariant() switch
        {
            "" => Mt4OrderSide.None,
            "buy" => Mt4OrderSide.Buy,
            "sell" => Mt4OrderSide.Sell,
            _ => throw new InvalidDataException("order_side_invalid"),
        };
        var orderKind = (ReadOptionalString(command.Params, "order_kind") ?? "market").ToLowerInvariant() switch
        {
            "market" => Mt4OrderKind.Market,
            "limit" => Mt4OrderKind.Limit,
            "stop" => Mt4OrderKind.Stop,
            "stop_limit" => throw new InvalidDataException("mt4_stop_limit_unsupported"),
            _ => throw new InvalidDataException("order_kind_invalid"),
        };
        var tradeCommand = new Mt4TradeCommand(
            command.CommandId,
            command.TerminalInstanceId,
            command.AccountRef.BrokerServer,
            command.AccountRef.Login,
            command.ConnectionEpoch,
            command.DeadlineUtcMsc,
            action,
            symbol,
            side,
            orderKind,
            ReadOptionalInt64(command.Params, "ticket") ?? 0,
            ReadOptionalDouble(command.Params, "volume") ?? 0,
            ReadOptionalDouble(command.Params, "price"),
            ReadOptionalDouble(command.Params, "stop_loss"),
            ReadOptionalDouble(command.Params, "take_profit"),
            checked((int)(ReadOptionalInt64(command.Params, "deviation") ?? 20)),
            checked((int)(ReadOptionalInt64(command.Params, "magic") ?? 234000)),
            ReadOptionalInt64(command.Params, "expiration") ?? 0);
        ValidateTradeCommand(tradeCommand);
        return tradeCommand;
    }

    public static byte[] EncodeCommand(Mt4TradeCommand command)
    {
        ArgumentNullException.ThrowIfNull(command);
        ValidateTradeCommand(command);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Command);
            WriteString(writer, command.CommandId);
            WriteString(writer, command.TerminalInstanceId);
            WriteString(writer, command.BrokerServer);
            WriteString(writer, command.Login);
            writer.Write(command.ConnectionEpoch);
            writer.Write(command.DeadlineUtcMsc);
            writer.Write((int)command.Action);
            WriteString(writer, command.Symbol);
            writer.Write((int)command.Side);
            writer.Write((int)command.OrderKind);
            writer.Write(command.Ticket);
            WriteString(writer, command.Volume.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            WriteNullableDouble(writer, command.Price);
            WriteNullableDouble(writer, command.StopLoss);
            WriteNullableDouble(writer, command.TakeProfit);
            writer.Write(command.Deviation);
            writer.Write(command.Magic);
            writer.Write(command.Expiration);
        });
    }

    public static Mt4TradeCommand DecodeCommand(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Command);
        var command = new Mt4TradeCommand(
            ReadString(reader, 128),
            ReadString(reader, 128),
            ReadString(reader, 128),
            ReadString(reader, 64),
            reader.ReadInt64(),
            reader.ReadInt64(),
            (Mt4TradeAction)reader.ReadInt32(),
            ReadString(reader, 64),
            (Mt4OrderSide)reader.ReadInt32(),
            (Mt4OrderKind)reader.ReadInt32(),
            reader.ReadInt64(),
            ReadDoubleString(reader, required: true)!.Value,
            ReadDoubleString(reader, required: false),
            ReadDoubleString(reader, required: false),
            ReadDoubleString(reader, required: false),
            reader.ReadInt32(),
            reader.ReadInt32(),
            reader.ReadInt64());
        EnsureFullyRead(reader);
        ValidateTradeCommand(command);
        return command;
    }

    public static byte[] EncodeCommandResult(Mt4TradeResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        if (string.IsNullOrWhiteSpace(result.CommandId) || result.ObservedAtUtcMsc <= 0)
        {
            throw new InvalidDataException("mt4_command_result_invalid");
        }
        var status = result.Status switch
        {
            "succeeded" => 1,
            "rejected" => 2,
            "uncertain" => 3,
            _ => throw new InvalidDataException("mt4_command_result_status_invalid"),
        };
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.CommandResult);
            WriteString(writer, result.CommandId);
            writer.Write(status);
            WriteString(writer, result.ErrorCode ?? string.Empty);
            WriteString(writer, result.ErrorMessage ?? string.Empty);
            writer.Write(result.BrokerRetcode);
            writer.Write(result.Ticket);
            writer.Write(result.ObservedAtUtcMsc);
        });
    }

    public static Mt4TradeResult DecodeCommandResult(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.CommandResult);
        var commandId = ReadString(reader, 128);
        var status = reader.ReadInt32() switch
        {
            1 => "succeeded",
            2 => "rejected",
            3 => "uncertain",
            _ => throw new InvalidDataException("mt4_command_result_status_invalid"),
        };
        var errorCode = NullIfEmpty(ReadString(reader, 128));
        var errorMessage = NullIfEmpty(ReadString(reader, 1_024));
        var result = new Mt4TradeResult(
            commandId,
            status,
            errorCode,
            errorMessage,
            reader.ReadInt32(),
            reader.ReadInt64(),
            reader.ReadInt64());
        EnsureFullyRead(reader);
        if (string.IsNullOrWhiteSpace(result.CommandId) || result.ObservedAtUtcMsc <= 0)
        {
            throw new InvalidDataException("mt4_command_result_invalid");
        }
        return result;
    }

    public static async Task WriteFrameAsync(
        Stream stream,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (payload.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static async Task<byte[]> ReadFrameAsync(
        Stream stream,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var header = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, header, cancellationToken);
        var size = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (size is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        var payload = new byte[size];
        await ReadExactlyAsync(stream, payload, cancellationToken);
        return payload;
    }

    private static byte[] Encode(Action<BinaryWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, StrictUtf8, leaveOpen: true))
        {
            write(writer);
        }
        if (stream.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        return stream.ToArray();
    }

    private static BinaryReader CreateReader(ReadOnlySpan<byte> payload, Mt4MessageType expectedType)
    {
        if (payload.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        var reader = new BinaryReader(new MemoryStream(payload.ToArray(), writable: false), StrictUtf8);
        if (reader.ReadInt32() != (int)expectedType)
        {
            reader.Dispose();
            throw new InvalidDataException("mt4_pipe_message_type_invalid");
        }
        return reader;
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        var bytes = StrictUtf8.GetBytes(value ?? string.Empty);
        if (bytes.Length > MaxStringBytes)
        {
            throw new InvalidDataException("mt4_pipe_string_too_large");
        }
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }

    private static void WriteNullableDouble(BinaryWriter writer, double? value)
    {
        WriteString(
            writer,
            value?.ToString("R", System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty);
    }

    private static string ReadString(BinaryReader reader, int limit)
    {
        var length = reader.ReadInt32();
        if (length < 0 || length > limit || length > reader.BaseStream.Length - reader.BaseStream.Position)
        {
            throw new InvalidDataException("mt4_pipe_string_size_invalid");
        }
        return StrictUtf8.GetString(reader.ReadBytes(length));
    }

    private static bool ReadBoolean(BinaryReader reader) => reader.ReadInt32() switch
    {
        0 => false,
        1 => true,
        _ => throw new InvalidDataException("mt4_pipe_boolean_invalid"),
    };

    private static JsonElement ParseObject(string json, string errorCode)
    {
        try
        {
            var value = JsonSerializer.Deserialize<JsonElement>(json);
            return value.ValueKind == JsonValueKind.Object
                ? value
                : throw new InvalidDataException(errorCode);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException(errorCode, error);
        }
    }

    private static IReadOnlyList<JsonElement> ParseArray(string json, string errorCode)
    {
        try
        {
            var value = JsonSerializer.Deserialize<JsonElement>(json);
            if (value.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException(errorCode);
            }
            return value.EnumerateArray().Select(item => item.Clone()).ToArray();
        }
        catch (JsonException error)
        {
            throw new InvalidDataException(errorCode, error);
        }
    }

    private static void EnsureFullyRead(BinaryReader reader)
    {
        if (reader.BaseStream.Position != reader.BaseStream.Length)
        {
            throw new InvalidDataException("mt4_pipe_trailing_data");
        }
    }

    private static void ValidateTradeCommand(Mt4TradeCommand command)
    {
        if (string.IsNullOrWhiteSpace(command.CommandId)
            || string.IsNullOrWhiteSpace(command.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(command.BrokerServer)
            || string.IsNullOrWhiteSpace(command.Login)
            || command.ConnectionEpoch <= 0
            || command.DeadlineUtcMsc <= 0
            || command.Deviation < 0
            || !Enum.IsDefined(command.Action)
            || !Enum.IsDefined(command.Side)
            || !Enum.IsDefined(command.OrderKind))
        {
            throw new InvalidDataException("mt4_command_route_invalid");
        }
        if (command.Action == Mt4TradeAction.PlaceOrder
            && (string.IsNullOrWhiteSpace(command.Symbol)
                || command.Side == Mt4OrderSide.None
                || command.OrderKind == Mt4OrderKind.None
                || command.Volume <= 0))
        {
            throw new InvalidDataException("mt4_place_order_params_invalid");
        }
        if (command.Action is Mt4TradeAction.CancelOrder
                or Mt4TradeAction.ModifyOrder
                or Mt4TradeAction.ClosePosition
                or Mt4TradeAction.QueryExecution
            && command.Ticket <= 0)
        {
            throw new InvalidDataException("ticket_required");
        }
        if (command.Action == Mt4TradeAction.ClosePosition && command.Volume < 0)
        {
            throw new InvalidDataException("close_volume_invalid");
        }
    }

    private static void ValidateQuoteRequest(Mt4QuoteRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(request.BrokerServer)
            || string.IsNullOrWhiteSpace(request.Login)
            || request.ConnectionEpoch <= 0
            || string.IsNullOrWhiteSpace(request.Symbol)
            || request.Symbol != request.Symbol.Trim()
            || request.Symbol.Length > 64)
        {
            throw new InvalidDataException("mt4_quote_request_invalid");
        }
    }

    private static void ValidateQuote(Mt4Quote quote)
    {
        if (string.IsNullOrWhiteSpace(quote.RequestId)
            || string.IsNullOrWhiteSpace(quote.Symbol)
            || quote.ObservedAtUtcMsc <= 0
            || quote.Status is not ("succeeded" or "rejected"))
        {
            throw new InvalidDataException("mt4_quote_invalid");
        }
        if (quote.Status == "succeeded"
            && (quote.Bid is null || quote.Ask is null
                || !double.IsFinite(quote.Bid.Value) || quote.Bid.Value <= 0
                || !double.IsFinite(quote.Ask.Value) || quote.Ask.Value <= 0
                || quote.Ask.Value < quote.Bid.Value))
        {
            throw new InvalidDataException("mt4_quote_price_invalid");
        }
        if (quote.Status == "rejected" && string.IsNullOrWhiteSpace(quote.ErrorCode))
        {
            throw new InvalidDataException("mt4_quote_error_missing");
        }
    }

    private static string? ReadOptionalString(JsonElement value, string propertyName)
    {
        if (!value.TryGetProperty(propertyName, out var property) || property.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        if (property.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException($"{propertyName}_invalid");
        }
        return property.GetString()?.Trim();
    }

    private static long? ReadOptionalInt64(JsonElement value, string propertyName)
    {
        if (!value.TryGetProperty(propertyName, out var property) || property.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out var number))
        {
            return number;
        }
        if (property.ValueKind == JsonValueKind.String && long.TryParse(
                property.GetString(),
                System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture,
                out number))
        {
            return number;
        }
        throw new InvalidDataException($"{propertyName}_invalid");
    }

    private static double? ReadOptionalDouble(JsonElement value, string propertyName)
    {
        if (!value.TryGetProperty(propertyName, out var property) || property.ValueKind == JsonValueKind.Null)
        {
            return null;
        }
        double number;
        if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out number)
            || property.ValueKind == JsonValueKind.String && double.TryParse(
                property.GetString(),
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out number))
        {
            return double.IsFinite(number) ? number : throw new InvalidDataException($"{propertyName}_invalid");
        }
        throw new InvalidDataException($"{propertyName}_invalid");
    }

    private static string? NullIfEmpty(string value) => string.IsNullOrEmpty(value) ? null : value;

    private static double? ReadDoubleString(BinaryReader reader, bool required)
    {
        var value = ReadString(reader, 64);
        if (string.IsNullOrEmpty(value))
        {
            return required ? throw new InvalidDataException("mt4_pipe_number_missing") : null;
        }
        if (!double.TryParse(
                value,
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out var number)
            || !double.IsFinite(number))
        {
            throw new InvalidDataException("mt4_pipe_number_invalid");
        }
        return number;
    }

    private static async Task ReadExactlyAsync(
        Stream stream,
        Memory<byte> buffer,
        CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], cancellationToken);
            if (read == 0)
            {
                throw new EndOfStreamException("mt4_pipe_closed");
            }
            offset += read;
        }
    }
}
