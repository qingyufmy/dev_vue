using System.Net.WebSockets;

namespace AurumBridge.Runtime;

public static class BridgeSessionLoopMonitor
{
    public static async Task RunAsync(
        Task receiveTask,
        Task sendTask,
        Task outboxTask,
        Task heartbeatTask,
        CancellationTokenSource sessionCancellation)
    {
        ArgumentNullException.ThrowIfNull(receiveTask);
        ArgumentNullException.ThrowIfNull(sendTask);
        ArgumentNullException.ThrowIfNull(outboxTask);
        ArgumentNullException.ThrowIfNull(heartbeatTask);
        ArgumentNullException.ThrowIfNull(sessionCancellation);

        var loops = new[] { receiveTask, sendTask, outboxTask, heartbeatTask };
        var completed = await Task.WhenAny(loops);
        try
        {
            await completed;
            if (completed != receiveTask && !sessionCancellation.IsCancellationRequested)
            {
                throw new WebSocketException("bridge_session_loop_stopped");
            }
        }
        finally
        {
            await sessionCancellation.CancelAsync();
            foreach (var loop in loops)
            {
                if (loop == completed)
                {
                    continue;
                }
                await ObserveAfterCancellationAsync(loop);
            }
        }
    }

    private static async Task ObserveAfterCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch
        {
        }
    }
}
