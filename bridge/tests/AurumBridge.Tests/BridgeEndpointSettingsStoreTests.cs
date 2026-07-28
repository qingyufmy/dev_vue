using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeEndpointSettingsStoreTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-endpoints-{Guid.NewGuid():N}");
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
    public async Task PersistsAndClearsASeparatedControlAndRealtimeEndpoint()
    {
        var store = new BridgeEndpointSettingsStore(_directory);
        Assert.IsNull(store.Load());

        await store.SaveAsync(new(
            new Uri("https://control.example.com"),
            new Uri("ws://realtime.example.com:8080")));
        var saved = new BridgeEndpointSettingsStore(_directory).Load();

        Assert.IsNotNull(saved);
        Assert.AreEqual("https://control.example.com/", saved.ControlBaseUri.AbsoluteUri);
        Assert.AreEqual("ws://realtime.example.com:8080/", saved.RealtimeBaseUri.AbsoluteUri);
        await store.ClearAsync();
        Assert.IsFalse(store.Exists);
    }

    [TestMethod]
    public void RejectsUnsafeControlAddressesAndRealtimePaths()
    {
        var controlError = Assert.ThrowsExactly<InvalidDataException>(() =>
            BridgeEndpointSettingsStore.Normalize(
                "http://remote.example.com",
                "ws://remote.example.com"));
        var realtimeError = Assert.ThrowsExactly<InvalidDataException>(() =>
            BridgeEndpointSettingsStore.Normalize(
                "https://control.example.com",
                "wss://realtime.example.com/custom/path"));

        Assert.AreEqual("bridge_server_url_invalid", controlError.Message);
        Assert.AreEqual("bridge_realtime_url_invalid", realtimeError.Message);
    }

    [TestMethod]
    public void DerivesTheRealtimeEndpointFromOneServerAddress()
    {
        var remote = BridgeEndpointSettingsStore.FromServerUrl(
            "https://control.example.com");
        var local = BridgeEndpointSettingsStore.FromServerUrl(
            "http://127.0.0.1:3000");

        Assert.AreEqual("https://control.example.com/", remote.ControlBaseUri.AbsoluteUri);
        Assert.AreEqual("wss://control.example.com/", remote.RealtimeBaseUri.AbsoluteUri);
        Assert.AreEqual("http://127.0.0.1:3000/", local.ControlBaseUri.AbsoluteUri);
        Assert.AreEqual("ws://127.0.0.1:3000/", local.RealtimeBaseUri.AbsoluteUri);
    }

    [TestMethod]
    public void RejectsUnknownFieldsInsteadOfSilentlyChangingTheirMeaning()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllText(
            Path.Combine(_directory, BridgeEndpointSettingsStore.FileName),
            """{"schema_version":1,"control_url":"https://control.example.com","realtime_url":"wss://realtime.example.com","extra":true}""");

        var error = Assert.ThrowsExactly<InvalidDataException>(() =>
            new BridgeEndpointSettingsStore(_directory).Load());

        Assert.AreEqual("bridge_endpoint_settings_invalid", error.Message);
    }
}
