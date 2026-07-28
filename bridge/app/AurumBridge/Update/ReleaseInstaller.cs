using System.Text.Json;
using System.Text.Json.Serialization;
using AurumBridge.Runtime;

namespace AurumBridge.Update;

public sealed record StagedRelease(
    string Version,
    string VersionDirectory,
    string Priority = "normal",
    string? ReleaseId = null,
    int MinimumIdleSeconds = 120,
    long? ActivationDeadlineUtcMsc = null);

public sealed class ReleaseInstaller(
    string installRoot,
    ReleaseStager stager,
    Func<string, long>? availableFreeSpaceProvider = null)
{
    private const string ReleaseMarkerFileName = ".aurum-release.json";
    private const long DiskSafetyReserveBytes = 256L * 1024 * 1024;
    private const int EstimatedExpansionMultiplier = 4;
    private static readonly string[] RequiredPackageIds =
    [
        "core",
        "adapter.mt5.python",
        "adapter.mt4",
    ];
    private static readonly string[] RequiredCoreFiles =
    [
        "AURUMBridge.exe",
        "AURUMBridge.dll",
        "AURUMBridge.runtimeconfig.json",
        "hostfxr.dll",
        "coreclr.dll",
        "e_sqlite3.dll",
        "Microsoft.Data.Sqlite.dll",
        "server-endpoints.json",
        "runtime/python/python.exe",
    ];
    private readonly string _installRoot = Path.GetFullPath(installRoot);
    private readonly ReleaseStager _stager = stager ?? throw new ArgumentNullException(nameof(stager));
    private readonly Func<string, long> _availableFreeSpaceProvider = availableFreeSpaceProvider
        ?? ReadAvailableFreeSpace;

    public async Task<StagedRelease?> StageAsync(
        ReleaseManifest manifest,
        Version currentVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(currentVersion);
        if (!Version.TryParse(manifest.ReleaseVersion, out var targetVersion))
        {
            throw new InvalidDataException("update_release_version_invalid");
        }
        if (targetVersion <= currentVersion)
        {
            return null;
        }
        ValidatePackageSet(manifest, targetVersion);

        var versionsRoot = Path.Combine(_installRoot, "versions");
        var finalVersionDirectory = Path.GetFullPath(Path.Combine(versionsRoot, manifest.ReleaseVersion));
        EnsureDescendant(versionsRoot, finalVersionDirectory);
        if (Directory.Exists(finalVersionDirectory))
        {
            return await MatchesStagedReleaseAsync(
                finalVersionDirectory,
                manifest,
                cancellationToken)
                ? DescribeStagedRelease(manifest, finalVersionDirectory)
                : throw new IOException("update_version_already_exists");
        }

        var operationId = Guid.NewGuid().ToString("N");
        var downloadDirectory = Path.Combine(_installRoot, "staging", $"{manifest.ReleaseVersion}-{operationId}");
        var contentCacheDirectory = Path.Combine(_installRoot, "cache", "packages");
        var temporaryVersionDirectory = Path.Combine(versionsRoot, $".{manifest.ReleaseVersion}-{operationId}.tmp");
        EnsureDescendant(Path.Combine(_installRoot, "staging"), downloadDirectory);
        EnsureDescendant(Path.Combine(_installRoot, "cache"), contentCacheDirectory);
        EnsureDescendant(versionsRoot, temporaryVersionDirectory);
        DeleteStaleCacheParts(contentCacheDirectory);
        var cachedPackages = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
        {
            var cached = await _stager.FindVerifiedCachedPackageAsync(
                package,
                contentCacheDirectory,
                cancellationToken);
            if (cached is not null)
            {
                cachedPackages[package.ModuleId] = cached;
            }
        }
        var downloadBytes = manifest.Packages
            .Where(package => !cachedPackages.ContainsKey(package.ModuleId))
            .Sum(package => package.SizeBytes);
        var estimatedExpansionBytes = checked(
            manifest.Packages.Sum(package => package.SizeBytes)
            * EstimatedExpansionMultiplier);
        EnsureSufficientDiskSpace(checked(
            downloadBytes + estimatedExpansionBytes + DiskSafetyReserveBytes));
        Directory.CreateDirectory(downloadDirectory);
        Directory.CreateDirectory(temporaryVersionDirectory);
        try
        {
            var downloads = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
            {
                downloads[package.ModuleId] = cachedPackages.GetValueOrDefault(package.ModuleId)
                    ?? await _stager.DownloadPackageAsync(
                        package,
                        downloadDirectory,
                        contentCacheDirectory,
                        cancellationToken);
            }
            var exactExpansionBytes = manifest.Packages.Sum(package =>
                ReleaseStager.GetExpandedSize(downloads[package.ModuleId]));
            EnsureSufficientDiskSpace(checked(
                exactExpansionBytes + DiskSafetyReserveBytes));
            foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
            {
                var destination = package.ModuleId == "core"
                    ? temporaryVersionDirectory
                    : Path.Combine(temporaryVersionDirectory, "modules", package.ModuleId);
                ReleaseStager.ExtractPackage(downloads[package.ModuleId], destination);
            }
            ValidateStagedLayout(temporaryVersionDirectory);
            await using (var marker = new FileStream(
                Path.Combine(temporaryVersionDirectory, ReleaseMarkerFileName),
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(marker, manifest, cancellationToken:cancellationToken);
                await marker.FlushAsync(cancellationToken);
            }
            Directory.CreateDirectory(versionsRoot);
            Directory.Move(temporaryVersionDirectory, finalVersionDirectory);
            return DescribeStagedRelease(manifest, finalVersionDirectory);
        }
        finally
        {
            DeleteTemporaryDirectory(temporaryVersionDirectory, versionsRoot);
            DeleteTemporaryDirectory(downloadDirectory, Path.Combine(_installRoot, "staging"));
        }
    }

    private static StagedRelease DescribeStagedRelease(
        ReleaseManifest manifest,
        string versionDirectory) => new(
            manifest.ReleaseVersion,
            versionDirectory,
            manifest.SchemaVersion == 2 ? manifest.Priority! : "normal",
            manifest.ReleaseId,
            manifest.SchemaVersion == 2 ? manifest.MinimumIdleSeconds!.Value : 120,
            manifest.SchemaVersion == 2 ? manifest.ActivationDeadlineUtcMsc : null);

    public async Task<StagedRelease?> RestoreAsync(
        BridgeUpdateState state,
        ReleaseManifestVerifier verifier,
        Version launcherVersion,
        Version currentVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(verifier);
        ArgumentNullException.ThrowIfNull(launcherVersion);
        ArgumentNullException.ThrowIfNull(currentVersion);
        if (state.State is not (BridgeUpdateStates.WaitingWindow
                or BridgeUpdateStates.AcquiringLease
                or BridgeUpdateStates.Draining
                or BridgeUpdateStates.Activating)
            || !Version.TryParse(state.TargetVersion, out var targetVersion)
            || targetVersion <= currentVersion)
        {
            return null;
        }
        var versionDirectory = Path.GetFullPath(Path.Combine(
            _installRoot,
            "versions",
            state.TargetVersion));
        EnsureDescendant(Path.Combine(_installRoot, "versions"), versionDirectory);
        var markerPath = Path.Combine(versionDirectory, ReleaseMarkerFileName);
        if (!File.Exists(markerPath))
        {
            throw new InvalidDataException("update_staged_release_missing");
        }
        ReleaseManifest manifest;
        try
        {
            await using var marker = new FileStream(
                markerPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous);
            manifest = await JsonSerializer.DeserializeAsync<ReleaseManifest>(
                marker,
                cancellationToken:cancellationToken)
                ?? throw new InvalidDataException("update_staged_release_invalid");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("update_staged_release_invalid", error);
        }
        verifier.Verify(manifest, launcherVersion);
        var priority = manifest.SchemaVersion == 2 ? manifest.Priority : "normal";
        if (manifest.ReleaseVersion != state.TargetVersion
            || manifest.ReleaseId != state.ReleaseId
            || priority != state.Priority
            || manifest.SchemaVersion == 2
                && (manifest.MinimumIdleSeconds != state.MinimumIdleSeconds
                    || manifest.ActivationDeadlineUtcMsc != state.ActivationDeadlineUtcMsc))
        {
            throw new InvalidDataException("update_staged_release_state_mismatch");
        }
        return await StageAsync(manifest, currentVersion, cancellationToken)
            ?? throw new InvalidDataException("update_staged_release_invalid");
    }

    private static async Task<bool> MatchesStagedReleaseAsync(
        string versionDirectory,
        ReleaseManifest expected,
        CancellationToken cancellationToken)
    {
        var executable = Path.Combine(versionDirectory, "AURUMBridge.exe");
        var markerPath = Path.Combine(versionDirectory, ReleaseMarkerFileName);
        if (!File.Exists(executable) || !File.Exists(markerPath))
        {
            return false;
        }
        try
        {
            ValidateStagedLayout(versionDirectory);
            await using var marker = new FileStream(
                markerPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous);
            var actual = await JsonSerializer.DeserializeAsync<ReleaseManifest>(
                marker,
                cancellationToken:cancellationToken);
            return actual is not null
                && actual.Signature == expected.Signature
                && ReleaseManifestVerifier.Canonicalize(actual)
                    == ReleaseManifestVerifier.Canonicalize(expected);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static void ValidatePackageSet(ReleaseManifest manifest, Version targetCoreVersion)
    {
        var moduleIds = manifest.Packages
            .Select(package => package.ModuleId)
            .ToHashSet(StringComparer.Ordinal);
        if (RequiredPackageIds.Any(moduleId => !moduleIds.Contains(moduleId)))
        {
            throw new InvalidDataException("update_required_package_missing");
        }
        var core = manifest.Packages.SingleOrDefault(package => package.ModuleId == "core")
            ?? throw new InvalidDataException("update_core_package_missing");
        if (!Version.TryParse(core.Version, out var coreVersion) || coreVersion != targetCoreVersion)
        {
            throw new InvalidDataException("update_core_version_mismatch");
        }
        foreach (var package in manifest.Packages)
        {
            if (package.MinimumCoreVersion is not null
                && (!Version.TryParse(package.MinimumCoreVersion, out var minimum)
                    || targetCoreVersion < minimum))
            {
                throw new InvalidDataException("update_package_core_incompatible");
            }
            if (package.MaximumCoreVersion is not null
                && (!Version.TryParse(package.MaximumCoreVersion, out var maximum)
                    || targetCoreVersion > maximum))
            {
                throw new InvalidDataException("update_package_core_incompatible");
            }
        }
    }

    internal static void ValidateStagedLayout(string versionDirectory)
    {
        foreach (var relativePath in RequiredCoreFiles)
        {
            if (!File.Exists(Path.Combine(versionDirectory, relativePath)))
            {
                throw new InvalidDataException("update_core_component_missing");
            }
        }
        if (!File.Exists(Path.Combine(
                versionDirectory, "modules", "adapter.mt5.python", "worker.py")))
        {
            throw new InvalidDataException("update_mt5_adapter_missing");
        }
        if (!File.Exists(Path.Combine(
                versionDirectory, "modules", "adapter.mt4", "AURUMBridgeEA.ex4")))
        {
            throw new InvalidDataException("update_mt4_adapter_missing");
        }
        _ = BridgeServerEndpointConfiguration.ReadPackaged(versionDirectory, required:true);
    }

    private static void DeleteTemporaryDirectory(string path, string expectedParent)
    {
        var fullPath = Path.GetFullPath(path);
        EnsureDescendant(expectedParent, fullPath);
        if (Directory.Exists(fullPath))
        {
            Directory.Delete(fullPath, recursive:true);
        }
    }

    private static void EnsureDescendant(string parent, string child)
    {
        var prefix = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(child).StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("update_path_invalid");
        }
    }

    private void EnsureSufficientDiskSpace(long requiredBytes)
    {
        long availableBytes;
        try
        {
            availableBytes = _availableFreeSpaceProvider(_installRoot);
        }
        catch (Exception error) when (error is not InvalidDataException)
        {
            throw new InvalidDataException("update_disk_space_check_failed", error);
        }
        if (availableBytes < 0)
        {
            throw new InvalidDataException("update_disk_space_check_failed");
        }
        if (availableBytes < requiredBytes)
        {
            throw new IOException("update_disk_space_insufficient");
        }
    }

    private static long ReadAvailableFreeSpace(string path)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(path));
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new InvalidDataException("update_disk_space_check_failed");
        }
        return new DriveInfo(root).AvailableFreeSpace;
    }

    private static void DeleteStaleCacheParts(string contentCacheDirectory)
    {
        Directory.CreateDirectory(contentCacheDirectory);
        foreach (var part in Directory.EnumerateFiles(
            contentCacheDirectory,
            "*.part",
            SearchOption.TopDirectoryOnly))
        {
            File.Delete(part);
        }
    }
}

public sealed record ReleaseActivationPointer
{
    [JsonPropertyName("active_version")]
    public required string ActiveVersion { get; init; }

    [JsonPropertyName("last_known_good_version")]
    public required string LastKnownGoodVersion { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

    [JsonPropertyName("expected_terminal_instance_ids")]
    public IReadOnlyList<string> ExpectedTerminalInstanceIds { get; init; } = [];

    [JsonPropertyName("updated_at_utc_msc")]
    public required long UpdatedAtUtcMsc { get; init; }
}

public sealed class ReleaseActivationStore(
    string pointerPath,
    Func<long>? clock = null)
{
    private readonly string _pointerPath = Path.GetFullPath(pointerPath);
    private readonly Func<long> _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    public async Task PrepareActivationAsync(
        StagedRelease stagedRelease,
        Version runningVersion,
        IReadOnlyList<string>? expectedTerminalInstanceIds = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stagedRelease);
        ArgumentNullException.ThrowIfNull(runningVersion);
        var pointer = await LoadAsync(cancellationToken);
        var versionsRoot = Path.Combine(Path.GetDirectoryName(_pointerPath)!, "versions");
        var versionDirectory = Path.GetFullPath(stagedRelease.VersionDirectory);
        var versionsPrefix = Path.GetFullPath(versionsRoot).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!Version.TryParse(stagedRelease.Version, out var stagedVersion)
            || stagedVersion <= runningVersion
            || pointer.ActiveVersion != runningVersion.ToString()
            || !versionDirectory.StartsWith(versionsPrefix, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(
                Path.GetFileName(Path.TrimEndingDirectorySeparator(versionDirectory)),
                stagedRelease.Version,
                StringComparison.Ordinal)
            || !File.Exists(Path.Combine(versionDirectory, "AURUMBridge.exe")))
        {
            throw new InvalidDataException("update_activation_invalid");
        }
        await SaveAsync(pointer with
        {
            ActiveVersion = stagedRelease.Version,
            Status = "pending",
            ExpectedTerminalInstanceIds = NormalizeTerminalInstanceIds(
                expectedTerminalInstanceIds),
            UpdatedAtUtcMsc = _clock(),
        }, cancellationToken);
    }

    private async Task<ReleaseActivationPointer> LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = new FileStream(
                _pointerPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous);
            var pointer = await JsonSerializer.DeserializeAsync<ReleaseActivationPointer>(
                stream,
                cancellationToken:cancellationToken)
                ?? throw new InvalidDataException("update_pointer_invalid");
            ValidatePointer(pointer);
            return pointer;
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("update_pointer_invalid", error);
        }
    }

    private async Task SaveAsync(ReleaseActivationPointer pointer, CancellationToken cancellationToken)
    {
        ValidatePointer(pointer);
        var directory = Path.GetDirectoryName(_pointerPath)!;
        var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(_pointerPath)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, pointer, cancellationToken:cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, _pointerPath, overwrite:true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static void ValidatePointer(ReleaseActivationPointer pointer)
    {
        if (!Version.TryParse(pointer.ActiveVersion, out _)
            || !Version.TryParse(pointer.LastKnownGoodVersion, out _)
            || pointer.Status is not ("pending" or "healthy" or "rolled_back")
            || pointer.ExpectedTerminalInstanceIds is null
            || NormalizeTerminalInstanceIds(pointer.ExpectedTerminalInstanceIds).Count
                != pointer.ExpectedTerminalInstanceIds.Count
            || pointer.UpdatedAtUtcMsc <= 0)
        {
            throw new InvalidDataException("update_pointer_invalid");
        }
    }

    private static IReadOnlyList<string> NormalizeTerminalInstanceIds(
        IReadOnlyList<string>? values)
    {
        if (values is null)
        {
            return [];
        }
        if (values.Count > 64
            || values.Any(value => string.IsNullOrWhiteSpace(value)
                || value.Length > 128
                || value.Any(character => !char.IsAsciiLetterOrDigit(character)
                    && character is not ('_' or '-'))))
        {
            throw new InvalidDataException("update_pointer_invalid");
        }
        return values.Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
    }
}
