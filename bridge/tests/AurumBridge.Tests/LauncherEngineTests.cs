using AurumBridge.Launcher;
using AurumBridge.Runtime;
using System.Text.Json;

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
        await _store.SaveAsync(Pointer(
            "3.1.0",
            "3.0.0",
            "pending",
            ["mt5_0123456789abcdef01234567"]));
        await WriteUpdateStateAsync("3.1.0");
        var runner = new FakeRunner(_ => true, startupReady:true);
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_100);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("3.1.0", launched);
        Assert.AreEqual("3.1.0", pointer.LastKnownGoodVersion);
        Assert.AreEqual("healthy", pointer.Status);
        StringAssert.Contains(runner.StartedExecutable!, Path.Combine("3.1.0", "AURUMBridge.exe"));
        Assert.HasCount(1, runner.StartupChecks);
        Assert.AreEqual("3.1.0", runner.StartupChecks[0].ExpectedVersion);
        Assert.IsFalse(runner.StartupChecks[0].StartMinimized);
        CollectionAssert.AreEqual(
            new[] { "mt5_0123456789abcdef01234567" },
            runner.StartupChecks[0].ExpectedTerminalInstanceIds.ToArray());
        Assert.IsEmpty(pointer.ExpectedTerminalInstanceIds);
        var updateState = await new LauncherUpdateStateStore(
            Path.Combine(_directory, "update-state.json")).LoadAsync();
        Assert.IsNotNull(updateState);
        Assert.AreEqual("healthy", updateState.State);
        Assert.IsNull(updateState.MaintenanceLeaseId);
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
    public async Task PreservesMinimizedStartupAcrossHealthyPendingAndRollbackLaunches()
    {
        CreateVersion("3.0.0");
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        await WriteUpdateStateAsync("3.1.0");
        var runner = new FakeRunner(_ => true, startupReady:false, rollbackReady:true);
        var engine = new LauncherEngine(_directory, _store, runner);

        await engine.LaunchAsync(startMinimized:true);

        Assert.HasCount(2, runner.StartupChecks);
        Assert.IsTrue(runner.StartupChecks.All(check => check.StartMinimized));
        Assert.IsTrue(runner.StartedMinimized);
    }

    [TestMethod]
    public async Task RollsBackWhenPendingVersionDoesNotCompleteInitialSynchronization()
    {
        CreateVersion("3.0.0");
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        await WriteUpdateStateAsync("3.1.0");
        var runner = new FakeRunner(_ => true, startupReady:false);
        var engine = new LauncherEngine(_directory, _store, runner, () => 1_800_000_000_300);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();

        Assert.AreEqual("3.0.0", launched);
        Assert.AreEqual("3.0.0", pointer.ActiveVersion);
        Assert.AreEqual("rolled_back", pointer.Status);
        StringAssert.Contains(runner.StartedExecutable!, Path.Combine("3.0.0", "AURUMBridge.exe"));
        Assert.HasCount(2, runner.StartupChecks);
        Assert.AreEqual(TimeSpan.FromSeconds(20), runner.StartupChecks[0].Timeout);
        Assert.AreEqual(TimeSpan.FromSeconds(25), runner.StartupChecks[1].Timeout);
        var updateState = await new LauncherUpdateStateStore(
            Path.Combine(_directory, "update-state.json")).LoadAsync();
        Assert.IsNotNull(updateState);
        Assert.AreEqual("rolled_back", updateState.State);
        Assert.AreEqual("launcher_startup_readiness_failed", updateState.LastErrorCode);
        Assert.IsNull(updateState.MaintenanceLeaseId);
        Assert.AreEqual(
            TimeSpan.FromSeconds(55),
            runner.HealthChecks.Aggregate(TimeSpan.Zero, (total, check) => total + check.Timeout)
                + runner.StartupChecks.Aggregate(TimeSpan.Zero, (total, check) => total + check.Timeout),
            "Pending activation and rollback process budgets must remain below the 60 second acceptance limit.");
    }

    [TestMethod]
    public async Task RollbackRestoresTheServerAddressCarriedByLastKnownGoodVersion()
    {
        CreateVersion("3.0.0", "https://bridge-old.example.com");
        CreateVersion("3.1.0", "https://bridge-new.example.com");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        await WriteUpdateStateAsync("3.1.0");
        var runner = new FakeRunner(_ => true, startupReady:false, rollbackReady:true);
        var engine = new LauncherEngine(_directory, _store, runner);

        var launched = await engine.LaunchAsync();
        var pointer = await _store.LoadAsync();
        var activeDirectory = Path.Combine(_directory, "versions", pointer.ActiveVersion);
        var runtime = BridgeRuntimePathResolver.Resolve(
            activeDirectory,
            name => name == "AURUM_BRIDGE_DATA_DIR"
                ? Path.Combine(_directory, "state")
                : null);

        Assert.AreEqual("3.0.0", launched);
        Assert.AreEqual("3.0.0", pointer.ActiveVersion);
        Assert.AreEqual(new Uri("https://bridge-old.example.com"), runtime.ServerBaseUri);
        CollectionAssert.AreEqual(
            new[] { "3.1.0", "3.0.0" },
            runner.StartupChecks.Select(check => check.ExpectedVersion).ToArray());
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
        Assert.IsTrue(runner.HealthChecks.All(check => check.Timeout == TimeSpan.FromSeconds(5)));
    }

    [TestMethod]
    public async Task FailsClosedWhenRollbackVersionCannotRestoreExpectedTerminals()
    {
        CreateVersion("3.0.0");
        CreateVersion("3.1.0");
        await _store.SaveAsync(Pointer("3.1.0", "3.0.0", "pending"));
        await WriteUpdateStateAsync("3.1.0");
        var runner = new FakeRunner(_ => true, startupReady:false, rollbackReady:false);
        var engine = new LauncherEngine(_directory, _store, runner);

        var error = await Assert.ThrowsExactlyAsync<InvalidOperationException>(() =>
            engine.LaunchAsync());
        var updateState = await new LauncherUpdateStateStore(
            Path.Combine(_directory, "update-state.json")).LoadAsync();

        Assert.AreEqual("launcher_rollback_startup_failed", error.Message);
        Assert.IsNotNull(updateState);
        Assert.AreEqual("rolled_back", updateState.State);
        Assert.AreEqual("launcher_startup_readiness_failed", updateState.LastErrorCode);
        Assert.AreEqual("lease_test123", updateState.MaintenanceLeaseId);
        Assert.IsNull(runner.StartedExecutable);
    }

    [TestMethod]
    public async Task ValidatesReadySignalVersionConnectionAndExpectedTerminals()
    {
        var path = Path.Combine(_directory, "ready.json");
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new
        {
            ready = true,
            version = "3.1.0",
            server_connected = true,
            running_terminal_instance_ids = new[]
            {
                "mt5_0123456789abcdef01234567",
                "mt4_0123456789abcdef01234567",
            },
        }));

        Assert.IsTrue(await BridgeProcessRunner.IsExpectedReadySignalAsync(
            path,
            "3.1.0",
            ["mt4_0123456789abcdef01234567"]));
        Assert.IsFalse(await BridgeProcessRunner.IsExpectedReadySignalAsync(
            path,
            "3.2.0",
            ["mt4_0123456789abcdef01234567"]));
        Assert.IsFalse(await BridgeProcessRunner.IsExpectedReadySignalAsync(
            path,
            "3.1.0",
            ["mt5_missing"]));
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

    private void CreateVersion(string version, string? serverUrl = null)
    {
        var directory = Path.Combine(_directory, "versions", version);
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(Path.Combine(directory, "AURUMBridge.exe"), []);
        if (serverUrl is null)
        {
            return;
        }
        Directory.CreateDirectory(Path.Combine(directory, "runtime", "python"));
        File.WriteAllBytes(Path.Combine(directory, "runtime", "python", "python.exe"), []);
        Directory.CreateDirectory(Path.Combine(directory, "modules", "adapter.mt5.python"));
        File.WriteAllText(
            Path.Combine(directory, "modules", "adapter.mt5.python", "worker.py"),
            string.Empty);
        Directory.CreateDirectory(Path.Combine(directory, "modules", "adapter.mt4"));
        File.WriteAllBytes(
            Path.Combine(directory, "modules", "adapter.mt4", "AURUMBridgeEA.ex4"),
            []);
        File.WriteAllText(
            Path.Combine(directory, BridgeServerEndpointConfiguration.FileName),
            JsonSerializer.Serialize(new { schema_version = 1, server_url = serverUrl }));
    }

    private static VersionPointer Pointer(
        string active,
        string lastKnownGood,
        string status,
        IReadOnlyList<string>? expectedTerminalInstanceIds = null) => new()
    {
        ActiveVersion = active,
        LastKnownGoodVersion = lastKnownGood,
        Status = status,
        ExpectedTerminalInstanceIds = expectedTerminalInstanceIds ?? [],
        UpdatedAtUtcMsc = 1_800_000_000_000,
    };

    private async Task WriteUpdateStateAsync(string targetVersion)
    {
        await File.WriteAllTextAsync(
            Path.Combine(_directory, "update-state.json"),
            JsonSerializer.Serialize(new LauncherUpdateState
            {
                State = "activating",
                TargetVersion = targetVersion,
                ReleaseId = "bridge-test",
                Priority = "normal",
                StagedAtUtcMsc = 1_800_000_000_000,
                MinimumIdleSeconds = 120,
                MaintenanceLeaseId = "lease_test123",
                MaintenanceLeaseExpiresAtUtcMsc = 1_800_000_090_000,
                UpdatedAtUtcMsc = 1_800_000_000_000,
            }));
    }

    private sealed class FakeRunner(
        Func<string, bool> health,
        bool startupReady = true,
        bool rollbackReady = true) : IBridgeProcessRunner
    {
        public List<(string ExecutablePath, TimeSpan Timeout)> HealthChecks { get; } = [];
        public List<(string ExecutablePath, string ExpectedVersion,
            IReadOnlyList<string> ExpectedTerminalInstanceIds, bool StartMinimized,
            TimeSpan Timeout)> StartupChecks { get; } = [];
        public string? StartedExecutable { get; private set; }
        public bool StartedMinimized { get; private set; }

        public Task<bool> RunHealthCheckAsync(
            string executablePath,
            TimeSpan timeout,
            CancellationToken cancellationToken = default)
        {
            HealthChecks.Add((executablePath, timeout));
            return Task.FromResult(health(executablePath));
        }

        public void StartBridge(string executablePath, bool startMinimized)
        {
            StartedExecutable = executablePath;
            StartedMinimized = startMinimized;
        }

        public Task<bool> StartBridgeAndWaitReadyAsync(
            string executablePath,
            string expectedVersion,
            IReadOnlyList<string> expectedTerminalInstanceIds,
            bool startMinimized,
            TimeSpan timeout,
            CancellationToken cancellationToken = default)
        {
            StartupChecks.Add((
                executablePath,
                expectedVersion,
                expectedTerminalInstanceIds,
                startMinimized,
                timeout));
            var ready = executablePath.Contains("3.0.0", StringComparison.Ordinal)
                ? rollbackReady
                : startupReady;
            if (ready)
            {
                StartedExecutable = executablePath;
                StartedMinimized = startMinimized;
            }
            return Task.FromResult(ready);
        }
    }
}
