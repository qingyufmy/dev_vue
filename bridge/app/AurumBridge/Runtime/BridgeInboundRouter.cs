using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public sealed record FullSnapshotRequest(
    string TerminalInstanceId,
    long ConnectionEpoch,
    string Stream,
    long ExpectedRevision);

public sealed class BridgeInboundRouter
{
    private readonly BridgeStore _store;
    private readonly BridgeCommandDispatcher _dispatcher;
    private readonly PriorityMessageQueue _outbound;
    private readonly Func<long> _clock;

    public BridgeInboundRouter(
        BridgeStore store,
        BridgeCommandDispatcher dispatcher,
        PriorityMessageQueue outbound,
        Func<long>? clock = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _outbound = outbound ?? throw new ArgumentNullException(nameof(outbound));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public event Func<FullSnapshotRequest, Task>? FullSnapshotRequired;
    public event Action<string, string>? DataAcknowledged;
    public event Action<string>? HelloAcknowledged;

    public async Task RouteAsync(string payloadJson, CancellationToken cancellationToken = default)
    {
        using var document = JsonDocument.Parse(payloadJson, new JsonDocumentOptions
        {
            MaxDepth = 64,
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
        });
        var root = document.RootElement;
        if (!root.TryGetProperty("v", out var version) || version.GetInt32() != 3
            || !root.TryGetProperty("type", out var typeElement))
        {
            throw new InvalidDataException("bridge_message_envelope_invalid");
        }
        var type = typeElement.GetString();
        switch (type)
        {
            case "hello_ack":
                HelloAcknowledged?.Invoke(ReadRequiredString(root, "session_id"));
                return;
            case "data_ack":
                await HandleDataAcknowledgementAsync(payloadJson, cancellationToken);
                return;
            case "command":
                var command = JsonSerializer.Deserialize<CommandMessage>(payloadJson, BridgeJson.Options)
                    ?? throw new InvalidDataException("bridge_command_invalid");
                var result = await _dispatcher.DispatchAsync(command, cancellationToken);
                var resultJson = JsonSerializer.Serialize(result, BridgeJson.Options);
                await _outbound.EnqueueAsync(new(
                    result.MessageId,
                    resultJson,
                    BridgeMessagePriority.Trade), cancellationToken);
                return;
            case "heartbeat":
            case "error":
                return;
            default:
                throw new InvalidDataException("bridge_message_type_unexpected");
        }
    }

    private async Task HandleDataAcknowledgementAsync(
        string payloadJson,
        CancellationToken cancellationToken)
    {
        var acknowledgement = JsonSerializer.Deserialize<DataAckMessage>(payloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("bridge_data_ack_invalid");
        if (acknowledgement.Status is "applied" or "duplicate")
        {
            await _store.AcknowledgeOutboxAsync(
                acknowledgement.AckedMessageId,
                acknowledgement.Status,
                _clock(),
                cancellationToken);
            DataAcknowledged?.Invoke(acknowledgement.AckedMessageId, acknowledgement.Status);
            return;
        }
        if (acknowledgement.Status == "gap")
        {
            var expectedRevision = acknowledgement.ExpectedRevision
                ?? throw new InvalidDataException("bridge_data_ack_expected_revision_missing");
            var handler = FullSnapshotRequired;
            if (handler is not null)
            {
                await handler(new(
                    acknowledgement.TerminalInstanceId,
                    acknowledgement.ConnectionEpoch,
                    acknowledgement.Stream,
                    expectedRevision));
            }
            DataAcknowledged?.Invoke(acknowledgement.AckedMessageId, acknowledgement.Status);
            return;
        }
        throw new InvalidDataException("bridge_data_ack_rejected");
    }

    private static string ReadRequiredString(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new InvalidDataException($"bridge_{propertyName}_invalid");
        }
        return value.GetString()!;
    }
}
