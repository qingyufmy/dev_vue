using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public sealed class BridgeOutboxPump
{
    private const long InitialRetryDelayMsc = 2_000;
    private const long MaximumRetryDelayMsc = 30_000;
    private readonly BridgeStore _store;
    private readonly PriorityMessageQueue _outbound;
    private readonly Func<long> _clock;
    private readonly Dictionary<string, ClaimState> _queued = new(StringComparer.Ordinal);
    private readonly object _sync = new();
    private sealed record ClaimState(int AttemptCount, long RetryAtUtcMsc);

    public BridgeOutboxPump(
        BridgeStore store,
        PriorityMessageQueue outbound,
        Func<long>? clock = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _outbound = outbound ?? throw new ArgumentNullException(nameof(outbound));
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async Task<int> PumpOnceAsync(CancellationToken cancellationToken = default)
    {
        var now = _clock();
        var messages = await _store.GetReadyOutboxAsync(now, 200, cancellationToken);
        var queued = 0;
        foreach (var message in messages)
        {
            if (!TryClaim(message, now))
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

    public async Task<bool> RecordSuccessfulSendAsync(
        string messageId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(messageId);
        ClaimState claim;
        lock (_sync)
        {
            if (!_queued.TryGetValue(messageId, out claim!))
            {
                return false;
            }
        }

        var now = _clock();
        var retryAt = checked(now + RetryDelayMsc(claim.AttemptCount));
        if (!await _store.RecordOutboxAttemptAsync(
                messageId, claim.AttemptCount, retryAt, cancellationToken))
        {
            ReleaseClaim(messageId);
            return false;
        }

        lock (_sync)
        {
            if (_queued.TryGetValue(messageId, out var current) && current == claim)
            {
                _queued[messageId] = new(claim.AttemptCount + 1, retryAt);
            }
        }
        return true;
    }

    public bool TryClaim(string messageId, int attemptCount)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(messageId);
        if (attemptCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(attemptCount));
        }
        lock (_sync)
        {
            return _queued.TryAdd(messageId, new(attemptCount, long.MaxValue));
        }
    }

    private bool TryClaim(OutboxMessage message, long nowUtcMsc)
    {
        lock (_sync)
        {
            if (_queued.TryGetValue(message.MessageId, out var current)
                && current.RetryAtUtcMsc > nowUtcMsc)
            {
                return false;
            }
            _queued[message.MessageId] = new(message.AttemptCount, long.MaxValue);
            return true;
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
        if (status == "gap")
        {
            lock (_sync)
            {
                if (_queued.TryGetValue(messageId, out var current))
                {
                    _queued[messageId] = current with { RetryAtUtcMsc = long.MaxValue };
                }
            }
            return;
        }
        if (status is not ("applied" or "duplicate"))
        {
            return;
        }
        ReleaseClaim(messageId);
    }

    private static long RetryDelayMsc(int attemptCount)
    {
        var exponent = Math.Clamp(attemptCount, 0, 4);
        return Math.Min(MaximumRetryDelayMsc, InitialRetryDelayMsc << exponent);
    }
}
