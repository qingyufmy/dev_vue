namespace AurumBridge.Runtime;

public sealed record BridgeRuntimePaths(
    string DataDirectory,
    string CredentialPath,
    string PythonExecutable,
    string Mt5WorkerScript,
    string? Mt4ExpertPath,
    Uri ServerBaseUri);

public static class BridgeRuntimePathResolver
{
    private const string DefaultServerUrl = "https://www.cnfxtrade.com";

    public static string ResolveInstallRoot(string applicationDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationDirectory);
        var versionDirectory = new DirectoryInfo(Path.GetFullPath(applicationDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar)));
        var versionsDirectory = versionDirectory.Parent;
        var installRoot = versionsDirectory?.Parent;
        if (!Version.TryParse(versionDirectory.Name, out _)
            || versionsDirectory is null
            || !string.Equals(versionsDirectory.Name, "versions", StringComparison.OrdinalIgnoreCase)
            || installRoot is null)
        {
            throw new InvalidOperationException("bridge_install_root_invalid");
        }
        return installRoot.FullName;
    }

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

        var rootDataDirectory = Path.GetFullPath(dataDirectory);
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
        var configuredMt4Expert = getEnvironmentVariable("AURUM_BRIDGE_MT4_EA");
        string[] mt4ExpertCandidates =
        [
            Path.Combine(
                applicationDirectory,
                "modules",
                "adapter.mt4",
                Mt4ExpertInstaller.ExpertFileName),
            .. FindDevelopmentMt4ExpertCandidates(applicationDirectory),
        ];
        var mt4Expert = IsInstalledVersionDirectory(applicationDirectory)
            ? ResolveRequiredFile(
                configuredMt4Expert,
                mt4ExpertCandidates,
                "mt4_ea_package_not_found")
            : ResolveOptionalFile(configuredMt4Expert, mt4ExpertCandidates);
        var serverUri = ResolveServerUri(applicationDirectory, getEnvironmentVariable);
        var profileDataDirectory = BridgeRuntimeProfile.ResolveDataDirectory(rootDataDirectory, profileId);
        return new(
            profileDataDirectory,
            Path.Combine(profileDataDirectory, "credential.dat"),
            python,
            worker,
            mt4Expert,
            serverUri);
    }

    private static Uri ResolveServerUri(
        string applicationDirectory,
        Func<string, string?> getEnvironmentVariable)
    {
        var environmentValue = getEnvironmentVariable("AURUM_BRIDGE_SERVER_URL");
        if (!string.IsNullOrWhiteSpace(environmentValue))
        {
            return BridgeServerEndpointConfiguration.ParseServerUri(environmentValue);
        }
        var packaged = BridgeServerEndpointConfiguration.ReadPackaged(
            applicationDirectory,
            required:IsInstalledVersionDirectory(applicationDirectory));
        return packaged
            ?? BridgeServerEndpointConfiguration.ParseServerUri(DefaultServerUrl);
    }

    private static string? ResolveOptionalFile(
        string? configuredPath,
        IEnumerable<string> candidates)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath))
        {
            var configured = Path.GetFullPath(configuredPath.Trim());
            if (!File.Exists(configured))
            {
                throw new FileNotFoundException("mt4_ea_package_not_found", configured);
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
        return null;
    }

    private static bool IsInstalledVersionDirectory(string applicationDirectory)
    {
        var directory = new DirectoryInfo(applicationDirectory);
        return Version.TryParse(directory.Name, out _)
            && string.Equals(
                directory.Parent?.Name,
                "versions",
                StringComparison.OrdinalIgnoreCase);
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

    private static IEnumerable<string> FindDevelopmentMt4ExpertCandidates(
        string applicationDirectory)
    {
        var current = new DirectoryInfo(applicationDirectory);
        for (var depth = 0; current is not null && depth < 8; depth++, current = current.Parent)
        {
            yield return Path.Combine(
                current.FullName,
                "bridge",
                "adapters",
                "mt4-ea",
                Mt4ExpertInstaller.ExpertFileName);
        }
    }
}
