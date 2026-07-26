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
    public async Task HelloAcknowledgementRequiresTheCompleteHandshakeRoute()
    {
        var router = Router();
        BridgeHelloAcknowledgement? acknowledgement = null;
        router.HelloAcknowledged += value => acknowledgement = value;
        var hello = new HelloMessage
        {
            Type = "hello",
            MessageId = "hello_01JROUTER0001",
            SentAtUtcMsc = Now,
            SessionId = "session_01JROUTER01",
            BridgeVersion = "3.0.0",
            Terminals = [Terminal()],
        };
        var attempt = new BridgeConnectionAttempt(
            new Uri("wss://bridge.example/ws"), "ticket", hello);

        await router.RouteAsync(JsonSerializer.Serialize(new
        {
            v = 3,
            type = "hello_ack",
            message_id = "hello_ack_01JROUTER01",
            sent_at_utc_msc = Now,
            acked_message_id = hello.MessageId,
            session_id = hello.SessionId,
            accepted_terminal_instance_ids = new[] { Terminal().TerminalInstanceId },
        }));

        Assert.IsNotNull(acknowledgement);
        BridgeWebSocketClient.ValidateHelloAcknowledgement(attempt, acknowledgement);
        Assert.ThrowsExactly<InvalidDataException>(() =>
            BridgeWebSocketClient.ValidateHelloAcknowledgement(
                attempt,
                acknowledgement with { AckedMessageId = "hello_wrong_message" }));
        Assert.ThrowsExactly<InvalidDataException>(() =>
            BridgeWebSocketClient.ValidateHelloAcknowledgement(
                attempt,
                acknowledgement with { AcceptedTerminalInstanceIds = ["terminal_wrong_route"] }));
    }

    [TestMethod]
    public async Task HelloAcknowledgementRejectsDuplicateAcceptedTerminals()
    {
        var router = Router();

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => router.RouteAsync(
            JsonSerializer.Serialize(new
            {
                v = 3,
                type = "hello_ack",
                message_id = "hello_ack_01JROUTER02",
                sent_at_utc_msc = Now,
                acked_message_id = "hello_01JROUTER0001",
                session_id = "session_01JROUTER01",
                accepted_terminal_instance_ids = new[] { "terminal_01JROUTER01", "terminal_01JROUTER01" },
            })));
    }

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
    public async Task CommandResultAckDeletesDurableTradeOutbox()
    {
        var pump = new BridgeOutboxPump(_testStore.Store, _outbound);
        var router = new BridgeInboundRouter(
            _testStore.Store, Dispatcher(), _outbound, () => Now, outboxPump:pump);
        var command = Command();

        await router.RouteAsync(JsonSerializer.Serialize(command, BridgeJson.Options));
        var result = Result(command);
        Assert.HasCount(1, await _testStore.Store.GetPendingOutboxAsync());

        await router.RouteAsync(JsonSerializer.Serialize(ResultAck(result), BridgeJson.Options));

        Assert.IsEmpty(await _testStore.Store.GetPendingOutboxAsync());
        Assert.AreEqual(0, await pump.PumpOnceAsync());
    }

    [TestMethod]
    public async Task DuplicateCommandReceiptCanBeAcknowledgedAfterOutboxWasCleared()
    {
        var pump = new BridgeOutboxPump(_testStore.Store, _outbound);
        var router = new BridgeInboundRouter(
            _testStore.Store, Dispatcher(), _outbound, () => Now, outboxPump:pump);
        var command = Command();
        var result = Result(command);

        await router.RouteAsync(JsonSerializer.Serialize(command, BridgeJson.Options));
        await router.RouteAsync(JsonSerializer.Serialize(ResultAck(result), BridgeJson.Options));
        await router.RouteAsync(JsonSerializer.Serialize(command, BridgeJson.Options));
        await router.RouteAsync(JsonSerializer.Serialize(
            ResultAck(result) with { Status = "duplicate" }, BridgeJson.Options));

        Assert.AreEqual(1, _workerCalls);
        Assert.IsEmpty(await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task QuoteRequestUsesDataPriorityWithoutPersistingOutbox()
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
        Assert.AreEqual(BridgeMessagePriority.Data, response.Priority);
        Assert.AreEqual("quote", JsonDocument.Parse(response.PayloadJson).RootElement
            .GetProperty("type").GetString());
        Assert.IsEmpty(await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task DataRequestUsesDataPriorityWithoutPersistingOutbox()
    {
        var router = new BridgeInboundRouter(
            _testStore.Store, Dispatcher(), _outbound, () => Now,
            dataHandler:(request, _) => Task.FromResult(new DataResponseMessage
            {
                Type = "data_response", MessageId = "data_01JROUTER_RESULT", SentAtUtcMsc = Now,
                RequestId = request.RequestId, TerminalInstanceId = request.TerminalInstanceId,
                AccountRef = request.AccountRef, ConnectionEpoch = request.ConnectionEpoch,
                Action = request.Action, Params = request.Params, ObservedAtUtcMsc = Now,
                Status = "succeeded", Payload = JsonSerializer.SerializeToElement(new { rates = Array.Empty<object>() }),
            }));

        await router.RouteAsync(JsonSerializer.Serialize(DataRequest(), BridgeJson.Options));

        var response = await _outbound.DequeueAsync();
        Assert.AreEqual(BridgeMessagePriority.Data, response.Priority);
        Assert.AreEqual("data_response", JsonDocument.Parse(response.PayloadJson).RootElement
            .GetProperty("type").GetString());
        Assert.IsEmpty(await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    [DataRow("symbols")]
    [DataRow("history")]
    [DataRow("chart_data")]
    public async Task LegacyWebsiteDataActionsUseTheV3DataChannel(string action)
    {
        var router = new BridgeInboundRouter(
            _testStore.Store, Dispatcher(), _outbound, () => Now,
            dataHandler:(request, _) => Task.FromResult(new DataResponseMessage
            {
                Type = "data_response", MessageId = $"data_result_{action}", SentAtUtcMsc = Now,
                RequestId = request.RequestId, TerminalInstanceId = request.TerminalInstanceId,
                AccountRef = request.AccountRef, ConnectionEpoch = request.ConnectionEpoch,
                Action = request.Action, Params = request.Params, ObservedAtUtcMsc = Now,
                Status = "succeeded", Payload = JsonSerializer.SerializeToElement(new { source = "mt5" }),
            }));
        var request = DataRequest() with { Action = action };

        await router.RouteAsync(JsonSerializer.Serialize(request, BridgeJson.Options));

        var response = await _outbound.DequeueAsync();
        Assert.AreEqual(action, JsonDocument.Parse(response.PayloadJson).RootElement
            .GetProperty("action").GetString());
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

    private static DataRequestMessage DataRequest() => new()
    {
        Type = "data_request", MessageId = "msg_01JROUTER_DATA", SentAtUtcMsc = Now,
        RequestId = "data_01JROUTER_REQUEST", TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
        Action = "rates",
        Params = JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", timeframe = "M30", count = 100 }),
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

    private static CommandResultAckMessage ResultAck(CommandResultMessage result) => new()
    {
        Type = "command_result_ack",
        MessageId = "ack_01JROUTER_RESULT",
        SentAtUtcMsc = Now + 2,
        AckedMessageId = result.MessageId,
        CommandId = result.CommandId,
        TerminalInstanceId = result.TerminalInstanceId,
        AccountRef = result.AccountRef,
        ConnectionEpoch = result.ConnectionEpoch,
        Status = "applied",
    };
}
