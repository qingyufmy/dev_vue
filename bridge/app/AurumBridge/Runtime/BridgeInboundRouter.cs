using System.Text;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public sealed record FullSnapshotRequest(
    string TerminalInstanceId,
    long ConnectionEpoch,
    string Stream,
    long ExpectedRevision);

public sealed record BridgeHelloAcknowledgement(
    string AckedMessageId,
    string SessionId,
    IReadOnlyList<string> AcceptedTerminalInstanceIds);

public sealed record BridgeReleaseAvailableNotification(
    string? ReleaseId,
    string ReleaseVersion,
    string RolloutChannel,
    string Reason);

public sealed class BridgeInboundRouter
{
    private const int MaximumOutboundDataBytes = 3 * 1024 * 1024;
    private readonly BridgeStore _store;
    private readonly BridgeCommandDispatcher _dispatcher;
    private readonly PriorityMessageQueue _outbound;
    private readonly Func<long> _clock;
    private readonly Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? _quoteHandler;
    private readonly Func<DataRequestMessage, CancellationToken, Task<DataResponseMessage>>? _dataHandler;
    private readonly BridgeOutboxPump? _outboxPump;

    public BridgeInboundRouter(
        BridgeStore store,
        BridgeCommandDispatcher dispatcher,
        PriorityMessageQueue outbound,
        Func<long>? clock = null,
        Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? quoteHandler = null,
        Func<DataRequestMessage, CancellationToken, Task<DataResponseMessage>>? dataHandler = null,
        BridgeOutboxPump? outboxPump = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _outbound = outbound ?? throw new ArgumentNullException(nameof(outbound));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _quoteHandler = quoteHandler;
        _dataHandler = dataHandler;
        _outboxPump = outboxPump;
    }

    public event Func<FullSnapshotRequest, Task>? FullSnapshotRequired;
    public event Action<string, string>? DataAcknowledged;
    public event Action<BridgeHelloAcknowledgement>? HelloAcknowledged;
    public event Action<string>? InitialSynchronizationCompleted;
    public event Action<BridgeReleaseAvailableNotification>? ReleaseAvailable;

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
                var helloAcknowledgement = new BridgeHelloAcknowledgement(
                    ReadRequiredString(root, "acked_message_id"),
                    ReadRequiredString(root, "session_id"),
                    ReadRequiredStringArray(root, "accepted_terminal_instance_ids", 1, 32));
                HelloAcknowledged?.Invoke(helloAcknowledgement);
                return;
            case "data_ack":
                await HandleDataAcknowledgementAsync(payloadJson, cancellationToken);
                return;
            case "command_result_ack":
                await HandleCommandResultAcknowledgementAsync(payloadJson, cancellationToken);
                return;
            case "command":
                var command = JsonSerializer.Deserialize<CommandMessage>(payloadJson, BridgeJson.Options)
                    ?? throw new InvalidDataException("bridge_command_invalid");
                var result = await _dispatcher.DispatchAsync(command, cancellationToken);
                var resultJson = JsonSerializer.Serialize(result, BridgeJson.Options);
                var pendingResult = _outboxPump is null
                    ? null
                    : await _store.GetPendingOutboxMessageAsync(result.MessageId, cancellationToken);
                var claimed = _outboxPump?.TryClaim(
                    result.MessageId, pendingResult?.AttemptCount ?? 0) ?? true;
                if (claimed)
                {
                    try
                    {
                        await _outbound.EnqueueAsync(new(
                            result.MessageId,
                            resultJson,
                            BridgeMessagePriority.Trade), cancellationToken);
                    }
                    catch
                    {
                        _outboxPump?.ReleaseClaim(result.MessageId);
                        throw;
                    }
                }
                return;
            case "quote_request":
                await HandleQuoteRequestAsync(payloadJson, cancellationToken);
                return;
            case "data_request":
                await HandleDataRequestAsync(payloadJson, cancellationToken);
                return;
            case "heartbeat":
                return;
            case "release_available":
                var releaseVersion = ReadRequiredString(root, "release_version");
                if (!Version.TryParse(releaseVersion, out _))
                {
                    throw new InvalidDataException("bridge_release_notification_invalid");
                }
                var rolloutChannel = ReadRequiredString(root, "rollout_channel");
                var reason = ReadRequiredString(root, "reason");
                if (rolloutChannel is not ("internal" or "stable")
                    || reason is not ("published" or "rollback"))
                {
                    throw new InvalidDataException("bridge_release_notification_invalid");
                }
                string? releaseId = null;
                if (root.TryGetProperty("release_id", out var releaseIdElement)
                    && releaseIdElement.ValueKind is not JsonValueKind.Null)
                {
                    releaseId = releaseIdElement.GetString();
                    if (string.IsNullOrWhiteSpace(releaseId) || releaseId.Length > 128)
                    {
                        throw new InvalidDataException("bridge_release_notification_invalid");
                    }
                }
                ReleaseAvailable?.Invoke(new(
                    releaseId,
                    releaseVersion,
                    rolloutChannel,
                    reason));
                return;
            case "error":
                throw new InvalidDataException(ReadRequiredString(root, "error_code"));
            default:
                throw new InvalidDataException("bridge_message_type_unexpected");
        }
    }

    private async Task HandleCommandResultAcknowledgementAsync(
        string payloadJson,
        CancellationToken cancellationToken)
    {
        var acknowledgement = JsonSerializer.Deserialize<CommandResultAckMessage>(payloadJson, BridgeJson.Options)
            ?? throw new InvalidDataException("bridge_command_result_ack_invalid");
        if (acknowledgement.Version != 3
            || acknowledgement.Type != "command_result_ack"
            || acknowledgement.Status is not ("applied" or "duplicate"))
        {
            throw new InvalidDataException("bridge_command_result_ack_invalid");
        }
        var pending = await _store.GetPendingOutboxMessageAsync(
            acknowledgement.AckedMessageId, cancellationToken);
        if (pending is not null && pending.MessageType != "command_result")
        {
            throw new InvalidDataException("bridge_command_result_ack_type_mismatch");
        }
        var result = pending is null
            ? await _store.GetExecutionReceiptAsync(acknowledgement.CommandId, cancellationToken)
            : JsonSerializer.Deserialize<CommandResultMessage>(pending.PayloadJson, BridgeJson.Options);
        if (result is null || result.MessageId != acknowledgement.AckedMessageId)
        {
            throw new InvalidDataException("bridge_command_result_ack_unknown");
        }
        if (result.CommandId != acknowledgement.CommandId
            || result.TerminalInstanceId != acknowledgement.TerminalInstanceId
            || result.ConnectionEpoch != acknowledgement.ConnectionEpoch
            || !SameAccount(result.AccountRef, acknowledgement.AccountRef))
        {
            throw new InvalidDataException("bridge_command_result_ack_route_mismatch");
        }
        if (pending is not null && !await _store.AcknowledgeOutboxAsync(
            acknowledgement.AckedMessageId, acknowledgement.Status, _clock(), cancellationToken))
        {
            throw new InvalidDataException("bridge_command_result_ack_unknown");
        }
        _outboxPump?.HandleAcknowledgement(acknowledgement.AckedMessageId, acknowledgement.Status);
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
            BridgeMessagePriority.Data), cancellationToken);
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
        var responseJson = JsonSerializer.Serialize(response, BridgeJson.Options);
        if (Encoding.UTF8.GetByteCount(responseJson) > MaximumOutboundDataBytes)
        {
            response = RejectedData(request, "bridge_result_too_large");
            responseJson = JsonSerializer.Serialize(response, BridgeJson.Options);
        }
        await _outbound.EnqueueAsync(new(
            response.MessageId,
            responseJson,
            BridgeMessagePriority.Data), cancellationToken);
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

    private static IReadOnlyList<string> ReadRequiredStringArray(
        JsonElement root,
        string propertyName,
        int minimumCount,
        int maximumCount)
    {
        if (!root.TryGetProperty(propertyName, out var value)
            || value.ValueKind != JsonValueKind.Array
            || value.GetArrayLength() < minimumCount
            || value.GetArrayLength() > maximumCount)
        {
            throw new InvalidDataException($"bridge_{propertyName}_invalid");
        }
        var values = new List<string>(value.GetArrayLength());
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in value.EnumerateArray())
        {
            var itemValue = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
            if (string.IsNullOrWhiteSpace(itemValue) || !unique.Add(itemValue))
            {
                throw new InvalidDataException($"bridge_{propertyName}_invalid");
            }
            values.Add(itemValue);
        }
        return values;
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
            || !BridgeSymbolIdentity.Equivalent(response.Symbol, request.Symbol)
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
            || request.Action is not ("rates" or "symbol_snapshot" or "risk_snapshot" or "performance_daily"
                or "symbols" or "history" or "chart_data" or "pending_order_state" or "diagnostics")
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

    private static bool SameAccount(AccountRef? left, AccountRef? right) =>
        left is not null
        && right is not null
        && string.Equals(left.BrokerServer, right.BrokerServer, StringComparison.OrdinalIgnoreCase)
        && left.Login == right.Login;
}
