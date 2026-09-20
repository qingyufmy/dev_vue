using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Liangjian.BridgeV4.Migration;

namespace Liangjian.BridgeV4.Configuration
{
    public interface IBridgeSecretProtector
    {
        string Protect(string plaintext);
        string Unprotect(string ciphertext);
    }

    public sealed class CurrentUserSecretProtector : IBridgeSecretProtector
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Liangjian.BridgeV4.ProfileSecret.v1");

        public string Protect(string plaintext)
        {
            if (string.IsNullOrWhiteSpace(plaintext))
            {
                throw new InvalidDataException("bridge_profile_secret_empty");
            }
            byte[] source = Encoding.UTF8.GetBytes(plaintext);
            try
            {
                return Convert.ToBase64String(ProtectedData.Protect(source, Entropy, DataProtectionScope.CurrentUser));
            }
            finally
            {
                Array.Clear(source, 0, source.Length);
            }
        }

        public string Unprotect(string ciphertext)
        {
            if (string.IsNullOrWhiteSpace(ciphertext))
            {
                throw new InvalidDataException("bridge_profile_secret_missing");
            }
            byte[] protectedBytes;
            try
            {
                protectedBytes = Convert.FromBase64String(ciphertext);
            }
            catch (FormatException)
            {
                throw new InvalidDataException("bridge_profile_secret_invalid");
            }
            byte[] plaintext = null;
            try
            {
                plaintext = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
                string value = new UTF8Encoding(false, true).GetString(plaintext);
                if (string.IsNullOrWhiteSpace(value))
                {
                    throw new InvalidDataException("bridge_profile_secret_invalid");
                }
                return value;
            }
            catch (CryptographicException)
            {
                throw new InvalidDataException("bridge_profile_secret_unavailable");
            }
            catch (DecoderFallbackException)
            {
                throw new InvalidDataException("bridge_profile_secret_invalid");
            }
            finally
            {
                Array.Clear(protectedBytes, 0, protectedBytes.Length);
                if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length);
            }
        }
    }

    public sealed class BridgeProfileCatalog
    {
        public BridgeProfileCatalog()
        {
            SchemaVersion = 2;
            Profiles = new List<BridgeProfileSettings>();
        }

        public int SchemaVersion { get; set; }
        public string InstallationId { get; set; }
        public List<BridgeProfileSettings> Profiles { get; set; }
    }

    public sealed class BridgeProfileSettings
    {
        public string ProfileId { get; set; }
        public string DisplayName { get; set; }
        public string Platform { get; set; }
        public string TerminalInstanceId { get; set; }
        public string BrokerServer { get; set; }
        public string Login { get; set; }
        public string ServerUri { get; set; }
        public bool AutoConnect { get; set; }
        public bool RemovalPending { get; set; }
        public string PythonExecutablePath { get; set; }
        public string WorkerScriptPath { get; set; }
        public string TerminalPath { get; set; }
        public bool Mt5Portable { get; set; }
        public string Mt5DataPath { get; set; }
        public string ProtectedRefreshToken { get; set; }

        public BridgeProfileSettings Clone()
        {
            return (BridgeProfileSettings)MemberwiseClone();
        }

        public bool SameRoute(BridgeProfileSettings other)
        {
            return other != null
                && string.Equals(Platform, other.Platform, StringComparison.OrdinalIgnoreCase)
                && string.Equals(TerminalInstanceId, other.TerminalInstanceId, StringComparison.Ordinal)
                && string.Equals(BrokerServer, other.BrokerServer, StringComparison.Ordinal)
                && string.Equals(Login, other.Login, StringComparison.Ordinal);
        }

        public bool SameConnectionSettings(BridgeProfileSettings other)
        {
            return SameRoute(other)
                && string.Equals(ServerUri, other.ServerUri, StringComparison.Ordinal)
                && string.Equals(PythonExecutablePath, other.PythonExecutablePath, StringComparison.OrdinalIgnoreCase)
                && string.Equals(WorkerScriptPath, other.WorkerScriptPath, StringComparison.OrdinalIgnoreCase)
                && string.Equals(TerminalPath, other.TerminalPath, StringComparison.OrdinalIgnoreCase)
                && Mt5Portable == other.Mt5Portable
                && string.Equals(Mt5DataPath ?? string.Empty, other.Mt5DataPath ?? string.Empty, StringComparison.OrdinalIgnoreCase);
        }
    }

    public sealed class BridgeProfileStore
    {
        public const int CurrentSchemaVersion = 2;
        private readonly string path;
        private readonly IBridgeSecretProtector secrets;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();

        public BridgeProfileStore(string filePath, IBridgeSecretProtector secretProtector)
        {
            if (string.IsNullOrWhiteSpace(filePath) || secretProtector == null)
            {
                throw new ArgumentNullException(string.IsNullOrWhiteSpace(filePath) ? "filePath" : "secretProtector");
            }
            path = Path.GetFullPath(filePath);
            secrets = secretProtector;
            serializer.MaxJsonLength = 1024 * 1024;
            serializer.RecursionLimit = 32;
        }

        public string FilePath { get { return path; } }

        public BridgeProfileCatalog LoadOrCreate()
        {
            if (!File.Exists(path))
            {
                return new BridgeProfileCatalog
                {
                    InstallationId = "installation-" + Guid.NewGuid().ToString("N")
                };
            }
            try
            {
                string json = File.ReadAllText(path, Encoding.UTF8);
                ValidateJsonShape(json);
                BridgeProfileCatalog catalog = serializer.Deserialize<BridgeProfileCatalog>(json);
                // Early prototypes wrote schema 1 even before a profile existed.
                // An empty catalog has no credentials or endpoint semantics to
                // migrate. Preserve installation identity and leave disk untouched.
                if (catalog != null && catalog.SchemaVersion == 1
                    && catalog.Profiles != null && catalog.Profiles.Count == 0)
                    catalog.SchemaVersion = CurrentSchemaVersion;
                Validate(catalog, false);
                return catalog;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception error)
            {
                if (error is IOException || error is UnauthorizedAccessException) throw;
                throw new InvalidDataException("bridge_profile_catalog_invalid", error);
            }
        }

        public void Save(BridgeProfileCatalog catalog)
        {
            Validate(catalog, false);
            string directory = Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(directory)) throw new InvalidDataException("bridge_profile_catalog_path_invalid");
            Directory.CreateDirectory(directory);
            string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            string backup = path + ".previous";
            try
            {
                // Keep unchanged profiles readable by previous V4 binaries. A
                // pending-removal profile intentionally fails their strict reader.
                IDictionary<string, object> encoded = serializer.DeserializeObject(serializer.Serialize(catalog)) as IDictionary<string, object>;
                foreach (object value in (object[])encoded["Profiles"])
                {
                    IDictionary<string, object> profile = (IDictionary<string, object>)value;
                    if (!(bool)profile["RemovalPending"]) profile.Remove("RemovalPending");
                    if (!(bool)profile["Mt5Portable"]) profile.Remove("Mt5Portable");
                    if (string.IsNullOrEmpty(profile["Mt5DataPath"] as string)) profile.Remove("Mt5DataPath");
                }
                File.WriteAllText(temporary, serializer.Serialize(encoded), new UTF8Encoding(false));
                using (FileStream stream = new FileStream(temporary, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    stream.Flush(true);
                }
                if (File.Exists(path))
                {
                    File.Replace(temporary, path, backup, true);
                    if (File.Exists(backup)) File.Delete(backup);
                }
                else
                {
                    File.Move(temporary, path);
                }
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        public void SetRefreshToken(BridgeProfileSettings profile, string refreshToken)
        {
            if (profile == null) throw new ArgumentNullException("profile");
            profile.ProtectedRefreshToken = secrets.Protect(refreshToken);
        }

        public string ReadRefreshToken(BridgeProfileSettings profile)
        {
            if (profile == null) throw new ArgumentNullException("profile");
            return secrets.Unprotect(profile.ProtectedRefreshToken);
        }

        public static void Validate(BridgeProfileCatalog catalog, bool allowMissingSecret)
        {
            if (catalog == null || catalog.SchemaVersion != CurrentSchemaVersion
                || !ValidIdentifier(catalog.InstallationId, 128) || catalog.Profiles == null)
            {
                throw new InvalidDataException("bridge_profile_catalog_invalid");
            }
            HashSet<string> profileIds = new HashSet<string>(StringComparer.Ordinal);
            HashSet<string> terminals = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (BridgeProfileSettings profile in catalog.Profiles)
            {
                ValidateProfile(profile, allowMissingSecret);
                if (!profileIds.Add(profile.ProfileId)
                    || !terminals.Add(profile.Platform + "|" + profile.TerminalInstanceId))
                {
                    throw new InvalidDataException("bridge_profile_catalog_duplicate");
                }
            }
        }

        public static void ValidateProfile(BridgeProfileSettings profile, bool allowMissingSecret)
        {
            if (profile != null && profile.RemovalPending && profile.AutoConnect)
                throw new InvalidDataException("bridge_profile_removal_pending");
            if (profile == null
                || !ValidIdentifier(profile.ProfileId, 128)
                || !ValidText(profile.DisplayName, 80)
                || !ValidText(profile.TerminalInstanceId, 191)
                || !ValidText(profile.BrokerServer, 128)
                || !ValidText(profile.Login, 64)
                || (profile.Platform != "mt4" && profile.Platform != "mt5"))
            {
                throw new InvalidDataException("bridge_profile_invalid");
            }
            try
            {
                BridgeV4EndpointPolicy.ValidateRealtimeUri(profile.ServerUri);
            }
            catch (InvalidDataException)
            {
                throw new InvalidDataException("bridge_profile_server_uri_invalid");
            }
            if (!allowMissingSecret && string.IsNullOrWhiteSpace(profile.ProtectedRefreshToken))
            {
                throw new InvalidDataException("bridge_profile_secret_missing");
            }
            if (profile.Platform == "mt5"
                && (!ValidPath(profile.PythonExecutablePath) || !ValidPath(profile.WorkerScriptPath)
                    || !ValidPath(profile.TerminalPath)))
            {
                throw new InvalidDataException("bridge_profile_mt5_path_invalid");
            }
            if (!string.IsNullOrEmpty(profile.Mt5DataPath) && !ValidPath(profile.Mt5DataPath))
                throw new InvalidDataException("bridge_profile_mt5_path_invalid");
        }

        private void ValidateJsonShape(string json)
        {
            IDictionary<string, object> root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            RequireExactFields(root, new[] { "SchemaVersion", "InstallationId", "Profiles" });
            object rawProfiles;
            object[] profiles;
            if (!root.TryGetValue("Profiles", out rawProfiles) || (profiles = rawProfiles as object[]) == null)
                throw new InvalidDataException("bridge_profile_catalog_invalid");
            string[] fields =
            {
                "ProfileId", "DisplayName", "Platform", "TerminalInstanceId", "BrokerServer", "Login",
                "ServerUri", "AutoConnect", "PythonExecutablePath", "WorkerScriptPath", "TerminalPath",
                "ProtectedRefreshToken"
            };
            foreach (object value in profiles)
            {
                IDictionary<string, object> profile = value as IDictionary<string, object>;
                if (profile != null && profile.ContainsKey("Mt5Portable"))
                {
                    if (!(profile["Mt5Portable"] is bool)) throw new InvalidDataException("bridge_profile_catalog_invalid");
                    profile.Remove("Mt5Portable");
                }
                if (profile != null && profile.ContainsKey("Mt5DataPath"))
                {
                    if (!(profile["Mt5DataPath"] is string)) throw new InvalidDataException("bridge_profile_catalog_invalid");
                    profile.Remove("Mt5DataPath");
                }
                if (profile != null && profile.ContainsKey("RemovalPending"))
                {
                    if (!(profile["RemovalPending"] is bool)) throw new InvalidDataException("bridge_profile_catalog_invalid");
                    profile.Remove("RemovalPending");
                }
                RequireExactFields(profile, fields);
            }
        }

        private static void RequireExactFields(IDictionary<string, object> values, string[] fields)
        {
            if (values == null || values.Count != fields.Length)
                throw new InvalidDataException("bridge_profile_catalog_invalid");
            HashSet<string> expected = new HashSet<string>(fields, StringComparer.Ordinal);
            foreach (string field in values.Keys)
                if (!expected.Remove(field)) throw new InvalidDataException("bridge_profile_catalog_invalid");
            if (expected.Count != 0) throw new InvalidDataException("bridge_profile_catalog_invalid");
        }

        private static bool ValidText(string value, int maximumLength)
        {
            return !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength
                && value.IndexOf('\r') < 0 && value.IndexOf('\n') < 0;
        }

        private static bool ValidPath(string value)
        {
            return ValidText(value, 4096) && Path.IsPathRooted(value);
        }

        private static bool ValidIdentifier(string value, int maximumLength)
        {
            if (!ValidText(value, maximumLength) || !IsAsciiAlphaNumeric(value[0])) return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (!IsAsciiAlphaNumeric(current) && current != '-' && current != '_' && current != '.') return false;
            }
            return true;
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }
    }
}
