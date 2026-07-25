using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace AurumBridge.Workers;

public sealed record Mt5Installation(string ExecutablePath, string Source, bool IsRunning)
{
    public string TerminalInstanceId => Mt5TerminalDiscovery.CreateTerminalInstanceId(ExecutablePath);
}

public sealed record Mt5InstallationCandidate(string Path, string Source, bool IsRunning = false);

public static class Mt5TerminalDiscovery
{
    private static readonly string[] ExecutableNames = ["terminal64.exe", "terminal.exe"];

    public static IReadOnlyList<Mt5Installation> DiscoverWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            return [];
        }
        var candidates = new List<Mt5InstallationCandidate>();
        candidates.AddRange(DiscoverRunningProcesses());
        candidates.AddRange(DiscoverRegistry(RegistryHive.CurrentUser, RegistryView.Default, "registry_hkcu"));
        candidates.AddRange(DiscoverRegistry(RegistryHive.LocalMachine, RegistryView.Registry64, "registry_hklm64"));
        candidates.AddRange(DiscoverRegistry(RegistryHive.LocalMachine, RegistryView.Registry32, "registry_hklm32"));
        return ResolveCandidates(candidates);
    }

    public static IReadOnlyList<Mt5Installation> ResolveCandidates(
        IEnumerable<Mt5InstallationCandidate> candidates)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        var installations = new List<Mt5Installation>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in candidates.OrderBy(value => value.IsRunning ? 0 : 1))
        {
            var executable = FindExecutable(candidate.Path);
            if (executable is null || !seen.Add(executable))
            {
                continue;
            }
            installations.Add(new(executable, candidate.Source, candidate.IsRunning));
        }
        return installations;
    }

    public static string CreateTerminalInstanceId(string executablePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executablePath);
        var normalized = Path.GetFullPath(executablePath).ToUpperInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))
            .ToLowerInvariant();
        return $"mt5_{hash[..24]}";
    }

    private static IEnumerable<Mt5InstallationCandidate> DiscoverRunningProcesses()
    {
        foreach (var processName in new[] { "terminal64", "terminal" })
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                using (process)
                {
                    string? executable = null;
                    try
                    {
                        executable = process.MainModule?.FileName;
                    }
                    catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
                    {
                    }
                    if (!string.IsNullOrWhiteSpace(executable))
                    {
                        yield return new(executable, "running_process", true);
                    }
                }
            }
        }
    }

    private static IReadOnlyList<Mt5InstallationCandidate> DiscoverRegistry(
        RegistryHive hive,
        RegistryView view,
        string source)
    {
        var candidates = new List<Mt5InstallationCandidate>();
        RegistryKey? root = null;
        RegistryKey? terminals = null;
        try
        {
            root = RegistryKey.OpenBaseKey(hive, view);
            terminals = root.OpenSubKey(@"Software\MetaQuotes\Terminal", writable: false);
            if (terminals is null)
            {
                return candidates;
            }
            foreach (var subkeyName in terminals.GetSubKeyNames())
            {
                using var terminal = terminals.OpenSubKey(subkeyName, writable: false);
                var installPath = terminal?.GetValue("InstallPath") as string;
                if (!string.IsNullOrWhiteSpace(installPath))
                {
                    candidates.Add(new(installPath, source));
                }
            }
        }
        catch (Exception error) when (error is UnauthorizedAccessException
            or System.Security.SecurityException
            or IOException)
        {
        }
        finally
        {
            terminals?.Dispose();
            root?.Dispose();
        }
        return candidates;
    }

    private static string? FindExecutable(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }
        try
        {
            var fullPath = Path.GetFullPath(path.Trim());
            if (File.Exists(fullPath)
                && ExecutableNames.Contains(Path.GetFileName(fullPath), StringComparer.OrdinalIgnoreCase))
            {
                return fullPath;
            }
            if (!Directory.Exists(fullPath))
            {
                return null;
            }
            foreach (var name in ExecutableNames)
            {
                var candidate = Path.Combine(fullPath, name);
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        {
        }
        return null;
    }
}
