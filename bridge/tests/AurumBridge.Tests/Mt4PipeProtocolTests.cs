using System.Buffers.Binary;
using System.Text;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4PipeProtocolTests
{
    [TestMethod]
    public void HelloRoundTripsUtf8Identity()
    {
        var hello = new Mt4Hello(
            3,
            "3.0.0",
            @"C:\Users\Trader\AppData\Roaming\MetaQuotes\Terminal\账户一",
            "Broker-Demo",
            "12345678",
            true,
            true);

        var decoded = Mt4PipeProtocol.DecodeHello(Mt4PipeProtocol.EncodeHello(hello));

        Assert.AreEqual(hello, decoded);
    }

    [TestMethod]
    public void DecodesSnapshotIntoValidatedJsonCollections()
    {
        var payload = EncodeRaw(writer =>
        {
            writer.Write((int)Mt4MessageType.Snapshot);
            writer.Write(1_800_000_000_000L);
            WriteString(writer, """{"balance":1000.0}""");
            WriteString(writer, """[{"ticket":"101","symbol":"XAUUSD"}]""");
            WriteString(writer, "[]");
        });

        var snapshot = Mt4PipeProtocol.DecodeSnapshot(payload);

        Assert.AreEqual(1000.0, snapshot.Account.GetProperty("balance").GetDouble());
        Assert.HasCount(1, snapshot.Positions);
        Assert.IsEmpty(snapshot.Orders);
    }

    [TestMethod]
    public async Task FrameReaderRejectsOversizedPayloadBeforeAllocation()
    {
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, Mt4PipeProtocol.MaxFrameBytes + 1);
        await using var stream = new MemoryStream(header);

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => Mt4PipeProtocol.ReadFrameAsync(stream));
    }

    private static byte[] EncodeRaw(Action<BinaryWriter> write)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, new UTF8Encoding(false, true), leaveOpen: true);
        write(writer);
        return stream.ToArray();
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }
}
