using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public sealed class BridgeOutboxPump
{
    private readonly BridgeStore _store;
    private readonly PriorityMessageQueue _outbound;
    private readonly HashSet<string> _queued = new(StringComparer.Ordinal);
    private readonly object _sync = new();

    public BridgeOutboxPump(BridgeStore store, PriorityMessageQueue outbound)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _outbound = outbound ?? throw new ArgumentNullException(nameof(outbound));
    }

    public async Task<int> PumpOnceAsync(CancellationToken cancellationToken = default)
    {
        var messages = await _store.GetPendingOutboxAsync(200, cancellationToken);
        var queued = 0;
        foreach (var message in messages)
        {
            lock (_sync)
            {
                if (!_queued.Add(message.MessageId))
                {
                    continue;
                }
            }
            try
            {
                await _outbound.EnqueueAsync(new(
                    message.MessageId,
                    message.PayloadJson,
                    message.Priority == "trade" ? BridgeMessagePriority.Trade : BridgeMessagePriority.Data),
                cancellationToken);
                queued++;
            }
            catch
            {
                lock (_sync)
                {
                    _queued.Remove(message.MessageId);
                }
                throw;
            }
        }
        return queued;
    }

    public void HandleAcknowledgement(string messageId, string status)
    {
        // A gap stays suppressed for this connection while the Worker produces
        // a full snapshot. A reconnect gets one more replay opportunity.
        if (status is not ("applied" or "duplicate"))
        {
            return;
        }
        lock (_sync)
        {
            _queued.Remove(messageId);
        }
    }
}
