using System.Runtime.InteropServices;

namespace AurumBridge.Launcher;

internal static class Program
{
    [STAThread]
    public static async Task Main(string[] args)
    {
        if (args is ["--uninstall"])
        {
            Environment.ExitCode = await LauncherUninstaller.BeginInteractiveAsync();
            return;
        }
        if (args is ["--uninstall-worker", var installRoot, var dataMode, var parentProcessId]
            && int.TryParse(parentProcessId, out var parsedParentProcessId))
        {
            Environment.ExitCode = await LauncherUninstaller.RunWorkerAsync(
                installRoot,
                dataMode,
                parsedParentProcessId);
            return;
        }
        var automaticStartup = args.Length == 1 && args[0] == "--autostart";
        try
        {
            var startup = LauncherStartupOptions.Parse(args);
            if (startup.Delay > TimeSpan.Zero)
            {
                await Task.Delay(startup.Delay);
            }
            var root = AppContext.BaseDirectory;
            var store = new VersionPointerStore(Path.Combine(root, "current.json"));
            var engine = new LauncherEngine(root, store, new BridgeProcessRunner(root));
            await engine.LaunchAsync(startup.StartMinimized);
        }
        catch
        {
            if (!automaticStartup)
            {
                MessageBoxW(
                    0,
                    "量见智桥启动失败，且无法自动恢复上一个版本。请运行修复安装。",
                    "量见智桥",
                    0x00000010);
            }
            Environment.ExitCode = 1;
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(
        nint windowHandle,
        string text,
        string caption,
        uint type);
}
