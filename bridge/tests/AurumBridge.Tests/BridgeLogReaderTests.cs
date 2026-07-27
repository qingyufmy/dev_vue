using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeLogReaderTests
{
    [TestMethod]
    public async Task ReadsRecentActiveLogDirectlyWithAStableLineLimit()
    {
        var directory = Path.Combine(Path.GetTempPath(), "aurum-log-reader-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "bridge-20260726.log");
            await File.WriteAllLinesAsync(path,
            [
                "{\"timestamp_utc\":\"2026-07-26T00:00:00Z\",\"level\":\"info\",\"event_name\":\"first\",\"message\":\"one\"}",
                "{\"timestamp_utc\":\"2026-07-26T00:00:01Z\",\"level\":\"warning\",\"event_name\":\"second\",\"message\":\"two\"}",
                "{\"timestamp_utc\":\"2026-07-26T00:00:02Z\",\"level\":\"error\",\"event_name\":\"third\",\"message\":\"three\"}",
            ]);

            var text = await new BridgeLogReader(directory).ReadRecentTextAsync(maxLines:2);

            Assert.DoesNotContain("first", text);
            StringAssert.Contains(text, "[警告]");
            StringAssert.Contains(text, "second");
            StringAssert.Contains(text, "[错误]");
            StringAssert.Contains(text, "third");
        }
        finally
        {
            Directory.Delete(directory, recursive:true);
        }
    }

    [TestMethod]
    public async Task StopsBeforeOpeningOlderFilesWhenNewestLogsFillTheLimit()
    {
        var directory = Path.Combine(Path.GetTempPath(), "aurum-log-reader-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        FileStream? lockedOlderLog = null;
        try
        {
            var olderPath = Path.Combine(directory, "bridge-20260725.log");
            var newestPath = Path.Combine(directory, "bridge-20260726.log");
            await File.WriteAllTextAsync(olderPath, "older");
            await File.WriteAllLinesAsync(newestPath,
            [
                "newest-one",
                "newest-two",
            ]);
            File.SetLastWriteTimeUtc(olderPath, new DateTime(2026, 7, 25, 0, 0, 0, DateTimeKind.Utc));
            File.SetLastWriteTimeUtc(newestPath, new DateTime(2026, 7, 26, 0, 0, 0, DateTimeKind.Utc));
            lockedOlderLog = new FileStream(
                olderPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);

            var text = await new BridgeLogReader(directory).ReadRecentTextAsync(maxLines:2);

            Assert.IsFalse(text.Contains("older", StringComparison.Ordinal));
            StringAssert.Contains(text, "newest-one");
            StringAssert.Contains(text, "newest-two");
        }
        finally
        {
            lockedOlderLog?.Dispose();
            Directory.Delete(directory, recursive:true);
        }
    }
}
