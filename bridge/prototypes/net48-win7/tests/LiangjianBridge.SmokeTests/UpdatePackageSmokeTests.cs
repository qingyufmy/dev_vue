using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.SmokeTests
{
    /// <summary>
    /// Offline update-contract tests. The production public key is exercised
    /// with the shared legacy fixture; generated keys are used only for local
    /// package/staging tests and never leave the test process.
    /// </summary>
    public static class UpdatePackageSmokeTests
    {
        private const string PublicKey =
            "-----BEGIN PUBLIC KEY-----\n"
            + "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBg2F2dFgpivr4Z+5JxAkmlh7Pjwb\n"
            + "cnmIegMq2gs1ZDOO1mqnnzrnUyHKCTBvVVe+M+e7/JUvTqKExm+8z0ItIg==\n"
            + "-----END PUBLIC KEY-----";

        private const string LegacyManifest =
            "{\"schema_version\":2,\"release_version\":\"3.1.0\",\"release_id\":\"release-fixture-3.1.0\","
            + "\"generated_at_utc_msc\":1800000000000,\"published_at_utc_msc\":1800000000000,"
            + "\"expires_at_utc_msc\":4102444800000,\"priority\":\"normal\",\"minimum_launcher_version\":\"3.0.0\","
            + "\"minimum_idle_seconds\":120,\"activation_deadline_utc_msc\":null,\"rollout_channel\":\"stable\","
            + "\"rollout_percentage\":100,\"packages\":["
            + "{\"module_id\":\"core\",\"version\":\"3.1.0\",\"url\":\"http://127.0.0.1:3000/bridge/releases/core.zip\","
            + "\"size_bytes\":101,\"sha256\":\"1111111111111111111111111111111111111111111111111111111111111111\","
            + "\"signature\":\"7kHtkUmQJSJfbR/F5wQVUuWFauU3LkHbipNQBBnYwNXxAarT+jrAVhnHtYnS43dXBW8i9ZueuhHfw3NBV6Rhjw==\","
            + "\"minimum_core_version\":null,\"maximum_core_version\":null},"
            + "{\"module_id\":\"adapter.mt5.python\",\"version\":\"3.1.0\",\"url\":\"http://127.0.0.1:3000/bridge/releases/mt5.zip\","
            + "\"size_bytes\":102,\"sha256\":\"2222222222222222222222222222222222222222222222222222222222222222\","
            + "\"signature\":\"RW9bRf2rI2RFDg5XEu/GeyIzpoh23sokEqlT6vgtew0hX24mwAepHWH6ziPetwIaF202Av0HPixQXt0RzGNOHQ==\","
            + "\"minimum_core_version\":\"3.1.0\",\"maximum_core_version\":\"3.1.0\"},"
            + "{\"module_id\":\"adapter.mt4\",\"version\":\"3.1.0\",\"url\":\"http://127.0.0.1:3000/bridge/releases/mt4.zip\","
            + "\"size_bytes\":103,\"sha256\":\"3333333333333333333333333333333333333333333333333333333333333333\","
            + "\"signature\":\"blAzsvEAvyA/lEhez7U//Qs1x6gyftVzeAiTlTOaFPQzDCFNp8jQWfD9/4uBEpm2JEDna6qTOqlaYnTnbvyfRA==\","
            + "\"minimum_core_version\":\"3.1.0\",\"maximum_core_version\":\"3.1.0\"}],"
            + "\"signature\":\"qf/BAz2CinkOMPdB86AtukHVRpU4Hb0lJUV4/f0/JMtCet7UC+FaMy/jo/xG6DHwFsP76VmfH2ZWB+ZvqisouQ==\"}";

        public static void RunAll()
        {
            TestLegacyManifestAndCanonicalization();
            TestManifestSignatureTamper();
            TestPackageSignatureAndHashTamper();
            TestPackageStagingAndIdempotency();
            TestZipTraversalIsRejected();
            TestVersionConflictIsRejected();
        }

        public static void TestLegacyManifestAndCanonicalization()
        {
            using (ReleaseManifestVerifier verifier = new ReleaseManifestVerifier(PublicKey, delegate { return 1800000000100L; }))
            {
                ReleaseManifest manifest = ReleaseManifestParser.Parse(LegacyManifest);
                verifier.Verify(manifest, "3.0.0");
                Assert(manifest.SchemaVersion == 2, "legacy_schema_not_parsed");
                string optionalFieldsOmitted = LegacyManifest
                    .Replace(",\"minimum_idle_seconds\":120", string.Empty)
                    .Replace(",\"activation_deadline_utc_msc\":null", string.Empty)
                    .Replace(",\"minimum_core_version\":null", string.Empty)
                    .Replace(",\"maximum_core_version\":null", string.Empty)
                    .Replace(",\"minimum_core_version\":\"3.1.0\"", string.Empty)
                    .Replace(",\"maximum_core_version\":\"3.1.0\"", string.Empty);
                ReleaseManifest omitted = ReleaseManifestParser.Parse(optionalFieldsOmitted);
                Assert(!omitted.MinimumIdleSeconds.HasValue && !omitted.ActivationDeadlineUtcMsc.HasValue, "optional_manifest_fields_not_omittable");
                Assert(omitted.Packages[0].MinimumCoreVersion == null && omitted.Packages[1].MaximumCoreVersion == null, "optional_package_fields_not_omittable");
                string canonical = ReleaseManifestVerifier.CanonicalizeManifest(manifest);
                Assert(canonical.StartsWith("AURUM-RELEASE-V2\n2\nrelease-fixture-3.1.0\n", StringComparison.Ordinal), "legacy_canonical_prefix_wrong");
                Assert(canonical.IndexOf("adapter.mt4|", StringComparison.Ordinal) < canonical.IndexOf("adapter.mt5.python|", StringComparison.Ordinal), "package_sort_wrong");
            }
        }

        public static void TestManifestSignatureTamper()
        {
            using (ReleaseManifestVerifier verifier = new ReleaseManifestVerifier(PublicKey, delegate { return 1800000000100L; }))
            {
                ReleaseManifest manifest = ReleaseManifestParser.Parse(LegacyManifest);
                manifest.Priority = "urgent";
                AssertThrows<InvalidDataException>(delegate { verifier.Verify(manifest, "3.0.0"); }, "update_manifest_signature_invalid", "manifest_tamper_accepted");
                ReleaseManifest unsupported = ReleaseManifestParser.Parse(LegacyManifest.Replace("\"schema_version\":2", "\"schema_version\":3"));
                AssertThrows<InvalidDataException>(delegate { verifier.Verify(unsupported, "3.0.0"); }, "update_manifest_invalid", "unsupported_schema_accepted");
                AssertThrows<InvalidDataException>(delegate { ReleaseManifestParser.Parse(LegacyManifest.Replace("\"schema_version\":2", "\"schema_version\":2.5")); }, "update_manifest_invalid", "fractional_number_accepted");
            }
        }

        public static void TestPackageSignatureAndHashTamper()
        {
            string root = CreateTempRoot("bridge-v4-update-package-tamper");
            try
            {
                using (GeneratedRelease release = CreateGeneratedRelease(root, "4.0.0.1", "release-tamper-4.0.0.1", "LiangjianBridge.exe"))
                {
                    ReleaseManifest badSignature = CloneManifest(release.Manifest);
                    badSignature.Packages[0].Signature = Convert.ToBase64String(new byte[64]);
                    badSignature.Signature = Sign(release.Signer, ReleaseManifestVerifier.CanonicalizeManifest(badSignature));
                    AssertThrows<InvalidDataException>(delegate { release.Verifier.Verify(badSignature, "4.0.0.0"); }, "update_package_signature_invalid", "package_signature_tamper_accepted");

                    byte[] original = File.ReadAllBytes(release.PackagePath);
                    ReleasePackageStager stager = new ReleasePackageStager(Path.Combine(root, "install"), release.Verifier, "4.0.0.0");
                    byte[] altered = (byte[])original.Clone();
                    altered[0] = (byte)(altered[0] ^ 1);
                    File.WriteAllBytes(release.PackagePath, altered);
                    AssertThrows<InvalidDataException>(delegate
                    {
                        stager.Stage(release.Manifest, new Dictionary<string, string> { { "core", release.PackagePath } });
                    }, "update_package_hash_invalid", "package_hash_tamper_accepted");
                    File.WriteAllBytes(release.PackagePath, new byte[] { 1, 2, 3 });
                    AssertThrows<InvalidDataException>(delegate
                    {
                        stager.Stage(release.Manifest, new Dictionary<string, string> { { "core", release.PackagePath } });
                    }, "update_package_size_invalid", "package_size_tamper_accepted");
                    File.WriteAllBytes(release.PackagePath, original);
                }
            }
            finally
            {
                DeleteTempRoot(root);
            }
        }

        public static void TestPackageStagingAndIdempotency()
        {
            string root = CreateTempRoot("bridge-v4-update-package-stage");
            try
            {
                using (GeneratedRelease release = CreateGeneratedRelease(root, "4.0.0.2", "release-stage-4.0.0.2", "LiangjianBridge.exe"))
                {
                    string installRoot = Path.Combine(root, "install");
                    ReleasePackageStager stager = new ReleasePackageStager(installRoot, release.Verifier, "4.0.0.0");
                    IDictionary<string, string> packages = new Dictionary<string, string> { { "core", release.PackagePath } };
                    ReleaseStageResult first = stager.Stage(release.Manifest, packages);
                    Assert(!first.AlreadyStaged && File.Exists(Path.Combine(first.DirectoryPath, "LiangjianBridge.exe")), "package_stage_failed");
                    Assert(!Directory.Exists(Path.Combine(installRoot, "data")), "stage_touched_data");
                    ReleaseStageResult second = stager.Stage(release.Manifest, packages);
                    Assert(second.AlreadyStaged && string.Equals(second.DirectoryPath, first.DirectoryPath, StringComparison.OrdinalIgnoreCase), "package_stage_not_idempotent");
                }
            }
            finally
            {
                DeleteTempRoot(root);
            }
        }

        public static void TestZipTraversalIsRejected()
        {
            string root = CreateTempRoot("bridge-v4-update-package-traversal");
            try
            {
                using (GeneratedRelease release = CreateGeneratedRelease(root, "4.0.0.3", "release-traversal-4.0.0.3", "../outside.txt", "LiangjianBridge.exe"))
                {
                    ReleasePackageStager stager = new ReleasePackageStager(Path.Combine(root, "install"), release.Verifier, "4.0.0.0");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        stager.Stage(release.Manifest, new Dictionary<string, string> { { "core", release.PackagePath } });
                    }, "update_package_zip_path_invalid", "zip_traversal_accepted");
                    Assert(!File.Exists(Path.Combine(root, "outside.txt")), "zip_traversal_wrote_outside");
                }
            }
            finally
            {
                DeleteTempRoot(root);
            }
        }

        public static void TestVersionConflictIsRejected()
        {
            string root = CreateTempRoot("bridge-v4-update-package-conflict");
            try
            {
                using (GeneratedRelease release = CreateGeneratedRelease(root, "4.0.0.4", "release-conflict-4.0.0.4", "LiangjianBridge.exe"))
                using (GeneratedRelease other = CreateGeneratedRelease(root, "4.0.0.4", "release-other-4.0.0.4", "LiangjianBridge.exe"))
                {
                    string installRoot = Path.Combine(root, "install");
                    ReleasePackageStager firstStager = new ReleasePackageStager(installRoot, release.Verifier, "4.0.0.0");
                    firstStager.Stage(release.Manifest, new Dictionary<string, string> { { "core", release.PackagePath } });
                    ReleasePackageStager secondStager = new ReleasePackageStager(installRoot, other.Verifier, "4.0.0.0");
                    AssertThrows<InvalidDataException>(delegate
                    {
                        secondStager.Stage(other.Manifest, new Dictionary<string, string> { { "core", other.PackagePath } });
                    }, "update_stage_version_conflict", "version_conflict_accepted");
                }
            }
            finally
            {
                DeleteTempRoot(root);
            }
        }

        private static GeneratedRelease CreateGeneratedRelease(string root, string version, string releaseId, params string[] entries)
        {
            string packagePath = Path.Combine(root, releaseId + ".zip");
            CreateZip(packagePath, entries);
            byte[] packageBytes = File.ReadAllBytes(packagePath);
            CngKey key = CngKey.Create(CngAlgorithm.ECDsaP256);
            ECDsaCng signer = new ECDsaCng(key);
            ReleaseManifestVerifier verifier = ReleaseManifestVerifier.FromEccPublicBlob(key.Export(CngKeyBlobFormat.EccPublicBlob), delegate { return 1800000000100L; });
            ReleasePackage package = new ReleasePackage
            {
                ModuleId = "core",
                Version = version,
                Url = "http://127.0.0.1:3000/bridge/releases/core.zip",
                SizeBytes = packageBytes.Length,
                Sha256 = Sha256(packageBytes),
                MinimumCoreVersion = null,
                MaximumCoreVersion = null
            };
            package.Signature = Sign(signer, ReleaseManifestVerifier.CanonicalizePackage(package));
            ReleaseManifest manifest = new ReleaseManifest
            {
                SchemaVersion = 2,
                ReleaseVersion = version,
                ReleaseId = releaseId,
                GeneratedAtUtcMsc = 1800000000000L,
                PublishedAtUtcMsc = 1800000000000L,
                ExpiresAtUtcMsc = 4102444800000L,
                Priority = "normal",
                MinimumLauncherVersion = "4.0.0.0",
                MinimumIdleSeconds = 30,
                ActivationDeadlineUtcMsc = null,
                RolloutChannel = "stable",
                RolloutPercentage = 100,
                Packages = new List<ReleasePackage> { package }
            };
            manifest.Signature = Sign(signer, ReleaseManifestVerifier.CanonicalizeManifest(manifest));
            return new GeneratedRelease { Manifest = manifest, Verifier = verifier, PackagePath = packagePath, Signer = signer, Key = key };
        }

        private static string Sign(ECDsaCng signer, string canonical)
        {
            return Convert.ToBase64String(signer.SignData(Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256));
        }

        private static void CreateZip(string path, params string[] entries)
        {
            using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Create, false, Encoding.UTF8))
            {
                foreach (string name in entries)
                {
                    ZipArchiveEntry entry = archive.CreateEntry(name);
                    using (Stream stream = entry.Open())
                    {
                        byte[] bytes = Encoding.UTF8.GetBytes("fixture:" + name);
                        stream.Write(bytes, 0, bytes.Length);
                    }
                }
            }
        }

        private static ReleaseManifest CloneManifest(ReleaseManifest source)
        {
            ReleaseManifest copy = new ReleaseManifest
            {
                SchemaVersion = source.SchemaVersion,
                ReleaseVersion = source.ReleaseVersion,
                ReleaseId = source.ReleaseId,
                GeneratedAtUtcMsc = source.GeneratedAtUtcMsc,
                PublishedAtUtcMsc = source.PublishedAtUtcMsc,
                ExpiresAtUtcMsc = source.ExpiresAtUtcMsc,
                Priority = source.Priority,
                MinimumLauncherVersion = source.MinimumLauncherVersion,
                MinimumIdleSeconds = source.MinimumIdleSeconds,
                ActivationDeadlineUtcMsc = source.ActivationDeadlineUtcMsc,
                RolloutChannel = source.RolloutChannel,
                RolloutPercentage = source.RolloutPercentage,
                Signature = source.Signature
            };
            foreach (ReleasePackage package in source.Packages)
            {
                copy.Packages.Add(new ReleasePackage
                {
                    ModuleId = package.ModuleId,
                    Version = package.Version,
                    Url = package.Url,
                    SizeBytes = package.SizeBytes,
                    Sha256 = package.Sha256,
                    Signature = package.Signature,
                    MinimumCoreVersion = package.MinimumCoreVersion,
                    MaximumCoreVersion = package.MaximumCoreVersion
                });
            }
            return copy;
        }

        private static string Sha256(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(bytes);
                StringBuilder result = new StringBuilder(64);
                foreach (byte value in digest) result.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
                return result.ToString();
            }
        }

        private static string CreateTempRoot(string name)
        {
            string root = Path.Combine(Path.GetTempPath(), name + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static void DeleteTempRoot(string root)
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private static void AssertThrows<T>(Action action, string expectedCode, string message) where T : Exception
        {
            try
            {
                action();
            }
            catch (T error)
            {
                Assert(error.Message == expectedCode, message + "_wrong_error_" + error.Message);
                return;
            }
            throw new InvalidOperationException(message);
        }

        private sealed class GeneratedRelease : IDisposable
        {
            public ReleaseManifest Manifest;
            public ReleaseManifestVerifier Verifier;
            public string PackagePath;
            public ECDsaCng Signer;
            public CngKey Key;

            public void Dispose()
            {
                if (Verifier != null) Verifier.Dispose();
                if (Signer != null) Signer.Dispose();
                if (Key != null) Key.Dispose();
            }
        }
    }
}
