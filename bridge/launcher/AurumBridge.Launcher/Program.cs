namespace AurumBridge.Launcher;

internal static class Program
{
    [STAThread]
    public static async Task Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
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
            MessageBox.Show(
                "AURUM Bridge 启动失败，且无法自动恢复上一个版本。请运行修复安装。",
                "AURUM Bridge",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }
}
