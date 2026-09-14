using System;
using System.IO;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Storage;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class ProfileConfigurationSmokeTests
    {
        public static void TestCurrentUserSecretsAndAtomicCatalog()
        {
            string root = NewRoot("profile-store");
            try
            {
                string path = Path.Combine(root, "profiles.json");
                BridgeProfileStore store = new BridgeProfileStore(path, new CurrentUserSecretProtector());
                BridgeProfileCatalog catalog = store.LoadOrCreate();
                BridgeProfileSettings profile = NewProfile("profile-a", "terminal-a", "10001");
                const string token = "secret-bearer-token-for-profile-a";
                store.SetRefreshToken(profile, token);
                catalog.Profiles.Add(profile);
                store.Save(catalog);

                string raw = File.ReadAllText(path);
                Assert(raw.IndexOf(token, StringComparison.Ordinal) < 0, "profile_secret_stored_as_plaintext");
                BridgeProfileCatalog loaded = store.LoadOrCreate();
                Assert(loaded.Profiles.Count == 1 && loaded.InstallationId == catalog.InstallationId,
                    "profile_catalog_round_trip_failed");
                Assert(store.ReadRefreshToken(loaded.Profiles[0]) == token, "profile_secret_round_trip_failed");

                loaded.Profiles[0].DisplayName = "修改后的档案";
                store.Save(loaded);
                Assert(store.LoadOrCreate().Profiles[0].DisplayName == "修改后的档案",
                    "profile_catalog_atomic_replace_failed");
                Assert(!File.Exists(path + ".previous"), "profile_catalog_backup_not_cleaned");
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        public static void TestCatalogRejectsCorruptionAndDuplicates()
        {
            string root = NewRoot("profile-invalid");
            try
            {
                string path = Path.Combine(root, "profiles.json");
                BridgeProfileStore store = new BridgeProfileStore(path, new CurrentUserSecretProtector());
                File.WriteAllText(path, "{not-json");
                AssertThrows<InvalidDataException>(delegate { store.LoadOrCreate(); },
                    "corrupt_profile_catalog_accepted");

                BridgeProfileCatalog valid = new BridgeProfileCatalog { InstallationId = "installation-valid" };
                BridgeProfileSettings validProfile = NewProfile("profile-valid", "terminal-valid", "10000");
                store.SetRefreshToken(validProfile, "valid-secret-token");
                valid.Profiles.Add(validProfile);
                store.Save(valid);
                string serialized = File.ReadAllText(path);
                File.WriteAllText(path, serialized.Replace("\"SchemaVersion\":2", "\"SchemaVersion\":1"));
                AssertThrows<InvalidDataException>(delegate { store.LoadOrCreate(); },
                    "populated_legacy_catalog_implicitly_migrated");
                string unexpected = serialized.Substring(0, serialized.Length - 1) + ",\"Unexpected\":true}";
                File.WriteAllText(path, unexpected);
                AssertThrows<InvalidDataException>(delegate { store.LoadOrCreate(); },
                    "unknown_profile_catalog_field_accepted");

                BridgeProfileCatalog catalog = new BridgeProfileCatalog { InstallationId = "installation-test" };
                BridgeProfileSettings first = NewProfile("profile-a", "terminal-a", "10001");
                BridgeProfileSettings second = NewProfile("profile-b", "terminal-a", "10002");
                first.ProtectedRefreshToken = "encrypted-a";
                second.ProtectedRefreshToken = "encrypted-b";
                catalog.Profiles.Add(first);
                catalog.Profiles.Add(second);
                AssertThrows<InvalidDataException>(delegate { BridgeProfileStore.Validate(catalog, false); },
                    "duplicate_terminal_profile_accepted");

                catalog = new BridgeProfileCatalog { InstallationId = "中文-installation" };
                AssertThrows<InvalidDataException>(delegate { BridgeProfileStore.Validate(catalog, false); },
                    "unicode_installation_id_accepted");
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        public static void TestEmptyLegacyCatalogRemainsIntact()
        {
            string root = NewRoot("profile-empty-legacy");
            try
            {
                string path = Path.Combine(root, "profiles.json");
                const string raw = "{\"SchemaVersion\":1,\"InstallationId\":\"installation-existing\",\"Profiles\":[]}";
                File.WriteAllText(path, raw);
                BridgeProfileStore store = new BridgeProfileStore(path, new CurrentUserSecretProtector());
                BridgeProfileCatalog loaded = store.LoadOrCreate();
                Assert(loaded.SchemaVersion == BridgeProfileStore.CurrentSchemaVersion
                    && loaded.InstallationId == "installation-existing" && loaded.Profiles.Count == 0,
                    "empty_legacy_catalog_not_preserved");
                Assert(File.ReadAllText(path) == raw, "loading_rewrote_legacy_catalog");
                File.WriteAllText(path, raw.Replace("SchemaVersion\":1", "SchemaVersion\":99"));
                AssertThrows<InvalidDataException>(delegate { store.LoadOrCreate(); }, "unknown_empty_schema_accepted");
            }
            finally { DeleteRoot(root); }
        }

        public static void TestPersistedEpochSurvivesRestart()
        {
            string root = NewRoot("profile-epoch");
            string databasePath = Path.Combine(root, "profile.db");
            try
            {
                Assert(ProfileDataStore.ReadPersistedConnectionEpoch(databasePath) == 1,
                    "missing_profile_epoch_not_initialized");
                using (ProfileDataStore store = new ProfileDataStore(databasePath, "profile-a",
                    "terminal-a", "mt4", "Demo", "10001", 1))
                {
                    store.RebindEpoch(4);
                }
                Assert(ProfileDataStore.ReadPersistedConnectionEpoch(databasePath) == 4,
                    "profile_epoch_not_restored");
            }
            finally { DeleteRoot(root); }
        }

        private static BridgeProfileSettings NewProfile(string profileId, string terminalId, string login)
        {
            return new BridgeProfileSettings
            {
                ProfileId = profileId,
                DisplayName = "测试档案",
                Platform = "mt4",
                TerminalInstanceId = terminalId,
                BrokerServer = "Demo",
                Login = login,
                ServerUri = "wss://bridge.example.test/bridge/v4/ws",
                AutoConnect = false,
                PythonExecutablePath = string.Empty,
                WorkerScriptPath = string.Empty,
                TerminalPath = string.Empty
            };
        }

        private static string NewRoot(string suffix)
        {
            string path = Path.Combine(Path.GetTempPath(), "bridge-v4-" + suffix + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }

        private static void DeleteRoot(string root)
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try { action(); }
            catch (T) { return; }
            throw new InvalidOperationException(message);
        }
    }
}
