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

    [TestMethod]
    public void SeparatesAccountsInTheSameTerminalWhileNormalizingBrokerServerCase()
    {
        var path = Path.Combine(Path.GetTempPath(), "Broker MT4", "account-switch");

        var first = Mt4TerminalIdentity.CreateAccountTerminalInstanceId(
            path, "Broker-Demo", "1001", "device-a");
        var same = Mt4TerminalIdentity.CreateAccountTerminalInstanceId(
            path, "broker-demo", "1001", "device-a");
        var switched = Mt4TerminalIdentity.CreateAccountTerminalInstanceId(
            path, "Broker-Demo", "1002", "device-a");

        Assert.AreEqual(first, same);
        Assert.AreNotEqual(first, switched);
        Assert.DoesNotContain("1001", first);
        Assert.DoesNotContain("Broker-Demo", first);
    }
}
