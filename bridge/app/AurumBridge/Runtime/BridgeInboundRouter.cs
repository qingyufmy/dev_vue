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
    private readonly Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? _quoteHandler;
    private readonly Func<DataRequestMessage, CancellationToken, Task<DataResponseMessage>>? _dataHandler;

    public BridgeInboundRouter(
        BridgeStore store,
        BridgeCommandDispatcher dispatcher,
        PriorityMessageQueue outbound,
        Func<long>? clock = null,
        Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? quoteHandler = null,
        Func<DataRequestMessage, CancellationToken, Task<DataResponseMessage>>? dataHandler = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _outbound = outbound ?? throw new ArgumentNullException(nameof(outbound));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _quoteHandler = quoteHandler;
        _dataHandler = dataHandler;
    }

    public event Func<FullSnapshotRequest, Task>? FullSnapshotRequired;
    public event Action<string, string>? DataAcknowledged;
    public event Action<string>? HelloAcknowledged;
    public event Action<string>? InitialSynchronizationCompleted;

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
            case "quote_request":
                await HandleQuoteRequestAsync(payloadJson, cancellationToken);
                return;
            case "data_request":
                await HandleDataRequestAsync(payloadJson, cancellationToken);
                return;
            case "heartbeat":
            case "error":
                return;
            default:
                throw new InvalidDataException("bridge_message_type_unexpected");
        }
    }

    private async Task HandleQuoteRequestAsync(
        string payloadJson,
        CancellationToken cancellationToken)
    {
        var request = JsonSerializer.Deserialize<QuoteRequestMessage>(payloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("bridge_quote_request_invalid");
        ValidateQuoteRequest(request);
        QuoteMessage response;
        try
        {
            response = _quoteHandler is null
                ? RejectedQuote(request, "bridge_quote_unavailable")
                : await _quoteHandler(request, cancellationToken);
            ValidateQuoteResponse(request, response);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            response = RejectedQuote(request, "bridge_quote_unavailable");
        }
        await _outbound.EnqueueAsync(new(
            response.MessageId,
            JsonSerializer.Serialize(response, BridgeJson.Options),
            BridgeMessagePriority.Trade), cancellationToken);
    }

    private async Task HandleDataRequestAsync(
        string payloadJson,
        CancellationToken cancellationToken)
    {
        var request = JsonSerializer.Deserialize<DataRequestMessage>(payloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("bridge_data_request_invalid");
        ValidateDataRequest(request);
        DataResponseMessage response;
        try
        {
            response = _dataHandler is null
                ? RejectedData(request, "terminal_data_action_unavailable")
                : await _dataHandler(request, cancellationToken);
            ValidateDataResponse(request, response);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            response = RejectedData(request, "terminal_data_request_failed");
        }
        await _outbound.EnqueueAsync(new(
            response.MessageId,
            JsonSerializer.Serialize(response, BridgeJson.Options),
            BridgeMessagePriority.Trade), cancellationToken);
    }

    private async Task HandleDataAcknowledgementAsync(
        string payloadJson,
        CancellationToken cancellationToken)
    {
        var acknowledgement = JsonSerializer.Deserialize<DataAckMessage>(payloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("bridge_data_ack_invalid");
        if (acknowledgement.Status is "applied" or "duplicate")
        {
            var acknowledgedDelta = await ReadPendingDeltaAsync(acknowledgement, cancellationToken);
            var removed = await _store.AcknowledgeOutboxAsync(
                acknowledgement.AckedMessageId,
                acknowledgement.Status,
                _clock(),
                cancellationToken);
            if (removed && acknowledgedDelta?.FullSnapshot == true)
            {
                if (_dispatcher.AcknowledgeInitialSnapshot(
                    acknowledgedDelta.TerminalInstanceId,
                    acknowledgedDelta.ConnectionEpoch,
                    acknowledgedDelta.Stream))
                {
                    InitialSynchronizationCompleted?.Invoke(acknowledgedDelta.TerminalInstanceId);
                }
            }
            DataAcknowledged?.Invoke(acknowledgement.AckedMessageId, acknowledgement.Status);
            return;
        }
        if (acknowledgement.Status == "gap")
        {
            await ReadPendingDeltaAsync(acknowledgement, cancellationToken);
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

    private async Task<DataDeltaMessage?> ReadPendingDeltaAsync(
        DataAckMessage acknowledgement,
        CancellationToken cancellationToken)
    {
        var outbox = await _store.GetPendingOutboxMessageAsync(
            acknowledgement.AckedMessageId,
            cancellationToken);
        if (outbox is null)
        {
            return null;
        }
        var delta = JsonSerializer.Deserialize<DataDeltaMessage>(outbox.PayloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("bridge_data_ack_source_invalid");
        if (delta.Type != "data_delta"
            || delta.MessageId != acknowledgement.AckedMessageId
            || delta.TerminalInstanceId != acknowledgement.TerminalInstanceId
            || delta.ConnectionEpoch != acknowledgement.ConnectionEpoch
            || delta.Stream != acknowledgement.Stream
            || delta.Revision != acknowledgement.Revision)
        {
            throw new InvalidDataException("bridge_data_ack_route_mismatch");
        }
        return delta;
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

    private static void ValidateQuoteRequest(QuoteRequestMessage request)
    {
        if (request.Version != 3 || request.Type != "quote_request"
            || string.IsNullOrWhiteSpace(request.MessageId)
            || string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || request.ConnectionEpoch <= 0
            || string.IsNullOrWhiteSpace(request.AccountRef?.BrokerServer)
            || string.IsNullOrWhiteSpace(request.AccountRef?.Login)
            || string.IsNullOrWhiteSpace(request.Symbol)
            || request.Symbol != request.Symbol.Trim()
            || request.Symbol.Length > 64)
        {
            throw new InvalidDataException("bridge_quote_request_invalid");
        }
    }

    private static void ValidateQuoteResponse(QuoteRequestMessage request, QuoteMessage response)
    {
        if (response.Version != 3 || response.Type != "quote"
            || response.RequestId != request.RequestId
            || response.TerminalInstanceId != request.TerminalInstanceId
            || response.ConnectionEpoch != request.ConnectionEpoch
            || !string.Equals(response.AccountRef.BrokerServer, request.AccountRef.BrokerServer,
                StringComparison.OrdinalIgnoreCase)
            || response.AccountRef.Login != request.AccountRef.Login
            || response.Symbol != request.Symbol
            || response.ObservedAtUtcMsc <= 0
            || response.Status is not ("succeeded" or "rejected"))
        {
            throw new InvalidDataException("bridge_quote_response_invalid");
        }
        if (response.Status == "succeeded"
            && (response.Bid is null || response.Ask is null
                || !double.IsFinite(response.Bid.Value) || response.Bid <= 0
                || !double.IsFinite(response.Ask.Value) || response.Ask <= 0
                || response.Ask < response.Bid))
        {
            throw new InvalidDataException("bridge_quote_price_invalid");
        }
        if (response.Status == "rejected" && string.IsNullOrWhiteSpace(response.ErrorCode))
        {
            throw new InvalidDataException("bridge_quote_error_missing");
        }
    }

    private static void ValidateDataRequest(DataRequestMessage request)
    {
        if (request.Version != 3 || request.Type != "data_request"
            || string.IsNullOrWhiteSpace(request.MessageId)
            || string.IsNullOrWhiteSpace(request.RequestId)
            || string.IsNullOrWhiteSpace(request.TerminalInstanceId)
            || request.ConnectionEpoch <= 0
            || string.IsNullOrWhiteSpace(request.AccountRef?.BrokerServer)
            || string.IsNullOrWhiteSpace(request.AccountRef?.Login)
            || request.Action is not ("rates" or "symbol_snapshot" or "risk_snapshot")
            || request.Params.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("bridge_data_request_invalid");
        }
    }

    private static void ValidateDataResponse(DataRequestMessage request, DataResponseMessage response)
    {
        if (response.Version != 3 || response.Type != "data_response"
            || response.RequestId != request.RequestId
            || response.TerminalInstanceId != request.TerminalInstanceId
            || response.ConnectionEpoch != request.ConnectionEpoch
            || !string.Equals(response.AccountRef.BrokerServer, request.AccountRef.BrokerServer,
                StringComparison.OrdinalIgnoreCase)
            || response.AccountRef.Login != request.AccountRef.Login
            || response.Action != request.Action
            || response.ObservedAtUtcMsc <= 0
            || response.Status is not ("succeeded" or "rejected")
            || (response.Status == "succeeded" && response.Payload?.ValueKind != JsonValueKind.Object)
            || (response.Status == "rejected" && string.IsNullOrWhiteSpace(response.ErrorCode)))
        {
            throw new InvalidDataException("bridge_data_response_invalid");
        }
    }

    private QuoteMessage RejectedQuote(QuoteRequestMessage request, string errorCode)
    {
        var now = _clock();
        return new()
        {
            Type = "quote",
            MessageId = $"quote_{request.RequestId}_{Guid.NewGuid():N}",
            SentAtUtcMsc = now,
            RequestId = request.RequestId,
            TerminalInstanceId = request.TerminalInstanceId,
            AccountRef = request.AccountRef,
            ConnectionEpoch = request.ConnectionEpoch,
            Symbol = request.Symbol,
            ObservedAtUtcMsc = now,
            Status = "rejected",
            ErrorCode = errorCode,
        };
    }

    private DataResponseMessage RejectedData(DataRequestMessage request, string errorCode)
    {
        var now = _clock();
        return new()
        {
            Type = "data_response",
            MessageId = $"data_{request.RequestId}_{Guid.NewGuid():N}",
            SentAtUtcMsc = now,
            RequestId = request.RequestId,
            TerminalInstanceId = request.TerminalInstanceId,
            AccountRef = request.AccountRef,
            ConnectionEpoch = request.ConnectionEpoch,
            Action = request.Action,
            Params = request.Params,
            ObservedAtUtcMsc = now,
            Status = "rejected",
            ErrorCode = errorCode,
        };
    }
}
