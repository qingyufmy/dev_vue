using System;
using System.IO;
using System.Data.SQLite;
using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.Storage
{
    /// <summary>One immutable account dataset per paired profile route. Never copies trade ledgers.</summary>
    public sealed class ProfileAccountDataLocation
    {
        public string DatabasePath { get; private set; }
        public string DirectoryPath { get { return Path.GetDirectoryName(DatabasePath); } }
        public long ConnectionEpoch { get; private set; }

        public static IDisposable AcquireLease(string dataRoot, BridgeProfileSettings profile)
        {
            BridgeProfileStore.ValidateProfile(profile, false);
            string root = Path.Combine(Path.GetFullPath(dataRoot), "profiles", profile.ProfileId);
            Directory.CreateDirectory(root);
            // OS releases this handle after a crash; the empty file is not a persistent lock flag.
            return new FileStream(Path.Combine(root, "active.lock"), FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None);
        }

        public static ProfileAccountDataLocation Resolve(string dataRoot, BridgeProfileSettings profile)
        {
            BridgeProfileStore.ValidateProfile(profile, false);
            string root = Path.Combine(Path.GetFullPath(dataRoot), "profiles", profile.ProfileId);
            string accounts = Path.Combine(root, "accounts");
            string expected = Path.Combine(accounts, IdentityKey(profile), "bridge.db");
            ProfileAccountDataLocation result = new ProfileAccountDataLocation { DatabasePath = expected, ConnectionEpoch = 1 };
            string matching = null;
            Inspect(Path.Combine(root, "bridge.db"), profile, result, ref matching);
            if (Directory.Exists(accounts))
            {
                foreach (string directory in Directory.GetDirectories(accounts))
                {
                    // Our directories only; do not traverse arbitrary folders or recursive links.
                    string name = Path.GetFileName(directory);
                    if (name.Length != 64 || !IsHex(name)) continue;
                    if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("bridge_cache_directory_invalid");
                    Inspect(Path.Combine(directory, "bridge.db"), profile, result, ref matching);
                }
            }
            if (matching != null) result.DatabasePath = matching;
            // If a target exists with another identity, do not let the constructor overwrite it.
            if (File.Exists(expected) && matching != expected)
                throw new InvalidDataException("bridge_cache_profile_identity_mismatch");
            return result;
        }

        private static void Inspect(string path, BridgeProfileSettings profile, ProfileAccountDataLocation result, ref string matching)
        {
            if (!File.Exists(path)) return;
            using (SQLiteConnection connection = new SQLiteConnection("Data Source=" + path + ";Version=3;Read Only=True;BusyTimeout=5000;"))
            {
                connection.Open();
                using (SQLiteCommand query = connection.CreateCommand())
                {
                    query.CommandText = "SELECT profile_id,terminal_instance_id,platform,broker_server,login,connection_epoch FROM profile_state WHERE slot=1";
                    using (SQLiteDataReader row = query.ExecuteReader())
                    {
                        if (!row.Read() || row.GetString(0) != profile.ProfileId)
                            throw new InvalidDataException("bridge_cache_profile_identity_mismatch");
                        long epoch = Convert.ToInt64(row.GetValue(5), CultureInfo.InvariantCulture);
                        if (epoch < 1 || epoch >= 9007199254740991L)
                            throw new InvalidDataException("bridge_cache_epoch_invalid");
                        result.ConnectionEpoch = Math.Max(result.ConnectionEpoch, epoch);
                        if (row.GetString(1) == profile.TerminalInstanceId && row.GetString(2) == profile.Platform
                            && row.GetString(3) == profile.BrokerServer && row.GetString(4) == profile.Login)
                        {
                            if (matching != null) throw new InvalidDataException("bridge_cache_duplicate_identity");
                            matching = path;
                        }
                    }
                }
            }
        }

        private static string IdentityKey(BridgeProfileSettings profile)
        {
            using (MemoryStream bytes = new MemoryStream())
            {
                using (BinaryWriter writer = new BinaryWriter(bytes, Encoding.UTF8, true))
                {
                    writer.Write(profile.TerminalInstanceId);
                    writer.Write(profile.Platform);
                    writer.Write(profile.BrokerServer);
                    writer.Write(profile.Login);
                }
                using (SHA256 hash = SHA256.Create())
                    return BitConverter.ToString(hash.ComputeHash(bytes.ToArray())).Replace("-", "").ToLowerInvariant();
            }
        }

        private static bool IsHex(string name)
        {
            foreach (char c in name) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }
    }
}
