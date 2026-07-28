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
        var mt4Expert = CreateFile("modules", "adapter.mt4", "AURUMBridgeEA.ex4");

        var paths = BridgeRuntimePathResolver.Resolve(_directory, _ => null);

        Assert.AreEqual(python, paths.PythonExecutable);
        Assert.AreEqual(worker, paths.Mt5WorkerScript);
        Assert.AreEqual(mt4Expert, paths.Mt4ExpertPath);
        Assert.AreEqual(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "AURUM", "BridgeV3", "credential.dat"),
            paths.CredentialPath);
        Assert.AreEqual(new Uri("https://www.cnfxtrade.com"), paths.ServerBaseUri);
        Assert.AreEqual(new Uri("wss://www.cnfxtrade.com"), paths.RealtimeBaseUri);
    }

    [TestMethod]
    public void ResolvesInstallRootFromTheActiveVersionDirectory()
    {
        var installed = Path.Combine(_directory, "versions", "3.2.5");
        Directory.CreateDirectory(installed);

        Assert.AreEqual(
            _directory,
            BridgeRuntimePathResolver.ResolveInstallRoot(installed + Path.DirectorySeparatorChar));
    }

    [TestMethod]
    public void RejectsAnInstallRootOutsideTheVersionedLauncherLayout()
    {
        var error = Assert.ThrowsExactly<InvalidOperationException>(() =>
            BridgeRuntimePathResolver.ResolveInstallRoot(_directory));

        Assert.AreEqual("bridge_install_root_invalid", error.Message);
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
        Assert.AreEqual(Path.Combine(_directory, "state", "credential.dat"), paths.CredentialPath);
        Assert.AreEqual(new Uri("http://localhost:3000"), paths.ServerBaseUri);
        Assert.AreEqual(Path.Combine(_directory, "state"), paths.DataDirectory);
    }

    [TestMethod]
    public void UsesTheServerAddressCarriedInsideTheSignedCorePackage()
    {
        CreateFile("runtime", "python", "python.exe");
        CreateFile("modules", "adapter.mt5.python", "worker.py");
        File.WriteAllText(
            Path.Combine(_directory, "server-endpoints.json"),
            """{"schema_version":1,"server_url":"https://bridge-new.example.com"}""");

        var paths = BridgeRuntimePathResolver.Resolve(_directory, _ => null);

        Assert.AreEqual(new Uri("https://bridge-new.example.com"), paths.ServerBaseUri);
    }

    [TestMethod]
    public void InstalledVersionFailsClosedWhenTheSignedServerAddressIsMissing()
    {
        var installed = Path.Combine(_directory, "versions", "3.2.5");
        CreateFile(installed, "runtime", "python", "python.exe");
        CreateFile(installed, "modules", "adapter.mt5.python", "worker.py");
        CreateFile(installed, "modules", "adapter.mt4", "AURUMBridgeEA.ex4");

        var error = Assert.ThrowsExactly<InvalidDataException>(() =>
            BridgeRuntimePathResolver.Resolve(installed, _ => null));

        Assert.AreEqual("bridge_server_endpoints_missing", error.Message);
    }

    [TestMethod]
    public void ExplicitOperationsOverrideCanRecoverAnInstalledVersionWithAMissingAddressFile()
    {
        var installed = Path.Combine(_directory, "versions", "3.2.5");
        CreateFile(installed, "runtime", "python", "python.exe");
        CreateFile(installed, "modules", "adapter.mt5.python", "worker.py");
        CreateFile(installed, "modules", "adapter.mt4", "AURUMBridgeEA.ex4");

        var paths = BridgeRuntimePathResolver.Resolve(
            installed,
            name => name == "AURUM_BRIDGE_SERVER_URL"
                ? "https://bridge-recovery.example.com"
                : null);

        Assert.AreEqual(new Uri("https://bridge-recovery.example.com"), paths.ServerBaseUri);
    }

    [TestMethod]
    public void EnvironmentOverrideTakesPrecedenceOverThePackagedServerAddress()
    {
        var python = CreateFile("runtime", "python", "python.exe");
        var worker = CreateFile("modules", "adapter.mt5.python", "worker.py");
        File.WriteAllText(
            Path.Combine(_directory, "server-endpoints.json"),
            """{"schema_version":1,"server_url":"https://bridge-new.example.com"}""");
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AURUM_BRIDGE_PYTHON"] = python,
            ["AURUM_BRIDGE_MT5_WORKER"] = worker,
            ["AURUM_BRIDGE_SERVER_URL"] = "http://localhost:3000",
        };

        var paths = BridgeRuntimePathResolver.Resolve(
            _directory,
            name => values.GetValueOrDefault(name));

        Assert.AreEqual(new Uri("http://localhost:3000"), paths.ServerBaseUri);
    }

    [TestMethod]
    public async Task AdminEndpointSettingsOverrideThePackageForEveryRuntimeProfile()
    {
        var python = CreateFile("runtime", "python", "python.exe");
        var worker = CreateFile("modules", "adapter.mt5.python", "worker.py");
        var state = Path.Combine(_directory, "state");
        await new BridgeEndpointSettingsStore(state).SaveAsync(new(
            new Uri("https://control.example.com"),
            new Uri("ws://realtime.example.com:8080")));
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AURUM_BRIDGE_PYTHON"] = python,
            ["AURUM_BRIDGE_MT5_WORKER"] = worker,
            ["AURUM_BRIDGE_DATA_DIR"] = state,
        };

        var paths = BridgeRuntimePathResolver.Resolve(
            _directory,
            name => values.GetValueOrDefault(name),
            "source-1");

        Assert.AreEqual(new Uri("https://control.example.com"), paths.ServerBaseUri);
        Assert.AreEqual(new Uri("ws://realtime.example.com:8080"), paths.RealtimeBaseUri);
    }

    [TestMethod]
    public void DamagedAdminSettingsFallBackToThePackagedOfficialAddress()
    {
        CreateFile("runtime", "python", "python.exe");
        CreateFile("modules", "adapter.mt5.python", "worker.py");
        var state = Path.Combine(_directory, "state");
        Directory.CreateDirectory(state);
        File.WriteAllText(
            Path.Combine(state, BridgeEndpointSettingsStore.FileName),
            "{broken");
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AURUM_BRIDGE_DATA_DIR"] = state,
        };

        var paths = BridgeRuntimePathResolver.Resolve(
            _directory,
            name => values.GetValueOrDefault(name));

        Assert.AreEqual(new Uri("https://www.cnfxtrade.com"), paths.ServerBaseUri);
    }

    [TestMethod]
    public void RejectsAMalformedOrUnsafePackagedServerAddress()
    {
        CreateFile("runtime", "python", "python.exe");
        CreateFile("modules", "adapter.mt5.python", "worker.py");
        File.WriteAllText(
            Path.Combine(_directory, "server-endpoints.json"),
            """{"schema_version":1,"server_url":"http://remote.example.com"}""");

        var error = Assert.ThrowsExactly<InvalidDataException>(() =>
            BridgeRuntimePathResolver.Resolve(_directory, _ => null));

        Assert.AreEqual("bridge_server_url_invalid", error.Message);
    }

    [TestMethod]
    public void ResolvesObserverProfileIntoAnIsolatedStateDirectory()
    {
        var python = CreateFile("tools", "python.exe");
        var worker = CreateFile("source", "worker.py");
        var root = Path.Combine(_directory, "state");
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AURUM_BRIDGE_PYTHON"] = python,
            ["AURUM_BRIDGE_MT5_WORKER"] = worker,
            ["AURUM_BRIDGE_DATA_DIR"] = root,
        };

        var paths = BridgeRuntimePathResolver.Resolve(
            _directory,
            name => values.GetValueOrDefault(name),
            "source-1");

        Assert.AreEqual(Path.Combine(root, "profiles", "source-1"), paths.DataDirectory);
        Assert.AreEqual(
            Path.Combine(root, "profiles", "source-1", "credential.dat"),
            paths.CredentialPath);
    }

    [TestMethod]
    public void DevelopmentLayoutPrefersTheBridgeVirtualEnvironmentOverPathPython()
    {
        var applicationDirectory = Path.Combine(
            _directory, "bridge", "app", "AurumBridge", "bin", "Debug", "net10.0-windows");
        Directory.CreateDirectory(applicationDirectory);
        var bridgePython = CreateFile(".venv-bridge", "Scripts", "python.exe");
        var pathPython = CreateFile("system-python", "python.exe");
        CreateFile("bridge", "adapters", "mt5-python", "worker.py");
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = Path.GetDirectoryName(pathPython)!,
        };

        var paths = BridgeRuntimePathResolver.Resolve(
            applicationDirectory,
            name => values.GetValueOrDefault(name));

        Assert.AreEqual(bridgePython, paths.PythonExecutable);
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

    [TestMethod]
    public void InstalledVersionRejectsAMissingMt4ExpertPackage()
    {
        var applicationDirectory = Path.Combine(_directory, "versions", "3.0.0");
        Directory.CreateDirectory(Path.Combine(applicationDirectory, "runtime", "python"));
        Directory.CreateDirectory(Path.Combine(
            applicationDirectory,
            "modules",
            "adapter.mt5.python"));
        File.WriteAllBytes(Path.Combine(
            applicationDirectory,
            "runtime",
            "python",
            "python.exe"), []);
        File.WriteAllBytes(Path.Combine(
            applicationDirectory,
            "modules",
            "adapter.mt5.python",
            "worker.py"), []);

        var error = Assert.ThrowsExactly<FileNotFoundException>(() =>
            BridgeRuntimePathResolver.Resolve(applicationDirectory, _ => null));

        Assert.AreEqual("mt4_ea_package_not_found", error.Message);
    }

    private string CreateFile(params string[] parts)
    {
        var path = Path.Combine([_directory, .. parts]);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, []);
        return path;
    }
}
