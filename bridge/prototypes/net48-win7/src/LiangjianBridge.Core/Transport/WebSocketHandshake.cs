using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Liangjian.BridgeV4.Transport
{
    public static class WebSocketHandshake
    {
        private const string WebSocketMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

        public static string CreateClientKey()
        {
            byte[] nonce = new byte[16];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(nonce);
            }
            return Convert.ToBase64String(nonce);
        }

        public static string BuildRequest(Uri uri, string clientKey, string bearerToken)
        {
            if (uri == null || !string.Equals(uri.Scheme, "wss", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("bridge_wss_uri_required", "uri");
            }
            if (string.IsNullOrEmpty(clientKey) || string.IsNullOrEmpty(bearerToken)
                || bearerToken.Length > 4096 || bearerToken.IndexOf('\r') >= 0 || bearerToken.IndexOf('\n') >= 0)
            {
                throw new ArgumentException("bridge_wss_credentials_invalid");
            }

            string path = string.IsNullOrEmpty(uri.PathAndQuery) ? "/" : uri.PathAndQuery;
            string host = uri.IsDefaultPort ? uri.Host : uri.Host + ":" + uri.Port.ToString(CultureInfo.InvariantCulture);
            StringBuilder request = new StringBuilder(512);
            request.Append("GET ").Append(path).Append(" HTTP/1.1\r\n");
            request.Append("Host: ").Append(host).Append("\r\n");
            request.Append("Upgrade: websocket\r\n");
            request.Append("Connection: Upgrade\r\n");
            request.Append("Sec-WebSocket-Key: ").Append(clientKey).Append("\r\n");
            request.Append("Sec-WebSocket-Version: 13\r\n");
            request.Append("Authorization: Bearer ").Append(bearerToken).Append("\r\n");
            request.Append("\r\n");
            return request.ToString();
        }

        public static void ValidateResponse(string responseHeaders, string clientKey)
        {
            if (string.IsNullOrEmpty(responseHeaders) || responseHeaders.Length > 16384)
            {
                throw new WebSocketProtocolException("bridge_wss_handshake_size_invalid");
            }
            string[] lines = responseHeaders.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length < 2 || !lines[0].StartsWith("HTTP/1.1 101 ", StringComparison.Ordinal))
            {
                throw new WebSocketProtocolException("bridge_wss_upgrade_rejected");
            }

            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 1; index < lines.Length; index++)
            {
                int separator = lines[index].IndexOf(':');
                if (separator <= 0)
                {
                    continue;
                }
                headers[lines[index].Substring(0, separator).Trim()] = lines[index].Substring(separator + 1).Trim();
            }

            RequireToken(headers, "Upgrade", "websocket");
            RequireToken(headers, "Connection", "Upgrade");
            string accept;
            if (!headers.TryGetValue("Sec-WebSocket-Accept", out accept) || !FixedTimeEquals(accept, ComputeAccept(clientKey)))
            {
                throw new WebSocketProtocolException("bridge_wss_accept_invalid");
            }
        }

        public static string ComputeAccept(string clientKey)
        {
            byte[] source = Encoding.ASCII.GetBytes(clientKey + WebSocketMagic);
            using (SHA1 sha1 = SHA1.Create())
            {
                return Convert.ToBase64String(sha1.ComputeHash(source));
            }
        }

        private static void RequireToken(IDictionary<string, string> headers, string name, string token)
        {
            string value;
            if (!headers.TryGetValue(name, out value))
            {
                throw new WebSocketProtocolException("bridge_wss_" + name.ToLowerInvariant() + "_missing");
            }
            string[] tokens = value.Split(',');
            foreach (string candidate in tokens)
            {
                if (string.Equals(candidate.Trim(), token, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }
            throw new WebSocketProtocolException("bridge_wss_" + name.ToLowerInvariant() + "_invalid");
        }

        private static bool FixedTimeEquals(string left, string right)
        {
            byte[] a = Encoding.ASCII.GetBytes(left ?? string.Empty);
            byte[] b = Encoding.ASCII.GetBytes(right ?? string.Empty);
            int difference = a.Length ^ b.Length;
            int length = Math.Max(a.Length, b.Length);
            for (int index = 0; index < length; index++)
            {
                byte av = index < a.Length ? a[index] : (byte)0;
                byte bv = index < b.Length ? b[index] : (byte)0;
                difference |= av ^ bv;
            }
            return difference == 0;
        }
    }
}
