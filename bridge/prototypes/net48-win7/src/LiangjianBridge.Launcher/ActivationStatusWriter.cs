using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.LauncherApp
{
    internal static class ActivationStatusWriter
    {
        public static void Write(string releaseId, string targetVersion, string state, string errorCode)
        {
            string directory = Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData), "Liangjian", "BridgeV4", "updates");
            WriteToPath(Path.Combine(directory, "activation-status.json"), releaseId,
                targetVersion, state, errorCode);
        }

        internal static void WriteToPath(string path, string releaseId, string targetVersion,
            string state, string errorCode)
        {
            Validate(releaseId, targetVersion, state, errorCode);
            path = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(directory)) throw new InvalidDataException("bridge_activation_status_path_invalid");
            Directory.CreateDirectory(directory);
            string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                string json = new JavaScriptSerializer().Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "schema_version", 1 }, { "release_id", releaseId },
                    { "target_version", targetVersion }, { "state", state },
                    { "reported_at_utc_msc", UtcNowMsc() }, { "error_code", errorCode }
                });
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(json);
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally
            {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }

        private static void Validate(string releaseId, string version, string state, string errorCode)
        {
            Version parsed;
            if (!ValidOpaqueId(releaseId) || !Version.TryParse(version, out parsed)
                || (state != "healthy" && state != "rolled_back" && state != "failed")
                || (errorCode != null && (errorCode.Length == 0 || errorCode.Length > 128)))
                throw new InvalidDataException("bridge_activation_status_invalid");
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

        private static long UtcNowMsc()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }
}
