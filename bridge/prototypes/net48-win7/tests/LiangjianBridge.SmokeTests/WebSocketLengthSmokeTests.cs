using System;
using Liangjian.BridgeV4.Transport;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class WebSocketLengthSmokeTests
    {
        public static void RunAll()
        {
            foreach (int size in new[] { 0, 125, 126, 255, 256, 1024, 65535, 65536, 1048576 })
            {
                byte[] payload = new byte[size];
                for (int i = 0; i < size; i++) payload[i] = (byte)(i % 251);
                byte[] frame = WebSocketFrameCodec.EncodeClientFrame(WebSocketOpcode.Text, payload, true);
                int marker = frame[1] & 127;
                int expectedMarker = size <= 125 ? size : size <= 65535 ? 126 : 127;
                Require(marker == expectedMarker && (frame[1] & 128) != 0, "length_marker_invalid");
                int cursor = 2;
                ulong decoded = (ulong)marker;
                if (marker >= 126)
                {
                    decoded = 0;
                    int count = marker == 126 ? 2 : 8;
                    for (int i = 0; i < count; i++) decoded = (decoded << 8) | frame[cursor++];
                }
                Require(decoded == (ulong)size && frame.Length == cursor + 4 + size, "encoded_length_invalid");
                for (int i = 0; i < size; i++)
                    Require((frame[cursor + 4 + i] ^ frame[cursor + i % 4]) == payload[i], "payload_invalid");
            }
            try
            {
                WebSocketFrameCodec.EncodeClientText(new string('x', 1048577));
                throw new InvalidOperationException("oversize_accepted");
            }
            catch (WebSocketProtocolException) { }
        }

        private static void Require(bool value, string reason)
        {
            if (!value) throw new InvalidOperationException(reason);
        }
    }
}
