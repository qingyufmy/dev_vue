using System.Text.Json;
using System.Text.Json.Serialization;

namespace AurumBridge.Protocol;

public sealed record AccountRef(
    [property: JsonPropertyName("broker_server")] string BrokerServer,
    [property: JsonPropertyName("login")] string Login);

public abstract record BridgeEnvelope
{
    [JsonPropertyName("v")]
    public int Version { get; init; } = 3;

    [JsonPropertyName("type")]
    public required string Type { get; init; }

    [JsonPropertyName("message_id")]
    public required string MessageId { get; init; }

    [JsonPropertyName("sent_at_utc_msc")]
    public required long SentAtUtcMsc { get; init; }
}

public sealed record TerminalDescriptor
{
    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("platform")]
    public required string Platform { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("worker_version")]
    public string? WorkerVersion { get; init; }
}

public sealed record HelloMessage : BridgeEnvelope
{
    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }

    [JsonPropertyName("bridge_version")]
    public required string BridgeVersion { get; init; }

    [JsonPropertyName("terminals")]
    public required IReadOnlyList<TerminalDescriptor> Terminals { get; init; }
}

public sealed record HeartbeatMessage : BridgeEnvelope
{
    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }
}

public sealed record DataDeltaMessage : BridgeEnvelope
{
    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("stream")]
    public required string Stream { get; init; }

    [JsonPropertyName("revision")]
    public required long Revision { get; init; }

    [JsonPropertyName("base_revision")]
    public required long BaseRevision { get; init; }

    [JsonPropertyName("observed_at_utc_msc")]
    public required long ObservedAtUtcMsc { get; init; }

    [JsonPropertyName("source_time_msc")]
    public long? SourceTimeMsc { get; init; }

    [JsonPropertyName("full_snapshot")]
    public bool FullSnapshot { get; init; }

    [JsonPropertyName("upserts")]
    public required IReadOnlyList<JsonElement> Upserts { get; init; }

    [JsonPropertyName("deletes")]
    public required IReadOnlyList<JsonElement> Deletes { get; init; }
}

public sealed record DataAckMessage : BridgeEnvelope
{
    [JsonPropertyName("acked_message_id")]
    public required string AckedMessageId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("stream")]
    public required string Stream { get; init; }

    [JsonPropertyName("revision")]
    public required long Revision { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("expected_revision")]
    public long? ExpectedRevision { get; init; }
}

public sealed record CommandMessage : BridgeEnvelope
{
    [JsonPropertyName("command_id")]
    public required string CommandId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("issued_at_utc_msc")]
    public required long IssuedAtUtcMsc { get; init; }

    [JsonPropertyName("deadline_utc_msc")]
    public required long DeadlineUtcMsc { get; init; }

    [JsonPropertyName("action")]
    public required string Action { get; init; }

    [JsonPropertyName("params")]
    public required JsonElement Params { get; init; }
}

public sealed record ExecutionEvidence
{
    [JsonPropertyName("observed_at_utc_msc")]
    public required long ObservedAtUtcMsc { get; init; }

    [JsonPropertyName("order_tickets")]
    public IReadOnlyList<string> OrderTickets { get; init; } = [];

    [JsonPropertyName("position_tickets")]
    public IReadOnlyList<string> PositionTickets { get; init; } = [];

    [JsonPropertyName("deal_tickets")]
    public IReadOnlyList<string> DealTickets { get; init; } = [];

    [JsonPropertyName("broker_retcode")]
    public long? BrokerRetcode { get; init; }
}

public sealed record CommandResultMessage : BridgeEnvelope
{
    [JsonPropertyName("command_id")]
    public required string CommandId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("completed_at_utc_msc")]
    public required long CompletedAtUtcMsc { get; init; }

    [JsonPropertyName("error_code")]
    public string? ErrorCode { get; init; }

    [JsonPropertyName("error_message")]
    public string? ErrorMessage { get; init; }

    [JsonPropertyName("raw_result")]
    public JsonElement? RawResult { get; init; }

    [JsonPropertyName("evidence")]
    public required ExecutionEvidence Evidence { get; init; }
}

public sealed record CommandResultAckMessage : BridgeEnvelope
{
    [JsonPropertyName("acked_message_id")]
    public required string AckedMessageId { get; init; }

    [JsonPropertyName("command_id")]
    public required string CommandId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }
}

public sealed record QuoteRequestMessage : BridgeEnvelope
{
    [JsonPropertyName("request_id")]
    public required string RequestId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("symbol")]
    public required string Symbol { get; init; }
}

public sealed record QuoteMessage : BridgeEnvelope
{
    [JsonPropertyName("request_id")]
    public required string RequestId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("symbol")]
    public required string Symbol { get; init; }

    [JsonPropertyName("observed_at_utc_msc")]
    public required long ObservedAtUtcMsc { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("bid")]
    public double? Bid { get; init; }

    [JsonPropertyName("ask")]
    public double? Ask { get; init; }

    [JsonPropertyName("last")]
    public double? Last { get; init; }

    [JsonPropertyName("symbol_trade_mode")]
    public int? SymbolTradeMode { get; init; }

    [JsonPropertyName("terminal_connected")]
    public bool? TerminalConnected { get; init; }

    [JsonPropertyName("error_code")]
    public string? ErrorCode { get; init; }
}

public sealed record DataRequestMessage : BridgeEnvelope
{
    [JsonPropertyName("request_id")]
    public required string RequestId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("action")]
    public required string Action { get; init; }

    [JsonPropertyName("params")]
    public required JsonElement Params { get; init; }
}

public sealed record DataResponseMessage : BridgeEnvelope
{
    [JsonPropertyName("request_id")]
    public required string RequestId { get; init; }

    [JsonPropertyName("terminal_instance_id")]
    public required string TerminalInstanceId { get; init; }

    [JsonPropertyName("account_ref")]
    public required AccountRef AccountRef { get; init; }

    [JsonPropertyName("connection_epoch")]
    public required long ConnectionEpoch { get; init; }

    [JsonPropertyName("action")]
    public required string Action { get; init; }

    [JsonPropertyName("params")]
    public required JsonElement Params { get; init; }

    [JsonPropertyName("observed_at_utc_msc")]
    public required long ObservedAtUtcMsc { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("payload")]
    public JsonElement? Payload { get; init; }

    [JsonPropertyName("error_code")]
    public string? ErrorCode { get; init; }
}

public static class BridgeJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };
}
