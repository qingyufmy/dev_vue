using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.LauncherApp;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.SmokeTests
{
    internal static class UpdateOrchestrationSmokeTests
    {
        private const long Now = 1800000000100L;

        public static void RunAll()
        {
            TestStatusStoreAndLauncherWriterAgree();
            TestManagedInstallLayout();
            TestSignedDownloadStagesAndHonorsRestartGate();
        }

        private static void TestStatusStoreAndLauncherWriterAgree()
        {
            string root = NewRoot("update-status");
            try
            {
                string path = Path.Combine(root, "updates", "activation-status.json");
                ActivationStatusWriter.WriteToPath(path, "release-status-1", "4.2.0", "healthy", null);
                ReleaseActivationStatus status = new ReleaseActivationStatusStore(path).Read();
                Assert(status.ReleaseId == "release-status-1" && status.TargetVersion == "4.2.0"
                    && status.State == "healthy" && status.ErrorCode == null
                    && status.ReportedAtUtcMsc > 0, "activation_status_round_trip_failed");
            }
            finally { DeleteRoot(root); }
        }

        private static void TestManagedInstallLayout()
        {
            string root = NewRoot("update-layout");
            try
            {
                string versions = Path.Combine(root, "versions");
                string version = Path.Combine(versions, "4.0.0.0");
                Directory.CreateDirectory(version);
                File.WriteAllText(Path.Combine(root, "LiangjianBridge.Launcher.exe"), "fixture");
                File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.0.0");
                string resolved;
                Assert(BridgeInstallLayout.TryResolve(version, out resolved)
                    && resolved == Path.GetFullPath(root), "managed_install_layout_not_resolved");
                File.Delete(Path.Combine(root, "LiangjianBridge.Launcher.exe"));
                File.WriteAllText(Path.Combine(root, "AURUMBridge.Launcher.exe"), "legacy-fixture");
                Assert(BridgeInstallLayout.TryResolve(version, out resolved)
                    && resolved == Path.GetFullPath(root), "legacy_managed_install_layout_not_resolved");
                File.WriteAllText(Path.Combine(versions, "current.txt"), "4.0.1.0");
                Assert(!BridgeInstallLayout.TryResolve(version, out resolved), "inactive_version_layout_accepted");
            }
            finally { DeleteRoot(root); }
        }

        private static void TestSignedDownloadStagesAndHonorsRestartGate()
        {
            string root = NewRoot("update-service");
            string installRoot = Path.Combine(root, "install");
            string dataRoot = Path.Combine(root, "data");
            Directory.CreateDirectory(installRoot);
            Directory.CreateDirectory(dataRoot);
            CngKey key = CngKey.Create(CngAlgorithm.ECDsaP256);
            using (ECDsaCng signer = new ECDsaCng(key))
            using (LocalReleaseServer server = new LocalReleaseServer())
            {
                try
                {
                    byte[] packageBytes = CreatePackage(root);
                    ReleaseManifest manifest = CreateManifest(server.BaseUrl, packageBytes, signer);
                    server.ManifestBytes = Encoding.UTF8.GetBytes(SerializeManifest(manifest));
                    server.PackageBytes = packageBytes;
                    BridgeUpdateService service = new BridgeUpdateService(installRoot, dataRoot,
                        "4.0.0.0", PublicKeyPem(key.Export(CngKeyBlobFormat.EccPublicBlob)),
                        new ReleaseDownloadClient(3000), true, delegate { return Now; });
                    service.Observe(new PendingBridgeRelease
                    {
                        ReleaseId = manifest.ReleaseId, Version = manifest.ReleaseVersion,
                        ManifestUrl = server.BaseUrl + "/manifest.json", RolloutChannel = "stable",
                        Reason = "published", RestartNotBeforeUtcMsc = Now + 5000
                    });
                    BridgeUpdateSnapshot snapshot = WaitForState(service, "staged", 5000);
                    Assert(snapshot.ErrorCode == null, "signed_update_stage_failed");
                    string staged = Path.Combine(installRoot, "versions", "4.2.0.0", "LiangjianBridge.exe");
                    Assert(File.Exists(staged), "signed_update_entrypoint_not_staged");
                    Assert(service.ReadyRelease(Now + 4999, new UpdateActivitySnapshot()) == null,
                        "update_ready_before_server_time");
                    Assert(service.ReadyRelease(Now + 5000,
                        new UpdateActivitySnapshot { UncertainCommands = 1 }) == null,
                        "update_ready_with_uncertain_command");
                    PendingBridgeRelease ready = service.ReadyRelease(Now + 5000, new UpdateActivitySnapshot());
                    Assert(ready != null && ready.ReleaseId == manifest.ReleaseId,
                        "idle_signed_update_not_ready");
                    Assert(service.MarkActivating(ready.ReleaseId), "ready_update_not_claimed");
                    service.MarkActivationLaunchFailed(ready.ReleaseId, Now + 5001,
                        "bridge_update_launcher_failed");
                    ReleaseActivationStatus status = new ReleaseActivationStatusStore(Path.Combine(dataRoot,
                        "updates", "activation-status.json")).Read();
                    Assert(status.State == "failed" && status.ErrorCode == "bridge_update_launcher_failed",
                        "activation_launch_failure_not_persisted");
                }
                finally
                {
                    key.Dispose();
                    DeleteRoot(root);
                }
            }
        }

        private static ReleaseManifest CreateManifest(string baseUrl, byte[] packageBytes, ECDsaCng signer)
        {
            ReleasePackage package = new ReleasePackage
            {
                ModuleId = "core", Version = "4.2.0.0", Url = baseUrl + "/core.zip",
                SizeBytes = packageBytes.LongLength, Sha256 = Sha256(packageBytes),
                MinimumCoreVersion = null, MaximumCoreVersion = null
            };
            package.Signature = Sign(signer, ReleaseManifestVerifier.CanonicalizePackage(package));
            ReleaseManifest manifest = new ReleaseManifest
            {
                SchemaVersion = 2, ReleaseVersion = "4.2.0.0", ReleaseId = "release-service-4200",
                GeneratedAtUtcMsc = Now - 100, PublishedAtUtcMsc = Now - 100,
                ExpiresAtUtcMsc = Now + 60000, Priority = "normal",
                MinimumLauncherVersion = "4.0.0.0", MinimumIdleSeconds = 30,
                ActivationDeadlineUtcMsc = null, RolloutChannel = "stable", RolloutPercentage = 100,
                Packages = new List<ReleasePackage> { package }
            };
            manifest.Signature = Sign(signer, ReleaseManifestVerifier.CanonicalizeManifest(manifest));
            return manifest;
        }

        private static string SerializeManifest(ReleaseManifest manifest)
        {
            List<object> packages = new List<object>();
            foreach (ReleasePackage package in manifest.Packages)
            {
                packages.Add(new Dictionary<string, object>
                {
                    { "module_id", package.ModuleId }, { "version", package.Version }, { "url", package.Url },
                    { "size_bytes", package.SizeBytes }, { "sha256", package.Sha256 },
                    { "signature", package.Signature }, { "minimum_core_version", package.MinimumCoreVersion },
                    { "maximum_core_version", package.MaximumCoreVersion }
                });
            }
            return new JavaScriptSerializer().Serialize(new Dictionary<string, object>
            {
                { "schema_version", manifest.SchemaVersion }, { "release_version", manifest.ReleaseVersion },
                { "release_id", manifest.ReleaseId }, { "generated_at_utc_msc", manifest.GeneratedAtUtcMsc },
                { "published_at_utc_msc", manifest.PublishedAtUtcMsc }, { "expires_at_utc_msc", manifest.ExpiresAtUtcMsc },
                { "priority", manifest.Priority }, { "minimum_launcher_version", manifest.MinimumLauncherVersion },
                { "minimum_idle_seconds", manifest.MinimumIdleSeconds },
                { "activation_deadline_utc_msc", manifest.ActivationDeadlineUtcMsc },
                { "rollout_channel", manifest.RolloutChannel }, { "rollout_percentage", manifest.RolloutPercentage },
                { "packages", packages }, { "signature", manifest.Signature }
            });
        }

        private static byte[] CreatePackage(string root)
        {
            string path = Path.Combine(root, "fixture.zip");
            using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Create, false, Encoding.UTF8))
            {
                ZipArchiveEntry entry = archive.CreateEntry("LiangjianBridge.exe");
                using (Stream output = entry.Open())
                {
                    byte[] bytes = Encoding.ASCII.GetBytes("healthy-fixture");
                    output.Write(bytes, 0, bytes.Length);
                }
            }
            return File.ReadAllBytes(path);
        }

        private static string PublicKeyPem(byte[] blob)
        {
            byte[] prefix = new byte[] { 0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
                0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04 };
            byte[] der = new byte[prefix.Length + 64];
            Array.Copy(prefix, der, prefix.Length);
            Array.Copy(blob, 8, der, prefix.Length, 64);
            return "-----BEGIN PUBLIC KEY-----\n" + Convert.ToBase64String(der) + "\n-----END PUBLIC KEY-----";
        }

        private static BridgeUpdateSnapshot WaitForState(BridgeUpdateService service, string state, int timeout)
        {
            int started = Environment.TickCount;
            BridgeUpdateSnapshot snapshot;
            do
            {
                snapshot = service.Snapshot();
                if (snapshot.State == state || snapshot.State == "failed") return snapshot;
                Thread.Sleep(25);
            } while (unchecked(Environment.TickCount - started) < timeout);
            throw new TimeoutException("update_service_stage_timeout");
        }

        private static string Sign(ECDsaCng signer, string value)
        {
            return Convert.ToBase64String(signer.SignData(Encoding.UTF8.GetBytes(value), HashAlgorithmName.SHA256));
        }

        private static string Sha256(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                StringBuilder value = new StringBuilder(64);
                foreach (byte item in sha.ComputeHash(bytes)) value.Append(item.ToString("x2"));
                return value.ToString();
            }
        }

        private static string NewRoot(string name)
        {
            string root = Path.Combine(Path.GetTempPath(), name + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            return root;
        }

        private static void DeleteRoot(string root) { if (Directory.Exists(root)) Directory.Delete(root, true); }
        private static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

        private sealed class LocalReleaseServer : IDisposable
        {
            private readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            private readonly Thread thread;
            private volatile bool stopped;
            public byte[] ManifestBytes;
            public byte[] PackageBytes;
            public readonly string BaseUrl;

            public LocalReleaseServer()
            {
                listener.Start();
                BaseUrl = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
                thread = new Thread(Run) { IsBackground = true };
                thread.Start();
            }

            public void Dispose()
            {
                stopped = true;
                listener.Stop();
                thread.Join(3000);
            }

            private void Run()
            {
                while (!stopped)
                {
                    try
                    {
                        using (TcpClient client = listener.AcceptTcpClient()) Respond(client);
                    }
                    catch (SocketException) { if (stopped) return; }
                    catch (ObjectDisposedException) { if (stopped) return; }
                }
            }

            private void Respond(TcpClient client)
            {
                NetworkStream stream = client.GetStream();
                byte[] buffer = new byte[4096];
                int count = stream.Read(buffer, 0, buffer.Length);
                string request = Encoding.ASCII.GetString(buffer, 0, count);
                byte[] body = request.IndexOf("GET /manifest.json ", StringComparison.Ordinal) >= 0
                    ? ManifestBytes : PackageBytes;
                byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: "
                    + body.Length + "\r\n\r\n");
                stream.Write(header, 0, header.Length);
                stream.Write(body, 0, body.Length);
                stream.Flush();
            }
        }
    }
}
