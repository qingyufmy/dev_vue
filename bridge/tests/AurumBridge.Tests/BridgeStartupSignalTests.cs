using System.Text.Json;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeStartupSignalTests
{
    [TestMethod]
    public async Task WritesAnAtomicMachineReadableReadySignal()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"aurum-ready-{Guid.NewGuid():N}");
        var path = Path.Combine(directory, "ready.json");
        try
        {
            await BridgeStartupSignal.WriteAsync(path, "3.1.0", () => 1_800_000_000_000);

            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(path));
            Assert.IsTrue(document.RootElement.GetProperty("ready").GetBoolean());
            Assert.AreEqual("3.1.0", document.RootElement.GetProperty("version").GetString());
            Assert.AreEqual(1_800_000_000_000, document.RootElement
                .GetProperty("ready_at_utc_msc").GetInt64());
            Assert.IsFalse(Directory.EnumerateFiles(directory, ".*.tmp").Any());
        }
        finally
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive:true);
            }
        }
    }
}
