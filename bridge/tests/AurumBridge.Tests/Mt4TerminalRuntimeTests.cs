using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4TerminalRuntimeTests
{
    [TestMethod]
    public void CollectionCadenceUsesLowIdleLoadAndFastActivePolling()
    {
        Assert.AreEqual(
            TimeSpan.FromSeconds(1),
            Mt4TerminalRuntime.CollectionDelay(hasActiveTrades:false));
        Assert.AreEqual(
            TimeSpan.FromMilliseconds(250),
            Mt4TerminalRuntime.CollectionDelay(hasActiveTrades:true));
    }

    [TestMethod]
    public void CachesOnlyBoundedReadHeavyMt4Actions()
    {
        Assert.AreEqual(TimeSpan.FromSeconds(2), Mt4TerminalRuntime.DataCacheMaxAge("rates"));
        Assert.AreEqual(TimeSpan.FromSeconds(5), Mt4TerminalRuntime.DataCacheMaxAge("history"));
        Assert.AreEqual(TimeSpan.FromSeconds(5), Mt4TerminalRuntime.DataCacheMaxAge("chart_data"));
        Assert.AreEqual(TimeSpan.FromSeconds(30), Mt4TerminalRuntime.DataCacheMaxAge("performance_daily"));
        Assert.AreEqual(TimeSpan.FromMinutes(5), Mt4TerminalRuntime.DataCacheMaxAge("symbols"));
        Assert.IsNull(Mt4TerminalRuntime.DataCacheMaxAge("risk_snapshot"));
        Assert.IsNull(Mt4TerminalRuntime.DataCacheMaxAge("pending_order_state"));
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
        var outbox = await testStore.Store.GetPendingOutboxAsync();
        Assert.HasCount(3, outbox);
        foreach (var item in outbox)
        {
            var delta = JsonDocument.Parse(item.PayloadJson).RootElement;
            Assert.AreEqual(1_800_000_000_100, delta.GetProperty("observed_at_utc_msc").GetInt64());
            Assert.AreEqual(1_800_000_000_000, delta.GetProperty("source_time_msc").GetInt64());
        }
        Assert.AreEqual("succeeded", result.Status);
        CollectionAssert.Contains(result.Evidence.OrderTickets.ToArray(), "20");
        Assert.AreEqual(Terminal().ConnectionEpoch, connection.Welcome!.ConnectionEpoch);
        Assert.AreEqual(2300.0, quote.Bid);
        Assert.AreEqual(2, quote.Digits);
        Assert.AreEqual(0.01, quote.Point);
        Assert.AreEqual(4, quote.SymbolTradeMode);
        Assert.IsTrue(quote.TerminalConnected);
    }

    [TestMethod]
    public async Task ReturnsTheResolvedBrokerSymbolForAStandardQuoteRequest()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection { QuoteSymbol = "XAUUSD.s" };
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_quote_suffix");
        await runtime.StartAsync();

        var quote = await runtime.GetQuoteAsync(QuoteRequest());

        Assert.AreEqual("XAUUSD.s", quote.Symbol);
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
    public async Task CompletedCommandWakesIdleCollectionImmediately()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_wake");
        await runtime.StartAsync();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var collection = runtime.RunCollectionLoopAsync(cancellation.Token);
        await WaitUntilAsync(() => connection.CollectCount >= 1, TimeSpan.FromSeconds(2));

        var started = DateTimeOffset.UtcNow;
        await runtime.ExecuteCommandAsync(Command("cancel_order", new { ticket = "20" }), cancellation.Token);
        await WaitUntilAsync(() => connection.CollectCount >= 2, TimeSpan.FromMilliseconds(500));

        Assert.IsLessThan(TimeSpan.FromMilliseconds(500), DateTimeOffset.UtcNow - started);
        Assert.IsTrue(connection.CollectedStreams[0].HasFlag(Mt4CollectionStreams.Account));
        Assert.IsFalse(connection.CollectedStreams[1].HasFlag(Mt4CollectionStreams.Account));
        Assert.IsTrue(connection.CollectedStreams[1].HasFlag(Mt4CollectionStreams.Positions));
        Assert.IsTrue(connection.CollectedStreams[1].HasFlag(Mt4CollectionStreams.Orders));
        cancellation.Cancel();
        try
        {
            await collection;
            Assert.Fail("Collection loop should stop through cancellation.");
        }
        catch (OperationCanceledException)
        {
        }
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
    public async Task ReusesFreshRatesFromSqliteAcrossMt4RuntimeRestarts()
    {
        await using var testStore = await TestStore.CreateAsync();
        var now = 1_800_000_000_100L;
        var firstConnection = new FakeConnection();
        var firstRuntime = new Mt4TerminalRuntime(
            Terminal(), firstConnection, testStore.Store, "aurum_mt4_runtime_cache_first", () => now);
        await firstRuntime.StartAsync();
        var firstRequest = RatesRequest("request_mt4_rates_cache_01");

        var first = await firstRuntime.GetDataAsync(firstRequest);
        await firstRuntime.DisposeAsync();
        now += 1_000;
        var secondConnection = new FakeConnection();
        await using var secondRuntime = new Mt4TerminalRuntime(
            Terminal(), secondConnection, testStore.Store, "aurum_mt4_runtime_cache_second", () => now);
        await secondRuntime.StartAsync();
        var second = await secondRuntime.GetDataAsync(RatesRequest("request_mt4_rates_cache_02"));

        Assert.AreEqual("succeeded", first.Status);
        Assert.AreEqual("succeeded", second.Status);
        Assert.AreEqual("request_mt4_rates_cache_02", second.RequestId);
        Assert.AreEqual(1, firstConnection.RatesRequestCount);
        Assert.AreEqual(0, secondConnection.RatesRequestCount);
    }

    [TestMethod]
    public async Task SuccessfulTradeInvalidatesEarlierMt4ReadCache()
    {
        await using var testStore = await TestStore.CreateAsync();
        var now = 1_800_000_000_100L;
        var connection = new FakeConnection();
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_cache_invalidation", () => now);
        await runtime.StartAsync();

        await runtime.GetDataAsync(RatesRequest("request_mt4_rates_before_trade_01"));
        now += 1_000;
        await runtime.GetDataAsync(RatesRequest("request_mt4_rates_before_trade_02"));
        await runtime.ExecuteCommandAsync(Command("cancel_order", new { ticket = "20" }));
        await runtime.GetDataAsync(RatesRequest("request_mt4_rates_after_trade_01"));

        Assert.AreEqual(2, connection.RatesRequestCount);
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

    [TestMethod]
    public async Task MapsAllExtendedMt4DataActionsThroughTheVersionedChannel()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection { SupportsExtendedData = true };
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_extended");
        await runtime.StartAsync();
        var actions = new[] { "symbols", "history", "chart_data", "pending_order_state", "diagnostics" };

        foreach (var action in actions)
        {
            var parameters = action switch
            {
                "history" => new { page = 2, page_size = 25, date_from = "2026-01-01", direction = "BUY" },
                "chart_data" => (object)new { date_from = "2026-01-01", date_to = "2026-01-31" },
                "pending_order_state" => new
                {
                    ticket = "5001",
                    expected_state = new { ticket = "5001", symbol = "XAUUSD", direction = "buy", volume = 0.1, magic = 234000 },
                },
                _ => new { },
            };
            var request = new DataRequestMessage
            {
                Type = "data_request", MessageId = $"message_{action}", SentAtUtcMsc = 1,
                RequestId = $"request_{action}", TerminalInstanceId = Terminal().TerminalInstanceId,
                AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
                Action = action, Params = JsonSerializer.SerializeToElement(parameters),
            };

            var response = await runtime.GetDataAsync(request);

            Assert.AreEqual("succeeded", response.Status);
            Assert.AreEqual(action, response.Payload!.Value.GetProperty("action").GetString());
            Assert.AreEqual(action, connection.LastExtendedRequest!.Action);
            if (action == "history") Assert.AreEqual(2, connection.LastExtendedRequest.Page);
        }
    }

    [TestMethod]
    public async Task OldMt4AdapterRequiresAnEaUpdateForExtendedData()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection { SupportsExtendedData = false };
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_extended_old");
        await runtime.StartAsync();
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "message_diagnostics", SentAtUtcMsc = 1,
            RequestId = "request_diagnostics", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            Action = "diagnostics", Params = JsonSerializer.SerializeToElement(new { }),
        };

        var response = await runtime.GetDataAsync(request);

        Assert.AreEqual("rejected", response.Status);
        Assert.AreEqual("mt4_ea_update_required", response.ErrorCode);
        Assert.IsNull(connection.LastExtendedRequest);
    }

    [TestMethod]
    public async Task PersistsImmutableMt4HistoryWithDualCursor()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection { SupportsDeals = true };
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_deals",
            () => 1_800_000_001_000);
        await runtime.StartAsync();

        var persisted = await runtime.IngestDealsAsync(new Mt4DealsBatch(
            1_800_000_000_900,
            [
                Json("""{"ticket":"101","time_msc":1799999999900,"symbol":"XAUUSD"}"""),
                Json("""{"ticket":"102","time_msc":1800000000000,"symbol":"XAUUSD"}"""),
            ],
            1_800_000_000_000,
            102,
            true),
            fullSnapshot: true);

        Assert.AreEqual(1, persisted);
        Assert.AreEqual(
            new AurumBridge.Storage.HistoryCursor(1_800_000_000_000, "102"),
            await testStore.Store.GetHistoryCursorAsync(
                Terminal().TerminalInstanceId, Terminal().AccountRef, "deals"));
        var outbox = await testStore.Store.GetPendingOutboxAsync();
        var delta = JsonDocument.Parse(outbox.Single().PayloadJson).RootElement;
        Assert.AreEqual("deals", delta.GetProperty("stream").GetString());
        Assert.HasCount(2, delta.GetProperty("upserts").EnumerateArray().ToArray());
    }

    [TestMethod]
    public async Task OldMt4AdapterDoesNotExposeDealsStream()
    {
        await using var testStore = await TestStore.CreateAsync();
        var connection = new FakeConnection { SupportsDeals = false };
        await using var runtime = new Mt4TerminalRuntime(
            Terminal(), connection, testStore.Store, "aurum_mt4_runtime_old_adapter");
        await runtime.StartAsync();

        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => runtime.RequestFullSnapshot("deals"));
        Assert.AreEqual(0, connection.DealsCollectCount);
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

    private static DataRequestMessage RatesRequest(string requestId) => new()
    {
        Type = "data_request",
        MessageId = $"message_{requestId}",
        SentAtUtcMsc = 1_800_000_000_000,
        RequestId = requestId,
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = Terminal().ConnectionEpoch,
        Action = "rates",
        Params = JsonSerializer.SerializeToElement(new
        {
            symbol = "XAUUSD", timeframe = "M30", count = 100,
        }),
    };

    private static JsonElement Json(string value) => JsonDocument.Parse(value).RootElement.Clone();

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        while (!condition())
        {
            await Task.Delay(10, cancellation.Token);
        }
    }

    private sealed class FakeConnection : IMt4EaConnection
    {
        public bool SupportsDeals { get; init; }
        public bool SupportsExtendedData { get; init; }
        public Mt4Welcome? Welcome { get; private set; }
        public int ExecuteCount { get; private set; }
        public int CollectCount { get; private set; }
        public List<Mt4CollectionStreams> CollectedStreams { get; } = [];
        public int DealsCollectCount { get; private set; }
        public Mt4TradeCommand? LastCommand { get; private set; }
        public List<Mt4TradeCommand> Commands { get; } = [];
        public JsonElement? NextRawResult { get; init; }
        public string? QuoteSymbol { get; init; }
        public int RatesRequestCount { get; private set; }
        public Mt4RatesRequest? LastRatesRequest { get; private set; }
        public Mt4SymbolSnapshotRequest? LastSymbolRequest { get; private set; }
        public Mt4RiskSnapshotRequest? LastRiskRequest { get; private set; }
        public Mt4PerformanceDailyRequest? LastPerformanceRequest { get; private set; }
        public Mt4ExtendedDataRequest? LastExtendedRequest { get; private set; }

        public Task SendWelcomeAsync(Mt4Welcome welcome, CancellationToken cancellationToken = default)
        {
            Welcome = welcome;
            return Task.CompletedTask;
        }

        public Task<Mt4Snapshot> CollectAsync(
            Mt4CollectionStreams streams,
            CancellationToken cancellationToken = default)
        {
            CollectCount++;
            CollectedStreams.Add(streams);
            return Task.FromResult(new Mt4Snapshot(
                1_800_000_000_000,
                Json("""{"balance":1000.0}"""),
                [],
                []));
        }

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
                QuoteSymbol ?? request.Symbol,
                1_800_000_000_060,
                "succeeded",
                2300.0,
                2300.2,
                null,
                180,
                "broker_time_derived",
                2,
                0.01,
                4));

        public Task<Mt4Rates> GetRatesAsync(
            Mt4RatesRequest request,
            CancellationToken cancellationToken = default)
        {
            RatesRequestCount++;
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

        public Task<Mt4ExtendedData> GetExtendedDataAsync(
            Mt4ExtendedDataRequest request,
            CancellationToken cancellationToken = default)
        {
            LastExtendedRequest = request;
            return Task.FromResult(new Mt4ExtendedData(
                request.RequestId, 1_800_000_000_095, "succeeded",
                JsonSerializer.SerializeToElement(new { action = request.Action, source = "mt4" }), null));
        }

        public Task<Mt4DealsBatch> CollectDealsAsync(
            Mt4DealsRequest request,
            CancellationToken cancellationToken = default)
        {
            DealsCollectCount++;
            return Task.FromResult(new Mt4DealsBatch(
                1_800_000_000_100,
                [],
                request.CursorTimeMsc,
                request.CursorTicket,
                false));
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
