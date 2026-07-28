using AurumBridge.UI;
using AurumBridge.Runtime;

namespace AurumBridge;

internal static class Program
{
    [STAThread]
    public static async Task Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var (profileId, runtimeArgs) = ReadProfileArgument(args);
        var (backgroundMode, foregroundArgs) =
            BridgeRuntimeProfile.ReadBackgroundArgument(runtimeArgs);
        if (backgroundMode && BridgeRuntimeProfile.IsDefault(profileId))
        {
            throw new ArgumentException("bridge_arguments_invalid", nameof(args));
        }
        var healthMode = foregroundArgs.Contains("--health-check", StringComparer.Ordinal);
        try
        {
            if (TryReadHealthArguments(foregroundArgs, out var healthFile))
            {
                var paths = BridgeRuntimePathResolver.Resolve(AppContext.BaseDirectory);
                var versionDirectory = Directory.GetParent(AppContext.BaseDirectory.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar));
                var installRoot = versionDirectory?.Parent?.Parent?.FullName
                    ?? throw new InvalidOperationException("bridge_install_root_invalid");
                await BridgeHealthCheck.RunAsync(paths, healthFile, Path.Combine(installRoot, "health"));
                return;
            }
            var (startupReadyFile, expectedTerminalInstanceIds) =
                ReadStartupReadyArguments(foregroundArgs);
            var instanceId = BridgeRuntimeProfile.InstanceId(profileId);
            using var singleInstance = BridgeSingleInstanceGuard.TryAcquire(instanceId);
            if (singleInstance is null)
            {
                return;
            }
            Application.Run(new BridgeApplicationContext(
                singleInstance,
                startupReadyFile,
                expectedTerminalInstanceIds,
                profileId,
                backgroundMode));
        }
        catch (Exception error)
        {
            if (healthMode)
            {
                Environment.ExitCode = 1;
                return;
            }
            if (backgroundMode)
            {
                Environment.ExitCode = 1;
                return;
            }
            MessageBox.Show(
                BridgeUiText.DescribeError(error),
                $"{BridgeBrand.ProductName}无法启动",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    internal static (string ProfileId, string[] RuntimeArgs) ReadProfileArgument(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);
        var profileId = BridgeRuntimeProfile.DefaultId;
        var runtimeArgs = new List<string>();
        var profileSeen = false;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] != "--profile")
            {
                runtimeArgs.Add(args[index]);
                continue;
            }
            if (++index >= args.Length || profileSeen)
            {
                throw new ArgumentException("bridge_arguments_invalid", nameof(args));
            }
            profileSeen = true;
            profileId = BridgeRuntimeProfile.Validate(args[index]);
        }
        return (profileId, runtimeArgs.ToArray());
    }

    public static (string? ReadyFile, IReadOnlyList<string> ExpectedTerminalInstanceIds)
        ReadStartupReadyArguments(string[] args)
    {
        if (args.Length == 0)
        {
            return (null, []);
        }
        if (args.Length < 2
            || args.Length % 2 != 0
            || args[0] != "--ready-file"
            || string.IsNullOrWhiteSpace(args[1])
            || !Path.IsPathFullyQualified(args[1]))
        {
            throw new ArgumentException("bridge_arguments_invalid", nameof(args));
        }
        var expected = new List<string>();
        for (var index = 2; index < args.Length; index += 2)
        {
            var value = args[index + 1];
            if (args[index] != "--expected-terminal"
                || string.IsNullOrWhiteSpace(value)
                || value.Length > 128
                || value.Any(character => !char.IsAsciiLetterOrDigit(character)
                    && character is not ('_' or '-'))
                || expected.Contains(value, StringComparer.Ordinal)
                || expected.Count >= 64)
            {
                throw new ArgumentException("bridge_arguments_invalid", nameof(args));
            }
            expected.Add(value);
        }
        return (Path.GetFullPath(args[1]), expected);
    }

    private static bool TryReadHealthArguments(string[] args, out string healthFile)
    {
        healthFile = string.Empty;
        if (args.Length == 0)
        {
            return false;
        }
        if (args.Length != 3
            || args[0] != "--health-check"
            || args[1] != "--health-file"
            || string.IsNullOrWhiteSpace(args[2]))
        {
            throw new ArgumentException("bridge_arguments_invalid", nameof(args));
        }
        healthFile = args[2];
        return true;
    }
}
