using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
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
        var unsigned = SignPackages(
            Manifest("00" + new string('a', 62), 100, string.Empty),
            signingKey);
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
    public void SharedNativeManifestFixturePreservesTheDotNetP256Contract()
    {
        var fixtureRoot = Path.Combine(AppContext.BaseDirectory, "update-contract");
        var manifest = JsonSerializer.Deserialize<ReleaseManifest>(File.ReadAllText(
            Path.Combine(fixtureRoot, "manifest-v2.json")))
            ?? throw new InvalidDataException("update_manifest_invalid");
        using var verifier = new ReleaseManifestVerifier(
            File.ReadAllText(Path.Combine(fixtureRoot, "release-public-key.pem")),
            () => 1_800_000_000_100);

        verifier.Verify(manifest, new Version(3, 0, 0));

        Assert.AreEqual("release-fixture-3.1.0", manifest.ReleaseId);
        Assert.AreEqual(3, manifest.Packages.Count);
    }

    [TestMethod]
    public void PreservesTheV1CanonicalSignatureContract()
    {
        var value = Manifest(new string('a', 64), 100, "manifest-signature");

        var canonical = ReleaseManifestVerifier.Canonicalize(value);

        StringAssert.StartsWith(canonical, "AURUM-RELEASE-V1\n1\n3.1.0\n1800000000000\n1.0.0\n");
        StringAssert.Contains(canonical, "core|3.1.0|https://updates.example.com/core-3.1.0.zip|");
    }

    [TestMethod]
    public void VerifiesV2PolicyAndRejectsExpiryOrSignedPolicyTampering()
    {
        const long now = 1_800_000_000_100;
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unsigned = SignPackages(
            ManifestV2("00" + new string('a', 62), 100, string.Empty),
            signingKey);
        var signed = unsigned with
        {
            Signature = Convert.ToBase64String(signingKey.SignData(
                Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(unsigned)),
                HashAlgorithmName.SHA256)),
        };
        using var verifier = new ReleaseManifestVerifier(
            signingKey.ExportSubjectPublicKeyInfoPem(),
            () => now);

        verifier.Verify(signed, new Version(1, 0, 0));

        var priorityTampered = signed with { Priority = "urgent" };
        var priorityError = Assert.ThrowsExactly<InvalidDataException>(() =>
            verifier.Verify(priorityTampered, new Version(1, 0, 0)));
        Assert.AreEqual("update_manifest_signature_invalid", priorityError.Message);

        using var expiredVerifier = new ReleaseManifestVerifier(
            signingKey.ExportSubjectPublicKeyInfoPem(),
            () => signed.ExpiresAtUtcMsc!.Value);
        var expiryError = Assert.ThrowsExactly<InvalidDataException>(() =>
            expiredVerifier.Verify(signed, new Version(1, 0, 0)));
        Assert.AreEqual("update_manifest_invalid", expiryError.Message);
    }

    [TestMethod]
    public void RejectsAPackageWithoutItsOwnValidSignature()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var packagesSigned = SignPackages(
            Manifest("00" + new string('a', 62), 100, string.Empty),
            signingKey);
        var packageTampered = packagesSigned with
        {
            Packages = [packagesSigned.Packages[0] with { Signature = Convert.ToBase64String([1, 2, 3]) }],
        };
        var manifestSigned = packageTampered with
        {
            Signature = Convert.ToBase64String(signingKey.SignData(
                Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(packageTampered)),
                HashAlgorithmName.SHA256)),
        };
        using var verifier = new ReleaseManifestVerifier(signingKey.ExportSubjectPublicKeyInfoPem());

        var error = Assert.ThrowsExactly<InvalidDataException>(() =>
            verifier.Verify(manifestSigned, new Version(1, 0, 0)));

        Assert.AreEqual("update_package_signature_invalid", error.Message);
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
        StringAssert.EndsWith(path, ".zip");
        Assert.IsFalse(Directory.EnumerateFiles(
            Path.GetDirectoryName(path)!, "*.part", SearchOption.TopDirectoryOnly).Any());
    }

    [TestMethod]
    public async Task VerifiesAnOfflinePackageWithoutTrustingItsFileName()
    {
        var bytes = Encoding.UTF8.GetBytes("verified offline payload");
        var sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var package = Manifest(sha256, bytes.Length, "signature").Packages[0];
        var path = Path.Combine(_directory, "renamed-offline-package.zip");
        await File.WriteAllBytesAsync(path, bytes);

        Assert.IsTrue(await ReleaseStager.VerifyPackageFileAsync(package, path, CancellationToken.None));

        bytes[0] ^= 0xff;
        await File.WriteAllBytesAsync(path, bytes);
        Assert.IsFalse(await ReleaseStager.VerifyPackageFileAsync(package, path, CancellationToken.None));
    }

    [TestMethod]
    public async Task FetchesAndVerifiesTheServerManifestBeforeReturningIt()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unsigned = SignPackages(
            Manifest("00" + new string('a', 62), 100, string.Empty),
            signingKey);
        var signed = unsigned with
        {
            Signature = Convert.ToBase64String(signingKey.SignData(
                Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(unsigned)),
                HashAlgorithmName.SHA256)),
        };
        using var http = new HttpClient(new StaticResponseHandler(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(signed))));
        using var verifier = new ReleaseManifestVerifier(signingKey.ExportSubjectPublicKeyInfoPem());
        var client = new ReleaseManifestClient(new Uri("http://127.0.0.1:3000"), http);

        var fetched = await client.FetchVerifiedAsync(
            verifier,
            new Version(1, 0, 0),
            "install_0123456789abcdef0123456789abcdef",
            "stable");

        Assert.IsNotNull(fetched);
        Assert.AreEqual("3.1.0", fetched.ReleaseVersion);
    }

    [TestMethod]
    public async Task ReusesOnlyAVerifiedManifestAfterAnEtagNotModifiedResponse()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unsigned = SignPackages(
            Manifest("00" + new string('a', 62), 100, string.Empty),
            signingKey);
        var signed = unsigned with
        {
            Signature = Convert.ToBase64String(signingKey.SignData(
                Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(unsigned)),
                HashAlgorithmName.SHA256)),
        };
        var handler = new ConditionalManifestHandler(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(signed)));
        using var http = new HttpClient(handler);
        using var verifier = new ReleaseManifestVerifier(signingKey.ExportSubjectPublicKeyInfoPem());
        var client = new ReleaseManifestClient(new Uri("http://127.0.0.1:3000"), http);

        var first = await client.FetchVerifiedAsync(
            verifier, new Version(1, 0, 0),
            "install_0123456789abcdef0123456789abcdef", "stable");
        var second = await client.FetchVerifiedAsync(
            verifier, new Version(1, 0, 0),
            "install_0123456789abcdef0123456789abcdef", "stable");

        Assert.AreSame(first, second);
        Assert.AreEqual(2, handler.Requests);
        Assert.IsTrue(handler.ConditionalRequestObserved);
    }

    [TestMethod]
    public void BoundsManifestCheckBackoffAndJitter()
    {
        Assert.AreEqual(
            TimeSpan.FromSeconds(24),
            BridgeUpdateRetryPolicy.ComputeCheckDelay(1, 0));
        Assert.AreEqual(
            TimeSpan.FromSeconds(36),
            BridgeUpdateRetryPolicy.ComputeCheckDelay(1, 1));
        Assert.AreEqual(
            TimeSpan.FromMinutes(15),
            BridgeUpdateRetryPolicy.ComputeCheckDelay(32, 1));
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() =>
            BridgeUpdateRetryPolicy.ComputeCheckDelay(0, 0.5));
    }

    [TestMethod]
    public void AcceptsOnlyTheCurrentAndBootstrapReleaseEndpoints()
    {
        using var http = new HttpClient(new StaticResponseHandler([]));
        var server = new Uri("http://127.0.0.1:3000");

        _ = new ReleaseManifestClient(server, http, "/api/bridge/v3/releases/current");
        _ = new ReleaseManifestClient(server, http, "/api/bridge/v3/releases/bootstrap");
        var error = Assert.ThrowsExactly<ArgumentException>(() =>
            new ReleaseManifestClient(server, http, "/api/admin/bridge/v3/releases/status"));

        StringAssert.Contains(error.Message, "update_endpoint_path_invalid");
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
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        using var http = new HttpClient(new PackageResponseHandler(packages));
        var manifest = ManifestForPackages("3.1.0", packages);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        var staged = await installer.StageAsync(manifest, new Version(3, 0, 0));

        Assert.IsNotNull(staged);
        Assert.IsTrue(File.Exists(Path.Combine(staged.VersionDirectory, "AURUMBridge.exe")));
        Assert.IsTrue(File.Exists(Path.Combine(staged.VersionDirectory, "e_sqlite3.dll")));
        Assert.IsTrue(File.Exists(Path.Combine(
            staged.VersionDirectory,
            "modules",
            "adapter.mt5.python",
            "worker.py")));
        Assert.IsTrue(File.Exists(Path.Combine(
            staged.VersionDirectory,
            "modules",
            "adapter.mt4",
            "AURUMBridgeEA.ex4")));
        Assert.IsFalse(Directory.Exists(Path.Combine(_directory, "staging"))
            && Directory.EnumerateFileSystemEntries(Path.Combine(_directory, "staging")).Any());
    }

    [TestMethod]
    public async Task ReusesAnIdenticalPreviouslyStagedReleaseAfterRestart()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        var handler = new PackageResponseHandler(packages);
        using var http = new HttpClient(handler);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));
        var manifest = ManifestForPackages("3.1.0", packages);

        var first = await installer.StageAsync(manifest, new Version(3, 0, 0));
        var second = await installer.StageAsync(manifest, new Version(3, 0, 0));

        Assert.IsNotNull(first);
        Assert.IsNotNull(second);
        Assert.AreEqual(first.VersionDirectory, second.VersionDirectory);
        Assert.AreEqual(3, handler.Requests);
    }

    [TestMethod]
    public async Task ReusesUnchangedPackagesByVerifiedSha256AcrossVersions()
    {
        var adapters = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        var firstPackages = new Dictionary<string, byte[]>(adapters, StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
        };
        var secondPackages = new Dictionary<string, byte[]>(adapters, StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(extraFile:("release.txt", "3.2.0")),
        };
        var handler = new VersionedPackageResponseHandler(firstPackages, secondPackages);
        using var http = new HttpClient(handler);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        await installer.StageAsync(
            ManifestForPackages("3.1.0", firstPackages),
            new Version(3, 0, 0));
        handler.UseSecondVersion = true;
        await installer.StageAsync(
            ManifestForPackages("3.2.0", secondPackages),
            new Version(3, 1, 0));

        Assert.AreEqual(4, handler.Requests);
        Assert.AreEqual(4, Directory.EnumerateFiles(
            Path.Combine(_directory, "cache", "packages"),
            "*.zip",
            SearchOption.TopDirectoryOnly).Count());
    }

    [TestMethod]
    public async Task RejectsAndReplacesACorruptedSameSizeCacheEntry()
    {
        var payload = CompleteCoreZip();
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = payload,
        };
        var handler = new PackageResponseHandler(packages);
        using var http = new HttpClient(handler);
        var stager = new ReleaseStager(http);
        var package = ManifestForPackages("3.1.0", packages).Packages.Single();
        var cacheDirectory = Path.Combine(_directory, "cache", "packages");
        var stagingDirectory = Path.Combine(_directory, "staging");
        var cached = await stager.DownloadPackageAsync(
            package,
            stagingDirectory,
            cacheDirectory);
        var corrupted = payload.ToArray();
        corrupted[0] ^= 0xff;
        await File.WriteAllBytesAsync(cached, corrupted);

        var replaced = await stager.DownloadPackageAsync(
            package,
            stagingDirectory,
            cacheDirectory);

        Assert.AreEqual(cached, replaced);
        Assert.AreEqual(2, handler.Requests);
        CollectionAssert.AreEqual(payload, await File.ReadAllBytesAsync(replaced));
        Assert.IsFalse(Directory.EnumerateFiles(
            cacheDirectory, "*.part", SearchOption.TopDirectoryOnly).Any());
    }

    [TestMethod]
    public async Task RejectsInsufficientDiskSpaceBeforeDownloading()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        var handler = new PackageResponseHandler(packages);
        using var http = new HttpClient(handler);
        var installer = new ReleaseInstaller(
            _directory,
            new ReleaseStager(http),
            _ => 1024);

        var error = await Assert.ThrowsExactlyAsync<IOException>(() =>
            installer.StageAsync(
                ManifestForPackages("3.1.0", packages),
                new Version(3, 0, 0)));

        Assert.AreEqual("update_disk_space_insufficient", error.Message);
        Assert.AreEqual(0, handler.Requests);
        Assert.IsFalse(Directory.Exists(Path.Combine(_directory, "versions", "3.1.0")));
    }

    [TestMethod]
    public async Task RemovesStaleInterruptedCachePartsBeforeStaging()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        var cacheDirectory = Path.Combine(_directory, "cache", "packages");
        Directory.CreateDirectory(cacheDirectory);
        var stalePart = Path.Combine(cacheDirectory, ".interrupted.part");
        await File.WriteAllTextAsync(stalePart, "partial");
        using var http = new HttpClient(new PackageResponseHandler(packages));
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        await installer.StageAsync(
            ManifestForPackages("3.1.0", packages),
            new Version(3, 0, 0));

        Assert.IsFalse(File.Exists(stalePart));
    }

    [TestMethod]
    public async Task CarriesSignedV2ActivationPolicyIntoTheStagedRelease()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        using var http = new HttpClient(new PackageResponseHandler(packages));
        var manifest = ManifestForPackages("3.1.0", packages) with
        {
            SchemaVersion = 2,
            ReleaseId = "bridge-3.1.0-20260728.1",
            Priority = "urgent",
            PublishedAtUtcMsc = 1_800_000_000_000,
            ExpiresAtUtcMsc = 1_800_086_400_000,
            MinimumIdleSeconds = 120,
            ActivationDeadlineUtcMsc = 1_800_043_200_000,
            RolloutChannel = "stable",
            RolloutPercentage = 100,
        };
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        var staged = await installer.StageAsync(manifest, new Version(3, 0, 0));

        Assert.IsNotNull(staged);
        Assert.AreEqual("urgent", staged.Priority);
        Assert.AreEqual("bridge-3.1.0-20260728.1", staged.ReleaseId);
        Assert.AreEqual(120, staged.MinimumIdleSeconds);
        Assert.AreEqual(1_800_043_200_000, staged.ActivationDeadlineUtcMsc);
    }

    [TestMethod]
    public async Task RestoresAndRevalidatesASignedStagedReleaseAfterAnInterruptedActivation()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unsigned = SignPackages(ManifestForPackages("3.1.0", packages) with
        {
            SchemaVersion = 2,
            ReleaseId = "bridge-3.1.0-20260728.2",
            Priority = "normal",
            PublishedAtUtcMsc = 1_800_000_000_000,
            ExpiresAtUtcMsc = 1_800_086_400_000,
            MinimumIdleSeconds = 180,
            ActivationDeadlineUtcMsc = 1_800_043_200_000,
            RolloutChannel = "stable",
            RolloutPercentage = 100,
        }, signingKey);
        var signed = unsigned with
        {
            Signature = Convert.ToBase64String(signingKey.SignData(
                Encoding.UTF8.GetBytes(ReleaseManifestVerifier.Canonicalize(unsigned)),
                HashAlgorithmName.SHA256)),
        };
        var handler = new PackageResponseHandler(packages);
        using var http = new HttpClient(handler);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));
        await installer.StageAsync(signed, new Version(3, 0, 0));
        using var verifier = new ReleaseManifestVerifier(
            signingKey.ExportSubjectPublicKeyInfoPem(),
            () => 1_800_000_000_100);

        foreach (var phase in new[]
        {
            BridgeUpdateStates.WaitingWindow,
            BridgeUpdateStates.AcquiringLease,
            BridgeUpdateStates.Draining,
            BridgeUpdateStates.Activating,
        })
        {
            var restored = await installer.RestoreAsync(new()
            {
                State = phase,
                TargetVersion = "3.1.0",
                ReleaseId = signed.ReleaseId,
                Priority = "normal",
                StagedAtUtcMsc = 1_800_000_000_050,
                MinimumIdleSeconds = 180,
                ActivationDeadlineUtcMsc = 1_800_043_200_000,
                UpdatedAtUtcMsc = 1_800_000_000_100,
            }, verifier, new Version(1, 0, 0), new Version(3, 0, 0));

            Assert.IsNotNull(restored, $"phase={phase}");
            Assert.AreEqual("bridge-3.1.0-20260728.2", restored.ReleaseId);
            Assert.AreEqual(180, restored.MinimumIdleSeconds);
        }
        Assert.AreEqual(3, handler.Requests);
    }

    [TestMethod]
    public async Task AtomicallyPersistsAndReloadsTheUpdateState()
    {
        const long now = 1_800_000_000_100;
        var statePath = Path.Combine(_directory, "update-state.json");
        var store = new BridgeUpdateStateStore(statePath, () => now);

        await store.SaveAsync(new()
        {
            State = BridgeUpdateStates.Draining,
            TargetVersion = "3.1.0",
            ReleaseId = "bridge-3.1.0-20260728.1",
            Priority = "normal",
            ManualActivationRequested = true,
            StagedAtUtcMsc = now - 100,
            MinimumIdleSeconds = 180,
            ActivationDeadlineUtcMsc = now + 10_000,
            MaintenanceLeaseId = "lease_test123",
            MaintenanceLeaseExpiresAtUtcMsc = now + 90_000,
            UpdatedAtUtcMsc = 1,
        });
        var restored = await store.LoadAsync();

        Assert.IsNotNull(restored);
        Assert.AreEqual(BridgeUpdateStates.Draining, restored.State);
        Assert.AreEqual("3.1.0", restored.TargetVersion);
        Assert.IsTrue(restored.ManualActivationRequested);
        Assert.AreEqual(180, restored.MinimumIdleSeconds);
        Assert.AreEqual("lease_test123", restored.MaintenanceLeaseId);
        Assert.AreEqual(now + 90_000, restored.MaintenanceLeaseExpiresAtUtcMsc);
        Assert.AreEqual(now, restored.UpdatedAtUtcMsc);
        Assert.IsFalse(Directory.EnumerateFiles(_directory, "*.tmp").Any());
    }

    [TestMethod]
    public async Task CreatesOneStableAnonymousInstallationIdentity()
    {
        var path = Path.Combine(_directory, "installation-id");
        var store = new BridgeInstallationIdentityStore(path);

        var first = await store.LoadOrCreateAsync();
        var second = await store.LoadOrCreateAsync();

        Assert.AreEqual(first, second);
        StringAssert.StartsWith(first, "install_");
        Assert.AreEqual(first, (await File.ReadAllTextAsync(path)).Trim());

        await File.WriteAllTextAsync(path, "invalid identity with spaces");
        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            store.LoadOrCreateAsync());
        Assert.AreEqual("bridge_installation_identity_invalid", error.Message);
    }

    [TestMethod]
    public async Task RejectsUnknownOrIncompletePersistentUpdateState()
    {
        var statePath = Path.Combine(_directory, "update-state.json");
        var store = new BridgeUpdateStateStore(statePath, () => 1_800_000_000_100);
        await File.WriteAllTextAsync(statePath,
            "{\"schema_version\":1,\"state\":\"waiting_window\",\"target_version\":\"3.1.0\",\"priority\":\"normal\",\"updated_at_utc_msc\":1,\"unexpected\":true}");

        var unknown = await Assert.ThrowsExactlyAsync<InvalidDataException>(() => store.LoadAsync());
        Assert.AreEqual("update_state_invalid", unknown.Message);

        var incomplete = await Assert.ThrowsExactlyAsync<InvalidDataException>(() => store.SaveAsync(new()
        {
            State = BridgeUpdateStates.WaitingWindow,
            TargetVersion = "3.1.0",
            Priority = "normal",
            UpdatedAtUtcMsc = 1,
        }));
        Assert.AreEqual("update_state_invalid", incomplete.Message);

        var unpairedLease = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            store.SaveAsync(new()
            {
                State = BridgeUpdateStates.WaitingWindow,
                TargetVersion = "3.1.0",
                Priority = "normal",
                StagedAtUtcMsc = 1,
                MaintenanceLeaseId = "lease_test123",
                UpdatedAtUtcMsc = 1,
            }));
        Assert.AreEqual("update_state_invalid", unpairedLease.Message);

        var rollbackAwaitingLeaseRelease = await store.SaveAsync(new()
        {
            State = BridgeUpdateStates.RolledBack,
            TargetVersion = "3.1.0",
            Priority = "normal",
            MaintenanceLeaseId = "lease_test123",
            MaintenanceLeaseExpiresAtUtcMsc = 1_800_000_090_000,
            LastErrorCode = "launcher_startup_readiness_failed",
            UpdatedAtUtcMsc = 1,
        });
        Assert.AreEqual("lease_test123", rollbackAwaitingLeaseRelease.MaintenanceLeaseId);
    }

    [TestMethod]
    public async Task RejectsAnUpdateWhoseCorePackageOmitsTheNativeSqliteRuntime()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(includeSqlite:false),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        using var http = new HttpClient(new PackageResponseHandler(packages));
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            installer.StageAsync(ManifestForPackages("3.1.0", packages), new Version(3, 0, 0)));

        Assert.AreEqual("update_core_component_missing", error.Message);
        Assert.IsFalse(Directory.Exists(Path.Combine(_directory, "versions", "3.1.0")));
    }

    [TestMethod]
    public async Task RejectsAnUpdateWhoseCorePackageOmitsTheSignedServerAddress()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(includeServerEndpoints:false),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
        };
        using var http = new HttpClient(new PackageResponseHandler(packages));
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            installer.StageAsync(ManifestForPackages("3.1.0", packages), new Version(3, 0, 0)));

        Assert.AreEqual("update_core_component_missing", error.Message);
    }

    [TestMethod]
    public async Task RejectsAManifestMissingEitherTradingPlatformAdapterBeforeDownload()
    {
        var packages = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "worker")),
        };
        var handler = new PackageResponseHandler(packages);
        using var http = new HttpClient(handler);
        var installer = new ReleaseInstaller(_directory, new ReleaseStager(http));

        var error = await Assert.ThrowsExactlyAsync<InvalidDataException>(() =>
            installer.StageAsync(ManifestForPackages("3.1.0", packages), new Version(3, 0, 0)));

        Assert.AreEqual("update_required_package_missing", error.Message);
        Assert.AreEqual(0, handler.Requests);
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
            ["core"] = CompleteCoreZip(),
            ["adapter.mt5.python"] = Zip(("worker.py", "expected")),
            ["adapter.mt4"] = Zip(("AURUMBridgeEA.ex4", "ea")),
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
            new Version(3, 0, 0),
            ["mt5_0123456789abcdef01234567"]);

        var pointer = JsonSerializer.Deserialize<ReleaseActivationPointer>(
            await File.ReadAllTextAsync(pointerPath));
        Assert.IsNotNull(pointer);
        Assert.AreEqual("3.1.0", pointer.ActiveVersion);
        Assert.AreEqual("3.0.0", pointer.LastKnownGoodVersion);
        Assert.AreEqual("pending", pointer.Status);
        CollectionAssert.AreEqual(
            new[] { "mt5_0123456789abcdef01234567" },
            pointer.ExpectedTerminalInstanceIds.ToArray());
    }

    [TestMethod]
    public async Task CoalescesRepeatedManualActivationAndPreservesItAcrossPhaseChanges()
    {
        var statePath = Path.Combine(_directory, "update-state.json");
        await new BridgeUpdateStateStore(statePath).SaveAsync(new()
        {
            State = BridgeUpdateStates.WaitingWindow,
            TargetVersion = "3.1.0",
            ReleaseId = "bridge-3.1.0-manual-test",
            Priority = "normal",
            StagedAtUtcMsc = 1_800_000_000_000,
            UpdatedAtUtcMsc = 1,
        });
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var coordinator = new BridgeUpdateCoordinator(
            new(
                _directory,
                Path.Combine(_directory, "AURUMBridge.Launcher.exe"),
                Path.Combine(_directory, "release-public-key.pem"),
                Path.Combine(_directory, "current.json"),
                new Version(3, 0, 0),
                new Version(1, 0, 0),
                statePath),
            new Uri("https://updates.example.com"),
            new HttpClient(new StaticResponseHandler([])),
            new ReleaseManifestVerifier(signingKey.ExportSubjectPublicKeyInfoPem()));
        var changedCount = 0;
        coordinator.StateChanged += _ => Interlocked.Increment(ref changedCount);

        var requests = await Task.WhenAll(Enumerable.Range(0, 20)
            .Select(_ => coordinator.RequestManualActivationAsync()));

        Assert.IsTrue(requests.All(state => state?.ManualActivationRequested == true));
        Assert.AreEqual(1, changedCount);

        var transitioned = await coordinator.SaveActivationPhaseAsync(
            new(
                "3.1.0",
                Path.Combine(_directory, "versions", "3.1.0"),
                "normal",
                "bridge-3.1.0-manual-test"),
            BridgeUpdateStates.AcquiringLease,
            manualActivationRequested:false);

        Assert.AreEqual(BridgeUpdateStates.AcquiringLease, transitioned.State);
        Assert.IsTrue(transitioned.ManualActivationRequested);
        Assert.IsNotNull(transitioned.ActivationStartedAtUtcMsc);
    }

    [TestMethod]
    public void ResolvesUpdatesOnlyFromACompleteInstalledLayout()
    {
        var applicationDirectory = Path.Combine(_directory, "versions", "3.0.0");
        Directory.CreateDirectory(applicationDirectory);
        File.WriteAllBytes(Path.Combine(_directory, "AURUMBridge.Launcher.exe"), []);
        File.WriteAllText(Path.Combine(_directory, "release-public-key.pem"), "public-key");
        File.WriteAllText(Path.Combine(_directory, "current.json"), "{}");

        var environment = BridgeUpdateCoordinator.ResolveEnvironment(
            applicationDirectory,
            _ => new Version(1, 0, 0));

        Assert.IsNotNull(environment);
        Assert.AreEqual(new Version(3, 0, 0), environment.CurrentVersion);
        Assert.AreEqual(new Version(1, 0, 0), environment.LauncherVersion);
        Assert.AreEqual(Path.Combine(_directory, "update-state.json"), environment.UpdateStatePath);
        Assert.AreEqual(TimeSpan.FromMinutes(15), BridgeUpdateCoordinator.RegularCheckInterval);
        Assert.IsNull(BridgeUpdateCoordinator.ResolveEnvironment(Path.Combine(_directory, "bin", "Debug")));
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
                Signature = "dGVzdC1wYWNrYWdlLXNpZ25hdHVyZQ==",
            },
        ],
    };

    private static ReleaseManifest ManifestV2(string sha256, long size, string signature) =>
        Manifest(sha256, size, signature) with
        {
            SchemaVersion = 2,
            ReleaseId = "bridge-3.1.0-20260728.1",
            Priority = "normal",
            PublishedAtUtcMsc = 1_800_000_000_000,
            ExpiresAtUtcMsc = 1_800_086_400_000,
            MinimumIdleSeconds = 120,
            ActivationDeadlineUtcMsc = null,
            RolloutChannel = "stable",
            RolloutPercentage = 10,
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
            Signature = "dGVzdC1wYWNrYWdlLXNpZ25hdHVyZQ==",
        }).ToArray(),
    };

    private static ReleaseManifest SignPackages(ReleaseManifest manifest, ECDsa signingKey) =>
        manifest with
        {
            Packages = manifest.Packages.Select(package => package with
            {
                Signature = Convert.ToBase64String(signingKey.SignData(
                    Encoding.UTF8.GetBytes(ReleaseManifestVerifier.CanonicalizePackage(package)),
                    HashAlgorithmName.SHA256)),
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

    private static byte[] CompleteCoreZip(
        bool includeSqlite = true,
        bool includeServerEndpoints = true,
        (string Path, string Content)? extraFile = null)
    {
        var files = new List<(string Path, string Content)>
        {
            ("AURUMBridge.exe", "exe"),
            ("AURUMBridge.dll", "app"),
            ("AURUMBridge.runtimeconfig.json", "{}"),
            ("hostfxr.dll", "host"),
            ("coreclr.dll", "runtime"),
            ("Microsoft.Data.Sqlite.dll", "managed-sqlite"),
            ("runtime/python/python.exe", "python"),
        };
        if (includeServerEndpoints)
        {
            files.Add(("server-endpoints.json", "{\"schema_version\":1,\"server_url\":\"http://127.0.0.1:3000\"}"));
        }
        if (includeSqlite)
        {
            files.Add(("e_sqlite3.dll", "native-sqlite"));
        }
        if (extraFile is { } extra)
        {
            files.Add(extra);
        }
        return Zip(files.ToArray());
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

    private sealed class ConditionalManifestHandler(byte[] payload) : HttpMessageHandler
    {
        private static readonly EntityTagHeaderValue Etag = new("\"manifest-test\"");

        public int Requests { get; private set; }
        public bool ConditionalRequestObserved { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests++;
            if (request.Headers.IfNoneMatch.Any(value => value.Tag == Etag.Tag))
            {
                ConditionalRequestObserved = true;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotModified));
            }
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(payload),
            };
            response.Headers.ETag = Etag;
            return Task.FromResult(response);
        }
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

    private sealed class VersionedPackageResponseHandler(
        IReadOnlyDictionary<string, byte[]> firstPackages,
        IReadOnlyDictionary<string, byte[]> secondPackages) : HttpMessageHandler
    {
        public int Requests { get; private set; }
        public bool UseSecondVersion { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests++;
            var packages = UseSecondVersion ? secondPackages : firstPackages;
            var moduleId = Path.GetFileNameWithoutExtension(request.RequestUri!.AbsolutePath);
            return packages.TryGetValue(moduleId, out var payload)
                ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new ByteArrayContent(payload),
                })
                : Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }
}
