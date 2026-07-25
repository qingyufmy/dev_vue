using System.Text.Json;

namespace AurumBridge.Runtime;

public static class BridgeStartupSignal
{
    public static async Task WriteAsync(
        string signalPath,
        string version,
        Func<long>? clock = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(signalPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);
        if (!Path.IsPathFullyQualified(signalPath) || !Version.TryParse(version, out _))
        {
            throw new ArgumentException("bridge_startup_signal_invalid");
        }
        var path = Path.GetFullPath(signalPath);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, new
                {
                    ready = true,
                    version,
                    ready_at_utc_msc = (clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))(),
                }, cancellationToken:cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, path, overwrite:true);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }
}
