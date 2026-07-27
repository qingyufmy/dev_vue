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

    [TestMethod]
    public async Task SelectedMt4TerminalDoesNotRestoreAnotherTerminalBinding()
    {
        await using var testStore = await TestStore.CreateAsync();
        var selectedPath = Path.Combine(testStore.DataDirectory, "Selected MT4");
        var otherPath = Path.Combine(testStore.DataDirectory, "Other MT4");
        Directory.CreateDirectory(selectedPath);
        Directory.CreateDirectory(otherPath);
        var selectedId = Workers.Mt4TerminalIdentity.CreateTerminalInstanceId(selectedPath);
        var otherId = Workers.Mt4TerminalIdentity.CreateTerminalInstanceId(otherPath);
        await testStore.Store.ActivateTerminalBindingAsync(
            selectedId, "mt4", selectedPath, new("Broker-One", "1001"), 1_800_000_000_000);
        await testStore.Store.ActivateTerminalBindingAsync(
            otherId, "mt4", otherPath, new("Broker-Two", "1002"), 1_800_000_000_000);
        var provisioner = new Mt4RuntimeProvisioner(testStore.Store);

        var result = await provisioner.ProvisionAsync([], selectedId);

        Assert.HasCount(1, result.Terminals);
        Assert.AreEqual(selectedId, result.Terminals[0].Binding.TerminalInstanceId);
        await result.Terminals[0].Supervisor.DisposeAsync();
    }

    [TestMethod]
    public async Task RestoresOnlyTheMainAndObserverMt4BindingsAllowedByTheHost()
    {
        await using var testStore = await TestStore.CreateAsync();
        var paths = new[] { "Main MT4", "Observer MT4", "Unrelated MT4" }
            .Select(name => Path.Combine(testStore.DataDirectory, name))
            .ToArray();
        foreach (var path in paths)
        {
            Directory.CreateDirectory(path);
        }
        var ids = paths.Select(path =>
            Workers.Mt4TerminalIdentity.CreateTerminalInstanceId(path)).ToArray();
        for (var index = 0; index < paths.Length; index++)
        {
            await testStore.Store.ActivateTerminalBindingAsync(
                ids[index],
                "mt4",
                paths[index],
                new("Broker", $"100{index}"),
                1_800_000_000_000);
        }
        var provisioner = new Mt4RuntimeProvisioner(testStore.Store);

        var result = await provisioner.ProvisionManyAsync(
            [],
            new HashSet<string>(StringComparer.Ordinal) { ids[0], ids[1] });

        CollectionAssert.AreEquivalent(
            new[] { ids[0], ids[1] },
            result.Terminals.Select(value => value.Binding.TerminalInstanceId).ToArray());
        foreach (var terminal in result.Terminals)
        {
            await terminal.Supervisor.DisposeAsync();
        }
    }
}
