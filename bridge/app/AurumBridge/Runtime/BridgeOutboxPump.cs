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
            if (!TryClaim(message.MessageId))
            {
                continue;
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
                ReleaseClaim(message.MessageId);
                throw;
            }
        }
        return queued;
    }

    public bool TryClaim(string messageId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(messageId);
        lock (_sync)
        {
            return _queued.Add(messageId);
        }
    }

    public void ReleaseClaim(string messageId)
    {
        lock (_sync)
        {
            _queued.Remove(messageId);
        }
    }

    public void HandleAcknowledgement(string messageId, string status)
    {
        // A gap stays suppressed for this connection while the Worker produces
        // a full snapshot. A reconnect gets one more replay opportunity.
        if (status is not ("applied" or "duplicate"))
        {
            return;
        }
        ReleaseClaim(messageId);
    }
}
