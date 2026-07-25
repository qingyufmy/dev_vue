using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using AurumBridge.Protocol;
using AurumBridge.Security;

namespace AurumBridge.Runtime;

public sealed record BridgePairingPrompt(string UserCode, Uri VerificationUri, long ExpiresAtUtcMsc);

public sealed class BridgeApiException : Exception
{
    public BridgeApiException(string code, HttpStatusCode statusCode)
        : base(code)
    {
        Code = code;
        StatusCode = statusCode;
    }

    public string Code { get; }
    public HttpStatusCode StatusCode { get; }
}

public sealed class BridgeSessionClient
{
    private readonly Uri _serverBaseUri;
    private readonly HttpClient _httpClient;
    private readonly IBridgeCredentialStore _credentialStore;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<long> _clock;

    public BridgeSessionClient(
        Uri serverBaseUri,
        HttpClient httpClient,
        IBridgeCredentialStore credentialStore,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<long>? clock = null)
    {
        _serverBaseUri = NormalizeServerUri(serverBaseUri);
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _credentialStore = credentialStore ?? throw new ArgumentNullException(nameof(credentialStore));
        _delay = delay ?? Task.Delay;
        _clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public async Task<BridgeCredential> PairAsync(
        string deviceName,
        Func<BridgePairingPrompt, Task> showVerification,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(showVerification);
        var start = await RetryTransientAsync(
            token => PostAsync<PairingStartResponse>(
                "/api/auth/bridge-pair/start",
                new { deviceName = StringSanitizer(deviceName, 120) },
                cancellationToken: token),
            cancellationToken);
        if (string.IsNullOrWhiteSpace(start.DeviceCode)
            || string.IsNullOrWhiteSpace(start.UserCode)
            || string.IsNullOrWhiteSpace(start.VerificationPath))
        {
            throw new InvalidDataException("bridge_pair_start_response_invalid");
        }
        var expiresAt = checked(_clock() + (long)start.ExpiresInSeconds * 1_000);
        var verificationUri = BuildVerificationUri(start.VerificationPath, start.UserCode);
        await showVerification(new(start.UserCode, verificationUri, expiresAt));

        var interval = TimeSpan.FromSeconds(Math.Clamp(start.IntervalSeconds, 1, 10));
        while (_clock() < expiresAt)
        {
            await _delay(interval, cancellationToken);
            PairingTokenResponse token;
            try
            {
                token = await PostAsync<PairingTokenResponse>(
                    "/api/auth/bridge-pair/token",
                    new { deviceCode = start.DeviceCode },
                    cancellationToken: cancellationToken);
            }
            catch (Exception error) when (
                !cancellationToken.IsCancellationRequested && IsTransient(error))
            {
                continue;
            }
            if (token.Status == "pending")
            {
                continue;
            }
            if (token.Status == "expired")
            {
                throw new BridgeApiException("bridge_pair_expired", HttpStatusCode.BadRequest);
            }
            if (token.Status != "approved" || string.IsNullOrWhiteSpace(token.RefreshToken))
            {
                throw new InvalidDataException("bridge_pair_token_response_invalid");
            }
            var credential = new BridgeCredential(
                token.RefreshToken,
                checked(_clock() + (long)token.RefreshExpiresInSeconds * 1_000));
            await _credentialStore.SaveAsync(credential, cancellationToken);
            return credential;
        }
        throw new BridgeApiException("bridge_pair_expired", HttpStatusCode.BadRequest);
    }

    public async Task<BridgeConnectionAttempt> AcquireConnectionAttemptAsync(
        HelloMessage hello,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(hello);
        var credential = await _credentialStore.LoadAsync(cancellationToken)
            ?? throw new BridgeApiException("bridge_not_paired", HttpStatusCode.Unauthorized);
        RefreshResponse refresh;
        try
        {
            refresh = await PostAsync<RefreshResponse>(
                "/api/auth/bridge-refresh",
                new { refreshToken = credential.RefreshToken },
                cancellationToken: cancellationToken);
        }
        catch (BridgeApiException error) when (error.StatusCode == HttpStatusCode.Unauthorized)
        {
            await _credentialStore.ClearAsync(CancellationToken.None);
            throw;
        }
        if (string.IsNullOrWhiteSpace(refresh.Token))
        {
            throw new InvalidDataException("bridge_refresh_response_invalid");
        }
        await _credentialStore.SaveAsync(new(
            credential.RefreshToken,
            checked(_clock() + (long)refresh.RefreshExpiresInSeconds * 1_000)), cancellationToken);
        var ticket = await PostAsync<TicketResponse>(
            "/api/auth/bridge-ticket",
            new { },
            refresh.Token,
            cancellationToken);
        if (string.IsNullOrWhiteSpace(ticket.Ticket))
        {
            throw new InvalidDataException("bridge_ticket_response_invalid");
        }
        return new(BuildWebSocketUri(), ticket.Ticket, hello);
    }

    public async Task<bool> LogoutAsync(CancellationToken cancellationToken = default)
    {
        var credential = await _credentialStore.LoadAsync(cancellationToken);
        if (credential is null)
        {
            return true;
        }
        var revoked = false;
        try
        {
            var refresh = await PostAsync<RefreshResponse>(
                "/api/auth/bridge-refresh",
                new { refreshToken = credential.RefreshToken },
                cancellationToken: cancellationToken);
            if (!string.IsNullOrWhiteSpace(refresh.Token))
            {
                await PostAsync<RevokeResponse>(
                    "/api/auth/bridge-revoke",
                    new { refreshToken = credential.RefreshToken },
                    refresh.Token,
                    cancellationToken);
                revoked = true;
            }
        }
        catch (Exception error) when (error is BridgeApiException or HttpRequestException or TaskCanceledException)
        {
        }
        finally
        {
            await _credentialStore.ClearAsync(CancellationToken.None);
        }
        return revoked;
    }

    private async Task<TResponse> PostAsync<TResponse>(
        string path,
        object body,
        string? bearerToken = null,
        CancellationToken cancellationToken = default)
        where TResponse : ApiResponse
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(_serverBaseUri, path))
        {
            Content = JsonContent.Create(body),
        };
        if (!string.IsNullOrWhiteSpace(bearerToken))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearerToken);
        }
        using var response = await _httpClient.SendAsync(request, cancellationToken);
        var result = await response.Content.ReadFromJsonAsync<TResponse>(
            BridgeJson.Options,
            cancellationToken) ?? throw new InvalidDataException("bridge_api_response_invalid");
        if (!response.IsSuccessStatusCode || !result.Ok)
        {
            throw new BridgeApiException(result.Code ?? "bridge_api_request_failed", response.StatusCode);
        }
        return result;
    }

    private async Task<TResponse> RetryTransientAsync<TResponse>(
        Func<CancellationToken, Task<TResponse>> operation,
        CancellationToken cancellationToken)
    {
        var failures = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return await operation(cancellationToken);
            }
            catch (Exception error) when (
                !cancellationToken.IsCancellationRequested && IsTransient(error))
            {
                failures++;
                await _delay(RetryDelay(failures), cancellationToken);
            }
        }
    }

    private static bool IsTransient(Exception error) => error switch
    {
        HttpRequestException => true,
        TaskCanceledException => true,
        BridgeApiException apiError when apiError.StatusCode == HttpStatusCode.TooManyRequests
            || (int)apiError.StatusCode >= 500 => true,
        _ => false,
    };

    private static TimeSpan RetryDelay(int failures) => TimeSpan.FromSeconds(failures switch
    {
        <= 1 => 1,
        2 => 2,
        3 => 4,
        4 => 8,
        5 => 15,
        _ => 30,
    });

    private Uri BuildVerificationUri(string verificationPath, string userCode)
    {
        var uri = new Uri(_serverBaseUri, verificationPath);
        var builder = new UriBuilder(uri)
        {
            Query = $"code={Uri.EscapeDataString(userCode)}",
        };
        return builder.Uri;
    }

    private Uri BuildWebSocketUri()
    {
        var builder = new UriBuilder(_serverBaseUri)
        {
            Scheme = _serverBaseUri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = "/aurum-api/bridge/v3/ws",
            Query = string.Empty,
        };
        return builder.Uri;
    }

    private static Uri NormalizeServerUri(Uri serverBaseUri)
    {
        ArgumentNullException.ThrowIfNull(serverBaseUri);
        var local = serverBaseUri.IsLoopback;
        if (serverBaseUri.Scheme != Uri.UriSchemeHttps
            && !(local && serverBaseUri.Scheme == Uri.UriSchemeHttp))
        {
            throw new ArgumentException("Bridge server must use HTTPS except on loopback.", nameof(serverBaseUri));
        }
        return new UriBuilder(serverBaseUri) { Path = "/", Query = string.Empty, Fragment = string.Empty }.Uri;
    }

    private static string StringSanitizer(string value, int maxLength)
    {
        var sanitized = String.Concat((value ?? string.Empty).Where(character => !Char.IsControl(character))).Trim();
        return sanitized.Length <= maxLength ? sanitized : sanitized[..maxLength];
    }

    private abstract record ApiResponse
    {
        [JsonPropertyName("ok")]
        public bool Ok { get; init; }

        [JsonPropertyName("code")]
        public string? Code { get; init; }
    }

    private sealed record PairingStartResponse : ApiResponse
    {
        [JsonPropertyName("deviceCode")]
        public string DeviceCode { get; init; } = string.Empty;

        [JsonPropertyName("userCode")]
        public string UserCode { get; init; } = string.Empty;

        [JsonPropertyName("verificationPath")]
        public string VerificationPath { get; init; } = string.Empty;

        [JsonPropertyName("expiresInSeconds")]
        public int ExpiresInSeconds { get; init; }

        [JsonPropertyName("intervalSeconds")]
        public int IntervalSeconds { get; init; }
    }

    private sealed record PairingTokenResponse : ApiResponse
    {
        [JsonPropertyName("status")]
        public string Status { get; init; } = string.Empty;

        [JsonPropertyName("refreshToken")]
        public string RefreshToken { get; init; } = string.Empty;

        [JsonPropertyName("refreshExpiresInSeconds")]
        public int RefreshExpiresInSeconds { get; init; }
    }

    private sealed record RefreshResponse : ApiResponse
    {
        [JsonPropertyName("token")]
        public string Token { get; init; } = string.Empty;

        [JsonPropertyName("refreshExpiresInSeconds")]
        public int RefreshExpiresInSeconds { get; init; }
    }

    private sealed record TicketResponse : ApiResponse
    {
        [JsonPropertyName("ticket")]
        public string Ticket { get; init; } = string.Empty;
    }

    private sealed record RevokeResponse : ApiResponse;
}
