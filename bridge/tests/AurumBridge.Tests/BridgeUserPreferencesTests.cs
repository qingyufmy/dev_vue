using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeUserPreferencesTests
{
    private string _directory = null!;
    private string _path = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), "aurum-preferences-tests", Guid.NewGuid().ToString("N"));
        _path = Path.Combine(_directory, "preferences.json");
    }

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive:true);
        }
    }

    [TestMethod]
    public async Task RequiresAnExplicitFirstPlatformSelectionAndPersistsIt()
    {
        var store = new BridgeUserPreferencesStore(_path);
        Assert.IsNull((await store.LoadAsync()).Platform);

        await store.SavePlatformAsync("MT4");

        Assert.AreEqual(BridgePlatform.Mt4, (await new BridgeUserPreferencesStore(_path).LoadAsync()).Platform);
    }

    [TestMethod]
    public async Task InvalidOrCorruptPreferenceFailsBackToSelection()
    {
        Directory.CreateDirectory(_directory);
        await File.WriteAllTextAsync(_path, "{not-json");
        Assert.IsNull((await new BridgeUserPreferencesStore(_path).LoadAsync()).Platform);

        await File.WriteAllTextAsync(_path, "{\"Platform\":\"mt6\"}");
        Assert.IsNull((await new BridgeUserPreferencesStore(_path).LoadAsync()).Platform);
    }

    [TestMethod]
    public async Task PlatformAndMt5TerminalSelectionsArePreservedIndependently()
    {
        var store = new BridgeUserPreferencesStore(_path);
        const string terminalId = "mt5_0123456789abcdef01234567";

        await store.SaveMt5TerminalAsync(terminalId);
        await store.SavePlatformAsync(BridgePlatform.Mt5);
        var preferences = await store.LoadAsync();

        Assert.AreEqual(BridgePlatform.Mt5, preferences.Platform);
        Assert.AreEqual(terminalId, preferences.Mt5TerminalInstanceId);

        await store.SavePlatformAsync(BridgePlatform.Mt4);
        Assert.AreEqual(
            terminalId,
            (await store.LoadAsync()).Mt5TerminalInstanceId);
    }

    [TestMethod]
    public async Task ObserverProfilePersistsItsDedicatedMt5ExecutablePath()
    {
        var store = new BridgeUserPreferencesStore(_path);
        var terminalPath = Path.Combine(_directory, "Broker MT5", "terminal64.exe");

        await store.SaveMt5TerminalPathAsync(terminalPath);
        await store.SavePlatformAsync(BridgePlatform.Mt5);
        var preferences = await new BridgeUserPreferencesStore(_path).LoadAsync();

        Assert.AreEqual(BridgePlatform.Mt5, preferences.Platform);
        Assert.AreEqual(Path.GetFullPath(terminalPath), preferences.Mt5TerminalPath);
    }

    [TestMethod]
    public async Task InvalidMt5TerminalSelectionIsIgnored()
    {
        Directory.CreateDirectory(_directory);
        await File.WriteAllTextAsync(
            _path,
            "{\"Platform\":\"mt5\",\"Mt5TerminalInstanceId\":\"../../unsafe\"}");

        var preferences = await new BridgeUserPreferencesStore(_path).LoadAsync();

        Assert.AreEqual(BridgePlatform.Mt5, preferences.Platform);
        Assert.IsNull(preferences.Mt5TerminalInstanceId);
    }

    [TestMethod]
    public async Task UnsafeOrNonTerminalMt5PathIsIgnored()
    {
        Directory.CreateDirectory(_directory);
        await File.WriteAllTextAsync(
            _path,
            "{\"Platform\":\"mt5\",\"Mt5TerminalPath\":\"../../unsafe.exe\"}");

        var preferences = await new BridgeUserPreferencesStore(_path).LoadAsync();

        Assert.AreEqual(BridgePlatform.Mt5, preferences.Platform);
        Assert.IsNull(preferences.Mt5TerminalPath);
    }
}
