using System.Buffers.Binary;
using System.Globalization;
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
    RatesRequest = 14,
    Rates = 15,
    SymbolSnapshotRequest = 16,
    SymbolSnapshot = 17,
    RiskSnapshotRequest = 18,
    RiskSnapshot = 19,
    Command = 20,
    CommandResult = 21,
    PerformanceDailyRequest = 22,
    PerformanceDaily = 23,
    DealsRequest = 24,
    Deals = 25,
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
    long SourceTimeMsc,
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

public sealed record Mt4RatesRequest(
    string RequestId,
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    string Symbol,
    string Timeframe,
    int Count,
    long StartUtcMsc,
    long EndUtcMsc);

public sealed record Mt4Rates(
    string RequestId,
    long ObservedAtUtcMsc,
    string Status,
    JsonElement? Payload,
    string? ErrorCode);

public sealed record Mt4SymbolSnapshotRequest(
    string RequestId,
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    string Symbol);

public sealed record Mt4SymbolSnapshot(
    string RequestId,
    long ObservedAtUtcMsc,
    string Status,
    JsonElement? Payload,
    string? ErrorCode);

public sealed record Mt4RiskSnapshotRequest(
    string RequestId,
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    string Symbol,
    long LastDealTimeMsc,
    long LastDealTicket,
    long BaselineFromUtcMsc,
    string ProposedSymbol,
    string ProposedOrderType,
    double? ProposedVolume,
    double? ProposedEntryPrice,
    double? ProposedStopLoss);

public sealed record Mt4RiskSnapshot(
    string RequestId,
    long ObservedAtUtcMsc,
    string Status,
    JsonElement? Payload,
    string? ErrorCode);

public sealed record Mt4PerformanceDailyRequest(
    string RequestId,
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    string DateFrom,
    string DateTo);

public sealed record Mt4PerformanceDaily(
    string RequestId,
    long ObservedAtUtcMsc,
    string Status,
    JsonElement? Payload,
    string? ErrorCode);

public sealed record Mt4DealsRequest(
    string TerminalInstanceId,
    string BrokerServer,
    string Login,
    long ConnectionEpoch,
    long CursorTimeMsc,
    long CursorTicket,
    int Limit);

public sealed record Mt4DealsBatch(
    long SourceTimeMsc,
    IReadOnlyList<JsonElement> Items,
    long NextTimeMsc,
    long NextTicket,
    bool HasMore);

public enum Mt4TradeAction
{
    PlaceOrder = 1,
    CancelOrder = 2,
    ModifyOrder = 3,
    ClosePosition = 4,
    QueryExecution = 5,
    ModifyPosition = 6,
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
    long Expiration,
    double? ExpectedStopLoss,
    double? ExpectedTakeProfit,
    string Comment,
    string ExpectedKind,
    string BridgeCommandRef);

public sealed record Mt4TradeResult(
    string CommandId,
    string Status,
    string? ErrorCode,
    string? ErrorMessage,
    int BrokerRetcode,
    long Ticket,
    long ObservedAtUtcMsc,
    JsonElement? RawResult = null);

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
        if (snapshot.SourceTimeMsc <= 0
            || snapshot.Account.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("mt4_snapshot_invalid");
        }
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Snapshot);
            writer.Write(snapshot.SourceTimeMsc);
            WriteString(writer, snapshot.Account.GetRawText());
            WriteString(writer, JsonSerializer.Serialize(snapshot.Positions));
            WriteString(writer, JsonSerializer.Serialize(snapshot.Orders));
        });
    }

    public static Mt4Snapshot DecodeSnapshot(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Snapshot);
        var sourceTimeMsc = reader.ReadInt64();
        var account = ParseObject(ReadString(reader, MaxStringBytes), "mt4_account_snapshot_invalid");
        var positions = ParseArray(ReadString(reader, MaxStringBytes), "mt4_positions_snapshot_invalid");
        var orders = ParseArray(ReadString(reader, MaxStringBytes), "mt4_orders_snapshot_invalid");
        EnsureFullyRead(reader);
        if (sourceTimeMsc <= 0)
        {
            throw new InvalidDataException("mt4_snapshot_time_invalid");
        }
        return new(sourceTimeMsc, account, positions, orders);
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

    public static Mt4RatesRequest CreateRatesRequest(DataRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Version != 3 || request.Type != "data_request" || request.Action != "rates")
        {
            throw new InvalidDataException("mt4_rates_request_invalid");
        }
        var result = new Mt4RatesRequest(
            request.RequestId, request.TerminalInstanceId, request.AccountRef.BrokerServer,
            request.AccountRef.Login, request.ConnectionEpoch,
            ReadOptionalString(request.Params, "symbol") ?? string.Empty,
            (ReadOptionalString(request.Params, "timeframe") ?? "M30").ToUpperInvariant(),
            checked((int)(ReadOptionalInt64(request.Params, "count") ?? 100)),
            ReadOptionalInt64(request.Params, "start_utc_msc") ?? 0,
            ReadOptionalInt64(request.Params, "end_utc_msc") ?? 0);
        ValidateRatesRequest(result);
        return result;
    }

    public static byte[] EncodeRatesRequest(Mt4RatesRequest request)
    {
        ValidateRatesRequest(request);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.RatesRequest);
            WriteString(writer, request.RequestId);
            WriteString(writer, request.TerminalInstanceId);
            WriteString(writer, request.BrokerServer);
            WriteString(writer, request.Login);
            writer.Write(request.ConnectionEpoch);
            WriteString(writer, request.Symbol);
            WriteString(writer, request.Timeframe);
            writer.Write(request.Count);
            writer.Write(request.StartUtcMsc);
            writer.Write(request.EndUtcMsc);
        });
    }

    public static Mt4RatesRequest DecodeRatesRequest(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.RatesRequest);
        var result = new Mt4RatesRequest(
            ReadString(reader, 128), ReadString(reader, 128), ReadString(reader, 128),
            ReadString(reader, 64), reader.ReadInt64(), ReadString(reader, 64),
            ReadString(reader, 16), reader.ReadInt32(), reader.ReadInt64(), reader.ReadInt64());
        EnsureFullyRead(reader);
        ValidateRatesRequest(result);
        return result;
    }

    public static byte[] EncodeRates(Mt4Rates result)
    {
        ValidateRates(result);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Rates);
            WriteString(writer, result.RequestId);
            writer.Write(result.ObservedAtUtcMsc);
            writer.Write(result.Status == "succeeded" ? 1 : 2);
            WriteString(writer, result.Payload?.GetRawText() ?? string.Empty);
            WriteString(writer, result.ErrorCode ?? string.Empty);
        });
    }

    public static Mt4Rates DecodeRates(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Rates);
        var requestId = ReadString(reader, 128);
        var observedAt = reader.ReadInt64();
        var status = reader.ReadInt32() switch
        {
            1 => "succeeded",
            2 => "rejected",
            _ => throw new InvalidDataException("mt4_rates_status_invalid"),
        };
        var payloadText = ReadString(reader, MaxStringBytes);
        var result = new Mt4Rates(requestId, observedAt, status,
            string.IsNullOrEmpty(payloadText) ? null : ParseObject(payloadText, "mt4_rates_payload_invalid"),
            NullIfEmpty(ReadString(reader, 128)));
        EnsureFullyRead(reader);
        ValidateRates(result);
        return result;
    }

    public static Mt4SymbolSnapshotRequest CreateSymbolSnapshotRequest(DataRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Version != 3 || request.Type != "data_request" || request.Action != "symbol_snapshot")
        {
            throw new InvalidDataException("mt4_symbol_snapshot_request_invalid");
        }
        var result = new Mt4SymbolSnapshotRequest(
            request.RequestId, request.TerminalInstanceId, request.AccountRef.BrokerServer,
            request.AccountRef.Login, request.ConnectionEpoch,
            ReadOptionalString(request.Params, "symbol") ?? string.Empty);
        ValidateSymbolSnapshotRequest(result);
        return result;
    }

    public static byte[] EncodeSymbolSnapshotRequest(Mt4SymbolSnapshotRequest request)
    {
        ValidateSymbolSnapshotRequest(request);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.SymbolSnapshotRequest);
            WriteString(writer, request.RequestId);
            WriteString(writer, request.TerminalInstanceId);
            WriteString(writer, request.BrokerServer);
            WriteString(writer, request.Login);
            writer.Write(request.ConnectionEpoch);
            WriteString(writer, request.Symbol);
        });
    }

    public static Mt4SymbolSnapshotRequest DecodeSymbolSnapshotRequest(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.SymbolSnapshotRequest);
        var result = new Mt4SymbolSnapshotRequest(
            ReadString(reader, 128), ReadString(reader, 128), ReadString(reader, 128),
            ReadString(reader, 64), reader.ReadInt64(), ReadString(reader, 64));
        EnsureFullyRead(reader);
        ValidateSymbolSnapshotRequest(result);
        return result;
    }

    public static byte[] EncodeSymbolSnapshot(Mt4SymbolSnapshot result)
    {
        ValidateSymbolSnapshot(result);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.SymbolSnapshot);
            WriteString(writer, result.RequestId);
            writer.Write(result.ObservedAtUtcMsc);
            writer.Write(result.Status == "succeeded" ? 1 : 2);
            WriteString(writer, result.Payload?.GetRawText() ?? string.Empty);
            WriteString(writer, result.ErrorCode ?? string.Empty);
        });
    }

    public static Mt4SymbolSnapshot DecodeSymbolSnapshot(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.SymbolSnapshot);
        var requestId = ReadString(reader, 128);
        var observedAt = reader.ReadInt64();
        var status = reader.ReadInt32() switch
        {
            1 => "succeeded", 2 => "rejected",
            _ => throw new InvalidDataException("mt4_symbol_snapshot_status_invalid"),
        };
        var payloadText = ReadString(reader, MaxStringBytes);
        var result = new Mt4SymbolSnapshot(requestId, observedAt, status,
            string.IsNullOrEmpty(payloadText) ? null : ParseObject(payloadText, "mt4_symbol_snapshot_payload_invalid"),
            NullIfEmpty(ReadString(reader, 128)));
        EnsureFullyRead(reader);
        ValidateSymbolSnapshot(result);
        return result;
    }

    public static Mt4RiskSnapshotRequest CreateRiskSnapshotRequest(DataRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Version != 3 || request.Type != "data_request" || request.Action != "risk_snapshot")
        {
            throw new InvalidDataException("mt4_risk_snapshot_request_invalid");
        }
        var hasProposedProperty = request.Params.TryGetProperty("proposed_order", out var value);
        if (hasProposedProperty && value.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null))
        {
            throw new InvalidDataException("mt4_risk_snapshot_request_invalid");
        }
        var proposed = hasProposedProperty && value.ValueKind == JsonValueKind.Object ? value : default;
        var result = new Mt4RiskSnapshotRequest(
            request.RequestId, request.TerminalInstanceId, request.AccountRef.BrokerServer,
            request.AccountRef.Login, request.ConnectionEpoch,
            ReadOptionalString(request.Params, "symbol") ?? string.Empty,
            ReadOptionalInt64(request.Params, "last_deal_time_msc") ?? 0,
            ReadOptionalInt64(request.Params, "last_deal_ticket") ?? 0,
            ReadOptionalInt64(request.Params, "baseline_from_utc_msc") ?? 0,
            proposed.ValueKind == JsonValueKind.Object ? ReadOptionalString(proposed, "symbol") ?? string.Empty : string.Empty,
            proposed.ValueKind == JsonValueKind.Object ? (ReadOptionalString(proposed, "order_type") ?? string.Empty).ToLowerInvariant() : string.Empty,
            proposed.ValueKind == JsonValueKind.Object ? ReadOptionalDouble(proposed, "volume") : null,
            proposed.ValueKind == JsonValueKind.Object ? ReadOptionalDouble(proposed, "entry_price") : null,
            proposed.ValueKind == JsonValueKind.Object ? ReadOptionalDouble(proposed, "sl") : null);
        ValidateRiskSnapshotRequest(result);
        return result;
    }

    public static byte[] EncodeRiskSnapshotRequest(Mt4RiskSnapshotRequest request)
    {
        ValidateRiskSnapshotRequest(request);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.RiskSnapshotRequest);
            WriteString(writer, request.RequestId); WriteString(writer, request.TerminalInstanceId);
            WriteString(writer, request.BrokerServer); WriteString(writer, request.Login);
            writer.Write(request.ConnectionEpoch); WriteString(writer, request.Symbol);
            writer.Write(request.LastDealTimeMsc); writer.Write(request.LastDealTicket);
            writer.Write(request.BaselineFromUtcMsc); WriteString(writer, request.ProposedSymbol);
            WriteString(writer, request.ProposedOrderType); WriteNullableDouble(writer, request.ProposedVolume);
            WriteNullableDouble(writer, request.ProposedEntryPrice); WriteNullableDouble(writer, request.ProposedStopLoss);
        });
    }

    public static Mt4RiskSnapshotRequest DecodeRiskSnapshotRequest(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.RiskSnapshotRequest);
        var result = new Mt4RiskSnapshotRequest(
            ReadString(reader, 128), ReadString(reader, 128), ReadString(reader, 128),
            ReadString(reader, 64), reader.ReadInt64(), ReadString(reader, 64),
            reader.ReadInt64(), reader.ReadInt64(), reader.ReadInt64(),
            ReadString(reader, 64), ReadString(reader, 32),
            ReadDoubleString(reader, false), ReadDoubleString(reader, false), ReadDoubleString(reader, false));
        EnsureFullyRead(reader);
        ValidateRiskSnapshotRequest(result);
        return result;
    }

    public static byte[] EncodeRiskSnapshot(Mt4RiskSnapshot result)
    {
        ValidateRiskSnapshot(result);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.RiskSnapshot); WriteString(writer, result.RequestId);
            writer.Write(result.ObservedAtUtcMsc); writer.Write(result.Status == "succeeded" ? 1 : 2);
            WriteString(writer, result.Payload?.GetRawText() ?? string.Empty);
            WriteString(writer, result.ErrorCode ?? string.Empty);
        });
    }

    public static Mt4RiskSnapshot DecodeRiskSnapshot(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.RiskSnapshot);
        var requestId = ReadString(reader, 128); var observedAt = reader.ReadInt64();
        var status = reader.ReadInt32() switch
        {
            1 => "succeeded", 2 => "rejected",
            _ => throw new InvalidDataException("mt4_risk_snapshot_status_invalid"),
        };
        var payloadText = ReadString(reader, MaxStringBytes);
        var result = new Mt4RiskSnapshot(requestId, observedAt, status,
            string.IsNullOrEmpty(payloadText) ? null : ParseObject(payloadText, "mt4_risk_snapshot_payload_invalid"),
            NullIfEmpty(ReadString(reader, 128)));
        EnsureFullyRead(reader); ValidateRiskSnapshot(result); return result;
    }

    public static Mt4PerformanceDailyRequest CreatePerformanceDailyRequest(DataRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Version != 3 || request.Type != "data_request" || request.Action != "performance_daily")
        {
            throw new InvalidDataException("mt4_performance_request_invalid");
        }
        var result = new Mt4PerformanceDailyRequest(
            request.RequestId, request.TerminalInstanceId, request.AccountRef.BrokerServer,
            request.AccountRef.Login, request.ConnectionEpoch,
            ReadOptionalString(request.Params, "date_from") ?? string.Empty,
            ReadOptionalString(request.Params, "date_to") ?? string.Empty);
        ValidatePerformanceDailyRequest(result);
        return result;
    }

    public static byte[] EncodePerformanceDailyRequest(Mt4PerformanceDailyRequest request)
    {
        ValidatePerformanceDailyRequest(request);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.PerformanceDailyRequest);
            WriteString(writer, request.RequestId); WriteString(writer, request.TerminalInstanceId);
            WriteString(writer, request.BrokerServer); WriteString(writer, request.Login);
            writer.Write(request.ConnectionEpoch); WriteString(writer, request.DateFrom);
            WriteString(writer, request.DateTo);
        });
    }

    public static Mt4PerformanceDailyRequest DecodePerformanceDailyRequest(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.PerformanceDailyRequest);
        var result = new Mt4PerformanceDailyRequest(
            ReadString(reader, 128), ReadString(reader, 128), ReadString(reader, 128),
            ReadString(reader, 64), reader.ReadInt64(), ReadString(reader, 10), ReadString(reader, 10));
        EnsureFullyRead(reader); ValidatePerformanceDailyRequest(result); return result;
    }

    public static byte[] EncodePerformanceDaily(Mt4PerformanceDaily result)
    {
        ValidatePerformanceDaily(result);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.PerformanceDaily); WriteString(writer, result.RequestId);
            writer.Write(result.ObservedAtUtcMsc); writer.Write(result.Status == "succeeded" ? 1 : 2);
            WriteString(writer, result.Payload?.GetRawText() ?? string.Empty);
            WriteString(writer, result.ErrorCode ?? string.Empty);
        });
    }

    public static Mt4PerformanceDaily DecodePerformanceDaily(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.PerformanceDaily);
        var requestId = ReadString(reader, 128); var observedAt = reader.ReadInt64();
        var status = reader.ReadInt32() switch
        {
            1 => "succeeded", 2 => "rejected",
            _ => throw new InvalidDataException("mt4_performance_status_invalid"),
        };
        var payloadText = ReadString(reader, MaxStringBytes);
        var result = new Mt4PerformanceDaily(requestId, observedAt, status,
            string.IsNullOrEmpty(payloadText) ? null : ParseObject(payloadText, "mt4_performance_payload_invalid"),
            NullIfEmpty(ReadString(reader, 128)));
        EnsureFullyRead(reader); ValidatePerformanceDaily(result); return result;
    }

    public static byte[] EncodeDealsRequest(Mt4DealsRequest request)
    {
        ValidateDealsRequest(request);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.DealsRequest);
            WriteString(writer, request.TerminalInstanceId);
            WriteString(writer, request.BrokerServer);
            WriteString(writer, request.Login);
            writer.Write(request.ConnectionEpoch);
            writer.Write(request.CursorTimeMsc);
            writer.Write(request.CursorTicket);
            writer.Write(request.Limit);
        });
    }

    public static Mt4DealsRequest DecodeDealsRequest(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.DealsRequest);
        var result = new Mt4DealsRequest(
            ReadString(reader, 128),
            ReadString(reader, 128),
            ReadString(reader, 64),
            reader.ReadInt64(),
            reader.ReadInt64(),
            reader.ReadInt64(),
            reader.ReadInt32());
        EnsureFullyRead(reader);
        ValidateDealsRequest(result);
        return result;
    }

    public static byte[] EncodeDeals(Mt4DealsBatch result)
    {
        ValidateDeals(result);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Deals);
            writer.Write(result.SourceTimeMsc);
            WriteString(writer, JsonSerializer.Serialize(result.Items, BridgeJson.Options));
            writer.Write(result.NextTimeMsc);
            writer.Write(result.NextTicket);
            writer.Write(result.HasMore ? 1 : 0);
        });
    }

    public static Mt4DealsBatch DecodeDeals(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Deals);
        var result = new Mt4DealsBatch(
            reader.ReadInt64(),
            ParseArray(ReadString(reader, MaxStringBytes), "mt4_deals_payload_invalid"),
            reader.ReadInt64(),
            reader.ReadInt64(),
            ReadBoolean(reader));
        EnsureFullyRead(reader);
        ValidateDeals(result);
        return result;
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
            "modify_position" => Mt4TradeAction.ModifyPosition,
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
            ReadOptionalInt64(command.Params, "ticket")
                ?? ReadOptionalInt64(command.Params, "pending_ticket")
                ?? ReadOptionalInt64(command.Params, "trade_ticket")
                ?? 0,
            ReadOptionalDouble(command.Params, "volume") ?? 0,
            ReadOptionalDouble(command.Params, "price"),
            ReadOptionalDouble(command.Params, "stop_loss"),
            ReadOptionalDouble(command.Params, "take_profit"),
            checked((int)(ReadOptionalInt64(command.Params, "deviation") ?? 20)),
            checked((int)(ReadOptionalInt64(command.Params, "magic") ?? 234000)),
            ReadOptionalInt64(command.Params, "expiration") ?? 0,
            ReadOptionalDouble(command.Params, "expected_stop_loss"),
            ReadOptionalDouble(command.Params, "expected_take_profit"),
            ReadOptionalString(command.Params, "comment") ?? string.Empty,
            (ReadOptionalString(command.Params, "expected_kind") ?? string.Empty).ToLowerInvariant(),
            ReadOptionalString(command.Params, "bridge_command_ref") ?? string.Empty);
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
            WriteNullableDouble(writer, command.ExpectedStopLoss);
            WriteNullableDouble(writer, command.ExpectedTakeProfit);
            WriteString(writer, command.Comment);
            WriteString(writer, command.ExpectedKind);
            WriteString(writer, command.BridgeCommandRef);
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
            reader.ReadInt64(),
            ReadDoubleString(reader, required: false),
            ReadDoubleString(reader, required: false),
            ReadString(reader, 64),
            ReadString(reader, 16),
            ReadString(reader, 64));
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
            WriteString(writer, result.RawResult?.GetRawText() ?? string.Empty);
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
        var brokerRetcode = reader.ReadInt32();
        var ticket = reader.ReadInt64();
        var observedAt = reader.ReadInt64();
        var rawResultText = ReadString(reader, MaxStringBytes);
        var result = new Mt4TradeResult(
            commandId,
            status,
            errorCode,
            errorMessage,
            brokerRetcode,
            ticket,
            observedAt,
            string.IsNullOrEmpty(rawResultText)
                ? null
                : ParseObject(rawResultText, "mt4_command_raw_result_invalid"));
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
                or Mt4TradeAction.ModifyPosition
                or Mt4TradeAction.ClosePosition
            && command.Ticket <= 0)
        {
            throw new InvalidDataException("ticket_required");
        }
        if (command.Action == Mt4TradeAction.QueryExecution
            && command.Ticket <= 0
            && string.IsNullOrWhiteSpace(command.BridgeCommandRef))
        {
            throw new InvalidDataException("bridge_reference_required");
        }
        if (command.Comment.Length > 64
            || command.BridgeCommandRef.Length > 64
            || command.ExpectedKind is not ("" or "trade" or "pending"))
        {
            throw new InvalidDataException("mt4_command_query_params_invalid");
        }
        if (command.Action == Mt4TradeAction.ClosePosition && command.Volume < 0)
        {
            throw new InvalidDataException("close_volume_invalid");
        }
        if (command.Action == Mt4TradeAction.ModifyPosition
            && (string.IsNullOrWhiteSpace(command.Symbol)
                || command.Side == Mt4OrderSide.None
                || command.Volume <= 0
                || command.StopLoss is null && command.TakeProfit is null))
        {
            throw new InvalidDataException("mt4_modify_position_params_invalid");
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

    private static void ValidateRatesRequest(Mt4RatesRequest request)
    {
        string[] timeframes = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
        if (string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(request.BrokerServer)
            || string.IsNullOrWhiteSpace(request.Login)
            || request.ConnectionEpoch <= 0
            || string.IsNullOrWhiteSpace(request.Symbol) || request.Symbol.Length > 64
            || !timeframes.Contains(request.Timeframe, StringComparer.Ordinal)
            || request.Count is < 2 or > 5_000
            || request.StartUtcMsc < 0 || request.EndUtcMsc < 0
            || (request.StartUtcMsc > 0 || request.EndUtcMsc > 0)
                && !(request.StartUtcMsc > 0 && request.EndUtcMsc > request.StartUtcMsc))
        {
            throw new InvalidDataException("mt4_rates_request_invalid");
        }
    }

    private static void ValidateRates(Mt4Rates result)
    {
        if (string.IsNullOrWhiteSpace(result.RequestId) || result.ObservedAtUtcMsc <= 0
            || result.Status is not ("succeeded" or "rejected")
            || result.Status == "succeeded" && result.Payload is null
            || result.Status == "rejected" && string.IsNullOrWhiteSpace(result.ErrorCode))
        {
            throw new InvalidDataException("mt4_rates_invalid");
        }
    }

    private static void ValidateSymbolSnapshotRequest(Mt4SymbolSnapshotRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(request.BrokerServer)
            || string.IsNullOrWhiteSpace(request.Login) || request.ConnectionEpoch <= 0
            || string.IsNullOrWhiteSpace(request.Symbol) || request.Symbol.Length > 64)
        {
            throw new InvalidDataException("mt4_symbol_snapshot_request_invalid");
        }
    }

    private static void ValidateSymbolSnapshot(Mt4SymbolSnapshot result)
    {
        if (string.IsNullOrWhiteSpace(result.RequestId) || result.ObservedAtUtcMsc <= 0
            || result.Status is not ("succeeded" or "rejected")
            || result.Status == "succeeded" && result.Payload is null
            || result.Status == "rejected" && string.IsNullOrWhiteSpace(result.ErrorCode))
        {
            throw new InvalidDataException("mt4_symbol_snapshot_invalid");
        }
    }

    private static void ValidateRiskSnapshotRequest(Mt4RiskSnapshotRequest request)
    {
        var hasProposed = !string.IsNullOrEmpty(request.ProposedSymbol)
            || !string.IsNullOrEmpty(request.ProposedOrderType)
            || request.ProposedVolume is not null || request.ProposedEntryPrice is not null
            || request.ProposedStopLoss is not null;
        string[] orderTypes = ["buy", "sell", "buy_limit", "sell_limit", "buy_stop", "sell_stop"];
        if (string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(request.BrokerServer) || string.IsNullOrWhiteSpace(request.Login)
            || request.ConnectionEpoch <= 0 || string.IsNullOrWhiteSpace(request.Symbol) || request.Symbol.Length > 64
            || request.LastDealTimeMsc < 0 || request.LastDealTicket < 0 || request.BaselineFromUtcMsc < 0
            || hasProposed && (string.IsNullOrWhiteSpace(request.ProposedSymbol) || request.ProposedSymbol.Length > 64
                || !orderTypes.Contains(request.ProposedOrderType, StringComparer.Ordinal)
                || request.ProposedVolume is null or <= 0
                || request.ProposedEntryPrice is null or <= 0 || request.ProposedStopLoss is null or <= 0))
        {
            throw new InvalidDataException("mt4_risk_snapshot_request_invalid");
        }
    }

    private static void ValidateRiskSnapshot(Mt4RiskSnapshot result)
    {
        if (string.IsNullOrWhiteSpace(result.RequestId) || result.ObservedAtUtcMsc <= 0
            || result.Status is not ("succeeded" or "rejected")
            || result.Status == "succeeded" && result.Payload is null
            || result.Status == "rejected" && string.IsNullOrWhiteSpace(result.ErrorCode))
        {
            throw new InvalidDataException("mt4_risk_snapshot_invalid");
        }
    }

    private static void ValidatePerformanceDailyRequest(Mt4PerformanceDailyRequest request)
    {
        var validFrom = DateOnly.TryParseExact(request.DateFrom, "yyyy-MM-dd",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var dateFrom);
        var validTo = DateOnly.TryParseExact(request.DateTo, "yyyy-MM-dd",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var dateTo);
        if (string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(request.BrokerServer)
            || string.IsNullOrWhiteSpace(request.Login) || request.ConnectionEpoch <= 0
            || !validFrom || !validTo || dateTo < dateFrom || dateTo.DayNumber - dateFrom.DayNumber > 30)
        {
            throw new InvalidDataException("mt4_performance_request_invalid");
        }
    }

    private static void ValidatePerformanceDaily(Mt4PerformanceDaily result)
    {
        if (string.IsNullOrWhiteSpace(result.RequestId) || result.ObservedAtUtcMsc <= 0
            || result.Status is not ("succeeded" or "rejected")
            || result.Status == "succeeded" && result.Payload is null
            || result.Status == "rejected" && string.IsNullOrWhiteSpace(result.ErrorCode))
        {
            throw new InvalidDataException("mt4_performance_invalid");
        }
    }

    private static void ValidateDealsRequest(Mt4DealsRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || string.IsNullOrWhiteSpace(request.BrokerServer)
            || string.IsNullOrWhiteSpace(request.Login)
            || request.ConnectionEpoch <= 0
            || request.CursorTimeMsc <= 0
            || request.CursorTicket < 0
            || request.Limit is < 1 or > 250)
        {
            throw new InvalidDataException("mt4_deals_request_invalid");
        }
    }

    private static void ValidateDeals(Mt4DealsBatch result)
    {
        if (result.SourceTimeMsc <= 0
            || result.NextTimeMsc <= 0
            || result.NextTicket < 0
            || result.Items.Count > 250
            || result.Items.Any(item => item.ValueKind != JsonValueKind.Object))
        {
            throw new InvalidDataException("mt4_deals_invalid");
        }
        foreach (var item in result.Items)
        {
            if (!item.TryGetProperty("ticket", out var ticket)
                || ticket.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)
                || !item.TryGetProperty("time_msc", out var time)
                || time.ValueKind != JsonValueKind.Number
                || !time.TryGetInt64(out var timeMsc)
                || timeMsc <= 0)
            {
                throw new InvalidDataException("mt4_deals_item_invalid");
            }
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
