using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeRuntimeProfileTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-profiles-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive:true);

    [TestMethod]
    public void KeepsDefaultAndObserverStateInSeparateDirectories()
    {
        Assert.AreEqual(_directory, BridgeRuntimeProfile.ResolveDataDirectory(_directory, "default"));
        Assert.AreEqual(
            Path.Combine(_directory, "profiles", "source-1"),
            BridgeRuntimeProfile.ResolveDataDirectory(_directory, "SOURCE-1"));
        Assert.AreEqual("AURUMBridge.v3", BridgeRuntimeProfile.InstanceId("default"));
        Assert.AreEqual(
            "AURUMBridge.v3.profile.source-1",
            BridgeRuntimeProfile.InstanceId("SOURCE-1"));
    }

    [TestMethod]
    public void CreatesAndListsPersistentObserverProfiles()
    {
        BridgeRuntimeProfile.CreateObserverProfile(_directory, "desk_b");
        BridgeRuntimeProfile.CreateObserverProfile(_directory, "desk-a");

        CollectionAssert.AreEqual(
            new[] { "desk-a", "desk_b" },
            BridgeRuntimeProfile.ListObserverProfiles(_directory).ToArray());
    }

    [TestMethod]
    public void RejectsReservedOrUnsafeObserverProfileNames()
    {
        Assert.ThrowsExactly<ArgumentException>(() =>
            BridgeRuntimeProfile.CreateObserverProfile(_directory, "default"));
        Assert.ThrowsExactly<ArgumentException>(() =>
            BridgeRuntimeProfile.CreateObserverProfile(_directory, "../outside"));
        Assert.IsFalse(Directory.Exists(Path.Combine(_directory, "outside")));
    }

    [TestMethod]
    public void ObserverProfilesLaunchAsBackgroundWorkers()
    {
        var info = BridgeRuntimeProfile.BuildLaunchInfo("source-1");

        CollectionAssert.AreEqual(
            new[] { "--profile", "source-1", "--background" },
            info.ArgumentList.TakeLast(3).ToArray());
    }

    [TestMethod]
    public void BackgroundArgumentIsRemovedBeforeOtherRuntimeArgumentsAreParsed()
    {
        var parsed = BridgeRuntimeProfile.ReadBackgroundArgument([
            "--ready-file",
            @"C:\temp\ready.json",
            "--background",
        ]);

        Assert.IsTrue(parsed.BackgroundMode);
        CollectionAssert.AreEqual(
            new[] { "--ready-file", @"C:\temp\ready.json" },
            parsed.RuntimeArgs);
        Assert.ThrowsExactly<ArgumentException>(() =>
            BridgeRuntimeProfile.ReadBackgroundArgument(["--background", "--background"]));
    }
}
