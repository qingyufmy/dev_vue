using System.Text.Json;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeInboundRequestDispatcherTests
{
    [TestMethod]
    public async Task BlockedDataRequestDoesNotDelayLaterTradeCommand()
    {
        var dataStarted = Signal();
        var releaseData = Signal();
        var tradeReceived = Signal();
        await using var dispatcher = new BridgeInboundRequestDispatcher(async (payload, cancellationToken) =>
        {
            var type = MessageType(payload);
            if (type == "data_request")
            {
                dataStarted.TrySetResult();
                await releaseData.Task.WaitAsync(cancellationToken);
            }
            else if (type == "command")
            {
                tradeReceived.TrySetResult();
            }
        });

        await dispatcher.RouteAsync(Message("data_request"));
        await dataStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await dispatcher.RouteAsync(Message("command"));

        await tradeReceived.Task.WaitAsync(TimeSpan.FromSeconds(2));
        releaseData.TrySetResult();
    }

    [TestMethod]
    public async Task TradeCommandsPreserveReceiveOrder()
    {
        var firstStarted = Signal();
        var releaseFirst = Signal();
        var secondStarted = Signal();
        var calls = 0;
        await using var dispatcher = new BridgeInboundRequestDispatcher(async (_, cancellationToken) =>
        {
            if (Interlocked.Increment(ref calls) == 1)
            {
                firstStarted.TrySetResult();
                await releaseFirst.Task.WaitAsync(cancellationToken);
                return;
            }
            secondStarted.TrySetResult();
        });

        await dispatcher.RouteAsync(Message("command", "first", "terminal_a"));
        await firstStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await dispatcher.RouteAsync(Message("command", "second", "terminal_a"));

        await Assert.ThrowsExactlyAsync<TimeoutException>(
            () => secondStarted.Task.WaitAsync(TimeSpan.FromMilliseconds(100)));
        releaseFirst.TrySetResult();
        await secondStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    [TestMethod]
    public async Task CommandsForDifferentTerminalsRunIndependently()
    {
        var firstStarted = Signal();
        var releaseFirst = Signal();
        var secondStarted = Signal();
        await using var dispatcher = new BridgeInboundRequestDispatcher(async (payload, cancellationToken) =>
        {
            using var document = JsonDocument.Parse(payload);
            var terminal = document.RootElement.GetProperty("terminal_instance_id").GetString();
            if (terminal == "terminal_a")
            {
                firstStarted.TrySetResult();
                await releaseFirst.Task.WaitAsync(cancellationToken);
                return;
            }
            secondStarted.TrySetResult();
        });

        await dispatcher.RouteAsync(Message("command", "first", "terminal_a"));
        await firstStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await dispatcher.RouteAsync(Message("command", "second", "terminal_b"));

        await secondStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        releaseFirst.TrySetResult();
    }

    [TestMethod]
    public async Task DataCapacityCountsRequestsAlreadyExecuting()
    {
        var firstStarted = Signal();
        var releaseFirst = Signal();
        await using var dispatcher = new BridgeInboundRequestDispatcher(
            async (_, cancellationToken) =>
            {
                firstStarted.TrySetResult();
                await releaseFirst.Task.WaitAsync(cancellationToken);
            },
            dataCapacity:1);

        await dispatcher.RouteAsync(Message("data_request", "first"));
        await firstStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            dispatcher.RouteAsync(Message("quote_request", "second")).AsTask());
        Assert.AreEqual("bridge_inbound_data_capacity_exceeded", error.Message);
        releaseFirst.TrySetResult();
    }

    [TestMethod]
    public async Task TradeCapacityCountsRequestsAlreadyExecuting()
    {
        var firstStarted = Signal();
        var releaseFirst = Signal();
        await using var dispatcher = new BridgeInboundRequestDispatcher(
            async (_, cancellationToken) =>
            {
                firstStarted.TrySetResult();
                await releaseFirst.Task.WaitAsync(cancellationToken);
            },
            tradeCapacity:1);

        await dispatcher.RouteAsync(Message("command", "first", "terminal_a"));
        await firstStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));

        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            dispatcher.RouteAsync(Message("command", "second", "terminal_b")).AsTask());
        Assert.AreEqual("bridge_inbound_trade_capacity_exceeded", error.Message);
        releaseFirst.TrySetResult();
    }

    [TestMethod]
    public async Task ControlMessagesRemainInline()
    {
        var releaseControl = Signal();
        await using var dispatcher = new BridgeInboundRequestDispatcher(
            (_, cancellationToken) => releaseControl.Task.WaitAsync(cancellationToken));

        var routing = dispatcher.RouteAsync(Message("data_ack")).AsTask();

        await Assert.ThrowsExactlyAsync<TimeoutException>(
            () => routing.WaitAsync(TimeSpan.FromMilliseconds(100)));
        releaseControl.TrySetResult();
        await routing;
    }

    [TestMethod]
    public async Task RequestWorkerFailureIsExposedToReceiveLoop()
    {
        await using var dispatcher = new BridgeInboundRequestDispatcher(
            (_, _) => throw new InvalidDataException("route_failed"));

        await dispatcher.RouteAsync(Message("data_request"));

        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(
            () => dispatcher.Faulted.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.AreEqual("route_failed", error.Message);
    }

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static string Message(
        string type,
        string id = "message",
        string? terminalInstanceId = null) =>
        JsonSerializer.Serialize(new
        {
            v = 3,
            type,
            message_id = id,
            terminal_instance_id = terminalInstanceId,
        });

    private static string? MessageType(string payload)
    {
        using var document = JsonDocument.Parse(payload);
        return document.RootElement.GetProperty("type").GetString();
    }
}
