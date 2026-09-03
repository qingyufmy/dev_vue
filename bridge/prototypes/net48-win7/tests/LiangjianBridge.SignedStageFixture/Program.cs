using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.SignedStageFixture
{
    internal static class Program
    {
        private static int Main(string[] arguments)
        {
            try
            {
                if (arguments == null || arguments.Length < 4 || arguments.Length % 2 != 0)
                    throw new InvalidDataException("signed_stage_arguments_invalid");

                string installRoot = Path.GetFullPath(arguments[0]);
                string launcherVersion = arguments[1];
                string evidenceRoot = Path.Combine(installRoot, ".signed-rehearsal");
                Directory.CreateDirectory(evidenceRoot);

                using (CngKey key = CngKey.Create(CngAlgorithm.ECDsaP256))
                using (ECDsaCng signer = new ECDsaCng(key))
                using (ReleaseManifestVerifier verifier = new ReleaseManifestVerifier(
                    PublicKeyPem(key.Export(CngKeyBlobFormat.EccPublicBlob))))
                {
                    File.WriteAllText(Path.Combine(evidenceRoot, "release-public-key.pem"),
                        PublicKeyPem(key.Export(CngKeyBlobFormat.EccPublicBlob)), new UTF8Encoding(false));
                    for (int index = 2; index < arguments.Length; index += 2)
                    {
                        Stage(installRoot, evidenceRoot, launcherVersion, arguments[index],
                            arguments[index + 1], signer, verifier);
                    }
                }
                Console.WriteLine("PASS signed_v2_stage");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
        }

        private static void Stage(string installRoot, string evidenceRoot, string launcherVersion,
            string version, string sourceDirectory, ECDsaCng signer,
            ReleaseManifestVerifier verifier)
        {
            Version parsedVersion;
            if (!Version.TryParse(version, out parsedVersion))
                throw new InvalidDataException("signed_stage_version_invalid");
            string source = Path.GetFullPath(sourceDirectory);
            if (!Directory.Exists(source) || !File.Exists(Path.Combine(source, "LiangjianBridge.exe")))
                throw new InvalidDataException("signed_stage_source_invalid");

            string packagePath = Path.Combine(evidenceRoot, "core-" + version + ".zip");
            CreatePackage(source, packagePath);
            byte[] packageBytes = File.ReadAllBytes(packagePath);
            string digest = Sha256(packageBytes);
            ReleasePackage package = new ReleasePackage
            {
                ModuleId = "core",
                Version = version,
                Url = "https://rehearsal.invalid/bridge/" + digest + ".zip",
                SizeBytes = packageBytes.LongLength,
                Sha256 = digest,
                MinimumCoreVersion = null,
                MaximumCoreVersion = null
            };
            package.Signature = Sign(signer, ReleaseManifestVerifier.CanonicalizePackage(package));

            long now = UtcMilliseconds();
            ReleaseManifest manifest = new ReleaseManifest
            {
                SchemaVersion = 2,
                ReleaseVersion = version,
                ReleaseId = "local-rehearsal-" + version + "-" + Guid.NewGuid().ToString("N"),
                GeneratedAtUtcMsc = now,
                PublishedAtUtcMsc = now,
                ExpiresAtUtcMsc = now + 86400000L,
                Priority = "normal",
                MinimumLauncherVersion = launcherVersion,
                MinimumIdleSeconds = 30,
                ActivationDeadlineUtcMsc = null,
                RolloutChannel = "internal",
                RolloutPercentage = 100,
                Packages = new List<ReleasePackage> { package }
            };
            manifest.Signature = Sign(signer, ReleaseManifestVerifier.CanonicalizeManifest(manifest));

            string manifestJson = Serialize(manifest);
            string manifestPath = Path.Combine(evidenceRoot, "manifest-" + version + ".json");
            File.WriteAllText(manifestPath, manifestJson, new UTF8Encoding(false));
            ReleaseManifest parsed = ReleaseManifestParser.Parse(manifestJson);
            verifier.Verify(parsed, launcherVersion);
            ReleasePackageStager stager = new ReleasePackageStager(installRoot, verifier, launcherVersion);
            ReleaseStageResult result = stager.Stage(parsed,
                new Dictionary<string, string> { { "core", packagePath } });
            if (!string.Equals(result.Version, version, StringComparison.Ordinal)
                || !File.Exists(Path.Combine(result.DirectoryPath, "LiangjianBridge.exe")))
                throw new InvalidDataException("signed_stage_result_invalid");
            Console.WriteLine("STAGED " + version + " " + digest + " " + result.DirectoryPath);
        }

        private static void CreatePackage(string sourceDirectory, string packagePath)
        {
            if (File.Exists(packagePath)) File.Delete(packagePath);
            string[] files = Directory.GetFiles(sourceDirectory, "*", SearchOption.AllDirectories);
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            using (FileStream file = new FileStream(packagePath, FileMode.CreateNew,
                FileAccess.Write, FileShare.None))
            using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Create, false, Encoding.UTF8))
            {
                foreach (string path in files)
                {
                    string relative = path.Substring(sourceDirectory.Length)
                        .TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                        .Replace(Path.DirectorySeparatorChar, '/');
                    if (string.Equals(relative, ".release-id", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("signed_stage_reserved_source_path");
                    ZipArchiveEntry entry = archive.CreateEntry(relative, CompressionLevel.Optimal);
                    using (Stream input = File.OpenRead(path))
                    using (Stream output = entry.Open()) input.CopyTo(output);
                }
            }
        }

        private static string Serialize(ReleaseManifest manifest)
        {
            List<Dictionary<string, object>> packages = new List<Dictionary<string, object>>();
            foreach (ReleasePackage package in manifest.Packages)
            {
                packages.Add(new Dictionary<string, object>
                {
                    { "module_id", package.ModuleId }, { "version", package.Version },
                    { "url", package.Url }, { "size_bytes", package.SizeBytes },
                    { "sha256", package.Sha256 }, { "signature", package.Signature },
                    { "minimum_core_version", package.MinimumCoreVersion },
                    { "maximum_core_version", package.MaximumCoreVersion }
                });
            }
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object>
            {
                { "schema_version", manifest.SchemaVersion },
                { "release_version", manifest.ReleaseVersion },
                { "release_id", manifest.ReleaseId },
                { "generated_at_utc_msc", manifest.GeneratedAtUtcMsc },
                { "published_at_utc_msc", manifest.PublishedAtUtcMsc },
                { "expires_at_utc_msc", manifest.ExpiresAtUtcMsc },
                { "priority", manifest.Priority },
                { "minimum_launcher_version", manifest.MinimumLauncherVersion },
                { "minimum_idle_seconds", manifest.MinimumIdleSeconds },
                { "activation_deadline_utc_msc", manifest.ActivationDeadlineUtcMsc },
                { "rollout_channel", manifest.RolloutChannel },
                { "rollout_percentage", manifest.RolloutPercentage },
                { "packages", packages }, { "signature", manifest.Signature }
            });
        }

        private static string PublicKeyPem(byte[] blob)
        {
            byte[] prefix = new byte[] { 0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,
                0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,
                0x42,0x00,0x04 };
            byte[] der = new byte[prefix.Length + 64];
            Array.Copy(prefix, der, prefix.Length);
            Array.Copy(blob, 8, der, prefix.Length, 64);
            return "-----BEGIN PUBLIC KEY-----\n" + Convert.ToBase64String(der)
                + "\n-----END PUBLIC KEY-----";
        }

        private static string Sign(ECDsaCng signer, string canonical)
        {
            return Convert.ToBase64String(signer.SignData(
                Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256));
        }

        private static string Sha256(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                StringBuilder result = new StringBuilder(64);
                foreach (byte value in sha.ComputeHash(bytes))
                    result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                return result.ToString();
            }
        }

        private static long UtcMilliseconds()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
        }
    }
}
