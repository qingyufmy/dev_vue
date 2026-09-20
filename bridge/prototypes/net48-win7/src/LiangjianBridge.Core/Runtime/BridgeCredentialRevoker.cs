using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.Runtime
{
    public interface IBridgeCredentialRevoker
    {
        void Revoke(BridgeProfileSettings profile, string refreshToken);
    }

    public sealed class HttpBridgeCredentialRevoker : IBridgeCredentialRevoker
    {
        private readonly string installationId;
        private readonly IBridgeSessionTokenHttpClient http;
        private readonly string trustedControlBase;
        public HttpBridgeCredentialRevoker(string installationIdValue, string trustedControlBase = null)
            : this(installationIdValue, new HttpWebRequestSessionTokenClient(200), trustedControlBase) { }

        public HttpBridgeCredentialRevoker(string installationIdValue, IBridgeSessionTokenHttpClient transport, string trustedControlBase = null)
        {
            if (transport == null || !Identifier(installationIdValue)) throw new ArgumentException("bridge_revocation_configuration_invalid");
            installationId = installationIdValue;
            http = transport;
            this.trustedControlBase = TrustedBridgeControlOrigin.Validate(trustedControlBase);
        }

        public void Revoke(BridgeProfileSettings profile, string refreshToken)
        {
            byte[] bytes = null;
            try
            {
                if (profile == null || !Identifier(profile.ProfileId) || refreshToken == null
                    || refreshToken.Length < 40 || refreshToken.Length > 512 || Regex.IsMatch(refreshToken, "\\s")) throw Failed();
                Uri realtime = BridgeV4EndpointPolicy.ValidateRealtimeUri(profile.ServerUri);
                Uri control = TrustedBridgeControlOrigin.Resolve(realtime, trustedControlBase, true);
                Uri endpoint = BridgeV4EndpointPolicy.BuildControlPath(control, "/api/v4/bridge/credential-revocations");
                JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 256 * 1024, RecursionLimit = 16 };
                bytes = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object>
                {
                    { "refresh_token", refreshToken }, { "installation_id", installationId }, { "profile_id", profile.ProfileId }
                }));
                string json = http.Post(endpoint, bytes, 15000);
                if (json == null || json.Length > 256 * 1024) throw Failed();
                IDictionary<string, object> root = serializer.DeserializeObject(json) as IDictionary<string, object>;
                Fields(root, "data", "meta");
                IDictionary<string, object> data = root["data"] as IDictionary<string, object>;
                Fields(data, "credential_type", "installation_id", "profile_id", "generation", "revoked");
                if (!Equals(data["credential_type"], "bridge_revocation") || !Equals(data["installation_id"], installationId)
                    || !Equals(data["profile_id"], profile.ProfileId) || !Equals(data["revoked"], true)
                    || (!(data["generation"] is int) && !(data["generation"] is long))
                    || Convert.ToInt64(data["generation"], CultureInfo.InvariantCulture) < 1) throw Failed();
                IDictionary<string, object> meta = root["meta"] as IDictionary<string, object>;
                Fields(meta, "request_id", "generated_at");
                string requestId = meta["request_id"] as string;
                DateTimeOffset generatedAt;
                if (string.IsNullOrWhiteSpace(requestId) || requestId.Length > 191
                    || !DateTimeOffset.TryParse(meta["generated_at"] as string, CultureInfo.InvariantCulture,
                        DateTimeStyles.RoundtripKind, out generatedAt) || generatedAt.Offset != TimeSpan.Zero) throw Failed();
            }
            catch (Exception) { throw Failed(); }
            finally { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); }
        }

        private static bool Identifier(string value)
        {
            return value != null && Regex.IsMatch(value, "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\z");
        }
        private static void Fields(IDictionary<string, object> value, params string[] fields)
        {
            if (value == null || value.Count != fields.Length) throw Failed();
            foreach (string field in fields) if (!value.ContainsKey(field)) throw Failed();
        }
        private static InvalidDataException Failed() { return new InvalidDataException("bridge_credential_revocation_failed"); }
    }
}
