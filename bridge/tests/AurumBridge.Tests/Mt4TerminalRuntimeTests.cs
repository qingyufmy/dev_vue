using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4TerminalRuntimeTests
{
    [TestMethod]
    public void CollectionCadenceKeepsIdleTradeDetectionInsideTheLocalP95Budget()
    {
        Assert.IsLessThanOrEqualTo(
            TimeSpan.FromMilliseconds(400),
            Mt4TerminalRuntime.CollectionDelay(hasActiveTrades:false));
        Assert.AreEqual(
            TimeSpan.FromMilliseconds(250),
            Mt4TerminalRuntime.CollectionDelay(hasActiveTrades:true));
    }

    [TestMethod]
    public async Task PersistsSnapshotAndMapsTradeResult()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(),
            connection,
            testStore.Store,
            "aurum_mt4_runtime_01",
            () => 1_800_000_000_100);
        await runtime.StartAsync();

        var persisted = await runtime.IngestSnapshotAsync(new(
            1_800_000_000_000,
            Json("""{"balance":1000.0}"""),
            [Json("""{"ticket":"10","symbol":"XAUUSD"}""")],
            []));
        var result = await runtime.ExecuteCommandAsync(Command("cancel_order", new { ticket = "20" }));
        var quote = await runtime.GetQuoteAsync(QuoteRequest());

        Assert.AreEqual(3, persisted);
        Assert.HasCount(3, await testStore.Store.GetPendingOutboxAsync());
        Assert.AreEqual("succeeded", result.Status);
        CollectionAssert.Contains(result.Evidence.OrderTickets.ToArray(), "20");
        Assert.AreEqual(Terminal().ConnectionEpoch, connection.Welcome!.ConnectionEpoch);
        Assert.AreEqual(2300.0, quote.Bid);
    }

    [TestMethod]
    public async Task RejectsUnsupportedCommandWithoutCallingEa()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_01");
        await runtime.StartAsync();

        var result = await runtime.ExecuteCommandAsync(Command("place_order", new
        {
            symbol = "XAUUSD",
            side = "buy",
            order_kind = "stop_limit",
            volume = 0.1,
        }));

        Assert.AreEqual("rejected", result.Status);
        Assert.AreEqual("mt4_stop_limit_unsupported", result.ErrorCode);
        Assert.AreEqual(0, connection.ExecuteCount);
    }

    [TestMethod]
    public async Task MapsStructuredExecutionQueryWithoutTradingPermissionFallbacks()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection
        {
            NextRawResult = Json("""{"found":true,"complete":true,"kind":"trade","ticket":"5003","position_id":"5003","comment":"AI-2F"}"""),
        };
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_01");
        await runtime.StartAsync();

        var result = await runtime.ExecuteCommandAsync(Command("query_execution", new
        {
            expected_kind = "pending", pending_ticket = "5003", bridge_command_ref = "AI-2F",
        }));

        Assert.AreEqual("succeeded", result.Status);
        Assert.IsTrue(result.RawResult!.Value.GetProperty("found").GetBoolean());
        Assert.AreEqual(5003L, connection.LastCommand!.Ticket);
        Assert.AreEqual("AI-2F", connection.LastCommand.BridgeCommandRef);
    }

    [TestMethod]
    [TestCategory("Acceptance")]
    public async Task ForwardsTheCompleteMt4TradeActionMatrix()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_matrix");
        await runtime.StartAsync();
        var commands = new (string Action, object Params, Mt4TradeAction Expected)[]
        {
            ("place_order", new { symbol = "XAUUSD", side = "buy", order_kind = "market", volume = 0.1 }, Mt4TradeAction.PlaceOrder),
            ("cancel_order", new { ticket = "20" }, Mt4TradeAction.CancelOrder),
            ("modify_order", new { ticket = "21", price = 2299.0, stop_loss = 2290.0 }, Mt4TradeAction.ModifyOrder),
            ("modify_position", new { ticket = "22", symbol = "XAUUSD", side = "buy", volume = 0.1, stop_loss = 2295.0 }, Mt4TradeAction.ModifyPosition),
            ("close_position", new { ticket = "22", symbol = "XAUUSD", side = "buy", volume = 0.1 }, Mt4TradeAction.ClosePosition),
            ("query_execution", new { expected_kind = "trade", trade_ticket = "22" }, Mt4TradeAction.QueryExecution),
        };

        foreach (var item in commands)
        {
            var result = await runtime.ExecuteCommandAsync(Command(item.Action, item.Params) with
            {
                CommandId = $"command_mt4_matrix_{connection.Commands.Count:D2}",
            });
            Assert.AreEqual("succeeded", result.Status, $"MT4 action {item.Action} was not forwarded successfully.");
        }

        CollectionAssert.AreEqual(
            commands.Select(item => item.Expected).ToArray(),
            connection.Commands.Select(command => command.Action).ToArray());
    }

    [TestMethod]
    public async Task MapsRatesOverTheTransientMt4DataChannel()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_01");
        await runtime.StartAsync();
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_rates_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_rates_01", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            Action = "rates", Params = JsonSerializer.SerializeToElement(new
            {
                symbol = "XAUUSD", timeframe = "M30", count = 100,
            }),
        };

        var response = await runtime.GetDataAsync(request);

        Assert.AreEqual("succeeded", response.Status);
        Assert.AreEqual("XAUUSD", response.Payload!.Value.GetProperty("symbol").GetString());
        Assert.AreEqual(100, connection.LastRatesRequest!.Count);
    }

    [TestMethod]
    public async Task MapsLightweightSymbolSnapshotWithoutPortfolioCollection()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_01");
        await runtime.StartAsync();
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_symbol_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_symbol_01", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            Action = "symbol_snapshot",
            Params = JsonSerializer.SerializeToElement(new { symbol = "XAUUSD" }),
        };

        var response = await runtime.GetDataAsync(request);

        Assert.AreEqual("succeeded", response.Status);
        Assert.AreEqual("mt4", response.Payload!.Value.GetProperty("source").GetString());
        Assert.AreEqual("XAUUSD", connection.LastSymbolRequest!.Symbol);
    }

    [TestMethod]
    public async Task MapsIncrementalRiskSnapshotWithDualCursor()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_01");
        await runtime.StartAsync();
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_risk_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_risk_01", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            Action = "risk_snapshot", Params = JsonSerializer.SerializeToElement(new
            {
                symbol = "XAUUSD", last_deal_time_msc = 100L, last_deal_ticket = 7L,
                baseline_from_utc_msc = 0L,
                proposed_order = new { symbol = "XAUUSD", order_type = "buy", volume = 0.1, entry_price = 2300, sl = 2290 },
            }),
        };

        var response = await runtime.GetDataAsync(request);

        Assert.AreEqual("succeeded", response.Status);
        Assert.AreEqual(1, response.Payload!.Value.GetProperty("snapshot_version").GetInt32());
        Assert.AreEqual(100L, connection.LastRiskRequest!.LastDealTimeMsc);
        Assert.AreEqual(7L, connection.LastRiskRequest.LastDealTicket);
    }

    [TestMethod]
    public async Task MapsBoundedDailyPerformanceWithoutAFullHistoryPayload()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_01");
        await runtime.StartAsync();
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_mt4_performance_01", SentAtUtcMsc = 1,
            RequestId = "request_mt4_performance_01", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            Action = "performance_daily",
            Params = JsonSerializer.SerializeToElement(new { date_from = "2026-01-01", date_to = "2026-01-31" }),
        };

        var response = await runtime.GetDataAsync(request);

        Assert.AreEqual("succeeded", response.Status);
        Assert.AreEqual(1, response.Payload!.Value.GetProperty("performance_version").GetInt32());
        Assert.AreEqual("2026-01-01", connection.LastPerformanceRequest!.DateFrom);
        Assert.AreEqual("2026-01-31", connection.LastPerformanceRequest.DateTo);
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "mt4_terminal_runtime_01",
        Platform = "mt4",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 3,
    };

    private static CommandMessage Command(string action, object parameters) => new()
    {
        Type = "command",
        MessageId = "message_mt4_runtime_01",
        SentAtUtcMsc = 1_800_000_000_000,
        CommandId = "command_mt4_runtime_01",
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = Terminal().ConnectionEpoch,
        IssuedAtUtcMsc = 1_800_000_000_000,
        DeadlineUtcMsc = 1_900_000_000_000,
        Action = action,
        Params = JsonSerializer.SerializeToElement(parameters),
    };

    private static QuoteRequestMessage QuoteRequest() => new()
    {
        Type = "quote_request",
        MessageId = "message_quote_mt4_runtime_01",
        SentAtUtcMsc = 1_800_000_000_000,
        RequestId = "request_quote_mt4_runtime_01",
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = Terminal().ConnectionEpoch,
        Symbol = "XAUUSD",
    };

    private static JsonElement Json(string value) => JsonDocument.Parse(value).RootElement.Clone();

    private sealed class FakeConnection : IMt4EaConnection
    {
        public Mt4Welcome? Welcome { get; private set; }
        public int ExecuteCount { get; private set; }
        public Mt4TradeCommand? LastCommand { get; private set; }
        public List<Mt4TradeCommand> Commands { get; } = [];
        public JsonElement? NextRawResult { get; init; }
        public Mt4RatesRequest? LastRatesRequest { get; private set; }
        public Mt4SymbolSnapshotRequest? LastSymbolRequest { get; private set; }
        public Mt4RiskSnapshotRequest? LastRiskRequest { get; private set; }
        public Mt4PerformanceDailyRequest? LastPerformanceRequest { get; private set; }

        public Task SendWelcomeAsync(Mt4Welcome welcome, CancellationToken cancellationToken = default)
        {
            Welcome = welcome;
            return Task.CompletedTask;
        }

        public Task<Mt4Snapshot> CollectAsync(
            Mt4CollectionStreams streams,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<Mt4TradeResult> ExecuteAsync(
            Mt4TradeCommand command,
            CancellationToken cancellationToken = default)
        {
            ExecuteCount++;
            LastCommand = command;
            Commands.Add(command);
            return Task.FromResult(new Mt4TradeResult(
                command.CommandId,
                "succeeded",
                null,
                null,
                0,
                command.Ticket,
                1_800_000_000_050,
                NextRawResult ?? (command.Action == Mt4TradeAction.QueryExecution
                    ? Json("""{"found":true,"complete":true,"kind":"trade","ticket":"22","position_id":"22"}""")
                    : null)));
        }

        public Task<Mt4Quote> GetQuoteAsync(
            Mt4QuoteRequest request,
            CancellationToken cancellationToken = default) => Task.FromResult(new Mt4Quote(
                request.RequestId,
                request.Symbol,
                1_800_000_000_060,
                "succeeded",
                2300.0,
                2300.2,
                null));

        public Task<Mt4Rates> GetRatesAsync(
            Mt4RatesRequest request,
            CancellationToken cancellationToken = default)
        {
            LastRatesRequest = request;
            return Task.FromResult(new Mt4Rates(
                request.RequestId, 1_800_000_000_060, "succeeded",
                JsonSerializer.SerializeToElement(new { symbol = request.Symbol, rates = Array.Empty<object>() }),
                null));
        }

        public Task<Mt4SymbolSnapshot> GetSymbolSnapshotAsync(
            Mt4SymbolSnapshotRequest request,
            CancellationToken cancellationToken = default)
        {
            LastSymbolRequest = request;
            return Task.FromResult(new Mt4SymbolSnapshot(
                request.RequestId, 1_800_000_000_070, "succeeded",
                JsonSerializer.SerializeToElement(new
                {
                    symbol = request.Symbol, source = "mt4",
                    account = new { leverage = 100 }, instrument = new { tick_size = 0.01 },
                }), null));
        }

        public Task<Mt4RiskSnapshot> GetRiskSnapshotAsync(
            Mt4RiskSnapshotRequest request,
            CancellationToken cancellationToken = default)
        {
            LastRiskRequest = request;
            return Task.FromResult(new Mt4RiskSnapshot(
                request.RequestId, 1_800_000_000_080, "succeeded",
                JsonSerializer.SerializeToElement(new
                {
                    snapshot_version = 1, source = "mt4", complete = true,
                    increment = new { requested_cursor = new { time_msc = request.LastDealTimeMsc, ticket = request.LastDealTicket } },
                }), null));
        }

        public Task<Mt4PerformanceDaily> GetPerformanceDailyAsync(
            Mt4PerformanceDailyRequest request,
            CancellationToken cancellationToken = default)
        {
            LastPerformanceRequest = request;
            return Task.FromResult(new Mt4PerformanceDaily(
                request.RequestId, 1_800_000_000_090, "succeeded",
                JsonSerializer.SerializeToElement(new
                {
                    performance_version = 1, date_from = request.DateFrom, date_to = request.DateTo,
                    timezone_offset_minutes = 0, account = new { login = 12345678, server = "Broker-Demo" },
                    daily = Array.Empty<object>(), scanned_deal_count = 0, source = "mt4",
                }), null));
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
