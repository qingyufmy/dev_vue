using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using AurumBridge.Protocol;

namespace AurumBridge.Workers;

public enum WorkerRequestPriority
{
    Trade,
    Data,
}

public sealed record WorkerRequestTimeouts(TimeSpan Trade, TimeSpan Data)
{
    public static readonly WorkerRequestTimeouts Default = new(
        TimeSpan.FromSeconds(30),
        TimeSpan.FromSeconds(20));

    public void Validate()
    {
        if (Trade <= TimeSpan.Zero || Data <= TimeSpan.Zero
            || Trade > TimeSpan.FromMinutes(2) || Data > TimeSpan.FromMinutes(2))
        {
            throw new ArgumentOutOfRangeException(nameof(WorkerRequestTimeouts));
        }
    }

    public TimeSpan Resolve(WorkerRequestPriority priority) =>
        priority == WorkerRequestPriority.Trade ? Trade : Data;
}

internal static class WorkerRequestExecution
{
    public static async Task<T> RunAsync<T>(
        Func<CancellationToken, Task<T>> operation,
        Func<Task> abort,
        TimeSpan timeout,
        string timeoutErrorCode,
        CancellationToken cancellationToken)
    {
        using var timeoutCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCancellation.CancelAfter(timeout);
        try
        {
            return await operation(timeoutCancellation.Token);
        }
        catch (Exception error)
        {
            try
            {
                await abort();
            }
            catch
            {
                // The original request failure is the authoritative error.
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (error is OperationCanceledException && timeoutCancellation.IsCancellationRequested)
            {
                throw new TimeoutException(timeoutErrorCode, error);
            }
            throw;
        }
    }
}

public interface IMt5WorkerClient : IAsyncDisposable
{
    bool IsConnected { get; }
    JsonElement WorkerHello { get; }
    Task StartAsync(TimeSpan timeout, CancellationToken cancellationToken = default);
    Task<JsonElement> RequestAsync<T>(
        T request,
        WorkerRequestPriority priority,
        CancellationToken cancellationToken = default);
}

public sealed class WorkerRequestGate
{
    private readonly object _sync = new();
    private readonly Queue<Waiter> _trade = new();
    private readonly Queue<Waiter> _data = new();
    private readonly SemaphoreSlim _tradeSlots;
    private readonly SemaphoreSlim _dataSlots;
    private bool _held;

    public WorkerRequestGate(int tradeCapacity = 128, int dataCapacity = 128)
    {
        if (tradeCapacity <= 0 || dataCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(tradeCapacity));
        }
        _tradeSlots = new(tradeCapacity, tradeCapacity);
        _dataSlots = new(dataCapacity, dataCapacity);
    }

    public async ValueTask<IDisposable> EnterAsync(
        WorkerRequestPriority priority,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_sync)
        {
            if (!_held)
            {
                _held = true;
                return new Lease(this);
            }
        }
        var slots = priority == WorkerRequestPriority.Trade ? _tradeSlots : _dataSlots;
        await slots.WaitAsync(cancellationToken);
        Waiter waiter;
        lock (_sync)
        {
            if (!_held)
            {
                _held = true;
                slots.Release();
                return new Lease(this);
            }
            waiter = new(
                new(TaskCreationOptions.RunContinuationsAsynchronously),
                slots);
            (priority == WorkerRequestPriority.Trade ? _trade : _data).Enqueue(waiter);
        }
        return await WaitAsync(waiter.Completion, cancellationToken);
    }

    private static async ValueTask<IDisposable> WaitAsync(
        TaskCompletionSource<IDisposable> waiter,
        CancellationToken cancellationToken)
    {
        using var registration = cancellationToken.Register(
            () => waiter.TrySetCanceled(cancellationToken));
        return await waiter.Task;
    }

    private void Release()
    {
        lock (_sync)
        {
            while (_trade.Count > 0 || _data.Count > 0)
            {
                var queue = _trade.Count > 0 ? _trade : _data;
                var waiter = queue.Dequeue();
                waiter.Slots.Release();
                if (waiter.Completion.TrySetResult(new Lease(this)))
                {
                    return;
                }
            }
            _held = false;
        }
    }

    private sealed record Waiter(
        TaskCompletionSource<IDisposable> Completion,
        SemaphoreSlim Slots);

    private sealed class Lease(WorkerRequestGate owner) : IDisposable
    {
        private WorkerRequestGate? _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Release();
    }
}

public sealed class Mt5WorkerClient : IMt5WorkerClient
{
    private readonly string _pipeName;
    private readonly ProcessStartInfo _startInfo;
    private readonly WorkerRequestGate _requestGate = new();
    private readonly WorkerRequestTimeouts _requestTimeouts;
    private NamedPipeServerStream? _pipe;
    private Process? _process;
    private bool _disposed;

    public Mt5WorkerClient(
        string pipeName,
        ProcessStartInfo startInfo,
        WorkerRequestTimeouts? requestTimeouts = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pipeName);
        _pipeName = pipeName;
        _startInfo = startInfo ?? throw new ArgumentNullException(nameof(startInfo));
        _requestTimeouts = requestTimeouts ?? WorkerRequestTimeouts.Default;
        _requestTimeouts.Validate();
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
        WorkerRequestPriority priority,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_pipe?.IsConnected != true || _process?.HasExited != false)
        {
            throw new InvalidOperationException("worker_not_connected");
        }
        using var lease = await _requestGate.EnterAsync(priority, cancellationToken);
        return await WorkerRequestExecution.RunAsync(
            async requestCancellation =>
            {
                var pipe = _pipe ?? throw new InvalidOperationException("worker_not_connected");
                await WorkerPipeProtocol.WriteAsync(pipe, request, requestCancellation);
                using var response = await WorkerPipeProtocol.ReadAsync(pipe, requestCancellation);
                return response.RootElement.Clone();
            },
            AbortAsync,
            _requestTimeouts.Resolve(priority),
            "mt5_worker_request_timeout",
            cancellationToken);
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
        using (await _requestGate.EnterAsync(WorkerRequestPriority.Trade))
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

    private async Task AbortAsync()
    {
        var pipe = _pipe;
        _pipe = null;
        try
        {
            pipe?.Dispose();
        }
        catch
        {
        }

        var process = _process;
        _process = null;
        if (process is null)
        {
            return;
        }
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
        finally
        {
            process.Dispose();
        }
    }
}
