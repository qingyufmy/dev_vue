using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Compatibility;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class LegacyLauncherContractSmokeTests
    {
        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(),
                "liangjian-bridge-v4-legacy-launcher-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                TestLegacyInstallHandoff(root);
                string health = Path.Combine(root, "health-test.json");
                LegacyLaunchRequest healthRequest = LegacyLauncherContract.Parse(new[]
                    { "--health-check", "--health-file", health });
                Require(healthRequest.Mode == LegacyLaunchMode.HealthCheck, "legacy_health_mode_invalid");
                LegacyLauncherContract.WriteHealthSignal(healthRequest.HealthFile, "4.0.0.0");
                Require(File.Exists(health), "legacy_health_signal_missing");

                string ready = Path.Combine(root, "ready-test.json");
                LegacyLaunchRequest runRequest = LegacyLauncherContract.Parse(new[]
                {
                    "--start-minimized", "--ready-file", ready,
                    "--expected-terminal", "mt5_a", "--expected-terminal", "mt4_b"
                });
                Require(runRequest.StartMinimized && runRequest.ExpectedTerminalInstanceIds.Count == 2,
                    "legacy_ready_arguments_invalid");
                LegacyLaunchRequest minimized = LegacyLauncherContract.Parse(new[] { "--start-minimized" });
                Require(minimized.StartMinimized && string.IsNullOrEmpty(minimized.ReadyFile),
                    "legacy_minimized_launch_invalid");
                LegacyLauncherContract.WriteReadySignal(runRequest.ReadyFile, "4.0.0.0",
                    new[] { "mt5_a", "mt4_b" });
                IDictionary<string, object> payload = new JavaScriptSerializer().DeserializeObject(
                    File.ReadAllText(ready)) as IDictionary<string, object>;
                Require(payload != null && (bool)payload["ready"] && (bool)payload["server_connected"],
                    "legacy_ready_signal_invalid");

                RequireThrows(delegate
                {
                    LegacyLauncherContract.Parse(new[] { "--ready-file", "relative.json" });
                }, "legacy_relative_ready_path_accepted");
                RequireThrows(delegate
                {
                    LegacyLauncherContract.Parse(new[]
                    {
                        "--ready-file", ready, "--expected-terminal", "duplicate",
                        "--expected-terminal", "duplicate"
                    });
                }, "legacy_duplicate_terminal_accepted");
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        private static void TestLegacyInstallHandoff(string root)
        {
            string install = Path.Combine(root, "install");
            string versions = Path.Combine(install, "versions");
            string current = Path.Combine(versions, "4.0.0.0");
            string previous = Path.Combine(versions, "3.0.4");
            Directory.CreateDirectory(current);
            Directory.CreateDirectory(previous);
            File.WriteAllText(Path.Combine(install, "AURUMBridge.Launcher.exe"), "launcher");
            File.WriteAllText(Path.Combine(install, "AURUMBridge.UninstallHelper.exe"), "uninstall-helper");
            File.WriteAllText(Path.Combine(current, "AURUMBridge.exe"), "v4");
            File.WriteAllText(Path.Combine(current, "LiangjianBridge.exe"), "v4");
            File.WriteAllText(Path.Combine(previous, "AURUMBridge.exe"), "v3");
            string legacyPointer = Path.Combine(install, "current.json");
            File.WriteAllText(legacyPointer,
                "{\"active_version\":\"4.0.0.0\",\"last_known_good_version\":\"3.0.4\","
                + "\"status\":\"pending\",\"expected_terminal_instance_ids\":[],"
                + "\"updated_at_utc_msc\":1800000000000}");
            string pointerBefore = File.ReadAllText(legacyPointer);
            Require(LegacyInstallHandoff.Prepare(current, "4.0.0.0"),
                "legacy_install_handoff_not_detected");
            Require(File.ReadAllText(Path.Combine(versions, "current.txt")).Trim() == "4.0.0.0",
                "legacy_current_pointer_missing");
            Require(File.ReadAllText(Path.Combine(versions, "previous.txt")).Trim() == "3.0.4",
                "legacy_previous_pointer_missing");
            Require(File.ReadAllText(Path.Combine(previous, "LiangjianBridge.exe")) == "v3",
                "legacy_previous_alias_missing");
            Require(File.ReadAllText(legacyPointer) == pointerBefore,
                "legacy_pointer_was_modified");
            Require(File.ReadAllText(Path.Combine(install, "AURUMBridge.Launcher.exe")) == "launcher"
                && File.ReadAllText(Path.Combine(install, "AURUMBridge.UninstallHelper.exe")) == "uninstall-helper",
                "legacy_shell_entry_was_modified");
            Require(LegacyInstallHandoff.Prepare(current, "4.0.0.0"),
                "legacy_install_handoff_not_idempotent");
            File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.1.0");
            File.WriteAllText(Path.Combine(versions, "previous.txt"), "4.0.0.0");
            File.WriteAllText(legacyPointer,
                "{\"active_version\":\"4.0.0.0\",\"last_known_good_version\":\"4.0.0.0\","
                + "\"status\":\"healthy\",\"expected_terminal_instance_ids\":[],"
                + "\"updated_at_utc_msc\":1800000000001}");
            Require(LegacyInstallHandoff.Prepare(current, "4.0.0.0"),
                "legacy_stable_handoff_not_idempotent");
            Require(File.ReadAllText(Path.Combine(versions, "current.txt")).Trim() == "4.0.0.0"
                && File.ReadAllText(Path.Combine(versions, "previous.txt")).Trim() == "4.0.0.0",
                "legacy_stable_handoff_did_not_repair_v4_pointers");
            File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.1.0");
            File.WriteAllText(Path.Combine(versions, "previous.txt"), "4.0.0.0");
            File.WriteAllText(legacyPointer,
                "{\"active_version\":\"4.0.0.0\",\"last_known_good_version\":\"4.0.0.0\","
                + "\"status\":\"rolled_back\",\"expected_terminal_instance_ids\":[],"
                + "\"updated_at_utc_msc\":1800000000002}");
            Require(LegacyInstallHandoff.Prepare(current, "4.0.0.0"),
                "legacy_rolled_back_handoff_not_accepted");
            Require(File.ReadAllText(Path.Combine(versions, "current.txt")).Trim() == "4.0.0.0"
                && File.ReadAllText(Path.Combine(versions, "previous.txt")).Trim() == "4.0.0.0",
                "legacy_rolled_back_handoff_did_not_repair_v4_pointers");
        }

        private static void Require(bool condition, string code)
        {
            if (!condition) throw new InvalidOperationException(code);
        }

        private static void RequireThrows(Action action, string code)
        {
            try { action(); }
            catch (InvalidDataException) { return; }
            throw new InvalidOperationException(code);
        }
    }
}
