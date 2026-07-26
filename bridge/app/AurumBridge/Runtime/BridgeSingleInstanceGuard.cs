namespace AurumBridge.Runtime;

public sealed class BridgeSingleInstanceGuard : IDisposable
{
    private readonly FileStream _lockStream;
    private readonly EventWaitHandle _activationEvent;
    private readonly EventWaitHandle _shutdownEvent;
    private RegisteredWaitHandle? _activationWait;
    private RegisteredWaitHandle? _shutdownWait;
    private bool _disposed;

    private BridgeSingleInstanceGuard(
        FileStream lockStream,
        EventWaitHandle activationEvent,
        EventWaitHandle shutdownEvent)
    {
        _lockStream = lockStream;
        _activationEvent = activationEvent;
        _shutdownEvent = shutdownEvent;
    }

    public event Action? ActivationRequested;
    public event Action? ShutdownRequested;

    public static BridgeSingleInstanceGuard? TryAcquire(
        string instanceId,
        string? lockDirectory = null)
    {
        ValidateInstanceId(instanceId);
        var directory = Path.GetFullPath(lockDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AURUMBridge",
            "locks"));
        Directory.CreateDirectory(directory);
        var activationEvent = new EventWaitHandle(
            initialState:false,
            EventResetMode.AutoReset,
            $"Local\\{instanceId}.activate");
        var shutdownEvent = new EventWaitHandle(
            initialState:false,
            EventResetMode.AutoReset,
            $"Local\\{instanceId}.shutdown");
        try
        {
            var lockPath = Path.Combine(directory, $"{instanceId}.lock");
            var lockStream = new FileStream(
                lockPath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                bufferSize:1,
                FileOptions.WriteThrough);
            return new(lockStream, activationEvent, shutdownEvent);
        }
        catch (IOException error) when ((error.HResult & 0xFFFF) is 32 or 33)
        {
            activationEvent.Set();
            activationEvent.Dispose();
            shutdownEvent.Dispose();
            return null;
        }
        catch
        {
            activationEvent.Dispose();
            shutdownEvent.Dispose();
            throw;
        }
    }

    public static void RequestShutdown(string instanceId)
    {
        ValidateInstanceId(instanceId);
        using var shutdownEvent = new EventWaitHandle(
            initialState:false,
            EventResetMode.AutoReset,
            $"Local\\{instanceId}.shutdown");
        shutdownEvent.Set();
    }

    public void StartActivationListener()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_activationWait is not null)
        {
            return;
        }
        _activationWait = ThreadPool.RegisterWaitForSingleObject(
            _activationEvent,
            (_, timedOut) =>
            {
                if (!timedOut && !_disposed)
                {
                    ActivationRequested?.Invoke();
                }
            },
            state:null,
            Timeout.InfiniteTimeSpan,
            executeOnlyOnce:false);
        _shutdownWait = ThreadPool.RegisterWaitForSingleObject(
            _shutdownEvent,
            (_, timedOut) =>
            {
                if (!timedOut && !_disposed)
                {
                    ShutdownRequested?.Invoke();
                }
            },
            state:null,
            Timeout.InfiniteTimeSpan,
            executeOnlyOnce:false);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _activationWait?.Unregister(waitObject:null);
        _shutdownWait?.Unregister(waitObject:null);
        _activationEvent.Dispose();
        _shutdownEvent.Dispose();
        _lockStream.Dispose();
    }

    private static void ValidateInstanceId(string instanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        if (instanceId.Length > 96
            || instanceId.Any(character => !char.IsAsciiLetterOrDigit(character)
                && character is not ('.' or '-' or '_')))
        {
            throw new ArgumentException("bridge_instance_id_invalid", nameof(instanceId));
        }
    }
}
