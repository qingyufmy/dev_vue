using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Terminal;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class TerminalDiscoverySmokeTests
    {
        public static void RunAll()
        {
            string first = @"C:\Demo 一\terminal64.exe";
            string second = @"C:\Demo Two\terminal64.exe";
            List<string> paths = new List<string> { first, first.ToUpperInvariant(), second, @"C:\Other\not-terminal.exe" };
            List<DiscoveredTerminal> mt4 = new List<DiscoveredTerminal> { new DiscoveredTerminal
                { Platform = "mt4", TerminalInstanceId = "terminal-four", BrokerServer = "Demo", Login = "100" } };
            FakeProbe probe = new FakeProbe { Body = Body(first, "200") };
            TerminalDiscovery discovery = new TerminalDiscovery(() => paths, () => mt4, probe);
            IList<DiscoveredTerminal> listed = discovery.List("mt5");
            Check(listed.Count == 2 && probe.Calls == 0, "list_must_not_probe_or_duplicate");
            DiscoveredTerminal selected = null;
            foreach (DiscoveredTerminal item in listed) if (item.TerminalPath == first) selected = item;
            Check(selected != null, "missing_selected_path");
            DiscoveredTerminal identified = discovery.Identify(selected, "python", "worker");
            DiscoveredTerminal portableResult = discovery.Identify(selected, "python", "worker", true, Path.GetDirectoryName(first));
            Check(portableResult.Portable && probe.Portable && probe.ExpectedDataPath == Path.GetDirectoryName(first), "portable_data_path_not_forwarded");
            Expect(() => discovery.Identify(selected, "python", "worker", true, @"C:\OtherData"), "bridge_discovery_data_path_mismatch");
            string id = identified.TerminalInstanceId;
            Check(identified.Login == "200" && identified.TerminalInstanceId != selected.TerminalInstanceId && selected.Login == null,
                "identify_mutated_selection_or_lost_account");
            probe.Body = Body(first, "201");
            Check(discovery.Identify(selected, "python", "worker").Login == "201", "account_change_was_cached");
            paths.Remove(first);
            Check(discovery.Identify(selected, "python", "worker").TerminalInstanceId == id, "path_case_changes_identity");
            probe.Body = Body(second, "200");
            Expect(() => discovery.Identify(selected, "python", "worker"), "bridge_discovery_probe_invalid");
            foreach (string invalid in new[] { "{}", "not json", Body(first, " "), Body(first, "200\n"),
                Body(first, "200").Replace("\"probe_version\":1", "\"probe_version\":2"), new string('x', 8193) })
            {
                probe.Body = invalid;
                Expect(() => discovery.Identify(selected, "python", "worker"), "bridge_discovery_probe_invalid");
            }
            probe.Body = Body(first, "200");
            probe.AfterRead = () => paths.Clear();
            Expect(() => discovery.Identify(selected, "python", "worker"), "bridge_discovery_terminal_changed");
            int calls = probe.Calls;
            Expect(() => discovery.Identify(selected, "python", "worker"), "bridge_discovery_terminal_changed");
            Check(probe.Calls == calls, "stopped_terminal_was_probed");
            DiscoveredTerminal four = discovery.List("mt4")[0];
            Check(discovery.Identify(four, null, null).Login == "100" && probe.Calls == calls, "mt4_used_python");
            mt4[0].Login = "101";
            Expect(() => discovery.Identify(four, null, null), "bridge_discovery_terminal_changed");
            Expect(() => discovery.Identify(null, null, null), "bridge_discovery_selection_missing");
            TestProcess();
        }

        // Runs only inside a spawned copy of this test executable. Never imports MT5.
        public static int RunFixture(string file, string terminal, bool portable = false)
        {
            string mode = File.ReadAllText(file);
            if (mode == "portable" && (!portable || Environment.GetEnvironmentVariable("AURUM_BRIDGE_WORKER_DATA_PATH") != Path.GetDirectoryName(terminal))) return 3;
            if (mode == "timeout") { Thread.Sleep(30000); return 0; }
            if (mode == "oversize") { Console.Write(new string('x', 9000)); return 0; }
            if (mode == "error") { Console.Error.Write("fixture_private_error"); return 2; }
            Console.Write(Body(terminal, "456"));
            return 0;
        }

        private static void TestProcess()
        {
            string directory = Path.Combine(Path.GetTempPath(), "bridge-discovery-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                string worker = Path.Combine(directory, "worker.probe-fixture");
                string terminal = Path.Combine(directory, "terminal64.exe");
                File.WriteAllText(terminal, "not an executable");
                File.WriteAllText(worker, "success");
                string executable = Assembly.GetExecutingAssembly().Location;
                Mt5TerminalProbeProcess process = new Mt5TerminalProbeProcess();
                string result = process.Read(executable, worker, terminal);
                Check(result.Contains("456"), "probe_process_arguments_or_output");
                File.WriteAllText(worker, "portable");
                Check(process.Read(executable, worker, terminal, true, directory).Contains("456"), "probe_portable_arguments_or_data_path");
                File.WriteAllText(worker, "error");
                Expect(() => process.Read(executable, worker, terminal), "bridge_discovery_probe_failed");
                File.WriteAllText(worker, "oversize");
                Expect(() => process.Read(executable, worker, terminal), "bridge_discovery_probe_failed");
                File.WriteAllText(worker, "timeout");
                Stopwatch elapsed = Stopwatch.StartNew();
                Expect(() => new Mt5TerminalProbeProcess(300).Read(executable, worker, terminal), "bridge_discovery_probe_timeout");
                Check(elapsed.ElapsedMilliseconds < 5000, "probe_timeout_not_bounded");
                Expect(() => process.Read("python", worker, terminal), "bridge_discovery_paths_invalid");
            }
            finally { Directory.Delete(directory, true); }
        }

        private static string Body(string path, string login)
        {
            return new JavaScriptSerializer().Serialize(new { probe_version = 1, terminal_path = path,
                data_path = Path.GetDirectoryName(path),
                account_ref = new { broker_server = "Demo", login = login } });
        }

        private static void Expect(Action action, string expected)
        {
            try { action(); }
            catch (Exception error) { if (error.Message == expected) return; throw; }
            throw new Exception("missing_discovery_error:" + expected);
        }

        private static void Check(bool valid, string code) { if (!valid) throw new Exception(code); }

        private sealed class FakeProbe : IMt5TerminalProbe
        {
            public string Body;
            public int Calls;
            public Action AfterRead;
            public bool Portable;
            public string ExpectedDataPath;
            public string Read(string python, string worker, string terminal, bool portable = false, string expectedDataPath = null)
            {
                Calls++;
                Portable = portable; ExpectedDataPath = expectedDataPath;
                if (AfterRead != null) AfterRead();
                return Body;
            }
        }
    }
}
