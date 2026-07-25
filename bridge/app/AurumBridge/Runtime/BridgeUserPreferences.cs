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

public sealed record BridgeUserPreferences(
    string? Platform,
    string? Mt5TerminalInstanceId = null);

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
                return new(null, null);
            }
            try
            {
                await using var stream = new FileStream(
                    _path, FileMode.Open, FileAccess.Read, FileShare.Read,
                    4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
                var stored = await JsonSerializer.DeserializeAsync<BridgeUserPreferences>(
                    stream, cancellationToken:cancellationToken) ?? new(null, null);
                return Normalize(stored);
            }
            catch (JsonException)
            {
                return new(null, null);
            }
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task SavePlatformAsync(string platform, CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadCoreAsync(cancellationToken);
            await SaveCoreAsync(
                current with { Platform = BridgePlatform.Normalize(platform) },
                cancellationToken);
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task SaveMt5TerminalAsync(
        string terminalInstanceId,
        CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeMt5TerminalId(terminalInstanceId)
            ?? throw new ArgumentOutOfRangeException(
                nameof(terminalInstanceId), terminalInstanceId, "Invalid MT5 terminal instance id.");
        await _access.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadCoreAsync(cancellationToken);
            await SaveCoreAsync(
                current with { Mt5TerminalInstanceId = normalized },
                cancellationToken);
        }
        finally
        {
            _access.Release();
        }
    }

    private async Task<BridgeUserPreferences> LoadCoreAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_path))
        {
            return new(null, null);
        }
        try
        {
            await using var stream = new FileStream(
                _path, FileMode.Open, FileAccess.Read, FileShare.Read,
                4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var stored = await JsonSerializer.DeserializeAsync<BridgeUserPreferences>(
                stream, cancellationToken:cancellationToken) ?? new(null, null);
            return Normalize(stored);
        }
        catch (JsonException)
        {
            return new(null, null);
        }
    }

    private async Task SaveCoreAsync(
        BridgeUserPreferences preferences,
        CancellationToken cancellationToken)
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

    private static BridgeUserPreferences Normalize(BridgeUserPreferences preferences)
    {
        string? platform = null;
        if (!string.IsNullOrWhiteSpace(preferences.Platform))
        {
            try
            {
                platform = BridgePlatform.Normalize(preferences.Platform);
            }
            catch (ArgumentOutOfRangeException)
            {
            }
        }
        return new(platform, NormalizeMt5TerminalId(preferences.Mt5TerminalInstanceId));
    }

    private static string? NormalizeMt5TerminalId(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return normalized is { Length: 28 }
            && normalized.StartsWith("mt5_", StringComparison.Ordinal)
            && normalized[4..].All(Uri.IsHexDigit)
                ? normalized
                : null;
    }
}
