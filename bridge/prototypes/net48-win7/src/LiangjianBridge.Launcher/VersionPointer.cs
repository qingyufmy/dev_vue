using System;
using System.IO;

namespace Liangjian.BridgeV4.LauncherApp
{
    public static class VersionPointer
    {
        public static string ResolveExecutable(string installRoot, string versionText)
        {
            Version version;
            if (string.IsNullOrWhiteSpace(versionText) || !Version.TryParse(versionText.Trim(), out version))
            {
                throw new InvalidDataException("bridge_version_pointer_invalid");
            }

            string versionsRoot = Path.GetFullPath(Path.Combine(installRoot, "versions"));
            string candidate = Path.GetFullPath(Path.Combine(versionsRoot, version.ToString(), "LiangjianBridge.exe"));
            string expectedPrefix = versionsRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!candidate.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("bridge_version_pointer_outside_root");
            }
            return candidate;
        }

        public static string ReadCurrentVersion(string installRoot)
        {
            string pointer = Path.Combine(Path.GetFullPath(installRoot), "versions", "current.txt");
            if (!File.Exists(pointer))
            {
                throw new FileNotFoundException("bridge_version_pointer_missing", pointer);
            }
            string value = File.ReadAllText(pointer).Trim();
            ResolveExecutable(installRoot, value);
            return value;
        }

        public static string Activate(string installRoot, string targetVersion)
        {
            string targetExecutable = ResolveExecutable(installRoot, targetVersion);
            if (!File.Exists(targetExecutable))
            {
                throw new FileNotFoundException("bridge_target_version_missing", targetExecutable);
            }
            string currentVersion = ReadCurrentVersion(installRoot);
            if (string.Equals(currentVersion, targetVersion, StringComparison.Ordinal))
            {
                return currentVersion;
            }
            string versionsRoot = Path.Combine(Path.GetFullPath(installRoot), "versions");
            AtomicWrite(Path.Combine(versionsRoot, "previous.txt"), currentVersion);
            AtomicWrite(Path.Combine(versionsRoot, "activation-pending.txt"), targetVersion.Trim());
            AtomicWrite(Path.Combine(versionsRoot, "current.txt"), targetVersion.Trim());
            return currentVersion;
        }

        public static string ReadPendingActivation(string installRoot)
        {
            string pointer = Path.Combine(Path.GetFullPath(installRoot), "versions", "activation-pending.txt");
            if (!File.Exists(pointer))
            {
                return null;
            }
            string value = File.ReadAllText(pointer).Trim();
            ResolveExecutable(installRoot, value);
            return value;
        }

        public static void CompleteActivation(string installRoot, string targetVersion)
        {
            string pending = ReadPendingActivation(installRoot);
            if (pending == null || !string.Equals(pending, targetVersion, StringComparison.Ordinal)
                || !string.Equals(ReadCurrentVersion(installRoot), targetVersion, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_activation_completion_mismatch");
            }
            File.Delete(Path.Combine(Path.GetFullPath(installRoot), "versions", "activation-pending.txt"));
        }

        public static string Rollback(string installRoot, string failedVersion)
        {
            string currentVersion = ReadCurrentVersion(installRoot);
            if (!string.Equals(currentVersion, failedVersion, StringComparison.Ordinal))
            {
                throw new InvalidDataException("bridge_rollback_current_version_mismatch");
            }
            string previousPointer = Path.Combine(Path.GetFullPath(installRoot), "versions", "previous.txt");
            if (!File.Exists(previousPointer))
            {
                throw new FileNotFoundException("bridge_previous_version_pointer_missing", previousPointer);
            }
            string previousVersion = File.ReadAllText(previousPointer).Trim();
            string previousExecutable = ResolveExecutable(installRoot, previousVersion);
            if (!File.Exists(previousExecutable))
            {
                throw new FileNotFoundException("bridge_previous_version_missing", previousExecutable);
            }
            AtomicWrite(Path.Combine(Path.GetFullPath(installRoot), "versions", "current.txt"), previousVersion);
            string pendingPointer = Path.Combine(Path.GetFullPath(installRoot), "versions", "activation-pending.txt");
            if (File.Exists(pendingPointer))
            {
                File.Delete(pendingPointer);
            }
            return previousVersion;
        }

        private static void AtomicWrite(string destination, string value)
        {
            string directory = Path.GetDirectoryName(destination);
            if (string.IsNullOrEmpty(directory))
            {
                throw new InvalidDataException("bridge_version_pointer_directory_invalid");
            }
            Directory.CreateDirectory(directory);
            string temporary = Path.Combine(directory, Path.GetFileName(destination) + "." + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (StreamWriter writer = new StreamWriter(output))
                {
                    writer.Write(value);
                    writer.Flush();
                    output.Flush(true);
                }
                if (File.Exists(destination))
                {
                    File.Replace(temporary, destination, null, true);
                }
                else
                {
                    File.Move(temporary, destination);
                }
            }
            finally
            {
                if (File.Exists(temporary))
                {
                    File.Delete(temporary);
                }
            }
        }
    }
}
