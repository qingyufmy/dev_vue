using System.Net;
using System.Net.Http.Headers;
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
    private string? _cacheKey;
    private EntityTagHeaderValue? _etag;
    private ReleaseManifest? _cachedManifest;

    public ReleaseManifestClient(
        Uri serverBaseUri,
        HttpClient httpClient,
        string endpointPath = "/api/bridge/v3/releases/current")
    {
        ArgumentNullException.ThrowIfNull(serverBaseUri);
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        var localHttp = serverBaseUri.IsLoopback && serverBaseUri.Scheme == Uri.UriSchemeHttp;
        if (serverBaseUri.Scheme != Uri.UriSchemeHttps && !localHttp)
        {
            throw new ArgumentException("update_server_uri_invalid", nameof(serverBaseUri));
        }
        if (endpointPath is not ("/api/bridge/v3/releases/current"
                or "/api/bridge/v3/releases/bootstrap"))
        {
            throw new ArgumentException("update_endpoint_path_invalid", nameof(endpointPath));
        }
        _endpoint = new(serverBaseUri, endpointPath);
    }

    public async Task<ReleaseManifest?> FetchVerifiedAsync(
        ReleaseManifestVerifier verifier,
        Version launcherVersion,
        string installationId,
        string rolloutChannel,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        ArgumentNullException.ThrowIfNull(launcherVersion);
        if (string.IsNullOrWhiteSpace(installationId)
            || rolloutChannel is not ("internal" or "stable"))
        {
            throw new ArgumentException("update_rollout_identity_invalid");
        }
        using var request = new HttpRequestMessage(HttpMethod.Get, _endpoint);
        request.Headers.Add("X-Aurum-Installation-Id", installationId);
        request.Headers.Add("X-Aurum-Release-Channel", rolloutChannel);
        var cacheKey = $"{installationId}:{rolloutChannel}";
        if (cacheKey == _cacheKey && _etag is not null && _cachedManifest is not null)
        {
            request.Headers.IfNoneMatch.Add(_etag);
        }
        using var response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            ClearCache();
            return null;
        }
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            if (cacheKey != _cacheKey || _cachedManifest is null)
            {
                throw new InvalidDataException("update_manifest_cache_missing");
            }
            verifier.Verify(_cachedManifest, launcherVersion);
            return _cachedManifest;
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
        _cacheKey = cacheKey;
        _etag = response.Headers.ETag;
        _cachedManifest = manifest;
        return manifest;
    }

    private void ClearCache()
    {
        _cacheKey = null;
        _etag = null;
        _cachedManifest = null;
    }
}
