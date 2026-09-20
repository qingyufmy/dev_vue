using System;
using System.IO;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class ProfileConnectionSettingsSmokeTests
    {
        public static void RunAll()
        {
            BridgeProfileSettings original = new BridgeProfileSettings { Platform = "mt5", TerminalInstanceId = "a",
                BrokerServer = "Demo", Login = "1", ServerUri = "wss://example.test/bridge/v4/ws",
                PythonExecutablePath = "C:\\old\\python.exe", WorkerScriptPath = "C:\\old\\worker.py",
                TerminalPath = "C:\\old\\terminal64.exe" };
            Action<BridgeProfileSettings>[] changes = {
                delegate(BridgeProfileSettings p) { p.ServerUri = "wss://new.example.test/bridge/v4/ws"; },
                delegate(BridgeProfileSettings p) { p.PythonExecutablePath = "C:\\new\\python.exe"; },
                delegate(BridgeProfileSettings p) { p.WorkerScriptPath = "C:\\new\\worker.py"; },
                delegate(BridgeProfileSettings p) { p.TerminalPath = "C:\\new\\terminal64.exe"; },
                delegate(BridgeProfileSettings p) { p.Mt5Portable = true; },
                delegate(BridgeProfileSettings p) { p.Mt5DataPath = "C:\\new\\data"; }
            };
            foreach (Action<BridgeProfileSettings> change in changes)
            {
                BridgeProfileSettings edited = original.Clone();
                change(edited);
                Assert(original.SameRoute(edited), "settings_changed_account_identity");
                Assert(!original.SameConnectionSettings(edited), "edited_connection_not_invalidated");
            }
            BridgeProfileSettings renamed = original.Clone();
            renamed.DisplayName = "renamed"; renamed.AutoConnect = true;
            Assert(original.SameConnectionSettings(renamed), "cosmetic_edit_stops_connection");
            TestOptionalSettingsRoundTrip();
        }

        private static void TestOptionalSettingsRoundTrip()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-settings-" + Guid.NewGuid().ToString("N"));
            string path = Path.Combine(root, "profiles.json");
            try
            {
                BridgeProfileStore store = new BridgeProfileStore(path, new CurrentUserSecretProtector());
                BridgeProfileCatalog catalog = store.LoadOrCreate();
                BridgeProfileSettings profile = new BridgeProfileSettings { ProfileId = "p", DisplayName = "p",
                    Platform = "mt4", TerminalInstanceId = "t", BrokerServer = "Demo", Login = "1",
                    ServerUri = "wss://example.test/bridge/v4/ws", ProtectedRefreshToken = "protected" };
                catalog.Profiles.Add(profile); store.Save(catalog);
                string old = File.ReadAllText(path);
                Assert(!old.Contains("Mt5Portable") && !old.Contains("Mt5DataPath"), "default_settings_break_legacy_reader");
                profile.Mt5Portable = true; profile.Mt5DataPath = "C:\\terminal-data"; store.Save(catalog);
                BridgeProfileSettings loaded = store.LoadOrCreate().Profiles[0];
                Assert(loaded.Mt5Portable && loaded.Mt5DataPath == profile.Mt5DataPath, "settings_round_trip_failed");
                string valid = File.ReadAllText(path);
                File.WriteAllText(path, valid.Replace("\"Mt5Portable\":true", "\"Mt5Portable\":\"true\""));
                bool rejected = false;
                try { store.LoadOrCreate(); } catch (InvalidDataException) { rejected = true; }
                Assert(rejected, "portable_wrong_type_accepted");
                File.WriteAllText(path, valid.Replace("\"Mt5DataPath\":\"C:\\\\terminal-data\"", "\"Mt5DataPath\":null"));
                rejected = false;
                try { store.LoadOrCreate(); } catch (InvalidDataException) { rejected = true; }
                Assert(rejected, "data_path_wrong_type_accepted");
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        private static void Assert(bool value, string code) { if (!value) throw new InvalidOperationException(code); }
    }
}
