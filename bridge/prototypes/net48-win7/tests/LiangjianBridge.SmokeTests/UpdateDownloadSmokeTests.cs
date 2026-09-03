using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Liangjian.BridgeV4.Update;

namespace Liangjian.BridgeV4.SmokeTests
{
    /// <summary>
    /// Local-only tests for the bounded update downloader. The test server is
    /// bound to loopback and no internet endpoint is contacted.
    /// </summary>
    public static class UpdateDownloadSmokeTests
    {
        public static void RunAll()
        {
            TestManifestSuccessAndStrictUtf8();
            TestManifestContentLengthLimit();
            TestPackageSuccess();
            TestPackageOversizeAndShortRead();
            TestRedirectLimit();
            TestNonLoopbackHttpAndCredentialUrlsRejected();
            TestFailedPackageLeavesNoPartialFile();
        }

        public static void TestManifestSuccessAndStrictUtf8()
        {
            string manifest = "{\"schema_version\":2,\"说明\":\"本地测试\"}";
            byte[] body = Encoding.UTF8.GetBytes(manifest);
            using (LocalHttpServer server = new LocalHttpServer(delegate(string path)
            {
                Assert(path == "/manifest.json", "manifest_path_not_requested");
                return LocalHttpResponse.Ok(body, true);
            }))
            {
                ReleaseManifestDownloadResult result = new ReleaseDownloadClient(3000)
                    .DownloadManifest(server.BaseUrl + "/manifest.json", true);
                Assert(result.ManifestText == manifest, "manifest_utf8_text_mismatch");
                Assert(result.BytesRead == body.LongLength, "manifest_byte_count_wrong");
                Assert(result.FinalUrl == server.BaseUrl + "/manifest.json", "manifest_final_url_wrong");
            }
        }

        public static void TestManifestContentLengthLimit()
        {
            using (LocalHttpServer server = new LocalHttpServer(delegate(string path)
            {
                return LocalHttpResponse.WithLength(200, "OK", new byte[] { 1 },
                    ReleaseDownloadClient.MaximumManifestBytes + 1L);
            }))
            {
                AssertThrows(delegate
                {
                    new ReleaseDownloadClient(3000).DownloadManifest(server.BaseUrl + "/too-large", true);
                }, "update_manifest_too_large", "manifest_content_length_limit_not_enforced");
            }
        }

        public static void TestPackageSuccess()
        {
            string root = CreateTempDirectory("liangjian-bridge-v4-download-success-");
            string destination = Path.Combine(root, "package.zip");
            byte[] body = Encoding.ASCII.GetBytes("package-bytes");
            try
            {
                using (LocalHttpServer server = new LocalHttpServer(delegate(string path)
                {
                    return LocalHttpResponse.Ok(body, true);
                }))
                {
                    ReleasePackageDownloadResult result = new ReleaseDownloadClient(3000)
                        .DownloadPackage(server.BaseUrl + "/core.zip", body.LongLength, destination, true);
                    Assert(result.PackagePath == Path.GetFullPath(destination), "package_path_wrong");
                    Assert(result.BytesRead == body.LongLength, "package_byte_count_wrong");
                    Assert(File.Exists(destination), "package_not_committed");
                    Assert(ByteArraysEqual(body, File.ReadAllBytes(destination)), "package_bytes_wrong");
                    Assert(!HasPartFiles(root), "package_part_file_left_after_success");
                }
            }
            finally
            {
                DeleteDirectory(root);
            }
        }

        public static void TestPackageOversizeAndShortRead()
        {
            string root = CreateTempDirectory("liangjian-bridge-v4-download-size-");
            string destination = Path.Combine(root, "package.zip");
            try
            {
                AssertThrows(delegate
                {
                    new ReleaseDownloadClient(3000).DownloadPackage(
                        "https://updates.example.test/package.zip",
                        ReleaseDownloadClient.MaximumPackageBytes + 1L,
                        destination);
                }, "update_package_size_invalid", "package_maximum_not_enforced");

                byte[] shortBody = Encoding.ASCII.GetBytes("123");
                using (LocalHttpServer server = new LocalHttpServer(delegate(string path)
                {
                    return LocalHttpResponse.Ok(shortBody, false);
                }))
                {
                    AssertThrows(delegate
                    {
                        new ReleaseDownloadClient(3000).DownloadPackage(
                            server.BaseUrl + "/short.zip", 5L, destination, true);
                    }, "update_package_short_read", "short_package_accepted");
                }
                Assert(!File.Exists(destination), "short_package_destination_created");
                Assert(!HasPartFiles(root), "short_package_part_file_left");
            }
            finally
            {
                DeleteDirectory(root);
            }
        }

        public static void TestRedirectLimit()
        {
            int requestCount = 0;
            using (LocalHttpServer server = new LocalHttpServer(delegate(string path)
            {
                Interlocked.Increment(ref requestCount);
                return LocalHttpResponse.Redirect("/loop");
            }))
            {
                AssertThrows(delegate
                {
                    new ReleaseDownloadClient(3000).DownloadManifest(server.BaseUrl + "/loop", true);
                }, "update_download_redirect_limit", "redirect_limit_not_enforced");
                Assert(requestCount == ReleaseDownloadClient.MaximumRedirects + 1,
                    "redirect_count_unexpected");
            }
        }

        public static void TestNonLoopbackHttpAndCredentialUrlsRejected()
        {
            AssertThrows(delegate
            {
                new ReleaseDownloadClient(3000).DownloadManifest(
                    "http://updates.example.test/manifest.json", true);
            }, "update_download_url_rejected", "non_loopback_http_accepted");
            AssertThrows(delegate
            {
                new ReleaseDownloadClient(3000).DownloadManifest(
                    "https://user:password@updates.example.test/manifest.json");
            }, "update_download_url_invalid", "credential_url_accepted");
        }

        public static void TestFailedPackageLeavesNoPartialFile()
        {
            string root = CreateTempDirectory("liangjian-bridge-v4-download-failure-");
            string destination = Path.Combine(root, "package.zip");
            byte[] body = Encoding.ASCII.GetBytes("partial");
            try
            {
                using (LocalHttpServer server = new LocalHttpServer(delegate(string path)
                {
                    return LocalHttpResponse.Ok(body, false);
                }))
                {
                    AssertThrows(delegate
                    {
                        new ReleaseDownloadClient(3000).DownloadPackage(
                            server.BaseUrl + "/package.zip", 20L, destination, true);
                    }, "update_package_short_read", "failed_package_download_accepted");
                }
                Assert(!File.Exists(destination), "failed_package_destination_created");
                Assert(!HasPartFiles(root), "failed_package_partial_file_left");
            }
            finally
            {
                DeleteDirectory(root);
            }
        }

        private static void AssertThrows(Action action, string expectedCode, string message)
        {
            try
            {
                action();
            }
            catch (InvalidDataException error)
            {
                Assert(error.Message == expectedCode, message + ": " + error.Message);
                return;
            }
            throw new InvalidOperationException(message);
        }

        private static string CreateTempDirectory(string prefix)
        {
            string path = Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }

        private static bool HasPartFiles(string directory)
        {
            return Directory.GetFiles(directory, "*.download-*.part").Length != 0;
        }

        private static void DeleteDirectory(string path)
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, true);
            }
        }

        private static bool ByteArraysEqual(byte[] first, byte[] second)
        {
            if (first == null || second == null || first.Length != second.Length)
            {
                return false;
            }
            for (int index = 0; index < first.Length; index++)
            {
                if (first[index] != second[index])
                {
                    return false;
                }
            }
            return true;
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }

        private sealed class LocalHttpResponse
        {
            public readonly int StatusCode;
            public readonly string Reason;
            public readonly byte[] Body;
            public readonly bool IncludeContentLength;
            public readonly long? ContentLengthOverride;
            public readonly string Location;

            private LocalHttpResponse(
                int statusCode,
                string reason,
                byte[] body,
                bool includeContentLength,
                long? contentLengthOverride,
                string location)
            {
                StatusCode = statusCode;
                Reason = reason;
                Body = body ?? new byte[0];
                IncludeContentLength = includeContentLength;
                ContentLengthOverride = contentLengthOverride;
                Location = location;
            }

            public static LocalHttpResponse Ok(byte[] body, bool includeContentLength)
            {
                return new LocalHttpResponse(200, "OK", body, includeContentLength, null, null);
            }

            public static LocalHttpResponse WithLength(int statusCode, string reason, byte[] body, long length)
            {
                return new LocalHttpResponse(statusCode, reason, body, true, length, null);
            }

            public static LocalHttpResponse Redirect(string location)
            {
                return new LocalHttpResponse(302, "Found", new byte[0], true, 0L, location);
            }
        }

        private sealed class LocalHttpServer : IDisposable
        {
            private readonly TcpListener listener;
            private readonly Func<string, LocalHttpResponse> handler;
            private readonly Thread thread;
            private volatile bool stopped;

            public readonly string BaseUrl;

            public LocalHttpServer(Func<string, LocalHttpResponse> handler)
            {
                this.handler = handler;
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                int port = ((IPEndPoint)listener.LocalEndpoint).Port;
                BaseUrl = "http://127.0.0.1:" + port.ToString();
                thread = new Thread(Run);
                thread.IsBackground = true;
                thread.Start();
            }

            public void Dispose()
            {
                stopped = true;
                listener.Stop();
                if (thread.IsAlive)
                {
                    thread.Join(3000);
                }
            }

            private void Run()
            {
                while (!stopped)
                {
                    TcpClient client = null;
                    try
                    {
                        client = listener.AcceptTcpClient();
                        Handle(client);
                    }
                    catch (SocketException)
                    {
                        if (stopped)
                        {
                            return;
                        }
                    }
                    catch (ObjectDisposedException)
                    {
                        if (stopped)
                        {
                            return;
                        }
                    }
                    finally
                    {
                        if (client != null)
                        {
                            client.Close();
                        }
                    }
                }
            }

            private void Handle(TcpClient client)
            {
                NetworkStream network = client.GetStream();
                network.ReadTimeout = 3000;
                byte[] readBuffer = new byte[2048];
                MemoryStream requestBuffer = new MemoryStream();
                while (requestBuffer.Length < 16384)
                {
                    int read = network.Read(readBuffer, 0, readBuffer.Length);
                    if (read <= 0)
                    {
                        break;
                    }
                    requestBuffer.Write(readBuffer, 0, read);
                    string requestText = Encoding.ASCII.GetString(requestBuffer.ToArray());
                    if (requestText.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0)
                    {
                        break;
                    }
                }
                string[] lines = Encoding.ASCII.GetString(requestBuffer.ToArray())
                    .Split(new string[] { "\r\n" }, StringSplitOptions.None);
                string[] requestParts = lines.Length == 0 ? new string[0] : lines[0].Split(' ');
                string target = requestParts.Length > 1 ? requestParts[1] : "/";
                int queryIndex = target.IndexOf('?');
                if (queryIndex >= 0)
                {
                    target = target.Substring(0, queryIndex);
                }
                LocalHttpResponse response = handler(target);
                StringBuilder header = new StringBuilder();
                header.Append("HTTP/1.1 ").Append(response.StatusCode).Append(' ')
                    .Append(response.Reason).Append("\r\nConnection: close\r\n");
                if (!string.IsNullOrEmpty(response.Location))
                {
                    header.Append("Location: ").Append(response.Location).Append("\r\n");
                }
                if (response.IncludeContentLength)
                {
                    long length = response.ContentLengthOverride.HasValue
                        ? response.ContentLengthOverride.Value
                        : response.Body.LongLength;
                    header.Append("Content-Length: ").Append(length.ToString()).Append("\r\n");
                }
                header.Append("\r\n");
                byte[] headerBytes = Encoding.ASCII.GetBytes(header.ToString());
                network.Write(headerBytes, 0, headerBytes.Length);
                if (response.Body.Length > 0)
                {
                    network.Write(response.Body, 0, response.Body.Length);
                }
                network.Flush();
            }
        }
    }
}
