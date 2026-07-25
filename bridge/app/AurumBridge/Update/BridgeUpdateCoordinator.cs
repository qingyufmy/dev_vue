using System.Diagnostics;

namespace AurumBridge.Update;

public sealed record BridgeUpdateEnvironment(
    string InstallRoot,
    string LauncherPath,
    string PublicKeyPath,
    string PointerPath,
    Version CurrentVersion,
    Version LauncherVersion);

public sealed class BridgeUpdateCoordinator : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly ReleaseManifestVerifier _verifier;
    private readonly ReleaseManifestClient _manifestClient;
    private readonly ReleaseInstaller _installer;
    private readonly ReleaseActivationStore _activationStore;
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
    }

    public BridgeUpdateEnvironment Environment { get; }

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
            launcherVersionResolver(launcherPath));
    }

    public async Task<StagedRelease?> CheckAndStageAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var manifest = await _manifestClient.FetchVerifiedAsync(
            _verifier,
            Environment.LauncherVersion,
            cancellationToken);
        return manifest is null
            ? null
            : await _installer.StageAsync(manifest, Environment.CurrentVersion, cancellationToken);
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
