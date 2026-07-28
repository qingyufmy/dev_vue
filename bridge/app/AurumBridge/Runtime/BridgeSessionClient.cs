using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using AurumBridge.Protocol;
using AurumBridge.Security;

namespace AurumBridge.Runtime;

public sealed record BridgePairingPrompt(string UserCode, Uri VerificationUri, long ExpiresAtUtcMsc);

public sealed record BridgeMaintenanceLeaseRequest(
    string InstallationId,
    string TargetVersion,
    string Priority,
    bool ManualRequest,
    IReadOnlyList<string> TerminalInstanceIds,
    IReadOnlyList<long> ObserverBridgeUserIds,
    int ExpectedDowntimeSeconds = 60);

public sealed record BridgeMaintenanceLeaseDecision(
    bool Acquired,
    string? LeaseId,
    long? ExpiresAtUtcMsc,
    string? ReasonCode,
    string? Reason,
    int RetryAfterSeconds);

public sealed record BridgeObserverSource(
    long BridgeUserId,
    string Email,
    string? Nickname,
    long? SourceId,
    string? SourceName,
    string? SourceStatus,
    long? TradingAccountId,
    string? LoginAccount,
    string? BrokerServer)
{
    public string DisplayName => SourceName ?? Nickname ?? Email;

    public string AccountSummary => LoginAccount is null
        ? "首次连接后自动识别交易账户"
        : String.IsNullOrWhiteSpace(BrokerServer)
            ? LoginAccount
            : $"{LoginAccount} · {BrokerServer}";
}

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
    private readonly Uri _realtimeBaseUri;
    private readonly HttpClient _httpClient;
    private readonly IBridgeCredentialStore _credentialStore;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<long> _clock;

    public event Action<bool>? ObserverSourceManagementChanged;

    public BridgeSessionClient(
        Uri serverBaseUri,
        HttpClient httpClient,
        IBridgeCredentialStore credentialStore,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<long>? clock = null,
        Uri? realtimeBaseUri = null)
    {
        _serverBaseUri = NormalizeServerUri(serverBaseUri);
        _realtimeBaseUri = BridgeServerEndpointConfiguration.ParseRealtimeUri(
            (realtimeBaseUri
                ?? BridgeServerEndpointConfiguration.DeriveRealtimeUri(_serverBaseUri)).AbsoluteUri);
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
        var accessToken = await RefreshAccessTokenAsync(cancellationToken);
        var ticket = await PostAsync<TicketResponse>(
            "/api/auth/bridge-ticket",
            new { },
            accessToken,
            cancellationToken);
        if (string.IsNullOrWhiteSpace(ticket.Ticket))
        {
            throw new InvalidDataException("bridge_ticket_response_invalid");
        }
        return new(BuildWebSocketUri(), ticket.Ticket, hello);
    }

    public async Task<IReadOnlyList<BridgeObserverSource>> ListManagedObserverSourcesAsync(
        CancellationToken cancellationToken = default)
    {
        var accessToken = await RefreshAccessTokenAsync(cancellationToken);
        var response = await PostAsync<ObserverSourcesResponse>(
            "/api/auth/bridge-observer-sources",
            new { },
            accessToken,
            cancellationToken);
        return response.Sources;
    }

    public async Task<BridgeCredential> CreateManagedObserverCredentialAsync(
        long bridgeUserId,
        string terminalInstanceId,
        CancellationToken cancellationToken = default)
    {
        if (bridgeUserId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(bridgeUserId));
        }
        ArgumentException.ThrowIfNullOrWhiteSpace(terminalInstanceId);
        var accessToken = await RefreshAccessTokenAsync(cancellationToken);
        var response = await PostAsync<ManagedObserverSessionResponse>(
            "/api/auth/bridge-observer-session",
            new { bridgeUserId, terminalInstanceId },
            accessToken,
            cancellationToken);
        if (response.BridgeUserId != bridgeUserId
            || !String.Equals(response.TerminalInstanceId, terminalInstanceId, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(response.RefreshToken))
        {
            throw new InvalidDataException("bridge_observer_session_response_invalid");
        }
        return new(
            response.RefreshToken,
            checked(_clock() + (long)response.RefreshExpiresInSeconds * 1_000));
    }

    public async Task<BridgeMaintenanceLeaseDecision> AcquireMaintenanceLeaseAsync(
        BridgeMaintenanceLeaseRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var accessToken = await RefreshAccessTokenAsync(cancellationToken);
        var response = await PostAsync<MaintenanceLeaseResponse>(
            "/api/bridge/v3/maintenance-leases",
            new
            {
                installation_id = request.InstallationId,
                target_version = request.TargetVersion,
                priority = request.Priority,
                manual_request = request.ManualRequest,
                terminal_instance_ids = request.TerminalInstanceIds,
                observer_bridge_user_ids = request.ObserverBridgeUserIds,
                expected_downtime_seconds = request.ExpectedDowntimeSeconds,
            },
            accessToken,
            cancellationToken);
        if (response.Acquired
            && (string.IsNullOrWhiteSpace(response.LeaseId)
                || response.ExpiresAtUtcMsc is not { } expiresAt
                || expiresAt <= _clock()))
        {
            throw new InvalidDataException("bridge_maintenance_lease_response_invalid");
        }
        if (!response.Acquired && string.IsNullOrWhiteSpace(response.ReasonCode))
        {
            throw new InvalidDataException("bridge_maintenance_lease_response_invalid");
        }
        return new(
            response.Acquired,
            response.LeaseId,
            response.ExpiresAtUtcMsc,
            response.ReasonCode,
            response.Reason,
            Math.Clamp(response.RetryAfterSeconds, 1, 300));
    }

    public async Task<long> RenewMaintenanceLeaseAsync(
        string leaseId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(leaseId);
        var accessToken = await RefreshAccessTokenAsync(cancellationToken);
        var response = await PostAsync<MaintenanceLeaseResponse>(
            $"/api/bridge/v3/maintenance-leases/{Uri.EscapeDataString(leaseId)}/renew",
            new { },
            accessToken,
            cancellationToken);
        if (!response.Renewed || response.LeaseId != leaseId
            || response.ExpiresAtUtcMsc is not { } expiresAt
            || expiresAt <= _clock())
        {
            throw new InvalidDataException("bridge_maintenance_lease_response_invalid");
        }
        return expiresAt;
    }

    public async Task ReleaseMaintenanceLeaseAsync(
        string leaseId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(leaseId);
        var accessToken = await RefreshAccessTokenAsync(cancellationToken);
        var response = await PostAsync<MaintenanceLeaseResponse>(
            $"/api/bridge/v3/maintenance-leases/{Uri.EscapeDataString(leaseId)}/release",
            new { },
            accessToken,
            cancellationToken);
        if (!response.Released || response.LeaseId != leaseId)
        {
            throw new InvalidDataException("bridge_maintenance_lease_response_invalid");
        }
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
            PublishObserverSourceManagement(false);
        }
        return revoked;
    }

    private void PublishObserverSourceManagement(bool allowed)
    {
        try
        {
            ObserverSourceManagementChanged?.Invoke(allowed);
        }
        catch
        {
            // UI capability updates must never interrupt authentication or reconnects.
        }
    }

    private async Task<string> RefreshAccessTokenAsync(CancellationToken cancellationToken)
    {
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
        catch (BridgeApiException error) when (ShouldClearCredential(error))
        {
            await _credentialStore.ClearAsync(CancellationToken.None);
            PublishObserverSourceManagement(false);
            throw;
        }
        if (string.IsNullOrWhiteSpace(refresh.Token))
        {
            throw new InvalidDataException("bridge_refresh_response_invalid");
        }
        var refreshedCredential = new BridgeCredential(
            credential.RefreshToken,
            checked(_clock() + (long)refresh.RefreshExpiresInSeconds * 1_000));
        if (!await _credentialStore.SaveIfCurrentAsync(
                credential, refreshedCredential, cancellationToken))
        {
            PublishObserverSourceManagement(false);
            throw new BridgeApiException("bridge_not_paired", HttpStatusCode.Unauthorized);
        }
        PublishObserverSourceManagement(String.Equals(
            refresh.BridgeRole,
            "admin",
            StringComparison.OrdinalIgnoreCase));
        return refresh.Token;
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
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        if (LooksLikeHtml(response, payload))
        {
            throw new BridgeApiException(
                "bridge_server_endpoint_unavailable",
                response.StatusCode);
        }
        TResponse result;
        try
        {
            result = JsonSerializer.Deserialize<TResponse>(payload, BridgeJson.Options)
                ?? throw new JsonException("bridge_api_response_empty");
        }
        catch (JsonException)
        {
            throw new BridgeApiException(
                response.IsSuccessStatusCode
                    ? "bridge_server_protocol_error"
                    : StableHttpErrorCode(response.StatusCode),
                response.StatusCode);
        }
        if (!response.IsSuccessStatusCode || !result.Ok)
        {
            var code = result.Code
                ?? (response.StatusCode == HttpStatusCode.TooManyRequests
                    ? "bridge_api_rate_limited"
                    : "bridge_api_request_failed");
            throw new BridgeApiException(code, response.StatusCode);
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

    private static bool ShouldClearCredential(BridgeApiException error) =>
        error.Code is "bridge_refresh_invalid" or "bridge_refresh_revoked";

    private static bool LooksLikeHtml(HttpResponseMessage response, string payload)
    {
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (String.Equals(mediaType, "text/html", StringComparison.OrdinalIgnoreCase)
            || String.Equals(mediaType, "application/xhtml+xml", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return payload.AsSpan().TrimStart().StartsWith("<", StringComparison.Ordinal);
    }

    private static string StableHttpErrorCode(HttpStatusCode statusCode) => statusCode switch
    {
        HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed =>
            "bridge_server_endpoint_unavailable",
        HttpStatusCode.TooManyRequests => "bridge_api_rate_limited",
        _ when (int)statusCode >= 500 => "bridge_server_unavailable",
        _ => "bridge_api_request_failed",
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
        var builder = new UriBuilder(_realtimeBaseUri)
        {
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

        [JsonPropertyName("bridgeRole")]
        public string BridgeRole { get; init; } = string.Empty;
    }

    private sealed record TicketResponse : ApiResponse
    {
        [JsonPropertyName("ticket")]
        public string Ticket { get; init; } = string.Empty;
    }

    private sealed record RevokeResponse : ApiResponse;

    private sealed record ObserverSourcesResponse : ApiResponse
    {
        [JsonPropertyName("sources")]
        public IReadOnlyList<ObserverSourceResponse> SourcesRaw { get; init; } = [];

        [JsonIgnore]
        public IReadOnlyList<BridgeObserverSource> Sources => SourcesRaw.Select(source => new BridgeObserverSource(
            source.BridgeUserId,
            source.Email,
            source.Nickname,
            source.SourceId,
            source.SourceName,
            source.SourceStatus,
            source.TradingAccountId,
            source.LoginAccount,
            source.BrokerServer)).ToArray();
    }

    private sealed record ObserverSourceResponse
    {
        [JsonPropertyName("bridge_user_id")]
        public long BridgeUserId { get; init; }

        [JsonPropertyName("email")]
        public string Email { get; init; } = string.Empty;

        [JsonPropertyName("nickname")]
        public string? Nickname { get; init; }

        [JsonPropertyName("source_id")]
        public long? SourceId { get; init; }

        [JsonPropertyName("source_name")]
        public string? SourceName { get; init; }

        [JsonPropertyName("source_status")]
        public string? SourceStatus { get; init; }

        [JsonPropertyName("trading_account_id")]
        public long? TradingAccountId { get; init; }

        [JsonPropertyName("login_account")]
        public string? LoginAccount { get; init; }

        [JsonPropertyName("broker_server")]
        public string? BrokerServer { get; init; }
    }

    private sealed record ManagedObserverSessionResponse : ApiResponse
    {
        [JsonPropertyName("bridgeUserId")]
        public long BridgeUserId { get; init; }

        [JsonPropertyName("refreshToken")]
        public string RefreshToken { get; init; } = string.Empty;

        [JsonPropertyName("refreshExpiresInSeconds")]
        public int RefreshExpiresInSeconds { get; init; }

        [JsonPropertyName("terminalInstanceId")]
        public string TerminalInstanceId { get; init; } = string.Empty;
    }

    private sealed record MaintenanceLeaseResponse : ApiResponse
    {
        [JsonPropertyName("acquired")]
        public bool Acquired { get; init; }

        [JsonPropertyName("renewed")]
        public bool Renewed { get; init; }

        [JsonPropertyName("released")]
        public bool Released { get; init; }

        [JsonPropertyName("lease_id")]
        public string? LeaseId { get; init; }

        [JsonPropertyName("expires_at_utc_msc")]
        public long? ExpiresAtUtcMsc { get; init; }

        [JsonPropertyName("reason_code")]
        public string? ReasonCode { get; init; }

        [JsonPropertyName("reason")]
        public string? Reason { get; init; }

        [JsonPropertyName("retry_after_seconds")]
        public int RetryAfterSeconds { get; init; } = 5;
    }
}
