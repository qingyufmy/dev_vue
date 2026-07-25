using System.Text.Json;
using AurumBridge.Protocol;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeProtocolSerializationTests
{
    [TestMethod]
    public void DataDeltaWritesRequiredNullableSourceTime()
    {
        var message = new DataDeltaMessage
        {
            Type = "data_delta",
            MessageId = "message_01JPROTOCOL01",
            SentAtUtcMsc = 1_800_000_000_000,
            TerminalInstanceId = "terminal_01JPROTOCOL1",
            AccountRef = new("Broker-Demo", "12345678"),
            ConnectionEpoch = 7,
            Stream = "positions",
            Revision = 1,
            BaseRevision = 0,
            ObservedAtUtcMsc = 1_800_000_000_000,
            SourceTimeMsc = null,
            FullSnapshot = true,
            Upserts = [],
            Deletes = [],
        };

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(message, BridgeJson.Options));

        Assert.IsTrue(document.RootElement.TryGetProperty("source_time_msc", out var sourceTime));
        Assert.AreEqual(JsonValueKind.Null, sourceTime.ValueKind);
    }
}
