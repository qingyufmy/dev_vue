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
}
