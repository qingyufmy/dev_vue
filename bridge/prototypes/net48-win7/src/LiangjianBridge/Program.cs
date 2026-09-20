using System;
using System.IO;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using Liangjian.BridgeV4;
using Liangjian.BridgeV4.Compatibility;
using Liangjian.BridgeV4.Migration;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.App
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(int processId);
        [STAThread]
        private static int Main(string[] arguments)
        {
            if (arguments != null && arguments.Length == 4
                && string.Equals(arguments[0], "--migrate-v3-snapshot", StringComparison.Ordinal))
            {
                try
                {
                    LegacyV3Migration.Generate(arguments[1], arguments[2], arguments[3]);
                    return 0;
                }
                catch (InvalidDataException) { return 1; }
                catch (IOException) { return 1; }
                catch (UnauthorizedAccessException) { return 1; }
            }

            LegacyLaunchRequest request;
            try
            {
                request = LegacyLauncherContract.Parse(arguments);
                LegacyInstallHandoff.Prepare(AppDomain.CurrentDomain.BaseDirectory, "4.0.0.0");
            }
            catch (InvalidDataException)
            {
                return 2;
            }
            catch (IOException)
            {
                return 2;
            }
            catch (UnauthorizedAccessException)
            {
                return 2;
            }

            if (request.Mode == LegacyLaunchMode.HealthCheck)
            {
                string core = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "LiangjianBridge.Core.dll");
                RuntimeStatus runtime = RuntimePrerequisite.Detect();
                if (!File.Exists(core) || !runtime.Supported) return 1;
                if (!string.IsNullOrEmpty(request.HealthFile))
                {
                    try { LegacyLauncherContract.WriteHealthSignal(request.HealthFile, "4.0.0.0"); }
                    catch (Exception) { return 1; }
                }
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs eventArgs)
            {
                MessageBox.Show(eventArgs.Exception.Message, "量见智桥", MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            string dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Liangjian", "BridgeV4");
            using (BridgeApplicationInstance instance = new BridgeApplicationInstance(dataRoot))
            {
                if (!instance.IsPrimary)
                {
                    AllowSetForegroundWindow(-1);
                    instance.NotifyPrimary();
                    return 0;
                }
                using (MainForm form = new MainForm(request))
                {
                    // Create the HWND before accepting a request from another launch.
                    IntPtr window = form.Handle;
                    instance.Listen(delegate
                    {
                        try
                        {
                            form.BeginInvoke(new Action(delegate
                            {
                                if (form.IsDisposed) return;
                                form.RestoreWindow();
                            }));
                        }
                        catch (InvalidOperationException) { }
                    });
                    Application.Run(form);
                }
            }
            return 0;
        }
    }
}
