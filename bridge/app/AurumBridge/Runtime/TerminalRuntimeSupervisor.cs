using AurumBridge.Protocol;

namespace AurumBridge.Runtime;

public enum TerminalRuntimeState
{
    Stopped,
    Starting,
    Running,
    Restarting,
}

public sealed record TerminalRuntimeStatus(
    string TerminalInstanceId,
    TerminalRuntimeState State,
    int ConsecutiveFailures,
    string? ErrorCode);

public sealed class TerminalRuntimeSupervisor : IAsyncDisposable
{
    private const int DefaultMaximumConsecutiveFailures = 8;
    private static readonly TimeSpan DefaultStableRunThreshold = TimeSpan.FromSeconds(30);
    private readonly TerminalDescriptor _terminal;
    private readonly Func<IBridgeTerminalRuntime> _runtimeFactory;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly TimeSpan _stableRunThreshold;
    private readonly int _maximumConsecutiveFailures;
    private readonly IDisposable? _lifetimeLease;
    private readonly CancellationTokenSource _stop = new();
    private readonly TaskCompletionSource _stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private IBridgeTerminalRuntime? _current;
    private int _runStarted;
    private bool _disposed;

    public TerminalRuntimeSupervisor(
        TerminalDescriptor terminal,
        Func<IBridgeTerminalRuntime> runtimeFactory,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        TimeSpan? stableRunThreshold = null,
        int maximumConsecutiveFailures = DefaultMaximumConsecutiveFailures,
        IDisposable? lifetimeLease = null)
    {
        _terminal = terminal ?? throw new ArgumentNullException(nameof(terminal));
        _runtimeFactory = runtimeFactory ?? throw new ArgumentNullException(nameof(runtimeFactory));
        _delay = delay ?? Task.Delay;
        _stableRunThreshold = stableRunThreshold ?? DefaultStableRunThreshold;
        if (_stableRunThreshold <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(stableRunThreshold));
        }
        if (maximumConsecutiveFailures is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumConsecutiveFailures));
        }
        _maximumConsecutiveFailures = maximumConsecutiveFailures;
        _lifetimeLease = lifetimeLease;
    }

    public TerminalDescriptor Terminal => _terminal;
    public bool IsRunning => Volatile.Read(ref _current) is not null;
    public event Action<TerminalRuntimeStatus>? StatusChanged;

    public async Task RunAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (Interlocked.Exchange(ref _runStarted, 1) != 0)
        {
            throw new InvalidOperationException("Terminal supervisor is already running.");
        }

        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            _stop.Token);
        var runCancellation = linkedCancellation.Token;
        var failures = 0;
        try
        {
            while (!runCancellation.IsCancellationRequested)
            {
                Publish(failures == 0 ? TerminalRuntimeState.Starting : TerminalRuntimeState.Restarting, failures);
                IBridgeTerminalRuntime? runtime = null;
                try
                {
                    runtime = _runtimeFactory();
                    ValidateRuntime(runtime);
                    await runtime.StartAsync(runCancellation);
                    Volatile.Write(ref _current, runtime);
                    Publish(TerminalRuntimeState.Running, failures);
                    var collectionTask = runtime.RunCollectionLoopAsync(runCancellation);
                    var stableRunTask = Task.Delay(_stableRunThreshold, runCancellation);
                    if (await Task.WhenAny(collectionTask, stableRunTask) == stableRunTask)
                    {
                        await stableRunTask;
                        failures = 0;
                        Publish(TerminalRuntimeState.Running, failures);
                    }
                    await collectionTask;
                    if (!runCancellation.IsCancellationRequested)
                    {
                        throw new InvalidOperationException("terminal_collection_loop_stopped");
                    }
                }
                catch (OperationCanceledException) when (runCancellation.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception error)
                {
                    failures = Math.Min(failures + 1, _maximumConsecutiveFailures);
                    var errorCode = NormalizeError(error);
                    Publish(TerminalRuntimeState.Restarting, failures, errorCode);
                }
                finally
                {
                    Interlocked.CompareExchange(ref _current, null, runtime);
                    if (runtime is not null)
                    {
                        await TryDisposeAsync(runtime);
                    }
                }

                if (!runCancellation.IsCancellationRequested)
                {
                    await _delay(RestartDelay(failures), runCancellation);
                }
            }
        }
        catch (OperationCanceledException) when (runCancellation.IsCancellationRequested)
        {
        }
        finally
        {
            Publish(TerminalRuntimeState.Stopped, failures);
            _stopped.TrySetResult();
        }
    }

    public Task<CommandResultMessage> ExecuteCommandAsync(
        CommandMessage command,
        CancellationToken cancellationToken = default)
    {
        var runtime = Volatile.Read(ref _current)
            ?? throw new InvalidOperationException("terminal_worker_unavailable");
        return runtime.ExecuteCommandAsync(command, cancellationToken);
    }

    public Task<QuoteMessage> GetQuoteAsync(
        QuoteRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        var runtime = Volatile.Read(ref _current)
            ?? throw new InvalidOperationException("terminal_worker_unavailable");
        return runtime.GetQuoteAsync(request, cancellationToken);
    }

    public Task<DataResponseMessage> GetDataAsync(
        DataRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        var runtime = Volatile.Read(ref _current)
            ?? throw new InvalidOperationException("terminal_worker_unavailable");
        return runtime.GetDataAsync(request, cancellationToken);
    }

    public bool RequestFullSnapshot(string stream, long connectionEpoch)
    {
        if (connectionEpoch != _terminal.ConnectionEpoch)
        {
            return false;
        }
        var runtime = Volatile.Read(ref _current);
        if (runtime is null)
        {
            return false;
        }
        runtime.RequestFullSnapshot(stream);
        return true;
    }

    public IReadOnlyDictionary<string, long> GetStreamFreshness() =>
        Volatile.Read(ref _current)?.GetStreamFreshness()
        ?? new Dictionary<string, long>(StringComparer.Ordinal);

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _stop.Cancel();
        if (Volatile.Read(ref _runStarted) != 0)
        {
            await _stopped.Task;
        }
        _lifetimeLease?.Dispose();
        _stop.Dispose();
    }

    private void ValidateRuntime(IBridgeTerminalRuntime runtime)
    {
        if (!string.Equals(runtime.Terminal.TerminalInstanceId, _terminal.TerminalInstanceId, StringComparison.Ordinal)
            || runtime.Terminal.ConnectionEpoch != _terminal.ConnectionEpoch)
        {
            throw new InvalidOperationException("terminal_runtime_identity_mismatch");
        }
    }

    private void Publish(
        TerminalRuntimeState state,
        int failures,
        string? errorCode = null) =>
        StatusChanged?.Invoke(new(_terminal.TerminalInstanceId, state, failures, errorCode));

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
        TimeoutException => "terminal_worker_timeout",
        InvalidDataException => "terminal_worker_protocol_error",
        IOException => "terminal_worker_io_error",
        _ => "terminal_worker_failure",
    };

    private static async ValueTask TryDisposeAsync(IBridgeTerminalRuntime runtime)
    {
        try
        {
            await runtime.DisposeAsync();
        }
        catch
        {
            // Worker cleanup must not prevent the supervisor from replacing it.
        }
    }
}
