using System;
using System.IO;
using System.Reflection;
using System.Threading;

namespace Liangjian.BridgeV4.UpdateFixture
{
    internal static class Program
    {
        private static int Main(string[] arguments)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            if (File.Exists(Path.Combine(root, "handoff.prepare")))
            {
                try
                {
                    Assembly core = Assembly.LoadFrom(Path.Combine(root, "LiangjianBridge.Core.dll"));
                    Type handoff = core.GetType("Liangjian.BridgeV4.Compatibility.LegacyInstallHandoff", true);
                    MethodInfo prepare = handoff.GetMethod("Prepare", BindingFlags.Public | BindingFlags.Static);
                    if (prepare == null) return 3;
                    prepare.Invoke(null, new object[] { root, new DirectoryInfo(root).Name });
                }
                catch (Exception) { return 3; }
            }
            if (arguments != null && arguments.Length == 1 && arguments[0] == "--health-check")
            {
                return File.Exists(Path.Combine(root, "health.fail")) ? 1 : 0;
            }
            if (arguments != null && arguments.Length == 3 && arguments[0] == "--health-check"
                && arguments[1] == "--health-file" && Path.IsPathRooted(arguments[2]))
            {
                if (File.Exists(Path.Combine(root, "health.fail"))) return 1;
                File.WriteAllText(arguments[2], "{\"ok\":true}");
                return 0;
            }
            if (arguments != null && arguments.Length >= 2)
            {
                int readyIndex = Array.IndexOf(arguments, "--ready-file");
                if (readyIndex >= 0 && readyIndex + 1 < arguments.Length
                    && Path.IsPathRooted(arguments[readyIndex + 1]))
                {
                    if (File.Exists(Path.Combine(root, "ready.fail"))) return 1;
                    string version = new DirectoryInfo(root).Name;
                    File.WriteAllText(arguments[readyIndex + 1],
                        "{\"ready\":true,\"version\":\"" + version
                        + "\",\"server_connected\":true,\"running_terminal_instance_ids\":[]}");
                    File.WriteAllText(Path.Combine(root, "started.marker"), DateTime.UtcNow.Ticks.ToString());
                    Thread.Sleep(3500);
                    return 0;
                }
            }
            if (arguments != null && arguments.Length > 1)
            {
                return 2;
            }
            File.WriteAllText(Path.Combine(root, "started.marker"), DateTime.UtcNow.Ticks.ToString());
            File.WriteAllText(Path.Combine(root, "arguments.marker"),
                arguments == null || arguments.Length == 0 ? string.Empty : arguments[0]);
            File.WriteAllText(Path.Combine(root, "install-root.marker"),
                Environment.GetEnvironmentVariable("LIANGJIAN_BRIDGE_INSTALL_ROOT") ?? string.Empty);
            return 0;
        }
    }
}
