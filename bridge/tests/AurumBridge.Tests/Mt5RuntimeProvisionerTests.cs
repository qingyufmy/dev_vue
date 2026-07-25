using System.Text.Json;
using AurumBridge.Protocol;
using AurumBridge.Runtime;
using AurumBridge.Storage;
using AurumBridge.Workers;

namespace AurumBridge.Tests;

[TestClass]
public sealed class Mt5RuntimeProvisionerTests
{
    private string _directory = null!;
    private string _python = null!;
    private string _worker = null!;
    private BridgeStore _store = null!;

    [TestInitialize]
    public async Task InitializeAsync()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-provisioner-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
        _python = Path.Combine(_directory, "python.exe");
        _worker = Path.Combine(_directory, "worker.py");
        File.WriteAllBytes(_python, []);
        File.WriteAllBytes(_worker, []);
        _store = new(Path.Combine(_directory, "bridge.db"));
        await _store.InitializeAsync();
    }

    [TestCleanup]
    public async Task CleanupAsync()
    {
        await _store.DisposeAsync();
        Directory.Delete(_directory, recursive: true);
    }

    [TestMethod]
    public async Task ProvisionsConnectedTerminalsWithDurableIdentity()
    {
        var installation = Installation("one");
        var provisioner = new Mt5RuntimeProvisioner(
            _store,
            _python,
            _worker,
            (value, _) => Task.FromResult(Probe(value, "Broker-Demo", "12345678")),
            () => 1_800_000_000_000);

        var result = await provisioner.ProvisionAsync([installation, installation]);

        Assert.HasCount(1, result.Terminals);
        Assert.IsEmpty(result.Failures);
        var terminal = result.Terminals[0];
        Assert.AreEqual("mt5", terminal.Supervisor.Terminal.Platform);
        Assert.AreEqual("12345678", terminal.Supervisor.Terminal.AccountRef.Login);
        Assert.AreEqual(1L, terminal.Supervisor.Terminal.ConnectionEpoch);
        Assert.HasCount(1, await _store.GetTerminalBindingsAsync());
        await terminal.Supervisor.DisposeAsync();
    }

    [TestMethod]
    public async Task IsolatesProbeFailureFromOtherTerminals()
    {
        var failed = Installation("failed");
        var connected = Installation("connected");
        var provisioner = new Mt5RuntimeProvisioner(
            _store,
            _python,
            _worker,
            (value, _) => value == failed
                ? throw new TimeoutException()
                : Task.FromResult(Probe(value, "Broker-Live", "99")));

        var result = await provisioner.ProvisionAsync([failed, connected]);

        Assert.HasCount(1, result.Terminals);
        Assert.HasCount(1, result.Failures);
        Assert.AreEqual(failed.TerminalInstanceId, result.Failures[0].TerminalInstanceId);
        Assert.AreEqual("mt5_probe_timeout", result.Failures[0].ErrorCode);
        await result.Terminals[0].Supervisor.DisposeAsync();
    }

    private Mt5Installation Installation(string name)
    {
        var directory = Path.Combine(_directory, name);
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "terminal64.exe");
        File.WriteAllBytes(path, []);
        return new(path, "test", true);
    }

    private static Mt5ProbeResult Probe(Mt5Installation installation, string server, string login) => new(
        installation.ExecutablePath,
        new AccountRef(server, login),
        Json("{}"),
        Json("""{"connected":true}"""));

    private static JsonElement Json(string value) => JsonDocument.Parse(value).RootElement.Clone();
}
