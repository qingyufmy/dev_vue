using System.Text.Json;
using System.Threading.Channels;

namespace AurumBridge.Runtime;

public sealed class BridgeInboundRequestDispatcher : IAsyncDisposable
{
    private const int DefaultTradeCapacity = 128;
    private const int DefaultDataCapacity = 96;
    private const int DataWorkerCount = 4;
    private const string InvalidTradeRoute = "__invalid_terminal_route__";

    private readonly Func<string, CancellationToken, Task> _routeHandler;
    private readonly Channel<string> _dataRequests;
    private readonly SemaphoreSlim _tradeSlots;
    private readonly SemaphoreSlim _dataSlots;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly TaskCompletionSource _faulted = new(
        TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _tradeSync = new();
    private readonly Dictionary<string, Task> _tradeTails = new(StringComparer.Ordinal);
    private readonly Task[] _dataWorkers;
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
        _tradeSlots = new(tradeCapacity, tradeCapacity);
        _dataSlots = new(dataCapacity, dataCapacity);
        _dataRequests = Channel.CreateBounded<string>(new BoundedChannelOptions(dataCapacity)
        {
            SingleReader = false,
            SingleWriter = true,
            FullMode = BoundedChannelFullMode.Wait,
            AllowSynchronousContinuations = false,
        });
        _dataWorkers = Enumerable.Range(0, DataWorkerCount)
            .Select(_ => ConsumeDataAsync())
            .ToArray();
    }

    public Task Faulted => _faulted.Task;

    public async ValueTask RouteAsync(
        string payloadJson,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);
        cancellationToken.ThrowIfCancellationRequested();
        ThrowIfStopped();

        var request = ReadRequestRoute(payloadJson);
        if (request is null)
        {
            await _routeHandler(payloadJson, cancellationToken);
            return;
        }
        if (request.Priority == BridgeMessagePriority.Trade)
        {
            ScheduleTrade(request.TerminalInstanceId ?? InvalidTradeRoute, payloadJson);
            return;
        }

        if (!_dataSlots.Wait(0))
        {
            throw new InvalidDataException("bridge_inbound_data_capacity_exceeded");
        }
        if (!_dataRequests.Writer.TryWrite(payloadJson))
        {
            _dataSlots.Release();
            throw new InvalidDataException("bridge_inbound_data_capacity_exceeded");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0)
        {
            return;
        }
        _dataRequests.Writer.TryComplete();
        await _shutdown.CancelAsync();
        Task[] tradeTails;
        lock (_tradeSync)
        {
            tradeTails = _tradeTails.Values.ToArray();
        }
        await Task.WhenAll(_dataWorkers.Concat(tradeTails));
        _tradeSlots.Dispose();
        _dataSlots.Dispose();
        _shutdown.Dispose();
    }

    private void ScheduleTrade(string terminalInstanceId, string payloadJson)
    {
        if (!_tradeSlots.Wait(0))
        {
            throw new InvalidDataException("bridge_inbound_trade_capacity_exceeded");
        }
        lock (_tradeSync)
        {
            if (Volatile.Read(ref _stopped) != 0 || _shutdown.IsCancellationRequested)
            {
                _tradeSlots.Release();
                throw new InvalidOperationException("bridge_inbound_dispatcher_stopped");
            }
            var previous = _tradeTails.GetValueOrDefault(terminalInstanceId, Task.CompletedTask);
            _tradeTails[terminalInstanceId] = RunTradeAsync(previous, payloadJson);
        }
    }

    private async Task RunTradeAsync(Task previous, string payloadJson)
    {
        await Task.Yield();
        try
        {
            await previous;
            _shutdown.Token.ThrowIfCancellationRequested();
            await _routeHandler(payloadJson, _shutdown.Token);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            await SignalFaultAsync(error);
        }
        finally
        {
            _tradeSlots.Release();
        }
    }

    private async Task ConsumeDataAsync()
    {
        try
        {
            await foreach (var payloadJson in _dataRequests.Reader.ReadAllAsync(_shutdown.Token))
            {
                try
                {
                    await _routeHandler(payloadJson, _shutdown.Token);
                }
                finally
                {
                    _dataSlots.Release();
                }
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            await SignalFaultAsync(error);
        }
    }

    private async Task SignalFaultAsync(Exception error)
    {
        if (_faulted.TrySetException(error))
        {
            _dataRequests.Writer.TryComplete(error);
            await _shutdown.CancelAsync();
        }
    }

    private void ThrowIfStopped()
    {
        if (Volatile.Read(ref _stopped) != 0 || _shutdown.IsCancellationRequested)
        {
            throw new InvalidOperationException("bridge_inbound_dispatcher_stopped");
        }
    }

    private static InboundRequestRoute? ReadRequestRoute(string payloadJson)
    {
        using var document = JsonDocument.Parse(payloadJson, new JsonDocumentOptions
        {
            MaxDepth = 64,
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
        });
        var root = document.RootElement;
        if (!root.TryGetProperty("type", out var typeElement)
            || typeElement.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        return typeElement.GetString() switch
        {
            "command" => new(
                BridgeMessagePriority.Trade,
                root.TryGetProperty("terminal_instance_id", out var terminalElement)
                    && terminalElement.ValueKind == JsonValueKind.String
                        ? terminalElement.GetString()
                        : null),
            "quote_request" or "data_request" => new(BridgeMessagePriority.Data, null),
            _ => null,
        };
    }

    private sealed record InboundRequestRoute(
        BridgeMessagePriority Priority,
        string? TerminalInstanceId);
}
