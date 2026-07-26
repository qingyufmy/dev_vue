using System.Text.Json;
using AurumBridge.Runtime;

namespace AurumBridge.Tests;

[TestClass]
public sealed class BridgeHealthCheckTests
{
    [TestMethod]
    public async Task WritesHealthProofOnlyInsideLauncherDirectory()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aurum-health-{Guid.NewGuid():N}");
        try
        {
            var runtime = CreateFile(root, "runtime", "python.exe");
            var worker = CreateFile(root, "modules", "worker.py");
            var healthRoot = Path.Combine(root, "health");
            var healthFile = Path.Combine(healthRoot, "health-test.json");
            var paths = new BridgeRuntimePaths(
                Path.Combine(root, "data"),
                Path.Combine(root, "data", "credential.dat"),
                runtime,
                worker,
                null,
                new("https://www.cnfxtrade.com"));

            await BridgeHealthCheck.RunAsync(paths, healthFile, healthRoot);
            using var document = JsonDocument.Parse(await File.ReadAllBytesAsync(healthFile));

            Assert.IsTrue(document.RootElement.GetProperty("ok").GetBoolean());
            Assert.AreEqual(3, document.RootElement.GetProperty("checks").GetArrayLength());
            await Assert.ThrowsExactlyAsync<InvalidDataException>(() => BridgeHealthCheck.RunAsync(
                paths,
                Path.Combine(root, "outside.json"),
                healthRoot));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    private static string CreateFile(string root, params string[] parts)
    {
        var path = Path.Combine([root, .. parts]);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, []);
        return path;
    }
}
