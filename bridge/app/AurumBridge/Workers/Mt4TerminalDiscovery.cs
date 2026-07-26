using System.Diagnostics;

namespace AurumBridge.Workers;

public sealed record Mt4Installation(
    string TerminalDataPath,
    string InstallationPath,
    string Source,
    bool IsRunning)
{
    public string TerminalInstanceId =>
        Mt4TerminalIdentity.CreateTerminalInstanceId(TerminalDataPath);

    public string DisplayName
    {
        get
        {
            var path = string.IsNullOrWhiteSpace(InstallationPath)
                ? TerminalDataPath
                : InstallationPath;
            return Path.GetFileName(Path.TrimEndingDirectorySeparator(path));
        }
    }
}

public sealed record Mt4InstallationCandidate(
    string TerminalDataPath,
    string InstallationPath,
    string Source,
    bool IsRunning = false);

public static class Mt4TerminalDiscovery
{
    public static IReadOnlyList<Mt4Installation> DiscoverWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            return [];
        }

        var runningExecutables = DiscoverRunningExecutables();
        var candidates = new List<Mt4InstallationCandidate>();
        var terminalRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "MetaQuotes",
            "Terminal");
        if (Directory.Exists(terminalRoot))
        {
            try
            {
                foreach (var directory in Directory.EnumerateDirectories(terminalRoot))
                {
                    if (!Directory.Exists(Path.Combine(directory, "MQL4")))
                    {
                        continue;
                    }
                    var installationPath = ReadOriginPath(directory);
                    if (installationPath is null
                        || !ContainsTerminalExecutable(installationPath))
                    {
                        continue;
                    }
                    var isRunning = runningExecutables.Any(executable =>
                        PathsEqual(Path.GetDirectoryName(executable), installationPath));
                    candidates.Add(new(
                        directory,
                        installationPath,
                        "terminal_data",
                        isRunning));
                }
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
            }
        }

        foreach (var executable in runningExecutables)
        {
            var installationPath = Path.GetDirectoryName(executable);
            if (installationPath is not null
                && Directory.Exists(Path.Combine(installationPath, "MQL4")))
            {
                candidates.Add(new(
                    installationPath,
                    installationPath,
                    "running_portable",
                    IsRunning:true));
            }
        }
        return ResolveCandidates(candidates);
    }

    public static IReadOnlyList<Mt4Installation> ResolveCandidates(
        IEnumerable<Mt4InstallationCandidate> candidates)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        var installations = new List<Mt4Installation>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var candidate in candidates.OrderBy(value => value.IsRunning ? 0 : 1))
        {
            try
            {
                var dataPath = Path.GetFullPath(candidate.TerminalDataPath);
                if (!Directory.Exists(Path.Combine(dataPath, "MQL4")) || !seen.Add(dataPath))
                {
                    continue;
                }
                var installationPath = string.IsNullOrWhiteSpace(candidate.InstallationPath)
                    ? dataPath
                    : Path.GetFullPath(candidate.InstallationPath);
                installations.Add(new(
                    dataPath,
                    installationPath,
                    candidate.Source,
                    candidate.IsRunning));
            }
            catch (Exception error) when (error is ArgumentException
                or NotSupportedException
                or PathTooLongException)
            {
            }
        }
        return installations;
    }

    private static IReadOnlyList<string> DiscoverRunningExecutables()
    {
        var executables = new List<string>();
        foreach (var processName in new[] { "terminal64", "terminal" })
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                using (process)
                {
                    try
                    {
                        if (process.MainModule?.FileName is { Length: > 0 } executable)
                        {
                            executables.Add(Path.GetFullPath(executable));
                        }
                    }
                    catch (Exception error) when (error is InvalidOperationException
                        or System.ComponentModel.Win32Exception
                        or NotSupportedException
                        or PathTooLongException)
                    {
                    }
                }
            }
        }
        return executables;
    }

    private static string? ReadOriginPath(string terminalDataPath)
    {
        var originPath = Path.Combine(terminalDataPath, "origin.txt");
        if (!File.Exists(originPath))
        {
            return null;
        }
        try
        {
            var value = File.ReadAllText(originPath).Trim().Trim('\0');
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }
            var path = Path.GetFullPath(value);
            return File.Exists(path) ? Path.GetDirectoryName(path) : path;
        }
        catch (Exception error) when (error is UnauthorizedAccessException
            or IOException
            or ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return null;
        }
    }

    private static bool ContainsTerminalExecutable(string installationPath) =>
        File.Exists(Path.Combine(installationPath, "terminal.exe"))
        || File.Exists(Path.Combine(installationPath, "terminal64.exe"));

    private static bool PathsEqual(string? first, string? second)
    {
        if (string.IsNullOrWhiteSpace(first) || string.IsNullOrWhiteSpace(second))
        {
            return false;
        }
        try
        {
            return string.Equals(
                Path.TrimEndingDirectorySeparator(Path.GetFullPath(first)),
                Path.TrimEndingDirectorySeparator(Path.GetFullPath(second)),
                StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception error) when (error is ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return false;
        }
    }
}
