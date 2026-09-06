using System;
using System.IO;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class ProfileAccountDataSmokeTests
    {
        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-account-data-" + Guid.NewGuid().ToString("N"));
            try
            {
                BridgeProfileSettings first = new BridgeProfileSettings { ProfileId = "profile-a", DisplayName = "test",
                    Platform = "mt4", TerminalInstanceId = "terminal-a", BrokerServer = "Demo", Login = "100",
                    ServerUri = "wss://bridge.example.test/bridge/v4/ws", ProtectedRefreshToken = "protected" };
                string legacy = Path.Combine(root, "profiles", first.ProfileId, "bridge.db");
                using (ProfileRuntime runtime = Open(legacy, first, 12))
                {
                    runtime.CommandLedger.Accept(first.ProfileId, "command-one", "idempotency-one", "order.place", "hash", 1000);
                    runtime.CommandLedger.RecordResult(first.ProfileId, "idempotency-one", "uncertain", 1001, "{}");
                }
                ProfileAccountDataLocation location = ProfileAccountDataLocation.Resolve(root, first);
                using (IDisposable lease = ProfileAccountDataLocation.AcquireLease(root, first))
                {
                    bool busy = false;
                    try { using (ProfileAccountDataLocation.AcquireLease(root, first)) { } }
                    catch (IOException) { busy = true; }
                    Check(busy, "profile_opened_twice");
                    BridgeProfileSettings other = first.Clone(); other.ProfileId = "profile-other";
                    using (ProfileAccountDataLocation.AcquireLease(root, other)) { }
                }
                using (ProfileAccountDataLocation.AcquireLease(root, first)) { }
                Check(location.DatabasePath == legacy && location.ConnectionEpoch == 12, "legacy_not_reused");
                BridgeProfileSettings second = first.Clone();
                second.Login = "101";
                location = ProfileAccountDataLocation.Resolve(root, second);
                string secondPath = location.DatabasePath;
                Check(secondPath != legacy && location.ConnectionEpoch == 12, "account_not_isolated");
                using (ProfileRuntime runtime = Open(secondPath, second, location.ConnectionEpoch))
                {
                    runtime.RebindEpoch(13);
                    Check(runtime.CommandLedger.ReadByCommandId(second.ProfileId, "command-one") == null, "ledger_leaked");
                }
                location = ProfileAccountDataLocation.Resolve(root, first);
                Check(location.DatabasePath == legacy && location.ConnectionEpoch == 13, "return_epoch_regressed");
                using (ProfileRuntime runtime = Open(location.DatabasePath, first, location.ConnectionEpoch))
                {
                    Check(runtime.CommandLedger.ReadByCommandId(first.ProfileId, "command-one").State == "uncertain", "uncertain_lost");
                    runtime.RebindEpoch(14);
                }
                location = ProfileAccountDataLocation.Resolve(root, second);
                Check(location.DatabasePath == secondPath && location.ConnectionEpoch == 14, "second_return_failed");
                foreach (string variation in new[] { "server", "instance", "platform" })
                {
                    BridgeProfileSettings changed = first.Clone();
                    if (variation == "server") changed.BrokerServer = "demo";
                    if (variation == "instance") changed.TerminalInstanceId = "terminal-b";
                    if (variation == "platform")
                    {
                        changed.Platform = "mt5"; changed.PythonExecutablePath = @"C:\runtime\python.exe";
                        changed.WorkerScriptPath = @"C:\runtime\worker.py"; changed.TerminalPath = @"C:\mt5\terminal64.exe";
                    }
                    ProfileAccountDataLocation isolated = ProfileAccountDataLocation.Resolve(root, changed);
                    Check(isolated.DatabasePath != legacy && isolated.DatabasePath != secondPath, "route_collision:" + variation);
                }
                // A paired ID/credential survives changing the account in the stored catalog.
                BridgeProfileStore store = new BridgeProfileStore(Path.Combine(root, "profiles.json"), new CurrentUserSecretProtector());
                store.SetRefreshToken(first, "br4-test-profile-credential");
                second = first.Clone(); second.Login = "101";
                BridgeProfileCatalog catalog = new BridgeProfileCatalog { InstallationId = "installation-a" };
                catalog.Profiles.Add(second); store.Save(catalog);
                Check(store.ReadRefreshToken(store.LoadOrCreate().Profiles[0]) == "br4-test-profile-credential", "credential_changed");
                // A corrupt dataset must not silently reset a profile's epoch.
                string bad = Path.Combine(root, "profiles", first.ProfileId, "accounts", new string('a', 64));
                Directory.CreateDirectory(bad);
                File.WriteAllText(Path.Combine(bad, "bridge.db"), "invalid sqlite");
                bool rejected = false;
                try { ProfileAccountDataLocation.Resolve(root, first); } catch { rejected = true; }
                Check(rejected, "corrupt_epoch_ignored");
            }
            finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        }

        private static ProfileRuntime Open(string path, BridgeProfileSettings profile, long epoch)
        {
            return new ProfileRuntime(new ProfileRuntimeConfiguration(path, profile.ProfileId, profile.TerminalInstanceId,
                profile.Platform, profile.BrokerServer, profile.Login, epoch));
        }
        private static void Check(bool valid, string code) { if (!valid) throw new Exception(code); }
    }
}
