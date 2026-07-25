using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt5TerminalRuntimeTests
{
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
        Assert.HasCount(3, await _testStore.Store.GetPendingOutboxAsync());
        Assert.AreEqual(0, await _runtime.IngestSnapshotAsync(snapshot, fullSnapshot: false));
        Assert.HasCount(3, await _testStore.Store.GetPendingOutboxAsync());
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
            Assert.HasCount(6, outbox);
            foreach (var payload in outbox.Skip(3))
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
        while ((await _testStore.Store.GetPendingOutboxAsync()).Count < 4)
        {
            await Task.Delay(10, cancellation.Token);
        }
        cancellation.Cancel();
        await Assert.ThrowsExactlyAsync<TaskCanceledException>(async () => await collection);

        var outbox = await _testStore.Store.GetPendingOutboxAsync();
        Assert.HasCount(4, outbox);
        var refresh = JsonDocument.Parse(outbox[^1].PayloadJson).RootElement;
        Assert.AreEqual("positions", refresh.GetProperty("stream").GetString());
        Assert.IsTrue(refresh.GetProperty("full_snapshot").GetBoolean());
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "terminal_01JRUNTIME01",
        Platform = "mt5",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
    };

    private static JsonElement Snapshot(string positionTicket) => JsonSerializer.SerializeToElement(new
    {
        v = 3,
        type = "snapshot",
        observed_at_utc_msc = 1_800_000_000_000,
        streams = new
        {
            account = new { login = 12345678, balance = 1000.0 },
            positions = new[] { new { ticket = positionTicket, symbol = "XAUUSD" } },
            orders = Array.Empty<object>(),
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

    private sealed class FakeWorker : IMt5WorkerClient
    {
        public bool IsConnected { get; private set; }
        public JsonElement WorkerHello { get; private set; }
        public JsonElement Response { get; set; }
        public int RequestCount { get; private set; }
        public Action<int>? RequestObserved { get; set; }
        private readonly TaskCompletionSource _secondRequest = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task StartAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
        {
            IsConnected = true;
            return Task.CompletedTask;
        }
        public Task<JsonElement> RequestAsync<T>(T request, CancellationToken cancellationToken = default)
        {
            RequestCount++;
            RequestObserved?.Invoke(RequestCount);
            if (RequestCount >= 2)
            {
                _secondRequest.TrySetResult();
            }
            return Task.FromResult(Response);
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
