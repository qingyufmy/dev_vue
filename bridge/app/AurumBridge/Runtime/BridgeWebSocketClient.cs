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
    private readonly Func<Task>? _initialSnapshotHandler;

    public BridgeWebSocketClient(
        BridgeStore store,
        BridgeCommandDispatcher dispatcher,
        Func<ClientWebSocket>? socketFactory = null,
        Func<QuoteRequestMessage, CancellationToken, Task<QuoteMessage>>? quoteHandler = null,
        Func<Task>? initialSnapshotHandler = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
        _socketFactory = socketFactory ?? (() => new ClientWebSocket());
        _quoteHandler = quoteHandler;
        _initialSnapshotHandler = initialSnapshotHandler;
    }

    public event Func<FullSnapshotRequest, Task>? FullSnapshotRequired;

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
            var router = new BridgeInboundRouter(_store, _dispatcher, outbound, quoteHandler:_quoteHandler);
            var outbox = new BridgeOutboxPump(_store, outbound);
            var helloReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            router.HelloAcknowledged += sessionId =>
            {
                if (string.Equals(sessionId, attempt.Hello.SessionId, StringComparison.Ordinal))
                {
                    helloReady.TrySetResult();
                }
            };
            router.DataAcknowledged += outbox.HandleAcknowledgement;
            router.FullSnapshotRequired += request => FullSnapshotRequired?.Invoke(request) ?? Task.CompletedTask;

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
                var sendTask = SendLoopAsync(socket, outbound, sessionCancellation.Token);
                var pumpTask = PumpLoopAsync(outbox, sessionCancellation.Token);
                await receiveTask;
                sessionCancellation.Cancel();
                await IgnoreCancellationAsync(sendTask);
                await IgnoreCancellationAsync(pumpTask);
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
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var message = await outbound.DequeueAsync(cancellationToken);
            await SendDirectAsync(socket, message.PayloadJson, cancellationToken);
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

    private static async Task ReceiveLoopAsync(
        ClientWebSocket socket,
        BridgeInboundRouter router,
        CancellationToken cancellationToken)
    {
        var receiveBuffer = new byte[16 * 1024];
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var writer = new ArrayBufferWriter<byte>();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(receiveBuffer, cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
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

            await router.RouteAsync(Encoding.UTF8.GetString(writer.WrittenSpan), cancellationToken);
        }
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

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
    }
}
