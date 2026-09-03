using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class LegacyV3CredentialExchangeSmokeTests
    {
        private const string CandidateControl = "http://127.0.0.1:3000/";
        private const string CandidateRealtime = "ws://127.0.0.1:3000/";
        private const string Fingerprint = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        private const string V3Entropy = "AURUM Bridge v3 refresh credential";

        public static void RunAll()
        {
            TestCredentialReaderStrictAndRedacted();
            TestTwoProfilesImportAtomically();
            TestLaterExchangeFailurePreservesCatalog();
            TestEndpointAndResponseValidation();
        }

        private static void TestCredentialReaderStrictAndRedacted()
        {
            string root = NewRoot("credential-reader");
            try
            {
                string path = Path.Combine(root, "credential.dat");
                string token = Token('r');
                WriteCredential(path, token, 1900000000000L);
                using (LegacyV3RefreshCredential credential = LegacyV3CredentialReader.Read(path, 1800000000000L))
                {
                    Assert(credential.RefreshToken == token && credential.ExpiresAtUtcMsc == 1900000000000L,
                        "v3_credential_round_trip_failed");
                }
                File.WriteAllText(path, "not-dpapi", Encoding.UTF8);
                Exception malformed = Capture(delegate
                {
                    LegacyV3CredentialReader.Read(path, 1800000000000L);
                });
                Assert(malformed != null && malformed.Message.IndexOf(token, StringComparison.Ordinal) < 0,
                    "malformed_credential_leaked_token");

                WriteCredential(path, token, 1700000000000L);
                Exception expired = Capture(delegate
                {
                    LegacyV3CredentialReader.Read(path, 1800000000000L);
                });
                Assert(expired != null && expired.Message.IndexOf(token, StringComparison.Ordinal) < 0,
                    "expired_credential_accepted_or_leaked");
                WriteCredentialJson(path, token, 1900000000000L,
                    "{\"RefreshToken\":\"" + token + "\",\"ExpiresAtUtcMsc\":1900000000000,\"extra\":true}");
                AssertThrows<InvalidDataException>(delegate
                {
                    LegacyV3CredentialReader.Read(path, 1800000000000L);
                }, "credential_unknown_field_accepted");
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        private static void TestTwoProfilesImportAtomically()
        {
            string root = NewRoot("two-profile-import");
            try
            {
                string dataRoot = Path.Combine(root, "legacy-data");
                Directory.CreateDirectory(Path.Combine(dataRoot, "profiles", "observer"));
                string firstToken = Token('a');
                string secondToken = Token('b');
                WriteCredential(Path.Combine(dataRoot, "credential.dat"), firstToken, 1900000000000L);
                WriteCredential(Path.Combine(dataRoot, "profiles", "observer", "credential.dat"), secondToken,
                    1900000000000L);
                string target = Path.Combine(root, "v4", "profiles.json");
                BridgeProfileStore store = new BridgeProfileStore(target, new CurrentUserSecretProtector());
                ImportFixture fixture = NewFixture(dataRoot);
                fixture.DefaultCredentialHash = HashFile(fixture.DefaultCredentialPath);
                fixture.ObserverCredentialHash = HashFile(fixture.ObserverCredentialPath);
                RecordingExchangeClient client = new RecordingExchangeClient();
                LegacyV3ProfileImporter importer = NewImporter(store);

                LegacyV3MigrationImportResult result = importer.Import(fixture.Snapshot, client);
                Assert(result.ImportedProfileCount == 2, "two_profile_import_count_wrong");
                BridgeProfileCatalog catalog = store.LoadOrCreate();
                Assert(catalog.SchemaVersion == 2 && catalog.Profiles.Count == 2
                    && catalog.InstallationId == fixture.Snapshot.LegacyInstallationId,
                    "two_profile_catalog_shape_wrong");
                Assert(catalog.Profiles[0].ProfileId == "default"
                    && catalog.Profiles[1].ProfileId == "observer", "profile_order_not_stable");
                Assert(catalog.Profiles[0].ServerUri == "ws://127.0.0.1:3000/bridge/v4/ws",
                    "local_websocket_uri_not_built");
                Assert(store.ReadRefreshToken(catalog.Profiles[0]) != firstToken
                    && store.ReadRefreshToken(catalog.Profiles[1]) != secondToken,
                    "v4_refresh_tokens_not_rotated");
                string raw = File.ReadAllText(target, Encoding.UTF8);
                Assert(raw.IndexOf(firstToken, StringComparison.Ordinal) < 0
                    && raw.IndexOf(secondToken, StringComparison.Ordinal) < 0
                    && raw.IndexOf("Protected" + "Bearer" + "Token", StringComparison.Ordinal) < 0
                    && raw.IndexOf("ProtectedRefreshToken", StringComparison.Ordinal) >= 0,
                    "refresh_token_written_insecurely");
                Assert(client.Requests.Count == 2
                    && client.Requests[0].installation_id == catalog.InstallationId
                    && client.Requests[0].profile_id == "default"
                    && client.Requests[1].profile_id == "observer",
                    "exchange_request_identity_wrong");
                Assert(HashFile(fixture.DefaultCredentialPath) == fixture.DefaultCredentialHash
                    && HashFile(fixture.ObserverCredentialPath) == fixture.ObserverCredentialHash,
                    "v3_source_changed_after_import");

                RecordingExchangeClient retry = new RecordingExchangeClient();
                importer.Import(fixture.Snapshot, retry);
                BridgeProfileCatalog retried = store.LoadOrCreate();
                Assert(retried.Profiles.Count == 2 && retry.Requests.Count == 2,
                    "repeat_import_created_duplicate_profiles");
                Assert(store.ReadRefreshToken(retried.Profiles[0]) == retry.Results[0].RefreshToken,
                    "repeat_import_did_not_accept_latest_token");
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        private static void TestLaterExchangeFailurePreservesCatalog()
        {
            string root = NewRoot("failed-import");
            try
            {
                string dataRoot = Path.Combine(root, "legacy-data");
                Directory.CreateDirectory(Path.Combine(dataRoot, "profiles", "observer"));
                WriteCredential(Path.Combine(dataRoot, "credential.dat"), Token('c'), 1900000000000L);
                WriteCredential(Path.Combine(dataRoot, "profiles", "observer", "credential.dat"), Token('d'),
                    1900000000000L);
                string target = Path.Combine(root, "v4", "profiles.json");
                BridgeProfileStore store = new BridgeProfileStore(target, new CurrentUserSecretProtector());
                BridgeProfileCatalog old = store.LoadOrCreate();
                old.InstallationId = "legacy-install";
                BridgeProfileSettings oldProfile = new BridgeProfileSettings
                {
                    ProfileId = "old", DisplayName = "old", Platform = "mt4",
                    TerminalInstanceId = "old-terminal", BrokerServer = "Demo", Login = "100",
                    ServerUri = "wss://bridge.example.test/bridge/v4/ws", AutoConnect = false,
                    PythonExecutablePath = string.Empty, WorkerScriptPath = string.Empty,
                    TerminalPath = string.Empty
                };
                store.SetRefreshToken(oldProfile, Token('o'));
                old.Profiles.Add(oldProfile);
                store.Save(old);
                byte[] before = File.ReadAllBytes(target);
                ImportFixture fixture = NewFixture(dataRoot);
                RecordingExchangeClient client = new RecordingExchangeClient { FailAt = 2 };
                Exception error = Capture(delegate
                {
                    NewImporter(store).Import(fixture.Snapshot, client);
                });
                Assert(error != null && error.Message.IndexOf(Token('c'), StringComparison.Ordinal) < 0
                    && error.Message.IndexOf(Token('d'), StringComparison.Ordinal) < 0,
                    "failed_exchange_leaked_refresh_token");
                byte[] after = File.ReadAllBytes(target);
                Assert(BytesEqual(before, after), "failed_exchange_changed_catalog");
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        private static void TestEndpointAndResponseValidation()
        {
            string root = NewRoot("endpoint-validation");
            try
            {
                string dataRoot = Path.Combine(root, "legacy-data");
                Directory.CreateDirectory(Path.Combine(dataRoot, "profiles", "observer"));
                WriteCredential(Path.Combine(dataRoot, "credential.dat"), Token('e'), 1900000000000L);
                WriteCredential(Path.Combine(dataRoot, "profiles", "observer", "credential.dat"), Token('f'),
                    1900000000000L);
                string target = Path.Combine(root, "v4", "profiles.json");
                BridgeProfileStore store = new BridgeProfileStore(target, new CurrentUserSecretProtector());
                ImportFixture fixture = NewFixture(dataRoot);
                fixture.Snapshot.EndpointOverride.CandidateRealtimeUri = "wss://other.example.test/";
                AssertThrows<InvalidDataException>(delegate
                {
                    NewImporter(store).Import(fixture.Snapshot, new RecordingExchangeClient());
                }, "endpoint_host_drift_accepted");

                fixture = NewFixture(dataRoot);
                RecordingExchangeClient invalidResponse = new RecordingExchangeClient
                {
                    InvalidResult = new BridgeV4CredentialExchangeResult("bridge_refresh", Token('z'), 1,
                        "/api/v4/bridge/session-tokens", "https://evil.example.test/bridge/v4/ws")
                };
                AssertThrows<InvalidDataException>(delegate
                {
                    NewImporter(store).Import(fixture.Snapshot, invalidResponse);
                }, "absolute_websocket_path_accepted");

                string mismatchTarget = Path.Combine(root, "v4-mismatch", "profiles.json");
                BridgeProfileStore mismatchStore = new BridgeProfileStore(mismatchTarget,
                    new CurrentUserSecretProtector());
                BridgeProfileCatalog mismatchCatalog = mismatchStore.LoadOrCreate();
                mismatchCatalog.InstallationId = "another-installation";
                mismatchStore.Save(mismatchCatalog);
                byte[] mismatchBefore = File.ReadAllBytes(mismatchTarget);
                AssertThrows<InvalidDataException>(delegate
                {
                    NewImporter(mismatchStore).Import(fixture.Snapshot, new RecordingExchangeClient());
                }, "installation_id_mismatch_accepted");
                Assert(BytesEqual(mismatchBefore, File.ReadAllBytes(mismatchTarget)),
                    "installation_mismatch_changed_catalog");

                fixture = NewFixture(dataRoot);
                fixture.Snapshot.LegacyInstallationId = "中文-install";
                AssertThrows<InvalidDataException>(delegate
                {
                    NewImporter(store).Import(fixture.Snapshot, new RecordingExchangeClient());
                }, "unicode_installation_id_accepted");
                fixture = NewFixture(dataRoot);
                fixture.Snapshot.Profiles[0].ProfileId = "-leading-hyphen";
                AssertThrows<InvalidDataException>(delegate
                {
                    NewImporter(store).Import(fixture.Snapshot, new RecordingExchangeClient());
                }, "leading_hyphen_profile_id_accepted");
            }
            finally
            {
                DeleteRoot(root);
            }
        }

        private static LegacyV3ProfileImporter NewImporter(BridgeProfileStore store)
        {
            return new LegacyV3ProfileImporter(store, new DelegateRuntimePathProvider(delegate
            {
                return new BridgeProfileRuntimePaths
                {
                    PythonExecutablePath = "C:\\bridge-runtime\\python.exe",
                    WorkerScriptPath = "C:\\bridge-runtime\\worker.py"
                };
            }));
        }

        private static ImportFixture NewFixture(string dataRoot)
        {
            return new ImportFixture
            {
                Snapshot = new LegacyV3MigrationSnapshot
                {
                    SchemaVersion = 1,
                    LegacyInstallationId = "legacy-install",
                    LegacySourceRoots = new LegacySourceRoots { DataRoot = dataRoot, InstallRoot = dataRoot },
                    EndpointOverride = new LegacyEndpointOverride
                    {
                        Status = "candidate", ActivationReady = false,
                        CandidateControlUri = CandidateControl, CandidateRealtimeUri = CandidateRealtime
                    },
                    CredentialExchangeRequired = true,
                    SourceFingerprint = Fingerprint,
                    Profiles = new List<LegacyV3ProfileSnapshot>
                    {
                        Profile("default", string.Empty, "mt5", "mt5-default", "D:\\term\\mt5"),
                        Profile("observer", "profiles/observer", "mt4", "mt4-observer", "D:\\term\\mt4")
                    }
                },
                DefaultCredentialPath = Path.Combine(dataRoot, "credential.dat"),
                ObserverCredentialPath = Path.Combine(dataRoot, "profiles", "observer", "credential.dat")
            };
        }

        private static LegacyV3ProfileSnapshot Profile(string id, string relative, string platform,
            string terminalId, string terminalPath)
        {
            return new LegacyV3ProfileSnapshot
            {
                ProfileId = id,
                SourceRelativePath = relative,
                CredentialFilePresent = true,
                CredentialExchangeRequired = true,
                Preferences = new LegacyV3PreferencesSnapshot
                {
                    Present = true, Platform = platform,
                    Mt5TerminalInstanceId = platform == "mt5" ? terminalId : null,
                    Mt5TerminalPath = platform == "mt5" ? terminalPath : null,
                    Mt4TerminalInstanceId = platform == "mt4" ? terminalId : null,
                    Mt4TerminalPath = platform == "mt4" ? terminalPath : null,
                    AutoStartEnabled = true
                },
                TerminalBindings = new List<LegacyTerminalBindingSnapshot>
                {
                    new LegacyTerminalBindingSnapshot
                    {
                        TerminalInstanceId = terminalId, Platform = platform, TerminalPath = terminalPath,
                        BrokerServer = "Demo-Server", Login = platform == "mt5" ? "10001" : "10002",
                        ConnectionEpoch = 1, UpdatedAtUtcMsc = 1800000000000L
                    }
                }
            };
        }

        private sealed class ImportFixture
        {
            public LegacyV3MigrationSnapshot Snapshot;
            public string DefaultCredentialPath;
            public string ObserverCredentialPath;
            public string DefaultCredentialHash { get; set; }
            public string ObserverCredentialHash { get; set; }
        }

        private sealed class RecordingExchangeClient : IBridgeV4CredentialExchangeClient
        {
            public RecordingExchangeClient()
            {
                Requests = new List<BridgeV4CredentialExchangeRequest>();
                Results = new List<BridgeV4CredentialExchangeResult>();
            }

            public int FailAt { get; set; }
            public BridgeV4CredentialExchangeResult InvalidResult { get; set; }
            public IList<BridgeV4CredentialExchangeRequest> Requests { get; private set; }
            public IList<BridgeV4CredentialExchangeResult> Results { get; private set; }

            public BridgeV4CredentialExchangeResult Exchange(BridgeV4CredentialExchangeRequest request,
                string candidateControlUri, string candidateRealtimeUri)
            {
                Requests.Add(request);
                if (FailAt > 0 && Requests.Count == FailAt)
                    throw new InvalidDataException("simulated exchange failure");
                BridgeV4CredentialExchangeResult result = InvalidResult ?? new BridgeV4CredentialExchangeResult(
                    "bridge_refresh", Token((char)('p' + Requests.Count)), Requests.Count,
                    "/api/v4/bridge/session-tokens", "/bridge/v4/ws");
                Results.Add(result);
                return result;
            }
        }

        private static void WriteCredential(string path, string token, long expiresAtUtcMsc)
        {
            string json = "{\"RefreshToken\":\"" + token + "\",\"ExpiresAtUtcMsc\":"
                + expiresAtUtcMsc.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}";
            WriteCredentialJson(path, token, expiresAtUtcMsc, json);
        }

        private static void WriteCredentialJson(string path, string token, long expiresAtUtcMsc, string json)
        {
            byte[] plain = Encoding.UTF8.GetBytes(json);
            byte[] entropy = Encoding.UTF8.GetBytes(V3Entropy);
            byte[] cipher = null;
            try
            {
                cipher = ProtectedData.Protect(plain, entropy, DataProtectionScope.CurrentUser);
                File.WriteAllBytes(path, cipher);
            }
            finally
            {
                Array.Clear(plain, 0, plain.Length);
                Array.Clear(entropy, 0, entropy.Length);
                if (cipher != null) Array.Clear(cipher, 0, cipher.Length);
            }
        }

        private static string Token(char prefix)
        {
            return prefix + new string('x', 63);
        }

        private static string HashFile(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                byte[] hash = sha.ComputeHash(stream);
                try { return Convert.ToBase64String(hash); }
                finally { Array.Clear(hash, 0, hash.Length); }
            }
        }

        private static Exception Capture(Action action)
        {
            try { action(); }
            catch (Exception error) { return error; }
            return null;
        }

        private static string NewRoot(string suffix)
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-v4-" + suffix + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static void DeleteRoot(string root)
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }

        private static bool BytesEqual(byte[] first, byte[] second)
        {
            if (first == null || second == null || first.Length != second.Length) return false;
            int difference = 0;
            for (int index = 0; index < first.Length; index++) difference |= first[index] ^ second[index];
            return difference == 0;
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
