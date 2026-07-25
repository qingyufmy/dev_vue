using AurumBridge.Runtime;

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
}
