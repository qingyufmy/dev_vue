using System;
using System.IO;
using System.Text;
using System.Threading;

namespace Liangjian.BridgeV4.Terminal
{
    /// <summary>
    /// The MT5 Python worker uses a four-byte little-endian JSON frame.
    /// It is deliberately separate from the small binary EA frame codec.
    /// </summary>
    public static class Mt5WorkerFrameCodec
    {
        public const int MaximumFrameBytes = 4 * 1024 * 1024;

        public static void WriteJson(Stream output, string json)
        {
            WriteJson(output, json, 600000);
        }

        public static void WriteJson(Stream output, string json, int timeoutMilliseconds)
        {
            if (output == null)
            {
                throw new ArgumentNullException("output");
            }
            if (timeoutMilliseconds < 100 || timeoutMilliseconds > 600000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }
            byte[] payload;
            try
            {
                payload = new UTF8Encoding(false, true).GetBytes(json ?? string.Empty);
            }
            catch (EncoderFallbackException)
            {
                throw new InvalidDataException("bridge_mt5_worker_utf8_invalid");
            }
            if (payload.Length == 0 || payload.Length > MaximumFrameBytes)
            {
                throw new InvalidDataException("bridge_mt5_worker_frame_size_invalid");
            }

            byte[] frame = new byte[payload.Length + 4];
            frame[0] = (byte)(payload.Length & 0xff);
            frame[1] = (byte)((payload.Length >> 8) & 0xff);
            frame[2] = (byte)((payload.Length >> 16) & 0xff);
            frame[3] = (byte)((payload.Length >> 24) & 0xff);
            Buffer.BlockCopy(payload, 0, frame, 4, payload.Length);
            WriteWithTimeout(output, frame, timeoutMilliseconds);
        }

        public static string ReadJson(Stream input)
        {
            return ReadJson(input, 600000);
        }

        public static string ReadJson(Stream input, int timeoutMilliseconds)
        {
            if (input == null)
            {
                throw new ArgumentNullException("input");
            }
            if (timeoutMilliseconds < 100 || timeoutMilliseconds > 600000)
            {
                throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            }
            byte[] lengthBytes = ReadExact(input, 4, timeoutMilliseconds);
            uint length = (uint)(lengthBytes[0]
                | (lengthBytes[1] << 8)
                | (lengthBytes[2] << 16)
                | (lengthBytes[3] << 24));
            if (length == 0 || length > MaximumFrameBytes)
            {
                throw new InvalidDataException("bridge_mt5_worker_frame_size_invalid");
            }
            byte[] payload = ReadExact(input, checked((int)length), timeoutMilliseconds);
            try
            {
                return new UTF8Encoding(false, true).GetString(payload);
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("bridge_mt5_worker_utf8_invalid");
            }
        }

        private static void WriteWithTimeout(Stream output, byte[] buffer, int timeoutMilliseconds)
        {
            IAsyncResult result = output.BeginWrite(buffer, 0, buffer.Length, null, null);
            WaitHandle handle = result.AsyncWaitHandle;
            try
            {
                if (!handle.WaitOne(timeoutMilliseconds))
                {
                    throw new TimeoutException("bridge_mt5_worker_write_timeout");
                }
                output.EndWrite(result);
                output.Flush();
            }
            finally
            {
                handle.Close();
            }
        }

        private static byte[] ReadExact(Stream input, int count, int timeoutMilliseconds)
        {
            byte[] buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                IAsyncResult result = input.BeginRead(buffer, offset, count - offset, null, null);
                WaitHandle handle = result.AsyncWaitHandle;
                int read;
                try
                {
                    if (!handle.WaitOne(timeoutMilliseconds))
                    {
                        throw new TimeoutException("bridge_mt5_worker_read_timeout");
                    }
                    read = input.EndRead(result);
                }
                finally
                {
                    handle.Close();
                }
                if (read <= 0)
                {
                    throw new EndOfStreamException("bridge_mt5_worker_frame_truncated");
                }
                offset += read;
            }
            return buffer;
        }
    }
}
