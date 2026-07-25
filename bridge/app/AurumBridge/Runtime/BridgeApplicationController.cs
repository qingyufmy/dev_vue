using AurumBridge.Security;
using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public enum BridgeApplicationPhase
{
    Starting,
    DetectingTerminal,
    TerminalNotFound,
    PairingRequired,
    Connecting,
    Online,
    Degraded,
    Stopped,
}

public sealed record BridgeTerminalStatus(
    string TerminalInstanceId,
    string Platform,
    string BrokerServer,
    string Login,
    TerminalRuntimeState RuntimeState,
    string? ErrorCode);

public sealed record BridgeApplicationStatus(
    BridgeApplicationPhase Phase,
    IReadOnlyList<BridgeTerminalStatus> Terminals,
    string? DetailCode);

public sealed class BridgeApplicationController : IAsyncDisposable
{
    private readonly BridgeRuntimePaths _paths;
    private readonly BridgeStore _store;
    private readonly HttpClient _httpClient;
    private readonly BridgeSessionClient _sessionClient;
    private readonly Mt5RuntimeProvisioner _provisioner;
    private readonly CancellationTokenSource _stop = new();
    private readonly Lock _sync = new();
    private readonly Dictionary<string, BridgeTerminalStatus> _terminalStatuses = new(StringComparer.Ordinal);
    private CancellationTokenSource? _cycleCancellation;
    private Task? _runTask;
    private BridgeApplicationPhase _phase = BridgeApplicationPhase.Starting;
    private string? _detailCode;
    private bool _disposed;

    public BridgeApplicationController(BridgeRuntimePaths paths)
    {
        _paths = paths ?? throw new ArgumentNullException(nameof(paths));
        Directory.CreateDirectory(paths.DataDirectory);
        _store = new(Path.Combine(paths.DataDirectory, "bridge.db"));
        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
        var credentials = new FileBridgeCredentialStore(
            Path.Combine(paths.DataDirectory, "credential.dat"),
            new WindowsDpapiProtector());
        _sessionClient = new(paths.ServerBaseUri, _httpClient, credentials);
        _provisioner = new(
            _store,
            paths.PythonExecutable,
            paths.Mt5WorkerScript);
    }

    public event Action<BridgeApplicationStatus>? StatusChanged;
    public BridgeRuntimePaths Paths => _paths;

    public Task RunAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        lock (_sync)
        {
            if (_runTask is not null)
            {
                throw new InvalidOperationException("Bridge application controller is already running.");
            }
            _runTask = RunCoreAsync(cancellationToken);
            return _runTask;
        }
    }

    public async Task PairAsync(
        Func<BridgePairingPrompt, Task> showVerification,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _sessionClient.PairAsync(Environment.MachineName, showVerification, cancellationToken);
        RequestRedetect();
    }

    public void RequestRedetect()
    {
        lock (_sync)
        {
            _cycleCancellation?.Cancel();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _stop.Cancel();
        RequestRedetect();
        Task? runTask;
        lock (_sync)
        {
            runTask = _runTask;
        }
        if (runTask is not null)
        {
            try
            {
                await runTask;
            }
            catch (OperationCanceledException)
            {
            }
        }
        _httpClient.Dispose();
        await _store.DisposeAsync();
        _stop.Dispose();
    }

    private async Task RunCoreAsync(CancellationToken cancellationToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        var stopping = lifetime.Token;
        try
        {
            await _store.InitializeAsync(stopping);
            while (!stopping.IsCancellationRequested)
            {
                using var cycle = CancellationTokenSource.CreateLinkedTokenSource(stopping);
                lock (_sync)
                {
                    _cycleCancellation = cycle;
                }
                try
                {
                    await RunCycleAsync(cycle.Token);
                }
                catch (OperationCanceledException) when (cycle.IsCancellationRequested)
                {
                }
                finally
                {
                    lock (_sync)
                    {
                        if (ReferenceEquals(_cycleCancellation, cycle))
                        {
                            _cycleCancellation = null;
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            Publish(BridgeApplicationPhase.Degraded, NormalizeApplicationError(error));
            throw;
        }
        finally
        {
            Publish(BridgeApplicationPhase.Stopped);
        }
    }

    private async Task RunCycleAsync(CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            _terminalStatuses.Clear();
        }
        Publish(BridgeApplicationPhase.DetectingTerminal);
        var installations = Mt5TerminalDiscovery.DiscoverWindows();
        if (installations.Count == 0)
        {
            Publish(BridgeApplicationPhase.TerminalNotFound, "mt5_terminal_not_found");
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return;
        }

        var result = await _provisioner.ProvisionAsync(installations, cancellationToken);
        if (result.Terminals.Count == 0)
        {
            Publish(
                BridgeApplicationPhase.TerminalNotFound,
                result.Failures.FirstOrDefault()?.ErrorCode ?? "mt5_account_unavailable");
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return;
        }
        foreach (var terminal in result.Terminals)
        {
            var descriptor = terminal.Supervisor.Terminal;
            lock (_sync)
            {
                _terminalStatuses[descriptor.TerminalInstanceId] = new(
                    descriptor.TerminalInstanceId,
                    descriptor.Platform,
                    descriptor.AccountRef.BrokerServer,
                    descriptor.AccountRef.Login,
                    TerminalRuntimeState.Starting,
                    null);
            }
            terminal.Supervisor.StatusChanged += HandleTerminalStatus;
        }
        if (result.Failures.Count > 0)
        {
            Publish(BridgeApplicationPhase.Degraded, result.Failures[0].ErrorCode);
        }

        await using var host = new BridgeHost(
            _store,
            result.Terminals.Select(terminal => terminal.Supervisor));
        var webSocket = new BridgeWebSocketClient(_store, host.CommandDispatcher);
        webSocket.FullSnapshotRequired += host.HandleFullSnapshotRequestAsync;
        var connection = new BridgeConnectionSupervisor(
            host.Terminals,
            typeof(BridgeApplicationController).Assembly.GetName().Version?.ToString() ?? "3.0.0",
            _sessionClient.AcquireConnectionAttemptAsync,
            (attempt, ready, token) => webSocket.RunSessionAsync(attempt, ready, token));
        connection.StatusChanged += HandleConnectionStatus;

        using var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var hostTask = host.RunAsync(runCancellation.Token);
        var connectionTask = connection.RunAsync(runCancellation.Token);
        try
        {
            await Task.WhenAll(hostTask, connectionTask);
        }
        finally
        {
            runCancellation.Cancel();
            await IgnoreCancellationAsync(hostTask);
            await IgnoreCancellationAsync(connectionTask);
        }
    }

    private void HandleTerminalStatus(TerminalRuntimeStatus status)
    {
        lock (_sync)
        {
            if (_terminalStatuses.TryGetValue(status.TerminalInstanceId, out var current))
            {
                _terminalStatuses[status.TerminalInstanceId] = current with
                {
                    RuntimeState = status.State,
                    ErrorCode = status.ErrorCode,
                };
            }
        }
        PublishCurrent();
    }

    private void HandleConnectionStatus(BridgeConnectionStatus status)
    {
        var phase = status.State switch
        {
            BridgeConnectionState.PairingRequired => BridgeApplicationPhase.PairingRequired,
            BridgeConnectionState.Connecting or BridgeConnectionState.Reconnecting => BridgeApplicationPhase.Connecting,
            BridgeConnectionState.Connected => BridgeApplicationPhase.Online,
            BridgeConnectionState.Stopped when _stop.IsCancellationRequested => BridgeApplicationPhase.Stopped,
            _ => _phase,
        };
        Publish(phase, status.ErrorCode);
    }

    private void Publish(BridgeApplicationPhase phase, string? detailCode = null)
    {
        BridgeApplicationStatus snapshot;
        lock (_sync)
        {
            _phase = phase;
            _detailCode = detailCode;
            snapshot = Snapshot();
        }
        StatusChanged?.Invoke(snapshot);
    }

    private void PublishCurrent()
    {
        BridgeApplicationStatus snapshot;
        lock (_sync)
        {
            snapshot = Snapshot();
        }
        StatusChanged?.Invoke(snapshot);
    }

    private BridgeApplicationStatus Snapshot() => new(
        _phase,
        _terminalStatuses.Values.OrderBy(value => value.TerminalInstanceId).ToArray(),
        _detailCode);

    private static string NormalizeApplicationError(Exception error) => error switch
    {
        FileNotFoundException fileError => fileError.Message,
        UnauthorizedAccessException => "bridge_data_directory_denied",
        IOException => "bridge_local_io_failed",
        _ => "bridge_start_failed",
    };

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
