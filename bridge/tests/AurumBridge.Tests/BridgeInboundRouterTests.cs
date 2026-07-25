using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Storage;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeInboundRouterTests
{
    private const long Now = 1_800_000_000_000;
    private TestStore _testStore = null!;
    private PriorityMessageQueue _outbound = null!;
    private int _workerCalls;

    [TestInitialize]
    public async Task InitializeAsync()
    {
        _testStore = await TestStore.CreateAsync();
        _outbound = new PriorityMessageQueue();
        _workerCalls = 0;
    }

    [TestCleanup]
    public async Task CleanupAsync() => await _testStore.DisposeAsync();

    [TestMethod]
    public async Task AppliedAckDeletesTheExactOutboxMessage()
    {
        var delta = Delta();
        await _testStore.Store.PersistDataDeltaAsync(delta);
        var router = Router();

        await router.RouteAsync(JsonSerializer.Serialize(Ack(delta, "applied"), BridgeJson.Options));

        Assert.IsEmpty(await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task GapAckKeepsOutboxAndRequestsAFullSnapshot()
    {
        var delta = Delta();
        await _testStore.Store.PersistDataDeltaAsync(delta);
        var router = Router();
        FullSnapshotRequest? request = null;
        router.FullSnapshotRequired += value =>
        {
            request = value;
            return Task.CompletedTask;
        };

        await router.RouteAsync(JsonSerializer.Serialize(Ack(delta, "gap") with
        {
            ExpectedRevision = 8,
        }, BridgeJson.Options));

        Assert.HasCount(1, await _testStore.Store.GetPendingOutboxAsync());
        Assert.IsNotNull(request);
        Assert.AreEqual(8, request.ExpectedRevision);
    }

    [TestMethod]
    public async Task FullSnapshotAcknowledgementsOpenLocalTradeAdmission()
    {
        var terminal = Terminal();
        var dispatcher = Dispatcher(initialSyncReady:false);
        var router = new BridgeInboundRouter(_testStore.Store, dispatcher, _outbound, () => Now);
        var synchronized = new List<string>();
        router.InitialSynchronizationCompleted += synchronized.Add;

        foreach (var stream in new[] { "account", "positions", "orders" })
        {
            var delta = Delta(stream, $"msg_01JROUTER_FULL_{stream}", fullSnapshot:true);
            await _testStore.Store.PersistDataDeltaAsync(delta);
            await router.RouteAsync(JsonSerializer.Serialize(Ack(delta, "applied"), BridgeJson.Options));
        }

        Assert.IsTrue(dispatcher.IsInitialSyncReady(
            terminal.TerminalInstanceId,
            terminal.ConnectionEpoch));
        CollectionAssert.AreEqual(new[] { terminal.TerminalInstanceId }, synchronized);
    }

    [TestMethod]
    public async Task MismatchedAcknowledgementCannotDeleteOutboxWork()
    {
        var delta = Delta();
        await _testStore.Store.PersistDataDeltaAsync(delta);
        var router = Router();

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => router.RouteAsync(
            JsonSerializer.Serialize(Ack(delta, "applied") with { Stream = "orders" }, BridgeJson.Options)));

        Assert.HasCount(1, await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task DuplicateCommandsReplayAReceiptWithoutExecutingWorkerTwice()
    {
        var router = Router();
        var command = Command();
        var json = JsonSerializer.Serialize(command, BridgeJson.Options);

        await router.RouteAsync(json);
        await router.RouteAsync(json);
        var first = await _outbound.DequeueAsync();
        var second = await _outbound.DequeueAsync();

        Assert.AreEqual(1, _workerCalls);
        Assert.AreEqual(BridgeMessagePriority.Trade, first.Priority);
        Assert.AreEqual(first.PayloadJson, second.PayloadJson);
    }

    [TestMethod]
    public async Task QuoteRequestUsesTradePriorityWithoutPersistingOutbox()
    {
        var terminal = Terminal();
        var router = new BridgeInboundRouter(
            _testStore.Store,
            new BridgeCommandDispatcher(
                _testStore.Store,
                id => id == terminal.TerminalInstanceId ? terminal : null,
                (command, _) => Task.FromResult(Result(command)),
                () => Now),
            _outbound,
            () => Now,
            (request, _) => Task.FromResult(new QuoteMessage
            {
                Type = "quote",
                MessageId = "quote_01JROUTER_RESULT",
                SentAtUtcMsc = Now,
                RequestId = request.RequestId,
                TerminalInstanceId = request.TerminalInstanceId,
                AccountRef = request.AccountRef,
                ConnectionEpoch = request.ConnectionEpoch,
                Symbol = request.Symbol,
                ObservedAtUtcMsc = Now,
                Status = "succeeded",
                Bid = 2300.0,
                Ask = 2300.2,
            }));

        await router.RouteAsync(JsonSerializer.Serialize(QuoteRequest(), BridgeJson.Options));

        var response = await _outbound.DequeueAsync();
        Assert.AreEqual(BridgeMessagePriority.Trade, response.Priority);
        Assert.AreEqual("quote", JsonDocument.Parse(response.PayloadJson).RootElement
            .GetProperty("type").GetString());
        Assert.IsEmpty(await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task OutboxPumpQueuesEachPendingMessageOncePerSession()
    {
        await _testStore.Store.PersistDataDeltaAsync(Delta());
        var pump = new BridgeOutboxPump(_testStore.Store, _outbound);

        Assert.AreEqual(1, await pump.PumpOnceAsync());
        Assert.AreEqual(0, await pump.PumpOnceAsync());
        Assert.AreEqual(BridgeMessagePriority.Data, (await _outbound.DequeueAsync()).Priority);
    }

    private BridgeInboundRouter Router()
    {
        return new(_testStore.Store, Dispatcher(), _outbound, () => Now);
    }

    private BridgeCommandDispatcher Dispatcher(bool initialSyncReady = true)
    {
        var terminal = Terminal();
        var dispatcher = new BridgeCommandDispatcher(
            _testStore.Store,
            id => id == terminal.TerminalInstanceId ? terminal : null,
            (command, _) =>
            {
                _workerCalls++;
                return Task.FromResult(Result(command));
            },
            () => Now);
        dispatcher.BeginSession("session_router_01", [terminal]);
        if (initialSyncReady)
        {
            foreach (var stream in new[] { "account", "positions", "orders" })
            {
                dispatcher.AcknowledgeInitialSnapshot(
                    terminal.TerminalInstanceId,
                    terminal.ConnectionEpoch,
                    stream);
            }
        }
        return dispatcher;
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "terminal_01JROUTER001",
        Platform = "mt5",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
    };

    private static CommandMessage Command() => new()
    {
        Type = "command",
        MessageId = "msg_01JROUTER_COMMAND",
        SentAtUtcMsc = Now,
        CommandId = "command_01JROUTER01",
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = 7,
        IssuedAtUtcMsc = Now,
        DeadlineUtcMsc = Now + 10_000,
        Action = "place_order",
        Params = JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", volume = "0.01" }),
    };

    private static QuoteRequestMessage QuoteRequest() => new()
    {
        Type = "quote_request",
        MessageId = "msg_01JROUTER_QUOTE",
        SentAtUtcMsc = Now,
        RequestId = "quote_01JROUTER_REQUEST",
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = Terminal().ConnectionEpoch,
        Symbol = "XAUUSD",
    };

    private static CommandResultMessage Result(CommandMessage command) => new()
    {
        Type = "command_result",
        MessageId = "result_01JROUTER001",
        SentAtUtcMsc = Now + 1,
        CommandId = command.CommandId,
        TerminalInstanceId = command.TerminalInstanceId,
        AccountRef = command.AccountRef,
        ConnectionEpoch = command.ConnectionEpoch,
        Status = "succeeded",
        CompletedAtUtcMsc = Now + 1,
        Evidence = new() { ObservedAtUtcMsc = Now + 1 },
    };

    private static DataDeltaMessage Delta(
        string stream = "positions",
        string messageId = "msg_01JROUTER_DELTA",
        bool fullSnapshot = false) => new()
    {
        Type = "data_delta",
        MessageId = messageId,
        SentAtUtcMsc = Now,
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = 7,
        Stream = stream,
        Revision = 1,
        BaseRevision = 0,
        ObservedAtUtcMsc = Now,
        SourceTimeMsc = Now,
        FullSnapshot = fullSnapshot,
        Upserts = stream == "account"
            ? [JsonSerializer.SerializeToElement(new { login = "12345678" })]
            : [JsonSerializer.SerializeToElement(new { ticket = "1001" })],
        Deletes = [],
    };

    private static DataAckMessage Ack(DataDeltaMessage delta, string status) => new()
    {
        Type = "data_ack",
        MessageId = "ack_01JROUTER0001",
        SentAtUtcMsc = Now + 1,
        AckedMessageId = delta.MessageId,
        TerminalInstanceId = delta.TerminalInstanceId,
        ConnectionEpoch = delta.ConnectionEpoch,
        Stream = delta.Stream,
        Revision = delta.Revision,
        Status = status,
        ExpectedRevision = 2,
    };
}
