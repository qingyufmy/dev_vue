using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4TerminalRuntimeTests
{
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
            return Task.FromResult(new Mt4TradeResult(
                command.CommandId,
                "succeeded",
                null,
                null,
                0,
                command.Ticket,
                1_800_000_000_050));
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

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
