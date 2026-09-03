using System;
using System.IO;
using System.Net;
using System.Text;

namespace Liangjian.BridgeV4.Update
{
    public sealed class ReleaseManifestDownloadResult
    {
        public string ManifestText { get; private set; }
        public long BytesRead { get; private set; }
        public string FinalUrl { get; private set; }

        internal ReleaseManifestDownloadResult(string manifestText, long bytesRead, string finalUrl)
        {
            ManifestText = manifestText;
            BytesRead = bytesRead;
            FinalUrl = finalUrl;
        }
    }

    public sealed class ReleasePackageDownloadResult
    {
        public string PackagePath { get; private set; }
        public long BytesRead { get; private set; }
        public string FinalUrl { get; private set; }

        internal ReleasePackageDownloadResult(string packagePath, long bytesRead, string finalUrl)
        {
            PackagePath = packagePath;
            BytesRead = bytesRead;
            FinalUrl = finalUrl;
        }
    }

    /// <summary>
    /// Small, synchronous downloader used by the update coordinator. It does
    /// not verify release signatures or hashes; those remain the manifest
    /// verifier and package stager responsibilities.
    /// </summary>
    public sealed class ReleaseDownloadClient
    {
        public const int MaximumManifestBytes = 128 * 1024;
        public const long MaximumPackageBytes = 512L * 1024L * 1024L;
        public const int MaximumRedirects = 3;
        public const int DefaultTimeoutMilliseconds = 15000;

        private const int MaximumTimeoutMilliseconds = 120000;
        private static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly int timeoutMilliseconds;

        public ReleaseDownloadClient()
            : this(DefaultTimeoutMilliseconds)
        {
        }

        public ReleaseDownloadClient(int timeoutMilliseconds)
        {
            if (timeoutMilliseconds < 1000 || timeoutMilliseconds > MaximumTimeoutMilliseconds)
            {
                throw Invalid("update_download_timeout_invalid");
            }
            this.timeoutMilliseconds = timeoutMilliseconds;
        }

        public ReleaseManifestDownloadResult DownloadManifest(string url)
        {
            return DownloadManifest(url, false);
        }

        public ReleaseManifestDownloadResult DownloadManifest(string url, bool allowLoopbackHttp)
        {
            DownloadResponse opened = OpenResponse(url, allowLoopbackHttp);
            try
            {
                if (opened.Response.ContentLength > MaximumManifestBytes)
                {
                    throw Invalid("update_manifest_too_large");
                }
                byte[] bytes;
                using (Stream input = opened.Response.GetResponseStream())
                {
                    if (input == null)
                    {
                        throw Invalid("update_manifest_empty");
                    }
                    bytes = ReadBounded(input, MaximumManifestBytes, "update_manifest_too_large");
                }
                string text;
                try
                {
                    text = StrictUtf8.GetString(bytes);
                }
                catch (DecoderFallbackException error)
                {
                    throw Invalid("update_manifest_utf8_invalid", error);
                }
                return new ReleaseManifestDownloadResult(text, bytes.LongLength, opened.FinalUri.AbsoluteUri);
            }
            finally
            {
                opened.Response.Close();
            }
        }

        public ReleasePackageDownloadResult DownloadPackage(string url, long expectedSize, string temporaryPath)
        {
            return DownloadPackage(url, expectedSize, temporaryPath, false);
        }

        public ReleasePackageDownloadResult DownloadPackage(
            string url,
            long expectedSize,
            string temporaryPath,
            bool allowLoopbackHttp)
        {
            if (expectedSize <= 0 || expectedSize > MaximumPackageBytes)
            {
                throw Invalid("update_package_size_invalid");
            }

            string destination = PrepareDestination(temporaryPath);
            string stagingPath = CreateStagingPath(destination);
            DownloadResponse opened = null;
            long bytesRead = 0;
            try
            {
                opened = OpenResponse(url, allowLoopbackHttp);
                long contentLength = opened.Response.ContentLength;
                if (contentLength > MaximumPackageBytes)
                {
                    throw Invalid("update_package_too_large");
                }
                if (contentLength >= 0 && contentLength != expectedSize)
                {
                    throw Invalid("update_package_content_length_invalid");
                }

                using (Stream input = opened.Response.GetResponseStream())
                {
                    if (input == null)
                    {
                        throw Invalid("update_package_short_read");
                    }
                    using (FileStream output = new FileStream(
                        stagingPath,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        81920,
                        FileOptions.SequentialScan))
                    {
                        bytesRead = CopyExact(input, output, expectedSize);
                        output.Flush(true);
                    }
                }

                try
                {
                    File.Move(stagingPath, destination);
                }
                catch (IOException error)
                {
                    throw Invalid("update_package_destination_conflict", error);
                }
                return new ReleasePackageDownloadResult(destination, bytesRead, opened.FinalUri.AbsoluteUri);
            }
            finally
            {
                if (opened != null)
                {
                    opened.Response.Close();
                }
                DeleteIfExists(stagingPath);
            }
        }

        private DownloadResponse OpenResponse(string url, bool allowLoopbackHttp)
        {
            Uri current = ValidateUrl(url, allowLoopbackHttp);
            int redirects = 0;
            while (true)
            {
                HttpWebRequest request = CreateRequest(current);
                HttpWebResponse response = null;
                try
                {
                    response = (HttpWebResponse)request.GetResponse();
                }
                catch (WebException error)
                {
                    HttpWebResponse errorResponse = error.Response as HttpWebResponse;
                    if (errorResponse != null)
                    {
                        errorResponse.Close();
                    }
                    throw Invalid("update_download_request_failed", error);
                }

                int status = (int)response.StatusCode;
                if (IsRedirect(status))
                {
                    if (redirects >= MaximumRedirects)
                    {
                        response.Close();
                        throw Invalid("update_download_redirect_limit");
                    }
                    string location = response.Headers[HttpResponseHeader.Location];
                    response.Close();
                    if (string.IsNullOrWhiteSpace(location))
                    {
                        throw Invalid("update_download_redirect_invalid");
                    }
                    Uri next;
                    try
                    {
                        next = new Uri(current, location);
                    }
                    catch (UriFormatException error)
                    {
                        throw Invalid("update_download_redirect_invalid", error);
                    }
                    ValidateRedirect(current, next, allowLoopbackHttp);
                    current = next;
                    redirects++;
                    continue;
                }
                if (status != 200)
                {
                    response.Close();
                    throw Invalid("update_download_http_status");
                }
                return new DownloadResponse(response, current);
            }
        }

        private HttpWebRequest CreateRequest(Uri uri)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(uri);
            request.Method = "GET";
            request.AllowAutoRedirect = false;
            request.Timeout = timeoutMilliseconds;
            request.ReadWriteTimeout = timeoutMilliseconds;
            request.Proxy = WebRequest.DefaultWebProxy;
            if (request.Proxy != null) request.Proxy.Credentials = CredentialCache.DefaultCredentials;
            request.UserAgent = "LiangjianBridgeV4/1.0";
            request.PreAuthenticate = false;
            request.UseDefaultCredentials = false;
            request.Credentials = null;
            return request;
        }

        private static Uri ValidateUrl(string url, bool allowLoopbackHttp)
        {
            if (string.IsNullOrWhiteSpace(url))
            {
                throw Invalid("update_download_url_invalid");
            }
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || !string.IsNullOrEmpty(uri.UserInfo))
            {
                throw Invalid("update_download_url_invalid");
            }
            if (string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                return uri;
            }
            if (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                && allowLoopbackHttp
                && IsAllowedLoopbackHost(uri.Host))
            {
                return uri;
            }
            throw Invalid("update_download_url_rejected");
        }

        private static void ValidateRedirect(Uri current, Uri next, bool allowLoopbackHttp)
        {
            if (string.Equals(current.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                && string.Equals(next.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase))
            {
                throw Invalid("update_download_https_downgrade");
            }
            ValidateUrl(next.AbsoluteUri, allowLoopbackHttp);
        }

        private static bool IsAllowedLoopbackHost(string host)
        {
            return string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsRedirect(int status)
        {
            return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
        }

        private static byte[] ReadBounded(Stream input, int maximumBytes, string tooLargeCode)
        {
            MemoryStream buffer = new MemoryStream();
            byte[] chunk = new byte[81920];
            while (true)
            {
                int read = input.Read(chunk, 0, chunk.Length);
                if (read <= 0)
                {
                    break;
                }
                if (buffer.Length > maximumBytes - read)
                {
                    throw Invalid(tooLargeCode);
                }
                buffer.Write(chunk, 0, read);
                if (buffer.Length == maximumBytes)
                {
                    int extra = input.Read(chunk, 0, 1);
                    if (extra > 0)
                    {
                        throw Invalid(tooLargeCode);
                    }
                    break;
                }
            }
            return buffer.ToArray();
        }

        private static long CopyExact(Stream input, Stream output, long expectedSize)
        {
            byte[] buffer = new byte[81920];
            byte[] extraBuffer = new byte[1];
            long total = 0;
            while (total < expectedSize)
            {
                int requested = (int)Math.Min((long)buffer.Length, expectedSize - total);
                int read = input.Read(buffer, 0, requested);
                if (read <= 0)
                {
                    throw Invalid("update_package_short_read");
                }
                output.Write(buffer, 0, read);
                total += read;
            }
            if (input.Read(extraBuffer, 0, 1) > 0)
            {
                throw Invalid("update_package_size_invalid");
            }
            return total;
        }

        private static string PrepareDestination(string temporaryPath)
        {
            if (string.IsNullOrWhiteSpace(temporaryPath))
            {
                throw Invalid("update_package_destination_invalid");
            }
            string destination;
            try
            {
                destination = Path.GetFullPath(temporaryPath);
            }
            catch (Exception error)
            {
                if (error is ArgumentException || error is NotSupportedException || error is PathTooLongException)
                {
                    throw Invalid("update_package_destination_invalid", error);
                }
                throw;
            }
            string directory = Path.GetDirectoryName(destination);
            if (string.IsNullOrEmpty(Path.GetFileName(destination))
                || string.IsNullOrEmpty(directory)
                || !Directory.Exists(directory)
                || File.Exists(destination)
                || Directory.Exists(destination))
            {
                throw Invalid("update_package_destination_invalid");
            }
            return destination;
        }

        private static string CreateStagingPath(string destination)
        {
            for (int attempt = 0; attempt < 8; attempt++)
            {
                string candidate = destination + ".download-" + Guid.NewGuid().ToString("N") + ".part";
                if (!File.Exists(candidate) && !Directory.Exists(candidate))
                {
                    return candidate;
                }
            }
            throw Invalid("update_package_staging_path_invalid");
        }

        private static void DeleteIfExists(string path)
        {
            if (!string.IsNullOrEmpty(path) && File.Exists(path))
            {
                try
                {
                    File.Delete(path);
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
            }
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }

        private static InvalidDataException Invalid(string code, Exception inner)
        {
            return new InvalidDataException(code, inner);
        }

        private sealed class DownloadResponse
        {
            public readonly HttpWebResponse Response;
            public readonly Uri FinalUri;

            public DownloadResponse(HttpWebResponse response, Uri finalUri)
            {
                Response = response;
                FinalUri = finalUri;
            }
        }
    }
}
