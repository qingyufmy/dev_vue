using System;
using System.IO;

namespace Liangjian.BridgeV4.Update
{
    public static class BridgeInstallLayout
    {
        public static bool TryResolve(string applicationBaseDirectory, out string installRoot)
        {
            installRoot = null;
            if (string.IsNullOrWhiteSpace(applicationBaseDirectory)) return false;
            string versionDirectory;
            try
            {
                versionDirectory = Path.GetFullPath(applicationBaseDirectory)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
            catch (Exception error)
            {
                if (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
                    return false;
                throw;
            }
            DirectoryInfo version = new DirectoryInfo(versionDirectory);
            DirectoryInfo versions = version.Parent;
            DirectoryInfo root = versions == null ? null : versions.Parent;
            Version parsed;
            if (versions == null || root == null || !string.Equals(versions.Name, "versions",
                StringComparison.OrdinalIgnoreCase) || !Version.TryParse(version.Name, out parsed)) return false;
            string launcher = Path.Combine(root.FullName, "LiangjianBridge.Launcher.exe");
            string legacyLauncher = Path.Combine(root.FullName, "AURUMBridge.Launcher.exe");
            string current = Path.Combine(versions.FullName, "current.txt");
            if ((!File.Exists(launcher) && !File.Exists(legacyLauncher)) || !File.Exists(current)) return false;
            string selected = File.ReadAllText(current).Trim();
            if (!string.Equals(selected, version.Name, StringComparison.Ordinal)) return false;
            installRoot = root.FullName;
            return true;
        }
    }
}
