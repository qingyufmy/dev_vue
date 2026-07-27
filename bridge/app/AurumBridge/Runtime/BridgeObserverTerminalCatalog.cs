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
            if (current.Platform != BridgePlatform.Mt5
                || string.IsNullOrWhiteSpace(current.Mt5TerminalPath)
                || !File.Exists(current.Mt5TerminalPath))
            {
                continue;
            }
            var path = Path.GetFullPath(current.Mt5TerminalPath);
            var terminalId = Mt5TerminalDiscovery.CreateTerminalInstanceId(path);
            if (!seenTerminalIds.Add(terminalId))
            {
                continue;
            }
            terminals.Add(new(
                profileId,
                BridgePlatform.Mt5,
                terminalId,
                path));
        }
        return terminals;
    }
}
