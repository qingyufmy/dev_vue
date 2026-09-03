using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Compatibility
{
    public static class LegacyInstallHandoff
    {
        private const int MaximumPointerBytes = 64 * 1024;

        public static bool Prepare(string applicationDirectory, string currentVersion)
        {
            Version parsed;
            if (string.IsNullOrWhiteSpace(applicationDirectory)
                || !Version.TryParse(currentVersion, out parsed))
                throw new InvalidDataException("bridge_legacy_handoff_invalid");

            DirectoryInfo currentDirectory = new DirectoryInfo(Path.GetFullPath(applicationDirectory));
            DirectoryInfo versionsDirectory = currentDirectory.Parent;
            DirectoryInfo installRoot = versionsDirectory == null ? null : versionsDirectory.Parent;
            if (versionsDirectory == null || installRoot == null
                || !string.Equals(versionsDirectory.Name, "versions", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(currentDirectory.Name, currentVersion, StringComparison.Ordinal))
                return false;

            string legacyPointer = Path.Combine(installRoot.FullName, "current.json");
            string legacyLauncher = Path.Combine(installRoot.FullName, "AURUMBridge.Launcher.exe");
            if (!File.Exists(legacyPointer) || !File.Exists(legacyLauncher)) return false;

            IDictionary<string, object> pointer = ReadPointer(legacyPointer);
            string active = ReadText(pointer, "active_version");
            string previous = ReadText(pointer, "last_known_good_version");
            string status = ReadText(pointer, "status");
            if (!string.Equals(active, currentVersion, StringComparison.Ordinal)
                || (status != "pending" && status != "healthy" && status != "rolled_back"))
                throw new InvalidDataException("bridge_legacy_pointer_invalid");

            string currentLegacyEntry = Path.Combine(currentDirectory.FullName, "AURUMBridge.exe");
            string currentV4Entry = Path.Combine(currentDirectory.FullName, "LiangjianBridge.exe");
            if (!SameFile(currentLegacyEntry, currentV4Entry))
                throw new InvalidDataException("bridge_legacy_current_alias_invalid");

            if (string.Equals(previous, currentVersion, StringComparison.Ordinal))
            {
                if (status != "healthy" && status != "rolled_back")
                    throw new InvalidDataException("bridge_legacy_pointer_invalid");
                AtomicWrite(Path.Combine(versionsDirectory.FullName, "previous.txt"), currentVersion);
                AtomicWrite(Path.Combine(versionsDirectory.FullName, "current.txt"), currentVersion);
                return true;
            }

            string previousDirectory = Path.Combine(versionsDirectory.FullName, previous);
            string previousLegacyEntry = Path.Combine(previousDirectory, "AURUMBridge.exe");
            string previousV4Alias = Path.Combine(previousDirectory, "LiangjianBridge.exe");
            if (!File.Exists(previousLegacyEntry))
                throw new InvalidDataException("bridge_legacy_previous_missing");
            EnsureAlias(previousLegacyEntry, previousV4Alias);

            AtomicWrite(Path.Combine(versionsDirectory.FullName, "previous.txt"), previous);
            AtomicWrite(Path.Combine(versionsDirectory.FullName, "current.txt"), currentVersion);
            return true;
        }

        private static IDictionary<string, object> ReadPointer(string path)
        {
            FileInfo file = new FileInfo(path);
            if (!file.Exists || file.Length < 2 || file.Length > MaximumPointerBytes)
                throw new InvalidDataException("bridge_legacy_pointer_invalid");
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer
                    { MaxJsonLength = MaximumPointerBytes, RecursionLimit = 8 };
                IDictionary<string, object> value = serializer.DeserializeObject(
                    File.ReadAllText(path, Encoding.UTF8)) as IDictionary<string, object>;
                if (value == null) throw new InvalidDataException("bridge_legacy_pointer_invalid");
                return value;
            }
            catch (InvalidDataException) { throw; }
            catch (Exception error)
            {
                if (error is ArgumentException || error is InvalidOperationException)
                    throw new InvalidDataException("bridge_legacy_pointer_invalid", error);
                throw;
            }
        }

        private static string ReadText(IDictionary<string, object> values, string key)
        {
            object raw;
            string value;
            if (!values.TryGetValue(key, out raw) || (value = raw as string) == null
                || value.Length < 1 || value.Length > 64)
                throw new InvalidDataException("bridge_legacy_pointer_invalid");
            Version parsed;
            if ((key == "active_version" || key == "last_known_good_version")
                && !Version.TryParse(value, out parsed))
                throw new InvalidDataException("bridge_legacy_pointer_invalid");
            return value;
        }

        private static void EnsureAlias(string source, string destination)
        {
            if (File.Exists(destination))
            {
                if (!SameFile(source, destination))
                    throw new InvalidDataException("bridge_legacy_previous_alias_conflict");
                return;
            }
            string temporary = destination + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    input.CopyTo(output);
                    output.Flush(true);
                }
                if (!SameFile(source, temporary))
                    throw new InvalidDataException("bridge_legacy_previous_alias_invalid");
                File.Move(temporary, destination);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        private static bool SameFile(string left, string right)
        {
            if (!File.Exists(left) || !File.Exists(right)) return false;
            FileInfo leftInfo = new FileInfo(left);
            FileInfo rightInfo = new FileInfo(right);
            if (leftInfo.Length != rightInfo.Length) return false;
            using (SHA256 algorithm = SHA256.Create())
            using (FileStream leftStream = File.OpenRead(left))
            using (FileStream rightStream = File.OpenRead(right))
            {
                return Equal(algorithm.ComputeHash(leftStream), algorithm.ComputeHash(rightStream));
            }
        }

        private static bool Equal(byte[] left, byte[] right)
        {
            if (left.Length != right.Length) return false;
            int different = 0;
            for (int index = 0; index < left.Length; index++) different |= left[index] ^ right[index];
            return different == 0;
        }

        private static void AtomicWrite(string destination, string value)
        {
            string temporary = destination + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                using (FileStream output = new FileStream(temporary, FileMode.CreateNew,
                    FileAccess.Write, FileShare.None))
                using (StreamWriter writer = new StreamWriter(output, new UTF8Encoding(false)))
                {
                    writer.Write(value);
                    writer.Flush();
                    output.Flush(true);
                }
                if (File.Exists(destination)) File.Replace(temporary, destination, null, true);
                else File.Move(temporary, destination);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
    }
}
