using System.Buffers.Binary;
using System.Text.Json;
using AurumBridge.Protocol;

namespace AurumBridge.Workers;

public static class WorkerPipeProtocol
{
    public const int MaxFrameBytes = 4 * 1024 * 1024;

    public static async Task WriteAsync<T>(
        Stream stream,
        T message,
        CancellationToken cancellationToken = default)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, BridgeJson.Options);
        if (payload.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("worker_frame_size_invalid");
        }
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static async Task<JsonDocument> ReadAsync(
        Stream stream,
        CancellationToken cancellationToken = default)
    {
        var header = new byte[4];
        await ReadExactlyAsync(stream, header, cancellationToken);
        var length = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(header));
        if (length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("worker_frame_size_invalid");
        }
        var payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken);
        return JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = 64 });
    }

    private static async Task ReadExactlyAsync(
        Stream stream,
        Memory<byte> buffer,
        CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer[offset..], cancellationToken);
            if (read == 0)
            {
                throw new EndOfStreamException("worker_pipe_closed");
            }
            offset += read;
        }
    }
}
