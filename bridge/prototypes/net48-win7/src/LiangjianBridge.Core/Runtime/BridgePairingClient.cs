using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class BridgePairingResult
    {
        public string ProfileId { get; internal set; }
        public string InstallationId { get; internal set; }
        public int Generation { get; internal set; }
    }

    // The caller keeps the generated secret for an uncertain-response retry
    // and stores it with the existing DPAPI profile store after redemption.
    public sealed class BridgePairingClient
    {
        private readonly IBridgeSessionTokenHttpClient http;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer
        { MaxJsonLength = 16384, RecursionLimit = 8 };

        public BridgePairingClient() : this(new HttpWebRequestSessionTokenClient()) { }
        public BridgePairingClient(IBridgeSessionTokenHttpClient transport)
        {
            if (transport == null) throw new ArgumentNullException("transport");
            http = transport;
        }

        public static string CreateRefreshToken()
        {
            byte[] bytes = new byte[48];
            try
            {
                using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
                return "br4_" + Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_');
            }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }

        public BridgePairingResult Redeem(string realtimeAddress, string installationId,
            string pairingCode, string refreshToken)
        {
            byte[] body = null;
            try
            {
                if (!Matches(installationId, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
                    || !Matches(pairingCode, "^bpc_[A-Za-z0-9_-]{43}$")
                    || !Matches(refreshToken, "^br4_[A-Za-z0-9_-]{64}$")) throw Invalid();
                Uri realtime = BridgeV4EndpointPolicy.ValidateRealtimeUri(realtimeAddress);
                Uri control = BridgeV4EndpointPolicy.ValidateControlUri(
                    (realtime.Scheme == "wss" ? "https://" : "http://") + realtime.Authority);
                Uri endpoint = BridgeV4EndpointPolicy.BuildControlPath(control, "/api/v4/bridge/pairing-redemptions");
                body = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object>
                {
                    { "pairing_code", pairingCode }, { "installation_id", installationId }, { "refresh_token", refreshToken }
                }));
                string response = http.Post(endpoint, body, 15000);
                return Parse(response, installationId);
            }
            catch (Exception) { throw Invalid(); }
            finally { if (body != null) Array.Clear(body, 0, body.Length); }
        }

        private BridgePairingResult Parse(string response, string installationId)
        {
            if (string.IsNullOrEmpty(response) || response.Length > 16384) throw Invalid();
            IDictionary<string, object> root = serializer.DeserializeObject(response) as IDictionary<string, object>;
            Exact(root, "data", "meta");
            IDictionary<string, object> data = root["data"] as IDictionary<string, object>;
            IDictionary<string, object> meta = root["meta"] as IDictionary<string, object>;
            Exact(meta, "request_id", "generated_at");
            DateTimeOffset generated;
            if (!(meta["request_id"] is string) || string.IsNullOrEmpty((string)meta["request_id"])
                || !(meta["generated_at"] is string) || !((string)meta["generated_at"]).EndsWith("Z", StringComparison.Ordinal)
                || !DateTimeOffset.TryParse((string)meta["generated_at"], out generated)) throw Invalid();
            Exact(data, "credential_type", "installation_id", "profile_id", "generation", "session_token_path", "websocket_path");
            if (!Equals(data["credential_type"], "bridge_refresh") || !Equals(data["installation_id"], installationId)
                || !Matches(data["profile_id"] as string, "^profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
                || !(data["generation"] is int) || (int)data["generation"] < 1
                || !Equals(data["session_token_path"], "/api/v4/bridge/session-tokens")
                || !Equals(data["websocket_path"], "/bridge/v4/ws")) throw Invalid();
            return new BridgePairingResult { ProfileId = (string)data["profile_id"], InstallationId = installationId,
                Generation = (int)data["generation"] };
        }

        private static void Exact(IDictionary<string, object> value, params string[] fields)
        {
            if (value == null || value.Count != fields.Length) throw Invalid();
            foreach (string field in fields) if (!value.ContainsKey(field)) throw Invalid();
        }
        private static bool Matches(string value, string pattern)
        { return value != null && value.Length <= 128 && Regex.IsMatch(value, pattern.TrimEnd('$') + "\\z"); }
        private static InvalidDataException Invalid() { return new InvalidDataException("bridge_pairing_exchange_failed"); }
    }
}
