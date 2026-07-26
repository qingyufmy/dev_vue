using System.Diagnostics;

namespace AurumBridge.Runtime;

public static class BridgeRuntimeProfile
{
    public const string DefaultId = "default";

    public static string Validate(string? profileId)
    {
        var value = string.IsNullOrWhiteSpace(profileId)
            ? DefaultId
            : profileId.Trim().ToLowerInvariant();
        if (value.Length > 40
            || value.Any(character => !char.IsAsciiLetterOrDigit(character)
                && character is not ('-' or '_')))
        {
            throw new ArgumentException("bridge_profile_id_invalid", nameof(profileId));
        }
        return value;
    }

    public static bool IsDefault(string profileId) =>
        string.Equals(Validate(profileId), DefaultId, StringComparison.Ordinal);

    public static string InstanceId(string profileId)
    {
        var validated = Validate(profileId);
        return IsDefault(validated)
            ? "AURUMBridge.v3"
            : $"AURUMBridge.v3.profile.{validated}";
    }

    public static string ResolveDataDirectory(string rootDataDirectory, string profileId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDataDirectory);
        var root = Path.GetFullPath(rootDataDirectory);
        var validated = Validate(profileId);
        return IsDefault(validated)
            ? root
            : Path.Combine(root, "profiles", validated);
    }

    public static IReadOnlyList<string> ListObserverProfiles(string rootDataDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDataDirectory);
        var profilesDirectory = Path.Combine(Path.GetFullPath(rootDataDirectory), "profiles");
        if (!Directory.Exists(profilesDirectory))
        {
            return [];
        }
        return Directory.EnumerateDirectories(profilesDirectory)
            .Select(Path.GetFileName)
            .Where(name => name is not null)
            .Select(name => Validate(name!))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
    }

    public static string CreateObserverProfile(string rootDataDirectory, string profileId)
    {
        var validated = Validate(profileId);
        if (IsDefault(validated))
        {
            throw new ArgumentException("bridge_profile_id_reserved", nameof(profileId));
        }
        var directory = ResolveDataDirectory(rootDataDirectory, validated);
        Directory.CreateDirectory(directory);
        return directory;
    }

    public static ProcessStartInfo BuildLaunchInfo(string profileId)
    {
        var validated = Validate(profileId);
        var processPath = Environment.ProcessPath
            ?? throw new InvalidOperationException("bridge_process_path_unavailable");
        var info = new ProcessStartInfo
        {
            FileName = processPath,
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = true,
        };
        if (string.Equals(
                Path.GetFileNameWithoutExtension(processPath),
                "dotnet",
                StringComparison.OrdinalIgnoreCase))
        {
            info.ArgumentList.Add(typeof(BridgeRuntimeProfile).Assembly.Location);
        }
        info.ArgumentList.Add("--profile");
        info.ArgumentList.Add(validated);
        return info;
    }
}
