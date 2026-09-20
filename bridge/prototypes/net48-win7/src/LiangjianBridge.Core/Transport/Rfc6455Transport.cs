using System;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;

namespace Liangjian.BridgeV4.Transport
{
    public sealed class Rfc6455Transport : IDisposable
    {
        private readonly object sendLock = new object();
        private TcpClient client;
        private Stream stream;
        private bool disposed;

        public bool Connected
        {
            get { return !disposed && client != null && client.Connected && stream != null; }
        }

        public void Connect(Uri uri, string bearerToken, int timeoutMilliseconds)
        {
            if (disposed)
            {
                throw new ObjectDisposedException("Rfc6455Transport");
            }
            if (client != null)
            {
                throw new InvalidOperationException("bridge_wss_already_connected");
            }
            if (!WebSocketEndpointPolicy.IsAllowed(uri))
            {
                throw new ArgumentException("bridge_wss_uri_required", "uri");
            }
            if (timeoutMilliseconds < 1000 || timeoutMilliseconds > 60000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }

            bool useTls = uri.Scheme == "wss";
            IPAddress loopback = null;
            if (!useTls)
            {
                // Pin plaintext connections to a numeric loopback address, without DNS resolution.
                loopback = string.Equals(uri.DnsSafeHost, "localhost", StringComparison.OrdinalIgnoreCase)
                    ? IPAddress.Loopback : IPAddress.Parse(uri.DnsSafeHost);
            }
            TcpClient pendingClient = useTls ? new TcpClient() : new TcpClient(loopback.AddressFamily);
            try
            {
                IAsyncResult connect = useTls
                    ? pendingClient.BeginConnect(uri.DnsSafeHost, uri.Port, null, null)
                    : pendingClient.BeginConnect(loopback, uri.Port, null, null);
                if (!connect.AsyncWaitHandle.WaitOne(timeoutMilliseconds))
                {
                    throw new TimeoutException("bridge_wss_connect_timeout");
                }
                pendingClient.EndConnect(connect);
                pendingClient.NoDelay = true;
                pendingClient.ReceiveTimeout = timeoutMilliseconds;
                pendingClient.SendTimeout = timeoutMilliseconds;

                Stream pendingStream = pendingClient.GetStream();
                if (useTls)
                {
                    SslStream tlsStream = new SslStream(pendingStream, false);
                    tlsStream.AuthenticateAsClient(uri.DnsSafeHost, null, SslProtocols.Tls12, true);
                    pendingStream = tlsStream;
                }

                string key = WebSocketHandshake.CreateClientKey();
                byte[] request = Encoding.ASCII.GetBytes(WebSocketHandshake.BuildRequest(uri, key, bearerToken));
                pendingStream.Write(request, 0, request.Length);
                pendingStream.Flush();
                string response = ReadHeaders(pendingStream);
                WebSocketHandshake.ValidateResponse(response, key);

                // The connect/upgrade timeout is not the established session's idle limit.
                // Welcome permits a 60s heartbeat interval and two intervals for its ACK.
                // Keep a bounded transport fallback beyond that application deadline.
                pendingClient.ReceiveTimeout = 185000;

                client = pendingClient;
                stream = pendingStream;
            }
            catch
            {
                pendingClient.Close();
                throw;
            }
        }

        public void SendText(string json)
        {
            EnsureConnected();
            byte[] frame = WebSocketFrameCodec.EncodeClientText(json);
            lock (sendLock)
            {
                stream.Write(frame, 0, frame.Length);
                stream.Flush();
            }
        }

        public string ReceiveText()
        {
            EnsureConnected();
            using (MemoryStream message = new MemoryStream())
            {
                bool started = false;
                while (true)
                {
                    WebSocketFrame frame = WebSocketFrameCodec.ReadServerFrame(stream);
                    if (frame.Opcode == WebSocketOpcode.Ping)
                    {
                        SendControl(WebSocketOpcode.Pong, frame.Payload);
                        continue;
                    }
                    if (frame.Opcode == WebSocketOpcode.Pong)
                    {
                        continue;
                    }
                    if (frame.Opcode == WebSocketOpcode.Close)
                    {
                        string reason = CloseError(frame.Payload);
                        try { SendControl(WebSocketOpcode.Close, frame.Payload); }
                        catch (IOException) { }
                        finally { Dispose(); }
                        if (reason != null) throw new WebSocketProtocolException(reason);
                        return null;
                    }
                    if (frame.Opcode == WebSocketOpcode.Binary)
                    {
                        throw new WebSocketProtocolException("bridge_wss_binary_unsupported");
                    }
                    if (!started && frame.Opcode != WebSocketOpcode.Text)
                    {
                        throw new WebSocketProtocolException("bridge_wss_fragment_start_invalid");
                    }
                    if (started && frame.Opcode != WebSocketOpcode.Continuation)
                    {
                        throw new WebSocketProtocolException("bridge_wss_fragment_sequence_invalid");
                    }
                    started = true;
                    if (message.Length + frame.Payload.Length > WebSocketFrameCodec.MaximumPayloadBytes)
                    {
                        throw new WebSocketProtocolException("bridge_wss_message_too_large");
                    }
                    message.Write(frame.Payload, 0, frame.Payload.Length);
                    if (frame.Final)
                    {
                        try
                        {
                            return new UTF8Encoding(false, true).GetString(message.ToArray());
                        }
                        catch (DecoderFallbackException)
                        {
                            throw new WebSocketProtocolException("bridge_wss_utf8_invalid");
                        }
                    }
                }
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            if (stream != null)
            {
                stream.Dispose();
                stream = null;
            }
            if (client != null)
            {
                client.Close();
                client = null;
            }
        }

        private static string CloseError(byte[] payload)
        {
            if (payload.Length == 0) return null;
            if (payload.Length < 2) return "bridge_wss_close_invalid";
            int code = (payload[0] << 8) | payload[1];
            if (code == 1000 || code == 1001) return null;
            string reason = Encoding.UTF8.GetString(payload, 2, payload.Length - 2);
            if (System.Text.RegularExpressions.Regex.IsMatch(reason, @"\Abridge_[a-z0-9_]{1,116}\z")) return reason;
            return "bridge_wss_closed_" + code.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        private void SendControl(WebSocketOpcode opcode, byte[] payload)
        {
            byte[] frame = WebSocketFrameCodec.EncodeClientFrame(opcode, payload, true);
            lock (sendLock)
            {
                stream.Write(frame, 0, frame.Length);
                stream.Flush();
            }
        }

        private void EnsureConnected()
        {
            if (!Connected)
            {
                throw new InvalidOperationException("bridge_wss_not_connected");
            }
        }

        private static string ReadHeaders(Stream source)
        {
            MemoryStream headers = new MemoryStream();
            int matched = 0;
            byte[] marker = new byte[] { 13, 10, 13, 10 };
            while (headers.Length < 16384)
            {
                int current = source.ReadByte();
                if (current < 0)
                {
                    throw new EndOfStreamException("bridge_wss_handshake_truncated");
                }
                headers.WriteByte((byte)current);
                if (current == marker[matched])
                {
                    matched++;
                    if (matched == marker.Length)
                    {
                        return Encoding.ASCII.GetString(headers.ToArray());
                    }
                }
                else
                {
                    matched = current == marker[0] ? 1 : 0;
                }
            }
            throw new WebSocketProtocolException("bridge_wss_handshake_size_invalid");
        }
    }
}
