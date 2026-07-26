using System.IO.Pipes;

namespace AurumBridge.Workers;

public interface IMt4EaConnection : IAsyncDisposable
{
    bool SupportsDeals { get; }
    bool SupportsExtendedData { get; }
    Task SendWelcomeAsync(Mt4Welcome welcome, CancellationToken cancellationToken = default);
    Task<Mt4Snapshot> CollectAsync(
        Mt4CollectionStreams streams,
        CancellationToken cancellationToken = default);
    Task<Mt4TradeResult> ExecuteAsync(
        Mt4TradeCommand command,
        CancellationToken cancellationToken = default);
    Task<Mt4Quote> GetQuoteAsync(
        Mt4QuoteRequest request,
        CancellationToken cancellationToken = default);
    Task<Mt4Rates> GetRatesAsync(
        Mt4RatesRequest request,
        CancellationToken cancellationToken = default);
    Task<Mt4SymbolSnapshot> GetSymbolSnapshotAsync(
        Mt4SymbolSnapshotRequest request,
        CancellationToken cancellationToken = default);
    Task<Mt4RiskSnapshot> GetRiskSnapshotAsync(
        Mt4RiskSnapshotRequest request,
        CancellationToken cancellationToken = default);
    Task<Mt4PerformanceDaily> GetPerformanceDailyAsync(
        Mt4PerformanceDailyRequest request,
        CancellationToken cancellationToken = default);
    Task<Mt4ExtendedData> GetExtendedDataAsync(
        Mt4ExtendedDataRequest request,
        CancellationToken cancellationToken = default);
    Task<Mt4DealsBatch> CollectDealsAsync(
        Mt4DealsRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class Mt4EaConnection : IMt4EaConnection
{
    private readonly NamedPipeServerStream _pipe;
    private readonly WorkerRequestGate _requestGate = new();
    private readonly WorkerRequestTimeouts _requestTimeouts;
    private bool _welcomed;
    private bool _faulted;
    private bool _disposed;

    private Mt4EaConnection(
        NamedPipeServerStream pipe,
        Mt4Hello hello,
        WorkerRequestTimeouts requestTimeouts)
    {
        _pipe = pipe;
        Hello = hello;
        _requestTimeouts = requestTimeouts;
    }

    public Mt4Hello Hello { get; }
    public bool IsConnected => !_disposed && !_faulted && _pipe.IsConnected;
    public bool SupportsDeals => SupportsDealsAdapter(Hello.AdapterVersion);
    public bool SupportsExtendedData => SupportsExtendedDataAdapter(Hello.AdapterVersion);

    public static bool SupportsDealsAdapter(string adapterVersion)
    {
        var stableVersion = adapterVersion?.Split('-', 2)[0];
        return Version.TryParse(stableVersion, out var version)
            && version >= new Version(3, 1, 0);
    }

    public static bool SupportsExtendedDataAdapter(string adapterVersion)
    {
        var stableVersion = adapterVersion?.Split('-', 2)[0];
        return Version.TryParse(stableVersion, out var version)
            && version >= new Version(3, 2, 0);
    }

    public static async Task<Mt4EaConnection> AcceptAsync(
        string pipeName,
        TimeSpan timeout,
        CancellationToken cancellationToken = default,
        WorkerRequestTimeouts? requestTimeouts = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
        requestTimeouts ??= WorkerRequestTimeouts.Default;
        requestTimeouts.Validate();
        using var timeoutCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCancellation.CancelAfter(timeout);
        var pipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            32,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await pipe.WaitForConnectionAsync(timeoutCancellation.Token);
            var payload = await Mt4PipeProtocol.ReadFrameAsync(pipe, timeoutCancellation.Token);
            var hello = Mt4PipeProtocol.DecodeHello(payload);
            return new(pipe, hello, requestTimeouts);
        }
        catch
        {
            await pipe.DisposeAsync();
            cancellationToken.ThrowIfCancellationRequested();
            if (timeoutCancellation.IsCancellationRequested)
            {
                throw new TimeoutException("mt4_ea_accept_timeout");
            }
            throw;
        }
    }

    public async Task SendWelcomeAsync(
        Mt4Welcome welcome,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_welcomed)
        {
            throw new InvalidOperationException("mt4_ea_already_welcomed");
        }
        await Mt4PipeProtocol.WriteFrameAsync(
            _pipe,
            Mt4PipeProtocol.EncodeWelcome(welcome),
            cancellationToken);
        _welcomed = true;
    }

    public Task<Mt4Snapshot> CollectAsync(
        Mt4CollectionStreams streams,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeCollect(streams),
            Mt4PipeProtocol.DecodeSnapshot,
            WorkerRequestPriority.Data,
            cancellationToken);

    public Task<Mt4TradeResult> ExecuteAsync(
        Mt4TradeCommand command,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeCommand(command),
            Mt4PipeProtocol.DecodeCommandResult,
            WorkerRequestPriority.Trade,
            cancellationToken);

    public Task<Mt4Quote> GetQuoteAsync(
        Mt4QuoteRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeQuoteRequest(request),
            Mt4PipeProtocol.DecodeQuote,
            WorkerRequestPriority.Trade,
            cancellationToken);

    public Task<Mt4Rates> GetRatesAsync(
        Mt4RatesRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeRatesRequest(request),
            Mt4PipeProtocol.DecodeRates,
            WorkerRequestPriority.Data,
            cancellationToken);

    public Task<Mt4SymbolSnapshot> GetSymbolSnapshotAsync(
        Mt4SymbolSnapshotRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeSymbolSnapshotRequest(request),
            Mt4PipeProtocol.DecodeSymbolSnapshot,
            WorkerRequestPriority.Data,
            cancellationToken);

    public Task<Mt4RiskSnapshot> GetRiskSnapshotAsync(
        Mt4RiskSnapshotRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(Mt4PipeProtocol.EncodeRiskSnapshotRequest(request),
            Mt4PipeProtocol.DecodeRiskSnapshot, WorkerRequestPriority.Data, cancellationToken);

    public Task<Mt4PerformanceDaily> GetPerformanceDailyAsync(
        Mt4PerformanceDailyRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(Mt4PipeProtocol.EncodePerformanceDailyRequest(request),
            Mt4PipeProtocol.DecodePerformanceDaily, WorkerRequestPriority.Data, cancellationToken);

    public Task<Mt4ExtendedData> GetExtendedDataAsync(
        Mt4ExtendedDataRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(Mt4PipeProtocol.EncodeExtendedDataRequest(request),
            Mt4PipeProtocol.DecodeExtendedData, WorkerRequestPriority.Data, cancellationToken);

    public Task<Mt4DealsBatch> CollectDealsAsync(
        Mt4DealsRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(Mt4PipeProtocol.EncodeDealsRequest(request),
            Mt4PipeProtocol.DecodeDeals, WorkerRequestPriority.Data, cancellationToken);

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        using (await _requestGate.EnterAsync(WorkerRequestPriority.Trade))
        {
            if (!_faulted && _pipe.IsConnected)
            {
                try
                {
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await Mt4PipeProtocol.WriteFrameAsync(
                        _pipe,
                        EncodeMessageType(Mt4MessageType.Shutdown),
                        timeout.Token);
                    var response = await Mt4PipeProtocol.ReadFrameAsync(_pipe, timeout.Token);
                    EnsureMessageType(response, Mt4MessageType.ShutdownAck);
                }
                catch (Exception error) when (error is IOException or OperationCanceledException)
                {
                }
            }
            await _pipe.DisposeAsync();
        }
    }

    private async Task<T> RequestAsync<T>(
        byte[] request,
        Func<ReadOnlySpan<byte>, T> decode,
        WorkerRequestPriority priority,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_welcomed || !_pipe.IsConnected)
        {
            throw new InvalidOperationException("mt4_ea_not_ready");
        }
        using var lease = await _requestGate.EnterAsync(priority, cancellationToken);
        return await WorkerRequestExecution.RunAsync(
            async requestCancellation =>
            {
                await Mt4PipeProtocol.WriteFrameAsync(_pipe, request, requestCancellation);
                var response = await Mt4PipeProtocol.ReadFrameAsync(_pipe, requestCancellation);
                return decode(response);
            },
            AbortAsync,
            _requestTimeouts.Resolve(priority),
            "mt4_ea_request_timeout",
            cancellationToken);
    }

    private Task AbortAsync()
    {
        _faulted = true;
        _pipe.Dispose();
        return Task.CompletedTask;
    }

    private static byte[] EncodeMessageType(Mt4MessageType messageType)
    {
        var payload = new byte[sizeof(int)];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(payload, (int)messageType);
        return payload;
    }

    private static void EnsureMessageType(ReadOnlySpan<byte> payload, Mt4MessageType expected)
    {
        if (payload.Length != sizeof(int)
            || System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(payload) != (int)expected)
        {
            throw new InvalidDataException("mt4_pipe_message_type_invalid");
        }
    }
}
