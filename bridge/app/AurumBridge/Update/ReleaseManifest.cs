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

    [JsonPropertyName("generated_at_utc_msc")]
    public required long GeneratedAtUtcMsc { get; init; }

    [JsonPropertyName("minimum_launcher_version")]
    public required string MinimumLauncherVersion { get; init; }

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

    public ReleaseManifestVerifier(string subjectPublicKeyInfoPem)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(subjectPublicKeyInfoPem);
        _publicKey = ECDsa.Create();
        _publicKey.ImportFromPem(subjectPublicKeyInfoPem);
    }

    public void Verify(ReleaseManifest manifest, Version launcherVersion)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(launcherVersion);
        ValidateManifest(manifest, launcherVersion);
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
    }

    public static string Canonicalize(ReleaseManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var builder = new StringBuilder()
            .Append("AURUM-RELEASE-V1\n")
            .Append(manifest.SchemaVersion).Append('\n')
            .Append(manifest.ReleaseVersion).Append('\n')
            .Append(manifest.GeneratedAtUtcMsc).Append('\n')
            .Append(manifest.MinimumLauncherVersion).Append('\n');
        foreach (var package in manifest.Packages.OrderBy(value => value.ModuleId, StringComparer.Ordinal))
        {
            builder.Append(package.ModuleId).Append('|')
                .Append(package.Version).Append('|')
                .Append(package.Url.AbsoluteUri).Append('|')
                .Append(package.SizeBytes).Append('|')
                .Append(package.Sha256.ToLowerInvariant()).Append('|')
                .Append(package.MinimumCoreVersion ?? string.Empty).Append('|')
                .Append(package.MaximumCoreVersion ?? string.Empty).Append('\n');
        }
        return builder.ToString();
    }

    public void Dispose() => _publicKey.Dispose();

    private static void ValidateManifest(ReleaseManifest manifest, Version launcherVersion)
    {
        if (manifest.SchemaVersion != 1
            || !Version.TryParse(manifest.ReleaseVersion, out _)
            || manifest.GeneratedAtUtcMsc <= 0
            || !Version.TryParse(manifest.MinimumLauncherVersion, out var minimumLauncher)
            || launcherVersion < minimumLauncher
            || manifest.Packages.Count is < 1 or > 16
            || string.IsNullOrWhiteSpace(manifest.Signature))
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
                || package.Url.Scheme != Uri.UriSchemeHttps && !isLocalHttp
                || package.Url.UserInfo.Length > 0)
            {
                throw new InvalidDataException("update_manifest_package_invalid");
            }
        }
    }
}
