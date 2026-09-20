using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Transport;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class LoopbackWebSocketSmokeTests
    {
        public static void RunAll()
        {
            foreach (string value in new[] { "ws://example.com/ws", "ws://192.168.1.2/ws",
                "ws://localhost.example.com/ws", "ws://user@localhost/ws", "ws://localhost/ws#fragment",
                "http://localhost/ws", "/relative" })
            {
                Uri uri = new Uri(value, UriKind.RelativeOrAbsolute);
                bool tokenRequested = false;
                try
                {
                    new Rfc6455MessageChannelFactory(uri, delegate { tokenRequested = true; return "test"; }, 3000);
                    throw new Exception("unsafe_factory_accepted");
                }
                catch (InvalidDataException) { }
                Assert(!tokenRequested, "unsafe_endpoint_requested_token");
                try { WebSocketHandshake.BuildRequest(uri, "test", "test"); throw new Exception("unsafe_handshake_accepted"); }
                catch (ArgumentException) { }
                using (Rfc6455Transport transport = new Rfc6455Transport())
                {
                    try { transport.Connect(uri, "test", 3000); throw new Exception("unsafe_transport_accepted"); }
                    catch (ArgumentException) { }
                }
            }
            Assert(WebSocketEndpointPolicy.IsAllowed(new Uri("wss://example.com/ws")), "wss_rejected");
            RoundTrip("localhost", IPAddress.Loopback);
            RoundTrip("127.0.0.1", IPAddress.Loopback);
            RoundTrip("localhost", IPAddress.Loopback, 4503, "bridge_route_storage_unavailable", "bridge_route_storage_unavailable");
            RoundTrip("localhost", IPAddress.Loopback, 4400, "private token=value", "bridge_wss_closed_4400");
            RoundTrip("localhost", IPAddress.Loopback, 1000);
            RoundTrip("localhost", IPAddress.Loopback, 0, "", null, 1400);
            if (Socket.OSSupportsIPv6) RoundTrip("[::1]", IPAddress.IPv6Loopback);
        }

        private static void RoundTrip(string host, IPAddress address, int closeCode = 0, string closeReason = "", string expectedError = null, int responseDelay = 0)
        {
            TcpListener listener = new TcpListener(address, 0);
            listener.Start();
            Exception serverError = null;
            Thread server = new Thread(delegate()
            {
                try
                {
                    using (TcpClient peer = listener.AcceptTcpClient())
                    {
                        peer.ReceiveTimeout = 4000;
                        peer.SendTimeout = 4000;
                        NetworkStream stream = peer.GetStream();
                        StringBuilder headers = new StringBuilder();
                        while (!headers.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
                        {
                            int next = stream.ReadByte();
                            if (next < 0 || headers.Length > 16384) throw new Exception("request_truncated");
                            headers.Append((char)next);
                        }
                        string request = headers.ToString();
                        Assert(request.Contains("Authorization: Bearer test-session-token\r\n"), "token_not_forwarded");
                        string key = null;
                        foreach (string line in request.Split(new[] { "\r\n" }, StringSplitOptions.None))
                            if (line.StartsWith("Sec-WebSocket-Key: ", StringComparison.Ordinal)) key = line.Substring(19);
                        byte[] response = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                            + WebSocketHandshake.ComputeAccept(key) + "\r\n\r\n");
                        stream.Write(response, 0, response.Length);
                        Assert(stream.ReadByte() == 0x81, "client_text_frame_missing");
                        int length = stream.ReadByte();
                        Assert(length == 0x84, "client_frame_not_masked");
                        byte[] mask = new byte[4];
                        for (int i = 0; i < 4; i++) mask[i] = (byte)stream.ReadByte();
                        byte[] payload = new byte[4];
                        for (int i = 0; i < 4; i++) payload[i] = (byte)(stream.ReadByte() ^ mask[i]);
                        Assert(Encoding.UTF8.GetString(payload) == "ping", "client_payload_invalid");
                        if (responseDelay > 0) Thread.Sleep(responseDelay);
                        byte[] frame = new byte[] { 0x81, 4, 112, 111, 110, 103 };
                        if (closeCode != 0)
                        {
                            byte[] reason = Encoding.UTF8.GetBytes(closeReason);
                            frame = new byte[4 + reason.Length];
                            frame[0] = 0x88; frame[1] = (byte)(reason.Length + 2);
                            frame[2] = (byte)(closeCode >> 8); frame[3] = (byte)(closeCode & 255);
                            Array.Copy(reason, 0, frame, 4, reason.Length);
                        }
                        stream.Write(frame, 0, frame.Length);
                        if (closeCode != 0) Assert(stream.ReadByte() == 0x88, "close_not_acknowledged");
                    }
                }
                catch (Exception error) { serverError = error; }
            });
            server.IsBackground = true;
            server.Start();
            try
            {
                Uri uri = new Uri("ws://" + host + ":" + ((IPEndPoint)listener.LocalEndpoint).Port + "/bridge/v4/ws");
                Rfc6455MessageChannelFactory factory = new Rfc6455MessageChannelFactory(uri, delegate { return "test-session-token"; }, responseDelay > 0 ? 1000 : 3000);
                using (IBridgeMessageChannel channel = factory.Connect())
                {
                    channel.Send("ping");
                    if (expectedError == null) Assert(channel.Receive() == (closeCode == 0 ? "pong" : null), "server_payload_invalid");
                    else
                    {
                        try { channel.Receive(); throw new Exception("close_error_lost"); }
                        catch (WebSocketProtocolException error) { Assert(error.Message == expectedError, "close_reason_invalid"); }
                    }
                }
                Assert(server.Join(5000), "server_timeout");
                if (serverError != null) throw serverError;
            }
            finally { listener.Stop(); }
        }

        private static void Assert(bool condition, string reason)
        {
            if (!condition) throw new InvalidOperationException(reason);
        }
    }
}
