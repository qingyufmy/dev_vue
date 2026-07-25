using System.Text.Json;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeFileLoggerTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-logs-{Guid.NewGuid():N}");
    }

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive:true);
        }
    }

    [TestMethod]
    public void RedactsCredentialsBeforeWritingStructuredLog()
    {
        var now = new DateTimeOffset(2026, 7, 25, 12, 0, 0, TimeSpan.Zero);
        using var logger = new BridgeFileLogger(_directory, clock:() => now);

        logger.Info(
            "session_failed",
            "access_token=token-secret Authorization: Bearer bearer-secret ticket=https-secret");

        var text = File.ReadAllText(Directory.GetFiles(_directory).Single());
        Assert.IsFalse(text.Contains("token-secret", StringComparison.Ordinal));
        Assert.IsFalse(text.Contains("bearer-secret", StringComparison.Ordinal));
        Assert.IsFalse(text.Contains("https-secret", StringComparison.Ordinal));
        Assert.HasCount(1, text.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries));
        using var document = JsonDocument.Parse(text);
        Assert.AreEqual("session_failed", document.RootElement.GetProperty("event_name").GetString());
    }

    [TestMethod]
    public void RotatesBySizeAndRetainsOnlyTheConfiguredFileCount()
    {
        var tick = 0;
        using var logger = new BridgeFileLogger(
            _directory,
            maxFileBytes:256,
            retainedFiles:3,
            clock:() => new DateTimeOffset(2026, 7, 25, 12, 0, tick++, TimeSpan.Zero));

        for (var index = 0; index < 20; index++)
        {
            logger.Info("rotation_test", new string('x', 100));
        }

        var files = Directory.GetFiles(_directory, "bridge-*.log");
        Assert.IsGreaterThanOrEqualTo(2, files.Length);
        Assert.IsLessThanOrEqualTo(3, files.Length);
    }
}
