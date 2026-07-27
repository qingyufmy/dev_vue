using System.Collections.Concurrent;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeHostTests
{
    [TestMethod]
    public async Task DispatchesCommandsToTheSelectedTerminal()
    {
        await using var testStore = await TestStore.CreateAsync();
        var first = new FakeRuntime(Terminal("terminal_host_01", "1001"));
        var second = new FakeRuntime(Terminal("terminal_host_02", "1002"));
        await using var host = new BridgeHost(testStore.Store,
        [
            new(first.Terminal, () => first),
            new(second.Terminal, () => second),
        ]);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var run = host.RunAsync(cancellation.Token);
        await Task.WhenAll(first.Running.Task, second.Running.Task).WaitAsync(TimeSpan.FromSeconds(2));

        var command = Command(second.Terminal);
        var result = await host.CommandDispatcher.DispatchAsync(command);
        var quote = await host.GetQuoteAsync(QuoteRequest(second.Terminal));

        Assert.AreEqual("succeeded", result.Status);
        Assert.AreEqual(0, first.CommandCount);
        Assert.AreEqual(1, second.CommandCount);
        Assert.AreEqual("XAUUSD", quote.Symbol);
        Assert.AreEqual(1, second.QuoteCount);
        await host.HandleFullSnapshotRequestAsync(new(
            second.Terminal.TerminalInstanceId,
            second.Terminal.ConnectionEpoch,
            "orders",
            1));
        Assert.HasCount(1, second.FullSnapshotRequests);
        await host.RequestAllFullSnapshotsAsync();
        CollectionAssert.AreEquivalent(
            new[] { "account", "positions", "orders" },
            first.FullSnapshotRequests);
        Assert.AreEqual(4, second.FullSnapshotRequests.Count);

        cancellation.Cancel();
        await run;
    }

    [TestMethod]
    public async Task RejectsDuplicateTerminalIds()
    {
        await using var testStore = await TestStore.CreateAsync();
        var terminal = Terminal("terminal_duplicate_01", "1001");
        var first = new TerminalRuntimeSupervisor(terminal, () => new FakeRuntime(terminal));
        var second = new TerminalRuntimeSupervisor(terminal, () => new FakeRuntime(terminal));

        Assert.ThrowsExactly<ArgumentException>(() => new BridgeHost(testStore.Store, [first, second]));
    }

    [TestMethod]
    [TestCategory("Acceptance")]
    [DataRow(1)]
    [DataRow(5)]
    [DataRow(20)]
    public async Task IsolatesOneWorkerCrashAcrossTerminalScale(int terminalCount)
    {
        await using var testStore = await TestStore.CreateAsync();
        var terminals = Enumerable.Range(0, terminalCount)
            .Select(index => Terminal($"terminal_scale_{index:D2}", $"20{index:D3}"))
            .ToArray();
        var creationCounts = new int[terminalCount];
        var stableRuntimes = new IsolatedRuntime?[terminalCount];
        var stableRunning = Enumerable.Range(0, terminalCount)
            .Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
            .ToArray();
        var supervisors = terminals.Select((terminal, index) => new TerminalRuntimeSupervisor(
            terminal,
            () =>
            {
                var creation = Interlocked.Increment(ref creationCounts[index]);
                var failCollection = index == 0 && creation == 1;
                var runtime = new IsolatedRuntime(terminal, failCollection);
                if (!failCollection)
                {
                    stableRuntimes[index] = runtime;
                    runtime.Started += () => stableRunning[index].TrySetResult();
                }
                return runtime;
            },
            (_, _) => Task.CompletedTask)).ToArray();
        await using var host = new BridgeHost(testStore.Store, supervisors);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var run = host.RunAsync(cancellation.Token);

        await Task.WhenAll(stableRunning.Select(signal => signal.Task)).WaitAsync(TimeSpan.FromSeconds(5));
        var results = await Task.WhenAll(terminals.Select((terminal, index) =>
            host.CommandDispatcher.DispatchAsync(Command(terminal) with
            {
                MessageId = $"message_scale_{index:D2}",
                CommandId = $"command_scale_{index:D2}",
            })));

        Assert.AreEqual(2, creationCounts[0], "Only the injected terminal should restart once.");
        Assert.IsTrue(creationCounts.Skip(1).All(count => count == 1));
        Assert.IsTrue(results.All(result => result.Status == "succeeded"));
        for (var index = 0; index < terminalCount; index++)
        {
            Assert.IsNotNull(stableRuntimes[index]);
            CollectionAssert.AreEqual(
                new[] { $"command_scale_{index:D2}" },
                stableRuntimes[index]!.CommandIds.ToArray(),
                $"Terminal {index} received a command belonging to another terminal.");
        }

        cancellation.Cancel();
        await run;
    }

    [TestMethod]
    public async Task ATerminalThatKeepsRecoveringDoesNotStopAnotherTerminal()
    {
        await using var testStore = await TestStore.CreateAsync();
        var failedTerminal = Terminal("terminal_failed_01", "3001");
        var stableTerminal = Terminal("terminal_stable_01", "3002");
        var failedRetriedPastThreshold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cappedFailureEvents = 0;
        var stableRunning = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failedSupervisor = new TerminalRuntimeSupervisor(
            failedTerminal,
            () => new IsolatedRuntime(failedTerminal, failCollection:true),
            (_, token) => Task.Delay(1, token),
            maximumConsecutiveFailures:2);
        failedSupervisor.StatusChanged += status =>
        {
            if (status.State == TerminalRuntimeState.Restarting
                && status.ConsecutiveFailures == 2
                && Interlocked.Increment(ref cappedFailureEvents) >= 2)
            {
                failedRetriedPastThreshold.TrySetResult();
            }
        };
        var stableRuntime = new IsolatedRuntime(stableTerminal, failCollection:false);
        stableRuntime.Started += () => stableRunning.TrySetResult();
        var stableSupervisor = new TerminalRuntimeSupervisor(stableTerminal, () => stableRuntime);
        await using var host = new BridgeHost(testStore.Store, [failedSupervisor, stableSupervisor]);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var run = host.RunAsync(cancellation.Token);

        await Task.WhenAll(failedRetriedPastThreshold.Task, stableRunning.Task).WaitAsync(TimeSpan.FromSeconds(2));
        var result = await host.CommandDispatcher.DispatchAsync(Command(stableTerminal));

        Assert.AreEqual("succeeded", result.Status);
        Assert.IsTrue(stableSupervisor.IsRunning);
        Assert.IsTrue(cappedFailureEvents >= 2);
        CollectionAssert.AreEqual(
            new[] { Command(stableTerminal).CommandId },
            stableRuntime.CommandIds.ToArray());

        cancellation.Cancel();
        await run;
    }

    private static TerminalDescriptor Terminal(string terminalId, string login) => new()
    {
        TerminalInstanceId = terminalId,
        Platform = "mt5",
        AccountRef = new("Broker-Demo", login),
        ConnectionEpoch = 1,
    };

    private static CommandMessage Command(TerminalDescriptor terminal) => new()
    {
        Type = "command",
        MessageId = "message_host_01",
        SentAtUtcMsc = 1,
        CommandId = "command_host_01",
        TerminalInstanceId = terminal.TerminalInstanceId,
        AccountRef = terminal.AccountRef,
        ConnectionEpoch = terminal.ConnectionEpoch,
        IssuedAtUtcMsc = 1,
        DeadlineUtcMsc = long.MaxValue,
        Action = "query_execution",
        Params = JsonSerializer.SerializeToElement(new { original_command_id = "original_01" }),
    };

    private static QuoteRequestMessage QuoteRequest(TerminalDescriptor terminal) => new()
    {
        Type = "quote_request",
        MessageId = "message_quote_host_01",
        SentAtUtcMsc = 1,
        RequestId = "request_quote_host_01",
        TerminalInstanceId = terminal.TerminalInstanceId,
        AccountRef = terminal.AccountRef,
        ConnectionEpoch = terminal.ConnectionEpoch,
        Symbol = "XAUUSD",
    };

    private sealed class FakeRuntime(TerminalDescriptor terminal) : IBridgeTerminalRuntime
    {
        public TerminalDescriptor Terminal { get; } = terminal;
        public int CommandCount { get; private set; }
        public int QuoteCount { get; private set; }
        public List<string> FullSnapshotRequests { get; } = [];
        public TaskCompletionSource Running { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            Running.TrySetResult();
            return Task.CompletedTask;
        }

        public async Task RunCollectionLoopAsync(CancellationToken cancellationToken = default) =>
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);

        public Task<CommandResultMessage> ExecuteCommandAsync(
            CommandMessage command,
            CancellationToken cancellationToken = default)
        {
            CommandCount++;
            return Task.FromResult(new CommandResultMessage
            {
                Type = "command_result",
                MessageId = "result_host_01",
                SentAtUtcMsc = 2,
                CommandId = command.CommandId,
                TerminalInstanceId = command.TerminalInstanceId,
                AccountRef = command.AccountRef,
                ConnectionEpoch = command.ConnectionEpoch,
                Status = "succeeded",
                CompletedAtUtcMsc = 2,
                Evidence = new() { ObservedAtUtcMsc = 2 },
            });
        }

        public Task<QuoteMessage> GetQuoteAsync(
            QuoteRequestMessage request,
            CancellationToken cancellationToken = default)
        {
            QuoteCount++;
            return Task.FromResult(new QuoteMessage
            {
                Type = "quote",
                MessageId = "result_quote_host_01",
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
        }

        public void RequestFullSnapshot(string stream) => FullSnapshotRequests.Add(stream);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class IsolatedRuntime(
        TerminalDescriptor terminal,
        bool failCollection) : IBridgeTerminalRuntime
    {
        public TerminalDescriptor Terminal { get; } = terminal;
        public ConcurrentQueue<string> CommandIds { get; } = new();
        public event Action? Started;

        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            Started?.Invoke();
            return Task.CompletedTask;
        }

        public async Task RunCollectionLoopAsync(CancellationToken cancellationToken = default)
        {
            if (failCollection)
            {
                throw new IOException("simulated_worker_crash");
            }
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }

        public Task<CommandResultMessage> ExecuteCommandAsync(
            CommandMessage command,
            CancellationToken cancellationToken = default)
        {
            if (command.TerminalInstanceId != Terminal.TerminalInstanceId
                || command.ConnectionEpoch != Terminal.ConnectionEpoch
                || command.AccountRef != Terminal.AccountRef)
            {
                throw new InvalidDataException("cross_terminal_command");
            }
            CommandIds.Enqueue(command.CommandId);
            return Task.FromResult(new CommandResultMessage
            {
                Type = "command_result",
                MessageId = $"result_{command.CommandId}",
                SentAtUtcMsc = 2,
                CommandId = command.CommandId,
                TerminalInstanceId = command.TerminalInstanceId,
                AccountRef = command.AccountRef,
                ConnectionEpoch = command.ConnectionEpoch,
                Status = "succeeded",
                CompletedAtUtcMsc = 2,
                Evidence = new() { ObservedAtUtcMsc = 2 },
            });
        }

        public Task<QuoteMessage> GetQuoteAsync(
            QuoteRequestMessage request,
            CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public void RequestFullSnapshot(string stream)
        {
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
