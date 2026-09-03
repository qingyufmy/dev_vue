using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class LegacyV3MigrationSmokeTests
    {
        public static void RunAll()
        {
            TestReadOnlyIdempotentSnapshot();
            TestMalformedAndOversizedInputsFailClosed();
        }

        private static void TestReadOnlyIdempotentSnapshot()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-legacy-migration", Guid.NewGuid().ToString("N"));
            string installRoot = Path.Combine(root, "legacy-install");
            string dataRoot = Path.Combine(root, "legacy-data");
            string observerRoot = Path.Combine(dataRoot, "profiles", "observer-one");
            string destination = Path.Combine(root, "pending", "legacy-v3.json");
            string defaultDatabase = Path.Combine(dataRoot, "bridge.db");
            string observerDatabase = Path.Combine(observerRoot, "bridge.db");
            try
            {
                Directory.CreateDirectory(installRoot);
                Directory.CreateDirectory(observerRoot);
                WriteText(Path.Combine(installRoot, "installation-id"), "install_legacy_fixture_01\n");
                WriteText(Path.Combine(dataRoot, "endpoint-settings.json"),
                    "{\"schema_version\":1,\"control_url\":\"https://trade.example.test/\",\"realtime_url\":\"wss://trade.example.test/\"}");
                WritePreferences(Path.Combine(dataRoot, "preferences.json"), "mt5", "mt5-default", "D:\\Terminals\\mt5-default");
                WritePreferences(Path.Combine(observerRoot, "preferences.json"), "mt4", "mt4-observer", "D:\\Terminals\\mt4-observer");
                WriteText(Path.Combine(dataRoot, "credential.dat"), "legacy-refresh-token-must-not-be-copied");
                CreateBindingDatabase(defaultDatabase, new BindingRow
                {
                    TerminalInstanceId = "mt5-default",
                    Platform = "mt5",
                    TerminalPath = "D:\\Terminals\\mt5-default",
                    BrokerServer = "Broker-Demo",
                    Login = "10001",
                    ConnectionEpoch = 2,
                    UpdatedAtUtcMsc = 1788307200000
                }, new BindingRow
                {
                    TerminalInstanceId = "mt5-default",
                    Platform = "mt5",
                    TerminalPath = "D:\\Terminals\\mt5-default",
                    BrokerServer = "Broker-Demo",
                    Login = "10001",
                    ConnectionEpoch = 2,
                    UpdatedAtUtcMsc = 1788307200000
                });
                CreateBindingDatabase(observerDatabase, new BindingRow
                {
                    TerminalInstanceId = "mt4-observer",
                    Platform = "mt4",
                    TerminalPath = "D:\\Terminals\\mt4-observer",
                    BrokerServer = "Broker-Observer",
                    Login = "20002",
                    ConnectionEpoch = 7,
                    UpdatedAtUtcMsc = 1788307200001
                });

                string sourceBefore = HashTree(root, destination);
                File.SetAttributes(defaultDatabase, FileAttributes.ReadOnly);
                LegacyV3MigrationSnapshot first = LegacyV3Migration.Generate(installRoot, dataRoot, destination);
                string firstJson = File.ReadAllText(destination, Encoding.UTF8);
                string sourceAfterFirst = HashTree(root, destination);
                Assert(sourceBefore == sourceAfterFirst, "legacy_source_changed_on_first_read");
                Assert(first.SchemaVersion == 1 && first.Profiles.Count == 2, "legacy_profile_snapshot_wrong");
                Assert(first.Profiles[0].TerminalBindings.Count == 1, "legacy_duplicate_binding_not_removed");
                Assert(first.Profiles[1].TerminalBindings.Count == 1, "legacy_observer_binding_missing");
                Assert(first.EndpointOverride.Status == "candidate"
                    && first.EndpointOverride.CandidateControlUri == "https://trade.example.test/"
                    && first.EndpointOverride.CandidateRealtimeUri == "wss://trade.example.test/"
                    && !first.EndpointOverride.ActivationReady
                    && first.EndpointOverride.Reason == "v4_endpoint_confirmation_required",
                    "legacy_https_endpoint_candidate_wrong");
                Assert(first.CredentialExchangeRequired, "legacy_exchange_flag_missing");
                Assert(first.Profiles[0].CredentialFilePresent
                    && first.Profiles[0].CredentialState == "present_pending_exchange", "legacy_credential_state_wrong");
                Assert(!first.Profiles[1].CredentialFilePresent
                    && first.Profiles[1].CredentialState == "missing_pending_pairing", "legacy_missing_credential_state_wrong");
                Assert(ContainsAll(first.DiscardedCategories, new[]
                {
                    "cache", "log", "runtime-status", "snapshots", "cursors", "outbox"
                }), "legacy_discarded_categories_incomplete");
                Assert(firstJson.IndexOf("legacy-refresh-token-must-not-be-copied", StringComparison.Ordinal) < 0,
                    "legacy_credential_content_written");
                Assert(firstJson.IndexOf("RefreshToken", StringComparison.OrdinalIgnoreCase) < 0,
                    "legacy_credential_field_written");

                File.SetAttributes(defaultDatabase, FileAttributes.Normal);
                LegacyV3MigrationSnapshot second = LegacyV3Migration.Generate(installRoot, dataRoot, destination);
                string secondJson = File.ReadAllText(destination, Encoding.UTF8);
                IDictionary<string, object> firstDocument = Parse(firstJson);
                IDictionary<string, object> secondDocument = Parse(secondJson);
                firstDocument.Remove("created_at_utc_msc");
                secondDocument.Remove("created_at_utc_msc");
                Assert(new JavaScriptSerializer().Serialize(firstDocument)
                    == new JavaScriptSerializer().Serialize(secondDocument), "legacy_snapshot_not_idempotent");
                Assert(first.SourceFingerprint == second.SourceFingerprint, "legacy_source_fingerprint_changed");
                Assert(HashTree(root, destination) == sourceBefore, "legacy_source_changed_on_second_read");
            }
            finally
            {
                ClearReadOnly(root);
                DeleteTree(root);
            }
        }

        private static void TestMalformedAndOversizedInputsFailClosed()
        {
            string root = Path.Combine(Path.GetTempPath(), "liangjian-bridge-v4-legacy-fail-closed", Guid.NewGuid().ToString("N"));
            string installRoot = Path.Combine(root, "legacy-install");
            string dataRoot = Path.Combine(root, "legacy-data");
            string preferencesPath = Path.Combine(dataRoot, "preferences.json");
            string destination = Path.Combine(root, "pending", "legacy-v3.json");
            try
            {
                Directory.CreateDirectory(installRoot);
                Directory.CreateDirectory(dataRoot);
                WriteText(Path.Combine(installRoot, "installation-id"), "install_legacy_fixture_02");
                WritePreferences(preferencesPath, "mt5", "mt5-default", "D:\\Terminals\\mt5-default");
                WriteText(Path.Combine(dataRoot, "endpoint-settings.json"),
                    "{\"schema_version\":1,\"control_url\":\"http://127.0.0.1:3000/\",\"realtime_url\":\"ws://127.0.0.1:3000/\"}");
                LegacyV3Migration.Generate(installRoot, dataRoot, destination);
                string stableOutput = File.ReadAllText(destination, Encoding.UTF8);

                WriteText(preferencesPath, "{\"Platform\":\"mt5\",\"Unknown\":true}");
                AssertThrows(delegate
                {
                    LegacyV3Migration.Generate(installRoot, dataRoot, destination);
                }, "legacy_unknown_preference_accepted");
                Assert(File.ReadAllText(destination, Encoding.UTF8) == stableOutput,
                    "legacy_failed_read_replaced_snapshot");

                WriteText(preferencesPath, new string('x', LegacyV3Migration.MaximumJsonBytes + 1));
                AssertThrows(delegate
                {
                    LegacyV3Migration.Generate(installRoot, dataRoot, destination);
                }, "legacy_oversized_json_accepted");

                WritePreferences(preferencesPath, "mt5", "mt5-default", "D:\\Terminals\\mt5-default");
                WriteText(Path.Combine(dataRoot, "endpoint-settings.json"),
                    "{\"schema_version\":1,\"control_url\":\"ftp://trade.example.test/\",\"realtime_url\":\"ws://trade.example.test/\"}");
                LegacyV3MigrationSnapshot pending = LegacyV3Migration.Generate(installRoot, dataRoot, destination);
                Assert(pending.EndpointOverride.Status == "pending"
                    && !pending.EndpointOverride.ActivationReady
                    && string.IsNullOrEmpty(pending.EndpointOverride.CandidateRealtimeUri),
                    "legacy_invalid_endpoint_not_pending");
            }
            finally
            {
                DeleteTree(root);
            }
        }

        private static void CreateBindingDatabase(string path, params BindingRow[] rows)
        {
            string directory = Path.GetDirectoryName(path);
            Directory.CreateDirectory(directory);
            using (SQLiteConnection connection = new SQLiteConnection("Data Source=" + path + ";Version=3;"))
            {
                connection.Open();
                using (SQLiteCommand create = connection.CreateCommand())
                {
                    create.CommandText = "CREATE TABLE terminal_bindings (terminal_instance_id TEXT NOT NULL, platform TEXT NOT NULL, terminal_path TEXT NOT NULL, broker_server TEXT NOT NULL, login_account TEXT NOT NULL, connection_epoch INTEGER NOT NULL, updated_at_utc_msc INTEGER NOT NULL);";
                    create.ExecuteNonQuery();
                }
                foreach (BindingRow row in rows)
                {
                    using (SQLiteCommand insert = connection.CreateCommand())
                    {
                        insert.CommandText = "INSERT INTO terminal_bindings (terminal_instance_id, platform, terminal_path, broker_server, login_account, connection_epoch, updated_at_utc_msc) VALUES (@terminal, @platform, @path, @broker, @login, @epoch, @updated);";
                        AddParameter(insert, "@terminal", row.TerminalInstanceId);
                        AddParameter(insert, "@platform", row.Platform);
                        AddParameter(insert, "@path", row.TerminalPath);
                        AddParameter(insert, "@broker", row.BrokerServer);
                        AddParameter(insert, "@login", row.Login);
                        AddParameter(insert, "@epoch", row.ConnectionEpoch);
                        AddParameter(insert, "@updated", row.UpdatedAtUtcMsc);
                        insert.ExecuteNonQuery();
                    }
                }
            }
        }

        private static void AddParameter(SQLiteCommand command, string name, object value)
        {
            SQLiteParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value;
            command.Parameters.Add(parameter);
        }

        private static void WritePreferences(string path, string platform, string terminalId, string terminalPath)
        {
            Dictionary<string, object> preferences = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "Platform", platform },
                { "Mt5TerminalInstanceId", platform == "mt5" ? terminalId : null },
                { "Mt5TerminalPath", platform == "mt5" ? terminalPath : null },
                { "Mt4TerminalInstanceId", platform == "mt4" ? terminalId : null },
                { "Mt4TerminalPath", platform == "mt4" ? terminalPath : null },
                { "ObserverEnabled", true },
                { "ObserverBridgeUserId", null },
                { "ObserverAccountLabel", null },
                { "ObserverTradingAccountId", null },
                { "ObserverTradingAccountLabel", null },
                { "ObserverClaimedTerminalInstanceId", platform == "mt4" ? terminalId : null },
                { "AutoStartEnabled", true }
            };
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            WriteText(path, serializer.Serialize(preferences));
        }

        private static IDictionary<string, object> Parse(string json)
        {
            return (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
        }

        private static bool ContainsAll(IList<string> values, string[] expected)
        {
            for (int index = 0; index < expected.Length; index++)
            {
                bool found = false;
                for (int valueIndex = 0; valueIndex < values.Count; valueIndex++)
                {
                    if (values[valueIndex] == expected[index])
                    {
                        found = true;
                        break;
                    }
                }
                if (!found) return false;
            }
            return true;
        }

        private static string HashTree(string root, string ignoredPath)
        {
            List<string> files = new List<string>();
            string[] allFiles = Directory.GetFiles(root, "*", SearchOption.AllDirectories);
            for (int index = 0; index < allFiles.Length; index++)
            {
                if (string.Equals(Path.GetFullPath(allFiles[index]), Path.GetFullPath(ignoredPath), StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                files.Add(allFiles[index]);
            }
            files.Sort(StringComparer.OrdinalIgnoreCase);
            using (SHA256 hash = SHA256.Create())
            using (MemoryStream content = new MemoryStream())
            {
                for (int index = 0; index < files.Count; index++)
                {
                    byte[] pathBytes = Encoding.UTF8.GetBytes(files[index].Substring(root.Length));
                    byte[] fileBytes = File.ReadAllBytes(files[index]);
                    content.Write(pathBytes, 0, pathBytes.Length);
                    content.WriteByte(0);
                    content.Write(fileBytes, 0, fileBytes.Length);
                    content.WriteByte(0);
                }
                byte[] digest = hash.ComputeHash(content.ToArray());
                return Convert.ToBase64String(digest);
            }
        }

        private static void ClearReadOnly(string root)
        {
            if (!Directory.Exists(root)) return;
            string[] files = Directory.GetFiles(root, "*", SearchOption.AllDirectories);
            for (int index = 0; index < files.Length; index++)
            {
                File.SetAttributes(files[index], FileAttributes.Normal);
            }
        }

        private static void DeleteTree(string root)
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }

        private static void WriteText(string path, string value)
        {
            string parent = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            File.WriteAllText(path, value, new UTF8Encoding(false));
        }

        private static void AssertThrows(Action action, string message)
        {
            try
            {
                action();
            }
            catch (InvalidDataException)
            {
                return;
            }
            throw new InvalidOperationException(message);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private sealed class BindingRow
        {
            public string TerminalInstanceId;
            public string Platform;
            public string TerminalPath;
            public string BrokerServer;
            public string Login;
            public long ConnectionEpoch;
            public long UpdatedAtUtcMsc;
        }
    }
}
