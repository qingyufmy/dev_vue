using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class BridgeSessionTokenProviderSmokeTests
    {
        private const string RefreshToken = "br4_" + "r" +
            "012345678901234567890123456789012345678901234567890123456789";
        private const string AccessToken = "bst_" +
            "0123456789012345678901234567890123456789012345678901";

        public static void RunAll()
        {
            TestRequestBindingAndAccessTokenBoundary();
            TestStrictResponseAndRedactedFailure();
            TestLocalEndpointMapping();
            TestFactoryUsesFreshSessionTokenPerConnection();
        }

        private static void TestRequestBindingAndAccessTokenBoundary()
        {
            RecordingHttpClient client = new RecordingHttpClient(Response(AccessToken, 30));
            HttpBridgeSessionTokenProvider provider = new HttpBridgeSessionTokenProvider(
                "install-01", client, 1000);
            BridgeSessionToken session = provider.Acquire(Profile("profile-01",
                "wss://bridge.example.test/bridge/v4/ws"), RefreshToken);

            Assert(session.AccessToken == AccessToken, "session_access_token_not_returned");
            Assert(session.AccessToken != RefreshToken, "refresh_token_crossed_session_boundary");
            Assert(session.ExpiresAtUtcMsc > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                "session_expiry_not_derived");
            Assert(client.Endpoint.AbsoluteUri ==
                "https://bridge.example.test/api/v4/bridge/session-tokens",
                "wss_session_endpoint_mapping_wrong");

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            IDictionary<string, object> body = serializer.DeserializeObject(client.BodyText)
                as IDictionary<string, object>;
            Assert(body != null && body.Count == 3
                && StringValue(body, "refresh_token") == RefreshToken
                && StringValue(body, "installation_id") == "install-01"
                && StringValue(body, "profile_id") == "profile-01",
                "session_request_binding_wrong");
        }

        private static void TestStrictResponseAndRedactedFailure()
        {
            string response = Response(AccessToken, 30).Replace(
                "\"websocket_path\":\"/bridge/v4/ws\"",
                "\"websocket_path\":\"/bridge/v4/ws\",\"unexpected\":true");
            RecordingHttpClient client = new RecordingHttpClient(response);
            HttpBridgeSessionTokenProvider provider = new HttpBridgeSessionTokenProvider(
                "install-01", client, 1000);
            Exception error = Capture(delegate
            {
                provider.Acquire(Profile("profile-01", "wss://bridge.example.test/bridge/v4/ws"),
                    RefreshToken);
            });
            Assert(error != null && error.Message == "bridge_session_token_exchange_failed"
                && error.Message.IndexOf(RefreshToken, StringComparison.Ordinal) < 0
                && error.Message.IndexOf(AccessToken, StringComparison.Ordinal) < 0
                && error.Message.IndexOf("unexpected", StringComparison.Ordinal) < 0,
                "session_response_failure_not_strict_or_redacted");
        }

        private static void TestLocalEndpointMapping()
        {
            RecordingHttpClient client = new RecordingHttpClient(Response(AccessToken, 1));
            HttpBridgeSessionTokenProvider provider = new HttpBridgeSessionTokenProvider(
                "install-01", client, 1000);
            provider.Acquire(Profile("profile-local", "ws://127.0.0.1:3000/bridge/v4/ws"),
                RefreshToken);
            Assert(client.Endpoint.AbsoluteUri ==
                "http://127.0.0.1:3000/api/v4/bridge/session-tokens",
                "local_ws_session_endpoint_mapping_wrong");
        }

        private static void TestFactoryUsesFreshSessionTokenPerConnection()
        {
            int providerCalls = 0;
            List<string> forwardedTokens = new List<string>();
            Rfc6455MessageChannelFactory factory = new Rfc6455MessageChannelFactory(
                new Uri("wss://bridge.example.test/bridge/v4/ws"),
                delegate
                {
                    providerCalls++;
                    return AccessToken;
                }, 1000,
                delegate(Uri uri, string accessToken, int timeout)
                {
                    forwardedTokens.Add(accessToken);
                    return new EmptyChannel();
                });
            using (IBridgeMessageChannel first = factory.Connect())
            using (IBridgeMessageChannel second = factory.Connect())
            {
                Assert(providerCalls == 2 && forwardedTokens.Count == 2
                    && forwardedTokens[0] == AccessToken && forwardedTokens[1] == AccessToken
                    && forwardedTokens[0].IndexOf("br4_", StringComparison.Ordinal) < 0,
                    "wss_factory_did_not_use_fresh_session_access_token");
            }
        }

        private static BridgeProfileSettings Profile(string profileId, string serverUri)
        {
            return new BridgeProfileSettings
            {
                ProfileId = profileId,
                ServerUri = serverUri
            };
        }

        private static string Response(string accessToken, int expiresInSeconds)
        {
            return "{\"data\":{\"credential_type\":\"bridge_session\","
                + "\"access_token\":\"" + accessToken + "\","
                + "\"expires_in_seconds\":" + expiresInSeconds.ToString() + ","
                + "\"websocket_path\":\"/bridge/v4/ws\"},"
                + "\"meta\":{\"request_id\":\"request-1\","
                + "\"generated_at\":\"2026-09-03T00:00:00.000Z\"}}";
        }

        private static string StringValue(IDictionary<string, object> values, string key)
        {
            object value;
            return values.TryGetValue(key, out value) ? value as string : null;
        }

        private static Exception Capture(Action action)
        {
            try { action(); }
            catch (Exception error) { return error; }
            return null;
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private sealed class RecordingHttpClient : IBridgeSessionTokenHttpClient
        {
            private readonly string response;

            public RecordingHttpClient(string responseValue)
            {
                response = responseValue;
            }

            public Uri Endpoint { get; private set; }
            public string BodyText { get; private set; }

            public string Post(Uri endpoint, byte[] requestBody, int timeoutMilliseconds)
            {
                Endpoint = endpoint;
                BodyText = Encoding.UTF8.GetString(requestBody);
                return response;
            }
        }

        private sealed class EmptyChannel : IBridgeMessageChannel
        {
            public string Receive() { return null; }
            public void Send(string envelopeJson) { }
            public void Dispose() { }
        }
    }
}
