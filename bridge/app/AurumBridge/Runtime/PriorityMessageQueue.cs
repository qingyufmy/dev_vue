using System.Collections.Concurrent;

namespace AurumBridge.Runtime;

public enum BridgeMessagePriority
{
    Trade,
    Data,
}

public sealed record OutboundBridgeMessage(
    string MessageId,
    string PayloadJson,
    BridgeMessagePriority Priority);

public sealed class PriorityMessageQueue
{
    private readonly ConcurrentQueue<OutboundBridgeMessage> _trade = new();
    private readonly ConcurrentQueue<OutboundBridgeMessage> _data = new();
    private readonly SemaphoreSlim _items = new(0);
    private readonly SemaphoreSlim _tradeSlots;
    private readonly SemaphoreSlim _dataSlots;

    public PriorityMessageQueue(int tradeCapacity = 256, int dataCapacity = 2_048)
    {
        if (tradeCapacity <= 0 || dataCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(tradeCapacity));
        }
        _tradeSlots = new(tradeCapacity, tradeCapacity);
        _dataSlots = new(dataCapacity, dataCapacity);
    }

    public async ValueTask EnqueueAsync(
        OutboundBridgeMessage message,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(message);
        var slots = message.Priority == BridgeMessagePriority.Trade ? _tradeSlots : _dataSlots;
        var queue = message.Priority == BridgeMessagePriority.Trade ? _trade : _data;
        await slots.WaitAsync(cancellationToken);
        queue.Enqueue(message);
        _items.Release();
    }

    public async ValueTask<OutboundBridgeMessage> DequeueAsync(
        CancellationToken cancellationToken = default)
    {
        await _items.WaitAsync(cancellationToken);
        if (_trade.TryDequeue(out var trade))
        {
            _tradeSlots.Release();
            return trade;
        }
        if (_data.TryDequeue(out var data))
        {
            _dataSlots.Release();
            return data;
        }
        throw new InvalidOperationException("Priority queue item signal was inconsistent.");
    }
}
