using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeCommandDispatcherTests
{
    private const long Now = 1_800_000_000_000;
    private TestStore _testStore = null!;

    public TestContext TestContext { get; set; } = null!;

    [TestInitialize]
    public async Task InitializeAsync()
    {
        _testStore = await TestStore.CreateAsync();
    }

    [TestCleanup]
    public async Task CleanupAsync() => await _testStore.DisposeAsync();

    [TestMethod]
    public async Task ConcurrentDuplicateCommandExecutesWorkerExactlyOnce()
    {
        var calls = 0;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var dispatcher = Dispatcher(async (command, _) =>
        {
            Interlocked.Increment(ref calls);
            await release.Task;
            return Success(command);
        });
        var command = Command();

        var first = dispatcher.DispatchAsync(command);
        var second = dispatcher.DispatchAsync(command);
        release.SetResult();
        var results = await Task.WhenAll(first, second);

        Assert.AreEqual(1, calls);
        Assert.IsTrue(results.All(result => result.Status == "succeeded"));
        Assert.IsNotNull(await _testStore.Store.GetExecutionReceiptAsync(command.CommandId));
    }

    [TestMethod]
    public async Task PersistedReceiptPreventsExecutionAfterRestart()
    {
        var command = Command();
        await _testStore.Store.SaveExecutionReceiptAsync(Success(command));
        var handler = new MockHandler();
        var dispatcher = Dispatcher(handler.ExecuteAsync);

        var result = await dispatcher.DispatchAsync(command);

        Assert.AreEqual("succeeded", result.Status);
        Assert.AreEqual(0, handler.Calls);
    }

    [TestMethod]
    public async Task RejectsExpiredAndCrossAccountCommandsWithoutCallingWorker()
    {
        var handler = new MockHandler();
        var dispatcher = Dispatcher(handler.ExecuteAsync);

        var expired = await dispatcher.DispatchAsync(Command() with { DeadlineUtcMsc = Now });
        var wrongAccount = await dispatcher.DispatchAsync(Command("command_01JDISPATCH02") with
        {
            AccountRef = new("Broker-Demo", "999"),
        });

        Assert.AreEqual("command_expired", expired.ErrorCode);
        Assert.AreEqual("command_route_mismatch", wrongAccount.ErrorCode);
        Assert.AreEqual(0, handler.Calls);
    }

    [TestMethod]
    public async Task RejectsTradeUntilInitialSnapshotsAreAcknowledgedButAllowsReconciliation()
    {
        var handler = new MockHandler();
        var dispatcher = Dispatcher(handler.ExecuteAsync, initialSyncReady:false);

        var trade = await dispatcher.DispatchAsync(Command("command_01JDISPATCH06"));
        var query = await dispatcher.DispatchAsync(Command("command_01JDISPATCH07") with
        {
            Action = "query_execution",
        });

        Assert.AreEqual("rejected", trade.Status);
        Assert.AreEqual("terminal_initial_sync_pending", trade.ErrorCode);
        Assert.AreEqual("succeeded", query.Status);
        Assert.AreEqual(1, handler.Calls);
    }

    [TestMethod]
    public async Task ANewSessionResetsInitialSnapshotReadiness()
    {
        var handler = new MockHandler();
        var dispatcher = Dispatcher(handler.ExecuteAsync);
        dispatcher.BeginSession("session_dispatch_02", [Terminal()]);

        var result = await dispatcher.DispatchAsync(Command("command_01JDISPATCH08"));

        Assert.AreEqual("terminal_initial_sync_pending", result.ErrorCode);
        Assert.AreEqual(0, handler.Calls);
    }

    [TestMethod]
    public async Task ConvertsWorkerExceptionAndMismatchedResultToUncertain()
    {
        var throwing = Dispatcher((_, _) => throw new InvalidOperationException("worker lost"));
        var failed = await throwing.DispatchAsync(Command());
        Assert.AreEqual("uncertain", failed.Status);
        Assert.AreEqual("worker_execution_exception", failed.ErrorCode);

        var mismatched = Dispatcher((command, _) => Task.FromResult(Success(command) with
        {
            ConnectionEpoch = command.ConnectionEpoch + 1,
        }));
        var invalid = await mismatched.DispatchAsync(Command("command_01JDISPATCH03"));
        Assert.AreEqual("uncertain", invalid.Status);
        Assert.AreEqual("worker_result_route_mismatch", invalid.ErrorCode);
    }

    [TestMethod]
    public async Task PersistsTimedOutExecutionAsUncertainAndNeverReplaysItLocally()
    {
        var calls = 0;
        var dispatcher = Dispatcher((_, _) =>
        {
            calls++;
            throw new TimeoutException("mt5_worker_request_timeout");
        });
        var command = Command("command_01JDISPATCH09");

        var first = await dispatcher.DispatchAsync(command);
        var duplicate = await dispatcher.DispatchAsync(command);

        Assert.AreEqual(1, calls);
        Assert.AreEqual("uncertain", first.Status);
        Assert.AreEqual("worker_execution_timeout", first.ErrorCode);
        Assert.AreEqual(first.CommandId, duplicate.CommandId);
        Assert.AreEqual(first.Status, duplicate.Status);
        Assert.AreEqual(first.ErrorCode, duplicate.ErrorCode);
        Assert.IsNotNull(await _testStore.Store.GetExecutionReceiptAsync(command.CommandId));
    }

    [TestMethod]
    public async Task PersistsUncertainReceiptWhenWorkerCancellationIsObserved()
    {
        using var cancellation = new CancellationTokenSource();
        var dispatcher = Dispatcher((_, token) =>
        {
            cancellation.Cancel();
            return Task.FromCanceled<CommandResultMessage>(token);
        });

        var result = await dispatcher.DispatchAsync(Command(), cancellation.Token);

        Assert.AreEqual("uncertain", result.Status);
        Assert.AreEqual("worker_execution_cancelled", result.ErrorCode);
        Assert.IsNotNull(await _testStore.Store.GetExecutionReceiptAsync(result.CommandId));
    }

    [TestMethod]
    public async Task PauseAtomicallyRejectsNewAdmissionAndDrainsExistingCommand()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var dispatcher = Dispatcher(async (command, _) =>
        {
            await release.Task;
            return Success(command);
        });
        var running = dispatcher.DispatchAsync(Command());
        await WaitUntilAsync(() => dispatcher.InFlightCount == 1);

        var drain = dispatcher.PauseAndDrainAsync(TimeSpan.FromSeconds(2));
        await Assert.ThrowsExactlyAsync<BridgeCommandAdmissionPausedException>(() =>
            dispatcher.DispatchAsync(Command("command_01JDISPATCH04")));
        Assert.IsFalse(drain.IsCompleted);
        release.SetResult();
        await running;
        await drain;

        Assert.AreEqual(0, dispatcher.InFlightCount);
        dispatcher.Resume();
        Assert.AreEqual("succeeded", (await dispatcher.DispatchAsync(Command("command_01JDISPATCH05"))).Status);
    }

    [TestMethod]
    [TestCategory("Acceptance")]
    public async Task TenThousandFaultInjectedCommandsNeverDuplicateOrCrossRouteAfterRestart()
    {
        const int injectionCount = 10_000;
        var workerCalls = 0;
        var successful = Command("command_01JACCEPTANCE01");
        var expired = Command("command_01JACCEPTANCE02") with { DeadlineUtcMsc = Now };
        var crossAccount = Command("command_01JACCEPTANCE03") with
        {
            AccountRef = new("Broker-Demo", "999"),
        };
        var interrupted = Command("command_01JACCEPTANCE04") with
        {
            Action = "query_execution",
        };
        var commands = new[] { successful, expired, crossAccount, interrupted };
        var dispatcher = Dispatcher((command, _) =>
        {
            Interlocked.Increment(ref workerCalls);
            return command.CommandId == interrupted.CommandId
                ? throw new IOException("simulated_worker_disconnect")
                : Task.FromResult(Success(command));
        });

        var started = System.Diagnostics.Stopwatch.StartNew();
        var results = await Task.WhenAll(Enumerable.Range(0, injectionCount)
            .Select(index => dispatcher.DispatchAsync(commands[index % commands.Length])));
        started.Stop();

        Assert.AreEqual(2, workerCalls, "Only the valid trade and interrupted reconciliation may reach the Worker.");
        Assert.AreEqual(injectionCount / 4, results.Count(result => result.Status == "succeeded"));
        Assert.AreEqual(injectionCount / 4, results.Count(result => result.ErrorCode == "command_expired"));
        Assert.AreEqual(injectionCount / 4, results.Count(result => result.ErrorCode == "command_route_mismatch"));
        Assert.AreEqual(injectionCount / 4, results.Count(result =>
            result.Status == "uncertain" && result.ErrorCode == "worker_execution_exception"));

        var replayCalls = 0;
        var restarted = Dispatcher((command, _) =>
        {
            Interlocked.Increment(ref replayCalls);
            return Task.FromResult(Success(command));
        });
        var replayed = await Task.WhenAll(Enumerable.Range(0, injectionCount)
            .Select(index => restarted.DispatchAsync(commands[index % commands.Length])));

        Assert.AreEqual(0, replayCalls, "Persisted terminal receipts must prevent execution after process restart.");
        Assert.IsTrue(replayed.All(result => results.Any(original =>
            original.CommandId == result.CommandId
            && original.Status == result.Status
            && original.ErrorCode == result.ErrorCode)));
        TestContext.WriteLine(
            $"Local in-process safety baseline: {injectionCount} injections in {started.ElapsedMilliseconds} ms; no production latency claim.");
    }

    [TestMethod]
    [TestCategory("Acceptance")]
    public async Task BridgeDispatchOverheadP99StaysWithinFiftyMilliseconds()
    {
        const int warmupCount = 100;
        const int sampleCount = 1_000;
        var handlerCalls = 0;
        var dispatcher = Dispatcher((command, _) =>
        {
            Interlocked.Increment(ref handlerCalls);
            return Task.FromResult(Success(command));
        });
        var samples = new double[sampleCount];

        for (var index = 0; index < warmupCount + sampleCount; index++)
        {
            var command = Command($"command_01JPERF{index:D6}") with
            {
                Action = "query_execution",
            };
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            var result = await dispatcher.DispatchAsync(command);
            Assert.AreEqual("succeeded", result.Status);
            if (index >= warmupCount)
            {
                samples[index - warmupCount] = System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            }
        }

        Array.Sort(samples);
        var p99 = samples[(int)Math.Ceiling(samples.Length * 0.99) - 1];
        TestContext.WriteLine(
            $"Local Bridge dispatch p99: {p99:F3} ms ({sampleCount} samples; SQLite receipt included, Worker execution excluded).");
        Assert.AreEqual(warmupCount + sampleCount, handlerCalls);
        Assert.IsLessThanOrEqualTo(50.0, p99,
            "Local Bridge dispatch overhead p99 exceeded the acceptance budget.");
    }

    private BridgeCommandDispatcher Dispatcher(
        TerminalCommandHandler handler,
        bool initialSyncReady = true)
    {
        var dispatcher = new BridgeCommandDispatcher(
            _testStore.Store,
            terminalId => terminalId == "terminal_01JDISPATCH1" ? Terminal() : null,
            handler,
            () => Now);
        dispatcher.BeginSession("session_dispatch_01", [Terminal()]);
        if (initialSyncReady)
        {
            foreach (var stream in new[] { "account", "positions", "orders" })
            {
                dispatcher.AcknowledgeInitialSnapshot(
                    Terminal().TerminalInstanceId,
                    Terminal().ConnectionEpoch,
                    stream);
            }
        }
        return dispatcher;
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "terminal_01JDISPATCH1",
        Platform = "mt5",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
    };

    private static CommandMessage Command(string commandId = "command_01JDISPATCH01") => new()
    {
        Type = "command",
        MessageId = $"msg_{commandId}",
        SentAtUtcMsc = Now,
        CommandId = commandId,
        TerminalInstanceId = "terminal_01JDISPATCH1",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 7,
        IssuedAtUtcMsc = Now,
        DeadlineUtcMsc = Now + 10_000,
        Action = "place_order",
        Params = JsonDocument.Parse("""{"symbol":"XAUUSD","volume":"0.01"}""").RootElement.Clone(),
    };

    private static CommandResultMessage Success(CommandMessage command) => new()
    {
        Type = "command_result",
        MessageId = $"result_{command.CommandId}",
        SentAtUtcMsc = Now + 1,
        CommandId = command.CommandId,
        TerminalInstanceId = command.TerminalInstanceId,
        AccountRef = command.AccountRef,
        ConnectionEpoch = command.ConnectionEpoch,
        Status = "succeeded",
        CompletedAtUtcMsc = Now + 1,
        Evidence = new() { ObservedAtUtcMsc = Now + 1 },
    };

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!condition())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class MockHandler
    {
        public int Calls { get; private set; }

        public Task<CommandResultMessage> ExecuteAsync(CommandMessage command, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(Success(command));
        }
    }
}
