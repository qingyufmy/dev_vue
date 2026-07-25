using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class PriorityMessageQueueTests
{
    [TestMethod]
    public async Task TradeMessagesOvertakeQueuedDataMessages()
    {
        var queue = new PriorityMessageQueue();
        await queue.EnqueueAsync(new("data_00000001", "data", BridgeMessagePriority.Data));
        await queue.EnqueueAsync(new("trade_0000001", "trade", BridgeMessagePriority.Trade));

        Assert.AreEqual("trade_0000001", (await queue.DequeueAsync()).MessageId);
        Assert.AreEqual("data_00000001", (await queue.DequeueAsync()).MessageId);
    }

    [TestMethod]
    public async Task WaitingReaderReceivesTheFirstAvailableMessage()
    {
        var queue = new PriorityMessageQueue();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var pending = queue.DequeueAsync(timeout.Token).AsTask();

        await queue.EnqueueAsync(new("trade_0000002", "trade", BridgeMessagePriority.Trade));

        Assert.AreEqual("trade_0000002", (await pending).MessageId);
    }
}
