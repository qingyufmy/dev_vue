using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class BridgeProfileRemovalSmokeTests
    {
        private static readonly string Token = "br4_" + new string('a', 48);

        public static void RunAll()
        {
            TestHttpReceipt();
            string root = Path.Combine(Path.GetTempPath(), "bridge-removal-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                BridgeProfileStore store = new BridgeProfileStore(Path.Combine(root, "profiles.json"), new Secrets());
                BridgeProfileCatalog catalog = new BridgeProfileCatalog { InstallationId = "installation-removal" };
                catalog.Profiles.Add(Profile("profile-one", "terminal-one", "10001"));
                catalog.Profiles.Add(Profile("profile-two", "terminal-two", "10002"));
                store.Save(catalog);
                Assert(!File.ReadAllText(store.FilePath).Contains("RemovalPending"), "ordinary_catalog_broke_old_reader");
                string ledger = Path.Combine(root, "uncertain-ledger.fixture");
                File.WriteAllText(ledger, "old-account-uncertain");
                List<string> order = new List<string>();
                Revoker revoker = new Revoker(order);
                bool stopFails = true;
                BridgeProfileRemovalService service = new BridgeProfileRemovalService(store, revoker, delegate(string id)
                {
                    Assert(id == "profile-one", "wrong_profile_stopped");
                    order.Add("stop");
                    if (stopFails) throw new IOException("stop_pending");
                });
                Reject(delegate { service.Complete(catalog, "profile-one"); });
                BridgeProfileCatalog pending = service.Prepare(catalog, "profile-one");
                Assert(!catalog.Profiles[0].RemovalPending, "prepare_mutated_ui_before_save");
                Assert(pending.Profiles[0].RemovalPending && !pending.Profiles[0].AutoConnect, "pending_not_disabled");
                Reject(delegate { service.Complete(pending, "profile-one"); });
                Assert(revoker.Calls == 0 && store.LoadOrCreate().Profiles.Count == 2, "stop_failure_reached_revoke");
                stopFails = false;
                revoker.Fail = true;
                Reject(delegate { service.Complete(store.LoadOrCreate(), "profile-one"); });
                BridgeProfileCatalog restarted = store.LoadOrCreate();
                Assert(restarted.Profiles[0].RemovalPending && !restarted.Profiles[0].AutoConnect, "restart_lost_pending_state");
                Assert(restarted.Profiles[1].AutoConnect && !restarted.Profiles[1].RemovalPending, "other_profile_changed");

                // Simulate an acknowledged revocation followed by a local save failure.
                revoker.Fail = false;
                string retained = Path.Combine(root, "retained.fixture");
                revoker.BeforeReturn = delegate
                {
                    File.Move(store.FilePath, retained);
                    Directory.CreateDirectory(store.FilePath);
                };
                try { Reject(delegate { service.Complete(restarted, "profile-one"); }); }
                finally
                {
                    Directory.Delete(store.FilePath);
                    File.Move(retained, store.FilePath);
                }
                Assert(store.LoadOrCreate().Profiles[0].RemovalPending, "save_failure_discarded_recovery");
                revoker.BeforeReturn = null;
                BridgeProfileCatalog result = service.Complete(store.LoadOrCreate(), "profile-one");
                Assert(result.Profiles.Count == 1 && result.Profiles[0].ProfileId == "profile-two", "wrong_final_catalog");
                Assert(revoker.Calls == 3 && revoker.LastToken == Token, "retry_changed_credential_identity");
                Assert(order[order.Count - 2] == "stop" && order[order.Count - 1] == "revoke", "revoke_before_stop");
                Assert(File.ReadAllText(ledger) == "old-account-uncertain", "removal_changed_ledger");
                Assert(!File.ReadAllText(store.FilePath).Contains("RemovalPending"), "completed_catalog_broke_old_reader");
            }
            finally { Directory.Delete(root, true); }
        }

        private static void TestHttpReceipt()
        {
            Transport transport = new Transport();
            HttpBridgeCredentialRevoker client = new HttpBridgeCredentialRevoker("installation-removal", transport);
            BridgeProfileSettings profile = Profile("profile-one", "terminal-one", "10001");
            client.Revoke(profile, Token);
            Assert(transport.Endpoint.AbsoluteUri == "https://bridge.example.test/api/v4/bridge/credential-revocations",
                "revocation_endpoint_not_scoped");
            IDictionary<string, object> sent = Parse(transport.Body);
            Assert(sent.Count == 3 && (string)sent["refresh_token"] == Token
                && (string)sent["installation_id"] == "installation-removal" && (string)sent["profile_id"] == profile.ProfileId,
                "revocation_identity_not_sent");
            foreach (byte value in transport.Bytes) Assert(value == 0, "revocation_request_not_cleared");
            foreach (string bad in new[]
            {
                Receipt().Replace("profile-one", "profile-other"),
                Receipt().Replace("installation-removal", "installation-other"),
                Receipt().Replace("\"revoked\":true", "\"revoked\":false"),
                Receipt().Replace("\"generation\":1", "\"generation\":1.5"),
                Receipt().Replace("\"generation\":1", "\"generation\":0"),
                Receipt().Replace("\"revoked\":true", "\"revoked\":true,\"token\":\"secret\""),
                "{}", "invalid"
            })
            {
                transport.Response = bad;
                Reject(delegate { client.Revoke(profile, Token); });
            }
            transport.Throw = true;
            try { client.Revoke(profile, Token); throw new Exception("transport_failure_accepted"); }
            catch (InvalidDataException error) { Assert(error.Message == "bridge_credential_revocation_failed", "secret_leaked_in_failure"); }
        }

        private static BridgeProfileSettings Profile(string id, string terminal, string login)
        {
            return new BridgeProfileSettings
            {
                ProfileId = id, DisplayName = id, Platform = "mt4", TerminalInstanceId = terminal,
                BrokerServer = "Broker-Demo", Login = login, AutoConnect = true,
                ServerUri = "wss://bridge.example.test/bridge/v4/ws", ProtectedRefreshToken = Token
            };
        }
        private static string Receipt()
        {
            return "{\"data\":{\"credential_type\":\"bridge_revocation\",\"installation_id\":\"installation-removal\","
                + "\"profile_id\":\"profile-one\",\"generation\":1,\"revoked\":true},"
                + "\"meta\":{\"request_id\":\"request-removal\",\"generated_at\":\"2026-09-06T00:00:00.000Z\"}}";
        }
        private static IDictionary<string, object> Parse(string value)
        { return (IDictionary<string, object>)new JavaScriptSerializer().DeserializeObject(value); }
        private static void Assert(bool condition, string code) { if (!condition) throw new Exception(code); }
        private static void Reject(Action action)
        {
            try { action(); }
            catch (InvalidDataException) { return; }
            catch (IOException) { return; }
            catch (UnauthorizedAccessException) { return; }
            throw new Exception("removal_failure_accepted");
        }
        private sealed class Secrets : IBridgeSecretProtector
        {
            public string Protect(string value) { return value; }
            public string Unprotect(string value) { return value; }
        }
        private sealed class Revoker : IBridgeCredentialRevoker
        {
            private readonly List<string> order;
            public int Calls;
            public string LastToken;
            public bool Fail;
            public Action BeforeReturn;
            public Revoker(List<string> value) { order = value; }
            public void Revoke(BridgeProfileSettings profile, string token)
            {
                order.Add("revoke"); Calls++; LastToken = token;
                Assert(profile.ProfileId == "profile-one" && profile.RemovalPending, "revoke_not_prepared");
                if (Fail) throw new IOException("response_lost_after_revoke");
                if (BeforeReturn != null) BeforeReturn();
            }
        }
        private sealed class Transport : IBridgeSessionTokenHttpClient
        {
            public string Response = Receipt();
            public Uri Endpoint;
            public string Body;
            public byte[] Bytes;
            public bool Throw;
            public string Post(Uri endpoint, byte[] requestBody, int timeoutMilliseconds)
            {
                Endpoint = endpoint; Bytes = requestBody; Body = Encoding.UTF8.GetString(requestBody);
                if (Throw) throw new IOException(Token);
                return Response;
            }
        }
    }
}
