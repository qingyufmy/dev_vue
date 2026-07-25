using System.Text.Json;
using System.Threading.Channels;

namespace AurumBridge.Runtime;

public sealed class BridgeInboundRequestDispatcher : IAsyncDisposable
{
    private const int DefaultTradeCapacity = 128;
    private const int DefaultDataCapacity = 96;
    private readonly Func<string, CancellationToken, Task> _routeHandler;
    private readonly Channel<string> _tradeRequests;
    private readonly Channel<string> _dataRequests;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly TaskCompletionSource _faulted = new(
        TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Task _tradeWorker;
    private readonly Task _dataWorker;
    private int _stopped;

    public BridgeInboundRequestDispatcher(
        BridgeInboundRouter router,
        int tradeCapacity = DefaultTradeCapacity,
        int dataCapacity = DefaultDataCapacity)
        : this((router ?? throw new ArgumentNullException(nameof(router))).RouteAsync,
            tradeCapacity, dataCapacity)
    {
    }

    public BridgeInboundRequestDispatcher(
        Func<string, CancellationToken, Task> routeHandler,
        int tradeCapacity = DefaultTradeCapacity,
        int dataCapacity = DefaultDataCapacity)
    {
        _routeHandler = routeHandler ?? throw new ArgumentNullException(nameof(routeHandler));
        if (tradeCapacity <= 0 || dataCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(tradeCapacity));
        }
        _tradeRequests = CreateQueue(tradeCapacity);
        _dataRequests = CreateQueue(dataCapacity);
        _tradeWorker = ConsumeAsync(_tradeRequests.Reader);
        _dataWorker = ConsumeAsync(_dataRequests.Reader);
    }

    public Task Faulted => _faulted.Task;

    public async ValueTask RouteAsync(
        string payloadJson,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);
        cancellationToken.ThrowIfCancellationRequested();
        if (Volatile.Read(ref _stopped) != 0)
        {
            throw new InvalidOperationException("bridge_inbound_dispatcher_stopped");
        }

        var priority = ReadRequestPriority(payloadJson);
        if (priority is null)
        {
            await _routeHandler(payloadJson, cancellationToken);
            return;
        }

        var writer = priority == BridgeMessagePriority.Trade
            ? _tradeRequests.Writer
            : _dataRequests.Writer;
        if (!writer.TryWrite(payloadJson))
        {
            throw new InvalidDataException(priority == BridgeMessagePriority.Trade
                ? "bridge_inbound_trade_capacity_exceeded"
                : "bridge_inbound_data_capacity_exceeded");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0)
        {
            return;
        }
        _tradeRequests.Writer.TryComplete();
        _dataRequests.Writer.TryComplete();
        await _shutdown.CancelAsync();
        await Task.WhenAll(_tradeWorker, _dataWorker);
        _shutdown.Dispose();
    }

    private static Channel<string> CreateQueue(int capacity) =>
        Channel.CreateBounded<string>(new BoundedChannelOptions(capacity)
        {
            SingleReader = true,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false,
        });

    private async Task ConsumeAsync(ChannelReader<string> reader)
    {
        try
        {
            await foreach (var payloadJson in reader.ReadAllAsync(_shutdown.Token))
            {
                await _routeHandler(payloadJson, _shutdown.Token);
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            _faulted.TrySetException(error);
            _tradeRequests.Writer.TryComplete(error);
            _dataRequests.Writer.TryComplete(error);
            await _shutdown.CancelAsync();
        }
    }

    private static BridgeMessagePriority? ReadRequestPriority(string payloadJson)
    {
        using var document = JsonDocument.Parse(payloadJson, new JsonDocumentOptions
        {
            MaxDepth = 64,
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
        });
        if (!document.RootElement.TryGetProperty("type", out var typeElement)
            || typeElement.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        return typeElement.GetString() switch
        {
            "command" => BridgeMessagePriority.Trade,
            "quote_request" or "data_request" => BridgeMessagePriority.Data,
            _ => null,
        };
    }
}
