using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using AurumBridge.Protocol;

namespace AurumBridge.Workers;

public interface IMt5WorkerClient : IAsyncDisposable
{
    bool IsConnected { get; }
    JsonElement WorkerHello { get; }
    Task StartAsync(TimeSpan timeout, CancellationToken cancellationToken = default);
    Task<JsonElement> RequestAsync<T>(T request, CancellationToken cancellationToken = default);
}

public sealed class Mt5WorkerClient : IMt5WorkerClient
{
    private readonly string _pipeName;
    private readonly ProcessStartInfo _startInfo;
    private readonly SemaphoreSlim _requestLock = new(1, 1);
    private NamedPipeServerStream? _pipe;
    private Process? _process;
    private bool _disposed;

    public Mt5WorkerClient(string pipeName, ProcessStartInfo startInfo)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
        _pipeName = pipeName;
        _startInfo = startInfo ?? throw new ArgumentNullException(nameof(startInfo));
    }

    public JsonElement WorkerHello { get; private set; }
    public bool IsConnected => _pipe?.IsConnected == true && _process?.HasExited == false;

    public async Task StartAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_pipe is not null)
        {
            throw new InvalidOperationException("Worker client has already been started.");
        }
        _pipe = new NamedPipeServerStream(
            _pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        _process = Process.Start(_startInfo) ?? throw new InvalidOperationException("worker_process_start_failed");
        using var timeoutCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCancellation.CancelAfter(timeout);
        try
        {
            await _pipe.WaitForConnectionAsync(timeoutCancellation.Token);
            using var hello = await WorkerPipeProtocol.ReadAsync(_pipe, timeoutCancellation.Token);
            var root = hello.RootElement;
            if (!root.TryGetProperty("v", out var version) || version.GetInt32() != 3
                || !root.TryGetProperty("type", out var type) || type.GetString() != "worker_hello")
            {
                throw new InvalidDataException("worker_hello_invalid");
            }
            WorkerHello = root.Clone();
        }
        catch
        {
            await StopProcessAsync();
            throw;
        }
    }

    public async Task<JsonElement> RequestAsync<T>(
        T request,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_pipe?.IsConnected != true || _process?.HasExited != false)
        {
            throw new InvalidOperationException("worker_not_connected");
        }
        await _requestLock.WaitAsync(cancellationToken);
        try
        {
            await WorkerPipeProtocol.WriteAsync(_pipe, request, cancellationToken);
            using var response = await WorkerPipeProtocol.ReadAsync(_pipe, cancellationToken);
            return response.RootElement.Clone();
        }
        finally
        {
            _requestLock.Release();
        }
    }

    public static ProcessStartInfo BuildStartInfo(
        string pythonExecutable,
        string workerScript,
        string pipeName,
        string terminalPath,
        TerminalDescriptor terminal)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = pythonExecutable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var argument in new[]
        {
            workerScript,
            "--pipe", pipeName,
            "--terminal", terminalPath,
            "--terminal-id", terminal.TerminalInstanceId,
            "--broker-server", terminal.AccountRef.BrokerServer,
            "--login", terminal.AccountRef.Login,
            "--connection-epoch", terminal.ConnectionEpoch.ToString(System.Globalization.CultureInfo.InvariantCulture),
        })
        {
            startInfo.ArgumentList.Add(argument);
        }
        return startInfo;
    }

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
            if (_pipe?.IsConnected == true)
            {
                try
                {
                    await WorkerPipeProtocol.WriteAsync(_pipe, new { v = 3, type = "shutdown" });
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    using var response = await WorkerPipeProtocol.ReadAsync(_pipe, timeout.Token);
                }
                catch (Exception error) when (error is IOException or OperationCanceledException)
                {
                }
            }
            await StopProcessAsync();
            _pipe?.Dispose();
        }
        finally
        {
            _requestLock.Release();
            _requestLock.Dispose();
        }
    }

    private async Task StopProcessAsync()
    {
        if (_process is null)
        {
            return;
        }
        if (!_process.HasExited)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try
            {
                await _process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync();
            }
        }
        _process.Dispose();
        _process = null;
    }
}
