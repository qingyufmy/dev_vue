using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Liangjian.BridgeV4.Transport
{
    public enum WebSocketOpcode : byte
    {
        Continuation = 0x0,
        Text = 0x1,
        Binary = 0x2,
        Close = 0x8,
        Ping = 0x9,
        Pong = 0xA
    }

    public sealed class WebSocketFrame
    {
        public WebSocketFrame(bool final, WebSocketOpcode opcode, byte[] payload)
        {
            Final = final;
            Opcode = opcode;
            Payload = payload;
        }

        public bool Final { get; private set; }
        public WebSocketOpcode Opcode { get; private set; }
        public byte[] Payload { get; private set; }
    }

    public static class WebSocketFrameCodec
    {
        public const int MaximumPayloadBytes = 1024 * 1024;

        public static byte[] EncodeClientText(string text)
        {
            return EncodeClientFrame(WebSocketOpcode.Text, Encoding.UTF8.GetBytes(text ?? string.Empty), true);
        }

        public static byte[] EncodeClientFrame(WebSocketOpcode opcode, byte[] payload, bool final)
        {
            payload = payload ?? new byte[0];
            if (payload.Length > MaximumPayloadBytes)
            {
                throw new WebSocketProtocolException("bridge_wss_payload_too_large");
            }
            bool control = ((byte)opcode & 0x08) != 0;
            if (control && (!final || payload.Length > 125))
            {
                throw new WebSocketProtocolException("bridge_wss_control_frame_invalid");
            }

            byte[] mask = new byte[4];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create())
            {
                random.GetBytes(mask);
            }
            using (MemoryStream output = new MemoryStream(payload.Length + 14))
            {
                output.WriteByte((byte)((final ? 0x80 : 0x00) | (byte)opcode));
                WriteLength(output, payload.Length, true);
                output.Write(mask, 0, mask.Length);
                for (int index = 0; index < payload.Length; index++)
                {
                    output.WriteByte((byte)(payload[index] ^ mask[index % 4]));
                }
                return output.ToArray();
            }
        }

        public static WebSocketFrame ReadServerFrame(Stream input)
        {
            int first = ReadByteRequired(input);
            int second = ReadByteRequired(input);
            if ((first & 0x70) != 0)
            {
                throw new WebSocketProtocolException("bridge_wss_rsv_invalid");
            }
            if ((second & 0x80) != 0)
            {
                throw new WebSocketProtocolException("bridge_wss_server_masked_frame");
            }

            bool final = (first & 0x80) != 0;
            WebSocketOpcode opcode = (WebSocketOpcode)(first & 0x0F);
            ValidateOpcode(opcode);
            ulong payloadLength = ReadLength(input, second & 0x7F);
            if (payloadLength > MaximumPayloadBytes)
            {
                throw new WebSocketProtocolException("bridge_wss_payload_too_large");
            }
            bool control = ((byte)opcode & 0x08) != 0;
            if (control && (!final || payloadLength > 125))
            {
                throw new WebSocketProtocolException("bridge_wss_control_frame_invalid");
            }

            byte[] payload = new byte[(int)payloadLength];
            ReadExact(input, payload, 0, payload.Length);
            return new WebSocketFrame(final, opcode, payload);
        }

        private static void WriteLength(Stream output, int length, bool masked)
        {
            int maskFlag = masked ? 0x80 : 0;
            if (length <= 125)
            {
                output.WriteByte((byte)(maskFlag | length));
                return;
            }
            if (length <= ushort.MaxValue)
            {
                output.WriteByte((byte)(maskFlag | 126));
                output.WriteByte((byte)(length >> 8));
                output.WriteByte((byte)length);
                return;
            }
            output.WriteByte((byte)(maskFlag | 127));
            ulong value = (ulong)length;
            for (int shift = 56; shift >= 0; shift -= 8)
            {
                output.WriteByte((byte)(value >> shift));
            }
        }

        private static ulong ReadLength(Stream input, int indicator)
        {
            if (indicator <= 125)
            {
                return (ulong)indicator;
            }
            int bytes = indicator == 126 ? 2 : 8;
            ulong result = 0;
            for (int index = 0; index < bytes; index++)
            {
                result = (result << 8) | (byte)ReadByteRequired(input);
            }
            if ((indicator == 126 && result < 126) || (indicator == 127 && result <= ushort.MaxValue))
            {
                throw new WebSocketProtocolException("bridge_wss_length_not_minimal");
            }
            return result;
        }

        private static void ValidateOpcode(WebSocketOpcode opcode)
        {
            if (opcode != WebSocketOpcode.Continuation && opcode != WebSocketOpcode.Text && opcode != WebSocketOpcode.Binary
                && opcode != WebSocketOpcode.Close && opcode != WebSocketOpcode.Ping && opcode != WebSocketOpcode.Pong)
            {
                throw new WebSocketProtocolException("bridge_wss_opcode_invalid");
            }
        }

        private static int ReadByteRequired(Stream input)
        {
            int value = input.ReadByte();
            if (value < 0)
            {
                throw new EndOfStreamException("bridge_wss_frame_truncated");
            }
            return value;
        }

        private static void ReadExact(Stream input, byte[] buffer, int offset, int count)
        {
            while (count > 0)
            {
                int read = input.Read(buffer, offset, count);
                if (read <= 0)
                {
                    throw new EndOfStreamException("bridge_wss_frame_truncated");
                }
                offset += read;
                count -= read;
            }
        }
    }

    public sealed class WebSocketProtocolException : Exception
    {
        public WebSocketProtocolException(string code)
            : base(code)
        {
        }
    }
}
