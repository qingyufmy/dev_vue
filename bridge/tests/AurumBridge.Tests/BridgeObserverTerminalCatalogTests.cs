using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeObserverTerminalCatalogTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-observers-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive:true);

    [TestMethod]
    public async Task LoadsConfiguredMt5ProfilesAndIgnoresIncompleteProfiles()
    {
        var terminalPath = CreateFile("terminals", "source-a", "terminal64.exe");
        await SaveProfileAsync("source-a", terminalPath);
        BridgeRuntimeProfile.CreateObserverProfile(_directory, "incomplete");

        var terminals = await BridgeObserverTerminalCatalog.LoadAsync(_directory);

        Assert.HasCount(1, terminals);
        Assert.AreEqual("source-a", terminals[0].ProfileId);
        Assert.AreEqual(BridgePlatform.Mt5, terminals[0].Platform);
        Assert.AreEqual(Path.GetFullPath(terminalPath), terminals[0].TerminalPath);
        Assert.AreEqual(
            Mt5TerminalDiscovery.CreateTerminalInstanceId(terminalPath),
            terminals[0].TerminalInstanceId);
    }

    [TestMethod]
    public async Task ASharedTerminalPathIsNeverLoadedIntoTwoObserverWorkers()
    {
        var terminalPath = CreateFile("terminals", "shared", "terminal64.exe");
        await SaveProfileAsync("source-a", terminalPath);
        await SaveProfileAsync("source-b", terminalPath);

        var terminals = await BridgeObserverTerminalCatalog.LoadAsync(_directory);

        Assert.HasCount(1, terminals);
        Assert.AreEqual("source-a", terminals[0].ProfileId);
    }

    [TestMethod]
    public async Task PausedProfileKeepsItsConfigurationButIsExcludedFromRuntimeCatalog()
    {
        var terminalPath = CreateFile("terminals", "paused", "terminal64.exe");
        await SaveProfileAsync("paused", terminalPath);
        var profileDirectory = BridgeRuntimeProfile.ResolveDataDirectory(_directory, "paused");
        var preferences = new BridgeUserPreferencesStore(
            Path.Combine(profileDirectory, "preferences.json"));
        await preferences.SaveObserverEnabledAsync(false);

        var terminals = await BridgeObserverTerminalCatalog.LoadAsync(_directory);
        var stored = await preferences.LoadAsync();

        Assert.IsEmpty(terminals);
        Assert.IsFalse(stored.ObserverEnabled);
        Assert.AreEqual(Path.GetFullPath(terminalPath), stored.Mt5TerminalPath);
    }

    [TestMethod]
    public async Task LoadsAnMt4ObserverFromItsDedicatedTerminalDataPath()
    {
        var terminalDataPath = Path.Combine(_directory, "mt4-data");
        Directory.CreateDirectory(Path.Combine(terminalDataPath, "MQL4"));
        var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(
            _directory,
            "mt4-source");
        var preferences = new BridgeUserPreferencesStore(
            Path.Combine(profileDirectory, "preferences.json"));
        var terminalId = Mt4TerminalIdentity.CreateTerminalInstanceId(terminalDataPath);
        await preferences.SavePlatformAsync(BridgePlatform.Mt4);
        await preferences.SaveMt4TerminalAsync(terminalId);
        await preferences.SaveMt4TerminalPathAsync(terminalDataPath);

        var terminals = await BridgeObserverTerminalCatalog.LoadAsync(_directory);

        Assert.HasCount(1, terminals);
        Assert.AreEqual("mt4-source", terminals[0].ProfileId);
        Assert.AreEqual(BridgePlatform.Mt4, terminals[0].Platform);
        Assert.AreEqual(terminalId, terminals[0].TerminalInstanceId);
        Assert.AreEqual(Path.GetFullPath(terminalDataPath), terminals[0].TerminalPath);
    }

    [TestMethod]
    public void ControllerRejectsDuplicateOrMismatchedObserverRoutes()
    {
        var terminalPath = Path.Combine(_directory, "terminal64.exe");
        var terminalId = Mt5TerminalDiscovery.CreateTerminalInstanceId(terminalPath);
        var first = new BridgeObserverTerminalConfiguration(
            "source-a", BridgePlatform.Mt5, terminalId, terminalPath);
        var duplicate = first with { ProfileId = "source-b" };
        var mismatched = first with
        {
            TerminalInstanceId = "mt5_0123456789abcdef01234567",
        };

        Assert.ThrowsExactly<ArgumentException>(() =>
            BridgeApplicationController.NormalizeObserverTerminals([first, duplicate]));
        Assert.ThrowsExactly<ArgumentException>(() =>
            BridgeApplicationController.NormalizeObserverTerminals([mismatched]));

        var mt4Path = Path.Combine(_directory, "mt4-data");
        var mt4 = new BridgeObserverTerminalConfiguration(
            "mt4-source",
            BridgePlatform.Mt4,
            Mt4TerminalIdentity.CreateTerminalInstanceId(mt4Path),
            mt4Path);
        var normalized = BridgeApplicationController.NormalizeObserverTerminals([mt4]);
        Assert.AreEqual(BridgePlatform.Mt4, normalized[0].Platform);
    }

    private async Task SaveProfileAsync(string profileId, string terminalPath)
    {
        var profileDirectory = BridgeRuntimeProfile.CreateObserverProfile(_directory, profileId);
        var preferences = new BridgeUserPreferencesStore(
            Path.Combine(profileDirectory, "preferences.json"));
        await preferences.SavePlatformAsync(BridgePlatform.Mt5);
        await preferences.SaveMt5TerminalAsync(
            Mt5TerminalDiscovery.CreateTerminalInstanceId(terminalPath));
        await preferences.SaveMt5TerminalPathAsync(terminalPath);
    }

    private string CreateFile(params string[] parts)
    {
        var path = Path.Combine([_directory, .. parts]);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, []);
        return path;
    }
}
