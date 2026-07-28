using System.Diagnostics;
using System.Runtime.InteropServices;
using AurumBridge.Installation;

namespace AurumBridge.Launcher;

internal static class LauncherUninstaller
{
    private const uint MoveFileDelayUntilReboot = 0x00000004;
    private const uint MessageBoxYesNoCancelQuestion = 0x00000023;
    private const uint MessageBoxOkInformation = 0x00000040;
    private const uint MessageBoxOkError = 0x00000010;
    private const int IdYes = 6;
    private const int IdNo = 7;

    public static async Task<int> BeginInteractiveAsync()
    {
        var installRoot = Path.GetFullPath(AppContext.BaseDirectory);
        if (!BridgeInstallationRegistration.IsDefaultInstallRoot(installRoot))
        {
            ShowError("卸载入口无效，请从 Windows“应用和功能”中重新操作。");
            return 1;
        }
        if (BridgeProcessesRunning())
        {
            ShowError("请先在托盘菜单中退出量见智桥，然后重新卸载。");
            return 1;
        }
        var choice = MessageBoxW(
            0,
            "确认卸载量见智桥吗？\n\n选择“是”：卸载软件并保留授权、设置和日志。\n选择“否”：卸载软件并删除全部本地数据。\n选择“取消”：不卸载。",
            "卸载量见智桥",
            MessageBoxYesNoCancelQuestion);
        if (choice is not (IdYes or IdNo))
        {
            return 0;
        }
        var currentExecutable = Environment.ProcessPath
            ?? throw new InvalidOperationException("bridge_uninstall_executable_missing");
        var worker = Path.Combine(
            Path.GetTempPath(),
            $"LiangjianBridgeUninstall-{Guid.NewGuid():N}.exe");
        File.Copy(currentExecutable, worker, overwrite:false);
        var start = new ProcessStartInfo
        {
            FileName = worker,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("--uninstall-worker");
        start.ArgumentList.Add(installRoot);
        start.ArgumentList.Add(choice == IdYes ? "keep-data" : "remove-data");
        start.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        _ = Process.Start(start) ?? throw new InvalidOperationException("bridge_uninstall_worker_start_failed");
        await Task.CompletedTask;
        return 0;
    }

    public static async Task<int> RunWorkerAsync(string installRoot, string dataMode, int parentProcessId)
    {
        var workerPath = Environment.ProcessPath;
        try
        {
            if (!BridgeInstallationRegistration.IsDefaultInstallRoot(installRoot)
                || dataMode is not ("keep-data" or "remove-data")
                || parentProcessId <= 0)
            {
                throw new InvalidOperationException("bridge_uninstall_request_invalid");
            }
            try
            {
                using var parent = Process.GetProcessById(parentProcessId);
                await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            }
            catch (ArgumentException)
            {
                // The original launcher has already exited.
            }
            if (BridgeProcessesRunning())
            {
                throw new InvalidOperationException("bridge_uninstall_process_running");
            }
            var launcher = Path.Combine(installRoot, BridgeInstallationRegistration.LauncherFileName);
            var pointer = Path.Combine(installRoot, "current.json");
            if (!File.Exists(launcher) || !File.Exists(pointer))
            {
                throw new InvalidOperationException("bridge_uninstall_installation_invalid");
            }
            Directory.Delete(installRoot, recursive:true);
            BridgeInstallationRegistration.RemoveRegistrationAndShortcuts();
            if (dataMode == "remove-data" && Directory.Exists(BridgeInstallationRegistration.DefaultDataRoot))
            {
                Directory.Delete(BridgeInstallationRegistration.DefaultDataRoot, recursive:true);
            }
            MessageBoxW(0, "量见智桥已卸载完成。", "量见智桥", MessageBoxOkInformation);
            return 0;
        }
        catch (Exception error)
        {
            var message = error.Message switch
            {
                "bridge_uninstall_process_running" => "量见智桥仍在运行，请退出后重试。",
                "bridge_uninstall_installation_invalid" => "未找到完整的量见智桥安装目录。",
                _ => "卸载未完成，请重启电脑后重试。",
            };
            ShowError(message);
            return 1;
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(workerPath))
            {
                _ = MoveFileExW(workerPath, null, MoveFileDelayUntilReboot);
            }
        }
    }

    private static bool BridgeProcessesRunning() =>
        Process.GetProcessesByName("AURUMBridge").Any(process => process.Id != Environment.ProcessId)
        || Process.GetProcessesByName("AURUMBridge.Launcher")
            .Any(process => process.Id != Environment.ProcessId);

    private static void ShowError(string message) =>
        MessageBoxW(0, message, "量见智桥", MessageBoxOkError);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(nint windowHandle, string text, string caption, uint type);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string existingFileName, string? newFileName, uint flags);
}
