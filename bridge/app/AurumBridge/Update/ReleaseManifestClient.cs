using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AurumBridge.Update;

public sealed class ReleaseManifestClient
{
    private const int MaxManifestBytes = 128 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };
    private readonly Uri _endpoint;
    private readonly HttpClient _httpClient;

    public ReleaseManifestClient(Uri serverBaseUri, HttpClient httpClient)
    {
        ArgumentNullException.ThrowIfNull(serverBaseUri);
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        var localHttp = serverBaseUri.IsLoopback && serverBaseUri.Scheme == Uri.UriSchemeHttp;
        if (serverBaseUri.Scheme != Uri.UriSchemeHttps && !localHttp)
        {
            throw new ArgumentException("update_server_uri_invalid", nameof(serverBaseUri));
        }
        _endpoint = new(serverBaseUri, "/api/bridge/v3/releases/current");
    }

    public async Task<ReleaseManifest?> FetchVerifiedAsync(
        ReleaseManifestVerifier verifier,
        Version launcherVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        ArgumentNullException.ThrowIfNull(launcherVersion);
        using var response = await _httpClient.GetAsync(
            _endpoint,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            return null;
        }
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength is > MaxManifestBytes)
        {
            throw new InvalidDataException("update_manifest_too_large");
        }
        await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var content = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (content.Length + read > MaxManifestBytes)
            {
                throw new InvalidDataException("update_manifest_too_large");
            }
            await content.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
        }
        content.Position = 0;
        ReleaseManifest manifest;
        try
        {
            manifest = await JsonSerializer.DeserializeAsync<ReleaseManifest>(
                content,
                JsonOptions,
                cancellationToken)
                ?? throw new InvalidDataException("update_manifest_invalid");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("update_manifest_invalid", error);
        }
        verifier.Verify(manifest, launcherVersion);
        return manifest;
    }
}
