using AurumBridge.UI;
using AurumBridge.Runtime;

namespace AurumBridge;

internal static class Program
{
    [STAThread]
    public static async Task Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var healthMode = args.Contains("--health-check", StringComparer.Ordinal);
        try
        {
            if (TryReadHealthArguments(args, out var healthFile))
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
            var startupReadyFile = ReadStartupReadyFile(args);
            using var singleInstance = BridgeSingleInstanceGuard.TryAcquire("AURUMBridge.v3");
            if (singleInstance is null)
            {
                return;
            }
            Application.Run(new BridgeApplicationContext(singleInstance, startupReadyFile));
        }
        catch (Exception error)
        {
            if (healthMode)
            {
                Environment.ExitCode = 1;
                return;
            }
            MessageBox.Show(
                BridgeUiText.DescribeError(error),
                "AURUM Bridge 无法启动",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static string? ReadStartupReadyFile(string[] args)
    {
        if (args.Length == 0)
        {
            return null;
        }
        if (args.Length != 2
            || args[0] != "--ready-file"
            || string.IsNullOrWhiteSpace(args[1])
            || !Path.IsPathFullyQualified(args[1]))
        {
            throw new ArgumentException("bridge_arguments_invalid", nameof(args));
        }
        return Path.GetFullPath(args[1]);
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
