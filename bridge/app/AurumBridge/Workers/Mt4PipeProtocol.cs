using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace AurumBridge.Workers;

public enum Mt4MessageType
{
    Hello = 1,
    Welcome = 2,
    Collect = 10,
    Snapshot = 11,
    Command = 20,
    CommandResult = 21,
    Shutdown = 90,
    ShutdownAck = 91,
}

[Flags]
public enum Mt4CollectionStreams
{
    None = 0,
    Account = 1,
    Positions = 2,
    Orders = 4,
    All = Account | Positions | Orders,
}

public sealed record Mt4Hello(
    int ProtocolVersion,
    string AdapterVersion,
    string TerminalDataPath,
    string BrokerServer,
    string Login,
    bool Connected,
    bool TradeAllowed);

public sealed record Mt4Welcome(string TerminalInstanceId, long ConnectionEpoch);

public sealed record Mt4Snapshot(
    long ObservedAtUtcMsc,
    JsonElement Account,
    IReadOnlyList<JsonElement> Positions,
    IReadOnlyList<JsonElement> Orders);

public static class Mt4PipeProtocol
{
    public const int MaxFrameBytes = 4 * 1024 * 1024;
    private const int MaxStringBytes = 2 * 1024 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static byte[] EncodeHello(Mt4Hello hello)
    {
        ArgumentNullException.ThrowIfNull(hello);
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Hello);
            writer.Write(hello.ProtocolVersion);
            WriteString(writer, hello.AdapterVersion);
            WriteString(writer, hello.TerminalDataPath);
            WriteString(writer, hello.BrokerServer);
            WriteString(writer, hello.Login);
            writer.Write(hello.Connected ? 1 : 0);
            writer.Write(hello.TradeAllowed ? 1 : 0);
        });
    }

    public static Mt4Hello DecodeHello(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Hello);
        var result = new Mt4Hello(
            reader.ReadInt32(),
            ReadString(reader, 64),
            ReadString(reader, 32_768),
            ReadString(reader, 128),
            ReadString(reader, 64),
            ReadBoolean(reader),
            ReadBoolean(reader));
        EnsureFullyRead(reader);
        if (result.ProtocolVersion != 3
            || string.IsNullOrWhiteSpace(result.TerminalDataPath)
            || string.IsNullOrWhiteSpace(result.BrokerServer)
            || string.IsNullOrWhiteSpace(result.Login))
        {
            throw new InvalidDataException("mt4_hello_invalid");
        }
        return result;
    }

    public static byte[] EncodeWelcome(Mt4Welcome welcome)
    {
        ArgumentNullException.ThrowIfNull(welcome);
        if (welcome.ConnectionEpoch <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(welcome));
        }
        return Encode(writer =>
        {
            writer.Write((int)Mt4MessageType.Welcome);
            WriteString(writer, welcome.TerminalInstanceId);
            writer.Write(welcome.ConnectionEpoch);
        });
    }

    public static byte[] EncodeCollect(Mt4CollectionStreams streams) => Encode(writer =>
    {
        writer.Write((int)Mt4MessageType.Collect);
        writer.Write((int)streams);
    });

    public static Mt4Snapshot DecodeSnapshot(ReadOnlySpan<byte> payload)
    {
        using var reader = CreateReader(payload, Mt4MessageType.Snapshot);
        var observedAt = reader.ReadInt64();
        var account = ParseObject(ReadString(reader, MaxStringBytes), "mt4_account_snapshot_invalid");
        var positions = ParseArray(ReadString(reader, MaxStringBytes), "mt4_positions_snapshot_invalid");
        var orders = ParseArray(ReadString(reader, MaxStringBytes), "mt4_orders_snapshot_invalid");
        EnsureFullyRead(reader);
        if (observedAt <= 0)
        {
            throw new InvalidDataException("mt4_snapshot_time_invalid");
        }
        return new(observedAt, account, positions, orders);
    }

    public static async Task WriteFrameAsync(
        Stream stream,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (payload.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    public static async Task<byte[]> ReadFrameAsync(
        Stream stream,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var header = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, header, cancellationToken);
        var size = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (size is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        var payload = new byte[size];
        await ReadExactlyAsync(stream, payload, cancellationToken);
        return payload;
    }

    private static byte[] Encode(Action<BinaryWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, StrictUtf8, leaveOpen: true))
        {
            write(writer);
        }
        if (stream.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        return stream.ToArray();
    }

    private static BinaryReader CreateReader(ReadOnlySpan<byte> payload, Mt4MessageType expectedType)
    {
        if (payload.Length is <= 0 or > MaxFrameBytes)
        {
            throw new InvalidDataException("mt4_pipe_frame_size_invalid");
        }
        var reader = new BinaryReader(new MemoryStream(payload.ToArray(), writable: false), StrictUtf8);
        if (reader.ReadInt32() != (int)expectedType)
        {
            reader.Dispose();
            throw new InvalidDataException("mt4_pipe_message_type_invalid");
        }
        return reader;
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        var bytes = StrictUtf8.GetBytes(value ?? string.Empty);
        if (bytes.Length > MaxStringBytes)
        {
            throw new InvalidDataException("mt4_pipe_string_too_large");
        }
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }

    private static string ReadString(BinaryReader reader, int limit)
    {
        var length = reader.ReadInt32();
        if (length < 0 || length > limit || length > reader.BaseStream.Length - reader.BaseStream.Position)
        {
            throw new InvalidDataException("mt4_pipe_string_size_invalid");
        }
        return StrictUtf8.GetString(reader.ReadBytes(length));
    }

    private static bool ReadBoolean(BinaryReader reader) => reader.ReadInt32() switch
    {
        0 => false,
        1 => true,
        _ => throw new InvalidDataException("mt4_pipe_boolean_invalid"),
    };

    private static JsonElement ParseObject(string json, string errorCode)
    {
        try
        {
            var value = JsonSerializer.Deserialize<JsonElement>(json);
            return value.ValueKind == JsonValueKind.Object
                ? value
                : throw new InvalidDataException(errorCode);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException(errorCode, error);
        }
    }

    private static IReadOnlyList<JsonElement> ParseArray(string json, string errorCode)
    {
        try
        {
            var value = JsonSerializer.Deserialize<JsonElement>(json);
            if (value.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException(errorCode);
            }
            return value.EnumerateArray().Select(item => item.Clone()).ToArray();
        }
        catch (JsonException error)
        {
            throw new InvalidDataException(errorCode, error);
        }
    }

    private static void EnsureFullyRead(BinaryReader reader)
    {
        if (reader.BaseStream.Position != reader.BaseStream.Length)
        {
            throw new InvalidDataException("mt4_pipe_trailing_data");
        }
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
                throw new EndOfStreamException("mt4_pipe_closed");
            }
            offset += read;
        }
    }
}
