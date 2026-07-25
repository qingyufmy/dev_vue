using System.Text;
using System.Text.Json;

namespace AurumBridge.Runtime;

public sealed class BridgeLogReader
{
    private readonly string _logDirectory;

    public BridgeLogReader(string logDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(logDirectory);
        _logDirectory = Path.GetFullPath(logDirectory);
    }

    public async Task<string> ReadRecentTextAsync(
        int maxLines = 1_000,
        CancellationToken cancellationToken = default)
    {
        maxLines = Math.Clamp(maxLines, 1, 10_000);
        if (!Directory.Exists(_logDirectory))
        {
            return "暂无日志。";
        }
        var lines = new Queue<string>(maxLines);
        var files = Directory.EnumerateFiles(_logDirectory, "bridge-*.log", SearchOption.TopDirectoryOnly)
            .OrderBy(File.GetLastWriteTimeUtc)
            .ToArray();
        foreach (var path in files)
        {
            await using var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite,
                16 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks:true);
            while (await reader.ReadLineAsync(cancellationToken) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }
                if (lines.Count == maxLines)
                {
                    lines.Dequeue();
                }
                lines.Enqueue(FormatLine(line));
            }
        }
        return lines.Count == 0 ? "暂无日志。" : string.Join(Environment.NewLine, lines);
    }

    private static string FormatLine(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var timestamp = Read(root, "timestamp_utc");
            if (DateTimeOffset.TryParse(timestamp, out var parsed))
            {
                timestamp = parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
            }
            var level = Read(root, "level") switch
            {
                "warning" => "警告",
                "error" => "错误",
                _ => "信息",
            };
            var eventName = Read(root, "event_name");
            var message = Read(root, "message");
            return string.IsNullOrWhiteSpace(message)
                ? $"{timestamp}  [{level}]  {eventName}"
                : $"{timestamp}  [{level}]  {eventName}  {message}";
        }
        catch (JsonException)
        {
            return line;
        }
    }

    private static string Read(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
}
