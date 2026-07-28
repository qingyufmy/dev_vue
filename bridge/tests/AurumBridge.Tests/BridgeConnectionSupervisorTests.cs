using System.Net;
using AurumBridge.Protocol;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeConnectionSupervisorTests
{
    [TestMethod]
    public async Task CreatesFreshSessionAndReconnectsAfterDisconnect()
    {
        var hellos = new List<HelloMessage>();
        var statuses = new List<BridgeConnectionStatus>();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var supervisor = new BridgeConnectionSupervisor(
            [Terminal()],
            "3.0.0-test",
            (hello, _) =>
            {
                hellos.Add(hello);
                return Task.FromResult(new BridgeConnectionAttempt(
                    new("wss://example.com/aurum-api/bridge/v3/ws"),
                    "ticket",
                    hello));
            },
            (_, ready, _) =>
            {
                ready();
                if (hellos.Count >= 2)
                {
                    stop.Cancel();
                }
                return Task.CompletedTask;
            },
            (_, cancellationToken) => Task.CompletedTask,
            () => 1_800_000_000_000,
            new(
                "install_0123456789abcdef0123456789abcdef",
                new()
                {
                    ReleaseId = "bridge-3.1.0-test",
                    TargetVersion = "3.1.0",
                    State = "healthy",
                    StartedAtUtcMsc = 1_799_999_900_000,
                    UpdatedAtUtcMsc = 1_800_000_000_000,
                }));
        supervisor.StatusChanged += statuses.Add;

        await supervisor.RunAsync(stop.Token);

        Assert.HasCount(2, hellos);
        Assert.AreNotEqual(hellos[0].SessionId, hellos[1].SessionId);
        Assert.AreNotEqual(hellos[0].MessageId, hellos[1].MessageId);
        Assert.AreEqual("3.0.0-test", hellos[0].BridgeVersion);
        Assert.AreEqual("install_0123456789abcdef0123456789abcdef", hellos[0].InstallationId);
        Assert.AreEqual("bridge-3.1.0-test", hellos[0].UpdateReport?.ReleaseId);
        Assert.AreEqual("healthy", hellos[0].UpdateReport?.State);
        Assert.IsTrue(statuses.Any(status => status.State == BridgeConnectionState.Connected));
        Assert.AreEqual(BridgeConnectionState.Stopped, statuses[^1].State);
    }

    [TestMethod]
    public async Task PublishesPairingRequiredAndWaitsForExplicitAuthorization()
    {
        var statuses = new List<BridgeConnectionStatus>();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var attempts = 0;
        var reconnectDelays = 0;
        var supervisor = new BridgeConnectionSupervisor(
            [Terminal()],
            "3.0.0-test",
            (_, _) =>
            {
                attempts++;
                throw new BridgeApiException("bridge_not_paired", HttpStatusCode.Unauthorized);
            },
            (_, _, _) => Task.CompletedTask,
            (_, _) =>
            {
                reconnectDelays++;
                return Task.CompletedTask;
            });
        supervisor.StatusChanged += status =>
        {
            statuses.Add(status);
            if (status.State == BridgeConnectionState.PairingRequired)
            {
                stop.Cancel();
            }
        };

        await supervisor.RunAsync(stop.Token);

        Assert.AreEqual(1, attempts);
        Assert.AreEqual(0, reconnectDelays);
        Assert.IsTrue(statuses.Any(status => status.State == BridgeConnectionState.PairingRequired));
        Assert.AreEqual(BridgeConnectionState.Stopped, statuses[^1].State);
    }

    [TestMethod]
    public async Task CapsReconnectBackoffToPreserveTheSixtySecondRecoveryBudget()
    {
        var delays = new List<TimeSpan>();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var attempts = 0;
        var supervisor = new BridgeConnectionSupervisor(
            [Terminal()],
            "3.0.0-test",
            (hello, _) =>
            {
                attempts++;
                if (attempts <= 7)
                {
                    throw new HttpRequestException("simulated_disconnect");
                }
                return Task.FromResult(new BridgeConnectionAttempt(
                    new("wss://example.com/aurum-api/bridge/v3/ws"), "ticket", hello));
            },
            (_, ready, _) =>
            {
                ready();
                stop.Cancel();
                return Task.CompletedTask;
            },
            (delay, _) =>
            {
                delays.Add(delay);
                return Task.CompletedTask;
            });

        await supervisor.RunAsync(stop.Token);

        CollectionAssert.AreEqual(
            new[] { 1, 2, 4, 8, 10, 10, 10 },
            delays.Select(delay => (int)delay.TotalSeconds).ToArray());
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "mt5_terminal_connection_01",
        Platform = "mt5",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 1,
    };
}
