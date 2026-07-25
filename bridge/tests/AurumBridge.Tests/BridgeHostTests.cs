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
}
