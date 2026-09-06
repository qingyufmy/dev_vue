using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Terminal
{
    public sealed class DiscoveredTerminal
    {
        public string Platform { get; set; }
        public string TerminalPath { get; set; }
        public string TerminalInstanceId { get; set; }
        public string BrokerServer { get; set; }
        public string Login { get; set; }

        public override string ToString()
        {
            return Platform == "mt5" ? "MT5 · " + TerminalPath
                : "MT4 · " + Login + " · " + BrokerServer + " · " + TerminalInstanceId;
        }
    }

    public interface IMt5TerminalProbe
    {
        string Read(string pythonPath, string workerPath, string terminalPath);
    }

    /// <summary>Discovery never creates a profile, grants ownership or starts a terminal.</summary>
    public sealed class TerminalDiscovery
    {
        private readonly Func<IList<string>> runningPaths;
        private readonly Func<IList<DiscoveredTerminal>> mt4Sessions;
        private readonly IMt5TerminalProbe probe;

        public TerminalDiscovery(Func<IList<string>> paths, Func<IList<DiscoveredTerminal>> sessions,
            IMt5TerminalProbe terminalProbe)
        {
            if (paths == null || sessions == null || terminalProbe == null) throw new ArgumentNullException("discovery");
            runningPaths = paths;
            mt4Sessions = sessions;
            probe = terminalProbe;
        }

        public IList<DiscoveredTerminal> List(string platform)
        {
            List<DiscoveredTerminal> result = new List<DiscoveredTerminal>();
            if (platform == "mt4")
            {
                foreach (DiscoveredTerminal item in mt4Sessions())
                    if (item.Platform == "mt4" && Text(item.TerminalInstanceId, 128)
                        && Text(item.BrokerServer, 128) && Text(item.Login, 64)) result.Add(Copy(item));
            }
            else if (platform == "mt5")
            {
                HashSet<string> unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string path in runningPaths())
                {
                    if (!ValidTerminalPath(path)) continue;
                    string full = Path.GetFullPath(path);
                    if (unique.Add(full)) result.Add(new DiscoveredTerminal
                        { Platform = "mt5", TerminalPath = full, TerminalInstanceId = InstanceId(full) });
                }
            }
            else throw new InvalidDataException("bridge_discovery_platform_invalid");
            result.Sort((left, right) => StringComparer.OrdinalIgnoreCase.Compare(left.ToString(), right.ToString()));
            return result;
        }

        public DiscoveredTerminal Identify(DiscoveredTerminal selected, string pythonPath, string workerPath)
        {
            if (selected == null) throw new InvalidDataException("bridge_discovery_selection_missing");
            DiscoveredTerminal current = FindCurrent(selected);
            if (current.Platform == "mt4") return current;
            string body = probe.Read(pythonPath, workerPath, current.TerminalPath);
            DiscoveredTerminal identified = ParseProbe(current, body);
            FindCurrent(current); // The terminal may have exited during the asynchronous probe.
            return identified;
        }

        private DiscoveredTerminal FindCurrent(DiscoveredTerminal selected)
        {
            foreach (DiscoveredTerminal current in List(selected.Platform))
            {
                if (selected.Platform == "mt5"
                    ? string.Equals(selected.TerminalPath, current.TerminalPath, StringComparison.OrdinalIgnoreCase)
                    : selected.TerminalInstanceId == current.TerminalInstanceId
                        && selected.BrokerServer == current.BrokerServer && selected.Login == current.Login)
                    return current;
            }
            throw new InvalidDataException("bridge_discovery_terminal_changed");
        }

        private static DiscoveredTerminal ParseProbe(DiscoveredTerminal selected, string body)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(body) || body.Length > 8192) throw new InvalidDataException();
                JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 };
                Dictionary<string, object> value = json.DeserializeObject(body) as Dictionary<string, object>;
                object version, path, account;
                if (value == null || value.Count != 3 || !value.TryGetValue("probe_version", out version)
                    || !(version is int) || (int)version != 1
                    || !value.TryGetValue("terminal_path", out path) || !(path is string)
                    || !ValidTerminalPath((string)path)
                    || !string.Equals(Path.GetFullPath((string)path), selected.TerminalPath, StringComparison.OrdinalIgnoreCase)
                    || !value.TryGetValue("account_ref", out account)) throw new InvalidDataException();
                Dictionary<string, object> identity = account as Dictionary<string, object>;
                object server, login;
                if (identity == null || identity.Count != 2 || !identity.TryGetValue("broker_server", out server)
                    || !identity.TryGetValue("login", out login) || !Text(server as string, 128)
                    || !Text(login as string, 64)) throw new InvalidDataException();
                DiscoveredTerminal result = Copy(selected);
                result.BrokerServer = (string)server;
                result.Login = (string)login;
                return result;
            }
            catch (Exception) { throw new InvalidDataException("bridge_discovery_probe_invalid"); }
        }

        private static bool Text(string value, int maximum)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximum || value != value.Trim()) return false;
            foreach (char character in value) if (char.IsControl(character)) return false;
            return true;
        }

        private static bool ValidTerminalPath(string path)
        {
            return Text(path, 4096) && Path.IsPathRooted(path)
                && string.Equals(Path.GetFileName(path), "terminal64.exe", StringComparison.OrdinalIgnoreCase);
        }

        private static string InstanceId(string path)
        {
            using (SHA256 hash = SHA256.Create())
                return "mt5-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(path.ToUpperInvariant())))
                    .Replace("-", string.Empty).ToLowerInvariant();
        }

        private static DiscoveredTerminal Copy(DiscoveredTerminal item)
        {
            return new DiscoveredTerminal { Platform = item.Platform, TerminalPath = item.TerminalPath,
                TerminalInstanceId = item.TerminalInstanceId, BrokerServer = item.BrokerServer, Login = item.Login };
        }
    }
}
