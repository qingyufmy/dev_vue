using System.Text.Json;

namespace AurumBridge.Runtime;

public sealed record BridgeEndpointConfiguration(
    Uri ControlBaseUri,
    Uri RealtimeBaseUri);

public sealed class BridgeEndpointSettingsStore
{
    public const string FileName = "endpoint-settings.json";
    private readonly string _path;
    private readonly SemaphoreSlim _access = new(1, 1);

    public BridgeEndpointSettingsStore(string rootDataDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDataDirectory);
        _path = Path.Combine(Path.GetFullPath(rootDataDirectory), FileName);
    }

    public bool Exists => File.Exists(_path);

    public BridgeEndpointConfiguration? Load()
    {
        if (!File.Exists(_path))
        {
            return null;
        }
        try
        {
            var info = new FileInfo(_path);
            if (info.Length is <= 0 or > 4096)
            {
                throw new InvalidDataException("bridge_endpoint_settings_invalid");
            }
            using var document = JsonDocument.Parse(File.ReadAllBytes(_path));
            var root = document.RootElement;
            var properties = root.ValueKind == JsonValueKind.Object
                ? root.EnumerateObject().Select(property => property.Name)
                    .ToHashSet(StringComparer.Ordinal)
                : [];
            if (!properties.SetEquals(["schema_version", "control_url", "realtime_url"])
                || !root.TryGetProperty("schema_version", out var schema)
                || schema.ValueKind != JsonValueKind.Number
                || schema.GetInt32() != 1
                || !root.TryGetProperty("control_url", out var control)
                || control.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("realtime_url", out var realtime)
                || realtime.ValueKind != JsonValueKind.String)
            {
                throw new InvalidDataException("bridge_endpoint_settings_invalid");
            }
            return Normalize(control.GetString()!, realtime.GetString()!);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("bridge_endpoint_settings_invalid", error);
        }
    }

    public async Task SaveAsync(
        BridgeEndpointConfiguration configuration,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var normalized = Normalize(
            configuration.ControlBaseUri.AbsoluteUri,
            configuration.RealtimeBaseUri.AbsoluteUri);
        await _access.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(_path)!;
            Directory.CreateDirectory(directory);
            var temporaryPath = Path.Combine(
                directory,
                $".{Path.GetFileName(_path)}.{Guid.NewGuid():N}.tmp");
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
                        schema_version = 1,
                        control_url = normalized.ControlBaseUri.AbsoluteUri.TrimEnd('/'),
                        realtime_url = normalized.RealtimeBaseUri.AbsoluteUri.TrimEnd('/'),
                    }, cancellationToken:cancellationToken);
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

    public async Task ClearAsync(CancellationToken cancellationToken = default)
    {
        await _access.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(_path))
            {
                File.Delete(_path);
            }
        }
        finally
        {
            _access.Release();
        }
    }

    public static BridgeEndpointConfiguration Normalize(
        string controlUrl,
        string realtimeUrl) => new(
            BridgeServerEndpointConfiguration.ParseServerUri(controlUrl),
            BridgeServerEndpointConfiguration.ParseRealtimeUri(realtimeUrl));

    public static BridgeEndpointConfiguration FromServerUrl(string serverUrl)
    {
        var control = BridgeServerEndpointConfiguration.ParseServerUri(serverUrl);
        return new(
            control,
            BridgeServerEndpointConfiguration.DeriveRealtimeUri(control));
    }
}
