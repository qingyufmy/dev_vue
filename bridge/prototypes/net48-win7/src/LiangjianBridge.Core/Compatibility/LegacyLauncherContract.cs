using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Compatibility
{
    public enum LegacyLaunchMode
    {
        Run,
        HealthCheck
    }

    public sealed class LegacyLaunchRequest
    {
        public LegacyLaunchRequest()
        {
            ExpectedTerminalInstanceIds = new List<string>();
        }

        public LegacyLaunchMode Mode { get; internal set; }
        public bool StartMinimized { get; internal set; }
        public string HealthFile { get; internal set; }
        public string ReadyFile { get; internal set; }
        public IList<string> ExpectedTerminalInstanceIds { get; private set; }
    }

    public static class LegacyLauncherContract
    {
        private const int MaximumTerminalCount = 64;
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        public static LegacyLaunchRequest Parse(string[] arguments)
        {
            string[] values = arguments ?? new string[0];
            if (values.Length == 0)
            {
                return new LegacyLaunchRequest { Mode = LegacyLaunchMode.Run };
            }
            if (values.Length == 1 && values[0] == "--health-check")
            {
                return new LegacyLaunchRequest { Mode = LegacyLaunchMode.HealthCheck };
            }
            if (values.Length == 3 && values[0] == "--health-check"
                && values[1] == "--health-file")
            {
                ValidateSignalPath(values[2], "health-");
                return new LegacyLaunchRequest
                {
                    Mode = LegacyLaunchMode.HealthCheck,
                    HealthFile = Path.GetFullPath(values[2])
                };
            }

            LegacyLaunchRequest request = new LegacyLaunchRequest { Mode = LegacyLaunchMode.Run };
            int index = 0;
            if (values[index] == "--start-minimized")
            {
                request.StartMinimized = true;
                index++;
            }
            if (index == values.Length) return request;
            if (index + 1 >= values.Length || values[index] != "--ready-file")
            {
                throw new InvalidDataException("bridge_arguments_invalid");
            }
            ValidateSignalPath(values[index + 1], "ready-");
            request.ReadyFile = Path.GetFullPath(values[index + 1]);
            index += 2;

            HashSet<string> unique = new HashSet<string>(StringComparer.Ordinal);
            while (index < values.Length)
            {
                if (index + 1 >= values.Length || values[index] != "--expected-terminal"
                    || !ValidTerminalId(values[index + 1])
                    || !unique.Add(values[index + 1])
                    || unique.Count > MaximumTerminalCount)
                {
                    throw new InvalidDataException("bridge_arguments_invalid");
                }
                request.ExpectedTerminalInstanceIds.Add(values[index + 1]);
                index += 2;
            }
            return request;
        }

        public static void WriteHealthSignal(string path, string version)
        {
            ValidateSignalPath(path, "health-");
            ValidateVersion(version);
            AtomicWrite(path, new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "ok", true },
                { "version", version },
                { "implementation", "dotnet48-v4-transition" },
                { "checked_at_utc_msc", UtcNowMsc() },
                { "checks", new object[] { "net48_runtime", "core_assembly" } }
            });
        }

        public static void WriteReadySignal(string path, string version,
            IEnumerable<string> runningTerminalInstanceIds)
        {
            ValidateSignalPath(path, "ready-");
            ValidateVersion(version);
            if (runningTerminalInstanceIds == null)
                throw new InvalidDataException("bridge_ready_terminals_invalid");
            SortedSet<string> terminals = new SortedSet<string>(StringComparer.Ordinal);
            foreach (string terminalId in runningTerminalInstanceIds)
            {
                if (!ValidTerminalId(terminalId) || !terminals.Add(terminalId)
                    || terminals.Count > MaximumTerminalCount)
                    throw new InvalidDataException("bridge_ready_terminals_invalid");
            }
            AtomicWrite(path, new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "ready", true },
                { "version", version },
                { "server_connected", true },
                { "running_terminal_instance_ids", new List<string>(terminals) },
                { "ready_at_utc_msc", UtcNowMsc() }
            });
        }

        private static void AtomicWrite(string path, object payload)
        {
            string resolved = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(resolved);
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
                throw new DirectoryNotFoundException("bridge_signal_directory_missing");
            string temporary = resolved + ".tmp-" + Guid.NewGuid().ToString("N");
            byte[] bytes = Encoding.UTF8.GetBytes(Serializer.Serialize(payload));
            try
            {
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew,
                    FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
                if (File.Exists(resolved)) File.Replace(temporary, resolved, null, true);
                else File.Move(temporary, resolved);
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        private static void ValidateSignalPath(string path, string prefix)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path))
                    throw new InvalidDataException("bridge_signal_path_invalid");
                string name = Path.GetFileName(path);
                if (string.IsNullOrEmpty(name) || !name.StartsWith(prefix, StringComparison.Ordinal)
                    || !name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("bridge_signal_path_invalid");
                Path.GetFullPath(path);
            }
            catch (InvalidDataException) { throw; }
            catch (Exception error)
            {
                if (error is ArgumentException || error is NotSupportedException
                    || error is PathTooLongException)
                    throw new InvalidDataException("bridge_signal_path_invalid", error);
                throw;
            }
        }

        private static void ValidateVersion(string version)
        {
            Version parsed;
            if (string.IsNullOrWhiteSpace(version) || !Version.TryParse(version, out parsed)
                || parsed.Major < 0)
                throw new InvalidDataException("bridge_version_invalid");
        }

        private static bool ValidTerminalId(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 128) return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                bool asciiLetter = (current >= 'a' && current <= 'z')
                    || (current >= 'A' && current <= 'Z');
                if (!asciiLetter && !(current >= '0' && current <= '9')
                    && current != '_' && current != '-') return false;
            }
            return true;
        }

        private static long UtcNowMsc()
        {
            return (long)(DateTime.UtcNow
                - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }
}
