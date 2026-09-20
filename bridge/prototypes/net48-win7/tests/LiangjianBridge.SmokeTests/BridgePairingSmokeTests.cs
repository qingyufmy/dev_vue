using System;
using System.IO;
using System.Text;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class BridgePairingSmokeTests
    {
        private const string Profile = "profile-11111111-1111-4111-8111-111111111111";
        public static void RunAll()
        {
            string secret = BridgePairingClient.CreateRefreshToken();
            if (secret.Length != 68 || secret == BridgePairingClient.CreateRefreshToken()) throw new Exception("pairing_random_invalid");
            FakeHttp http = new FakeHttp();
            BridgePairingClient client = new BridgePairingClient(http);
            string code = "bpc_" + new string('a', 43);
            BridgePairingResult result = client.Redeem("wss://trade.example.test/bridge/v4/ws", "install-1", code, secret);
            string first = http.Body;
            client.Redeem("wss://trade.example.test/bridge/v4/ws", "install-1", code, secret);
            if (first != http.Body || result.ProfileId != Profile || result.InstallationId != "install-1"
                || !http.Body.Contains(secret) || !http.Body.Contains(code)
                || http.Endpoint != "https://trade.example.test/api/v4/bridge/pairing-redemptions") throw new Exception("pairing_binding_invalid");
            BridgePairingClient configured = new BridgePairingClient(http, "http://localhost:3010");
            configured.Redeem("ws://localhost:3012/bridge/v4/ws", "install-1", code, secret);
            if (http.Endpoint != "http://localhost:3010/api/v4/bridge/pairing-redemptions") throw new Exception("pairing_configured_api_port_ignored");
            try { configured.Redeem("wss://localhost:3012/bridge/v4/ws", "install-1", code, secret); throw new Exception("pairing_control_downgrade_accepted"); }
            catch (InvalidDataException) { }
            try { configured.Redeem("ws://127.0.0.1:3012/bridge/v4/ws", "install-1", code, secret); throw new Exception("pairing_control_host_mismatch_accepted"); }
            catch (InvalidDataException) { }
            foreach (string response in new[] { "{}", http.Response.Replace("install-1", "install-2"),
                http.Response.Replace("/bridge/v4/ws", "https://other.test/ws"),
                http.Response.Replace("\"generation\":1", "\"generation\":1,\"refresh_token\":\"leak\"") })
            {
                http.Response = response;
                try { client.Redeem("wss://trade.example.test/bridge/v4/ws", "install-1", code, secret); }
                catch (InvalidDataException error)
                {
                    if (error.Message != "bridge_pairing_exchange_failed") throw;
                    continue;
                }
                throw new Exception("pairing_invalid_response_accepted");
            }
        }
        private sealed class FakeHttp : IBridgeSessionTokenHttpClient
        {
            public string Endpoint;
            public string Body;
            public string Response = "{\"data\":{\"credential_type\":\"bridge_refresh\",\"installation_id\":\"install-1\",\"profile_id\":\""
                + Profile + "\",\"generation\":1,\"session_token_path\":\"/api/v4/bridge/session-tokens\",\"websocket_path\":\"/bridge/v4/ws\"},"
                + "\"meta\":{\"request_id\":\"request-1\",\"generated_at\":\"2026-09-06T00:00:00.000Z\"}}";
            public string Post(Uri endpoint, byte[] body, int timeout)
            { Endpoint = endpoint.AbsoluteUri; Body = Encoding.UTF8.GetString(body); return Response; }
        }
    }
}
