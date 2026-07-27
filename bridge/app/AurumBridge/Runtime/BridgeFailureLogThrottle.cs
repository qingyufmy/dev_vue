using System.Net.WebSockets;

namespace AurumBridge.Runtime;

public sealed record BridgeFailureLogDecision(
    bool ShouldLog,
    string ErrorCode,
    int SuppressedCount);

public sealed class BridgeFailureLogThrottle
{
    private readonly TimeSpan _interval;
    private readonly Func<long> _clock;
    private readonly Lock _sync = new();
    private readonly Dictionary<string, FailureState> _states = new(StringComparer.Ordinal);

    public BridgeFailureLogThrottle(
        TimeSpan interval,
        Func<long>? clock = null)
    {
        if (interval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(interval));
        }
        _interval = interval;
        _clock = clock ?? (() => Environment.TickCount64);
    }

    public BridgeFailureLogDecision Observe(string scope, Exception error)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scope);
        ArgumentNullException.ThrowIfNull(error);
        var now = _clock();
        var errorCode = NormalizeError(error);
        var key = $"{scope.Trim()}:{errorCode}";
        lock (_sync)
        {
            if (!_states.TryGetValue(key, out var state))
            {
                _states[key] = new(now, 0);
                return new(true, errorCode, 0);
            }
            var elapsed = TimeSpan.FromMilliseconds(Math.Max(0, now - state.LastLoggedAt));
            if (elapsed < _interval)
            {
                _states[key] = state with { SuppressedCount = state.SuppressedCount + 1 };
                return new(false, errorCode, state.SuppressedCount + 1);
            }
            _states[key] = new(now, 0);
            return new(true, errorCode, state.SuppressedCount);
        }
    }

    public void Reset(string scope)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scope);
        var prefix = $"{scope.Trim()}:";
        lock (_sync)
        {
            foreach (var key in _states.Keys
                .Where(key => key.StartsWith(prefix, StringComparison.Ordinal))
                .ToArray())
            {
                _states.Remove(key);
            }
        }
    }

    public static string NormalizeError(Exception error) => error switch
    {
        BridgeApiException apiError => apiError.Code,
        TimeoutException or TaskCanceledException => "bridge_connection_timeout",
        WebSocketException => "bridge_connection_lost",
        HttpRequestException => "bridge_server_unreachable",
        InvalidDataException => "bridge_server_protocol_error",
        _ => "bridge_connection_failed",
    };

    private sealed record FailureState(long LastLoggedAt, int SuppressedCount);
}
