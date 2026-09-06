using System;
using System.IO;
using System.Text;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class BridgePairingDraftSmokeTests
    {
        public static void RunAll()
        {
            string root = Path.Combine(Path.GetTempPath(), "bridge-pairing-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                string path = Path.Combine(root, "pairing.pending");
                CurrentUserSecretProtector protector = new CurrentUserSecretProtector();
                BridgeProfileStore profiles = new BridgeProfileStore(Path.Combine(root, "profiles.json"), protector);
                FakeHttp http = new FakeHttp();
                BridgePairingDraftStore store = new BridgePairingDraftStore(path, protector, profiles, new BridgePairingClient(http));
                BridgeProfileSettings profile = new BridgeProfileSettings { ProfileId = "local-draft", DisplayName = "测试档案", Platform = "mt4",
                    TerminalInstanceId = "terminal-1", BrokerServer = "demo", Login = "123", ServerUri = "wss://trade.example.test/bridge/v4/ws" };
                string code = "bpc_" + new string('a', 43);
                try { store.Pair(profile, "install-1", code); throw new Exception("pairing_failure_expected"); }
                catch (InvalidDataException) { }
                string request = http.Body;
                BridgePairingDraft pending = store.Load("install-1");
                string disk = File.ReadAllText(path);
                if (disk.Contains(code) || disk.Contains(pending.Token) || disk.Contains("测试档案")) throw new Exception("pairing_draft_plaintext");
                if (pending.Redeemed) throw new Exception("pairing_false_success");
                try { store.Load("other-installation"); throw new Exception("pairing_installation_not_checked"); }
                catch (InvalidDataException) { }
                profile.ServerUri = "wss://other.example.test/bridge/v4/ws";
                try { store.Pair(profile, "install-1", code); throw new Exception("pairing_origin_not_checked"); }
                catch (InvalidDataException) { }
                profile.ServerUri = pending.Profile.ServerUri;
                http.Fail = false;
                store = new BridgePairingDraftStore(path, protector, profiles, new BridgePairingClient(http));
                BridgeProfileSettings paired = store.Pair(profile, "install-1", code);
                if (request != http.Body || paired.ProfileId != FakeHttp.Profile || profiles.ReadRefreshToken(paired) != pending.Token)
                    throw new Exception("pairing_retry_changed_identity");
                int calls = http.Calls;
                // Simulates a crash before catalog save: the receipt is durable.
                store = new BridgePairingDraftStore(path, protector, profiles, new BridgePairingClient(http));
                paired = store.Pair(profile, "install-1", code);
                if (http.Calls != calls || paired.ProfileId != FakeHttp.Profile) throw new Exception("pairing_receipt_not_recovered");
                BridgeProfileCatalog catalog = new BridgeProfileCatalog { InstallationId = "install-1" };
                catalog.Profiles.Add(paired);
                profiles.Save(catalog);
                store.ClearCompleted("install-1", "wrong-profile");
                if (!File.Exists(path)) throw new Exception("pairing_clear_not_fenced");
                store.ClearCompleted("install-1", paired.ProfileId);
                if (File.Exists(path) || profiles.LoadOrCreate().Profiles.Count != 1) throw new Exception("pairing_save_incomplete");
            }
            finally { Directory.Delete(root, true); }
        }

        private sealed class FakeHttp : IBridgeSessionTokenHttpClient
        {
            public const string Profile = "profile-11111111-1111-4111-8111-111111111111";
            public bool Fail = true;
            public string Body;
            public int Calls;
            public string Post(Uri endpoint, byte[] body, int timeout)
            {
                Calls++;
                Body = Encoding.UTF8.GetString(body);
                if (Fail) throw new IOException("offline");
                return "{\"data\":{\"credential_type\":\"bridge_refresh\",\"installation_id\":\"install-1\",\"profile_id\":\"" + Profile
                    + "\",\"generation\":1,\"session_token_path\":\"/api/v4/bridge/session-tokens\",\"websocket_path\":\"/bridge/v4/ws\"},"
                    + "\"meta\":{\"request_id\":\"request-1\",\"generated_at\":\"2026-09-06T00:00:00.000Z\"}}";
            }
        }
    }
}
