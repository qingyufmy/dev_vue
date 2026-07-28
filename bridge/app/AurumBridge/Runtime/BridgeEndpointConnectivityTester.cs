using System.Net.Sockets;

namespace AurumBridge.Runtime;

public sealed record BridgeEndpointConnectivityResult(
    bool ControlReachable,
    bool RealtimeReachable,
    string Description)
{
    public bool Success => ControlReachable && RealtimeReachable;
}

public sealed class BridgeEndpointConnectivityTester
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(8);
    private readonly Func<Uri, CancellationToken, Task> _testControl;
    private readonly Func<Uri, CancellationToken, Task> _testRealtime;

    public BridgeEndpointConnectivityTester()
        : this(TestControlAsync, TestRealtimeAsync)
    {
    }

    internal BridgeEndpointConnectivityTester(
        Func<Uri, CancellationToken, Task> testControl,
        Func<Uri, CancellationToken, Task> testRealtime)
    {
        _testControl = testControl ?? throw new ArgumentNullException(nameof(testControl));
        _testRealtime = testRealtime ?? throw new ArgumentNullException(nameof(testRealtime));
    }

    public async Task<BridgeEndpointConnectivityResult> TestAsync(
        BridgeEndpointConfiguration configuration,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(Timeout);
        var control = CaptureAsync(
            () => _testControl(configuration.ControlBaseUri, deadline.Token),
            cancellationToken);
        var realtime = CaptureAsync(
            () => _testRealtime(configuration.RealtimeBaseUri, deadline.Token),
            cancellationToken);
        var results = await Task.WhenAll(control, realtime);
        var controlReachable = results[0];
        var realtimeReachable = results[1];
        var description = controlReachable && realtimeReachable
            ? "控制服务正常，实时通道端口可达。"
            : !controlReachable && !realtimeReachable
                ? "控制服务和实时通道端口均无法连接，请检查地址或网络。"
                : controlReachable
                    ? "控制服务正常，但实时通道端口无法连接。"
                    : "实时通道端口可达，但控制服务健康检查失败。";
        return new(controlReachable, realtimeReachable, description);
    }

    private static async Task<bool> CaptureAsync(
        Func<Task> operation,
        CancellationToken cancellationToken)
    {
        try
        {
            await operation();
            return true;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception error) when (error is HttpRequestException
            or IOException
            or SocketException
            or TaskCanceledException)
        {
            return false;
        }
    }

    private static async Task TestControlAsync(
        Uri controlBaseUri,
        CancellationToken cancellationToken)
    {
        using var http = new HttpClient { Timeout = Timeout };
        using var response = await http.GetAsync(new Uri(controlBaseUri, "/health"), cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    private static async Task TestRealtimeAsync(
        Uri realtimeBaseUri,
        CancellationToken cancellationToken)
    {
        var port = realtimeBaseUri.IsDefaultPort
            ? realtimeBaseUri.Scheme == "wss" ? 443 : 80
            : realtimeBaseUri.Port;
        using var client = new TcpClient();
        await client.ConnectAsync(realtimeBaseUri.Host, port, cancellationToken);
    }
}
