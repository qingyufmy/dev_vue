using AurumBridge.Security;
using AurumBridge.Storage;
using AurumBridge.Workers;
using System.Collections.Concurrent;

namespace AurumBridge.Runtime;

public enum BridgeApplicationPhase
{
    Starting,
    PlatformSelectionRequired,
    TerminalSelectionRequired,
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

public sealed record BridgeTerminalCandidate(
    string TerminalInstanceId,
    string Platform,
    string BrokerServer,
    string Login);

public sealed record BridgeApplicationStatus(
    BridgeApplicationPhase Phase,
    IReadOnlyList<BridgeTerminalStatus> Terminals,
    string? DetailCode)
{
    public string? SelectedPlatform { get; init; }
    public string? SelectedTerminalInstanceId { get; init; }
    public IReadOnlyList<BridgeTerminalCandidate> TerminalCandidates { get; init; } = [];
    public bool ServerConnected { get; init; }
    public long? LastDataSyncUtcMsc { get; init; }
    public string BridgeVersion { get; init; } = "3.0.0";
}

public sealed class BridgeApplicationController : IAsyncDisposable
{
    private readonly BridgeRuntimePaths _paths;
    private readonly BridgeStore _store;
    private readonly HttpClient _httpClient;
    private readonly BridgeSessionClient _sessionClient;
    private readonly Mt5RuntimeProvisioner _mt5Provisioner;
    private readonly Mt4RuntimeProvisioner _mt4Provisioner;
    private readonly CancellationTokenSource _stop = new();
    private readonly Lock _sync = new();
    private readonly Dictionary<string, BridgeTerminalStatus> _terminalStatuses = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<Mt4EaConnection> _pendingMt4Registrations = new();
    private CancellationTokenSource? _cycleCancellation;
    private Task? _runTask;
    private BridgeApplicationPhase _phase = BridgeApplicationPhase.Starting;
    private string? _detailCode;
    private BridgeCommandDispatcher? _activeCommandDispatcher;
    private bool _updatePreparation;
    private string? _selectedPlatform;
    private string? _selectedMt5TerminalId;
    private readonly string? _selectedMt5TerminalPath;
    private string? _activeMt5TerminalId;
    private IReadOnlyList<BridgeTerminalCandidate> _terminalCandidates = [];
    private bool _serverConnected;
    private long? _lastDataSyncUtcMsc;
    private bool _disposed;

    public BridgeApplicationController(
        BridgeRuntimePaths paths,
        string? selectedPlatform = null,
        string? selectedMt5TerminalId = null,
        string? selectedMt5TerminalPath = null)
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
        _mt5Provisioner = new(
            _store,
            paths.PythonExecutable,
            paths.Mt5WorkerScript);
        _mt4Provisioner = new(_store);
        _selectedPlatform = string.IsNullOrWhiteSpace(selectedPlatform)
            ? null
            : BridgePlatform.Normalize(selectedPlatform);
        _selectedMt5TerminalId = selectedMt5TerminalId;
        _selectedMt5TerminalPath = string.IsNullOrWhiteSpace(selectedMt5TerminalPath)
            ? null
            : Path.GetFullPath(selectedMt5TerminalPath);
    }

    public event Action<BridgeApplicationStatus>? StatusChanged;
    public event Action<Exception>? ConnectionFailureObserved;
    public BridgeRuntimePaths Paths => _paths;
    public string? SelectedPlatform
    {
        get
        {
            lock (_sync)
            {
                return _selectedPlatform;
            }
        }
    }

    public void SelectPlatform(string platform)
    {
        var normalized = BridgePlatform.Normalize(platform);
        lock (_sync)
        {
            if (_selectedPlatform == normalized)
            {
                return;
            }
            _selectedPlatform = normalized;
            _cycleCancellation?.Cancel();
        }
    }

    public void SelectTerminal(string terminalInstanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        lock (_sync)
        {
            if (!_terminalCandidates.Any(candidate =>
                    candidate.TerminalInstanceId == terminalInstanceId))
            {
                throw new ArgumentOutOfRangeException(
                    nameof(terminalInstanceId), terminalInstanceId, "Unknown terminal selection.");
            }
            _selectedMt5TerminalId = terminalInstanceId;
            _activeMt5TerminalId = terminalInstanceId;
            _cycleCancellation?.Cancel();
        }
    }

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

    public async Task<bool> LogoutAsync(CancellationToken cancellationToken = default)
    {
        var revoked = await _sessionClient.LogoutAsync(cancellationToken);
        RequestRedetect();
        return revoked;
    }

    public async Task PauseForUpdateAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        BridgeCommandDispatcher? dispatcher;
        lock (_sync)
        {
            if (_updatePreparation)
            {
                throw new InvalidOperationException("bridge_update_already_preparing");
            }
            _updatePreparation = true;
            dispatcher = _activeCommandDispatcher;
        }
        try
        {
            if (dispatcher is not null)
            {
                await dispatcher.PauseAndDrainAsync(timeout, cancellationToken);
            }
        }
        catch
        {
            lock (_sync)
            {
                _updatePreparation = false;
            }
            dispatcher?.Resume();
            throw;
        }
    }

    public void ResumeAfterFailedUpdate()
    {
        BridgeCommandDispatcher? dispatcher;
        lock (_sync)
        {
            _updatePreparation = false;
            dispatcher = _activeCommandDispatcher;
        }
        dispatcher?.Resume();
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
        while (_pendingMt4Registrations.TryDequeue(out var registration))
        {
            await registration.DisposeAsync();
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
                bool updatePreparation;
                lock (_sync)
                {
                    updatePreparation = _updatePreparation;
                }
                if (updatePreparation)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(100), stopping);
                    continue;
                }
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
            _terminalCandidates = [];
            _activeMt5TerminalId = null;
            _serverConnected = false;
        }
        var selectedPlatform = SelectedPlatform;
        if (selectedPlatform is null)
        {
            Publish(BridgeApplicationPhase.PlatformSelectionRequired);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return;
        }
        Publish(BridgeApplicationPhase.DetectingTerminal);
        var mt5 = new Mt5ProvisioningResult([], []);
        var mt4 = new Mt4ProvisioningResult([], []);
        if (selectedPlatform == BridgePlatform.Mt5)
        {
            while (_pendingMt4Registrations.TryDequeue(out var unusedRegistration))
            {
                await unusedRegistration.DisposeAsync();
            }
            var installations = ResolveMt5Installations(
                Mt5TerminalDiscovery.DiscoverWindows(),
                _selectedMt5TerminalPath);
            mt5 = await _mt5Provisioner.ProvisionAsync(installations, cancellationToken);
            if (mt5.Terminals.Count > 0)
            {
                mt5 = await SelectMt5TerminalAsync(mt5, cancellationToken);
            }
        }
        else
        {
            var registrations = new List<Mt4EaConnection>();
            while (_pendingMt4Registrations.TryDequeue(out var pendingRegistration))
            {
                registrations.Add(pendingRegistration);
            }
            registrations.AddRange(await Mt4RuntimeProvisioner.AcceptRegistrationsAsync(
                TimeSpan.FromMilliseconds(1_500), cancellationToken));
            mt4 = await _mt4Provisioner.ProvisionAsync(registrations, cancellationToken);
        }
        var supervisors = mt5.Terminals.Select(terminal => terminal.Supervisor)
            .Concat(mt4.Terminals.Select(terminal => terminal.Supervisor))
            .ToArray();
        if (supervisors.Length == 0)
        {
            Publish(
                BridgeApplicationPhase.TerminalNotFound,
                selectedPlatform == BridgePlatform.Mt5
                    ? mt5.Failures.FirstOrDefault()?.ErrorCode ?? "mt5_terminal_not_found"
                    : mt4.Failures.FirstOrDefault()?.ErrorCode ?? "mt4_registration_invalid");
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return;
        }

        foreach (var supervisor in supervisors)
        {
            var descriptor = supervisor.Terminal;
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
            supervisor.StatusChanged += HandleTerminalStatus;
        }
        var firstFailure = mt5.Failures.FirstOrDefault()?.ErrorCode
            ?? mt4.Failures.FirstOrDefault()?.ErrorCode;
        if (firstFailure is not null)
        {
            Publish(BridgeApplicationPhase.Degraded, firstFailure);
        }

        await using var host = new BridgeHost(_store, supervisors);
        bool pauseForUpdate;
        lock (_sync)
        {
            _activeCommandDispatcher = host.CommandDispatcher;
            pauseForUpdate = _updatePreparation;
        }
        if (pauseForUpdate)
        {
            await host.CommandDispatcher.PauseAndDrainAsync(
                TimeSpan.FromSeconds(30),
                cancellationToken);
        }
        var webSocket = new BridgeWebSocketClient(
            _store,
            host.CommandDispatcher,
            quoteHandler:host.GetQuoteAsync,
            dataHandler:host.GetDataAsync,
            initialSnapshotHandler:host.RequestAllFullSnapshotsAsync,
            heartbeatTerminalsProvider:host.GetTerminalStreamFreshness);
        webSocket.DataAcknowledged += status =>
        {
            if (status is "applied" or "duplicate")
            {
                lock (_sync)
                {
                    _lastDataSyncUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                }
                PublishCurrent();
            }
        };
        var synchronizedTerminals = new HashSet<string>(StringComparer.Ordinal);
        var synchronizationLock = new object();
        webSocket.InitialSynchronizationCompleted += terminalId =>
        {
            bool allSynchronized;
            lock (synchronizationLock)
            {
                synchronizedTerminals.Add(terminalId);
                allSynchronized = synchronizedTerminals.Count == host.Terminals.Count;
            }
            if (allSynchronized)
            {
                Publish(BridgeApplicationPhase.Online);
            }
        };
        webSocket.FullSnapshotRequired += host.HandleFullSnapshotRequestAsync;
        var connection = new BridgeConnectionSupervisor(
            host.Terminals,
            typeof(BridgeApplicationController).Assembly.GetName().Version?.ToString() ?? "3.0.0",
            _sessionClient.AcquireConnectionAttemptAsync,
            (attempt, ready, token) => webSocket.RunSessionAsync(attempt, ready, token));
        connection.FailureObserved += error => ConnectionFailureObserved?.Invoke(error);
        connection.StatusChanged += status =>
        {
            if (status.State is BridgeConnectionState.Connecting
                or BridgeConnectionState.Reconnecting
                or BridgeConnectionState.PairingRequired)
            {
                lock (synchronizationLock)
                {
                    synchronizedTerminals.Clear();
                }
            }
            HandleConnectionStatus(status);
        };

        using var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var hostTask = host.RunAsync(runCancellation.Token);
        var connectionTask = connection.RunAsync(runCancellation.Token);
        var registrationTask = selectedPlatform == BridgePlatform.Mt4
            ? WatchMt4RegistrationsAsync(runCancellation.Token)
            : Task.Delay(Timeout.InfiniteTimeSpan, runCancellation.Token);
        try
        {
            await Task.WhenAll(hostTask, connectionTask, registrationTask);
        }
        finally
        {
            lock (_sync)
            {
                if (ReferenceEquals(_activeCommandDispatcher, host.CommandDispatcher))
                {
                    _activeCommandDispatcher = null;
                }
            }
            runCancellation.Cancel();
            await IgnoreCancellationAsync(hostTask);
            await IgnoreCancellationAsync(connectionTask);
            await IgnoreCancellationAsync(registrationTask);
        }
    }

    public static IReadOnlyList<Mt5Installation> ResolveMt5Installations(
        IReadOnlyList<Mt5Installation> discovered,
        string? configuredTerminalPath)
    {
        ArgumentNullException.ThrowIfNull(discovered);
        if (string.IsNullOrWhiteSpace(configuredTerminalPath))
        {
            return discovered;
        }
        return [new(
            Path.GetFullPath(configuredTerminalPath),
            "observer_profile",
            IsRunning:false)];
    }

    private async Task WatchMt4RegistrationsAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            Mt4EaConnection registration;
            try
            {
                registration = await Mt4EaConnection.AcceptAsync(
                    Mt4TerminalIdentity.RegistrationPipeName,
                    TimeSpan.FromSeconds(30),
                    cancellationToken);
            }
            catch (TimeoutException)
            {
                continue;
            }
            _pendingMt4Registrations.Enqueue(registration);
            RequestRedetect();
            return;
        }
    }

    private async Task<Mt5ProvisioningResult> SelectMt5TerminalAsync(
        Mt5ProvisioningResult result,
        CancellationToken cancellationToken)
    {
        var candidates = result.Terminals
            .Select(terminal => new BridgeTerminalCandidate(
                terminal.Binding.TerminalInstanceId,
                BridgePlatform.Mt5,
                terminal.Binding.AccountRef.BrokerServer,
                terminal.Binding.AccountRef.Login))
            .OrderBy(candidate => candidate.Login, StringComparer.Ordinal)
            .ThenBy(candidate => candidate.BrokerServer, StringComparer.Ordinal)
            .ToArray();
        string? preferred;
        lock (_sync)
        {
            _terminalCandidates = candidates;
            preferred = _selectedMt5TerminalId;
        }
        var selectedId = ResolveMt5TerminalSelection(candidates, preferred);
        if (selectedId is null)
        {
            foreach (var terminal in result.Terminals)
            {
                await terminal.Supervisor.DisposeAsync();
            }
            Publish(BridgeApplicationPhase.TerminalSelectionRequired);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new OperationCanceledException(cancellationToken);
        }

        var selected = result.Terminals.Single(terminal =>
            terminal.Binding.TerminalInstanceId == selectedId);
        foreach (var terminal in result.Terminals)
        {
            if (!ReferenceEquals(terminal, selected))
            {
                await terminal.Supervisor.DisposeAsync();
            }
        }
        lock (_sync)
        {
            _activeMt5TerminalId = selectedId;
        }
        return new([selected], result.Failures);
    }

    public static string? ResolveMt5TerminalSelection(
        IReadOnlyList<BridgeTerminalCandidate> candidates,
        string? preferredTerminalInstanceId)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        if (candidates.Count == 1)
        {
            return candidates[0].TerminalInstanceId;
        }
        return candidates.Any(candidate =>
                candidate.TerminalInstanceId == preferredTerminalInstanceId)
            ? preferredTerminalInstanceId
            : null;
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
        if (status.State == TerminalRuntimeState.Stopped
            && status.ErrorCode == "terminal_worker_failure_limit")
        {
            Publish(BridgeApplicationPhase.Degraded, status.ErrorCode);
        }
        else
        {
            PublishCurrent();
        }
    }

    private void HandleConnectionStatus(BridgeConnectionStatus status)
    {
        lock (_sync)
        {
            _serverConnected = status.State == BridgeConnectionState.Connected;
        }
        var phase = status.State switch
        {
            BridgeConnectionState.PairingRequired => BridgeApplicationPhase.PairingRequired,
            BridgeConnectionState.Connecting or BridgeConnectionState.Reconnecting => BridgeApplicationPhase.Connecting,
            BridgeConnectionState.Connected => BridgeApplicationPhase.Connecting,
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
        _detailCode)
    {
        SelectedPlatform = _selectedPlatform,
        SelectedTerminalInstanceId = _activeMt5TerminalId ?? _selectedMt5TerminalId,
        TerminalCandidates = _terminalCandidates,
        ServerConnected = _serverConnected,
        LastDataSyncUtcMsc = _lastDataSyncUtcMsc,
        BridgeVersion = typeof(BridgeApplicationController).Assembly.GetName().Version?.ToString(3)
            ?? "3.0.0",
    };

    private static string NormalizeApplicationError(Exception error) => error switch
    {
        FileNotFoundException fileError => fileError.Message,
        InvalidDataException dataError when dataError.Message is
            "mt5_probe_identity_mismatch"
            or "mt4_ea_identity_mismatch"
            or "terminal_runtime_identity_mismatch" => dataError.Message,
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
