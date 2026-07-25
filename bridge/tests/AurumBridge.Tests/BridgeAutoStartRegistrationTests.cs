using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeAutoStartRegistrationTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-autostart-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive:true);

    [TestMethod]
    public void RegistersTheStableLauncherAndDoesNotRewriteAnIdenticalValue()
    {
        var applicationDirectory = CreateInstalledLayout("3.1.0");
        var store = new MemoryValueStore();
        var registration = new BridgeAutoStartRegistration(store);

        Assert.IsTrue(registration.EnsureForInstalledApplication(applicationDirectory));
        Assert.AreEqual(
            $"\"{Path.Combine(_directory, "AURUMBridge.Launcher.exe")}\" --autostart",
            store.Value);
        Assert.IsFalse(registration.EnsureForInstalledApplication(applicationDirectory));
        Assert.AreEqual(1, store.Writes);
    }

    [TestMethod]
    public void DoesNotRegisterDevelopmentOrIncompleteLayouts()
    {
        var store = new MemoryValueStore();
        var registration = new BridgeAutoStartRegistration(store);
        var developmentDirectory = Path.Combine(_directory, "bin", "Debug", "net10.0-windows");
        Directory.CreateDirectory(developmentDirectory);

        Assert.IsFalse(registration.EnsureForInstalledApplication(developmentDirectory));
        var installedWithoutLauncher = Path.Combine(_directory, "versions", "3.1.0");
        Directory.CreateDirectory(installedWithoutLauncher);
        Assert.IsFalse(registration.EnsureForInstalledApplication(installedWithoutLauncher));
        Assert.AreEqual(0, store.Writes);
    }

    private string CreateInstalledLayout(string version)
    {
        var applicationDirectory = Path.Combine(_directory, "versions", version);
        Directory.CreateDirectory(applicationDirectory);
        File.WriteAllBytes(Path.Combine(_directory, "AURUMBridge.Launcher.exe"), []);
        return applicationDirectory;
    }

    private sealed class MemoryValueStore : IAutoStartValueStore
    {
        public string? Value { get; private set; }
        public int Writes { get; private set; }
        public string? Read(string valueName) => Value;
        public void Write(string valueName, string command)
        {
            Value = command;
            Writes++;
        }
    }
}
