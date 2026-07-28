using System.Net.WebSockets;
using AurumBridge.Protocol;

namespace AurumBridge.Runtime;

public enum BridgeConnectionState
{
    Stopped,
    PairingRequired,
    Connecting,
    Connected,
    Reconnecting,
}

public sealed record BridgeConnectionStatus(
    BridgeConnectionState State,
    int ConsecutiveFailures,
    string? ErrorCode);

public sealed class BridgeConnectionSupervisor
{
    private readonly IReadOnlyList<TerminalDescriptor> _terminals;
    private readonly string _bridgeVersion;
    private readonly Func<HelloMessage, CancellationToken, Task<BridgeConnectionAttempt>> _acquireAttempt;
    private readonly Func<BridgeConnectionAttempt, Action, CancellationToken, Task> _runSession;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<long> _clock;
    private readonly BridgeHelloMetadata? _helloMetadata;
    private int _runStarted;

    public BridgeConnectionSupervisor(
        IReadOnlyList<TerminalDescriptor> terminals,
        string bridgeVersion,
        Func<HelloMessage, CancellationToken, Task<BridgeConnectionAttempt>> acquireAttempt,
        Func<BridgeConnectionAttempt, Action, CancellationToken, Task> runSession,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<long>? clock = null,
        BridgeHelloMetadata? helloMetadata = null)
    {
        ArgumentNullException.ThrowIfNull(terminals);
        if (terminals.Count is < 1 or > 32)
        {
            throw new ArgumentOutOfRangeException(nameof(terminals), "A bridge session requires 1 to 32 terminals.");
        }
        ArgumentException.ThrowIfNullOrWhiteSpace(bridgeVersion);
        _terminals = terminals.ToArray();
        _bridgeVersion = bridgeVersion.Trim();
        _acquireAttempt = acquireAttempt ?? throw new ArgumentNullException(nameof(acquireAttempt));
        _runSession = runSession ?? throw new ArgumentNullException(nameof(runSession));
        _delay = delay ?? Task.Delay;
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        _helloMetadata = helloMetadata;
    }

    public event Action<BridgeConnectionStatus>? StatusChanged;
    public event Action<Exception>? FailureObserved;

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref _runStarted, 1) != 0)
        {
            throw new InvalidOperationException("Bridge connection supervisor is already running.");
        }
        var failures = 0;
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                Publish(failures == 0 ? BridgeConnectionState.Connecting : BridgeConnectionState.Reconnecting, failures);
                try
                {
                    var hello = CreateHello();
                    var attempt = await _acquireAttempt(hello, cancellationToken);
                    await _runSession(
                        attempt,
                        () =>
                        {
                            failures = 0;
                            Publish(BridgeConnectionState.Connected, failures);
                        },
                        cancellationToken);
                    if (!cancellationToken.IsCancellationRequested)
                    {
                        throw new WebSocketException("bridge_session_closed");
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception error)
                {
                    try
                    {
                        FailureObserved?.Invoke(error);
                    }
                    catch
                    {
                        // Diagnostics must never interrupt the reconnect loop.
                    }
                    failures++;
                    var errorCode = NormalizeError(error);
                    var state = errorCode == "bridge_not_paired"
                        ? BridgeConnectionState.PairingRequired
                        : BridgeConnectionState.Reconnecting;
                    Publish(state, failures, errorCode);
                    if (state == BridgeConnectionState.PairingRequired)
                    {
                        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                    }
                }
                if (!cancellationToken.IsCancellationRequested)
                {
                    await _delay(RestartDelay(failures), cancellationToken);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            Publish(BridgeConnectionState.Stopped, failures);
        }
    }

    private HelloMessage CreateHello()
    {
        var now = _clock();
        return new()
        {
            Type = "hello",
            MessageId = $"hello_{Guid.NewGuid():N}",
            SentAtUtcMsc = now,
            SessionId = $"session_{Guid.NewGuid():N}",
            BridgeVersion = _bridgeVersion,
            InstallationId = _helloMetadata?.InstallationId,
            UpdateReport = _helloMetadata?.UpdateReport,
            Terminals = _terminals,
        };
    }

    private void Publish(BridgeConnectionState state, int failures, string? errorCode = null) =>
        StatusChanged?.Invoke(new(state, failures, errorCode));

    private static TimeSpan RestartDelay(int failures)
    {
        var seconds = failures switch
        {
            <= 1 => 1,
            2 => 2,
            3 => 4,
            4 => 8,
            _ => 10,
        };
        return TimeSpan.FromSeconds(seconds);
    }

    private static string NormalizeError(Exception error) => error switch
    {
        BridgeApiException apiError => apiError.Code,
        TimeoutException => "bridge_connection_timeout",
        WebSocketException => "bridge_connection_lost",
        HttpRequestException => "bridge_server_unreachable",
        InvalidDataException => "bridge_server_protocol_error",
        _ => "bridge_connection_failed",
    };
}
