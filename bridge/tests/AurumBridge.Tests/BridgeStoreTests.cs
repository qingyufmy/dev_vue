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
    public async Task KeepsExecutionReceiptsBoundedAndIdempotent()
    {
        for (var index = 1; index <= 5; index++)
        {
            await _store.SaveExecutionReceiptAsync(Result($"command_{index:00000000}", index), receiptLimit: 3);
        }
        await _store.SaveExecutionReceiptAsync(Result("command_00000005", 5), receiptLimit: 3);

        Assert.AreEqual(3, await _store.CountExecutionReceiptsAsync());
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
