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
    string? Mt5TerminalInstanceId = null,
    string? Mt5TerminalPath = null,
    string? Mt4TerminalInstanceId = null,
    string? Mt4TerminalPath = null,
    bool ObserverEnabled = true);

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
                return new(null, null, null);
            }
            try
            {
                await using var stream = new FileStream(
                    _path, FileMode.Open, FileAccess.Read, FileShare.Read,
                    4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
                var stored = await JsonSerializer.DeserializeAsync<BridgeUserPreferences>(
                    stream, cancellationToken:cancellationToken) ?? new(null, null, null);
                return Normalize(stored);
            }
            catch (JsonException)
            {
                return new(null, null, null);
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

    public async Task SaveObserverEnabledAsync(
        bool enabled,
        CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadCoreAsync(cancellationToken);
            await SaveCoreAsync(
                current with { ObserverEnabled = enabled },
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

    public async Task SaveMt5TerminalPathAsync(
        string terminalExecutablePath,
        CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeMt5TerminalPath(terminalExecutablePath)
            ?? throw new ArgumentOutOfRangeException(
                nameof(terminalExecutablePath), terminalExecutablePath, "Invalid MT5 terminal path.");
        await _access.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadCoreAsync(cancellationToken);
            await SaveCoreAsync(
                current with { Mt5TerminalPath = normalized },
                cancellationToken);
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task SaveMt4TerminalAsync(
        string terminalInstanceId,
        CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeMt4TerminalId(terminalInstanceId)
            ?? throw new ArgumentOutOfRangeException(
                nameof(terminalInstanceId), terminalInstanceId, "Invalid MT4 terminal instance id.");
        await _access.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadCoreAsync(cancellationToken);
            await SaveCoreAsync(
                current with { Mt4TerminalInstanceId = normalized },
                cancellationToken);
        }
        finally
        {
            _access.Release();
        }
    }

    public async Task SaveMt4TerminalPathAsync(
        string terminalDataPath,
        CancellationToken cancellationToken = default)
    {
        var normalized = NormalizeMt4TerminalPath(terminalDataPath)
            ?? throw new ArgumentOutOfRangeException(
                nameof(terminalDataPath), terminalDataPath, "Invalid MT4 terminal data path.");
        await _access.WaitAsync(cancellationToken);
        try
        {
            var current = await LoadCoreAsync(cancellationToken);
            await SaveCoreAsync(
                current with { Mt4TerminalPath = normalized },
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
            return new(null, null, null);
        }
        try
        {
            await using var stream = new FileStream(
                _path, FileMode.Open, FileAccess.Read, FileShare.Read,
                4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var stored = await JsonSerializer.DeserializeAsync<BridgeUserPreferences>(
                stream, cancellationToken:cancellationToken) ?? new(null, null, null);
            return Normalize(stored);
        }
        catch (JsonException)
        {
            return new(null, null, null);
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
        return new(
            platform,
            NormalizeMt5TerminalId(preferences.Mt5TerminalInstanceId),
            NormalizeMt5TerminalPath(preferences.Mt5TerminalPath),
            NormalizeMt4TerminalId(preferences.Mt4TerminalInstanceId),
            NormalizeMt4TerminalPath(preferences.Mt4TerminalPath),
            preferences.ObserverEnabled);
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

    private static string? NormalizeMt5TerminalPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
        {
            return null;
        }
        try
        {
            var path = Path.GetFullPath(value.Trim());
            var fileName = Path.GetFileName(path);
            return fileName.Equals("terminal64.exe", StringComparison.OrdinalIgnoreCase)
                || fileName.Equals("terminal.exe", StringComparison.OrdinalIgnoreCase)
                    ? path
                    : null;
        }
        catch (Exception error) when (error is ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return null;
        }
    }

    private static string? NormalizeMt4TerminalId(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return normalized is { Length: 28 }
            && normalized.StartsWith("mt4_", StringComparison.Ordinal)
            && normalized[4..].All(Uri.IsHexDigit)
                ? normalized
                : null;
    }

    private static string? NormalizeMt4TerminalPath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
        {
            return null;
        }
        try
        {
            return Path.GetFullPath(value.Trim());
        }
        catch (Exception error) when (error is ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return null;
        }
    }
}
