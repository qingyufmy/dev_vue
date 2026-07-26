namespace AurumBridge.Runtime;

public sealed record BridgeRuntimePaths(
    string DataDirectory,
    string PythonExecutable,
    string Mt5WorkerScript,
    Uri ServerBaseUri);

public static class BridgeRuntimePathResolver
{
    private const string DefaultServerUrl = "https://www.cnfxtrade.com";

    public static BridgeRuntimePaths Resolve(
        string baseDirectory,
        Func<string, string?>? getEnvironmentVariable = null,
        string profileId = BridgeRuntimeProfile.DefaultId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(baseDirectory);
        var applicationDirectory = Path.GetFullPath(baseDirectory);
        getEnvironmentVariable ??= Environment.GetEnvironmentVariable;
        var dataDirectory = getEnvironmentVariable("AURUM_BRIDGE_DATA_DIR");
        if (string.IsNullOrWhiteSpace(dataDirectory))
        {
            dataDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "AURUM",
                "BridgeV3");
        }

        var python = ResolveRequiredFile(
            getEnvironmentVariable("AURUM_BRIDGE_PYTHON"),
            [
                Path.Combine(applicationDirectory, "runtime", "python", "python.exe"),
                .. FindDevelopmentPythonCandidates(applicationDirectory),
                .. ExecutablesOnPath(getEnvironmentVariable("PATH"), "python.exe", "python3.exe"),
            ],
            "mt5_python_runtime_not_found");
        var worker = ResolveRequiredFile(
            getEnvironmentVariable("AURUM_BRIDGE_MT5_WORKER"),
            [
                Path.Combine(applicationDirectory, "modules", "adapter.mt5.python", "worker.py"),
                .. FindDevelopmentWorkerCandidates(applicationDirectory),
            ],
            "mt5_worker_script_not_found");
        var serverValue = getEnvironmentVariable("AURUM_BRIDGE_SERVER_URL");
        if (!Uri.TryCreate(
                string.IsNullOrWhiteSpace(serverValue) ? DefaultServerUrl : serverValue.Trim(),
                UriKind.Absolute,
                out var serverUri))
        {
            throw new InvalidDataException("bridge_server_url_invalid");
        }
        return new(
            BridgeRuntimeProfile.ResolveDataDirectory(dataDirectory, profileId),
            python,
            worker,
            serverUri);
    }

    private static string ResolveRequiredFile(
        string? configuredPath,
        IEnumerable<string> candidates,
        string errorCode)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath))
        {
            var configured = Path.GetFullPath(configuredPath.Trim());
            if (!File.Exists(configured))
            {
                throw new FileNotFoundException(errorCode, configured);
            }
            return configured;
        }
        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return Path.GetFullPath(candidate);
            }
        }
        throw new FileNotFoundException(errorCode);
    }

    private static IEnumerable<string> ExecutablesOnPath(string? pathValue, params string[] executableNames)
    {
        if (string.IsNullOrWhiteSpace(pathValue))
        {
            yield break;
        }
        foreach (var path in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            string directory;
            try
            {
                directory = Path.GetFullPath(path.Trim().Trim('"'));
            }
            catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
            {
                continue;
            }
            foreach (var executableName in executableNames)
            {
                yield return Path.Combine(directory, executableName);
            }
        }
    }

    private static IEnumerable<string> FindDevelopmentWorkerCandidates(string applicationDirectory)
    {
        var current = new DirectoryInfo(applicationDirectory);
        for (var depth = 0; current is not null && depth < 8; depth++, current = current.Parent)
        {
            yield return Path.Combine(current.FullName, "bridge", "adapters", "mt5-python", "worker.py");
        }
    }

    private static IEnumerable<string> FindDevelopmentPythonCandidates(string applicationDirectory)
    {
        var current = new DirectoryInfo(applicationDirectory);
        for (var depth = 0; current is not null && depth < 8; depth++, current = current.Parent)
        {
            yield return Path.Combine(current.FullName, ".venv-bridge", "Scripts", "python.exe");
        }
    }
}
