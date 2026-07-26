using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4TerminalConnectionTests
{
    [TestMethod]
    public void CreatesStablePrivateIdentityAndDedicatedPipe()
    {
        var path = Path.Combine(Path.GetTempPath(), "Broker MT4", "账户一");

        var first = Mt4TerminalIdentity.CreateTerminalInstanceId(path);
        var second = Mt4TerminalIdentity.CreateTerminalInstanceId(path);
        var pipe = Mt4TerminalIdentity.CreateReconnectPipeName(first);

        Assert.AreEqual(first, second);
        StringAssert.StartsWith(first, "mt4_");
        Assert.DoesNotContain("Broker MT4", first);
        Assert.AreEqual($"aurum_{first}", pipe);
    }

    [TestMethod]
    public void RejectsUntrustedPipeIdentityInput()
    {
        Assert.ThrowsExactly<ArgumentException>(() =>
            Mt4TerminalIdentity.CreateReconnectPipeName("mt4_bad\\pipe"));
    }

    [TestMethod]
    public void SeparatesTheSameTerminalPathAcrossDevicesWithoutExposingEitherValue()
    {
        var path = Path.Combine(Path.GetTempPath(), "Broker MT4", "same-path");

        var first = Mt4TerminalIdentity.CreateTerminalInstanceId(path, "device-a");
        var second = Mt4TerminalIdentity.CreateTerminalInstanceId(path, "device-b");

        Assert.AreNotEqual(first, second);
        Assert.DoesNotContain("device-a", first);
        Assert.DoesNotContain("same-path", first);
    }
}
