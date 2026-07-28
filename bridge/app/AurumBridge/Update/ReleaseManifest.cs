using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace AurumBridge.Update;

public sealed record ReleasePackage
{
    [JsonPropertyName("module_id")]
    public required string ModuleId { get; init; }

    [JsonPropertyName("version")]
    public required string Version { get; init; }

    [JsonPropertyName("url")]
    public required Uri Url { get; init; }

    [JsonPropertyName("size_bytes")]
    public required long SizeBytes { get; init; }

    [JsonPropertyName("sha256")]
    public required string Sha256 { get; init; }

    [JsonPropertyName("signature")]
    public required string Signature { get; init; }

    [JsonPropertyName("minimum_core_version")]
    public string? MinimumCoreVersion { get; init; }

    [JsonPropertyName("maximum_core_version")]
    public string? MaximumCoreVersion { get; init; }
}

public sealed record ReleaseManifest
{
    [JsonPropertyName("schema_version")]
    public int SchemaVersion { get; init; } = 1;

    [JsonPropertyName("release_version")]
    public required string ReleaseVersion { get; init; }

    [JsonPropertyName("release_id")]
    public string? ReleaseId { get; init; }

    [JsonPropertyName("generated_at_utc_msc")]
    public required long GeneratedAtUtcMsc { get; init; }

    [JsonPropertyName("published_at_utc_msc")]
    public long? PublishedAtUtcMsc { get; init; }

    [JsonPropertyName("expires_at_utc_msc")]
    public long? ExpiresAtUtcMsc { get; init; }

    [JsonPropertyName("priority")]
    public string? Priority { get; init; }

    [JsonPropertyName("minimum_launcher_version")]
    public required string MinimumLauncherVersion { get; init; }

    [JsonPropertyName("minimum_idle_seconds")]
    public int? MinimumIdleSeconds { get; init; }

    [JsonPropertyName("activation_deadline_utc_msc")]
    public long? ActivationDeadlineUtcMsc { get; init; }

    [JsonPropertyName("rollout_channel")]
    public string? RolloutChannel { get; init; }

    [JsonPropertyName("rollout_percentage")]
    public int? RolloutPercentage { get; init; }

    [JsonPropertyName("packages")]
    public required IReadOnlyList<ReleasePackage> Packages { get; init; }

    [JsonPropertyName("signature")]
    public required string Signature { get; init; }
}

public sealed class ReleaseManifestVerifier : IDisposable
{
    private static readonly HashSet<string> AllowedModuleIds = new(StringComparer.Ordinal)
    {
        "core",
        "adapter.mt5.python",
        "adapter.mt4",
        "data.symbol-map",
    };
    private readonly ECDsa _publicKey;
    private readonly Func<long> _clock;

    public ReleaseManifestVerifier(
        string subjectPublicKeyInfoPem,
        Func<long>? clock = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(subjectPublicKeyInfoPem);
        _publicKey = ECDsa.Create();
        _publicKey.ImportFromPem(subjectPublicKeyInfoPem);
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public void Verify(ReleaseManifest manifest, Version launcherVersion)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(launcherVersion);
        ValidateManifest(manifest, launcherVersion, _clock());
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(manifest.Signature);
        }
        catch (FormatException error)
        {
            throw new InvalidDataException("update_manifest_signature_invalid", error);
        }
        var payload = Encoding.UTF8.GetBytes(Canonicalize(manifest));
        if (!_publicKey.VerifyData(payload, signature, HashAlgorithmName.SHA256))
        {
            throw new InvalidDataException("update_manifest_signature_invalid");
        }
        foreach (var package in manifest.Packages)
        {
            VerifyPackage(package);
        }
    }

    public static string Canonicalize(ReleaseManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var builder = manifest.SchemaVersion switch
        {
            1 => new StringBuilder()
                .Append("AURUM-RELEASE-V1\n")
                .Append(manifest.SchemaVersion).Append('\n')
                .Append(manifest.ReleaseVersion).Append('\n')
                .Append(manifest.GeneratedAtUtcMsc).Append('\n')
                .Append(manifest.MinimumLauncherVersion).Append('\n'),
            2 => new StringBuilder()
                .Append("AURUM-RELEASE-V2\n")
                .Append(manifest.SchemaVersion).Append('\n')
                .Append(manifest.ReleaseId).Append('\n')
                .Append(manifest.ReleaseVersion).Append('\n')
                .Append(manifest.GeneratedAtUtcMsc).Append('\n')
                .Append(manifest.PublishedAtUtcMsc).Append('\n')
                .Append(manifest.ExpiresAtUtcMsc).Append('\n')
                .Append(manifest.Priority).Append('\n')
                .Append(manifest.MinimumLauncherVersion).Append('\n')
                .Append(manifest.MinimumIdleSeconds).Append('\n')
                .Append(manifest.ActivationDeadlineUtcMsc?.ToString() ?? string.Empty).Append('\n')
                .Append(manifest.RolloutChannel).Append('\n')
                .Append(manifest.RolloutPercentage).Append('\n'),
            _ => throw new InvalidDataException("update_manifest_schema_unsupported"),
        };
        foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
        {
            builder.Append(package.ModuleId).Append('|')
                .Append(package.Version).Append('|')
                .Append(package.Url.AbsoluteUri).Append('|')
                .Append(package.SizeBytes).Append('|')
                .Append(package.Sha256.ToLowerInvariant()).Append('|')
                .Append(package.Signature).Append('|')
                .Append(package.MinimumCoreVersion ?? string.Empty).Append('|')
                .Append(package.MaximumCoreVersion ?? string.Empty).Append('\n');
        }
        return builder.ToString();
    }

    public static string CanonicalizePackage(ReleasePackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        return new StringBuilder()
            .Append("AURUM-PACKAGE-V1\n")
            .Append(package.ModuleId).Append('\n')
            .Append(package.Version).Append('\n')
            .Append(package.Url.AbsoluteUri).Append('\n')
            .Append(package.SizeBytes).Append('\n')
            .Append(package.Sha256.ToLowerInvariant()).Append('\n')
            .Append(package.MinimumCoreVersion ?? string.Empty).Append('\n')
            .Append(package.MaximumCoreVersion ?? string.Empty).Append('\n')
            .ToString();
    }

    public void Dispose() => _publicKey.Dispose();

    private static void ValidateManifest(
        ReleaseManifest manifest,
        Version launcherVersion,
        long nowUtcMsc)
    {
        if (manifest.SchemaVersion is not (1 or 2)
            || !Version.TryParse(manifest.ReleaseVersion, out _)
            || manifest.GeneratedAtUtcMsc <= 0
            || !Version.TryParse(manifest.MinimumLauncherVersion, out var minimumLauncher)
            || launcherVersion < minimumLauncher
            || manifest.Packages.Count is < 1 or > 16
            || string.IsNullOrWhiteSpace(manifest.Signature))
        {
            throw new InvalidDataException("update_manifest_invalid");
        }
        if (manifest.SchemaVersion == 2
            && (!ValidReleaseId(manifest.ReleaseId)
                || manifest.Priority is not ("normal" or "urgent")
                || manifest.PublishedAtUtcMsc is not > 0
                || manifest.ExpiresAtUtcMsc is not > 0
                || manifest.ExpiresAtUtcMsc <= manifest.PublishedAtUtcMsc
                || manifest.ExpiresAtUtcMsc <= nowUtcMsc
                || manifest.GeneratedAtUtcMsc > manifest.ExpiresAtUtcMsc
                || manifest.MinimumIdleSeconds is not (>= 30 and <= 3600)
                || manifest.ActivationDeadlineUtcMsc is { } activationDeadline
                    && (activationDeadline <= manifest.PublishedAtUtcMsc
                        || activationDeadline > manifest.ExpiresAtUtcMsc)
                || manifest.RolloutChannel is not ("internal" or "stable")
                || manifest.RolloutPercentage is not (>= 1 and <= 100)))
        {
            throw new InvalidDataException("update_manifest_invalid");
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var package in manifest.Packages)
        {
            var isLocalHttp = package.Url.IsLoopback && package.Url.Scheme == Uri.UriSchemeHttp;
            if (!AllowedModuleIds.Contains(package.ModuleId)
                || !seen.Add(package.ModuleId)
                || !Version.TryParse(package.Version, out _)
                || package.SizeBytes is <= 0 or > 512L * 1024 * 1024
                || package.Sha256.Length != 64
                || package.Sha256.Any(character => !Uri.IsHexDigit(character))
                || string.IsNullOrWhiteSpace(package.Signature)
                || package.Url.Scheme != Uri.UriSchemeHttps && !isLocalHttp
                || package.Url.UserInfo.Length > 0)
            {
                throw new InvalidDataException("update_manifest_package_invalid");
            }
        }
    }

    private static bool ValidReleaseId(string? releaseId) => releaseId is { Length: >= 8 and <= 128 }
        && releaseId.All(character => char.IsAsciiLetterOrDigit(character)
            || character is '.' or '_' or ':' or '-');

    private void VerifyPackage(ReleasePackage package)
    {
        byte[] signature;
        try
        {
            signature = Convert.FromBase64String(package.Signature);
        }
        catch (FormatException error)
        {
            throw new InvalidDataException("update_package_signature_invalid", error);
        }
        var payload = Encoding.UTF8.GetBytes(CanonicalizePackage(package));
        if (!_publicKey.VerifyData(payload, signature, HashAlgorithmName.SHA256))
        {
            throw new InvalidDataException("update_package_signature_invalid");
        }
    }
}
