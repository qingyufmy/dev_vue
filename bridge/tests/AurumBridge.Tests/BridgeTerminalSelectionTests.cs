using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeTerminalSelectionTests
{
    private static readonly BridgeTerminalCandidate First = new(
        "mt5_0123456789abcdef01234567", "mt5", "Broker-One", "1001");
    private static readonly BridgeTerminalCandidate Second = new(
        "mt5_89abcdef0123456701234567", "mt5", "Broker-Two", "1002");

    [TestMethod]
    public void ASingleMt5TerminalIsSelectedAutomatically()
    {
        Assert.AreEqual(
            First.TerminalInstanceId,
            BridgeApplicationController.ResolveMt5TerminalSelection([First], null));
    }

    [TestMethod]
    public void MultipleMt5TerminalsRequireAnExplicitValidSelection()
    {
        Assert.IsNull(BridgeApplicationController.ResolveMt5TerminalSelection(
            [First, Second], null));
        Assert.IsNull(BridgeApplicationController.ResolveMt5TerminalSelection(
            [First, Second], "mt5_stale"));
        Assert.AreEqual(
            Second.TerminalInstanceId,
            BridgeApplicationController.ResolveMt5TerminalSelection(
                [First, Second], Second.TerminalInstanceId));
    }

    [TestMethod]
    public void ObserverProfileUsesOnlyItsConfiguredMt5Installation()
    {
        var discovered = new Mt5Installation(
            Path.Combine(Path.GetTempPath(), "auto", "terminal64.exe"),
            "registry_hkcu",
            IsRunning:true);
        var configuredPath = Path.Combine(
            Path.GetTempPath(), "observer", "terminal64.exe");

        var result = BridgeApplicationController.ResolveMt5Installations(
            [discovered],
            configuredPath);

        Assert.HasCount(1, result);
        Assert.AreEqual(Path.GetFullPath(configuredPath), result[0].ExecutablePath);
        Assert.AreEqual("observer_profile", result[0].Source);
        Assert.IsFalse(result[0].IsRunning);
    }

    [TestMethod]
    public void DefaultProfileKeepsAutomaticMt5Discovery()
    {
        IReadOnlyList<Mt5Installation> discovered = [new(
            Path.Combine(Path.GetTempPath(), "auto", "terminal64.exe"),
            "registry_hkcu",
            IsRunning:true)];

        Assert.AreSame(
            discovered,
            BridgeApplicationController.ResolveMt5Installations(discovered, null));
    }
}
