using AurumBridge.Workers;

namespace AurumBridge.Runtime;

public sealed record BridgeObserverTerminalConfiguration(
    string ProfileId,
    string Platform,
    string TerminalInstanceId,
    string TerminalPath);

public static class BridgeObserverTerminalCatalog
{
    public static async Task<IReadOnlyList<BridgeObserverTerminalConfiguration>> LoadAsync(
        string rootDataDirectory,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDataDirectory);
        var terminals = new List<BridgeObserverTerminalConfiguration>();
        var seenTerminalIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var profileId in BridgeRuntimeProfile.ListObserverProfiles(rootDataDirectory))
        {
            var profileDirectory = BridgeRuntimeProfile.ResolveDataDirectory(
                rootDataDirectory,
                profileId);
            var preferences = new BridgeUserPreferencesStore(
                Path.Combine(profileDirectory, "preferences.json"));
            var current = await preferences.LoadAsync(cancellationToken);
            BridgeObserverTerminalConfiguration? terminal = current.Platform switch
            {
                BridgePlatform.Mt5 => ResolveMt5(profileId, current),
                BridgePlatform.Mt4 => ResolveMt4(profileId, current),
                _ => null,
            };
            if (terminal is null || !seenTerminalIds.Add(terminal.TerminalInstanceId))
            {
                continue;
            }
            terminals.Add(terminal);
        }
        return terminals;
    }

    private static BridgeObserverTerminalConfiguration? ResolveMt5(
        string profileId,
        BridgeUserPreferences preferences)
    {
        if (string.IsNullOrWhiteSpace(preferences.Mt5TerminalPath)
            || !File.Exists(preferences.Mt5TerminalPath))
        {
            return null;
        }
        var path = Path.GetFullPath(preferences.Mt5TerminalPath);
        return new(
            profileId,
            BridgePlatform.Mt5,
            Mt5TerminalDiscovery.CreateTerminalInstanceId(path),
            path);
    }

    private static BridgeObserverTerminalConfiguration? ResolveMt4(
        string profileId,
        BridgeUserPreferences preferences)
    {
        if (string.IsNullOrWhiteSpace(preferences.Mt4TerminalPath)
            || string.IsNullOrWhiteSpace(preferences.Mt4TerminalInstanceId)
            || !Directory.Exists(Path.Combine(preferences.Mt4TerminalPath, "MQL4")))
        {
            return null;
        }
        var path = Path.GetFullPath(preferences.Mt4TerminalPath);
        var terminalId = Mt4TerminalIdentity.CreateTerminalInstanceId(path);
        if (terminalId != preferences.Mt4TerminalInstanceId)
        {
            return null;
        }
        return new(
            profileId,
            BridgePlatform.Mt4,
            terminalId,
            path);
    }
}
