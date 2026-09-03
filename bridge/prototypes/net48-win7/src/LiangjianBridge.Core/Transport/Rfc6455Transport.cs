using System;
using System.IO;
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
        private SslStream stream;
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
            if (uri == null || !string.Equals(uri.Scheme, "wss", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("bridge_wss_uri_required", "uri");
            }
            if (timeoutMilliseconds < 1000 || timeoutMilliseconds > 60000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }

            TcpClient pendingClient = new TcpClient();
            try
            {
                IAsyncResult connect = pendingClient.BeginConnect(uri.Host, uri.Port, null, null);
                if (!connect.AsyncWaitHandle.WaitOne(timeoutMilliseconds))
                {
                    throw new TimeoutException("bridge_wss_connect_timeout");
                }
                pendingClient.EndConnect(connect);
                pendingClient.NoDelay = true;
                pendingClient.ReceiveTimeout = timeoutMilliseconds;
                pendingClient.SendTimeout = timeoutMilliseconds;

                SslStream pendingStream = new SslStream(pendingClient.GetStream(), false);
                pendingStream.AuthenticateAsClient(uri.Host, null, SslProtocols.Tls12, true);

                string key = WebSocketHandshake.CreateClientKey();
                byte[] request = Encoding.ASCII.GetBytes(WebSocketHandshake.BuildRequest(uri, key, bearerToken));
                pendingStream.Write(request, 0, request.Length);
                pendingStream.Flush();
                string response = ReadHeaders(pendingStream);
                WebSocketHandshake.ValidateResponse(response, key);

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
                        SendControl(WebSocketOpcode.Close, frame.Payload);
                        Dispose();
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
