using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class InstallationAuthorizationView
    {
        public string AuthorizationId { get; internal set; }
        public string ConfirmationPath { get; internal set; }
        public string ExpiresAt { get; internal set; }
        public int PollIntervalSeconds { get; internal set; }
        public string Status { get; internal set; }
        public string UserId { get; internal set; }
        public string DisplayName { get; internal set; }
        public int Generation { get; internal set; }
    }

    public sealed class InstallationStatus
    {
        public string InstallationId { get; internal set; }
        public string UserId { get; internal set; }
        public string DisplayName { get; internal set; }
        public int Generation { get; internal set; }
        public bool Authorized { get; internal set; }
        public int Included { get; internal set; }
        public int Purchased { get; internal set; }
        public int Total { get; internal set; }
        public int Active { get; internal set; }
        public int Available { get; internal set; }
    }

    public sealed class InstallationAuthorizationClient
    {
        private readonly IBridgeSessionTokenHttpClient http;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 12 };
        public InstallationAuthorizationClient() { }
        public InstallationAuthorizationClient(IBridgeSessionTokenHttpClient transport)
        { if (transport == null) throw new ArgumentNullException("transport"); http = transport; }

        public InstallationAuthorizationView Start(string apiBase, string installationId, string deviceName,
            string pollSecret, string installationToken, string requestKey)
        {
            ValidateSecrets(installationId, installationToken);
            RequireToken(pollSecret, "bip_", 43);
            RequireRequestKey(requestKey);
            if (string.IsNullOrWhiteSpace(deviceName) || deviceName.Length > 128) throw Invalid();
            IDictionary<string, object> data = Post(apiBase, "/bridge/installation-authorizations", new Dictionary<string, object>
            {
                { "installation_id", installationId }, { "device_name", deviceName },
                { "poll_secret_hash", Hash(pollSecret) }, { "installation_token_hash", Hash(installationToken) },
                { "request_key", requestKey }
            }, 200);
            Exact(data, "authorization_id", "confirmation_path", "expires_at", "poll_interval_seconds");
            string id = Text(data, "authorization_id", 128);
            RequireKey(id);
            string confirmation = Text(data, "confirmation_path", 256);
            if (confirmation != "/bridge/authorize?request=" + Uri.EscapeDataString(id)) throw Invalid();
            string expires = Text(data, "expires_at", 64); Utc(expires);
            return new InstallationAuthorizationView { AuthorizationId = id, ConfirmationPath = confirmation,
                ExpiresAt = expires, PollIntervalSeconds = Interval(data), Status = "pending" };
        }

        public InstallationAuthorizationView Poll(string apiBase, string installationId, string authorizationId,
            string pollSecret, string installationToken)
        {
            RequireKey(authorizationId); RequireToken(pollSecret, "bip_", 43); ValidateSecrets(installationId, installationToken);
            IDictionary<string, object> data = Post(apiBase, "/bridge/installation-authorizations/" + Uri.EscapeDataString(authorizationId) + "/poll",
                new Dictionary<string, object> { { "poll_secret", pollSecret }, { "installation_token", installationToken } }, 200);
            string status = Text(data, "status", 16);
            InstallationAuthorizationView result = new InstallationAuthorizationView
                { AuthorizationId = authorizationId, Status = status, PollIntervalSeconds = Interval(data) };
            if (status == "approved")
            {
                Exact(data, "status", "poll_interval_seconds", "installation_id", "user", "generation", "authorized");
                ValidateIdentity(data, installationId);
                IDictionary<string, object> user = User(data);
                result.UserId = Text(user, "id", 128); result.DisplayName = Text(user, "display_name", 256);
                result.Generation = Number(data, "generation", 1);
            }
            else
            {
                Exact(data, "status", "poll_interval_seconds");
                if (status != "pending" && status != "denied" && status != "expired" && status != "revoked") throw Invalid();
            }
            return result;
        }

        public InstallationStatus Status(string apiBase, string installationId, string installationToken)
        {
            IDictionary<string, object> data = Post(apiBase, "/bridge/installations/status", Proof(installationId, installationToken), 200);
            Exact(data, "installation_id", "user", "generation", "authorized", "capacity");
            ValidateIdentity(data, installationId);
            IDictionary<string, object> user = User(data), capacity = Object(data, "capacity");
            Exact(capacity, "included", "purchased", "total", "active", "available");
            InstallationStatus result = new InstallationStatus { InstallationId = installationId, Authorized = true,
                UserId = Text(user, "id", 128), DisplayName = Text(user, "display_name", 256), Generation = Number(data, "generation", 1),
                Included = Number(capacity, "included", 0), Purchased = Number(capacity, "purchased", 0),
                Total = Number(capacity, "total", 0), Active = Number(capacity, "active", 0), Available = Number(capacity, "available", 0) };
            if ((long)result.Included + result.Purchased != result.Total
                || result.Available != Math.Max(0, result.Total - result.Active)) throw Invalid();
            return result;
        }

        public BridgePairingResult RegisterProfile(string apiBase, string installationId, string installationToken,
            string requestKey, string refreshToken)
        {
            RequireRequestKey(requestKey); RequireToken(refreshToken, "br4_", 64);
            IDictionary<string, object> body = Proof(installationId, installationToken);
            body["request_key"] = requestKey; body["refresh_token"] = refreshToken;
            IDictionary<string, object> data = Post(apiBase, "/bridge/installations/profiles", body, 200);
            Exact(data, "credential_type", "installation_id", "profile_id", "generation", "session_token_path", "websocket_path");
            if (!Equals(data["credential_type"], "bridge_refresh") || !Equals(data["installation_id"], installationId)
                || !Equals(data["session_token_path"], "/api/v4/bridge/session-tokens") || !Equals(data["websocket_path"], "/bridge/v4/ws")) throw Invalid();
            string id = Text(data, "profile_id", 128);
            if (!Regex.IsMatch(id, "^profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z")) throw Invalid();
            return new BridgePairingResult { InstallationId = installationId, ProfileId = id, Generation = Number(data, "generation", 1) };
        }

        public void Revoke(string apiBase, string installationId, string installationToken)
        {
            IDictionary<string, object> data = Post(apiBase, "/bridge/installations/revoke", Proof(installationId, installationToken), 200);
            Exact(data, "installation_id", "revoked");
            if (!Equals(data["installation_id"], installationId) || !Equals(data["revoked"], true)) throw Invalid();
        }

        internal static string NormalizeBase(string value)
        {
            Uri uri = BridgeV4EndpointPolicy.ValidateControlUri(value);
            if (uri.AbsolutePath != "/" && uri.AbsolutePath != "/api/v4" && uri.AbsolutePath != "/api/v4/") throw Invalid();
            return uri.GetLeftPart(UriPartial.Authority);
        }
        internal static string Secret(string prefix, int bytesCount)
        {
            byte[] bytes = new byte[bytesCount];
            try { using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
                return prefix + Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
        internal static void RequireKey(string key)
        { if (key == null || !Regex.IsMatch(key, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\z")) throw Invalid(); }
        internal static void RequireRequestKey(string key)
        { if (key == null || !Regex.IsMatch(key, "^[A-Za-z0-9._:-]{16,128}\\z")) throw Invalid(); }
        internal static void RequireToken(string value, string prefix, int count)
        { if (value == null || !Regex.IsMatch(value, "^" + prefix + "[A-Za-z0-9_-]{" + count + "}\\z")) throw Invalid(); }
        private static void ValidateSecrets(string installationId, string token)
        { RequireKey(installationId); RequireToken(token, "bi4_", 64); }
        private static IDictionary<string, object> Proof(string id, string token)
        { ValidateSecrets(id, token); return new Dictionary<string, object> { { "installation_id", id }, { "installation_token", token } }; }
        private static string Hash(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            try { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
        private IDictionary<string, object> Post(string apiBase, string path, IDictionary<string, object> payload, int status)
        {
            byte[] body = null;
            try
            {
                Uri endpoint = new Uri(NormalizeBase(apiBase) + "/api/v4" + path);
                body = Encoding.UTF8.GetBytes(json.Serialize(payload));
                string response = (http ?? new HttpWebRequestSessionTokenClient(status)).Post(endpoint, body, 15000);
                if (string.IsNullOrEmpty(response) || response.Length > 65536) throw Invalid();
                IDictionary<string, object> root = json.DeserializeObject(response) as IDictionary<string, object>;
                Exact(root, "data", "meta"); IDictionary<string, object> meta = Object(root, "meta");
                Exact(meta, "request_id", "generated_at"); Text(meta, "request_id", 256); Utc(Text(meta, "generated_at", 64));
                return Object(root, "data");
            }
            catch (BridgeHttpStatusException) { throw; }
            catch (Exception) { throw Invalid(); }
            finally { if (body != null) Array.Clear(body, 0, body.Length); }
        }
        private static void ValidateIdentity(IDictionary<string, object> data, string id)
        { if (!Equals(data["installation_id"], id) || !Equals(data["authorized"], true)) throw Invalid(); Number(data, "generation", 1); User(data); }
        private static IDictionary<string, object> User(IDictionary<string, object> data)
        { IDictionary<string, object> user = Object(data, "user"); Exact(user, "id", "display_name"); Text(user, "id", 128); Text(user, "display_name", 256); return user; }
        private static int Interval(IDictionary<string, object> data)
        { int value = Number(data, "poll_interval_seconds", 1); if (value > 60) throw Invalid(); return value; }
        private static int Number(IDictionary<string, object> data, string key, int minimum)
        { object value; if (!data.TryGetValue(key, out value) || !(value is int) || (int)value < minimum) throw Invalid(); return (int)value; }
        private static string Text(IDictionary<string, object> data, string key, int maximum)
        { object value; string text; if (!data.TryGetValue(key, out value) || (text = value as string) == null || string.IsNullOrWhiteSpace(text) || text.Length > maximum || text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0) throw Invalid(); return text; }
        private static IDictionary<string, object> Object(IDictionary<string, object> data, string key)
        { object value; if (data == null || !data.TryGetValue(key, out value) || !(value is IDictionary<string, object>)) throw Invalid(); return (IDictionary<string, object>)value; }
        private static void Exact(IDictionary<string, object> data, params string[] keys)
        { if (data == null || data.Count != keys.Length) throw Invalid(); foreach (string key in keys) if (!data.ContainsKey(key)) throw Invalid(); }
        private static void Utc(string value)
        { DateTimeOffset date; if (!value.EndsWith("Z", StringComparison.Ordinal) || !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out date)) throw Invalid(); }
        private static InvalidDataException Invalid() { return new InvalidDataException("bridge_installation_authorization_failed"); }
    }
}
