using System.Diagnostics;

namespace AurumBridge.Update;

public sealed record BridgeUpdateEnvironment(
    string InstallRoot,
    string LauncherPath,
    string PublicKeyPath,
    string PointerPath,
    Version CurrentVersion,
    Version LauncherVersion,
    string UpdateStatePath);

public sealed class BridgeUpdateCoordinator : IDisposable
{
    public static TimeSpan RegularCheckInterval { get; } = TimeSpan.FromMinutes(15);

    private readonly HttpClient _httpClient;
    private readonly ReleaseManifestVerifier _verifier;
    private readonly ReleaseManifestClient _manifestClient;
    private readonly ReleaseInstaller _installer;
    private readonly ReleaseActivationStore _activationStore;
    private readonly BridgeUpdateStateStore _stateStore;
    private readonly BridgeInstallationIdentityStore _installationIdentityStore;
    private readonly string _rolloutChannel;
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private bool _disposed;

    internal BridgeUpdateCoordinator(
        BridgeUpdateEnvironment environment,
        Uri serverBaseUri,
        HttpClient httpClient,
        ReleaseManifestVerifier verifier)
    {
        Environment = environment;
        _httpClient = httpClient;
        _verifier = verifier;
        _manifestClient = new(serverBaseUri, httpClient);
        _installer = new(environment.InstallRoot, new ReleaseStager(httpClient));
        _activationStore = new(environment.PointerPath);
        _stateStore = new(environment.UpdateStatePath);
        _installationIdentityStore = new(Path.Combine(environment.InstallRoot, "installation-id"));
        _rolloutChannel = ReadRolloutChannel(environment.InstallRoot);
    }

    public BridgeUpdateEnvironment Environment { get; }

    public event Action<BridgeUpdateState>? StateChanged;

    public static BridgeUpdateCoordinator? CreateIfInstalled(
        string applicationDirectory,
        Uri serverBaseUri)
    {
        var environment = ResolveEnvironment(applicationDirectory);
        if (environment is null)
        {
            return null;
        }
        var httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        try
        {
            var verifier = new ReleaseManifestVerifier(File.ReadAllText(environment.PublicKeyPath));
            return new(environment, serverBaseUri, httpClient, verifier);
        }
        catch
        {
            httpClient.Dispose();
            throw;
        }
    }

    public static BridgeUpdateEnvironment? ResolveEnvironment(
        string applicationDirectory,
        Func<string, Version>? launcherVersionResolver = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationDirectory);
        var versionDirectory = new DirectoryInfo(Path.GetFullPath(applicationDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar)));
        if (!Version.TryParse(versionDirectory.Name, out var currentVersion)
            || versionDirectory.Parent is not { } versionsDirectory
            || !string.Equals(versionsDirectory.Name, "versions", StringComparison.OrdinalIgnoreCase)
            || versionsDirectory.Parent is not { } installRoot)
        {
            return null;
        }
        var launcherPath = Path.Combine(installRoot.FullName, "AURUMBridge.Launcher.exe");
        var publicKeyPath = Path.Combine(installRoot.FullName, "release-public-key.pem");
        var pointerPath = Path.Combine(installRoot.FullName, "current.json");
        var updateStatePath = Path.Combine(installRoot.FullName, "update-state.json");
        if (!File.Exists(launcherPath) || !File.Exists(publicKeyPath) || !File.Exists(pointerPath))
        {
            return null;
        }
        launcherVersionResolver ??= ResolveLauncherVersion;
        return new(
            installRoot.FullName,
            Path.GetFullPath(launcherPath),
            Path.GetFullPath(publicKeyPath),
            Path.GetFullPath(pointerPath),
            currentVersion,
            launcherVersionResolver(launcherPath),
            Path.GetFullPath(updateStatePath));
    }

    public async Task<StagedRelease?> CheckAndStageAsync(
        CancellationToken cancellationToken = default,
        bool retryRolledBackRelease = false)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _operationGate.WaitAsync(cancellationToken);
        try
        {
            var previous = await _stateStore.LoadAsync(cancellationToken);
            var installationId = await _installationIdentityStore.LoadOrCreateAsync(cancellationToken);
            var manifest = await _manifestClient.FetchVerifiedAsync(
                _verifier,
                Environment.LauncherVersion,
                installationId,
                _rolloutChannel,
                cancellationToken);
            if (manifest is null)
            {
                if (previous?.State != BridgeUpdateStates.RolledBack)
                {
                    await SaveCheckingStateAsync(cancellationToken);
                }
                return null;
            }
            if (Version.Parse(manifest.ReleaseVersion) <= Environment.CurrentVersion)
            {
                await SaveCheckingStateAsync(cancellationToken);
                return null;
            }
            var sameRelease = previous is not null
                && previous.TargetVersion == manifest.ReleaseVersion
                && previous.ReleaseId == manifest.ReleaseId;
            if (sameRelease
                && previous!.State == BridgeUpdateStates.RolledBack
                && !retryRolledBackRelease)
            {
                return null;
            }
            var alreadyWaiting = sameRelease
                && previous!.State == BridgeUpdateStates.WaitingWindow;
            if (!alreadyWaiting)
            {
                await SaveStateAsync(new()
                {
                    State = BridgeUpdateStates.Downloading,
                    TargetVersion = manifest.ReleaseVersion,
                    ReleaseId = manifest.ReleaseId,
                    Priority = manifest.SchemaVersion == 2 ? manifest.Priority : "normal",
                    MinimumIdleSeconds = manifest.SchemaVersion == 2
                        ? manifest.MinimumIdleSeconds!.Value
                        : 120,
                    ActivationDeadlineUtcMsc = manifest.SchemaVersion == 2
                        ? manifest.ActivationDeadlineUtcMsc
                        : null,
                    ManualActivationRequested = sameRelease
                        && previous!.ManualActivationRequested,
                    StagedAtUtcMsc = sameRelease ? previous!.StagedAtUtcMsc : null,
                    UpdatedAtUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                }, cancellationToken);
            }
            var staged = await _installer.StageAsync(
                manifest,
                Environment.CurrentVersion,
                cancellationToken);
            if (staged is null)
            {
                await SaveCheckingStateAsync(cancellationToken);
                return null;
            }
            var stagedAt = sameRelease && previous!.StagedAtUtcMsc is { } priorStagedAt
                ? priorStagedAt
                : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            await SaveStateAsync(new()
            {
                State = BridgeUpdateStates.WaitingWindow,
                TargetVersion = staged.Version,
                ReleaseId = staged.ReleaseId,
                Priority = staged.Priority,
                MinimumIdleSeconds = staged.MinimumIdleSeconds,
                ActivationDeadlineUtcMsc = staged.ActivationDeadlineUtcMsc,
                ManualActivationRequested = sameRelease
                    && previous!.ManualActivationRequested,
                StagedAtUtcMsc = stagedAt,
                UpdatedAtUtcMsc = stagedAt,
            }, cancellationToken);
            return staged;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            await TrySaveFailureStateAsync(error);
            throw;
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public Task<BridgeUpdateState?> LoadStateAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _stateStore.LoadAsync(cancellationToken);
    }

    public async Task<StagedRelease?> RestoreStagedReleaseAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _operationGate.WaitAsync(cancellationToken);
        try
        {
            var state = await _stateStore.LoadAsync(cancellationToken);
            return state is null
                ? null
                : await _installer.RestoreAsync(
                    state,
                    _verifier,
                    Environment.LauncherVersion,
                    Environment.CurrentVersion,
                    cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception error)
        {
            await TrySaveFailureStateAsync(error);
            throw;
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task<BridgeUpdateState?> RequestManualActivationAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _operationGate.WaitAsync(cancellationToken);
        try
        {
            var state = await _stateStore.LoadAsync(cancellationToken);
            if (state?.State != BridgeUpdateStates.WaitingWindow)
            {
                return null;
            }
            if (state.ManualActivationRequested)
            {
                return state;
            }
            return await SaveStateAsync(
                state with { ManualActivationRequested = true },
                cancellationToken);
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public Task PrepareActivationAsync(
        StagedRelease stagedRelease,
        IReadOnlyList<string>? expectedTerminalInstanceIds = null,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _activationStore.PrepareActivationAsync(
            stagedRelease,
            Environment.CurrentVersion,
            expectedTerminalInstanceIds,
            cancellationToken);
    }

    public async Task<BridgeUpdateState> SaveActivationPhaseAsync(
        StagedRelease stagedRelease,
        string phase,
        bool manualActivationRequested,
        string? leaseId = null,
        long? leaseExpiresAtUtcMsc = null,
        long? nextRetryAtUtcMsc = null,
        string? lastErrorCode = null,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(stagedRelease);
        if (phase is not (BridgeUpdateStates.WaitingWindow
            or BridgeUpdateStates.AcquiringLease
            or BridgeUpdateStates.Draining
            or BridgeUpdateStates.Activating))
        {
            throw new ArgumentOutOfRangeException(nameof(phase));
        }
        await _operationGate.WaitAsync(cancellationToken);
        try
        {
            var previous = await _stateStore.LoadAsync(cancellationToken);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return await SaveStateAsync(new()
            {
                State = phase,
                TargetVersion = stagedRelease.Version,
                ReleaseId = stagedRelease.ReleaseId,
                Priority = stagedRelease.Priority,
                ManualActivationRequested = manualActivationRequested
                    || previous?.ManualActivationRequested == true,
                StagedAtUtcMsc = previous?.TargetVersion == stagedRelease.Version
                    ? previous.StagedAtUtcMsc ?? now
                    : now,
                ActivationStartedAtUtcMsc = phase == BridgeUpdateStates.WaitingWindow
                    ? null
                    : previous?.TargetVersion == stagedRelease.Version
                        && previous.State != BridgeUpdateStates.WaitingWindow
                        ? previous.ActivationStartedAtUtcMsc ?? now
                        : now,
                MinimumIdleSeconds = stagedRelease.MinimumIdleSeconds,
                ActivationDeadlineUtcMsc = stagedRelease.ActivationDeadlineUtcMsc,
                MaintenanceLeaseId = leaseId,
                MaintenanceLeaseExpiresAtUtcMsc = leaseExpiresAtUtcMsc,
                NextRetryAtUtcMsc = nextRetryAtUtcMsc,
                LastErrorCode = lastErrorCode,
                UpdatedAtUtcMsc = now,
            }, cancellationToken);
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public void StartLauncher()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _ = Process.Start(new ProcessStartInfo
        {
            FileName = Environment.LauncherPath,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("update_launcher_start_failed");
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _verifier.Dispose();
        _httpClient.Dispose();
        _operationGate.Dispose();
    }

    private async Task<BridgeUpdateState> SaveStateAsync(
        BridgeUpdateState state,
        CancellationToken cancellationToken)
    {
        var persisted = await _stateStore.SaveAsync(state, cancellationToken);
        try
        {
            StateChanged?.Invoke(persisted);
        }
        catch
        {
        }
        return persisted;
    }

    private Task<BridgeUpdateState> SaveCheckingStateAsync(CancellationToken cancellationToken) =>
        SaveStateAsync(new()
        {
            State = BridgeUpdateStates.Checking,
            UpdatedAtUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, cancellationToken);

    private async Task TrySaveFailureStateAsync(Exception error)
    {
        var errorCode = IsSafeErrorCode(error.Message)
            ? error.Message
            : "update_check_failed";
        try
        {
            var previous = await _stateStore.LoadAsync(CancellationToken.None);
            if (previous is not null && previous.State != BridgeUpdateStates.Downloading)
            {
                // A transient check failure must not erase a verified staged
                // release or misreport a healthy/rolled-back runtime.
                return;
            }
            await SaveStateAsync(new()
            {
                State = BridgeUpdateStates.Failed,
                LastErrorCode = errorCode,
                UpdatedAtUtcMsc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            }, CancellationToken.None);
        }
        catch
        {
        }
    }

    private static bool IsSafeErrorCode(string value) => value is { Length: >= 1 and <= 64 }
        && value.All(character => char.IsAsciiLetterOrDigit(character) || character == '_');

    private static Version ResolveLauncherVersion(string launcherPath)
    {
        var info = FileVersionInfo.GetVersionInfo(launcherPath);
        if (info.FileMajorPart < 0 || info.FileMinorPart < 0 || info.FileBuildPart < 0)
        {
            throw new InvalidDataException("update_launcher_version_invalid");
        }
        return new(info.FileMajorPart, info.FileMinorPart, info.FileBuildPart);
    }

    private static string ReadRolloutChannel(string installRoot)
    {
        var path = Path.Combine(installRoot, "release-channel");
        if (!File.Exists(path))
        {
            return "stable";
        }
        var value = File.ReadAllText(path).Trim().ToLowerInvariant();
        return value is "internal" or "stable"
            ? value
            : throw new InvalidDataException("update_rollout_channel_invalid");
    }
}
