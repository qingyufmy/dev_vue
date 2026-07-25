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
    public async Task RefreshesSessionThenAcquiresOneTimeWebSocketTicket()
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
            new Uri("https://bridge.example"),
            new HttpClient(handler),
            store,
            clock: () => 1_800_000_000_000);

        var attempt = await client.AcquireConnectionAttemptAsync(Hello());

        Assert.AreEqual("wss://bridge.example/aurum-api/bridge/v3/ws", attempt.WebSocketUri.AbsoluteUri);
        Assert.AreEqual(new string('t', 48), attempt.Ticket);
        Assert.AreEqual("Bearer short-jwt", handler.Requests[1].Authorization);
        Assert.DoesNotContain(new string('r', 64), handler.Requests[1].Body);
    }

    [TestMethod]
    public async Task InvalidRefreshCredentialIsRemovedBeforeRePairing()
    {
        var handler = new QueueHandler(Response(HttpStatusCode.Unauthorized, new
        {
            ok = false,
            code = "bridge_refresh_expired",
        }));
        var store = new MemoryCredentialStore
        {
            Credential = new(new string('r', 64), 1_900_000_000_000),
        };
        var client = new BridgeSessionClient(
            new Uri("https://bridge.example"),
            new HttpClient(handler),
            store);

        var error = await Assert.ThrowsExactlyAsync<BridgeApiException>(
            async () => await client.AcquireConnectionAttemptAsync(Hello()));
        Assert.AreEqual("bridge_refresh_expired", error.Code);
        Assert.IsNull(store.Credential);
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

        Assert.IsTrue(await client.LogoutAsync());

        Assert.IsNull(store.Credential);
        Assert.AreEqual("https://bridge.example/api/auth/bridge-revoke", handler.Requests[1].Uri);
        Assert.AreEqual("Bearer short-jwt", handler.Requests[1].Authorization);
        StringAssert.Contains(handler.Requests[1].Body, refreshToken);
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

    private sealed record CapturedRequest(string Uri, string? Authorization, string Body);

    private sealed class QueueHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> _responses = new(responses);
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
            return _responses.Dequeue();
        }
    }

    private sealed class MemoryCredentialStore : IBridgeCredentialStore
    {
        public BridgeCredential? Credential { get; set; }
        public Task<BridgeCredential?> LoadAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(Credential);
        public Task SaveAsync(BridgeCredential credential, CancellationToken cancellationToken = default)
        {
            Credential = credential;
            return Task.CompletedTask;
        }
        public Task ClearAsync(CancellationToken cancellationToken = default)
        {
            Credential = null;
            return Task.CompletedTask;
        }
    }
}
