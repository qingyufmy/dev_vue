using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.Update
{
    public sealed class BridgeUpdateSnapshot
    {
        public string ReleaseId { get; internal set; }
        public string Version { get; internal set; }
        public string State { get; internal set; }
        public long RestartNotBeforeUtcMsc { get; internal set; }
        public string ErrorCode { get; internal set; }
    }

    public sealed class BridgeUpdateService
    {
        private const long MaximumReleaseDownloadBytes = 1024L * 1024L * 1024L;
        private readonly object gate = new object();
        private readonly string downloadsRoot;
        private readonly string launcherVersion;
        private readonly bool allowLoopbackHttp;
        private readonly ReleaseDownloadClient downloader;
        private readonly ReleaseManifestVerifier verifier;
        private readonly ReleasePackageStager stager;
        private readonly ReleaseActivationStatusStore statusStore;
        private PendingBridgeRelease pending;
        private string state = "idle";
        private string errorCode;
        private string processingReleaseId;

        public BridgeUpdateService(string installDirectory, string dataRoot, string launcherVersionValue)
            : this(installDirectory, dataRoot, launcherVersionValue, ReleaseTrust.PublicKeyPem,
                new ReleaseDownloadClient(), false, null)
        {
        }

        internal BridgeUpdateService(string installDirectory, string dataRoot, string launcherVersionValue,
            string publicKeyPem, ReleaseDownloadClient downloadClient, bool allowLocalHttp,
            Func<long> clock)
        {
            if (string.IsNullOrWhiteSpace(installDirectory) || string.IsNullOrWhiteSpace(dataRoot)
                || string.IsNullOrWhiteSpace(launcherVersionValue) || downloadClient == null)
                throw Invalid("update_service_configuration_invalid");
            string installRoot = NormalizeRoot(installDirectory, "update_service_install_root_invalid");
            string fullDataRoot = NormalizeRoot(dataRoot, "update_service_data_root_invalid");
            downloadsRoot = Path.Combine(fullDataRoot, "updates", "downloads");
            EnsureChild(downloadsRoot, fullDataRoot, "update_service_data_root_invalid");
            launcherVersion = launcherVersionValue;
            allowLoopbackHttp = allowLocalHttp;
            downloader = downloadClient;
            verifier = new ReleaseManifestVerifier(publicKeyPem, clock);
            stager = new ReleasePackageStager(installRoot, verifier, launcherVersion);
            statusStore = new ReleaseActivationStatusStore(Path.Combine(fullDataRoot,
                "updates", "activation-status.json"));
        }

        public void Observe(PendingBridgeRelease release)
        {
            ValidateRelease(release);
            PendingBridgeRelease work = Copy(release);
            bool queue = false;
            lock (gate)
            {
                if (pending != null && pending.ReleaseId == work.ReleaseId
                    && (state == "downloading" || state == "staged" || state == "activating"
                        || state == "failed")) return;
                pending = work;
                state = "downloading";
                errorCode = null;
                if (processingReleaseId == null)
                {
                    processingReleaseId = work.ReleaseId;
                    queue = true;
                }
            }
            if (queue) ThreadPool.QueueUserWorkItem(delegate { DownloadAndStage(work); });
        }

        public BridgeUpdateSnapshot Snapshot()
        {
            lock (gate)
            {
                return pending == null ? new BridgeUpdateSnapshot { State = state, ErrorCode = errorCode }
                    : new BridgeUpdateSnapshot
                    {
                        ReleaseId = pending.ReleaseId, Version = pending.Version, State = state,
                        RestartNotBeforeUtcMsc = pending.RestartNotBeforeUtcMsc, ErrorCode = errorCode
                    };
            }
        }

        public PendingBridgeRelease ReadyRelease(long nowUtcMsc, UpdateActivitySnapshot activity)
        {
            if (activity == null || nowUtcMsc < 1 || activity.ActiveCommands < 0
                || activity.UncertainCommands < 0 || activity.PendingCriticalWrites < 0)
                throw Invalid("update_service_activity_invalid");
            lock (gate)
            {
                return pending != null && state == "staged" && nowUtcMsc >= pending.RestartNotBeforeUtcMsc
                    && activity.ActiveCommands == 0 && activity.UncertainCommands == 0
                    && activity.PendingCriticalWrites == 0 ? Copy(pending) : null;
            }
        }

        public bool MarkActivating(string releaseId)
        {
            lock (gate)
            {
                if (pending == null || pending.ReleaseId != releaseId || state != "staged") return false;
                state = "activating";
                return true;
            }
        }

        public void MarkActivationLaunchFailed(string releaseId, long nowUtcMsc, string code)
        {
            ReleaseActivationStatus failure = null;
            lock (gate)
            {
                if (pending == null || pending.ReleaseId != releaseId) return;
                state = "failed";
                errorCode = SafeCode(code);
                failure = new ReleaseActivationStatus
                {
                    ReleaseId = pending.ReleaseId, TargetVersion = pending.Version, State = "failed",
                    ReportedAtUtcMsc = nowUtcMsc, ErrorCode = errorCode
                };
            }
            TryWriteStatus(failure);
        }

        private void DownloadAndStage(PendingBridgeRelease work)
        {
            string workingDirectory = null;
            try
            {
                ReleaseManifestDownloadResult downloaded = downloader.DownloadManifest(
                    work.ManifestUrl, allowLoopbackHttp);
                ReleaseManifest manifest = verifier.VerifyJson(downloaded.ManifestText, launcherVersion);
                if (manifest.ReleaseId != work.ReleaseId || manifest.ReleaseVersion != work.Version
                    || manifest.RolloutChannel != work.RolloutChannel)
                    throw Invalid("update_release_notification_mismatch");

                Directory.CreateDirectory(downloadsRoot);
                workingDirectory = Path.Combine(downloadsRoot, work.ReleaseId + "-" + Guid.NewGuid().ToString("N"));
                EnsureChild(workingDirectory, downloadsRoot, "update_service_download_root_invalid");
                Directory.CreateDirectory(workingDirectory);
                Dictionary<string, string> packageFiles = new Dictionary<string, string>(StringComparer.Ordinal);
                long totalDownloadBytes = 0;
                foreach (ReleasePackage package in manifest.Packages)
                {
                    if (package.SizeBytes > MaximumReleaseDownloadBytes - totalDownloadBytes)
                        throw Invalid("update_release_size_invalid");
                    totalDownloadBytes += package.SizeBytes;
                    string destination = Path.Combine(workingDirectory, package.ModuleId + ".zip");
                    ReleasePackageDownloadResult packageResult = downloader.DownloadPackage(
                        package.Url, package.SizeBytes, destination, allowLoopbackHttp);
                    packageFiles.Add(package.ModuleId, packageResult.PackagePath);
                }
                stager.Stage(manifest, packageFiles);
                lock (gate)
                {
                    if (pending != null && pending.ReleaseId == work.ReleaseId)
                    {
                        state = "staged";
                        errorCode = null;
                    }
                }
            }
            catch (Exception error)
            {
                string code = SafeCode(error.Message);
                lock (gate)
                {
                    if (pending != null && pending.ReleaseId == work.ReleaseId)
                    {
                        state = "failed";
                        errorCode = code;
                        TryWriteStatus(new ReleaseActivationStatus
                        {
                            ReleaseId = work.ReleaseId, TargetVersion = work.Version, State = "failed",
                            ReportedAtUtcMsc = UtcNowMsc(), ErrorCode = code
                        });
                    }
                }
            }
            finally
            {
                if (workingDirectory != null && Directory.Exists(workingDirectory))
                {
                    try
                    {
                        EnsureChild(workingDirectory, downloadsRoot, "update_service_download_root_invalid");
                        Directory.Delete(workingDirectory, true);
                    }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                    catch (InvalidDataException) { }
                }
                PendingBridgeRelease next = null;
                lock (gate)
                {
                    processingReleaseId = null;
                    if (pending != null && pending.ReleaseId != work.ReleaseId && state == "downloading")
                    {
                        next = Copy(pending);
                        processingReleaseId = next.ReleaseId;
                    }
                }
                if (next != null) ThreadPool.QueueUserWorkItem(delegate { DownloadAndStage(next); });
            }
        }

        private static void ValidateRelease(PendingBridgeRelease release)
        {
            Uri manifest;
            Version version;
            if (release == null || !ValidOpaqueId(release.ReleaseId)
                || !Version.TryParse(release.Version, out version)
                || !Uri.TryCreate(release.ManifestUrl, UriKind.Absolute, out manifest)
                || (release.RolloutChannel != "internal" && release.RolloutChannel != "stable")
                || (release.Reason != "published" && release.Reason != "rollback")
                || release.RestartNotBeforeUtcMsc < 1) throw Invalid("update_release_invalid");
        }

        private static PendingBridgeRelease Copy(PendingBridgeRelease value)
        {
            return new PendingBridgeRelease
            {
                ReleaseId = value.ReleaseId, Version = value.Version, ManifestUrl = value.ManifestUrl,
                RolloutChannel = value.RolloutChannel, Reason = value.Reason,
                RestartNotBeforeUtcMsc = value.RestartNotBeforeUtcMsc, Staged = value.Staged
            };
        }

        private static string NormalizeRoot(string path, string code)
        {
            string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string root = Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) throw Invalid(code);
            return full;
        }

        private static void EnsureChild(string child, string parent, string code)
        {
            string fullChild = Path.GetFullPath(child).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string fullParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!fullChild.StartsWith(fullParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw Invalid(code);
        }

        private static string SafeCode(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 128) return "update_failed";
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')
                    || character == '_')) return "update_failed";
            }
            return value;
        }

        private static bool ValidOpaqueId(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length < 8 || value.Length > 191) return false;
            foreach (char character in value)
            {
                if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
                    || (character >= '0' && character <= '9') || character == '.' || character == '_'
                    || character == ':' || character == '-')) return false;
            }
            return true;
        }

        private void TryWriteStatus(ReleaseActivationStatus status)
        {
            try { statusStore.Write(status); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (InvalidDataException) { }
        }

        private static long UtcNowMsc()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static InvalidDataException Invalid(string code) { return new InvalidDataException(code); }
    }
}
