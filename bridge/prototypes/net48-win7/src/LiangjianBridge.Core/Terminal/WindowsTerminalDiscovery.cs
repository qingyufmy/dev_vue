using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace Liangjian.BridgeV4.Terminal
{
    public static class WindowsTerminalDiscovery
    {
        public static TerminalDiscovery Create(TerminalSessionHost host)
        {
            if (host == null) throw new ArgumentNullException("host");
            return new TerminalDiscovery(RunningMt5Paths, () =>
            {
                List<DiscoveredTerminal> result = new List<DiscoveredTerminal>();
                foreach (TerminalSessionSnapshot session in host.Snapshot())
                    if (session.Platform == "mt4" && session.Connected)
                        result.Add(new DiscoveredTerminal { Platform = "mt4", TerminalInstanceId = session.TerminalInstanceId,
                            BrokerServer = session.BrokerServer, Login = session.Login });
                return result;
            }, new Mt5TerminalProbeProcess());
        }

        private static IList<string> RunningMt5Paths()
        {
            List<string> paths = new List<string>();
            // QueryFullProcessImageName works from the x86 app against x64 MT5 on Win7.
            foreach (Process process in Process.GetProcessesByName("terminal64"))
            {
                using (process)
                {
                    IntPtr handle = OpenProcess(0x1000, false, process.Id);
                    if (handle == IntPtr.Zero) continue;
                    try
                    {
                        StringBuilder path = new StringBuilder(4096);
                        int size = path.Capacity;
                        if (QueryFullProcessImageName(handle, 0, path, ref size)) paths.Add(path.ToString());
                    }
                    finally { CloseHandle(handle); }
                }
            }
            return paths;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }

    public sealed class Mt5TerminalProbeProcess : IMt5TerminalProbe
    {
        private readonly int timeoutMilliseconds;
        public Mt5TerminalProbeProcess(int timeout = 15000)
        {
            if (timeout < 100 || timeout > 15000) throw new ArgumentOutOfRangeException("timeout");
            timeoutMilliseconds = timeout;
        }

        public string Read(string pythonPath, string workerPath, string terminalPath)
        {
            RequireFile(pythonPath);
            RequireFile(workerPath);
            RequireFile(terminalPath);
            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = pythonPath,
                Arguments = Quote(workerPath) + " --probe --terminal " + Quote(terminalPath),
                WorkingDirectory = Path.GetDirectoryName(workerPath),
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            using (Process process = new Process { StartInfo = start })
            {
                if (!process.Start()) throw new IOException("bridge_discovery_probe_failed");
                Task<string> output = Task.Run(() => ReadBounded(process.StandardOutput));
                Task<string> error = Task.Run(() => ReadBounded(process.StandardError));
                try
                {
                    if (!process.WaitForExit(timeoutMilliseconds)) throw new IOException("bridge_discovery_probe_timeout");
                    if (!Task.WaitAll(new Task[] { output, error }, 1000) || process.ExitCode != 0)
                        throw new IOException("bridge_discovery_probe_failed");
                    return output.Result;
                }
                catch (AggregateException) { throw new IOException("bridge_discovery_probe_failed"); }
                finally
                {
                    // Only our short-lived Python process. Never kill MT4/MT5 or a live worker.
                    if (!process.HasExited) { process.Kill(); process.WaitForExit(1000); }
                }
            }
        }

        private static string ReadBounded(StreamReader reader)
        {
            StringBuilder result = new StringBuilder();
            char[] buffer = new char[256];
            int count;
            while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (result.Length + count > 8192) throw new IOException("bridge_discovery_output_limit");
                result.Append(buffer, 0, count);
            }
            return result.ToString();
        }

        private static void RequireFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || path.IndexOf('"') >= 0 || path.IndexOf('\n') >= 0
                || path.IndexOf('\r') >= 0 || !Path.IsPathRooted(path) || !File.Exists(path))
                throw new IOException("bridge_discovery_paths_invalid");
        }

        private static string Quote(string path) { return "\"" + path + "\""; }
    }
}
