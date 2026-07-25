using System.Collections.Concurrent;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class TerminalRuntimeSupervisorTests
{
    [TestMethod]
    public async Task RestartsFailedRuntimeWithBoundedBackoff()
    {
        var created = new ConcurrentQueue<FakeRuntime>();
        var delays = new List<TimeSpan>();
        var finalRuntimeRunning = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var creationCount = 0;
        var supervisor = new TerminalRuntimeSupervisor(
            Terminal(),
            () =>
            {
                var runtimeNumber = Interlocked.Increment(ref creationCount);
                var runtime = new FakeRuntime(Terminal(), failCollection: runtimeNumber <= 7);
                created.Enqueue(runtime);
                if (runtimeNumber == 8)
                {
                    runtime.Started += () => finalRuntimeRunning.TrySetResult();
                }
                return runtime;
            },
            (delay, _) =>
            {
                delays.Add(delay);
                return Task.CompletedTask;
            });
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var run = supervisor.RunAsync(cancellation.Token);

        await finalRuntimeRunning.Task.WaitAsync(TimeSpan.FromSeconds(2));
        cancellation.Cancel();
        await run;

        CollectionAssert.AreEqual(
            new[] { 1, 2, 4, 8, 10, 10, 10 },
            delays.Select(delay => (int)delay.TotalSeconds).ToArray());
        Assert.IsTrue(created.First().Disposed);
    }

    [TestMethod]
    public async Task RoutesCommandAndFullSnapshotOnlyWhileRuntimeIsAvailable()
    {
        var runtime = new FakeRuntime(Terminal());
        var supervisor = new TerminalRuntimeSupervisor(
            Terminal(),
            () => runtime,
            (_, _) => Task.CompletedTask);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var run = supervisor.RunAsync(cancellation.Token);
        await runtime.Running.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var command = Command();
        var result = await supervisor.ExecuteCommandAsync(command);
        var quote = await supervisor.GetQuoteAsync(QuoteRequest());
        Assert.AreEqual(command.CommandId, result.CommandId);
        Assert.AreEqual("succeeded", quote.Status);
        Assert.IsTrue(supervisor.RequestFullSnapshot("positions", Terminal().ConnectionEpoch));
        Assert.HasCount(1, runtime.FullSnapshotRequests);
        Assert.IsFalse(supervisor.RequestFullSnapshot("orders", Terminal().ConnectionEpoch + 1));

        cancellation.Cancel();
        await run;
        Assert.IsFalse(supervisor.IsRunning);
    }

    private static TerminalDescriptor Terminal() => new()
    {
        TerminalInstanceId = "terminal_supervisor_01",
        Platform = "mt5",
        AccountRef = new("Broker-Demo", "12345678"),
        ConnectionEpoch = 9,
    };

    private static CommandMessage Command() => new()
    {
        Type = "command",
        MessageId = "message_supervisor_01",
        SentAtUtcMsc = 1,
        CommandId = "command_supervisor_01",
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = Terminal().ConnectionEpoch,
        IssuedAtUtcMsc = 1,
        DeadlineUtcMsc = long.MaxValue,
        Action = "query_execution",
        Params = JsonSerializer.SerializeToElement(new { original_command_id = "original_01" }),
    };

    private static QuoteRequestMessage QuoteRequest() => new()
    {
        Type = "quote_request",
        MessageId = "message_quote_supervisor_01",
        SentAtUtcMsc = 1,
        RequestId = "request_quote_supervisor_01",
        TerminalInstanceId = Terminal().TerminalInstanceId,
        AccountRef = Terminal().AccountRef,
        ConnectionEpoch = Terminal().ConnectionEpoch,
        Symbol = "XAUUSD",
    };

    private sealed class FakeRuntime : IBridgeTerminalRuntime
    {
        private readonly bool _failCollection;
        public FakeRuntime(TerminalDescriptor terminal, bool failCollection = false)
        {
            Terminal = terminal;
            _failCollection = failCollection;
        }

        public TerminalDescriptor Terminal { get; }
        public bool Disposed { get; private set; }
        public List<string> FullSnapshotRequests { get; } = [];
        public TaskCompletionSource Running { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public event Action? Started;

        public Task StartAsync(CancellationToken cancellationToken = default)
        {
            Running.TrySetResult();
            Started?.Invoke();
            return Task.CompletedTask;
        }

        public Task<CommandResultMessage> ExecuteCommandAsync(
            CommandMessage command,
            CancellationToken cancellationToken = default) => Task.FromResult(new CommandResultMessage
            {
                Type = "command_result",
                MessageId = "result_supervisor_01",
                SentAtUtcMsc = 2,
                CommandId = command.CommandId,
                TerminalInstanceId = command.TerminalInstanceId,
                AccountRef = command.AccountRef,
                ConnectionEpoch = command.ConnectionEpoch,
                Status = "succeeded",
                CompletedAtUtcMsc = 2,
                Evidence = new() { ObservedAtUtcMsc = 2 },
            });

        public Task<QuoteMessage> GetQuoteAsync(
            QuoteRequestMessage request,
            CancellationToken cancellationToken = default) => Task.FromResult(new QuoteMessage
            {
                Type = "quote",
                MessageId = "result_quote_supervisor_01",
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

        public async Task RunCollectionLoopAsync(CancellationToken cancellationToken = default)
        {
            if (_failCollection)
            {
                throw new IOException("test failure");
            }
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }

        public void RequestFullSnapshot(string stream) => FullSnapshotRequests.Add(stream);

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
