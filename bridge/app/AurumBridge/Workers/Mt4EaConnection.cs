using System.IO.Pipes;

namespace AurumBridge.Workers;

public interface IMt4EaConnection : IAsyncDisposable
{
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
}

public sealed class Mt4EaConnection : IMt4EaConnection
{
    private readonly NamedPipeServerStream _pipe;
    private readonly SemaphoreSlim _requestLock = new(1, 1);
    private bool _welcomed;
    private bool _disposed;

    private Mt4EaConnection(NamedPipeServerStream pipe, Mt4Hello hello)
    {
        _pipe = pipe;
        Hello = hello;
    }

    public Mt4Hello Hello { get; }
    public bool IsConnected => !_disposed && _pipe.IsConnected;

    public static async Task<Mt4EaConnection> AcceptAsync(
        string pipeName,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
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
            return new(pipe, hello);
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
            cancellationToken);

    public Task<Mt4TradeResult> ExecuteAsync(
        Mt4TradeCommand command,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeCommand(command),
            Mt4PipeProtocol.DecodeCommandResult,
            cancellationToken);

    public Task<Mt4Quote> GetQuoteAsync(
        Mt4QuoteRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeQuoteRequest(request),
            Mt4PipeProtocol.DecodeQuote,
            cancellationToken);

    public Task<Mt4Rates> GetRatesAsync(
        Mt4RatesRequest request,
        CancellationToken cancellationToken = default) =>
        RequestAsync(
            Mt4PipeProtocol.EncodeRatesRequest(request),
            Mt4PipeProtocol.DecodeRates,
            cancellationToken);

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        await _requestLock.WaitAsync();
        try
        {
            if (_pipe.IsConnected)
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
        finally
        {
            _requestLock.Release();
            _requestLock.Dispose();
        }
    }

    private async Task<T> RequestAsync<T>(
        byte[] request,
        Func<ReadOnlySpan<byte>, T> decode,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_welcomed || !_pipe.IsConnected)
        {
            throw new InvalidOperationException("mt4_ea_not_ready");
        }
        await _requestLock.WaitAsync(cancellationToken);
        try
        {
            await Mt4PipeProtocol.WriteFrameAsync(_pipe, request, cancellationToken);
            var response = await Mt4PipeProtocol.ReadFrameAsync(_pipe, cancellationToken);
            return decode(response);
        }
        finally
        {
            _requestLock.Release();
        }
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
