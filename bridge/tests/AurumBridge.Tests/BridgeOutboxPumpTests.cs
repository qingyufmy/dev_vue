using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeOutboxPumpTests
{
    private const long StartTime = 1_800_000_000_000;
    private TestStore _testStore = null!;

    [TestInitialize]
    public async Task InitializeAsync() => _testStore = await TestStore.CreateAsync();

    [TestCleanup]
    public async Task CleanupAsync() => await _testStore.DisposeAsync();

    [TestMethod]
    public async Task RetriesAnUnacknowledgedMessageInTheSameSessionWithBackoff()
    {
        var message = Delta();
        await _testStore.Store.PersistDataDeltaAsync(message);
        var outbound = new PriorityMessageQueue();
        var now = StartTime;
        var pump = new BridgeOutboxPump(_testStore.Store, outbound, () => now);

        Assert.AreEqual(1, await pump.PumpOnceAsync());
        Assert.AreEqual(0, await pump.PumpOnceAsync());
        Assert.AreEqual(message.MessageId, (await outbound.DequeueAsync()).MessageId);
        Assert.IsTrue(await pump.RecordSuccessfulSendAsync(message.MessageId));

        now += 1_999;
        Assert.AreEqual(0, await pump.PumpOnceAsync());
        now += 1;
        Assert.AreEqual(1, await pump.PumpOnceAsync());
        Assert.AreEqual(message.MessageId, (await outbound.DequeueAsync()).MessageId);
        Assert.AreEqual(1, (await _testStore.Store.GetPendingOutboxAsync()).Single().AttemptCount);

        Assert.IsTrue(await pump.RecordSuccessfulSendAsync(message.MessageId));
        now += 3_999;
        Assert.AreEqual(0, await pump.PumpOnceAsync());
        now += 1;
        Assert.AreEqual(1, await pump.PumpOnceAsync());
        Assert.AreEqual(2, (await _testStore.Store.GetPendingOutboxAsync()).Single().AttemptCount);
    }

    [TestMethod]
    public async Task PersistsTheRetryDeadlineAcrossOutboxPumpRecreation()
    {
        var message = Delta();
        await _testStore.Store.PersistDataDeltaAsync(message);
        var now = StartTime;
        var firstOutbound = new PriorityMessageQueue();
        var firstPump = new BridgeOutboxPump(_testStore.Store, firstOutbound, () => now);
        Assert.AreEqual(1, await firstPump.PumpOnceAsync());
        await firstOutbound.DequeueAsync();
        Assert.IsTrue(await firstPump.RecordSuccessfulSendAsync(message.MessageId));

        var replacementOutbound = new PriorityMessageQueue();
        var replacementPump = new BridgeOutboxPump(
            _testStore.Store, replacementOutbound, () => now);
        Assert.AreEqual(0, await replacementPump.PumpOnceAsync());
        now += 2_000;
        Assert.AreEqual(1, await replacementPump.PumpOnceAsync());
        Assert.AreEqual(message.MessageId, (await replacementOutbound.DequeueAsync()).MessageId);
    }

    [TestMethod]
    public async Task SuppressesAGapReplayUntilTheConnectionIsRecreated()
    {
        var message = Delta();
        await _testStore.Store.PersistDataDeltaAsync(message);
        var now = StartTime;
        var outbound = new PriorityMessageQueue();
        var pump = new BridgeOutboxPump(_testStore.Store, outbound, () => now);
        Assert.AreEqual(1, await pump.PumpOnceAsync());
        await outbound.DequeueAsync();
        Assert.IsTrue(await pump.RecordSuccessfulSendAsync(message.MessageId));

        pump.HandleAcknowledgement(message.MessageId, "gap");
        now += 60_000;
        Assert.AreEqual(0, await pump.PumpOnceAsync());

        var replacementOutbound = new PriorityMessageQueue();
        var replacementPump = new BridgeOutboxPump(
            _testStore.Store, replacementOutbound, () => now);
        Assert.AreEqual(1, await replacementPump.PumpOnceAsync());
    }

    [TestMethod]
    public async Task IsolatedSessionOnlyPumpsMessagesForItsOwnTerminalRoutes()
    {
        var primary = Delta();
        var observer = Delta() with
        {
            MessageId = "msg_retry_observer_01",
            TerminalInstanceId = "terminal_observer_01",
        };
        await _testStore.Store.PersistDataDeltaAsync(primary);
        await _testStore.Store.PersistDataDeltaAsync(observer);
        var outbound = new PriorityMessageQueue();
        var pump = new BridgeOutboxPump(
            _testStore.Store,
            outbound,
            () => StartTime,
            new HashSet<string>(StringComparer.Ordinal) { primary.TerminalInstanceId });

        Assert.AreEqual(1, await pump.PumpOnceAsync());
        Assert.AreEqual(primary.MessageId, (await outbound.DequeueAsync()).MessageId);
    }

    private static DataDeltaMessage Delta() => new()
    {
        Type = "data_delta",
        MessageId = "msg_retry_00000001",
        SentAtUtcMsc = StartTime,
        TerminalInstanceId = "terminal_retry_01",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 1,
        Stream = "account",
        Revision = 1,
        BaseRevision = 0,
        FullSnapshot = true,
        ObservedAtUtcMsc = StartTime,
        SourceTimeMsc = StartTime,
        Upserts = [JsonDocument.Parse("""{"balance":1000}""").RootElement.Clone()],
        Deletes = [],
    };
}
