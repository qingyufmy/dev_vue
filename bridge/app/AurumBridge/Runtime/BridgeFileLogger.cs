using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AurumBridge.Runtime;

public sealed partial class BridgeFileLogger : IDisposable
{
    private const long DefaultMaxFileBytes = 5L * 1024 * 1024;
    private const int DefaultRetainedFiles = 10;
    private readonly string _logDirectory;
    private readonly long _maxFileBytes;
    private readonly int _retainedFiles;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _sync = new();
    private bool _disposed;

    public BridgeFileLogger(
        string logDirectory,
        long maxFileBytes = DefaultMaxFileBytes,
        int retainedFiles = DefaultRetainedFiles,
        Func<DateTimeOffset>? clock = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(logDirectory);
        if (maxFileBytes < 128)
        {
            throw new ArgumentOutOfRangeException(nameof(maxFileBytes));
        }
        if (retainedFiles is < 2 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(retainedFiles));
        }
        _logDirectory = Path.GetFullPath(logDirectory);
        _maxFileBytes = maxFileBytes;
        _retainedFiles = retainedFiles;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public string LogDirectory => _logDirectory;

    public void Info(string eventName, string? message = null) => Write("info", eventName, message);

    public void Warning(string eventName, string? message = null) => Write("warning", eventName, message);

    public void Error(string eventName, Exception error)
    {
        ArgumentNullException.ThrowIfNull(error);
        Write("error", eventName, FormatException(error));
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _disposed = true;
        }
    }

    internal static string Redact(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }
        var redacted = BearerPattern().Replace(value, "Bearer [REDACTED]");
        return SecretPattern().Replace(redacted, match =>
            $"{match.Groups[1].Value}{match.Groups[2].Value}[REDACTED]");
    }

    internal static string FormatException(Exception error)
    {
        ArgumentNullException.ThrowIfNull(error);
        var parts = new List<string>(4);
        Exception? current = error;
        while (current is not null && parts.Count < 4)
        {
            parts.Add($"{current.GetType().Name}: {current.Message}");
            current = current.InnerException;
        }
        if (current is not null)
        {
            parts.Add("inner_exception_chain_truncated");
        }
        return string.Join(" --> ", parts);
    }

    private void Write(string level, string eventName, string? message)
    {
        if (string.IsNullOrWhiteSpace(eventName))
        {
            throw new ArgumentException("bridge_log_event_invalid", nameof(eventName));
        }
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }
            try
            {
                var now = _clock();
                Directory.CreateDirectory(_logDirectory);
                var path = Path.Combine(_logDirectory, $"bridge-{now:yyyyMMdd}.log");
                var line = JsonSerializer.Serialize(new
                {
                    timestamp_utc = now.ToUniversalTime().ToString("O"),
                    level,
                    event_name = Redact(eventName.Trim()),
                    message = message is null ? null : Redact(message),
                }) + Environment.NewLine;
                var bytes = Encoding.UTF8.GetBytes(line);
                RotateIfNeeded(path, bytes.Length, now);
                using var stream = new FileStream(
                    path,
                    FileMode.Append,
                    FileAccess.Write,
                    FileShare.ReadWrite,
                    16 * 1024,
                    FileOptions.WriteThrough);
                stream.Write(bytes);
                stream.Flush(flushToDisk:true);
                EnforceRetention(path);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private void RotateIfNeeded(string activePath, int nextLineBytes, DateTimeOffset now)
    {
        if (!File.Exists(activePath) || new FileInfo(activePath).Length + nextLineBytes <= _maxFileBytes)
        {
            return;
        }
        var archivePath = Path.Combine(
            _logDirectory,
            $"bridge-{now:yyyyMMdd}-{now.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}.log");
        File.Move(activePath, archivePath);
    }

    private void EnforceRetention(string activePath)
    {
        var files = Directory.EnumerateFiles(_logDirectory, "bridge-*.log", SearchOption.TopDirectoryOnly)
            .Select(Path.GetFullPath)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .ToArray();
        foreach (var path in files.Skip(_retainedFiles))
        {
            if (!string.Equals(path, activePath, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(path);
            }
        }
    }

    [GeneratedRegex(@"(?i)\bBearer\s+[A-Za-z0-9._~+\-/]+=*")]
    private static partial Regex BearerPattern();

    [GeneratedRegex(@"(?i)\b(access_token|refresh_token|password|authorization|ticket|device_key|private_key)([\""']?\s*[:=]\s*[\""']?)([^\""'\s&,}]+)")]
    private static partial Regex SecretPattern();
}
