using AurumBridge.Launcher;

namespace AurumBridge.Tests;

[TestClass]
public sealed class LauncherEngineTests
{
    private string _directory = null!;
    private VersionPointerStore _store = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-launcher-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
        _store = new(Path.Combine(_directory, "current.json"));
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive: true);

    [TestMethod]
    public async Task MarksHealthyVersionAsLastKnownGoodBeforeStarting()
    {
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        var runner = new FakeRunner(_ => true);
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_100);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("3.1.0", launched);
        Assert.AreEqual("3.1.0", pointer.LastKnownGoodVersion);
        Assert.AreEqual("healthy", pointer.Status);
        StringAssert.Contains(runner.StartedExecutable!, Path.Combine("3.1.0", "AURUMBridge.exe"));
    }

    [TestMethod]
    public async Task RollsBackBeforeStartingWhenPendingVersionFailsHealthCheck()
    {
        CreateVersion("3.0.0");
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        var runner = new FakeRunner(path => path.Contains("3.0.0", StringComparison.Ordinal));
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_200);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("3.0.0", launched);
        Assert.AreEqual("3.0.0", pointer.ActiveVersion);
        Assert.AreEqual("rolled_back", pointer.Status);
        Assert.HasCount(2, runner.HealthChecks);
        StringAssert.Contains(runner.StartedExecutable!, Path.Combine("3.0.0", "AURUMBridge.exe"));
    }

    [TestMethod]
    public async Task RefusesPointerTraversalAndMissingExecutable()
    {
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            _store.SaveAsync(Pointer("../escape", "3.0.0", "pending")));
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        var engine = new LauncherEngine(_directory, _store, new FakeRunner(_ => true));

        await Assert.ThrowsExactlyAsync<FileNotFoundException>(() => engine.LaunchAsync());
    }

    private void CreateVersion(string version)
    {
        var directory = Path.Combine(_directory, "versions", version);
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(Path.Combine(directory, "AURUMBridge.exe"), []);
    }

    private static VersionPointer Pointer(string active, string lastKnownGood, string status) => new()
    {
        ActiveVersion = active,
        LastKnownGoodVersion = lastKnownGood,
        Status = status,
        UpdatedAtUtcMsc = 1_800_000_000_000,
    };

    private sealed class FakeRunner(Func<string, bool> health) : IBridgeProcessRunner
    {
        public List<string> HealthChecks { get; } = [];
        public string? StartedExecutable { get; private set; }

        public Task<bool> RunHealthCheckAsync(
            string executablePath,
            CancellationToken cancellationToken = default)
        {
            HealthChecks.Add(executablePath);
            return Task.FromResult(health(executablePath));
        }

        public void StartBridge(string executablePath) => StartedExecutable = executablePath;
    }
}
