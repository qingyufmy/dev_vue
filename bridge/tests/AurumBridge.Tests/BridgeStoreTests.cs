using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Storage;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeStoreTests
{
    private string _directory = null!;
    private BridgeStore _store = null!;

    [TestInitialize]
    public async Task InitializeAsync()
    {
        _directory = Path.Combine(Path.GetTempPath(), "aurum-bridge-tests", Guid.NewGuid().ToString("N"));
        _store = new BridgeStore(Path.Combine(_directory, "bridge.db"));
        await _store.InitializeAsync();
    }

    [TestCleanup]
    public async Task CleanupAsync()
    {
        await _store.DisposeAsync();
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    [TestMethod]
    public async Task InitializesWithWalJournalMode()
    {
        Assert.AreEqual("wal", (await _store.GetJournalModeAsync()).ToLowerInvariant());
    }

    [TestMethod]
    public async Task PersistsLatestStateAndOutboxInOneTransaction()
    {
        var message = Delta("positions", revision: 1, baseRevision: 0,
            upserts: [Json("""{"ticket":"1001","symbol":"XAUUSD"}""")]);

        var result = await _store.PersistDataDeltaAsync(message);
        var outbox = await _store.GetPendingOutboxAsync();

        Assert.AreEqual(PersistDeltaStatus.Applied, result.Status);
        Assert.HasCount(1, outbox);
        Assert.AreEqual(message.MessageId, outbox[0].MessageId);
        Assert.AreEqual("data_delta", outbox[0].MessageType);
        StringAssert.Contains(outbox[0].PayloadJson, "XAUUSD");
    }

    [TestMethod]
    public async Task RejectsRevisionGapWithoutAddingOutboxWork()
    {
        await _store.PersistDataDeltaAsync(Delta("orders", 1, 0,
            [Json("""{"ticket":"2001"}""")]));

        var gap = await _store.PersistDataDeltaAsync(Delta("orders", 3, 2,
            [Json("""{"ticket":"2002"}""")]));

        Assert.AreEqual(PersistDeltaStatus.Gap, gap.Status);
        Assert.AreEqual(2L, gap.ExpectedRevision);
        Assert.HasCount(1, await _store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task AcceptsAnExactReplayButRejectsConflictingContentAtTheSameRevision()
    {
        var original = Delta("positions", 1, 0,
            [Json("""{"ticket":"1001","symbol":"XAUUSD"}""")]);
        await _store.PersistDataDeltaAsync(original);

        var replay = await _store.PersistDataDeltaAsync(original);
        Assert.AreEqual(PersistDeltaStatus.Duplicate, replay.Status);
        Assert.HasCount(1, await _store.GetPendingOutboxAsync());

        var conflict = original with
        {
            Upserts = [Json("""{"ticket":"1001","symbol":"EURUSD"}""")],
        };
        await Assert.ThrowsExactlyAsync<InvalidDataException>(
            () => _store.PersistDataDeltaAsync(conflict));
    }

    [TestMethod]
    public async Task RemovesOutboxOnlyAfterAppliedOrDuplicateAcknowledgement()
    {
        var message = Delta("account", 1, 0,
            [Json("""{"balance":1000,"equity":995}""")]);
        await _store.PersistDataDeltaAsync(message);

        Assert.IsFalse(await _store.AcknowledgeOutboxAsync(message.MessageId, "gap", 10));
        Assert.HasCount(1, await _store.GetPendingOutboxAsync());
        Assert.IsTrue(await _store.AcknowledgeOutboxAsync(message.MessageId, "applied", 11));
        Assert.IsEmpty(await _store.GetPendingOutboxAsync());
    }

    [TestMethod]
    [TestCategory("Acceptance")]
    public async Task RecoversEveryUnacknowledgedOutboxMessageAfterProcessRestart()
    {
        const int messageCount = 200;
        for (var revision = 1; revision <= messageCount; revision++)
        {
            await _store.PersistDataDeltaAsync(Delta(
                "positions",
                revision,
                revision - 1,
                [Json($$"""{"ticket":"{{revision:D8}}","symbol":"XAUUSD"}""")]));
        }
        var beforeRestart = await _store.GetPendingOutboxAsync(messageCount);
        await _store.DisposeAsync();

        _store = new BridgeStore(Path.Combine(_directory, "bridge.db"));
        await _store.InitializeAsync();
        var recovered = await _store.GetPendingOutboxAsync(messageCount);

        Assert.AreEqual(messageCount, recovered.Count);
        CollectionAssert.AreEqual(
            beforeRestart.Select(message => message.MessageId).ToArray(),
            recovered.Select(message => message.MessageId).ToArray());
        CollectionAssert.AreEqual(
            beforeRestart.Select(message => message.PayloadJson).ToArray(),
            recovered.Select(message => message.PayloadJson).ToArray());
    }

    [TestMethod]
    public async Task CoalescesAnOfflineDataStreamIntoOneBoundedFullSnapshot()
    {
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 1, 0, [Json("""{"ticket":"1","volume":0.1}""")]),
            dataOutboxLimitPerStream:3);
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 2, 1, [Json("""{"ticket":"2","volume":0.2}""")]),
            dataOutboxLimitPerStream:3);
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 3, 2, [Json("""{"ticket":"1","volume":0.3}""")]),
            dataOutboxLimitPerStream:3);

        var pending = await _store.GetPendingOutboxAsync(20);

        Assert.HasCount(1, pending);
        var merged = JsonSerializer.Deserialize<DataDeltaMessage>(
            pending[0].PayloadJson, BridgeJson.Options);
        Assert.IsNotNull(merged);
        Assert.IsTrue(merged.FullSnapshot);
        Assert.AreEqual(0, merged.BaseRevision);
        Assert.AreEqual(3, merged.Revision);
        Assert.HasCount(2, merged.Upserts);
        Assert.IsTrue(merged.Upserts.Any(item =>
            item.GetProperty("ticket").GetString() == "1"
            && item.GetProperty("volume").GetDouble() == 0.3));
        Assert.IsTrue(merged.Upserts.Any(item =>
            item.GetProperty("ticket").GetString() == "2"));
    }

    [TestMethod]
    public async Task ARequestedFullSnapshotSupersedesOlderUnacknowledgedDeltasOnlyForItsStream()
    {
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 1, 0, [Json("""{"ticket":"1"}""")]));
        await _store.PersistDataDeltaAsync(Delta(
            "orders", 1, 0, [Json("""{"ticket":"9"}""")]));
        await _store.PersistDataDeltaAsync(Delta(
            "positions", 2, 0, [Json("""{"ticket":"1"}""")]) with
        {
            FullSnapshot = true,
        });

        var pending = await _store.GetPendingOutboxAsync(20);
        var deltas = pending.Select(message => JsonSerializer.Deserialize<DataDeltaMessage>(
            message.PayloadJson, BridgeJson.Options)!).ToArray();

        Assert.HasCount(2, deltas);
        Assert.HasCount(1, deltas.Where(delta => delta.Stream == "positions"));
        Assert.AreEqual(2, deltas.Single(delta => delta.Stream == "positions").Revision);
        Assert.HasCount(1, deltas.Where(delta => delta.Stream == "orders"));
    }

    [TestMethod]
    public async Task KeepsExecutionReceiptsBoundedAndIdempotent()
    {
        for (var index = 1; index <= 5; index++)
        {
            var result = Result($"command_{index:00000000}", index);
            await _store.SaveExecutionReceiptAsync(result, receiptLimit: 3);
            Assert.IsTrue(await _store.AcknowledgeOutboxAsync(
                result.MessageId, "applied", result.CompletedAtUtcMsc + 1));
        }
        await _store.SaveExecutionReceiptAsync(Result("command_00000005", 5), receiptLimit: 3);

        Assert.AreEqual(3, await _store.CountExecutionReceiptsAsync());
    }

    [TestMethod]
    public async Task NeverTrimsAnExecutionReceiptWhoseTradeResultIsUnacknowledged()
    {
        var first = Result("command_00000001", 1);
        var second = Result("command_00000002", 2);
        var third = Result("command_00000003", 3);
        await _store.SaveExecutionReceiptAsync(first, receiptLimit: 2);
        await _store.SaveExecutionReceiptAsync(second, receiptLimit: 2);
        await _store.SaveExecutionReceiptAsync(third, receiptLimit: 2);

        Assert.AreEqual(3, await _store.CountExecutionReceiptsAsync());
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(first.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(second.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(third.CommandId));

        Assert.IsTrue(await _store.AcknowledgeOutboxAsync(
            first.MessageId, "applied", first.CompletedAtUtcMsc + 1));
        var fourth = Result("command_00000004", 4);
        await _store.SaveExecutionReceiptAsync(fourth, receiptLimit: 2);

        Assert.IsNull(await _store.GetExecutionReceiptAsync(first.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(second.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(third.CommandId));
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(fourth.CommandId));
    }

    [TestMethod]
    public async Task PersistsExecutionReceiptAndTradeOutboxInOneTransaction()
    {
        var result = Result("command_00000001", 1);

        await _store.SaveExecutionReceiptAsync(result);
        var pending = await _store.GetPendingOutboxAsync();

        Assert.HasCount(1, pending);
        Assert.AreEqual(result.MessageId, pending[0].MessageId);
        Assert.AreEqual("command_result", pending[0].MessageType);
        Assert.AreEqual("trade", pending[0].Priority);
        Assert.IsNotNull(await _store.GetExecutionReceiptAsync(result.CommandId));
    }

    [TestMethod]
    public async Task ActivatingTerminalBindingAdvancesDurableConnectionEpoch()
    {
        var terminalPath = Path.Combine(_directory, "Broker MT5", "terminal64.exe");
        var first = await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01",
            "MT5",
            terminalPath,
            new(" Broker-Demo ", " 12345678 "),
            1_800_000_000_001);
        var second = await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01",
            "mt5",
            terminalPath,
            new("Broker-Live", "87654321"),
            1_800_000_000_002);

        Assert.AreEqual(1L, first.ConnectionEpoch);
        Assert.AreEqual(2L, second.ConnectionEpoch);
        Assert.AreEqual("Broker-Demo", first.AccountRef.BrokerServer);
        Assert.AreEqual("12345678", first.AccountRef.Login);
        Assert.AreEqual("Broker-Live", second.AccountRef.BrokerServer);
        Assert.AreEqual("87654321", second.AccountRef.Login);
    }

    [TestMethod]
    public async Task AdvancingTerminalBindingPrunesOnlyItsStaleDataOutbox()
    {
        var terminalPath = Path.Combine(_directory, "Broker MT5", "terminal64.exe");
        var first = await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01", "mt5", terminalPath, new("Broker-Demo", "12345678"), 10);
        await _store.PersistDataDeltaAsync(Delta("positions", 1, 0,
            [Json("""{"ticket":"1001"}""")]) with
        {
            MessageId = "msg_target_epoch_1",
            TerminalInstanceId = first.TerminalInstanceId,
            ConnectionEpoch = first.ConnectionEpoch,
        });
        await _store.PersistDataDeltaAsync(Delta("positions", 1, 0,
            [Json("""{"ticket":"2001"}""")]) with
        {
            MessageId = "msg_other_terminal",
            TerminalInstanceId = "mt5_terminal_02",
            ConnectionEpoch = 1,
        });

        var second = await _store.ActivateTerminalBindingAsync(
            first.TerminalInstanceId, "mt5", terminalPath, first.AccountRef, 20);

        var afterActivation = await _store.GetPendingOutboxAsync();
        Assert.HasCount(1, afterActivation);
        Assert.AreEqual("msg_other_terminal", afterActivation[0].MessageId);
        Assert.AreEqual(0L, await _store.GetStreamRevisionAsync(
            first.TerminalInstanceId, first.ConnectionEpoch, "positions"));
        Assert.AreEqual(1L, await _store.GetStreamRevisionAsync(
            "mt5_terminal_02", 1, "positions"));

        await _store.PersistDataDeltaAsync(Delta("positions", 1, 0,
            [Json("""{"ticket":"1002"}""")]) with
        {
            MessageId = "msg_target_epoch_2",
            TerminalInstanceId = second.TerminalInstanceId,
            ConnectionEpoch = second.ConnectionEpoch,
        });
        var current = await _store.GetPendingOutboxAsync();
        Assert.HasCount(2, current);
        CollectionAssert.Contains(current.Select(message => message.MessageId).ToArray(), "msg_target_epoch_2");
    }

    [TestMethod]
    public async Task ListsLatestTerminalBindingsForStartupRecovery()
    {
        var firstPath = Path.Combine(_directory, "One", "terminal64.exe");
        var secondPath = Path.Combine(_directory, "Two", "terminal64.exe");
        await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_02", "mt5", secondPath, new("Broker-Two", "2"), 20);
        await _store.ActivateTerminalBindingAsync(
            "mt5_terminal_01", "mt5", firstPath, new("Broker-One", "1"), 10);

        var bindings = await _store.GetTerminalBindingsAsync();

        Assert.HasCount(2, bindings);
        Assert.AreEqual("mt5_terminal_01", bindings[0].TerminalInstanceId);
        Assert.AreEqual(Path.GetFullPath(firstPath), bindings[0].TerminalPath);
        Assert.AreEqual(1L, bindings[0].ConnectionEpoch);
        Assert.AreEqual("mt5", bindings[0].ToDescriptor("test-worker").Platform);
    }

    private static DataDeltaMessage Delta(
        string stream,
        long revision,
        long baseRevision,
        IReadOnlyList<JsonElement> upserts,
        IReadOnlyList<JsonElement>? deletes = null) => new()
    {
        Type = "data_delta",
        MessageId = $"msg_{stream}_{revision:00000000}",
        SentAtUtcMsc = 1_800_000_000_000 + revision,
        TerminalInstanceId = "terminal_01JSTORE0001",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
        Stream = stream,
        Revision = revision,
        BaseRevision = baseRevision,
        ObservedAtUtcMsc = 1_800_000_000_000 + revision,
        SourceTimeMsc = 1_800_000_000_000,
        Upserts = upserts,
        Deletes = deletes ?? [],
    };

    private static CommandResultMessage Result(string commandId, long sequence) => new()
    {
        Type = "command_result",
        MessageId = $"msg_result_{sequence:00000000}",
        SentAtUtcMsc = 1_800_000_000_000 + sequence,
        CommandId = commandId,
        TerminalInstanceId = "terminal_01JSTORE0001",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
        Status = "succeeded",
        CompletedAtUtcMsc = 1_800_000_000_000 + sequence,
        Evidence = new() { ObservedAtUtcMsc = 1_800_000_000_000 + sequence },
    };

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();
}
