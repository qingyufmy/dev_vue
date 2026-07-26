using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeSingleInstanceGuardTests
{
    private readonly List<string> _directories = [];

    [TestCleanup]
    public void Cleanup()
    {
        foreach (var directory in _directories.Where(Directory.Exists))
        {
            Directory.Delete(directory, recursive:true);
        }
    }

    [TestMethod]
    public async Task SecondProcessSignalsTheOwnerInsteadOfAcquiringExecutionAuthority()
    {
        var instanceId = $"AURUMBridge.test.{Guid.NewGuid():N}";
        var directory = Path.Combine(Path.GetTempPath(), instanceId);
        _directories.Add(directory);
        using var owner = BridgeSingleInstanceGuard.TryAcquire(instanceId, directory);
        Assert.IsNotNull(owner);
        var activated = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.ActivationRequested += () => activated.TrySetResult();
        owner.StartActivationListener();

        var duplicate = await Task.Run(() => BridgeSingleInstanceGuard.TryAcquire(instanceId, directory));

        Assert.IsNull(duplicate);
        await activated.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [TestMethod]
    public async Task AuthorityCanBeAcquiredAfterTheOwnerExits()
    {
        var instanceId = $"AURUMBridge.test.{Guid.NewGuid():N}";
        var directory = Path.Combine(Path.GetTempPath(), instanceId);
        _directories.Add(directory);
        var owner = BridgeSingleInstanceGuard.TryAcquire(instanceId, directory);
        Assert.IsNotNull(owner);
        owner.Dispose();

        var replacementAcquired = await Task.Run(() =>
        {
            using var replacement = BridgeSingleInstanceGuard.TryAcquire(instanceId, directory);
            return replacement is not null;
        });

        Assert.IsTrue(replacementAcquired);
    }

    [TestMethod]
    public async Task OwnerReceivesACoordinatedShutdownRequest()
    {
        var instanceId = $"AURUMBridge.test.{Guid.NewGuid():N}";
        var directory = Path.Combine(Path.GetTempPath(), instanceId);
        _directories.Add(directory);
        using var owner = BridgeSingleInstanceGuard.TryAcquire(instanceId, directory);
        Assert.IsNotNull(owner);
        var requested = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.ShutdownRequested += () => requested.TrySetResult();
        owner.StartActivationListener();

        await Task.Run(() => BridgeSingleInstanceGuard.RequestShutdown(instanceId));

        await requested.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }
}
