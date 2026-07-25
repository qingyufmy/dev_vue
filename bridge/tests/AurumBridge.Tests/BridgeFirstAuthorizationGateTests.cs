using AurumBridge.Runtime;
using AurumBridge.UI;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeFirstAuthorizationGateTests
{
    [TestMethod]
    public void OpensTheBrowserOnlyOnceWhenAuthorizationIsRequired()
    {
        var gate = new BridgeFirstAuthorizationGate();

        Assert.IsFalse(gate.TryStart(BridgeApplicationPhase.Connecting));
        Assert.IsTrue(gate.TryStart(BridgeApplicationPhase.PairingRequired));
        Assert.IsFalse(gate.TryStart(BridgeApplicationPhase.PairingRequired));
        Assert.IsFalse(gate.TryStart(BridgeApplicationPhase.Online));
    }
}
