using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeEndpointConnectivityTesterTests
{
    [TestMethod]
    public async Task ReportsBothIndependentConnectionChecks()
    {
        var checkedUris = new List<Uri>();
        var tester = new BridgeEndpointConnectivityTester(
            (uri, _) =>
            {
                checkedUris.Add(uri);
                return Task.CompletedTask;
            },
            (uri, _) =>
            {
                checkedUris.Add(uri);
                return Task.CompletedTask;
            });
        var configuration = new BridgeEndpointConfiguration(
            new Uri("https://control.example.com"),
            new Uri("ws://realtime.example.com"));

        var result = await tester.TestAsync(configuration);

        Assert.IsTrue(result.Success);
        CollectionAssert.AreEquivalent(
            new[] { configuration.ControlBaseUri, configuration.RealtimeBaseUri },
            checkedUris);
    }

    [TestMethod]
    public async Task ExplainsAPartialRealtimeFailureWithoutThrowing()
    {
        var tester = new BridgeEndpointConnectivityTester(
            (_, _) => Task.CompletedTask,
            (_, _) => Task.FromException(new IOException("offline")));

        var result = await tester.TestAsync(new(
            new Uri("https://control.example.com"),
            new Uri("wss://realtime.example.com")));

        Assert.IsTrue(result.ControlReachable);
        Assert.IsFalse(result.RealtimeReachable);
        StringAssert.Contains(result.Description, "实时通道");
    }
}
