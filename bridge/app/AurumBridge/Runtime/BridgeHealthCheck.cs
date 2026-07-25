using System.Text.Json;
using AurumBridge.Storage;

namespace AurumBridge.Runtime;

public static class BridgeHealthCheck
{
    public static async Task RunAsync(
        BridgeRuntimePaths paths,
        string healthFile,
        string allowedHealthDirectory,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentException.ThrowIfNullOrWhiteSpace(healthFile);
        ArgumentException.ThrowIfNullOrWhiteSpace(allowedHealthDirectory);
        if (!File.Exists(paths.PythonExecutable) || !File.Exists(paths.Mt5WorkerScript))
        {
            throw new FileNotFoundException("bridge_runtime_component_missing");
        }
        var allowedRoot = Path.GetFullPath(allowedHealthDirectory);
        Directory.CreateDirectory(allowedRoot);
        var output = Path.GetFullPath(healthFile);
        var prefix = allowedRoot.EndsWith(Path.DirectorySeparatorChar)
            ? allowedRoot
            : allowedRoot + Path.DirectorySeparatorChar;
        if (!output.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(output).StartsWith("health-", StringComparison.Ordinal)
            || Path.GetExtension(output) != ".json")
        {
            throw new InvalidDataException("bridge_health_path_invalid");
        }

        Directory.CreateDirectory(paths.DataDirectory);
        await using var store = new BridgeStore(Path.Combine(paths.DataDirectory, "bridge.db"));
        await store.InitializeAsync(cancellationToken);
        if (!string.Equals(await store.GetJournalModeAsync(cancellationToken), "wal", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("bridge_health_sqlite_wal_required");
        }
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            ok = true,
            version = typeof(BridgeHealthCheck).Assembly.GetName().Version?.ToString() ?? "unknown",
            checked_at_utc_msc = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            checks = new[] { "runtime_files", "sqlite_wal", "data_directory_write" },
        });
        var temporary = Path.Combine(allowedRoot, $".{Path.GetFileName(output)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(payload, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporary, output, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }
        }
    }
}
