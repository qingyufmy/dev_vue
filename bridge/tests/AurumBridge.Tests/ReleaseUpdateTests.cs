using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
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

    private sealed class StaticResponseHandler(byte[] payload) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(payload),
            });
    }
}
