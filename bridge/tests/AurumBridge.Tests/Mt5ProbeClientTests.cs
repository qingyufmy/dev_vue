using System.Text.Json;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt5ProbeClientTests
{
    [TestMethod]
    public void ParsesConnectedAccountIdentity()
    {
        var payload = JsonSerializer.Serialize(new
        {
            v = 3,
            type = "mt5_probe",
            terminal_path = @"C:\Broker\terminal64.exe",
            account_ref = new { broker_server = "Broker-Demo", login = "12345678" },
            account = new { balance = 1000.0 },
            terminal = new { connected = true },
        });

        var result = Mt5ProbeClient.ParseResponse(payload);

        Assert.AreEqual("12345678", result.AccountRef.Login);
        Assert.AreEqual("Broker-Demo", result.AccountRef.BrokerServer);
    }

    [TestMethod]
    public void RejectsDisconnectedOrMalformedProbeResponses()
    {
        var disconnected = JsonSerializer.Serialize(new
        {
            v = 3,
            type = "mt5_probe",
            terminal_path = @"C:\Broker\terminal64.exe",
            account_ref = new { broker_server = "Broker-Demo", login = "12345678" },
            account = new { balance = 1000.0 },
            terminal = new { connected = false },
        });

        Assert.ThrowsExactly<InvalidDataException>(() => Mt5ProbeClient.ParseResponse(disconnected));
        Assert.ThrowsExactly<InvalidDataException>(() => Mt5ProbeClient.ParseResponse("{}"));
    }

    [TestMethod]
    public void ProbeProcessReceivesArgumentsWithoutShellConcatenation()
    {
        var startInfo = Mt5ProbeClient.BuildStartInfo(
            @"C:\Runtime\python.exe",
            @"C:\AURUM Bridge\worker.py",
            @"C:\Broker One\terminal64.exe");

        Assert.IsFalse(startInfo.UseShellExecute);
        CollectionAssert.AreEqual(
            new[] { @"C:\AURUM Bridge\worker.py", "--probe", "--terminal", @"C:\Broker One\terminal64.exe" },
            startInfo.ArgumentList.ToArray());
    }
}
