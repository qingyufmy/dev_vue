using System.Text.Json;

namespace AurumBridge.Runtime;

public static class BridgePlatform
{
    public const string Mt4 = "mt4";
    public const string Mt5 = "mt5";

    public static string Normalize(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        var normalized = value.Trim().ToLowerInvariant();
        return normalized is Mt4 or Mt5
            ? normalized
            : throw new ArgumentOutOfRangeException(nameof(value), value, "Unsupported bridge platform.");
    }

    public static string DisplayName(string value) => Normalize(value).ToUpperInvariant();
}

public sealed record BridgeUserPreferences(string? Platform);

public sealed class BridgeUserPreferencesStore
{
    private readonly string _path;
    private readonly SemaphoreSlim _access = new(1, 1);

    public BridgeUserPreferencesStore(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        _path = Path.GetFullPath(path);
    }

    public async Task<BridgeUserPreferences> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(_path))
            {
                return new(null);
            }
            try
            {
                await using var stream = new FileStream(
                    _path, FileMode.Open, FileAccess.Read, FileShare.Read,
                    4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
                var stored = await JsonSerializer.DeserializeAsync<BridgeUserPreferences>(
                    stream, cancellationToken:cancellationToken) ?? new(null);
                return string.IsNullOrWhiteSpace(stored.Platform)
                    ? new(null)
                    : new(BridgePlatform.Normalize(stored.Platform));
            }
            catch (JsonException)
            {
                return new(null);
            }
            catch (ArgumentOutOfRangeException)
            {
                return new(null);
            }
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task SavePlatformAsync(string platform, CancellationToken cancellationToken = default)
    {
        var preferences = new BridgeUserPreferences(BridgePlatform.Normalize(platform));
        await _access.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(_path)!;
            Directory.CreateDirectory(directory);
            var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(_path)}.{Guid.NewGuid():N}.tmp");
            try
            {
                await using (var stream = new FileStream(
                    temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
                {
                    await JsonSerializer.SerializeAsync(stream, preferences, cancellationToken:cancellationToken);
                    await stream.FlushAsync(cancellationToken);
                }
                File.Move(temporaryPath, _path, overwrite:true);
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }
        finally
        {
            _access.Release();
        }
    }
}
