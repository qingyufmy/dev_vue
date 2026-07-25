using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class WorkerRequestGateTests
{
    [TestMethod]
    public async Task TradeWaitersOvertakeAllQueuedDataAfterTheCurrentCall()
    {
        var gate = new WorkerRequestGate();
        using var currentDataCall = await gate.EnterAsync(WorkerRequestPriority.Data);
        var firstData = gate.EnterAsync(WorkerRequestPriority.Data).AsTask();
        var firstTrade = gate.EnterAsync(WorkerRequestPriority.Trade).AsTask();
        var secondData = gate.EnterAsync(WorkerRequestPriority.Data).AsTask();
        var secondTrade = gate.EnterAsync(WorkerRequestPriority.Trade).AsTask();

        currentDataCall.Dispose();
        using var firstTradeLease = await firstTrade.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.IsFalse(firstData.IsCompleted);
        Assert.IsFalse(secondData.IsCompleted);
        Assert.IsFalse(secondTrade.IsCompleted);

        firstTradeLease.Dispose();
        using var secondTradeLease = await secondTrade.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.IsFalse(firstData.IsCompleted);
        Assert.IsFalse(secondData.IsCompleted);

        secondTradeLease.Dispose();
        using var firstDataLease = await firstData.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.IsFalse(secondData.IsCompleted);
        firstDataLease.Dispose();
        using var secondDataLease = await secondData.WaitAsync(TimeSpan.FromSeconds(1));
    }

    [TestMethod]
    public async Task CancelledWaiterDoesNotBlockTheNextTrade()
    {
        var gate = new WorkerRequestGate();
        using var current = await gate.EnterAsync(WorkerRequestPriority.Data);
        using var cancellation = new CancellationTokenSource();
        var cancelled = gate.EnterAsync(WorkerRequestPriority.Trade, cancellation.Token).AsTask();
        var next = gate.EnterAsync(WorkerRequestPriority.Trade).AsTask();
        cancellation.Cancel();

        current.Dispose();

        await Assert.ThrowsExactlyAsync<TaskCanceledException>(async () => await cancelled);
        using var nextLease = await next.WaitAsync(TimeSpan.FromSeconds(1));
    }

    [TestMethod]
    public async Task AFullWaitQueueAppliesBackpressureWithoutDroppingRequests()
    {
        var gate = new WorkerRequestGate(tradeCapacity:1, dataCapacity:1);
        var current = await gate.EnterAsync(WorkerRequestPriority.Data);
        var firstWaiting = gate.EnterAsync(WorkerRequestPriority.Data).AsTask();
        var capacityBlocked = gate.EnterAsync(WorkerRequestPriority.Data).AsTask();

        Assert.IsFalse(firstWaiting.IsCompleted);
        Assert.IsFalse(capacityBlocked.IsCompleted);

        current.Dispose();
        var firstLease = await firstWaiting.WaitAsync(TimeSpan.FromSeconds(1));
        Assert.IsFalse(capacityBlocked.IsCompleted);

        firstLease.Dispose();
        using var finalLease = await capacityBlocked.WaitAsync(TimeSpan.FromSeconds(1));
    }
}
