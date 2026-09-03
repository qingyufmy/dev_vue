using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.Runtime
{
    public sealed class BridgeSessionToken
    {
        public BridgeSessionToken(string accessToken, long expiresAtUtcMsc)
        {
            if (string.IsNullOrWhiteSpace(accessToken))
                throw new InvalidDataException("bridge_session_token_invalid");
            if (expiresAtUtcMsc <= 0) throw new InvalidDataException("bridge_session_token_invalid");
            AccessToken = accessToken;
            ExpiresAtUtcMsc = expiresAtUtcMsc;
        }

        public string AccessToken { get; private set; }
        public long ExpiresAtUtcMsc { get; private set; }
    }

    /// <summary>
    /// The connection layer accepts only a short-lived session credential.
    /// This default prevents a V4 refresh token from ever being sent as a
    /// WebSocket bearer until the HTTP session-token client is wired in.
    /// </summary>
    public interface IBridgeSessionTokenProvider
    {
        BridgeSessionToken Acquire(BridgeProfileSettings profile, string refreshToken);
    }

    /// <summary>
    /// Narrow transport seam used by the session-token exchange.  Keeping
    /// HTTP behind this interface lets offline tests verify the credential
    /// boundary without connecting to a real server.
    /// </summary>
    public interface IBridgeSessionTokenHttpClient
    {
        string Post(Uri endpoint, byte[] requestBody, int timeoutMilliseconds);
    }

    /// <summary>
    /// The production transport is deliberately small: no redirects, a
    /// bounded response, and no exception text from the peer is propagated.
    /// </summary>
    internal sealed class HttpWebRequestSessionTokenClient : IBridgeSessionTokenHttpClient
    {
        private const int MaximumResponseBytes = 256 * 1024;

        public string Post(Uri endpoint, byte[] requestBody, int timeoutMilliseconds)
        {
            if (endpoint == null || requestBody == null || requestBody.Length == 0)
                throw new InvalidDataException("bridge_session_token_exchange_failed");

            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Accept = "application/json";
            request.UserAgent = "LiangjianBridgeV4/4.0";
            request.Timeout = timeoutMilliseconds;
            request.ReadWriteTimeout = timeoutMilliseconds;
            request.AllowAutoRedirect = false;
            request.ContentLength = requestBody.Length;
            try
            {
                using (Stream stream = request.GetRequestStream())
                {
                    stream.Write(requestBody, 0, requestBody.Length);
                }
                using (WebResponse response = request.GetResponse())
                {
                    HttpWebResponse httpResponse = response as HttpWebResponse;
                    if (httpResponse == null || (int)httpResponse.StatusCode != 201)
                        throw new InvalidDataException("bridge_session_token_exchange_failed");
                    return ReadResponse(response.GetResponseStream());
                }
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (WebException)
            {
                throw new InvalidDataException("bridge_session_token_exchange_failed");
            }
            catch (IOException)
            {
                throw new InvalidDataException("bridge_session_token_exchange_failed");
            }
            catch (Exception)
            {
                throw new InvalidDataException("bridge_session_token_exchange_failed");
            }
        }

        private static string ReadResponse(Stream responseStream)
        {
            if (responseStream == null)
                throw new InvalidDataException("bridge_session_token_exchange_failed");
            using (MemoryStream buffer = new MemoryStream())
            {
                byte[] chunk = new byte[8192];
                try
                {
                    while (true)
                    {
                        int count = responseStream.Read(chunk, 0, chunk.Length);
                        if (count == 0) break;
                        if (buffer.Length + count > MaximumResponseBytes)
                            throw new InvalidDataException("bridge_session_token_exchange_failed");
                        buffer.Write(chunk, 0, count);
                    }
                }
                finally
                {
                    Array.Clear(chunk, 0, chunk.Length);
                }
                byte[] responseBytes = buffer.ToArray();
                try
                {
                    return new UTF8Encoding(false, true).GetString(responseBytes);
                }
                catch (DecoderFallbackException)
                {
                    throw new InvalidDataException("bridge_session_token_exchange_failed");
                }
                finally
                {
                    Array.Clear(responseBytes, 0, responseBytes.Length);
                }
            }
        }
    }

    /// <summary>
    /// Exchanges the profile's DPAPI-protected V4 refresh credential for a
    /// one-use, short-lived session credential.  A refresh credential is
    /// never returned to the connection layer as a WebSocket Authorization
    /// value.
    /// </summary>
    public sealed class HttpBridgeSessionTokenProvider : IBridgeSessionTokenProvider
    {
        public const int MaximumRequestBytes = 8 * 1024;
        public const int MaximumResponseBytes = 256 * 1024;
        private const int DefaultTimeoutMilliseconds = 15000;
        private readonly string installationId;
        private readonly IBridgeSessionTokenHttpClient httpClient;
        private readonly int timeoutMilliseconds;
        private readonly JavaScriptSerializer serializer = CreateSerializer();

        public HttpBridgeSessionTokenProvider(string installationIdValue)
            : this(installationIdValue, new HttpWebRequestSessionTokenClient(),
                DefaultTimeoutMilliseconds)
        {
        }

        public HttpBridgeSessionTokenProvider(string installationIdValue,
            IBridgeSessionTokenHttpClient httpClientValue, int timeoutMillisecondsValue)
        {
            if (!ValidIdentifier(installationIdValue, 128))
                throw new ArgumentException("installationIdValue");
            if (httpClientValue == null)
                throw new ArgumentNullException("httpClientValue");
            if (timeoutMillisecondsValue < 1000 || timeoutMillisecondsValue > 60000)
                throw new ArgumentOutOfRangeException("timeoutMillisecondsValue");
            installationId = installationIdValue;
            httpClient = httpClientValue;
            timeoutMilliseconds = timeoutMillisecondsValue;
        }

        public BridgeSessionToken Acquire(BridgeProfileSettings profile, string refreshToken)
        {
            byte[] requestBytes = null;
            string requestBody = null;
            try
            {
                if (profile == null || !ValidIdentifier(profile.ProfileId, 128)
                    || !ValidRefreshToken(refreshToken))
                    throw InvalidExchange();

                Uri realtime = BridgeV4EndpointPolicy.ValidateRealtimeUri(profile.ServerUri);
                Uri control = BuildControlUri(realtime);
                Uri endpoint = BridgeV4EndpointPolicy.BuildControlPath(control,
                    "/api/v4/bridge/session-tokens");
                requestBody = serializer.Serialize(new SessionTokenRequest
                {
                    refresh_token = refreshToken,
                    installation_id = installationId,
                    profile_id = profile.ProfileId
                });
                requestBytes = Encoding.UTF8.GetBytes(requestBody);
                if (requestBytes.Length == 0 || requestBytes.Length > MaximumRequestBytes)
                    throw InvalidExchange();

                string responseBody = httpClient.Post(endpoint, requestBytes, timeoutMilliseconds);
                try
                {
                    return ParseResponse(responseBody, refreshToken);
                }
                finally
                {
                    responseBody = null;
                }
            }
            catch (InvalidDataException)
            {
                throw InvalidExchange();
            }
            catch (Exception)
            {
                // Deliberately discard transport/serializer detail.  In
                // particular, a peer must not make a refresh token appear in
                // a UI error or log line.
                throw InvalidExchange();
            }
            finally
            {
                if (requestBytes != null) Array.Clear(requestBytes, 0, requestBytes.Length);
                requestBody = null;
            }
        }

        private BridgeSessionToken ParseResponse(string json, string refreshToken)
        {
            IDictionary<string, object> root;
            try
            {
                root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (Exception)
            {
                throw InvalidExchange();
            }
            RequireExactFields(root, new[] { "data", "meta" });
            object rawData;
            object rawMeta;
            if (!root.TryGetValue("data", out rawData)
                || !root.TryGetValue("meta", out rawMeta))
                throw InvalidExchange();
            IDictionary<string, object> meta = rawMeta as IDictionary<string, object>;
            RequireExactFields(meta, new[] { "request_id", "generated_at" });
            ReadText(meta, "request_id", 191);
            string generatedAt = ReadText(meta, "generated_at", 128);
            DateTimeOffset parsedGeneratedAt;
            if (!generatedAt.EndsWith("Z", StringComparison.Ordinal)
                || !DateTimeOffset.TryParse(generatedAt,
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind,
                    out parsedGeneratedAt)
                || parsedGeneratedAt.Offset != TimeSpan.Zero)
                throw InvalidExchange();

            IDictionary<string, object> data = rawData as IDictionary<string, object>;
            RequireExactFields(data, new[]
            {
                "credential_type", "access_token", "expires_in_seconds", "websocket_path"
            });
            string credentialType = ReadText(data, "credential_type", 64);
            string accessToken = ReadText(data, "access_token", 128);
            int expires = ReadExpires(data, "expires_in_seconds");
            string websocketPath = ReadPath(data, "websocket_path");
            if (credentialType != "bridge_session" || !ValidSessionToken(accessToken)
                || string.Equals(accessToken, refreshToken, StringComparison.Ordinal)
                || accessToken.StartsWith("br4_", StringComparison.Ordinal)
                || websocketPath != "/bridge/v4/ws")
                throw InvalidExchange();

            // Validate the returned path against the same authority as the
            // profile.  The response is never allowed to redirect a session
            // to another host or protocol.
            return new BridgeSessionToken(accessToken,
                checked(DateTimeOffset.UtcNow.AddSeconds(expires).ToUnixTimeMilliseconds()));
        }

        private static Uri BuildControlUri(Uri realtime)
        {
            if (realtime == null) throw InvalidExchange();
            string scheme = realtime.Scheme == "wss" ? Uri.UriSchemeHttps : Uri.UriSchemeHttp;
            Uri control;
            if (!Uri.TryCreate(scheme + "://" + realtime.Authority,
                UriKind.Absolute, out control))
                throw InvalidExchange();
            return BridgeV4EndpointPolicy.ValidateControlUri(control.ToString());
        }

        private static int ReadExpires(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)
                || (!(raw is byte) && !(raw is sbyte) && !(raw is short)
                    && !(raw is ushort) && !(raw is int) && !(raw is uint)
                    && !(raw is long) && !(raw is ulong)))
                throw InvalidExchange();
            try
            {
                int value = Convert.ToInt32(raw, System.Globalization.CultureInfo.InvariantCulture);
                if (value < 1 || value > 60) throw InvalidExchange();
                return value;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception)
            {
                throw InvalidExchange();
            }
        }

        private static string ReadText(IDictionary<string, object> values, string key, int maximum)
        {
            object raw;
            if (values == null || !values.TryGetValue(key, out raw)) throw InvalidExchange();
            string value = raw as string;
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximum
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0
                || value.IndexOf('\0') >= 0)
                throw InvalidExchange();
            return value;
        }

        private static string ReadPath(IDictionary<string, object> values, string key)
        {
            string value = ReadText(values, key, 256);
            if (value.Length < 2 || value[0] != '/' || value[1] == '/'
                || value.IndexOf('?') >= 0 || value.IndexOf('#') >= 0
                || value.IndexOf('\\') >= 0)
                throw InvalidExchange();
            return value;
        }

        private static bool ValidSessionToken(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length < 40 || value.Length > 128)
                return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (current < 0x21 || current == 0x7f || current == '\r'
                    || current == '\n' || current == '\0') return false;
            }
            return true;
        }

        private static bool ValidRefreshToken(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length < 40 || value.Length > 512)
                return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (current < 0x21 || current == 0x7f || current == '\r'
                    || current == '\n' || current == '\0') return false;
            }
            return true;
        }

        private static bool ValidIdentifier(string value, int maximum)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximum
                || !((value[0] >= 'A' && value[0] <= 'Z')
                    || (value[0] >= 'a' && value[0] <= 'z')
                    || (value[0] >= '0' && value[0] <= '9'))) return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (!((current >= 'A' && current <= 'Z')
                    || (current >= 'a' && current <= 'z')
                    || (current >= '0' && current <= '9')
                    || current == '-' || current == '_' || current == '.')) return false;
            }
            return true;
        }

        private static void RequireExactFields(IDictionary<string, object> values, string[] fields)
        {
            if (values == null || values.Count != fields.Length) throw InvalidExchange();
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string key in values.Keys)
                if (!expected.Remove(key)) throw InvalidExchange();
            if (expected.Count != 0) throw InvalidExchange();
        }

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer value = new JavaScriptSerializer();
            value.MaxJsonLength = MaximumResponseBytes;
            value.RecursionLimit = 16;
            return value;
        }

        private static InvalidDataException InvalidExchange()
        {
            return new InvalidDataException("bridge_session_token_exchange_failed");
        }

        private sealed class SessionTokenRequest
        {
            public string refresh_token { get; set; }
            public string installation_id { get; set; }
            public string profile_id { get; set; }
        }
    }

}
