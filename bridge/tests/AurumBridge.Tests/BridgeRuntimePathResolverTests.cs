using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeRuntimePathResolverTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-paths-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive: true);

    [TestMethod]
    public void ResolvesInstalledRuntimeLayoutWithoutUserConfiguration()
    {
        var python = CreateFile("runtime", "python", "python.exe");
        var worker = CreateFile("modules", "adapter.mt5.python", "worker.py");

        var paths = BridgeRuntimePathResolver.Resolve(_directory, _ => null);

        Assert.AreEqual(python, paths.PythonExecutable);
        Assert.AreEqual(worker, paths.Mt5WorkerScript);
        Assert.AreEqual(new Uri("https://www.cnfxtrade.com"), paths.ServerBaseUri);
    }

    [TestMethod]
    public void AllowsExplicitDevelopmentOverrides()
    {
        var python = CreateFile("tools", "python.exe");
        var worker = CreateFile("source", "worker.py");
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AURUM_BRIDGE_PYTHON"] = python,
            ["AURUM_BRIDGE_MT5_WORKER"] = worker,
            ["AURUM_BRIDGE_SERVER_URL"] = "http://localhost:3000",
            ["AURUM_BRIDGE_DATA_DIR"] = Path.Combine(_directory, "state"),
        };

        var paths = BridgeRuntimePathResolver.Resolve(
            _directory,
            name => values.GetValueOrDefault(name));

        Assert.AreEqual(python, paths.PythonExecutable);
        Assert.AreEqual(worker, paths.Mt5WorkerScript);
        Assert.AreEqual(new Uri("http://localhost:3000"), paths.ServerBaseUri);
        Assert.AreEqual(Path.Combine(_directory, "state"), paths.DataDirectory);
    }

    [TestMethod]
    public void RejectsConfiguredRuntimeFileThatDoesNotExist()
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AURUM_BRIDGE_PYTHON"] = Path.Combine(_directory, "missing-python.exe"),
        };

        var error = Assert.ThrowsExactly<FileNotFoundException>(() =>
            BridgeRuntimePathResolver.Resolve(_directory, name => values.GetValueOrDefault(name)));

        Assert.AreEqual("mt5_python_runtime_not_found", error.Message);
    }

    private string CreateFile(params string[] parts)
    {
        var path = Path.Combine([_directory, .. parts]);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, []);
        return path;
    }
}
