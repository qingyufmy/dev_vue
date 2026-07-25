using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AurumBridge.Update;

namespace AurumBridge.Tests;

[TestClass]
public sealed class ReleaseUpdateTests
{
    private string _directory = null!;

    [TestInitialize]
    public void Initialize()
    {
        _directory = Path.Combine(Path.GetTempPath(), $"aurum-update-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_directory);
    }

    [TestCleanup]
    public void Cleanup() => Directory.Delete(_directory, recursive: true);

    [TestMethod]
    public void VerifiesCanonicalManifestAndRejectsTampering()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unsigned = Manifest("00" + new string('a', 62), 100, string.Empty);
        var signature = Convert.ToBase64String(signingKey.SignData(
            Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(unsigned)),
            HashAlgorithmName.SHA256));
        var manifest = unsigned with { Signature = signature };
        using var verifier = new ReleaseManifestVerifier(signingKey.ExportSubjectPublicKeyInfoPem());

        verifier.Verify(manifest, new Version(1, 0, 0));
        var tampered = manifest with
        {
            Packages = [manifest.Packages[0] with { SizeBytes = 101 }],
        };

        Assert.ThrowsExactly<InvalidDataException>(() => verifier.Verify(tampered, new Version(1, 0, 0)));
    }

    [TestMethod]
    public async Task DownloadsOnlyExactSizeAndHash()
    {
        var bytes = Encoding.UTF8.GetBytes("verified update payload");
        var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        using var http = new HttpClient(new StaticResponseHandler(bytes));
        var stager = new ReleaseStager(http);
        var package = Manifest(sha256, bytes.Length, "signature").Packages[0];

        var path = await stager.DownloadPackageAsync(package, Path.Combine(_directory, "staging"));

        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(path));
    }

    [TestMethod]
    public async Task FetchesAndVerifiesTheServerManifestBeforeReturningIt()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unsigned = Manifest("00" + new string('a', 62), 100, string.Empty);
        var signed = unsigned with
        {
            Signature = Convert.ToBase64String(signingKey.SignData(
                Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(unsigned)),
                HashAlgorithmName.SHA256)),
        };
        using var http = new HttpClient(new StaticResponseHandler(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(signed))));
        using var verifier = new ReleaseManifestVerifier(signingKey.ExportSubjectPublicKeyInfoPem());
        var client = new ReleaseManifestClient(new Uri("https://www.cnfxtrade.com"), http);

        var fetched = await client.FetchVerifiedAsync(verifier, new Version(1, 0, 0));

        Assert.IsNotNull(fetched);
        Assert.AreEqual("3.1.0", fetched.ReleaseVersion);
    }

    [TestMethod]
    public void RejectsZipTraversalBeforeExtractingAnyFile()
    {
        var package = Path.Combine(_directory, "malicious.zip");
        using (var archive = ZipFile.Open(package, ZipArchiveMode.Create))
        {
            archive.CreateEntry("safe.txt");
            archive.CreateEntry("../escape.txt");
        }
        var target = Path.Combine(_directory, "version");

        Assert.ThrowsExactly<InvalidDataException>(() => ReleaseStager.ExtractPackage(package, target));

        Assert.IsFalse(File.Exists(Path.Combine(target, "safe.txt")));
        Assert.IsFalse(File.Exists(Path.Combine(_directory, "escape.txt")));
    }

    [TestMethod]
    public async Task StagesAllVerifiedModulesIntoAnIsolatedVersionDirectory()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = Zip(("AURUMBridge.exe", "core"), ("runtime/python/python.exe", "python")),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
        };
        using var http = new HttpClient(new PackageResponseHandler(packages));
        var manifest = ManifestForPackages("3.1.0", packages);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        var staged = await installer.StageAsync(manifest, new Version(3, 0, 0));

        Assert.IsNotNull(staged);
        Assert.IsTrue(File.Exists(Path.Combine(staged.VersionDirectory, "AURUMBridge.exe")));
        Assert.IsTrue(File.Exists(Path.Combine(
            staged.VersionDirectory,
            "modules",
            "adapter.mt5.python",
            "worker.py")));
        Assert.IsFalse(Directory.Exists(Path.Combine(_directory, "staging"))
            && Directory.EnumerateFileSystemEntries(Path.Combine(_directory, "staging")).Any());
    }

    [TestMethod]
    public async Task RefusesDowngradeAndIncompatibleModulesBeforeDownloading()
    {
        var handler = new PackageResponseHandler(new Dictionary<string, byte[]>());
        using var http = new HttpClient(handler);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));
        var downgrade = Manifest("00" + new string('a', 62), 100, "signature") with
        {
            ReleaseVersion = "2.9.0",
            Packages =
            [
                Manifest("00" + new string('a', 62), 100, "signature").Packages[0] with
                {
                    Version = "2.9.0",
                },
            ],
        };

        Assert.IsNull(await installer.StageAsync(downgrade, new Version(3, 0, 0)));
        var incompatible = downgrade with
        {
            ReleaseVersion = "3.1.0",
            Packages =
            [
                downgrade.Packages[0] with
                {
                    Version = "3.1.0",
                    MinimumCoreVersion = "4.0.0",
                },
            ],
        };
        await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            installer.StageAsync(incompatible, new Version(3, 0, 0)));
        Assert.AreEqual(0, handler.Requests);
    }

    [TestMethod]
    public async Task CorruptModuleLeavesTheCurrentAndTargetVersionsUntouched()
    {
        var currentDirectory = Path.Combine(_directory, "versions", "3.0.0");
        Directory.CreateDirectory(currentDirectory);
        var currentExecutable = Path.Combine(currentDirectory, "AURUMBridge.exe");
        await File.WriteAllTextAsync(currentExecutable, "current");
        var expectedPackages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = Zip(("AURUMBridge.exe", "next")),
            ["adapter.mt5.python"] = Zip(("worker.py", "expected")),
        };
        var servedPackages = new Dictionary<string, byte[]>(expectedPackages, StringComparer.Ordinal);
        servedPackages["adapter.mt5.python"] = Zip(("worker.py", "corrupt"));
        using var http = new HttpClient(new PackageResponseHandler(servedPackages));
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        await Assert.ThrowsExactlyAsync<InvalidDataException>(() => installer.StageAsync(
            ManifestForPackages("3.1.0", expectedPackages),
            new Version(3, 0, 0)));

        Assert.AreEqual("current", await File.ReadAllTextAsync(currentExecutable));
        Assert.IsFalse(Directory.Exists(Path.Combine(_directory, "versions", "3.1.0")));
        Assert.IsFalse(Directory.EnumerateDirectories(
            Path.Combine(_directory, "versions"),
            ".*.tmp").Any());
    }

    [TestMethod]
    public async Task AtomicallyMarksAStagedVersionPendingWithoutChangingLastKnownGood()
    {
        var versionDirectory = Path.Combine(_directory, "versions", "3.1.0");
        Directory.CreateDirectory(versionDirectory);
        File.WriteAllBytes(Path.Combine(versionDirectory, "AURUMBridge.exe"), []);
        var pointerPath = Path.Combine(_directory, "current.json");
        await File.WriteAllTextAsync(pointerPath, JsonSerializer.Serialize(new ReleaseActivationPointer
        {
            ActiveVersion = "3.0.0",
            LastKnownGoodVersion = "3.0.0",
            Status = "healthy",
            UpdatedAtUtcMsc = 1_800_000_000_000,
        }));
        var store = new ReleaseActivationStore(pointerPath, () => 1_800_000_000_100);

        await store.PrepareActivationAsync(
            new("3.1.0", versionDirectory),
            new Version(3, 0, 0));

        var pointer = JsonSerializer.Deserialize<ReleaseActivationPointer>(
            await File.ReadAllTextAsync(pointerPath));
        Assert.IsNotNull(pointer);
        Assert.AreEqual("3.1.0", pointer.ActiveVersion);
        Assert.AreEqual("3.0.0", pointer.LastKnownGoodVersion);
        Assert.AreEqual("pending", pointer.Status);
    }

    private static ReleaseManifest Manifest(string sha256, long size, string signature) => new()
    {
        ReleaseVersion = "3.1.0",
        GeneratedAtUtcMsc = 1_800_000_000_000,
        MinimumLauncherVersion = "1.0.0",
        Signature = signature,
        Packages =
        [
            new()
            {
                ModuleId = "core",
                Version = "3.1.0",
                Url = new("https://updates.example.com/core-3.1.0.zip"),
                SizeBytes = size,
                Sha256 = sha256,
            },
        ],
    };

    private static ReleaseManifest ManifestForPackages(
        string releaseVersion,
        IReadOnlyDictionary<string, byte[]> packages) => new()
    {
        ReleaseVersion = releaseVersion,
        GeneratedAtUtcMsc = 1_800_000_000_000,
        MinimumLauncherVersion = "1.0.0",
        Signature = "test-signature",
        Packages = packages.Select(pair => new ReleasePackage
        {
            ModuleId = pair.Key,
            Version = releaseVersion,
            Url = new($"https://updates.example.com/{pair.Key}.zip"),
            SizeBytes = pair.Value.Length,
            Sha256 = Convert.ToHexString(SHA256.HashData(pair.Value)).ToLowerInvariant(),
        }).ToArray(),
    };

    private static byte[] Zip(params (string Path, string Content)[] files)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen:true))
        {
            foreach (var file in files)
            {
                var entry = archive.CreateEntry(file.Path);
                using var writer = new StreamWriter(entry.Open(), Encoding.UTF8, leaveOpen:false);
                writer.Write(file.Content);
            }
        }
        return stream.ToArray();
    }

    private sealed class StaticResponseHandler(byte[] payload) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(payload),
            });
    }

    private sealed class PackageResponseHandler(IReadOnlyDictionary<string, byte[]> packages)
        : HttpMessageHandler
    {
        public int Requests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests++;
            var moduleId = Path.GetFileNameWithoutExtension(request.RequestUri!.AbsolutePath);
            if (!packages.TryGetValue(moduleId, out var payload))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(payload),
            });
        }
    }
}
