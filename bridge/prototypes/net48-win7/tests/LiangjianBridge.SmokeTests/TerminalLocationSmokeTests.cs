using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class TerminalLocationSmokeTests
    {
        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-location-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                string mt5 = Path.Combine(root, "terminal64.exe");
                string mt4 = Path.Combine(root, "terminal.exe");
                File.WriteAllText(mt5, "fixture"); File.WriteAllText(mt4, "fixture");
                Assert(TerminalLocation.Resolve(mt5, "mt5").ExecutablePath == mt5, "direct_mt5_path_failed");
                Assert(TerminalLocation.Resolve(root, "mt5").ExecutablePath == mt5, "mt5_folder_failed");
                Assert(TerminalLocation.Resolve(root, "mt4").ExecutablePath == mt4, "mt4_folder_failed");
                Reject(mt5, "mt4"); Reject("terminal64.exe", "mt5");
                foreach (string name in new[] { "setup.exe", "launch.cmd", "worker.py", "launch.bat", "command.ps1" })
                {
                    string bad = Path.Combine(root, name); File.WriteAllText(bad, "fixture"); Reject(bad, "mt5");
                }
                string link = Path.Combine(root, "portable.lnk");
                CreateShortcut(link, mt5, "/portable");
                TerminalLocation portable = TerminalLocation.Resolve(link, "mt5");
                Assert(portable.ExecutablePath == mt5 && portable.Portable, "portable_shortcut_not_resolved");
                CreateShortcut(link, mt5, string.Empty);
                Assert(!TerminalLocation.Resolve(link, "mt5").Portable, "plain_shortcut_changed_mode");
                CreateShortcut(link, mt5, "/portable /config:other.ini"); Reject(link, "mt5");
                CreateShortcut(link, Path.Combine(root, "launch.cmd"), string.Empty); Reject(link, "mt5");
                CreateShortcut(link, Path.Combine(root, "missing", "terminal64.exe"), string.Empty); Reject(link, "mt5");
            }
            finally { Directory.Delete(root, true); }
        }

        private static void CreateShortcut(string path, string target, string arguments)
        {
            object shell = null, shortcut = null;
            try
            {
                Type type = Type.GetTypeFromProgID("WScript.Shell", true);
                shell = Activator.CreateInstance(type);
                shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                shortcut.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                shortcut.GetType().InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
                shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }

        private static void Reject(string path, string platform)
        {
            try { TerminalLocation.Resolve(path, platform); }
            catch (InvalidDataException) { return; }
            throw new InvalidOperationException("unsafe_terminal_location_accepted");
        }
        private static void Assert(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
    }
}
