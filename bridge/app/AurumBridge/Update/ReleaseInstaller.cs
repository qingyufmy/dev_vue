using System.Text.Json;
using System.Text.Json.Serialization;

namespace AurumBridge.Update;

public sealed record StagedRelease(string Version, string VersionDirectory);

public sealed class ReleaseInstaller(
    string installRoot,
    ReleaseStager stager)
{
    private const string ReleaseMarkerFileName = ".aurum-release.json";
    private readonly string _installRoot = Path.GetFullPath(installRoot);
    private readonly ReleaseStager _stager = stager ?? throw new ArgumentNullException(nameof(stager));

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
                ? new(manifest.ReleaseVersion, finalVersionDirectory)
                : throw new IOException("update_version_already_exists");
        }

        var operationId = Guid.NewGuid().ToString("N");
        var downloadDirectory = Path.Combine(_installRoot, "staging", $"{manifest.ReleaseVersion}-{operationId}");
        var temporaryVersionDirectory = Path.Combine(versionsRoot, $".{manifest.ReleaseVersion}-{operationId}.tmp");
        EnsureDescendant(Path.Combine(_installRoot, "staging"), downloadDirectory);
        EnsureDescendant(versionsRoot, temporaryVersionDirectory);
        Directory.CreateDirectory(downloadDirectory);
        Directory.CreateDirectory(temporaryVersionDirectory);
        try
        {
            var downloads = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
            {
                downloads[package.ModuleId] = await _stager.DownloadPackageAsync(
                    package,
                    downloadDirectory,
                    cancellationToken);
            }
            foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
            {
                var destination = package.ModuleId == "core"
                    ? temporaryVersionDirectory
                    : Path.Combine(temporaryVersionDirectory, "modules", package.ModuleId);
                ReleaseStager.ExtractPackage(downloads[package.ModuleId], destination);
            }
            var executable = Path.Combine(temporaryVersionDirectory, "AURUMBridge.exe");
            if (!File.Exists(executable))
            {
                throw new InvalidDataException("update_core_executable_missing");
            }
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
            return new(manifest.ReleaseVersion, finalVersionDirectory);
        }
        finally
        {
            DeleteTemporaryDirectory(temporaryVersionDirectory, versionsRoot);
            DeleteTemporaryDirectory(downloadDirectory, Path.Combine(_installRoot, "staging"));
        }
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
}

public sealed record ReleaseActivationPointer
{
    [JsonPropertyName("active_version")]
    public required string ActiveVersion { get; init; }

    [JsonPropertyName("last_known_good_version")]
    public required string LastKnownGoodVersion { get; init; }

    [JsonPropertyName("status")]
    public required string Status { get; init; }

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
            || pointer.UpdatedAtUtcMsc <= 0)
        {
            throw new InvalidDataException("update_pointer_invalid");
        }
    }
}
