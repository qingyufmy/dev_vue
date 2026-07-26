namespace AurumBridge.Runtime;

public sealed class BridgeTerminalExclusiveLease : IDisposable
{
    private readonly FileStream _stream;
    private bool _disposed;

    private BridgeTerminalExclusiveLease(FileStream stream) => _stream = stream;

    public static BridgeTerminalExclusiveLease? TryAcquire(
        string terminalInstanceId,
        string? lockDirectory = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        if (terminalInstanceId.Length > 96
            || terminalInstanceId.Any(character => !char.IsAsciiLetterOrDigit(character)
                && character is not ('-' or '_')))
        {
            throw new ArgumentException("terminal_instance_id_invalid", nameof(terminalInstanceId));
        }
        var directory = Path.GetFullPath(lockDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AURUMBridge",
            "terminal-leases"));
        Directory.CreateDirectory(directory);
        try
        {
            return new(new FileStream(
                Path.Combine(directory, $"{terminalInstanceId}.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None,
                bufferSize:1,
                FileOptions.WriteThrough));
        }
        catch (IOException error) when ((error.HResult & 0xFFFF) is 32 or 33)
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _stream.Dispose();
    }
}
