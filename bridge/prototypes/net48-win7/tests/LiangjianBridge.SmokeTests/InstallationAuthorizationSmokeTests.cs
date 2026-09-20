using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Configuration;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class InstallationAuthorizationSmokeTests
    {
        public static void RunAll()
        {
            TestRealHttpSuccessStatus();
            string root = Path.Combine(Path.GetTempPath(), "bridge-installation-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                string path = Path.Combine(root, "authorization.dat");
                CurrentUserSecretProtector protector = new CurrentUserSecretProtector();
                BridgeProfileStore profiles = new BridgeProfileStore(Path.Combine(root, "profiles.json"), protector);
                FakeHttp http = new FakeHttp();
                InstallationAuthorizationClient client = new InstallationAuthorizationClient(http);
                InstallationAuthorizationStore store = new InstallationAuthorizationStore(path, protector, profiles, client);
                http.Fail = true;
                Reject(delegate { store.Start("https://trade.example.test", "install-1", "测试电脑"); });
                string startBody = http.Body;
                Assert(startBody.Contains("poll_secret_hash") && !startBody.Contains("bip_") && !startBody.Contains("bi4_"), "start_sent_plaintext_secret");
                Assert(!File.ReadAllText(path).Contains("测试电脑"), "installation_store_plaintext");
                Reject(delegate { store.Start("https://other.example.test", "install-1", "测试电脑"); });
                http.Fail = false;
                store = new InstallationAuthorizationStore(path, protector, profiles, client);
                InstallationAuthorizationView view = store.Start("https://trade.example.test", "install-1", "测试电脑");
                Assert(http.Body == startBody && view.Status == "pending", "installation_start_retry_changed_identity");
                http.PollStatus = "pending";
                view = store.Poll();
                Assert(view.Status == "pending", "installation_pending_wrong");
                int calls = http.Calls;
                store.Poll();
                Assert(http.Calls == calls, "installation_poll_not_throttled");
                // The client validates approval independently of the persisted poll timer.
                http.PollStatus = "approved";
                IDictionary<string, object> encrypted = new JavaScriptSerializer().DeserializeObject(protector.Unprotect(File.ReadAllText(path))) as IDictionary<string, object>;
                encrypted["NextPollUtcMsc"] = 0;
                File.WriteAllText(path, protector.Protect(new JavaScriptSerializer().Serialize(encrypted)));
                view = store.Poll();
                Assert(view.Status == "approved" && view.UserId == "7", "installation_approval_missing");
                InstallationStatus status = store.Status();
                Assert(status.Authorized && status.Total == 3 && status.Available == 2, "installation_capacity_wrong");
                BridgeProfileSettings profile = new BridgeProfileSettings { ProfileId = "local-draft", DisplayName = "测试档案", Platform = "mt4",
                    TerminalInstanceId = "terminal-1", BrokerServer = "demo", Login = "123", ServerUri = "wss://trade.example.test/bridge/v4/ws" };
                http.Fail = true;
                Reject(delegate { store.RegisterProfile(profile); });
                string registrationBody = http.Body;
                string refresh = (string)new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(registrationBody)["refresh_token"];
                Assert(!File.ReadAllText(path).Contains(refresh), "registration_secret_plaintext");
                BridgeProfileSettings other = profile.Clone(); other.Login = "456";
                Reject(delegate { store.RegisterProfile(other); });
                http.Fail = false;
                store = new InstallationAuthorizationStore(path, protector, profiles, client);
                BridgeProfileSettings registered = store.RegisterProfile(profile);
                Assert(http.Body == registrationBody && profiles.ReadRefreshToken(registered) == refresh, "registration_retry_changed_secret");
                calls = http.Calls;
                store = new InstallationAuthorizationStore(path, protector, profiles, client);
                registered = store.RegisterProfile(profile);
                Assert(http.Calls == calls && store.ReadPendingProfile().ProfileId == registered.ProfileId, "registration_receipt_not_durable");
                Reject(delegate { store.CompleteProfile("wrong-profile"); });
                store.CompleteProfile(registered.ProfileId);
                registered = store.RegisterProfile(other);
                Assert(profiles.ReadRefreshToken(registered) != refresh, "profiles_share_refresh_secret");
                store.CompleteProfile(registered.ProfileId);
                http.BadResponse = true;
                Reject(delegate { store.Status(); });
                http.BadResponse = false;
                store.Revoke();
                Assert(store.ReadView().Status == "revoked", "installation_revoke_not_durable");
                Reject(delegate { store.RegisterProfile(profile); });
                store.Start("https://trade.example.test", "install-1", "测试电脑"); store.Poll();
                http.Fail = true; Reject(delegate { store.RegisterProfile(profile); }); http.Fail = false;
                http.StatusCode = 503;
                try { store.Status(); throw new InvalidOperationException("server_error_expected"); }
                catch (BridgeHttpStatusException) { }
                Assert(store.ReadView().Status == "approved", "temporary_failure_revoked_authorization");
                http.StatusCode = 401;
                Assert(!store.Status().Authorized && store.ReadView().Status == "revoked", "unauthorized_not_persisted");
                Assert(store.ReadPendingProfile() != null, "unauthorized_destroyed_pending_profile");
                Reject(delegate { store.Start("https://trade.example.test", "install-1", "测试电脑"); });
                calls = http.Calls; store.Revoke();
                Assert(http.Calls == calls && store.ReadPendingProfile() == null, "explicit_local_signout_not_recoverable");
                http.StatusCode = 0;
                store.Start("https://trade.example.test", "install-1", "测试电脑");
                Assert(store.ReadView().Status == "pending", "signout_did_not_allow_new_authorization");
            }
            finally { Directory.Delete(root, true); }
        }

        private static void TestRealHttpSuccessStatus()
        {
            TcpListener allocator = new TcpListener(IPAddress.Loopback, 0);
            allocator.Start(); int port = ((IPEndPoint)allocator.LocalEndpoint).Port; allocator.Stop();
            string origin = "http://127.0.0.1:" + port;
            HttpListener listener = new HttpListener(); listener.Prefixes.Add(origin + "/"); listener.Start();
            Exception serverError = null;
            Thread server = new Thread(delegate()
            {
                try
                {
                    for (int index = 0; index < 3; index++)
                    {
                        HttpListenerContext request = listener.GetContext();
                        Assert(string.IsNullOrEmpty(request.Request.Headers["Origin"]), "native_request_sent_origin");
                        byte[] payload;
                        using (MemoryStream copy = new MemoryStream()) { request.Request.InputStream.CopyTo(copy); payload = copy.ToArray(); }
                        byte[] response = Encoding.UTF8.GetBytes(index == 2 ? "private-error-body" : new FakeHttp().Post(request.Request.Url, payload, 15000));
                        request.Response.StatusCode = index == 2 ? 401 : 200; request.Response.ContentType = "application/json";
                        request.Response.ContentLength64 = response.Length;
                        using (Stream output = request.Response.OutputStream) output.Write(response, 0, response.Length);
                    }
                }
                catch (Exception error) { serverError = error; }
            });
            server.IsBackground = true; server.Start();
            try
            {
                InstallationAuthorizationClient client = new InstallationAuthorizationClient();
                string token = "bi4_" + new string('a', 64);
                InstallationAuthorizationView view = client.Start(origin, "install-1", "电脑", "bip_" + new string('b', 43), token, new string('c', 32));
                Assert(view.AuthorizationId == "auth-1", "start_http_200_not_accepted");
                BridgePairingResult profile = client.RegisterProfile(origin, "install-1", token, new string('d', 32), "br4_" + new string('e', 64));
                Assert(profile.Generation == 1, "registration_http_200_not_accepted");
                try { client.Status(origin, "install-1", token); throw new InvalidOperationException("http_401_expected"); }
                catch (BridgeHttpStatusException error) { Assert(error.StatusCode == 401 && !error.Message.Contains("private"), "http_status_or_redaction_lost"); }
                Assert(server.Join(5000) && serverError == null, "authorization_http_fixture_failed");
            }
            finally { listener.Stop(); listener.Close(); server.Join(5000); }
        }

        private static void Assert(bool condition, string code) { if (!condition) throw new InvalidOperationException(code); }
        private static void Reject(Action action)
        { try { action(); } catch (InvalidDataException) { return; } throw new InvalidOperationException("installation_invalid_operation_accepted"); }
        private sealed class FakeHttp : IBridgeSessionTokenHttpClient
        {
            public bool Fail;
            public bool BadResponse;
            public string PollStatus;
            public int StatusCode;
            public string Body;
            public int Calls;
            public string Post(Uri endpoint, byte[] body, int timeout)
            {
                Calls++; Body = Encoding.UTF8.GetString(body);
                if (StatusCode != 0) throw new BridgeHttpStatusException(StatusCode);
                if (Fail) throw new IOException("offline_secret_must_not_escape");
                string data;
                string user = "\"user\":{\"id\":\"7\",\"display_name\":\"测试用户\"},\"generation\":1,\"authorized\":true";
                if (endpoint.AbsolutePath.EndsWith("/installation-authorizations"))
                    data = "{\"authorization_id\":\"auth-1\",\"confirmation_path\":\"/bridge/authorize?request=auth-1\",\"expires_at\":\"2026-09-14T01:00:00.000000Z\",\"poll_interval_seconds\":5}";
                else if (endpoint.AbsolutePath.EndsWith("/poll"))
                    data = "{\"status\":\"" + PollStatus + "\",\"poll_interval_seconds\":5" + (PollStatus == "approved" ? ",\"installation_id\":\"install-1\"," + user : "") + "}";
                else if (endpoint.AbsolutePath.EndsWith("/status"))
                    data = "{\"installation_id\":\"install-1\"," + user + ",\"capacity\":{\"included\":2,\"purchased\":1,\"total\":3,\"active\":1,\"available\":2}" + (BadResponse ? ",\"unexpected\":true" : "") + "}";
                else if (endpoint.AbsolutePath.EndsWith("/profiles"))
                    data = "{\"credential_type\":\"bridge_refresh\",\"installation_id\":\"install-1\",\"profile_id\":\"profile-11111111-1111-4111-8111-111111111111\",\"generation\":1,\"session_token_path\":\"/api/v4/bridge/session-tokens\",\"websocket_path\":\"/bridge/v4/ws\"}";
                else if (endpoint.AbsolutePath.EndsWith("/revoke")) data = "{\"installation_id\":\"install-1\",\"revoked\":true}";
                else throw new InvalidOperationException("unexpected_endpoint");
                return "{\"data\":" + data + ",\"meta\":{\"request_id\":\"test-request\",\"generated_at\":\"2026-09-14T00:00:00.000000Z\"}}";
            }
        }
    }
}
