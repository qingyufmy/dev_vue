using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt5TerminalDiscoveryTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-mt5-discovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    [TestMethod]
    public void RunningTerminalWinsAndDuplicateRegistryPathIsRemoved()
    {
        var terminalDirectory = Path.Combine(_directory, "Broker MT5");
        Directory.CreateDirectory(terminalDirectory);
        var executable = Path.Combine(terminalDirectory, "terminal64.exe");
        File.WriteAllBytes(executable, []);

        var result = Mt5TerminalDiscovery.ResolveCandidates([
            new(terminalDirectory, "registry_hkcu"),
            new(executable, "running_process", true),
        ]);

        Assert.HasCount(1, result);
        Assert.IsTrue(result[0].IsRunning);
        Assert.AreEqual("running_process", result[0].Source);
    }

    [TestMethod]
    public void IgnoresDirectoriesWithoutARealTerminalExecutable()
    {
        var result = Mt5TerminalDiscovery.ResolveCandidates([
            new(_directory, "manual"),
            new(Path.Combine(_directory, "missing"), "registry_hkcu"),
        ]);

        Assert.IsEmpty(result);
    }

    [TestMethod]
    public void StableTerminalIdDoesNotExposeTheInstallationPath()
    {
        var first = Mt5TerminalDiscovery.CreateTerminalInstanceId(Path.Combine(_directory, "terminal64.exe"));
        var second = Mt5TerminalDiscovery.CreateTerminalInstanceId(Path.Combine(_directory, "terminal64.exe"));

        Assert.AreEqual(first, second);
        StringAssert.StartsWith(first, "mt5_");
        Assert.DoesNotContain("aurum-mt5-discovery", first);
    }
}
