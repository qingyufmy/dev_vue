using System.Net.WebSockets;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeSessionLoopMonitorTests
{
    [TestMethod]
    public async Task OutboxFailureCancelsSessionAndPropagatesOriginalError()
    {
        using var cancellation = new CancellationTokenSource();
        var expected = new IOException("outbox_failed");
        var receive = WaitForCancellation(cancellation.Token);
        var send = WaitForCancellation(cancellation.Token);
        var heartbeat = WaitForCancellation(cancellation.Token);

        var actual = await Assert.ThrowsExactlyAsync<IOException>(() =>
            BridgeSessionLoopMonitor.RunAsync(
                receive,
                send,
                Task.FromException(expected),
                heartbeat,
                cancellation));

        Assert.AreSame(expected, actual);
        Assert.IsTrue(cancellation.IsCancellationRequested);
        await Task.WhenAll(Observe(receive), Observe(send), Observe(heartbeat));
    }

    [TestMethod]
    public async Task UnexpectedCleanSendStopForcesReconnect()
    {
        using var cancellation = new CancellationTokenSource();
        var receive = WaitForCancellation(cancellation.Token);
        var outbox = WaitForCancellation(cancellation.Token);
        var heartbeat = WaitForCancellation(cancellation.Token);

        var error = await Assert.ThrowsExactlyAsync<WebSocketException>(() =>
            BridgeSessionLoopMonitor.RunAsync(
                receive,
                Task.CompletedTask,
                outbox,
                heartbeat,
                cancellation));

        Assert.AreEqual("bridge_session_loop_stopped", error.Message);
        Assert.IsTrue(cancellation.IsCancellationRequested);
    }

    [TestMethod]
    public async Task CleanReceiveCloseStopsAllOtherLoops()
    {
        using var cancellation = new CancellationTokenSource();
        var send = WaitForCancellation(cancellation.Token);
        var outbox = WaitForCancellation(cancellation.Token);
        var heartbeat = WaitForCancellation(cancellation.Token);

        await BridgeSessionLoopMonitor.RunAsync(
            Task.CompletedTask,
            send,
            outbox,
            heartbeat,
            cancellation);

        Assert.IsTrue(cancellation.IsCancellationRequested);
        await Task.WhenAll(Observe(send), Observe(outbox), Observe(heartbeat));
    }

    private static Task WaitForCancellation(CancellationToken cancellationToken) =>
        Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);

    private static async Task Observe(Task task)
    {
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
    }
}
