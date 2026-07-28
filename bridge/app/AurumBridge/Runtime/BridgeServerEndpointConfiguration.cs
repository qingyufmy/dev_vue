using System.Text.Json;

namespace AurumBridge.Runtime;

public static class BridgeServerEndpointConfiguration
{
    public const string FileName = "server-endpoints.json";

    public static Uri? ReadPackaged(string applicationDirectory, bool required = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationDirectory);
        var path = Path.Combine(Path.GetFullPath(applicationDirectory), FileName);
        if (!File.Exists(path))
        {
            if (required) throw new InvalidDataException("bridge_server_endpoints_missing");
            return null;
        }
        try
        {
            var info = new FileInfo(path);
            if (info.Length is <= 0 or > 4096)
            {
                throw new InvalidDataException("bridge_server_endpoints_invalid");
            }
            var bytes = File.ReadAllBytes(path);
            ReadOnlyMemory<byte> payload = bytes is [0xEF, 0xBB, 0xBF, ..]
                ? bytes.AsMemory(3)
                : bytes;
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            var properties = root.ValueKind == JsonValueKind.Object
                ? root.EnumerateObject().Select(value => value.Name).ToHashSet(StringComparer.Ordinal)
                : [];
            if (!properties.SetEquals(["schema_version", "server_url"])
                || !root.TryGetProperty("schema_version", out var schema)
                || schema.ValueKind != JsonValueKind.Number || schema.GetInt32() != 1
                || !root.TryGetProperty("server_url", out var server)
                || server.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(server.GetString()))
            {
                throw new InvalidDataException("bridge_server_endpoints_invalid");
            }
            return ParseServerUri(server.GetString()!);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("bridge_server_endpoints_invalid", error);
        }
    }

    public static Uri ParseServerUri(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0
            || uri.AbsolutePath != "/"
            || uri.Scheme != Uri.UriSchemeHttps
                && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))
        {
            throw new InvalidDataException("bridge_server_url_invalid");
        }
        return uri;
    }
}
