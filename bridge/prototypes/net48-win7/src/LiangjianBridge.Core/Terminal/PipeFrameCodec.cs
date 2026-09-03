using System;
using System.IO;
using System.Text;

namespace Liangjian.BridgeV4.Terminal
{
    public static class PipeFrameCodec
    {
        public const int MaximumPayloadBytes = 256 * 1024;

        public static void WriteJson(Stream output, string json)
        {
            byte[] payload = new UTF8Encoding(false, true).GetBytes(json ?? string.Empty);
            WritePayload(output, payload);
        }

        public static void WritePayload(Stream output, byte[] payload)
        {
            if (output == null)
            {
                throw new ArgumentNullException("output");
            }
            if (payload == null || payload.Length == 0 || payload.Length > MaximumPayloadBytes)
            {
                throw new InvalidDataException("bridge_pipe_payload_size_invalid");
            }
            byte[] length = BitConverter.GetBytes(payload.Length);
            output.Write(length, 0, length.Length);
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }

        public static string ReadJson(Stream input)
        {
            byte[] payload = ReadPayload(input);
            try
            {
                return new UTF8Encoding(false, true).GetString(payload);
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("bridge_pipe_utf8_invalid");
            }
        }

        public static byte[] ReadPayload(Stream input)
        {
            if (input == null)
            {
                throw new ArgumentNullException("input");
            }
            byte[] lengthBytes = new byte[4];
            ReadExact(input, lengthBytes, 0, lengthBytes.Length);
            int length = BitConverter.ToInt32(lengthBytes, 0);
            if (length <= 0 || length > MaximumPayloadBytes)
            {
                throw new InvalidDataException("bridge_pipe_payload_size_invalid");
            }
            byte[] payload = new byte[length];
            ReadExact(input, payload, 0, length);
            return payload;
        }

        private static void ReadExact(Stream input, byte[] buffer, int offset, int count)
        {
            while (count > 0)
            {
                int read = input.Read(buffer, offset, count);
                if (read <= 0)
                {
                    throw new EndOfStreamException("bridge_pipe_frame_truncated");
                }
                offset += read;
                count -= read;
            }
        }
    }
}
