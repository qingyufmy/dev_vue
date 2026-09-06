using System;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Runtime;

namespace Liangjian.BridgeV4.Configuration
{
    public sealed class BridgePairingDraft
    {
        public int Version { get; set; }
        public string InstallationId { get; set; }
        public string Code { get; set; }
        public string Token { get; set; }
        public bool Redeemed { get; set; }
        public BridgeProfileSettings Profile { get; set; }
    }

    // One in-progress "add profile" dialog per installation. The whole draft is
    // DPAPI protected, including its code, secret and terminal configuration.
    public sealed class BridgePairingDraftStore
    {
        private readonly string path;
        private readonly IBridgeSecretProtector secrets;
        private readonly BridgeProfileStore profiles;
        private readonly BridgePairingClient client;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 12 };

        public BridgePairingDraftStore(string filePath, IBridgeSecretProtector protector,
            BridgeProfileStore profileStore, BridgePairingClient pairingClient)
        {
            path = Path.GetFullPath(filePath);
            secrets = protector;
            profiles = profileStore;
            client = pairingClient;
        }

        public BridgePairingDraft Load(string installationId)
        {
            if (!File.Exists(path)) return null;
            try
            {
                if (new FileInfo(path).Length > 262144) throw Invalid();
                BridgePairingDraft draft = json.Deserialize<BridgePairingDraft>(secrets.Unprotect(File.ReadAllText(path, Encoding.UTF8)));
                if (draft == null || draft.Version != 1 || draft.InstallationId != installationId
                    || !ValidCode(draft.Code) || !ValidToken(draft.Token)) throw Invalid();
                BridgeProfileStore.ValidateProfile(draft.Profile, !draft.Redeemed);
                return draft;
            }
            catch (Exception) { throw Invalid(); }
        }

        public BridgeProfileSettings Pair(BridgeProfileSettings profile, string installationId, string code)
        {
            BridgeProfileStore.ValidateProfile(profile, true);
            if (!ValidCode(code)) throw new InvalidDataException("bridge_pairing_code_invalid");
            BridgePairingDraft draft = Load(installationId);
            if (draft != null && draft.Code == code)
            {
                if (!string.Equals(draft.Profile.ServerUri, profile.ServerUri, StringComparison.Ordinal))
                    throw new InvalidDataException("bridge_pairing_server_changed");
                string allocatedId = draft.Profile.ProfileId;
                draft.Profile = profile.Clone();
                if (draft.Redeemed)
                {
                    draft.Profile.ProfileId = allocatedId;
                    profiles.SetRefreshToken(draft.Profile, draft.Token);
                }
            }
            else
            {
                draft = new BridgePairingDraft { Version = 1, InstallationId = installationId,
                    Profile = profile.Clone(), Code = code, Token = BridgePairingClient.CreateRefreshToken() };
            }
            // Durable before any HTTP call: an unknown outcome must reuse this secret.
            Save(draft);
            if (!draft.Redeemed)
            {
                BridgePairingResult result = client.Redeem(profile.ServerUri, installationId, code, draft.Token);
                draft.Profile.ProfileId = result.ProfileId;
                draft.Redeemed = true;
            }
            profiles.SetRefreshToken(draft.Profile, draft.Token);
            Save(draft);
            return draft.Profile.Clone();
        }

        public void ClearCompleted(string installationId, string profileId)
        {
            BridgePairingDraft draft = Load(installationId);
            if (draft != null && draft.Redeemed && draft.Profile.ProfileId == profileId) File.Delete(path);
        }

        private void Save(BridgePairingDraft draft)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(secrets.Protect(json.Serialize(draft)));
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static bool ValidCode(string value)
        { return value != null && value.Length == 47 && System.Text.RegularExpressions.Regex.IsMatch(value, "^bpc_[A-Za-z0-9_-]{43}\\z"); }
        private static bool ValidToken(string value)
        { return value != null && value.Length == 68 && System.Text.RegularExpressions.Regex.IsMatch(value, "^br4_[A-Za-z0-9_-]{64}\\z"); }
        private static InvalidDataException Invalid() { return new InvalidDataException("bridge_pairing_draft_unavailable"); }
    }
}
