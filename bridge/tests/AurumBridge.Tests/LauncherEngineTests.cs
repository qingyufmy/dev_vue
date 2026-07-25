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
        var runner = new FakeRunner(_ => true, startupReady:true);
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_100);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("3.1.0", launched);
        Assert.AreEqual("3.1.0", pointer.LastKnownGoodVersion);
        Assert.AreEqual("healthy", pointer.Status);
        StringAssert.Contains(runner.StartedExecutable!, Path.Combine("3.1.0", "AURUMBridge.exe"));
        Assert.HasCount(1, runner.StartupChecks);
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
    public async Task RollsBackWhenPendingVersionDoesNotCompleteInitialSynchronization()
    {
        CreateVersion("3.0.0");
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        var runner = new FakeRunner(_ => true, startupReady:false);
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_300);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("3.0.0", launched);
        Assert.AreEqual("3.0.0", pointer.ActiveVersion);
        Assert.AreEqual("rolled_back", pointer.Status);
        Assert.HasCount(1, runner.StartupChecks);
        StringAssert.Contains(runner.StartedExecutable!, Path.Combine("3.0.0", "AURUMBridge.exe"));
        Assert.AreEqual(TimeSpan.FromSeconds(30), runner.StartupChecks[0].Timeout);
        Assert.AreEqual(
            TimeSpan.FromSeconds(50),
            runner.HealthChecks.Aggregate(TimeSpan.Zero, (total, check) => total + check.Timeout)
                + runner.StartupChecks[0].Timeout,
            "Pending activation and rollback process budgets must remain below the 60 second acceptance limit.");
    }

    [TestMethod]
    public async Task FailsClosedWhenTheLastKnownGoodVersionAlsoFailsHealthCheck()
    {
        CreateVersion("3.0.0");
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        var runner = new FakeRunner(_ => false);
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_400);

        var error = await Assert.ThrowsExactlyAsync<InvalidOperationException>(() => engine.LaunchAsync());
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("launcher_rollback_health_check_failed", error.Message);
        Assert.AreEqual("3.0.0", pointer.ActiveVersion);
        Assert.AreEqual("rolled_back", pointer.Status);
        Assert.IsNull(runner.StartedExecutable);
        Assert.HasCount(2, runner.HealthChecks);
        Assert.IsTrue(runner.HealthChecks.All(check => check.Timeout == TimeSpan.FromSeconds(10)));
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

    private sealed class FakeRunner(Func<string, bool> health, bool startupReady = true) : IBridgeProcessRunner
    {
        public List<(string ExecutablePath, TimeSpan Timeout)> HealthChecks { get; } = [];
        public List<(string ExecutablePath, TimeSpan Timeout)> StartupChecks { get; } = [];
        public string? StartedExecutable { get; private set; }

        public Task<bool> RunHealthCheckAsync(
            string executablePath,
            TimeSpan timeout,
            CancellationToken cancellationToken = default)
        {
            HealthChecks.Add((executablePath, timeout));
            return Task.FromResult(health(executablePath));
        }

        public void StartBridge(string executablePath) => StartedExecutable = executablePath;

        public Task<bool> StartBridgeAndWaitReadyAsync(
            string executablePath,
            TimeSpan timeout,
            CancellationToken cancellationToken = default)
        {
            StartupChecks.Add((executablePath, timeout));
            if (startupReady)
            {
                StartedExecutable = executablePath;
            }
            return Task.FromResult(startupReady);
        }
    }
}
