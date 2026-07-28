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
    private bool _disposed;

    private BridgeUpdateCoordinator(
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

    public async Task<StagedRelease?> CheckAndStageAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        try
        {
            var manifest = await _manifestClient.FetchVerifiedAsync(
                _verifier,
                Environment.LauncherVersion,
                cancellationToken);
            if (manifest is null)
            {
                await SaveCheckingStateAsync(cancellationToken);
                return null;
            }
            var previous = await _stateStore.LoadAsync(cancellationToken);
            var sameRelease = previous is not null
                && previous.TargetVersion == manifest.ReleaseVersion
                && previous.ReleaseId == manifest.ReleaseId;
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
    }

    public Task<BridgeUpdateState?> LoadStateAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _stateStore.LoadAsync(cancellationToken);
    }

    public async Task<BridgeUpdateState?> RequestManualActivationAsync(
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
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

    public Task PrepareActivationAsync(
        StagedRelease stagedRelease,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _activationStore.PrepareActivationAsync(
            stagedRelease,
            Environment.CurrentVersion,
            cancellationToken);
    }

    public void StartLauncher()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _ = Process.Start(new ProcessStartInfo
        {
            FileName = Environment.LauncherPath,
            ArgumentList = { "--autostart" },
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
}
