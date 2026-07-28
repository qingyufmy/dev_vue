using Microsoft.Win32;

namespace AurumBridge.Runtime;

public interface IAutoStartValueStore
{
    string? Read(string valueName);
    void Write(string valueName, string command);
    void Delete(string valueName);
}

public sealed class WindowsAutoStartValueStore : IAutoStartValueStore
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public string? Read(string valueName)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable:false);
        return key?.GetValue(valueName) as string;
    }

    public void Write(string valueName, string command)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable:true)
            ?? throw new InvalidOperationException("bridge_autostart_registry_unavailable");
        key.SetValue(valueName, command, RegistryValueKind.String);
    }

    public void Delete(string valueName)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable:true);
        key?.DeleteValue(valueName, throwOnMissingValue:false);
    }
}

public sealed class BridgeAutoStartRegistration(IAutoStartValueStore valueStore)
{
    private const string ValueName = "AURUMBridge";
    private readonly IAutoStartValueStore _valueStore = valueStore
        ?? throw new ArgumentNullException(nameof(valueStore));

    public bool EnsureForInstalledApplication(string applicationDirectory)
    {
        var launcherPath = ResolveStableLauncher(applicationDirectory);
        if (launcherPath is null)
        {
            return false;
        }
        var command = BuildCommand(launcherPath);
        if (string.Equals(_valueStore.Read(ValueName), command, StringComparison.Ordinal))
        {
            return false;
        }
        _valueStore.Write(ValueName, command);
        return true;
    }

    public bool SetEnabledForInstalledApplication(
        string applicationDirectory,
        bool enabled)
    {
        if (!enabled)
        {
            return Disable();
        }
        var launcherPath = ResolveStableLauncher(applicationDirectory)
            ?? throw new InvalidOperationException("bridge_autostart_launcher_unavailable");
        var command = BuildCommand(launcherPath);
        if (string.Equals(_valueStore.Read(ValueName), command, StringComparison.Ordinal))
        {
            return false;
        }
        _valueStore.Write(ValueName, command);
        return true;
    }

    public bool Disable()
    {
        if (_valueStore.Read(ValueName) is null)
        {
            return false;
        }
        _valueStore.Delete(ValueName);
        return true;
    }

    public static string? ResolveStableLauncher(string applicationDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationDirectory);
        var versionDirectory = new DirectoryInfo(Path.GetFullPath(applicationDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar)));
        if (!Version.TryParse(versionDirectory.Name, out _)
            || versionDirectory.Parent is not { } versionsDirectory
            || !string.Equals(versionsDirectory.Name, "versions", StringComparison.OrdinalIgnoreCase)
            || versionsDirectory.Parent is not { } installRoot)
        {
            return null;
        }
        var launcherPath = Path.GetFullPath(Path.Combine(installRoot.FullName, "AURUMBridge.Launcher.exe"));
        return File.Exists(launcherPath) ? launcherPath : null;
    }

    private static string BuildCommand(string launcherPath) =>
        $"\"{launcherPath}\" --autostart";
}
