using System;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Runtime;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.Configuration
{
    // Only this encrypted document contains installation and pending profile secrets.
    // Views returned to the UI intentionally contain no credential material.
    public sealed class InstallationAuthorizationStore
    {
        private readonly object gate = new object();
        private readonly string path;
        private readonly IBridgeSecretProtector secrets;
        private readonly BridgeProfileStore profiles;
        private readonly InstallationAuthorizationClient client;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 };

        public InstallationAuthorizationStore(string filePath, IBridgeSecretProtector protector,
            BridgeProfileStore profileStore, InstallationAuthorizationClient authorizationClient)
        {
            if (protector == null || profileStore == null || authorizationClient == null) throw new ArgumentNullException("authorizationStoreDependency");
            path = Path.GetFullPath(filePath); secrets = protector; profiles = profileStore; client = authorizationClient;
        }

        public InstallationAuthorizationView ReadView()
        { lock (gate) { InstallationAuthorizationDocument value = Load(); return value == null ? null : View(value); } }

        public InstallationAuthorizationView Start(string apiBase, string installationId, string deviceName)
        {
            lock (gate)
            {
                string origin = InstallationAuthorizationClient.NormalizeBase(apiBase);
                InstallationAuthorizationClient.RequireKey(installationId);
                if (string.IsNullOrWhiteSpace(deviceName) || deviceName.Length > 128) throw Invalid();
                InstallationAuthorizationDocument value = Load();
                if (value != null && value.Status != "denied" && value.Status != "expired" && value.Status != "revoked")
                {
                    if (value.ApiBase != origin || value.InstallationId != installationId) throw new InvalidDataException("bridge_installation_authorization_origin_changed");
                    if (value.Status == "approved" || value.AuthorizationId != null) return View(value);
                }
                else
                {
                    if (value != null && value.PendingProfile != null) throw new InvalidDataException("bridge_installation_profile_pending");
                    value = new InstallationAuthorizationDocument { Version = 1, ApiBase = origin, InstallationId = installationId,
                        DeviceName = deviceName, PollSecret = InstallationAuthorizationClient.Secret("bip_", 32),
                        InstallationToken = InstallationAuthorizationClient.Secret("bi4_", 48), RequestKey = Guid.NewGuid().ToString("N"),
                        Status = "pending", PollIntervalSeconds = 5 };
                }
                Save(value); // Persist request identity and both secrets before even the first POST.
                InstallationAuthorizationView result = client.Start(value.ApiBase, value.InstallationId, value.DeviceName,
                    value.PollSecret, value.InstallationToken, value.RequestKey);
                value.AuthorizationId = result.AuthorizationId; value.ConfirmationPath = result.ConfirmationPath;
                value.ExpiresAt = result.ExpiresAt; value.PollIntervalSeconds = result.PollIntervalSeconds;
                Save(value); return View(value);
            }
        }

        public InstallationAuthorizationView Poll()
        {
            lock (gate)
            {
                InstallationAuthorizationDocument value = Required();
                if (value.Status != "pending") return View(value);
                if (value.AuthorizationId == null) throw new InvalidDataException("bridge_installation_authorization_start_required");
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (value.NextPollUtcMsc > now) return View(value);
                value.NextPollUtcMsc = checked(now + value.PollIntervalSeconds * 1000L);
                Save(value); // Also throttle retries after a lost response or application restart.
                InstallationAuthorizationView result = client.Poll(value.ApiBase, value.InstallationId, value.AuthorizationId,
                    value.PollSecret, value.InstallationToken);
                value.Status = result.Status; value.UserId = result.UserId; value.DisplayName = result.DisplayName;
                value.Generation = result.Generation; value.PollIntervalSeconds = result.PollIntervalSeconds;
                Save(value); return View(value);
            }
        }

        public InstallationStatus Status()
        {
            lock (gate)
            {
                InstallationAuthorizationDocument value = Approved();
                try { return client.Status(value.ApiBase, value.InstallationId, value.InstallationToken); }
                catch (BridgeHttpStatusException error)
                {
                    if (error.StatusCode == 401 || error.StatusCode == 403)
                    {
                        value.Status = "revoked"; Save(value);
                        return new InstallationStatus { InstallationId = value.InstallationId, Authorized = false };
                    }
                    throw;
                }
            }
        }

        public BridgeProfileSettings RegisterProfile(BridgeProfileSettings profile)
        {
            lock (gate)
            {
                InstallationAuthorizationDocument value = Approved();
                BridgeProfileStore.ValidateProfile(profile, true);
                Uri realtime = BridgeV4EndpointPolicy.ValidateRealtimeUri(profile.ServerUri);
                Uri control = new Uri(value.ApiBase);
                if (!string.Equals(realtime.Host, control.Host, StringComparison.OrdinalIgnoreCase)
                    || (control.Scheme == "https" && realtime.Scheme != "wss"))
                    throw new InvalidDataException("bridge_installation_profile_origin_mismatch");
                if (value.PendingProfile == null)
                {
                    value.PendingProfile = profile.Clone(); value.ProfileRequestKey = Guid.NewGuid().ToString("N");
                    value.ProfileRefreshToken = InstallationAuthorizationClient.Secret("br4_", 48); value.ProfileRegistered = false;
                }
                else if (!SameTerminal(value.PendingProfile, profile))
                    throw new InvalidDataException("bridge_installation_profile_pending");
                Save(value);
                if (!value.ProfileRegistered)
                {
                    BridgePairingResult result = client.RegisterProfile(value.ApiBase, value.InstallationId,
                        value.InstallationToken, value.ProfileRequestKey, value.ProfileRefreshToken);
                    value.PendingProfile.ProfileId = result.ProfileId; value.ProfileRegistered = true;
                }
                profiles.SetRefreshToken(value.PendingProfile, value.ProfileRefreshToken);
                Save(value);
                return value.PendingProfile.Clone();
            }
        }

        public BridgeProfileSettings ReadPendingProfile()
        { lock (gate) { InstallationAuthorizationDocument value = Load(); return value == null || value.PendingProfile == null ? null : value.PendingProfile.Clone(); } }

        // Called only after the catalog durably contains the returned profile.
        public void CompleteProfile(string profileId)
        {
            lock (gate)
            {
                InstallationAuthorizationDocument value = Required();
                if (value.PendingProfile == null) return;
                if (!value.ProfileRegistered || value.PendingProfile.ProfileId != profileId) throw Invalid();
                value.PendingProfile = null; value.ProfileRequestKey = null; value.ProfileRefreshToken = null;
                value.ProfileRegistered = false; Save(value);
            }
        }

        public void Revoke()
        {
            lock (gate)
            {
                InstallationAuthorizationDocument value = Required();
                // Explicit sign-out may discard only the uncommitted local registration draft.
                // A rejected installation proof has already made this parent authorization unusable.
                if (value.Status != "revoked") client.Revoke(value.ApiBase, value.InstallationId, value.InstallationToken);
                value.Status = "revoked";
                value.PendingProfile = null; value.ProfileRequestKey = null; value.ProfileRefreshToken = null;
                value.ProfileRegistered = false; Save(value);
            }
        }

        private static bool SameTerminal(BridgeProfileSettings left, BridgeProfileSettings right)
        {
            return left.TerminalInstanceId == right.TerminalInstanceId && left.Platform == right.Platform
                && left.BrokerServer == right.BrokerServer && left.Login == right.Login && left.ServerUri == right.ServerUri;
        }
        private InstallationAuthorizationDocument Approved()
        {
            InstallationAuthorizationDocument value = Required();
            if (value.Status != "approved") throw new InvalidDataException("bridge_installation_authorization_required");
            return value;
        }
        private InstallationAuthorizationDocument Required()
        { InstallationAuthorizationDocument value = Load(); if (value == null) throw new InvalidDataException("bridge_installation_authorization_required"); return value; }

        private InstallationAuthorizationDocument Load()
        {
            if (!File.Exists(path)) return null;
            try
            {
                if (new FileInfo(path).Length > 262144) throw Invalid();
                InstallationAuthorizationDocument value = json.Deserialize<InstallationAuthorizationDocument>(
                    secrets.Unprotect(File.ReadAllText(path, Encoding.UTF8)));
                if (value == null || value.Version != 1 || value.ApiBase != InstallationAuthorizationClient.NormalizeBase(value.ApiBase)) throw Invalid();
                InstallationAuthorizationClient.RequireKey(value.InstallationId); InstallationAuthorizationClient.RequireRequestKey(value.RequestKey);
                InstallationAuthorizationClient.RequireToken(value.PollSecret, "bip_", 43);
                InstallationAuthorizationClient.RequireToken(value.InstallationToken, "bi4_", 64);
                if (value.Status != "pending" && value.Status != "approved" && value.Status != "expired"
                    && value.Status != "denied" && value.Status != "revoked") throw Invalid();
                if (value.PollIntervalSeconds < 1 || value.PollIntervalSeconds > 60 || value.NextPollUtcMsc < 0) throw Invalid();
                if (value.AuthorizationId != null)
                {
                    InstallationAuthorizationClient.RequireKey(value.AuthorizationId);
                    if (value.ConfirmationPath != "/bridge/authorize?request=" + Uri.EscapeDataString(value.AuthorizationId)) throw Invalid();
                }
                if (value.Status == "approved" && (value.AuthorizationId == null || value.Generation < 1 || string.IsNullOrEmpty(value.UserId))) throw Invalid();
                if (value.PendingProfile != null)
                {
                    BridgeProfileStore.ValidateProfile(value.PendingProfile, !value.ProfileRegistered);
                    InstallationAuthorizationClient.RequireRequestKey(value.ProfileRequestKey);
                    InstallationAuthorizationClient.RequireToken(value.ProfileRefreshToken, "br4_", 64);
                }
                else if (value.ProfileRequestKey != null || value.ProfileRefreshToken != null || value.ProfileRegistered) throw Invalid();
                return value;
            }
            catch (Exception) { throw Invalid(); }
        }
        private void Save(InstallationAuthorizationDocument value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            byte[] bytes = null;
            try
            {
                bytes = Encoding.UTF8.GetBytes(secrets.Protect(json.Serialize(value)));
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
            }
            finally { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); if (File.Exists(temporary)) File.Delete(temporary); }
        }
        private static InstallationAuthorizationView View(InstallationAuthorizationDocument value)
        { return new InstallationAuthorizationView { AuthorizationId = value.AuthorizationId, ConfirmationPath = value.ConfirmationPath,
            ExpiresAt = value.ExpiresAt, PollIntervalSeconds = value.PollIntervalSeconds, Status = value.Status,
            UserId = value.UserId, DisplayName = value.DisplayName, Generation = value.Generation }; }
        private static InvalidDataException Invalid() { return new InvalidDataException("bridge_installation_authorization_store_invalid"); }
    }

    internal sealed class InstallationAuthorizationDocument
    {
        public int Version { get; set; }
        public string ApiBase { get; set; }
        public string InstallationId { get; set; }
        public string DeviceName { get; set; }
        public string PollSecret { get; set; }
        public string InstallationToken { get; set; }
        public string RequestKey { get; set; }
        public string AuthorizationId { get; set; }
        public string ConfirmationPath { get; set; }
        public string ExpiresAt { get; set; }
        public int PollIntervalSeconds { get; set; }
        public long NextPollUtcMsc { get; set; }
        public string Status { get; set; }
        public string UserId { get; set; }
        public string DisplayName { get; set; }
        public int Generation { get; set; }
        public BridgeProfileSettings PendingProfile { get; set; }
        public string ProfileRequestKey { get; set; }
        public string ProfileRefreshToken { get; set; }
        public bool ProfileRegistered { get; set; }
    }
}
