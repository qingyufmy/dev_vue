using System.Runtime.InteropServices;

namespace AurumBridge.Launcher;

internal static class Program
{
    [STAThread]
    public static async Task Main(string[] args)
    {
        try
        {
            if (args.Length > 1 || args.Length == 1 && args[0] != "--autostart")
            {
                throw new ArgumentException("launcher_arguments_invalid", nameof(args));
            }
            var root = AppContext.BaseDirectory;
            var store = new VersionPointerStore(Path.Combine(root, "current.json"));
            var engine = new LauncherEngine(root, store, new BridgeProcessRunner(root));
            await engine.LaunchAsync();
        }
        catch
        {
            MessageBoxW(
                0,
                "量见智桥启动失败，且无法自动恢复上一个版本。请运行修复安装。",
                "量见智桥",
                0x00000010);
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
