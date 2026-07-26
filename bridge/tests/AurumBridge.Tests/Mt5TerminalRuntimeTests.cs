using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt5TerminalRuntimeTests
{
    [TestMethod]
    public void CollectionCadenceUsesLowIdleLoadAndFastActivePolling()
    {
        Assert.AreEqual(
            TimeSpan.FromSeconds(1),
            Mt5TerminalRuntime.CollectionDelay(hasActiveTrades:false));
        Assert.AreEqual(
            TimeSpan.FromMilliseconds(250),
            Mt5TerminalRuntime.CollectionDelay(hasActiveTrades:true));
    }

    private TestStore _testStore = null!;
    private FakeWorker _worker = null!;
    private Mt5TerminalRuntime _runtime = null!;

    [TestInitialize]
    public async Task InitializeAsync()
    {
        _testStore = await TestStore.CreateAsync();
        _worker = new FakeWorker();
        _runtime = new Mt5TerminalRuntime(Terminal(), _worker, _testStore.Store, () => 1_800_000_000_000);
        await _runtime.StartAsync();
    }

    [TestCleanup]
    public async Task CleanupAsync()
    {
        await _runtime.DisposeAsync();
        await _testStore.DisposeAsync();
    }

    [TestMethod]
    public async Task InitialSnapshotPersistsThreeFullStreamsAndUnchangedPollPersistsNothing()
    {
        var snapshot = Snapshot("1001");
        Assert.AreEqual(3, await _runtime.IngestSnapshotAsync(snapshot, fullSnapshot: true));
        var outbox = await _testStore.Store.GetPendingOutboxAsync();
        Assert.HasCount(3, outbox);
        foreach (var item in outbox)
        {
            var delta = JsonDocument.Parse(item.PayloadJson).RootElement;
            Assert.AreEqual(1_800_000_000_000, delta.GetProperty("observed_at_utc_msc").GetInt64());
            Assert.AreEqual(1_799_999_999_900, delta.GetProperty("source_time_msc").GetInt64());
        }
        Assert.AreEqual(0, await _runtime.IngestSnapshotAsync(snapshot, fullSnapshot: false));
        Assert.HasCount(3, await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task UnchangedPollAdvancesStreamFreshnessWithoutWritingAnotherDelta()
    {
        await _runtime.DisposeAsync();
        var now = 1_800_000_000_000L;
        _runtime = new Mt5TerminalRuntime(Terminal(), _worker, _testStore.Store,
            () => Interlocked.Read(ref now));
        await _runtime.StartAsync();
        var snapshot = Snapshot("1001");

        Assert.AreEqual(3, await _runtime.IngestSnapshotAsync(snapshot, fullSnapshot:true));
        Interlocked.Exchange(ref now, 1_800_000_015_000L);
        Assert.AreEqual(0, await _runtime.IngestSnapshotAsync(snapshot, fullSnapshot:false));

        var freshness = _runtime.GetStreamFreshness();
        Assert.AreEqual(1_800_000_015_000L, freshness["account"]);
        Assert.AreEqual(1_800_000_015_000L, freshness["positions"]);
        Assert.AreEqual(1_800_000_015_000L, freshness["orders"]);
        Assert.HasCount(3, await _testStore.Store.GetPendingOutboxAsync());
    }

    [TestMethod]
    public async Task LegacyWorkerSnapshotTimeRemainsSupportedAsSourceTime()
    {
        var snapshot = Snapshot("1001", legacyTimeField: true);

        Assert.AreEqual(3, await _runtime.IngestSnapshotAsync(snapshot, fullSnapshot: true));

        var outbox = await _testStore.Store.GetPendingOutboxAsync();
        var delta = JsonDocument.Parse(outbox[0].PayloadJson).RootElement;
        Assert.AreEqual(1_800_000_000_000, delta.GetProperty("observed_at_utc_msc").GetInt64());
        Assert.AreEqual(1_799_999_999_900, delta.GetProperty("source_time_msc").GetInt64());
    }

    [TestMethod]
    public async Task DealBatchesPersistAsImmutableDeltasAndAdvanceDurableCursor()
    {
        var first = DealSnapshot(
            [new { ticket = 5001, time_msc = 1_799_999_999_800, symbol = "XAUUSD" }],
            1_799_999_999_900,
            "0",
            hasMore:true);

        Assert.AreEqual(1, await _runtime.IngestSnapshotAsync(first, fullSnapshot:true));

        var pending = await _testStore.Store.GetPendingOutboxAsync();
        var delta = JsonDocument.Parse(pending.Single().PayloadJson).RootElement;
        Assert.AreEqual("deals", delta.GetProperty("stream").GetString());
        Assert.IsTrue(delta.GetProperty("full_snapshot").GetBoolean());
        Assert.AreEqual(0, delta.GetProperty("deletes").GetArrayLength());
        Assert.AreEqual(5001, delta.GetProperty("upserts")[0].GetProperty("ticket").GetInt32());
        Assert.AreEqual(
            new AurumBridge.Storage.HistoryCursor(1_799_999_999_900, "0"),
            await _testStore.Store.GetHistoryCursorAsync(Terminal().TerminalInstanceId, "deals"));

        var emptyBackfill = DealSnapshot([], 1_800_000_000_000, "0", hasMore:true);
        Assert.AreEqual(0, await _runtime.IngestSnapshotAsync(emptyBackfill, fullSnapshot:false));
        Assert.AreEqual(
            new AurumBridge.Storage.HistoryCursor(1_800_000_000_000, "0"),
            await _testStore.Store.GetHistoryCursorAsync(Terminal().TerminalInstanceId, "deals"));
    }

    [TestMethod]
    public async Task DealCollectorRejectsARegressingCursor()
    {
        await _runtime.IngestSnapshotAsync(
            DealSnapshot([], 1_799_999_999_900, "0", hasMore:true), fullSnapshot:true);

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            _runtime.IngestSnapshotAsync(
                DealSnapshot([], 1_799_999_999_800, "0", hasMore:false), fullSnapshot:false));
    }

    [TestMethod]
    public async Task ChangedCollectionProducesOnlyOneIncrementalStreamMessage()
    {
        await _runtime.IngestSnapshotAsync(Snapshot("1001"), fullSnapshot: true);
        var changed = Snapshot("1002");

        Assert.AreEqual(1, await _runtime.IngestSnapshotAsync(changed, fullSnapshot: false));
        var outbox = await _testStore.Store.GetPendingOutboxAsync();
        Assert.HasCount(4, outbox);
        var delta = JsonDocument.Parse(outbox[^1].PayloadJson).RootElement;
        Assert.IsFalse(delta.GetProperty("full_snapshot").GetBoolean());
        Assert.AreEqual(2, delta.GetProperty("revision").GetInt64());
        Assert.AreEqual("1001", delta.GetProperty("deletes")[0].GetString());
        Assert.AreEqual("1002", delta.GetProperty("upserts")[0].GetProperty("ticket").GetString());
    }

    [TestMethod]
    public async Task CommandIsMechanicallyForwardedToWorker()
    {
        var command = new CommandMessage
        {
            Type = "command",
            MessageId = "msg_command_01",
            SentAtUtcMsc = 1,
            CommandId = "command_01JRUNTIME01",
            TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef,
            ConnectionEpoch = 7,
            IssuedAtUtcMsc = 1,
            DeadlineUtcMsc = long.MaxValue,
            Action = "cancel_order",
            Params = JsonSerializer.SerializeToElement(new { ticket = "1001" }),
        };
        _worker.Response = JsonSerializer.SerializeToElement(Result(command));

        var response = await _runtime.ExecuteCommandAsync(command);

        Assert.AreEqual(command.CommandId, response.CommandId);
        Assert.AreEqual(1, _worker.RequestCount);
    }

    [TestMethod]
    public async Task CompletedCommandWakesIdleCollectionImmediately()
    {
        var command = new CommandMessage
        {
            Type = "command", MessageId = "msg_command_wake", SentAtUtcMsc = 1,
            CommandId = "command_01JWAKE0001", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            IssuedAtUtcMsc = 1, DeadlineUtcMsc = long.MaxValue, Action = "cancel_order",
            Params = JsonSerializer.SerializeToElement(new { ticket = "1001" }),
        };
        _worker.ResponseFactory = request => request is CommandMessage ?
            JsonSerializer.SerializeToElement(Result(command)) : Snapshot("1001");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var collection = _runtime.RunCollectionLoopAsync(cancellation.Token);
        await WaitUntilAsync(() => _worker.RequestCount >= 1, TimeSpan.FromSeconds(2));

        var started = DateTimeOffset.UtcNow;
        await _runtime.ExecuteCommandAsync(command, cancellation.Token);
        await WaitUntilAsync(() => _worker.RequestCount >= 3, TimeSpan.FromMilliseconds(500));

        Assert.IsLessThan(TimeSpan.FromMilliseconds(500), DateTimeOffset.UtcNow - started);
        cancellation.Cancel();
        await AssertCollectionCancelledAsync(collection);
    }

    [TestMethod]
    public async Task QuoteRequestIsMechanicallyForwardedToWorker()
    {
        var request = new QuoteRequestMessage
        {
            Type = "quote_request",
            MessageId = "msg_quote_runtime_01",
            SentAtUtcMsc = 1,
            RequestId = "quote_01JRUNTIME01",
            TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef,
            ConnectionEpoch = Terminal().ConnectionEpoch,
            Symbol = "XAUUSD",
        };
        _worker.Response = JsonSerializer.SerializeToElement(new QuoteMessage
        {
            Type = "quote",
            MessageId = "quote_result_runtime_01",
            SentAtUtcMsc = 2,
            RequestId = request.RequestId,
            TerminalInstanceId = request.TerminalInstanceId,
            AccountRef = request.AccountRef,
            ConnectionEpoch = request.ConnectionEpoch,
            Symbol = request.Symbol,
            ObservedAtUtcMsc = 2,
            Status = "succeeded",
            Bid = 2300.0,
            Ask = 2300.2,
        });

        var response = await _runtime.GetQuoteAsync(request);

        Assert.AreEqual(2300.0, response.Bid);
        Assert.AreEqual(1, _worker.RequestCount);
    }

    [TestMethod]
    public async Task DataRequestIsMechanicallyForwardedToWorker()
    {
        var request = new DataRequestMessage
        {
            Type = "data_request", MessageId = "msg_data_runtime_01", SentAtUtcMsc = 1,
            RequestId = "data_01JRUNTIME01", TerminalInstanceId = Terminal().TerminalInstanceId,
            AccountRef = Terminal().AccountRef, ConnectionEpoch = Terminal().ConnectionEpoch,
            Action = "rates",
            Params = JsonSerializer.SerializeToElement(new { symbol = "XAUUSD", timeframe = "M30", count = 100 }),
        };
        _worker.Response = JsonSerializer.SerializeToElement(new DataResponseMessage
        {
            Type = "data_response", MessageId = "data_result_runtime_01", SentAtUtcMsc = 2,
            RequestId = request.RequestId, TerminalInstanceId = request.TerminalInstanceId,
            AccountRef = request.AccountRef, ConnectionEpoch = request.ConnectionEpoch,
            Action = request.Action, Params = request.Params, ObservedAtUtcMsc = 2,
            Status = "succeeded", Payload = JsonSerializer.SerializeToElement(new { rates = Array.Empty<object>() }),
        });

        var response = await _runtime.GetDataAsync(request);

        Assert.AreEqual("rates", response.Action);
        Assert.AreEqual(1, _worker.RequestCount);
    }

    [TestMethod]
    public async Task RestartWithinSameEpochContinuesRevisionFromSqlite()
    {
        await _runtime.IngestSnapshotAsync(Snapshot("1001"), fullSnapshot: true);
        await _runtime.DisposeAsync();
        var replacement = new Mt5TerminalRuntime(Terminal(), new FakeWorker(), _testStore.Store,
            () => 1_800_000_001_000);
        await replacement.StartAsync();
        try
        {
            await replacement.IngestSnapshotAsync(Snapshot("1001"), fullSnapshot: true);
            var outbox = await _testStore.Store.GetPendingOutboxAsync();
            Assert.HasCount(3, outbox);
            foreach (var payload in outbox)
            {
                Assert.AreEqual(2, JsonDocument.Parse(payload.PayloadJson).RootElement
                    .GetProperty("revision").GetInt64());
            }
        }
        finally
        {
            await replacement.DisposeAsync();
        }
    }

    [TestMethod]
    public void RejectsUnsupportedSnapshotStream()
    {
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => _runtime.RequestFullSnapshot("history"));
    }

    [TestMethod]
    public async Task GapRequestForcesOnlyTheRequestedStreamOnTheNextPoll()
    {
        _worker.Response = Snapshot("1001");
        _worker.RequestObserved = count =>
        {
            if (count == 1)
            {
                _runtime.RequestFullSnapshot("positions");
            }
        };
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var collection = _runtime.RunCollectionLoopAsync(cancellation.Token);

        await _worker.WaitForRequestCountAsync(2).WaitAsync(TimeSpan.FromSeconds(3));
        IReadOnlyList<AurumBridge.Storage.OutboxMessage> pending;
        while (true)
        {
            pending = await _testStore.Store.GetPendingOutboxAsync();
            if (pending.Any(message =>
            {
                var delta = JsonDocument.Parse(message.PayloadJson).RootElement;
                return delta.GetProperty("stream").GetString() == "positions"
                    && delta.GetProperty("revision").GetInt64() == 2
                    && delta.GetProperty("full_snapshot").GetBoolean();
            }))
            {
                break;
            }
            await Task.Delay(10, cancellation.Token);
        }
        cancellation.Cancel();
        await AssertCollectionCancelledAsync(collection);

        var outbox = await _testStore.Store.GetPendingOutboxAsync();
        Assert.HasCount(3, outbox);
        var refresh = outbox.Select(message => JsonDocument.Parse(message.PayloadJson).RootElement.Clone())
            .Single(delta => delta.GetProperty("stream").GetString() == "positions");
        Assert.AreEqual("positions", refresh.GetProperty("stream").GetString());
        Assert.AreEqual(2, refresh.GetProperty("revision").GetInt64());
        Assert.IsTrue(refresh.GetProperty("full_snapshot").GetBoolean());
    }

    [TestMethod]
    public async Task UnchangedPollingDoesNotPeriodicallyForceFullSnapshots()
    {
        await _runtime.DisposeAsync();
        var now = 1_800_000_000_000L;
        _worker = new FakeWorker { Response = Snapshot("1001") };
        _runtime = new Mt5TerminalRuntime(
            Terminal(), _worker, _testStore.Store, () => Interlocked.Add(ref now, 11_000));
        await _runtime.StartAsync();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var collection = _runtime.RunCollectionLoopAsync(cancellation.Token);

        await _worker.WaitForRequestCountAsync(2).WaitAsync(TimeSpan.FromSeconds(3));
        while ((await _testStore.Store.GetPendingOutboxAsync()).Count < 3)
        {
            await Task.Delay(10, cancellation.Token);
        }
        await Task.Delay(100, cancellation.Token);
        cancellation.Cancel();
        await AssertCollectionCancelledAsync(collection);

        Assert.HasCount(3, await _testStore.Store.GetPendingOutboxAsync());
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "terminal_01JRUNTIME01",
        Platform = "mt5",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
    };

    private static JsonElement Snapshot(string positionTicket, bool legacyTimeField = false)
    {
        var snapshot = new Dictionary<string, object?>
        {
            ["v"] = 3,
            ["type"] = "snapshot",
            [legacyTimeField ? "observed_at_utc_msc" : "source_time_msc"] = 1_799_999_999_900,
            ["streams"] = new
            {
                account = new { login = 12345678, balance = 1000.0 },
                positions = new[] { new { ticket = positionTicket, symbol = "XAUUSD" } },
                orders = Array.Empty<object>(),
            },
        };
        return JsonSerializer.SerializeToElement(snapshot);
    }

    private static JsonElement DealSnapshot(
        IReadOnlyList<object> items,
        long nextTimeMsc,
        string nextTicket,
        bool hasMore) => JsonSerializer.SerializeToElement(new
        {
            v = 3,
            type = "snapshot",
            source_time_msc = 1_799_999_999_900,
            streams = new
            {
                deals = new
                {
                    items,
                    next_cursor = new { time_msc = nextTimeMsc, ticket = nextTicket },
                    has_more = hasMore,
                },
            },
        });

    private static CommandResultMessage Result(CommandMessage command) => new()
    {
        Type = "command_result",
        MessageId = "result_01JRUNTIME01",
        SentAtUtcMsc = 2,
        CommandId = command.CommandId,
        TerminalInstanceId = command.TerminalInstanceId,
        AccountRef = command.AccountRef,
        ConnectionEpoch = command.ConnectionEpoch,
        Status = "succeeded",
        CompletedAtUtcMsc = 2,
        Evidence = new() { ObservedAtUtcMsc = 2 },
    };

    private static async Task WaitUntilAsync(Func<bool> condition, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        while (!condition())
        {
            await Task.Delay(10, cancellation.Token);
        }
    }

    private static async Task AssertCollectionCancelledAsync(Task collection)
    {
        try
        {
            await collection;
            Assert.Fail("Collection loop should stop through cancellation.");
        }
        catch (OperationCanceledException)
        {
        }
    }

    private sealed class FakeWorker : IMt5WorkerClient
    {
        public bool IsConnected { get; private set; }
        public JsonElement WorkerHello { get; private set; }
        public JsonElement Response { get; set; }
        public Func<object, JsonElement>? ResponseFactory { get; set; }
        public int RequestCount { get; private set; }
        public Action<int>? RequestObserved { get; set; }
        private readonly TaskCompletionSource _secondRequest = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task StartAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
        {
            IsConnected = true;
            return Task.CompletedTask;
        }
        public Task<JsonElement> RequestAsync<T>(
            T request,
            WorkerRequestPriority priority,
            CancellationToken cancellationToken = default)
        {
            RequestCount++;
            RequestObserved?.Invoke(RequestCount);
            if (RequestCount >= 2)
            {
                _secondRequest.TrySetResult();
            }
            return Task.FromResult(ResponseFactory?.Invoke(request!) ?? Response);
        }

        public Task WaitForRequestCountAsync(int count) => count <= RequestCount || count < 2
            ? Task.CompletedTask
            : _secondRequest.Task;
        public ValueTask DisposeAsync()
        {
            IsConnected = false;
            return ValueTask.CompletedTask;
        }
    }
}
