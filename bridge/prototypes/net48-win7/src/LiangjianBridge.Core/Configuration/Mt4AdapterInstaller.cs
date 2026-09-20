using System;
using System.IO;
using System.Security.Cryptography;

namespace Liangjian.BridgeV4.Configuration
{
    public sealed class Mt4AdapterInstallResult
    {
        public string Destination { get; internal set; }
        public string Backup { get; internal set; }
        public bool Changed { get; internal set; }
    }

    public static class Mt4AdapterInstaller
    {
        public const string AdapterFileName = "BridgeV4MT4.ex4";

        public static string ValidateDataDirectory(string selectedDirectory)
        {
            string root = RequireDirectory(selectedDirectory);
            string experts = Path.Combine(root, "MQL4", "Experts");
            RequireDirectory(Path.Combine(root, "MQL4"));
            RequireDirectory(experts);
            return experts;
        }

        public static bool NeedsOverwrite(string sourceEaPath, string selectedDirectory, bool export)
        {
            string source = RequireSource(sourceEaPath);
            string directory = export ? RequireDirectory(selectedDirectory) : ValidateDataDirectory(selectedDirectory);
            string destination = Path.Combine(directory, AdapterFileName);
            RejectReparseFile(destination);
            return File.Exists(destination) && !SameContents(source, destination);
        }

        public static Mt4AdapterInstallResult Install(string sourceEaPath, string selectedDataDirectory, bool allowOverwrite)
        {
            return CopyAdapter(sourceEaPath, ValidateDataDirectory(selectedDataDirectory), allowOverwrite);
        }

        public static Mt4AdapterInstallResult Export(string sourceEaPath, string selectedOutputDirectory, bool allowOverwrite)
        {
            return CopyAdapter(sourceEaPath, RequireDirectory(selectedOutputDirectory), allowOverwrite);
        }

        private static Mt4AdapterInstallResult CopyAdapter(string sourceEaPath, string directory, bool allowOverwrite)
        {
            string source = RequireSource(sourceEaPath);
            string destination = Path.Combine(directory, AdapterFileName);
            RejectReparseFile(destination);
            if (File.Exists(destination) && SameContents(source, destination))
                return new Mt4AdapterInstallResult { Destination = destination, Changed = false };
            if (File.Exists(destination) && !allowOverwrite) throw new IOException("bridge_mt4_adapter_overwrite_confirmation_required");
            string temporary = destination + ".pending-" + Guid.NewGuid().ToString("N");
            string backup = null;
            try
            {
                File.Copy(source, temporary, false);
                using (FileStream stream = new FileStream(temporary, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    stream.Flush(true);
                if (File.Exists(destination))
                {
                    if (!allowOverwrite) throw new IOException("bridge_mt4_adapter_overwrite_confirmation_required");
                    backup = destination + ".backup-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N");
                    File.Replace(temporary, destination, backup);
                }
                else File.Move(temporary, destination);
                return new Mt4AdapterInstallResult { Destination = destination, Backup = backup, Changed = true };
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static string RequireSource(string sourceEaPath)
        {
            if (string.IsNullOrWhiteSpace(sourceEaPath) || !Path.IsPathRooted(sourceEaPath)
                || !string.Equals(Path.GetFileName(sourceEaPath), AdapterFileName, StringComparison.Ordinal)
                || !File.Exists(sourceEaPath) || new FileInfo(sourceEaPath).Length == 0)
                throw new IOException("bridge_mt4_v4_adapter_missing");
            return Path.GetFullPath(sourceEaPath);
        }

        private static string RequireDirectory(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) || !Directory.Exists(path))
                throw new IOException("bridge_mt4_data_directory_invalid");
            string full = Path.GetFullPath(path);
            if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("bridge_mt4_data_directory_link_not_supported");
            return full;
        }

        private static void RejectReparseFile(string path)
        {
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("bridge_mt4_adapter_link_not_supported");
        }

        private static bool SameContents(string left, string right)
        {
            using (SHA256 hash = SHA256.Create())
            using (FileStream first = File.OpenRead(left))
            using (FileStream second = File.OpenRead(right))
                return Convert.ToBase64String(hash.ComputeHash(first)) == Convert.ToBase64String(hash.ComputeHash(second));
        }
    }
}
