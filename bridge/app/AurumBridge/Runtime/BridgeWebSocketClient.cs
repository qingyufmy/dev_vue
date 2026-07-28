using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public sealed record BridgeConnectionAttempt(Uri WebSocketUri, string Ticket, HelloMessage Hello);

public sealed class BridgeWebSocketClient
{
    private const int MaxInboundMessageBytes = 4 * 1024 * 1024;
    private readonly BridgeStore _store;
    private readonly BridgeCommandDispatcher _dispatcher;
    private readonly Func<ClientWebSocket> _socketFactory;
    private readonly Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? _quoteHandler;
    private readonly Func<DataRequestMessage, CancellationToken, Task<DataResponseMessage>>? _dataHandler;
    private readonly Func<Task>? _initialSnapshotHandler;
    private readonly Func<IReadOnlyList<TerminalStreamFreshness>>? _heartbeatTerminalsProvider;

    public BridgeWebSocketClient(
        BridgeStore store,
        BridgeCommandDispatcher dispatcher,
        Func<ClientWebSocket>? socketFactory = null,
        Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? quoteHandler = null,
        Func<DataRequestMessage, CancellationToken, Task<DataResponseMessage>>? dataHandler = null,
        Func<Task>? initialSnapshotHandler = null,
        Func<IReadOnlyList<TerminalStreamFreshness>>? heartbeatTerminalsProvider = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _socketFactory = socketFactory ?? (() => new ClientWebSocket());
        _quoteHandler = quoteHandler;
        _dataHandler = dataHandler;
        _initialSnapshotHandler = initialSnapshotHandler;
        _heartbeatTerminalsProvider = heartbeatTerminalsProvider;
    }

    public event Func<FullSnapshotRequest, Task>? FullSnapshotRequired;
    public event Action<string>? InitialSynchronizationCompleted;
    public event Action<string>? DataAcknowledged;
    public event Action<BridgeReleaseAvailableNotification>? ReleaseAvailable;

    public async Task RunSessionAsync(
        BridgeConnectionAttempt attempt,
        Action? sessionReady = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(attempt);
        if (string.IsNullOrWhiteSpace(attempt.Ticket))
        {
            throw new ArgumentException("A one-time bridge ticket is required.", nameof(attempt));
        }

        _dispatcher.BeginSession(attempt.Hello.SessionId, attempt.Hello.Terminals);
        try
        {
            using var socket = _socketFactory();
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
            var uri = WithTicket(attempt.WebSocketUri, attempt.Ticket);
            await socket.ConnectAsync(uri, cancellationToken);
            await SendDirectAsync(socket, JsonSerializer.Serialize(attempt.Hello, BridgeJson.Options), cancellationToken);

            var outbound = new PriorityMessageQueue();
            var sessionTerminalIds = attempt.Hello.Terminals
                .Select(terminal => terminal.TerminalInstanceId)
                .ToHashSet(StringComparer.Ordinal);
            var sessionTerminalEpochs = attempt.Hello.Terminals.ToDictionary(
                terminal => terminal.TerminalInstanceId,
                terminal => terminal.ConnectionEpoch,
                StringComparer.Ordinal);
            await _store.PruneObsoleteDataOutboxAsync(sessionTerminalEpochs, cancellationToken);
            var outbox = new BridgeOutboxPump(
                _store, outbound, terminalInstanceIds:sessionTerminalIds);
            var router = new BridgeInboundRouter(
                _store, _dispatcher, outbound, quoteHandler:_quoteHandler, dataHandler:_dataHandler,
                outboxPump:outbox);
            var helloReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            router.HelloAcknowledged += acknowledgement =>
            {
                ValidateHelloAcknowledgement(attempt, acknowledgement);
                helloReady.TrySetResult();
            };
            router.DataAcknowledged += (messageId, status) =>
            {
                outbox.HandleAcknowledgement(messageId, status);
                DataAcknowledged?.Invoke(status);
            };
            router.InitialSynchronizationCompleted += terminalId =>
                InitialSynchronizationCompleted?.Invoke(terminalId);
            router.FullSnapshotRequired += request => FullSnapshotRequired?.Invoke(request) ?? Task.CompletedTask;
            router.ReleaseAvailable += notification => ReleaseAvailable?.Invoke(notification);

            using var sessionCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var receiveTask = ReceiveLoopAsync(socket, router, sessionCancellation.Token);
            try
            {
                var handshakeTimeout = Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
                var handshake = await Task.WhenAny(helloReady.Task, receiveTask, handshakeTimeout);
                if (handshake == receiveTask)
                {
                    await receiveTask;
                    throw new WebSocketException("Bridge connection closed before hello acknowledgement.");
                }
                if (handshake == handshakeTimeout)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    throw new TimeoutException("Bridge hello acknowledgement timed out.");
                }
                await helloReady.Task;
                if (_initialSnapshotHandler is not null)
                {
                    await _initialSnapshotHandler();
                }
                sessionReady?.Invoke();
                var sendTask = SendLoopAsync(socket, outbound, outbox, sessionCancellation.Token);
                var pumpTask = PumpLoopAsync(outbox, sessionCancellation.Token);
                var heartbeatTask = HeartbeatLoopAsync(
                    outbound, attempt.Hello.SessionId, _heartbeatTerminalsProvider,
                    sessionCancellation.Token);
                await BridgeSessionLoopMonitor.RunAsync(
                    receiveTask,
                    sendTask,
                    pumpTask,
                    heartbeatTask,
                    sessionCancellation);
            }
            finally
            {
                sessionCancellation.Cancel();
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                {
                    try
                    {
                        await socket.CloseOutputAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "session_stopped",
                            CancellationToken.None);
                    }
                    catch (WebSocketException)
                    {
                    }
                }
            }
        }
        finally
        {
            _dispatcher.EndSession(attempt.Hello.SessionId);
        }
    }

    private static async Task SendLoopAsync(
        ClientWebSocket socket,
        PriorityMessageQueue outbound,
        BridgeOutboxPump outbox,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var message = await outbound.DequeueAsync(cancellationToken);
            await SendDirectAsync(socket, message.PayloadJson, cancellationToken);
            await outbox.RecordSuccessfulSendAsync(message.MessageId, cancellationToken);
        }
    }

    private static async Task PumpLoopAsync(
        BridgeOutboxPump outbox,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await outbox.PumpOnceAsync(cancellationToken);
            await Task.Delay(TimeSpan.FromMilliseconds(200), cancellationToken);
        }
    }

    private static async Task HeartbeatLoopAsync(
        PriorityMessageQueue outbound,
        string sessionId,
        Func<IReadOnlyList<TerminalStreamFreshness>>? terminalsProvider,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var heartbeat = new HeartbeatMessage
            {
                Type = "heartbeat",
                MessageId = $"heartbeat_{Guid.NewGuid():N}",
                SentAtUtcMsc = now,
                SessionId = sessionId,
                Terminals = terminalsProvider?.Invoke() ?? [],
            };
            await outbound.EnqueueAsync(new(
                heartbeat.MessageId,
                JsonSerializer.Serialize(heartbeat, BridgeJson.Options),
                BridgeMessagePriority.Trade), cancellationToken);
        }
    }

    private static async Task ReceiveLoopAsync(
        ClientWebSocket socket,
        BridgeInboundRouter router,
        CancellationToken cancellationToken)
    {
        await using var dispatcher = new BridgeInboundRequestDispatcher(router);
        using var receiveCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var receiveTask = ReceiveMessageAsync(socket, receiveCancellation.Token);
            var completed = await Task.WhenAny(receiveTask, dispatcher.Faulted);
            if (completed == dispatcher.Faulted || dispatcher.Faulted.IsCompleted)
            {
                await receiveCancellation.CancelAsync();
                try
                {
                    await receiveTask;
                }
                catch
                {
                }
                await dispatcher.Faulted;
            }
            var payloadJson = await receiveTask;
            if (payloadJson is null)
            {
                return;
            }
            await dispatcher.RouteAsync(payloadJson, cancellationToken);
        }
    }

    private static async Task<string?> ReceiveMessageAsync(
        ClientWebSocket socket,
        CancellationToken cancellationToken)
    {
        var receiveBuffer = new byte[16 * 1024];
        var writer = new ArrayBufferWriter<byte>();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(receiveBuffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }
            if (result.MessageType != WebSocketMessageType.Text)
            {
                throw new InvalidDataException("bridge_binary_message_unsupported");
            }
            if (writer.WrittenCount + result.Count > MaxInboundMessageBytes)
            {
                throw new InvalidDataException("bridge_message_too_large");
            }
            writer.Write(receiveBuffer.AsSpan(0, result.Count));
        }
        while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(writer.WrittenSpan);
    }

    private static async Task SendDirectAsync(
        ClientWebSocket socket,
        string payloadJson,
        CancellationToken cancellationToken)
    {
        var payload = Encoding.UTF8.GetBytes(payloadJson);
        await socket.SendAsync(payload, WebSocketMessageType.Text, true, cancellationToken);
    }

    private static Uri WithTicket(Uri baseUri, string ticket)
    {
        if (baseUri.Scheme is not ("ws" or "wss"))
        {
            throw new ArgumentException("Bridge endpoint must use ws or wss.", nameof(baseUri));
        }
        var builder = new UriBuilder(baseUri);
        var ticketParameter = $"ticket={Uri.EscapeDataString(ticket)}";
        builder.Query = string.IsNullOrWhiteSpace(builder.Query)
            ? ticketParameter
            : $"{builder.Query.TrimStart('?')}&{ticketParameter}";
        return builder.Uri;
    }

    public static void ValidateHelloAcknowledgement(
        BridgeConnectionAttempt attempt,
        BridgeHelloAcknowledgement acknowledgement)
    {
        ArgumentNullException.ThrowIfNull(attempt);
        ArgumentNullException.ThrowIfNull(acknowledgement);
        var expectedTerminals = attempt.Hello.Terminals
            .Select(terminal => terminal.TerminalInstanceId)
            .ToHashSet(StringComparer.Ordinal);
        if (!string.Equals(
                acknowledgement.AckedMessageId,
                attempt.Hello.MessageId,
                StringComparison.Ordinal)
            || !string.Equals(
                acknowledgement.SessionId,
                attempt.Hello.SessionId,
                StringComparison.Ordinal)
            || acknowledgement.AcceptedTerminalInstanceIds.Count != expectedTerminals.Count
            || acknowledgement.AcceptedTerminalInstanceIds.Any(id => !expectedTerminals.Contains(id)))
        {
            throw new InvalidDataException("bridge_hello_ack_route_mismatch");
        }
    }

}
