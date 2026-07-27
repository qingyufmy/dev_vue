using System.Net;
using System.Text;
using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Security;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeSessionClientTests
{
    [TestMethod]
    public void RejectsPlainHttpForNonLoopbackServers()
    {
        Assert.ThrowsExactly<ArgumentException>(() => new BridgeSessionClient(
            new Uri("http://bridge.example"),
            new HttpClient(new QueueHandler()),
            new MemoryCredentialStore()));
    }

    [TestMethod]
    public async Task PairsThroughBrowserCodeAndPersistsOnlyTheRefreshCredential()
    {
        var handler = new QueueHandler(
            Response(HttpStatusCode.Created, new
            {
                ok = true,
                deviceCode = new string('d', 48),
                userCode = "ABCD-2345",
                verificationPath = "/bridge/pair",
                expiresInSeconds = 600,
                intervalSeconds = 2,
            }),
            Response(HttpStatusCode.Accepted, new { ok = true, status = "pending" }),
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                status = "approved",
                refreshToken = new string('r', 64),
                refreshExpiresInSeconds = 7_776_000,
            }));
        var store = new MemoryCredentialStore();
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"),
            new HttpClient(handler),
            store,
            (_, _) => Task.CompletedTask,
            () => 1_800_000_000_000);
        BridgePairingPrompt? prompt = null;

        var credential = await client.PairAsync("Desk PC", value =>
        {
            prompt = value;
            return Task.CompletedTask;
        });

        Assert.AreEqual("ABCD-2345", prompt?.UserCode);
        Assert.AreEqual("https://bridge.example/bridge/pair?code=ABCD-2345", prompt?.VerificationUri.AbsoluteUri);
        Assert.AreEqual(new string('r', 64), credential.RefreshToken);
        Assert.AreEqual(credential, store.Credential);
        Assert.AreEqual(3, handler.Requests.Count);
    }

    [TestMethod]
    public async Task RetriesTransientPairingFailuresWithoutOpeningAnotherBrowser()
    {
        var handler = new QueueHandler(
            new HttpRequestException("start temporarily unavailable"),
            Response(HttpStatusCode.Created, new
            {
                ok = true,
                deviceCode = new string('d', 48),
                userCode = "ABCD-2345",
                verificationPath = "/bridge/pair",
                expiresInSeconds = 600,
                intervalSeconds = 2,
            }),
            new TaskCanceledException("token request timed out"),
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                status = "approved",
                refreshToken = new string('r', 64),
                refreshExpiresInSeconds = 7_776_000,
            }));
        var store = new MemoryCredentialStore();
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"),
            new HttpClient(handler),
            store,
            (_, _) => Task.CompletedTask,
            () => 1_800_000_000_000);
        var prompts = 0;

        await client.PairAsync("Desk PC", _ =>
        {
            prompts++;
            return Task.CompletedTask;
        });

        Assert.AreEqual(1, prompts);
        Assert.AreEqual(4, handler.Requests.Count);
        Assert.IsNotNull(store.Credential);
    }

    [TestMethod]
    public async Task RefreshesSessionThenAcquiresOneTimeWebSocketTicket()
    {
        var handler = new QueueHandler(
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                token = "short-jwt",
                refreshExpiresInSeconds = 7_776_000,
                bridgeRole = "admin",
            }),
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                ticket = new string('t', 48),
                expiresInSeconds = 30,
            }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"),
            new HttpClient(handler),
            store,
            clock: () => 1_800_000_000_000);
        var observerManagement = new List<bool>();
        client.ObserverSourceManagementChanged += observerManagement.Add;

        var attempt = await client.AcquireConnectionAttemptAsync(Hello());

        Assert.AreEqual("wss://bridge.example/aurum-api/bridge/v3/ws", attempt.WebSocketUri.AbsoluteUri);
        Assert.AreEqual(new string('t', 48), attempt.Ticket);
        Assert.AreEqual("Bearer short-jwt", handler.Requests[1].Authorization);
        Assert.DoesNotContain(new string('r', 64), handler.Requests[1].Body);
        CollectionAssert.AreEqual(new[] { true }, observerManagement);
    }

    [TestMethod]
    public async Task MissingOrNonAdminRoleFailsObserverManagementClosed()
    {
        var handler = new QueueHandler(
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                token = "short-jwt",
                refreshExpiresInSeconds = 7_776_000,
            }),
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                ticket = new string('t', 48),
                expiresInSeconds = 30,
            }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);
        var observerManagement = new List<bool>();
        client.ObserverSourceManagementChanged += observerManagement.Add;

        await client.AcquireConnectionAttemptAsync(Hello());

        CollectionAssert.AreEqual(new[] { false }, observerManagement);
    }

    [TestMethod]
    public async Task AdministratorListsObserverSourcesAndIssuesAnIsolatedCredential()
    {
        var handler = new QueueHandler(
            Response(HttpStatusCode.OK, new
            {
                ok = true, token = "admin-jwt", refreshExpiresInSeconds = 7_776_000, bridgeRole = "admin",
            }),
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                sources = new[]
                {
                    new
                    {
                        bridge_user_id = 42, email = "observer@example.com", nickname = "默认观摩",
                        source_id = 3, source_name = "黄金默认行情", source_status = "active",
                        trading_account_id = 9, login_account = "860058", broker_server = "Broker-Demo",
                    },
                },
            }),
            Response(HttpStatusCode.OK, new
            {
                ok = true, token = "admin-jwt-2", refreshExpiresInSeconds = 7_776_000, bridgeRole = "admin",
            }),
            Response(HttpStatusCode.OK, new
            {
                ok = true, bridgeUserId = 42, refreshToken = new string('o', 64),
                refreshExpiresInSeconds = 7_776_000,
                terminalInstanceId = "mt5_0123456789abcdef01234567",
            }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store,
            clock:() => 1_800_000_000_000);

        var sources = await client.ListManagedObserverSourcesAsync();
        var credential = await client.CreateManagedObserverCredentialAsync(
            42, "mt5_0123456789abcdef01234567");

        Assert.HasCount(1, sources);
        Assert.AreEqual("黄金默认行情", sources[0].DisplayName);
        Assert.AreEqual("860058 · Broker-Demo", sources[0].AccountSummary);
        Assert.AreEqual(new string('o', 64), credential.RefreshToken);
        Assert.AreEqual("https://bridge.example/api/auth/bridge-observer-sources", handler.Requests[1].Uri);
        Assert.AreEqual("Bearer admin-jwt", handler.Requests[1].Authorization);
        Assert.AreEqual("https://bridge.example/api/auth/bridge-observer-session", handler.Requests[3].Uri);
        StringAssert.Contains(handler.Requests[3].Body, "42");
        StringAssert.Contains(handler.Requests[3].Body, "mt5_0123456789abcdef01234567");
    }

    [TestMethod]
    public async Task RevokedRefreshCredentialIsRemovedBeforeRePairing()
    {
        var handler = new QueueHandler(Response(HttpStatusCode.Unauthorized, new
        {
            ok = false,
            code = "bridge_refresh_revoked",
        }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"),
            new HttpClient(handler),
            store);
        var observerManagement = new List<bool>();
        client.ObserverSourceManagementChanged += observerManagement.Add;

        var error = await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));
        Assert.AreEqual("bridge_refresh_revoked", error.Code);
        Assert.IsNull(store.Credential);
        CollectionAssert.AreEqual(new[] { false }, observerManagement);
    }

    [TestMethod]
    public async Task TemporaryServerFailurePreservesThePersistentAuthorization()
    {
        var handler = new QueueHandler(Response(HttpStatusCode.ServiceUnavailable, new
        {
            ok = false,
            code = "bridge_server_unreachable",
        }));
        var credential = new BridgeCredential(new string('r', 64), 1_900_000_000_000);
        var store = new MemoryCredentialStore { Credential = credential };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);

        await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));

        Assert.AreEqual(credential, store.Credential);
        Assert.HasCount(1, handler.Requests);
    }

    [TestMethod]
    public async Task HtmlResponseBecomesAStableEndpointErrorWithoutClearingAuthorization()
    {
        var credential = new BridgeCredential(new string('r', 64), 1_900_000_000_000);
        var store = new MemoryCredentialStore { Credential = credential };
        var handler = new QueueHandler(TextResponse(
            HttpStatusCode.Unauthorized,
            "<html><body>reverse proxy login</body></html>",
            "text/html"));
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);

        var error = await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));

        Assert.AreEqual("bridge_server_endpoint_unavailable", error.Code);
        Assert.AreEqual(credential, store.Credential);
    }

    [TestMethod]
    public async Task InvalidSuccessfulJsonBecomesAStableProtocolError()
    {
        var credential = new BridgeCredential(new string('r', 64), 1_900_000_000_000);
        var store = new MemoryCredentialStore { Credential = credential };
        var handler = new QueueHandler(TextResponse(
            HttpStatusCode.OK,
            "this is not json",
            "application/json"));
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);

        var error = await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));

        Assert.AreEqual("bridge_server_protocol_error", error.Code);
        Assert.AreEqual(credential, store.Credential);
    }

    [TestMethod]
    public async Task RateLimitedResponseWithoutServerCodeGetsAStableClientCode()
    {
        var handler = new QueueHandler(Response(HttpStatusCode.TooManyRequests, new
        {
            ok = false,
            error = "too frequent",
        }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);

        var error = await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));

        Assert.AreEqual("bridge_api_rate_limited", error.Code);
        Assert.AreEqual(HttpStatusCode.TooManyRequests, error.StatusCode);
    }

    [TestMethod]
    public async Task ConcurrentLogoutPreventsARefreshingProfileFromRestoringAuthorization()
    {
        var handler = new QueueHandler(Response(HttpStatusCode.OK, new
        {
            ok = true,
            token = "short-jwt",
            refreshExpiresInSeconds = 7_776_000,
            bridgeRole = "admin",
        }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
            AllowConditionalSave = false,
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);
        var observerManagement = new List<bool>();
        client.ObserverSourceManagementChanged += observerManagement.Add;

        var error = await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));

        Assert.AreEqual("bridge_not_paired", error.Code);
        Assert.HasCount(1, handler.Requests);
        CollectionAssert.AreEqual(new[] { false }, observerManagement);
    }

    [TestMethod]
    public async Task ExplicitLogoutRevokesOnlyThisSessionThenClearsLocalCredential()
    {
        var handler = new QueueHandler(
            Response(HttpStatusCode.OK, new
            {
                ok = true,
                token = "short-jwt",
                refreshExpiresInSeconds = 7_776_000,
            }),
            Response(HttpStatusCode.OK, new { ok = true }));
        var refreshToken = new string('r', 64);
        var store = new MemoryCredentialStore
        {
            Credential = new(refreshToken, 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);
        var observerManagement = new List<bool>();
        client.ObserverSourceManagementChanged += observerManagement.Add;

        Assert.IsTrue(await client.LogoutAsync());

        Assert.IsNull(store.Credential);
        Assert.AreEqual("https://bridge.example/api/auth/bridge-revoke", handler.Requests[1].Uri);
        Assert.AreEqual("Bearer short-jwt", handler.Requests[1].Authorization);
        StringAssert.Contains(handler.Requests[1].Body, refreshToken);
        CollectionAssert.AreEqual(new[] { false }, observerManagement);
    }

    [TestMethod]
    public async Task ExplicitLogoutStillClearsLocalCredentialWhenServerCannotBeReached()
    {
        var handler = new QueueHandler(Response(HttpStatusCode.ServiceUnavailable, new
        {
            ok = false,
            code = "bridge_server_unreachable",
        }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"), new HttpClient(handler), store);

        Assert.IsFalse(await client.LogoutAsync());

        Assert.IsNull(store.Credential);
        Assert.HasCount(1, handler.Requests);
    }

    private static HelloMessage Hello() => new()
    {
        Type = "hello",
        MessageId = "hello_session_test",
        SentAtUtcMsc = 1,
        SessionId = "session_test",
        BridgeVersion = "3.0.0",
        Terminals = [],
    };

    private static HttpResponseMessage Response(HttpStatusCode status, object body) => new(status)
    {
        Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
    };

    private static HttpResponseMessage TextResponse(
        HttpStatusCode status,
        string body,
        string mediaType) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, mediaType),
    };

    private sealed record CapturedRequest(string Uri, string? Authorization, string Body);

    private sealed class QueueHandler(params object[] responses) : HttpMessageHandler
    {
        private readonly Queue<object> _responses = new(responses);
        public List<CapturedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new(
                request.RequestUri!.AbsoluteUri,
                request.Headers.Authorization?.ToString(),
                body));
            var response = _responses.Dequeue();
            if (response is Exception error)
            {
                throw error;
            }
            return (HttpResponseMessage)response;
        }
    }

    private sealed class MemoryCredentialStore : IBridgeCredentialStore
    {
        public BridgeCredential? Credential { get; set; }
        public bool AllowConditionalSave { get; set; } = true;
        public Task<BridgeCredential?> LoadAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(Credential);
        public Task SaveAsync(BridgeCredential credential, CancellationToken cancellationToken = default)
        {
            Credential = credential;
            return Task.CompletedTask;
        }
        public Task<bool> SaveIfCurrentAsync(
            BridgeCredential expected,
            BridgeCredential credential,
            CancellationToken cancellationToken = default)
        {
            if (!AllowConditionalSave || Credential?.RefreshToken != expected.RefreshToken)
            {
                return Task.FromResult(false);
            }
            Credential = credential;
            return Task.FromResult(true);
        }
        public Task ClearAsync(CancellationToken cancellationToken = default)
        {
            Credential = null;
            return Task.CompletedTask;
        }
    }
}
