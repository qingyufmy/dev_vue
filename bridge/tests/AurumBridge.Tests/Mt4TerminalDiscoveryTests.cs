using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt4TerminalDiscoveryTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-mt4-discovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
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
    public void KeepsOnlyDirectoriesThatContainMql4Data()
    {
        var mt4Data = Path.Combine(_directory, "MT4 Data");
        var mt5Data = Path.Combine(_directory, "MT5 Data");
        Directory.CreateDirectory(Path.Combine(mt4Data, "MQL4"));
        Directory.CreateDirectory(Path.Combine(mt5Data, "MQL5"));

        var result = Mt4TerminalDiscovery.ResolveCandidates([
            new(mt5Data, Path.Combine(_directory, "Broker MT5"), "terminal_data"),
            new(mt4Data, Path.Combine(_directory, "Broker MT4"), "terminal_data"),
        ]);

        Assert.HasCount(1, result);
        Assert.AreEqual(Path.GetFullPath(mt4Data), result[0].TerminalDataPath);
        Assert.AreEqual("Broker MT4", result[0].DisplayName);
    }

    [TestMethod]
    public void RunningCandidateWinsAndDuplicateDataPathIsRemoved()
    {
        var dataPath = Path.Combine(_directory, "MT4 Data");
        Directory.CreateDirectory(Path.Combine(dataPath, "MQL4"));

        var result = Mt4TerminalDiscovery.ResolveCandidates([
            new(dataPath, Path.Combine(_directory, "Broker MT4"), "terminal_data"),
            new(dataPath, Path.Combine(_directory, "Portable MT4"), "running_portable", true),
        ]);

        Assert.HasCount(1, result);
        Assert.IsTrue(result[0].IsRunning);
        Assert.AreEqual("running_portable", result[0].Source);
    }
}
