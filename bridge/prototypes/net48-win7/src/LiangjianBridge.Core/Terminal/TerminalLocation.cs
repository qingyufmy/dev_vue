using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class TerminalLocation
    {
        public string ExecutablePath { get; private set; }
        public bool Portable { get; private set; }

        public static TerminalLocation Resolve(string input, string platform)
        {
            if (string.IsNullOrWhiteSpace(input) || !Path.IsPathRooted(input)
                || (platform != "mt4" && platform != "mt5"))
                throw new InvalidDataException("bridge_terminal_location_invalid");
            string path = Path.GetFullPath(input.Trim());
            bool portable = false;
            if (string.Equals(Path.GetExtension(path), ".lnk", StringComparison.OrdinalIgnoreCase))
            {
                if (!File.Exists(path)) throw new InvalidDataException("bridge_terminal_location_missing");
                object shell = null, shortcut = null;
                try
                {
                    Type type = Type.GetTypeFromProgID("WScript.Shell", true);
                    shell = Activator.CreateInstance(type);
                    shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                    string target = Convert.ToString(shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null));
                    string arguments = Convert.ToString(shortcut.GetType().InvokeMember("Arguments", BindingFlags.GetProperty, null, shortcut, null)).Trim();
                    if (!string.IsNullOrEmpty(arguments) && !string.Equals(arguments, "/portable", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("bridge_terminal_shortcut_arguments_unsupported");
                    portable = !string.IsNullOrEmpty(arguments);
                    if (string.IsNullOrWhiteSpace(target) || !Path.IsPathRooted(target))
                        throw new InvalidDataException("bridge_terminal_location_invalid");
                    path = Path.GetFullPath(target);
                }
                finally
                {
                    if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                    if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
                }
            }
            string executable = platform == "mt5" ? "terminal64.exe" : "terminal.exe";
            if (Directory.Exists(path)) path = Path.Combine(path, executable);
            if (!string.Equals(Path.GetFileName(path), executable, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("bridge_terminal_location_not_terminal");
            if (!File.Exists(path)) throw new InvalidDataException("bridge_terminal_location_missing");
            return new TerminalLocation { ExecutablePath = path, Portable = portable };
        }
    }
}
