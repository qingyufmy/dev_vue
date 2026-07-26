using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeTerminalExclusiveLeaseTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-terminal-lease-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive:true);

    [TestMethod]
    public void PreventsTwoBridgeProfilesFromUsingTheSameTerminal()
    {
        using var first = BridgeTerminalExclusiveLease.TryAcquire("mt5_123", _directory);
        using var blocked = BridgeTerminalExclusiveLease.TryAcquire("mt5_123", _directory);

        Assert.IsNotNull(first);
        Assert.IsNull(blocked);
    }

    [TestMethod]
    public void ReleasesTheTerminalForTheNextProfile()
    {
        var first = BridgeTerminalExclusiveLease.TryAcquire("mt5_123", _directory);
        Assert.IsNotNull(first);
        first.Dispose();

        using var next = BridgeTerminalExclusiveLease.TryAcquire("mt5_123", _directory);
        Assert.IsNotNull(next);
    }
}
