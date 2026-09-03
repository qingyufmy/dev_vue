using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Migration
{
    public sealed class BridgeV4CredentialExchangeRequest
    {
        public int schema_version { get; set; }
        public string legacy_refresh_token { get; set; }
        public string installation_id { get; set; }
        public string profile_id { get; set; }
        public string source_fingerprint { get; set; }
    }

    public sealed class BridgeV4CredentialExchangeResult
    {
        public BridgeV4CredentialExchangeResult()
        {
        }

        public BridgeV4CredentialExchangeResult(string credentialType, string refreshToken,
            long generation, string sessionTokenPath, string websocketPath)
        {
            CredentialType = credentialType;
            RefreshToken = refreshToken;
            Generation = generation;
            SessionTokenPath = sessionTokenPath;
            WebSocketPath = websocketPath;
        }

        public string CredentialType { get; internal set; }
        public string RefreshToken { get; internal set; }
        public long Generation { get; internal set; }
        public string SessionTokenPath { get; internal set; }
        public string WebSocketPath { get; internal set; }
    }

    public interface IBridgeV4CredentialExchangeClient
    {
        BridgeV4CredentialExchangeResult Exchange(BridgeV4CredentialExchangeRequest request,
            string candidateControlUri, string candidateRealtimeUri);
    }

    /// <summary>
    /// Minimal HTTP client for the V3-to-V4 handoff. Redirects and response
    /// payloads are deliberately bounded so a failed exchange cannot leak a
    /// credential through an exception or an untrusted endpoint.
    /// </summary>
    public sealed class HttpBridgeV4CredentialExchangeClient : IBridgeV4CredentialExchangeClient
    {
        public const int MaximumResponseBytes = 256 * 1024;
        private const int DefaultTimeoutMilliseconds = 15000;
        private readonly int timeoutMilliseconds;
        private readonly JavaScriptSerializer serializer = CreateSerializer();

        public HttpBridgeV4CredentialExchangeClient()
            : this(DefaultTimeoutMilliseconds)
        {
        }

        public HttpBridgeV4CredentialExchangeClient(int timeoutMillisecondsValue)
        {
            if (timeoutMillisecondsValue < 1000 || timeoutMillisecondsValue > 60000)
            {
                throw new ArgumentOutOfRangeException("timeoutMillisecondsValue");
            }
            timeoutMilliseconds = timeoutMillisecondsValue;
        }

        public BridgeV4CredentialExchangeResult Exchange(BridgeV4CredentialExchangeRequest request,
            string candidateControlUri, string candidateRealtimeUri)
        {
            ValidateRequest(request);
            Uri control = BridgeV4EndpointPolicy.ValidateControlUri(candidateControlUri);
            Uri realtime = BridgeV4EndpointPolicy.ValidateRealtimeUri(candidateRealtimeUri);
            BridgeV4EndpointPolicy.ValidateHostPair(control, realtime);

            Uri endpoint = BridgeV4EndpointPolicy.BuildControlPath(control,
                "/api/v4/bridge/legacy-credential-exchanges");
            string body = serializer.Serialize(request);
            byte[] bodyBytes = Encoding.UTF8.GetBytes(body);
            try
            {
                HttpWebRequest webRequest = (HttpWebRequest)WebRequest.Create(endpoint);
                webRequest.Method = "POST";
                webRequest.ContentType = "application/json; charset=utf-8";
                webRequest.Accept = "application/json";
                webRequest.UserAgent = "LiangjianBridgeV4/4.0";
                webRequest.Timeout = timeoutMilliseconds;
                webRequest.ReadWriteTimeout = timeoutMilliseconds;
                webRequest.AllowAutoRedirect = false;
                webRequest.ContentLength = bodyBytes.Length;
                using (Stream requestStream = webRequest.GetRequestStream())
                {
                    requestStream.Write(bodyBytes, 0, bodyBytes.Length);
                }
                using (WebResponse response = webRequest.GetResponse())
                {
                    HttpWebResponse httpResponse = response as HttpWebResponse;
                    if (httpResponse == null || (int)httpResponse.StatusCode < 200
                        || (int)httpResponse.StatusCode >= 300)
                    {
                        throw InvalidExchange();
                    }
                    string responseJson = null;
                    try
                    {
                        responseJson = ReadResponse(response.GetResponseStream());
                        return ParseResponse(responseJson, realtime);
                    }
                    finally
                    {
                        responseJson = null;
                    }
                }
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (WebException)
            {
                throw InvalidExchange();
            }
            catch (IOException)
            {
                throw InvalidExchange();
            }
            catch (Exception)
            {
                throw InvalidExchange();
            }
            finally
            {
                Array.Clear(bodyBytes, 0, bodyBytes.Length);
                body = null;
            }
        }

        private BridgeV4CredentialExchangeResult ParseResponse(string json, Uri realtime)
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
            if (!root.TryGetValue("data", out rawData)) throw InvalidExchange();
            object rawMeta;
            if (!root.TryGetValue("meta", out rawMeta)) throw InvalidExchange();
            IDictionary<string, object> meta = rawMeta as IDictionary<string, object>;
            RequireExactFields(meta, new[] { "request_id", "generated_at" });
            ReadText(meta, "request_id", 191);
            string generatedAt = ReadText(meta, "generated_at", 128);
            if (!generatedAt.EndsWith("Z", StringComparison.Ordinal)) throw InvalidExchange();
            IDictionary<string, object> data = rawData as IDictionary<string, object>;
            RequireExactFields(data, new[]
            {
                "credential_type", "refresh_token", "generation",
                "session_token_path", "websocket_path"
            });

            string credentialType = ReadText(data, "credential_type", 64);
            string refreshToken = ReadText(data, "refresh_token",
                LegacyV3CredentialReader.MaximumRefreshTokenLength);
            if (credentialType != "bridge_refresh" || !ValidToken(refreshToken))
            {
                throw InvalidExchange();
            }
            long generation = ReadPositiveInt64(data, "generation");
            string sessionPath = ReadPath(data, "session_token_path");
            string websocketPath = ReadPath(data, "websocket_path");
            if (sessionPath != "/api/v4/bridge/session-tokens"
                || websocketPath != "/bridge/v4/ws")
            {
                throw InvalidExchange();
            }
            // The server returns a path, never a host. Build once here to
            // reject accidental path/host changes before the catalog write.
            BridgeV4EndpointPolicy.BuildWebSocketUri(realtime, websocketPath);
            return new BridgeV4CredentialExchangeResult
            {
                CredentialType = credentialType,
                RefreshToken = refreshToken,
                Generation = generation,
                SessionTokenPath = sessionPath,
                WebSocketPath = websocketPath
            };
        }

        private static string ReadResponse(Stream responseStream)
        {
            if (responseStream == null) throw InvalidExchange();
            using (MemoryStream buffer = new MemoryStream())
            {
                byte[] chunk = new byte[8192];
                try
                {
                    while (true)
                    {
                        int count = responseStream.Read(chunk, 0, chunk.Length);
                        if (count == 0) break;
                        if (buffer.Length + count > MaximumResponseBytes) throw InvalidExchange();
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
                    throw InvalidExchange();
                }
                finally
                {
                    Array.Clear(responseBytes, 0, responseBytes.Length);
                }
            }
        }

        private static void ValidateRequest(BridgeV4CredentialExchangeRequest request)
        {
            if (request == null || request.schema_version != 1
                || !ValidIdentifier(request.installation_id, 128)
                || !ValidIdentifier(request.profile_id, 128)
                || !ValidToken(request.legacy_refresh_token)
                || !ValidFingerprint(request.source_fingerprint))
            {
                throw InvalidExchange();
            }
        }

        private static string ReadText(IDictionary<string, object> values, string key, int maximum)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)) throw InvalidExchange();
            string value = raw as string;
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximum
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0
                || value.IndexOf('\0') >= 0)
            {
                throw InvalidExchange();
            }
            return value;
        }

        private static string ReadPath(IDictionary<string, object> values, string key)
        {
            string value = ReadText(values, key, 256);
            if (value.Length < 2 || value[0] != '/' || value[1] == '/'
                || value.IndexOf('?') >= 0 || value.IndexOf('#') >= 0
                || value.IndexOf('\\') >= 0)
            {
                throw InvalidExchange();
            }
            return value;
        }

        private static long ReadPositiveInt64(IDictionary<string, object> values, string key)
        {
            object value;
            if (!values.TryGetValue(key, out value)
                || (!(value is byte) && !(value is sbyte) && !(value is short)
                    && !(value is ushort) && !(value is int) && !(value is uint)
                    && !(value is long) && !(value is ulong)))
            {
                throw InvalidExchange();
            }
            try
            {
                long result = Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture);
                if (result <= 0) throw InvalidExchange();
                return result;
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

        private static bool ValidToken(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length < 40
                || value.Length > LegacyV3CredentialReader.MaximumRefreshTokenLength)
            {
                return false;
            }
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
                || !IsAsciiAlphaNumeric(value[0])) return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (!IsAsciiAlphaNumeric(current) && current != '-' && current != '_'
                    && current != '.') return false;
            }
            return true;
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        private static bool ValidFingerprint(string value)
        {
            if (value == null || value.Length != 71 || !value.StartsWith("sha256:", StringComparison.Ordinal))
                return false;
            for (int index = 7; index < value.Length; index++)
            {
                char current = value[index];
                if (!((current >= '0' && current <= '9')
                    || (current >= 'a' && current <= 'f'))) return false;
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

        internal static InvalidDataException InvalidExchange()
        {
            return new InvalidDataException("bridge_v4_credential_exchange_failed");
        }
    }

    public static class BridgeV4EndpointPolicy
    {
        public static Uri ValidateControlUri(string value)
        {
            Uri uri = ParseAbsolute(value, "bridge_v4_control_uri_invalid");
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                throw new InvalidDataException("bridge_v4_control_uri_invalid");
            if (!IsLocal(uri.Host) && uri.Scheme != Uri.UriSchemeHttps)
                throw new InvalidDataException("bridge_v4_control_uri_insecure");
            return uri;
        }

        public static Uri ValidateRealtimeUri(string value)
        {
            Uri uri = ParseAbsolute(value, "bridge_v4_realtime_uri_invalid");
            if (uri.Scheme != "ws" && uri.Scheme != "wss")
                throw new InvalidDataException("bridge_v4_realtime_uri_invalid");
            if (!IsLocal(uri.Host) && uri.Scheme != "wss")
                throw new InvalidDataException("bridge_v4_realtime_uri_insecure");
            return uri;
        }

        public static void ValidateHostPair(Uri control, Uri realtime)
        {
            if (control == null || realtime == null
                || !string.Equals(control.Host, realtime.Host, StringComparison.OrdinalIgnoreCase)
                || control.Port != realtime.Port)
            {
                throw new InvalidDataException("bridge_v4_endpoint_host_mismatch");
            }
        }

        public static Uri BuildControlPath(Uri control, string path)
        {
            if (control == null || string.IsNullOrWhiteSpace(path)
                || path[0] != '/' || path.IndexOf('?') >= 0 || path.IndexOf('#') >= 0)
            {
                throw new InvalidDataException("bridge_v4_control_path_invalid");
            }
            string authority = control.GetLeftPart(UriPartial.Authority);
            return new Uri(authority + path, UriKind.Absolute);
        }

        public static Uri BuildWebSocketUri(Uri realtime, string websocketPath)
        {
            if (realtime == null || string.IsNullOrWhiteSpace(websocketPath)
                || websocketPath.Length < 2 || websocketPath[0] != '/'
                || websocketPath[1] == '/' || websocketPath.IndexOf('?') >= 0
                || websocketPath.IndexOf('#') >= 0 || websocketPath.IndexOf('\\') >= 0)
            {
                throw new InvalidDataException("bridge_v4_websocket_path_invalid");
            }
            string authority = realtime.GetLeftPart(UriPartial.Authority);
            return new Uri(authority + websocketPath, UriKind.Absolute);
        }

        private static Uri ParseAbsolute(string value, string errorCode)
        {
            Uri uri;
            if (string.IsNullOrWhiteSpace(value) || !Uri.TryCreate(value, UriKind.Absolute, out uri)
                || string.IsNullOrWhiteSpace(uri.Host) || uri.UserInfo.Length != 0
                || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            {
                throw new InvalidDataException(errorCode);
            }
            return uri;
        }

        private static bool IsLocal(string host)
        {
            if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)) return true;
            IPAddress address;
            if (!IPAddress.TryParse(host, out address))
                return host.EndsWith(".local", StringComparison.OrdinalIgnoreCase);
            if (IPAddress.IsLoopback(address)) return true;
            if (address.AddressFamily == AddressFamily.InterNetwork)
            {
                byte[] bytes = address.GetAddressBytes();
                return bytes[0] == 10 || bytes[0] == 127
                    || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
                    || (bytes[0] == 192 && bytes[1] == 168);
            }
            if (address.AddressFamily == AddressFamily.InterNetworkV6)
                return (address.GetAddressBytes()[0] & 0xfe) == 0xfc;
            return false;
        }
    }
}
