using AurumBridge.Protocol;
using AurumBridge.Security;
using AurumBridge.Storage;
using AurumBridge.Workers;
using System.Collections.Concurrent;
using System.Text.Json;

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
    string? ErrorCode,
    string? ObserverProfileId = null)
{
    public bool? TerminalTradingAllowed { get; init; }
    public bool? ProgramTradingAllowed { get; init; }
    public bool? AccountTradingAllowed { get; init; }
    public bool? AccountExpertTradingAllowed { get; init; }
    public bool Mt4ExpertRestartRequired { get; init; }
}

public sealed record BridgeTerminalCandidate(
    string TerminalInstanceId,
    string Platform,
    string BrokerServer,
    string Login,
    string? DisplayName = null);

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
    public bool CanManageObserverSources { get; init; }
}

public sealed class BridgeApplicationController : IAsyncDisposable, IBridgeUpdateDrainTarget
{
    private readonly BridgeRuntimePaths _paths;
    private readonly BridgeStore _store;
    private readonly HttpClient _httpClient;
    private readonly BridgeSessionClient _sessionClient;
    private readonly Mt5RuntimeProvisioner _mt5Provisioner;
    private readonly Mt4RuntimeProvisioner _mt4Provisioner;
    private readonly Mt4ExpertInstaller? _mt4ExpertInstaller;
    private BridgeHelloMetadata? _helloMetadata;
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
    private string? _selectedMt4TerminalId;
    private readonly string? _selectedMt5TerminalPath;
    private IReadOnlyList<BridgeObserverTerminalConfiguration> _observerTerminals;
    private string? _activeMt5TerminalId;
    private string? _activeMt4TerminalId;
    private IReadOnlyList<BridgeTerminalCandidate> _terminalCandidates = [];
    private bool _serverConnected;
    private bool _canManageObserverSources;
    private long? _lastDataSyncUtcMsc;
    private bool _disposed;

    public BridgeApplicationController(
        BridgeRuntimePaths paths,
        string? selectedPlatform = null,
        string? selectedMt5TerminalId = null,
        string? selectedMt5TerminalPath = null,
        string? selectedMt4TerminalId = null,
        IReadOnlyList<BridgeObserverTerminalConfiguration>? observerTerminals = null,
        BridgeHelloMetadata? helloMetadata = null)
    {
        _paths = paths ?? throw new ArgumentNullException(nameof(paths));
        Directory.CreateDirectory(paths.DataDirectory);
        _store = new(Path.Combine(paths.DataDirectory, "bridge.db"));
        _store.AccountSnapshotPersisted += HandleAccountSnapshotPersisted;
        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
        var credentials = new FileBridgeCredentialStore(
            paths.CredentialPath,
            new WindowsDpapiProtector());
        _sessionClient = new(paths.ServerBaseUri, _httpClient, credentials);
        _sessionClient.ObserverSourceManagementChanged += HandleObserverSourceManagementChanged;
        _mt5Provisioner = new(
            _store,
            paths.PythonExecutable,
            paths.Mt5WorkerScript);
        _mt4Provisioner = new(_store);
        _mt4ExpertInstaller = paths.Mt4ExpertPath is null
            ? null
            : new(paths.Mt4ExpertPath);
        _selectedPlatform = string.IsNullOrWhiteSpace(selectedPlatform)
            ? null
            : BridgePlatform.Normalize(selectedPlatform);
        _selectedMt5TerminalId = selectedMt5TerminalId;
        _selectedMt4TerminalId = selectedMt4TerminalId;
        _selectedMt5TerminalPath = string.IsNullOrWhiteSpace(selectedMt5TerminalPath)
            ? null
            : Path.GetFullPath(selectedMt5TerminalPath);
        _observerTerminals = NormalizeObserverTerminals(observerTerminals ?? []);
        _helloMetadata = helloMetadata;
    }

    public event Action<BridgeApplicationStatus>? StatusChanged;
    public event Action<Exception>? ConnectionFailureObserved;
    public event Action<TerminalRuntimeFailure>? TerminalFailureObserved;
    public event Action<BridgeReleaseAvailableNotification>? ReleaseAvailable;
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
            var selected = _terminalCandidates.SingleOrDefault(candidate =>
                candidate.TerminalInstanceId == terminalInstanceId);
            if (selected is null)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(terminalInstanceId), terminalInstanceId, "Unknown terminal selection.");
            }
            if (selected.Platform == BridgePlatform.Mt5)
            {
                _selectedMt5TerminalId = terminalInstanceId;
                _activeMt5TerminalId = terminalInstanceId;
            }
            else
            {
                _selectedMt4TerminalId = terminalInstanceId;
                _activeMt4TerminalId = terminalInstanceId;
            }
            _cycleCancellation?.Cancel();
        }
    }

    public void SetObserverTerminals(
        IReadOnlyList<BridgeObserverTerminalConfiguration> observerTerminals)
    {
        var normalized = NormalizeObserverTerminals(observerTerminals);
        lock (_sync)
        {
            if (_observerTerminals.SequenceEqual(normalized))
            {
                return;
            }
            _observerTerminals = normalized;
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

    public Task<IReadOnlyList<BridgeObserverSource>> ListManagedObserverSourcesAsync(
        CancellationToken cancellationToken = default) =>
        _sessionClient.ListManagedObserverSourcesAsync(cancellationToken);

    public Task<BridgeCredential> CreateManagedObserverCredentialAsync(
        long bridgeUserId,
        string terminalInstanceId,
        CancellationToken cancellationToken = default) =>
        _sessionClient.CreateManagedObserverCredentialAsync(
            bridgeUserId,
            terminalInstanceId,
            cancellationToken);

    public void RequestRedetect()
    {
        lock (_sync)
        {
            _cycleCancellation?.Cancel();
        }
    }

    internal bool UpdateHelloMetadata(
        BridgeHelloMetadata metadata,
        bool reconnect)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        lock (_sync)
        {
            if (_helloMetadata == metadata)
            {
                return false;
            }
            _helloMetadata = metadata;
            if (reconnect)
            {
                _cycleCancellation?.Cancel();
            }
            return true;
        }
    }

    public async Task<Mt4ExpertDeployment> InstallOrRepairMt4ExpertAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        string? selectedTerminalId;
        lock (_sync)
        {
            if (_selectedPlatform != BridgePlatform.Mt4)
            {
                throw new InvalidOperationException("mt4_platform_not_selected");
            }
            selectedTerminalId = _activeMt4TerminalId ?? _selectedMt4TerminalId;
        }
        var installations = Mt4TerminalDiscovery.DiscoverWindows();
        if (installations.Count == 0)
        {
            throw new InvalidOperationException("mt4_terminal_not_found");
        }
        var installation = ResolveMt4InstallationSelection(
            installations,
            selectedTerminalId);
        if (installation is null)
        {
            throw new InvalidOperationException("mt4_terminal_selection_required");
        }
        if (_mt4ExpertInstaller is null)
        {
            throw new FileNotFoundException("mt4_ea_package_not_found");
        }
        var result = await _mt4ExpertInstaller.DeployAsync(
            [installation],
            cancellationToken);
        var failure = result.Failures.FirstOrDefault();
        if (failure is not null)
        {
            throw new InvalidOperationException(failure.ErrorCode);
        }
        return result.Deployments.Single();
    }

    public async Task<bool> LogoutAsync(CancellationToken cancellationToken = default)
    {
        var revoked = await _sessionClient.LogoutAsync(cancellationToken);
        RequestRedetect();
        return revoked;
    }

    public Task<BridgeMaintenanceLeaseDecision> AcquireMaintenanceLeaseAsync(
        BridgeMaintenanceLeaseRequest request,
        CancellationToken cancellationToken = default) =>
        _sessionClient.AcquireMaintenanceLeaseAsync(request, cancellationToken);

    public Task<long> RenewMaintenanceLeaseAsync(
        string leaseId,
        CancellationToken cancellationToken = default) =>
        _sessionClient.RenewMaintenanceLeaseAsync(leaseId, cancellationToken);

    public Task ReleaseMaintenanceLeaseAsync(
        string leaseId,
        CancellationToken cancellationToken = default) =>
        _sessionClient.ReleaseMaintenanceLeaseAsync(leaseId, cancellationToken);

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
        _store.AccountSnapshotPersisted -= HandleAccountSnapshotPersisted;
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
            _activeMt4TerminalId = null;
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
        var mt4Deployment = new Mt4ExpertDeploymentResult([], []);
        string? mt4SetupDetail = null;
        IReadOnlyList<BridgeObserverTerminalConfiguration> observerTerminals;
        string? selectedMt5TerminalId;
        string? selectedMt4TerminalId;
        lock (_sync)
        {
            observerTerminals = _observerTerminals.ToArray();
            selectedMt5TerminalId = _selectedMt5TerminalId;
            selectedMt4TerminalId = _selectedMt4TerminalId;
        }
        var observerMt5Installations = observerTerminals
            .Where(terminal => terminal.Platform == BridgePlatform.Mt5)
            .Select(terminal => new Mt5Installation(
                terminal.TerminalPath,
                $"observer_profile:{terminal.ProfileId}",
                IsRunning:false))
            .ToArray();
        var observerProfileByTerminalId = observerTerminals.ToDictionary(
            terminal => terminal.TerminalInstanceId,
            terminal => terminal.ProfileId,
            StringComparer.Ordinal);
        var observerTerminalIds = observerProfileByTerminalId.Keys.ToHashSet(StringComparer.Ordinal);
        var observerMt5TerminalIds = observerTerminals
            .Where(terminal => terminal.Platform == BridgePlatform.Mt5)
            .Select(terminal => terminal.TerminalInstanceId)
            .ToHashSet(StringComparer.Ordinal);
        var observerMt4TerminalIds = observerTerminals
            .Where(terminal => terminal.Platform == BridgePlatform.Mt4)
            .Select(terminal => terminal.TerminalInstanceId)
            .ToHashSet(StringComparer.Ordinal);
        var primaryMt5TerminalIds = new HashSet<string>(StringComparer.Ordinal);
        if (selectedPlatform == BridgePlatform.Mt5)
        {
            var primaryInstallations = ResolvePrimaryMt5Installations(
                Mt5TerminalDiscovery.DiscoverWindows(),
                _selectedMt5TerminalPath,
                observerMt5TerminalIds,
                selectedMt5TerminalId);
            primaryMt5TerminalIds.UnionWith(
                primaryInstallations.Select(installation => installation.TerminalInstanceId));
            var installations = MergeMt5Installations(
                primaryInstallations,
                observerMt5Installations);
            mt5 = await _mt5Provisioner.ProvisionAsync(installations, cancellationToken);
            if (mt5.Terminals.Any(terminal =>
                primaryMt5TerminalIds.Contains(terminal.Binding.TerminalInstanceId)))
            {
                mt5 = await SelectMt5TerminalsAsync(
                    mt5,
                    primaryMt5TerminalIds,
                    observerMt5TerminalIds,
                    cancellationToken);
            }
            else
            {
                mt5 = await KeepOnlyMt5TerminalsAsync(
                    mt5,
                    observerMt5TerminalIds,
                    cancellationToken);
            }
        }
        else
        {
            if (observerMt5Installations.Length > 0)
            {
                mt5 = await _mt5Provisioner.ProvisionAsync(
                    observerMt5Installations,
                    cancellationToken);
            }
        }

        var discoveredMt4Installations = Mt4TerminalDiscovery.DiscoverWindows();
        var observerMt4Installations = observerTerminals
            .Where(terminal => terminal.Platform == BridgePlatform.Mt4)
            .Select(terminal => discoveredMt4Installations.FirstOrDefault(installation =>
                installation.TerminalInstanceId == terminal.TerminalInstanceId)
                ?? new Mt4Installation(
                    terminal.TerminalPath,
                    terminal.TerminalPath,
                    $"observer_profile:{terminal.ProfileId}",
                    IsRunning:false))
            .ToArray();
        Mt4Installation? primaryMt4Installation = null;
        if (selectedPlatform == BridgePlatform.Mt4)
        {
            primaryMt4Installation = await SelectMt4InstallationAsync(
                ResolvePrimaryMt4Installations(
                    discoveredMt4Installations,
                    observerMt4TerminalIds,
                    selectedMt4TerminalId),
                cancellationToken);
        }
        var mt4Installations = MergeMt4Installations(
            primaryMt4Installation is null ? [] : [primaryMt4Installation],
            observerMt4Installations);
        var allowedMt4TerminalIds = mt4Installations
            .Select(installation => installation.TerminalInstanceId)
            .ToHashSet(StringComparer.Ordinal);
        if (mt4Installations.Count > 0)
        {
            if (_mt4ExpertInstaller is null)
            {
                mt4Deployment = new(
                    [],
                    mt4Installations.Select(installation =>
                        new Mt4ExpertDeploymentFailure(
                            installation.TerminalInstanceId,
                            "mt4_ea_package_not_found")).ToArray());
            }
            else
            {
                mt4Deployment = await _mt4ExpertInstaller.DeployAsync(
                    mt4Installations,
                    cancellationToken);
            }
            mt4SetupDetail = primaryMt4Installation is null
                ? null
                : mt4Deployment.Failures.FirstOrDefault(failure =>
                    failure.TerminalInstanceId == primaryMt4Installation.TerminalInstanceId)?.ErrorCode
                    ?? "mt4_ea_attach_required";
        }
        if (allowedMt4TerminalIds.Count > 0)
        {
            var registrations = new List<Mt4EaConnection>();
            while (_pendingMt4Registrations.TryDequeue(out var pendingRegistration))
            {
                registrations.Add(pendingRegistration);
            }
            registrations.AddRange(await Mt4RuntimeProvisioner.AcceptRegistrationsAsync(
                TimeSpan.FromMilliseconds(1_500), cancellationToken));
            mt4 = await _mt4Provisioner.ProvisionManyAsync(
                registrations,
                allowedMt4TerminalIds,
                cancellationToken);
            foreach (var terminal in mt4.Terminals)
            {
                var observer = observerTerminals.FirstOrDefault(configuration =>
                    configuration.Platform == BridgePlatform.Mt4
                    && TerminalPathsEqual(
                        configuration.TerminalPath,
                        terminal.Binding.TerminalPath));
                if (observer is not null)
                {
                    observerProfileByTerminalId[terminal.Binding.TerminalInstanceId] =
                        observer.ProfileId;
                }
            }
        }
        else
        {
            while (_pendingMt4Registrations.TryDequeue(out var unusedRegistration))
            {
                await unusedRegistration.DisposeAsync();
            }
        }
        var supervisors = mt5.Terminals.Select(terminal => terminal.Supervisor)
            .Concat(mt4.Terminals.Select(terminal => terminal.Supervisor))
            .ToArray();
        var mt4AdapterVersionByTerminalId = mt4.Terminals.ToDictionary(
            terminal => terminal.Binding.TerminalInstanceId,
            terminal => terminal.AdapterVersion,
            StringComparer.Ordinal);
        if (supervisors.Length == 0)
        {
            Publish(
                BridgeApplicationPhase.TerminalNotFound,
                selectedPlatform == BridgePlatform.Mt5
                    ? mt5.Failures.FirstOrDefault()?.ErrorCode ?? "mt5_terminal_not_found"
                    : mt4.Failures.FirstOrDefault()?.ErrorCode
                        ?? mt4SetupDetail
                        ?? "mt4_terminal_not_found");
            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
            return;
        }

        var mainTerminalAvailable = selectedPlatform == BridgePlatform.Mt5
            ? _activeMt5TerminalId is not null
                && mt5.Terminals.Any(terminal =>
                    terminal.Binding.TerminalInstanceId == _activeMt5TerminalId)
            : primaryMt4Installation is not null
                && mt4.Terminals.Any(terminal =>
                    TerminalPathsEqual(
                        terminal.Binding.TerminalPath,
                        primaryMt4Installation.TerminalDataPath));
        var mainFailure = mainTerminalAvailable
            ? null
            : selectedPlatform == BridgePlatform.Mt5
                ? mt5.Failures.FirstOrDefault(failure =>
                    primaryMt5TerminalIds.Contains(failure.TerminalInstanceId))?.ErrorCode
                    ?? "mt5_terminal_not_found"
                : mt4.Failures.FirstOrDefault(failure =>
                    failure.TerminalInstanceId == primaryMt4Installation?.TerminalInstanceId)?.ErrorCode
                    ?? mt4SetupDetail
                    ?? "mt4_terminal_not_found";
        var observerFailure = mt5.Failures.FirstOrDefault(failure =>
                observerMt5TerminalIds.Contains(failure.TerminalInstanceId))?.ErrorCode
            ?? mt4.Failures.FirstOrDefault(failure =>
                observerMt4TerminalIds.Contains(failure.TerminalInstanceId))?.ErrorCode
            ?? mt4Deployment.Failures.FirstOrDefault(failure =>
                observerMt4TerminalIds.Contains(failure.TerminalInstanceId))?.ErrorCode;
        var cycleDetail = mainFailure ?? observerFailure;
        var cycleDegraded = cycleDetail is not null;

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
                    null,
                    observerProfileByTerminalId.GetValueOrDefault(
                        descriptor.TerminalInstanceId))
                {
                    Mt4ExpertRestartRequired = descriptor.Platform == BridgePlatform.Mt4
                        && mt4AdapterVersionByTerminalId.GetValueOrDefault(
                            descriptor.TerminalInstanceId) is { } adapterVersion
                        && Mt4PipeProtocol.RequiresAdapterRestart(adapterVersion),
                };
            }
            supervisor.StatusChanged += HandleTerminalStatus;
            supervisor.FailureObserved += failure => TerminalFailureObserved?.Invoke(failure);
        }
        if (cycleDegraded)
        {
            Publish(BridgeApplicationPhase.Degraded, cycleDetail);
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
                Publish(
                    cycleDegraded
                        ? BridgeApplicationPhase.Degraded
                        : BridgeApplicationPhase.Online,
                    cycleDetail);
            }
        };
        webSocket.FullSnapshotRequired += host.HandleFullSnapshotRequestAsync;
        webSocket.ReleaseAvailable += notification => ReleaseAvailable?.Invoke(notification);
        BridgeHelloMetadata? helloMetadata;
        lock (_sync)
        {
            helloMetadata = _helloMetadata;
        }
        var connection = new BridgeConnectionSupervisor(
            host.Terminals,
            typeof(BridgeApplicationController).Assembly.GetName().Version?.ToString() ?? "3.0.0",
            _sessionClient.AcquireConnectionAttemptAsync,
            (attempt, ready, token) => webSocket.RunSessionAsync(attempt, ready, token),
            helloMetadata:helloMetadata);
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
        var registrationTask = allowedMt4TerminalIds.Count > 0
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

    public static IReadOnlyList<Mt5Installation> ResolvePrimaryMt5Installations(
        IReadOnlyList<Mt5Installation> discovered,
        string? configuredTerminalPath,
        IReadOnlySet<string> observerTerminalIds,
        string? selectedTerminalId)
    {
        ArgumentNullException.ThrowIfNull(observerTerminalIds);
        return ResolveMt5Installations(discovered, configuredTerminalPath)
            .Where(installation =>
                !observerTerminalIds.Contains(installation.TerminalInstanceId)
                || installation.TerminalInstanceId == selectedTerminalId)
            .ToArray();
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

    private async Task<Mt5ProvisioningResult> SelectMt5TerminalsAsync(
        Mt5ProvisioningResult result,
        IReadOnlySet<string> primaryTerminalIds,
        IReadOnlySet<string> observerTerminalIds,
        CancellationToken cancellationToken)
    {
        var candidates = result.Terminals
            .Where(terminal => primaryTerminalIds.Contains(
                terminal.Binding.TerminalInstanceId))
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

        var kept = new List<Mt5ProvisionedTerminal>();
        foreach (var terminal in result.Terminals)
        {
            if (terminal.Binding.TerminalInstanceId == selectedId
                || observerTerminalIds.Contains(terminal.Binding.TerminalInstanceId))
            {
                kept.Add(terminal);
            }
            else
            {
                await terminal.Supervisor.DisposeAsync();
            }
        }
        lock (_sync)
        {
            _activeMt5TerminalId = selectedId;
        }
        return new(kept, result.Failures);
    }

    private static async Task<Mt5ProvisioningResult> KeepOnlyMt5TerminalsAsync(
        Mt5ProvisioningResult result,
        IReadOnlySet<string> terminalIds,
        CancellationToken cancellationToken)
    {
        var kept = new List<Mt5ProvisionedTerminal>();
        foreach (var terminal in result.Terminals)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (terminalIds.Contains(terminal.Binding.TerminalInstanceId))
            {
                kept.Add(terminal);
            }
            else
            {
                await terminal.Supervisor.DisposeAsync();
            }
        }
        return new(kept, result.Failures);
    }

    public static IReadOnlyList<Mt5Installation> MergeMt5Installations(
        IEnumerable<Mt5Installation> primaryInstallations,
        IEnumerable<Mt5Installation> observerInstallations)
    {
        ArgumentNullException.ThrowIfNull(primaryInstallations);
        ArgumentNullException.ThrowIfNull(observerInstallations);
        var merged = new List<Mt5Installation>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var installation in primaryInstallations.Concat(observerInstallations))
        {
            if (seen.Add(installation.TerminalInstanceId))
            {
                merged.Add(installation);
            }
        }
        return merged;
    }

    public static IReadOnlyList<Mt4Installation> ResolvePrimaryMt4Installations(
        IReadOnlyList<Mt4Installation> discovered,
        IReadOnlySet<string> observerTerminalIds,
        string? selectedTerminalId)
    {
        ArgumentNullException.ThrowIfNull(discovered);
        ArgumentNullException.ThrowIfNull(observerTerminalIds);
        return discovered.Where(installation =>
            !observerTerminalIds.Contains(installation.TerminalInstanceId)
            || installation.TerminalInstanceId == selectedTerminalId).ToArray();
    }

    public static IReadOnlyList<Mt4Installation> MergeMt4Installations(
        IEnumerable<Mt4Installation> primaryInstallations,
        IEnumerable<Mt4Installation> observerInstallations)
    {
        ArgumentNullException.ThrowIfNull(primaryInstallations);
        ArgumentNullException.ThrowIfNull(observerInstallations);
        var merged = new List<Mt4Installation>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var installation in primaryInstallations.Concat(observerInstallations))
        {
            if (seen.Add(installation.TerminalInstanceId))
            {
                merged.Add(installation);
            }
        }
        return merged;
    }

    public static bool TerminalPathsEqual(string first, string second)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(first);
        ArgumentException.ThrowIfNullOrWhiteSpace(second);
        return string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(first)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(second)),
            StringComparison.OrdinalIgnoreCase);
    }

    private async Task<Mt4Installation?> SelectMt4InstallationAsync(
        IReadOnlyList<Mt4Installation> installations,
        CancellationToken cancellationToken)
    {
        var candidates = installations
            .Select(installation => new BridgeTerminalCandidate(
                installation.TerminalInstanceId,
                BridgePlatform.Mt4,
                string.Empty,
                string.Empty,
                installation.DisplayName))
            .OrderBy(candidate => candidate.DisplayName, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
        string? preferred;
        lock (_sync)
        {
            _terminalCandidates = candidates;
            preferred = _selectedMt4TerminalId;
        }
        var selectedId = ResolveTerminalSelection(candidates, preferred);
        if (selectedId is null && candidates.Length > 0)
        {
            Publish(BridgeApplicationPhase.TerminalSelectionRequired);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new OperationCanceledException(cancellationToken);
        }
        if (selectedId is null)
        {
            return null;
        }
        lock (_sync)
        {
            _activeMt4TerminalId = selectedId;
        }
        return installations.Single(installation =>
            installation.TerminalInstanceId == selectedId);
    }

    public static string? ResolveMt5TerminalSelection(
        IReadOnlyList<BridgeTerminalCandidate> candidates,
        string? preferredTerminalInstanceId) =>
        ResolveTerminalSelection(candidates, preferredTerminalInstanceId);

    public static Mt4Installation? ResolveMt4InstallationSelection(
        IReadOnlyList<Mt4Installation> installations,
        string? preferredTerminalInstanceId)
    {
        ArgumentNullException.ThrowIfNull(installations);
        if (installations.Count == 1)
        {
            return installations[0];
        }
        return installations.SingleOrDefault(installation =>
            installation.TerminalInstanceId == preferredTerminalInstanceId);
    }

    public static string? ResolveTerminalSelection(
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
        bool allRunning;
        bool serverConnected;
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
            allRunning = _terminalStatuses.Count > 0
                && _terminalStatuses.Values.All(terminal =>
                    terminal.RuntimeState == TerminalRuntimeState.Running);
            serverConnected = _serverConnected;
        }
        if (status.State == TerminalRuntimeState.Restarting)
        {
            Publish(BridgeApplicationPhase.Degraded, status.ErrorCode);
        }
        else if (status.State == TerminalRuntimeState.Running && allRunning && serverConnected)
        {
            Publish(BridgeApplicationPhase.Online);
        }
        else
        {
            PublishCurrent();
        }
    }

    private void HandleAccountSnapshotPersisted(
        string terminalInstanceId,
        JsonElement account)
    {
        lock (_sync)
        {
            if (!_terminalStatuses.TryGetValue(terminalInstanceId, out var current))
            {
                return;
            }
            _terminalStatuses[terminalInstanceId] = ApplyTradingPermissions(current, account);
        }
        PublishCurrent();
    }

    public static BridgeTerminalStatus ApplyTradingPermissions(
        BridgeTerminalStatus terminal,
        JsonElement account)
    {
        ArgumentNullException.ThrowIfNull(terminal);
        if (account.ValueKind != JsonValueKind.Object)
        {
            return terminal;
        }
        return terminal with
        {
            TerminalTradingAllowed = ReadOptionalBoolean(account, "terminal_trade_allowed"),
            ProgramTradingAllowed = ReadOptionalBoolean(account, "program_trade_allowed"),
            AccountTradingAllowed = ReadOptionalBoolean(account, "trade_allowed"),
            AccountExpertTradingAllowed = ReadOptionalBoolean(account, "trade_expert"),
        };
    }

    private static bool? ReadOptionalBoolean(JsonElement value, string propertyName) =>
        value.TryGetProperty(propertyName, out var property)
            && property.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? property.GetBoolean()
                : null;

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

    private void HandleObserverSourceManagementChanged(bool allowed)
    {
        lock (_sync)
        {
            _canManageObserverSources = allowed;
        }
        PublishCurrent();
    }

    private BridgeApplicationStatus Snapshot() => new(
        _phase,
        _terminalStatuses.Values.OrderBy(value => value.TerminalInstanceId).ToArray(),
        _detailCode)
    {
        SelectedPlatform = _selectedPlatform,
        SelectedTerminalInstanceId = _selectedPlatform == BridgePlatform.Mt4
            ? _activeMt4TerminalId ?? _selectedMt4TerminalId
            : _activeMt5TerminalId ?? _selectedMt5TerminalId,
        TerminalCandidates = _terminalCandidates,
        ServerConnected = _serverConnected,
        LastDataSyncUtcMsc = _lastDataSyncUtcMsc,
        BridgeVersion = typeof(BridgeApplicationController).Assembly.GetName().Version?.ToString(3)
            ?? "3.0.0",
        CanManageObserverSources = _canManageObserverSources,
    };

    public static IReadOnlyList<BridgeObserverTerminalConfiguration>
        NormalizeObserverTerminals(
            IReadOnlyList<BridgeObserverTerminalConfiguration> observerTerminals)
    {
        ArgumentNullException.ThrowIfNull(observerTerminals);
        var normalized = new List<BridgeObserverTerminalConfiguration>(
            observerTerminals.Count);
        var seenTerminalIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var terminal in observerTerminals.OrderBy(
            terminal => terminal.ProfileId,
            StringComparer.Ordinal))
        {
            var profileId = BridgeRuntimeProfile.Validate(terminal.ProfileId);
            var platform = BridgePlatform.Normalize(terminal.Platform);
            if (BridgeRuntimeProfile.IsDefault(profileId))
            {
                throw new ArgumentException(
                    "observer_terminal_configuration_invalid",
                    nameof(observerTerminals));
            }
            var path = Path.GetFullPath(terminal.TerminalPath);
            var terminalId = platform == BridgePlatform.Mt5
                ? Mt5TerminalDiscovery.CreateTerminalInstanceId(path)
                : Mt4TerminalIdentity.CreateTerminalInstanceId(path);
            if (terminalId != terminal.TerminalInstanceId
                || !seenTerminalIds.Add(terminalId))
            {
                throw new ArgumentException(
                    "observer_terminal_configuration_invalid",
                    nameof(observerTerminals));
            }
            normalized.Add(terminal with
            {
                ProfileId = profileId,
                Platform = platform,
                TerminalPath = path,
            });
        }
        return normalized;
    }

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
