using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

namespace Liangjian.BridgeV4.LauncherApp
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] arguments)
        {
            string releaseId = null;
            string targetVersion = null;
            try
            {
                string installRoot = ResolveInstallRoot();
                if (arguments == null || arguments.Length == 0)
                {
                    LauncherActivation.LaunchCurrent(installRoot);
                }
                else if (arguments.Length == 1 && arguments[0] == "--autostart")
                {
                    System.Threading.Thread.Sleep(10000);
                    LauncherActivation.LaunchCurrent(installRoot, true);
                }
                else if (arguments.Length == 2 && arguments[0] == "--activate")
                {
                    LauncherActivation.ActivateAndLaunch(installRoot, arguments[1]);
                }
                else if (arguments.Length == 6 && arguments[0] == "--activate"
                    && arguments[2] == "--release-id" && arguments[4] == "--wait-pid")
                {
                    targetVersion = arguments[1];
                    releaseId = arguments[3];
                    WaitForProcess(arguments[5]);
                    LauncherActivationResult result = LauncherActivation.ActivateAndLaunch(installRoot, targetVersion);
                    try
                    {
                        ActivationStatusWriter.Write(releaseId, targetVersion,
                            result.RolledBack ? "rolled_back" : "healthy", result.ErrorCode);
                    }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
                else
                {
                    throw new ArgumentException("bridge_launcher_arguments_invalid");
                }
                return 0;
            }
            catch (Exception error)
            {
                if (releaseId != null && targetVersion != null)
                {
                    try { ActivationStatusWriter.Write(releaseId, targetVersion, "failed", "bridge_version_activation_failed"); }
                    catch (Exception) { }
                }
                MessageBox.Show(
                    "量见智桥无法启动。\r\n\r\n" + error.Message,
                    "量见智桥",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }
        }

        private static string ResolveInstallRoot()
        {
            string configured = Environment.GetEnvironmentVariable("LIANGJIAN_BRIDGE_INSTALL_ROOT");
            string root = string.IsNullOrWhiteSpace(configured)
                ? AppDomain.CurrentDomain.BaseDirectory
                : Path.GetFullPath(configured);
            VersionPointer.ReadCurrentVersion(root);
            return root;
        }

        private static void WaitForProcess(string value)
        {
            int processId;
            if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out processId)
                || processId < 1) throw new InvalidDataException("bridge_launcher_wait_pid_invalid");
            try
            {
                using (Process process = Process.GetProcessById(processId))
                {
                    if (!process.WaitForExit(30000)) throw new TimeoutException("bridge_launcher_wait_timeout");
                }
            }
            catch (ArgumentException)
            {
                // The old bridge already exited between argument creation and lookup.
            }
        }
    }
}
