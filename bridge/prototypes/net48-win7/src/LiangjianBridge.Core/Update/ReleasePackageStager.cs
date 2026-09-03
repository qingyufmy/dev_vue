using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace Liangjian.BridgeV4.Update
{
    public sealed class ReleaseStageResult
    {
        public string Version { get; internal set; }
        public string ReleaseId { get; internal set; }
        public string DirectoryPath { get; internal set; }
        public bool AlreadyStaged { get; internal set; }
    }

    /// <summary>
    /// Verifies already downloaded signed packages and atomically installs one
    /// release below versions/. User data, profiles and SQLite are outside the
    /// install root and are never opened by this class.
    /// </summary>
    public sealed class ReleasePackageStager
    {
        private const long MaximumExpandedBytes = 1024L * 1024L * 1024L;
        private const int MaximumZipEntries = 4096;
        private readonly string installRoot;
        private readonly string versionsRoot;
        private readonly ReleaseManifestVerifier verifier;
        private readonly string launcherVersion;

        public ReleasePackageStager(string installRoot, ReleaseManifestVerifier verifier, string launcherVersion)
        {
            if (string.IsNullOrWhiteSpace(installRoot) || verifier == null || string.IsNullOrWhiteSpace(launcherVersion))
            {
                throw Invalid("update_stager_configuration_invalid");
            }
            string fullInstallRoot = Path.GetFullPath(installRoot);
            if (string.Equals(fullInstallRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                Path.GetPathRoot(fullInstallRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
            {
                throw Invalid("update_stager_path_invalid");
            }
            this.installRoot = fullInstallRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            versionsRoot = Path.Combine(this.installRoot, "versions");
            this.verifier = verifier;
            this.launcherVersion = launcherVersion;
            EnsureChildPath(versionsRoot, this.installRoot, "update_stager_path_invalid");
        }

        public ReleaseStageResult Stage(ReleaseManifest manifest, IDictionary<string, string> packageFiles)
        {
            if (manifest == null || packageFiles == null)
            {
                throw Invalid("update_stage_input_invalid");
            }
            verifier.Verify(manifest, launcherVersion);
            string versionDirectory = Path.Combine(versionsRoot, manifest.ReleaseVersion);
            EnsureChildPath(versionDirectory, versionsRoot, "update_manifest_version_invalid");
            if (Directory.Exists(versionDirectory))
            {
                return ReadExisting(versionDirectory, manifest);
            }

            if (packageFiles.Count != manifest.Packages.Count)
            {
                throw Invalid("update_package_input_invalid");
            }
            foreach (ReleasePackage package in manifest.Packages)
            {
                string packagePath;
                if (!packageFiles.TryGetValue(package.ModuleId, out packagePath) || string.IsNullOrWhiteSpace(packagePath))
                {
                    throw Invalid("update_package_input_invalid");
                }
                VerifyPackageFile(package, packagePath);
            }

            Directory.CreateDirectory(versionsRoot);
            string stageDirectory = Path.Combine(versionsRoot, ".stage-" + manifest.ReleaseId + "-" + Guid.NewGuid().ToString("N"));
            EnsureChildPath(stageDirectory, versionsRoot, "update_stager_path_invalid");
            HashSet<string> extractedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long expandedBytes = 0;
            try
            {
                Directory.CreateDirectory(stageDirectory);
                foreach (ReleasePackage package in manifest.Packages)
                {
                    ExtractPackage(packageFiles[package.ModuleId], stageDirectory, extractedPaths, ref expandedBytes);
                }
                string executable = Path.Combine(stageDirectory, "LiangjianBridge.exe");
                if (!File.Exists(executable))
                {
                    throw Invalid("update_package_entrypoint_missing");
                }
                WriteMarker(stageDirectory, manifest.ReleaseId);
                try
                {
                    Directory.Move(stageDirectory, versionDirectory);
                    stageDirectory = null;
                }
                catch (IOException)
                {
                    if (!Directory.Exists(versionDirectory))
                    {
                        throw Invalid("update_stage_commit_failed");
                    }
                    ReleaseStageResult existing = ReadExisting(versionDirectory, manifest);
                    stageDirectory = null;
                    return existing;
                }
                return new ReleaseStageResult
                {
                    Version = manifest.ReleaseVersion,
                    ReleaseId = manifest.ReleaseId,
                    DirectoryPath = versionDirectory,
                    AlreadyStaged = false
                };
            }
            finally
            {
                if (!string.IsNullOrEmpty(stageDirectory) && Directory.Exists(stageDirectory))
                {
                    Directory.Delete(stageDirectory, true);
                }
            }
        }

        private static ReleaseStageResult ReadExisting(string versionDirectory, ReleaseManifest manifest)
        {
            if (!Directory.Exists(versionDirectory))
            {
                throw Invalid("update_stage_version_conflict");
            }
            string markerPath = Path.Combine(versionDirectory, ".release-id");
            if (!File.Exists(markerPath))
            {
                throw Invalid("update_stage_version_conflict");
            }
            string marker = File.ReadAllText(markerPath, Encoding.UTF8).Trim();
            if (!string.Equals(marker, manifest.ReleaseId, StringComparison.Ordinal))
            {
                throw Invalid("update_stage_version_conflict");
            }
            if (!File.Exists(Path.Combine(versionDirectory, "LiangjianBridge.exe")))
            {
                throw Invalid("update_stage_existing_invalid");
            }
            return new ReleaseStageResult
            {
                Version = manifest.ReleaseVersion,
                ReleaseId = manifest.ReleaseId,
                DirectoryPath = versionDirectory,
                AlreadyStaged = true
            };
        }

        private static void VerifyPackageFile(ReleasePackage package, string packagePath)
        {
            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(packagePath);
            }
            catch (Exception error)
            {
                if (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
                {
                    throw Invalid("update_package_path_invalid");
                }
                throw;
            }
            if (!File.Exists(fullPath))
            {
                throw Invalid("update_package_missing");
            }
            FileInfo info = new FileInfo(fullPath);
            if (info.Length != package.SizeBytes)
            {
                throw Invalid("update_package_size_invalid");
            }
            byte[] digest;
            using (FileStream stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SHA256 sha = SHA256.Create())
            {
                digest = sha.ComputeHash(stream);
            }
            string actual = ToLowerHex(digest);
            if (!string.Equals(actual, package.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                throw Invalid("update_package_hash_invalid");
            }
        }

        private static void ExtractPackage(string packagePath, string stageDirectory, HashSet<string> extractedPaths, ref long expandedBytes)
        {
            using (FileStream file = new FileStream(Path.GetFullPath(packagePath), FileMode.Open, FileAccess.Read, FileShare.Read))
            using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read, false, Encoding.UTF8))
            {
                if (archive.Entries.Count > MaximumZipEntries)
                {
                    throw Invalid("update_package_zip_entries_invalid");
                }
                List<ZipEntryPlan> plans = new List<ZipEntryPlan>();
                HashSet<string> localPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    ZipEntryPlan plan = PlanEntry(entry, stageDirectory);
                    if (!localPaths.Add(plan.RelativePath) || !extractedPaths.Add(plan.RelativePath))
                    {
                        throw Invalid("update_package_zip_duplicate_path");
                    }
                    if (plan.Length > MaximumExpandedBytes || expandedBytes > MaximumExpandedBytes - plan.Length)
                    {
                        throw Invalid("update_package_zip_expanded_size_invalid");
                    }
                    expandedBytes += plan.Length;
                    plans.Add(plan);
                }
                foreach (ZipEntryPlan plan in plans)
                {
                    if (plan.Directory)
                    {
                        Directory.CreateDirectory(plan.FullPath);
                        continue;
                    }
                    string parent = Path.GetDirectoryName(plan.FullPath);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (Stream source = plan.Entry.Open())
                    using (FileStream destination = new FileStream(plan.FullPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        CopyExact(source, destination, plan.Length);
                    }
                }
            }
        }

        private static ZipEntryPlan PlanEntry(ZipArchiveEntry entry, string stageDirectory)
        {
            if (entry == null || string.IsNullOrEmpty(entry.FullName) || entry.FullName.IndexOf('\0') >= 0
                || entry.FullName.IndexOf(':') >= 0 || entry.FullName.StartsWith("/", StringComparison.Ordinal)
                || entry.FullName.StartsWith("\\", StringComparison.Ordinal)
                || (entry.ExternalAttributes & 0xF0000000) == unchecked((int)0xA0000000))
            {
                throw Invalid("update_package_zip_path_invalid");
            }
            bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal)
                || entry.FullName.EndsWith("\\", StringComparison.Ordinal);
            string normalized = entry.FullName.Replace('/', '\\');
            string[] parts = normalized.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                throw Invalid("update_package_zip_path_invalid");
            }
            foreach (string part in parts)
            {
                if (part == "." || part == ".." || part.IndexOf(':') >= 0)
                {
                    throw Invalid("update_package_zip_path_invalid");
                }
            }
            string relative = string.Join("\\", parts);
            if (string.Equals(relative, ".release-id", StringComparison.OrdinalIgnoreCase))
            {
                throw Invalid("update_package_zip_reserved_path");
            }
            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(Path.Combine(stageDirectory, relative));
            }
            catch (Exception error)
            {
                if (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
                {
                    throw Invalid("update_package_zip_path_invalid");
                }
                throw;
            }
            EnsureChildPath(fullPath, stageDirectory, "update_package_zip_path_invalid");
            long length = directory ? 0 : entry.Length;
            if (length < 0)
            {
                throw Invalid("update_package_zip_entry_invalid");
            }
            return new ZipEntryPlan
            {
                Entry = entry,
                RelativePath = relative,
                FullPath = fullPath,
                Directory = directory,
                Length = length
            };
        }

        private static void CopyExact(Stream source, Stream destination, long expectedLength)
        {
            byte[] buffer = new byte[64 * 1024];
            long copied = 0;
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (copied > expectedLength - read)
                {
                    throw Invalid("update_package_zip_size_invalid");
                }
                destination.Write(buffer, 0, read);
                copied += read;
            }
            if (copied != expectedLength)
            {
                throw Invalid("update_package_zip_size_invalid");
            }
        }

        private static void WriteMarker(string directory, string releaseId)
        {
            string marker = Path.Combine(directory, ".release-id");
            using (FileStream stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(releaseId);
            }
        }

        private static string ToLowerHex(byte[] bytes)
        {
            StringBuilder result = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) result.Append(value.ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
            return result.ToString();
        }

        private static void EnsureChildPath(string candidate, string parent, string code)
        {
            string fullCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!fullCandidate.StartsWith(fullParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                throw Invalid(code);
            }
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }

        private sealed class ZipEntryPlan
        {
            public ZipArchiveEntry Entry;
            public string RelativePath;
            public string FullPath;
            public bool Directory;
            public long Length;
        }
    }
}
