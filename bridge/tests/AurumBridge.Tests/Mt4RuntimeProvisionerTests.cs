using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4RuntimeProvisionerTests
{
    [TestMethod]
    public async Task RestoresPersistedMt4BindingWithNewEpoch()
    {
        await using var testStore = await TestStore.CreateAsync();
        var dataPath = Path.Combine(testStore.DataDirectory, "MT4 Data");
        Directory.CreateDirectory(dataPath);
        var terminalId = Workers.Mt4TerminalIdentity.CreateTerminalInstanceId(dataPath);
        await testStore.Store.ActivateTerminalBindingAsync(
            terminalId,
            "mt4",
            dataPath,
            new("Broker-Demo", "12345678"),
            1_800_000_000_000);
        var provisioner = new Mt4RuntimeProvisioner(testStore.Store, () => 1_800_000_000_100);

        var result = await provisioner.ProvisionAsync([]);

        Assert.HasCount(1, result.Terminals);
        Assert.IsEmpty(result.Failures);
        Assert.AreEqual(2L, result.Terminals[0].Binding.ConnectionEpoch);
        Assert.AreEqual("mt4", result.Terminals[0].Supervisor.Terminal.Platform);
        await result.Terminals[0].Supervisor.DisposeAsync();
    }

    [TestMethod]
    public async Task MissingPersistedDataPathDoesNotBlockOtherPlatforms()
    {
        await using var testStore = await TestStore.CreateAsync();
        var missingPath = Path.Combine(testStore.DataDirectory, "missing");
        var terminalId = Workers.Mt4TerminalIdentity.CreateTerminalInstanceId(missingPath);
        await testStore.Store.ActivateTerminalBindingAsync(
            terminalId,
            "mt4",
            missingPath,
            new("Broker-Demo", "12345678"),
            1_800_000_000_000);
        var provisioner = new Mt4RuntimeProvisioner(testStore.Store);

        var result = await provisioner.ProvisionAsync([]);

        Assert.IsEmpty(result.Terminals);
        Assert.HasCount(1, result.Failures);
        Assert.AreEqual("mt4_terminal_data_path_not_found", result.Failures[0].ErrorCode);
    }
}
