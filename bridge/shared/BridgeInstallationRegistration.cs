using Microsoft.Win32;

namespace AurumBridge.Installation;

public static class BridgeInstallationRegistration
{
    public const string ApplicationId = "LiangjianBridge";
    public const string AutoStartValueName = "AURUMBridge";
    public const string LauncherFileName = "AURUMBridge.Launcher.exe";
    public const string ShortcutFileName = "量见智桥.lnk";

    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string UninstallKeyPath =
        @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LiangjianBridge";

    public static string DefaultInstallRoot => Path.GetFullPath(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AURUM",
        ApplicationId));

    public static string DefaultDataRoot => Path.GetFullPath(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AURUM",
        "BridgeV3"));

    public static string DesktopShortcutPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
        ShortcutFileName);

    public static string StartMenuShortcutPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Programs),
        ShortcutFileName);

    public static bool IsDefaultInstallRoot(string path) =>
        string.Equals(
            Path.GetFullPath(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)),
            DefaultInstallRoot,
            StringComparison.OrdinalIgnoreCase);

    public static string BuildUninstallCommand(string installRoot)
    {
        if (!IsDefaultInstallRoot(installRoot))
        {
            throw new InvalidOperationException("bridge_uninstall_root_invalid");
        }
        return $"\"{Path.Combine(DefaultInstallRoot, LauncherFileName)}\" --uninstall";
    }

    public static void Register(string installRoot, string version, long estimatedSizeBytes)
    {
        if (!IsDefaultInstallRoot(installRoot)
            || !Version.TryParse(version, out _)
            || estimatedSizeBytes < 0)
        {
            throw new InvalidOperationException("bridge_installation_registration_invalid");
        }
        var launcher = Path.Combine(DefaultInstallRoot, LauncherFileName);
        if (!File.Exists(launcher))
        {
            throw new FileNotFoundException("bridge_launcher_missing", launcher);
        }
        using var key = Registry.CurrentUser.CreateSubKey(UninstallKeyPath, writable:true)
            ?? throw new InvalidOperationException("bridge_uninstall_registry_unavailable");
        key.SetValue("DisplayName", "量见智桥", RegistryValueKind.String);
        key.SetValue("DisplayVersion", version, RegistryValueKind.String);
        key.SetValue("Publisher", "量见", RegistryValueKind.String);
        key.SetValue("DisplayIcon", launcher, RegistryValueKind.String);
        key.SetValue("InstallLocation", DefaultInstallRoot, RegistryValueKind.String);
        key.SetValue("UninstallString", BuildUninstallCommand(DefaultInstallRoot), RegistryValueKind.String);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue(
            "EstimatedSize",
            (int)Math.Min(int.MaxValue, Math.Max(1, estimatedSizeBytes / 1024)),
            RegistryValueKind.DWord);
    }

    public static void RemoveRegistrationAndShortcuts()
    {
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKeyPath, throwOnMissingSubKey:false);
        using (var run = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable:true))
        {
            run?.DeleteValue(AutoStartValueName, throwOnMissingValue:false);
        }
        DeleteIfPresent(DesktopShortcutPath);
        DeleteIfPresent(StartMenuShortcutPath);
    }

    private static void DeleteIfPresent(string path)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }
}
