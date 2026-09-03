using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Update
{
    public sealed class ReleaseActivationStatus
    {
        public string ReleaseId { get; set; }
        public string TargetVersion { get; set; }
        public string State { get; set; }
        public long ReportedAtUtcMsc { get; set; }
        public string ErrorCode { get; set; }

        public string Fingerprint
        {
            get
            {
                return string.Concat(ReleaseId, "|", TargetVersion, "|", State, "|",
                    ReportedAtUtcMsc.ToString(System.Globalization.CultureInfo.InvariantCulture), "|", ErrorCode);
            }
        }
    }

    public sealed class ReleaseActivationStatusStore
    {
        private static readonly HashSet<string> Fields = new HashSet<string>(StringComparer.Ordinal)
        {
            "schema_version", "release_id", "target_version", "state", "reported_at_utc_msc", "error_code"
        };

        private readonly object gate = new object();
        private readonly string filePath;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();

        public ReleaseActivationStatusStore(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw Invalid("update_status_path_invalid");
            filePath = Path.GetFullPath(path);
            if (string.IsNullOrEmpty(Path.GetDirectoryName(filePath))) throw Invalid("update_status_path_invalid");
            serializer.MaxJsonLength = 16 * 1024;
        }

        public string FilePath { get { return filePath; } }

        public ReleaseActivationStatus Read()
        {
            lock (gate)
            {
                if (!File.Exists(filePath)) return null;
                string json;
                using (StreamReader reader = new StreamReader(filePath, new UTF8Encoding(false, true)))
                {
                    json = reader.ReadToEnd();
                }
                if (Encoding.UTF8.GetByteCount(json) > 16 * 1024) throw Invalid("update_status_invalid");
                IDictionary<string, object> root;
                try { root = serializer.DeserializeObject(json) as IDictionary<string, object>; }
                catch (ArgumentException) { throw Invalid("update_status_invalid"); }
                catch (InvalidOperationException) { throw Invalid("update_status_invalid"); }
                if (root == null || root.Count != Fields.Count) throw Invalid("update_status_invalid");
                foreach (string key in root.Keys) if (!Fields.Contains(key)) throw Invalid("update_status_invalid");
                if (ReadLong(root, "schema_version") != 1) throw Invalid("update_status_invalid");
                ReleaseActivationStatus status = new ReleaseActivationStatus
                {
                    ReleaseId = ReadText(root, "release_id", 191),
                    TargetVersion = ReadVersion(root, "target_version"),
                    State = ReadText(root, "state", 16),
                    ReportedAtUtcMsc = ReadLong(root, "reported_at_utc_msc"),
                    ErrorCode = ReadOptionalText(root, "error_code", 128)
                };
                if (!ValidOpaqueId(status.ReleaseId)
                    || (status.State != "healthy" && status.State != "rolled_back" && status.State != "failed")
                    || status.ReportedAtUtcMsc < 1) throw Invalid("update_status_invalid");
                return status;
            }
        }

        public void Write(ReleaseActivationStatus status)
        {
            Validate(status);
            lock (gate)
            {
                string directory = Path.GetDirectoryName(filePath);
                Directory.CreateDirectory(directory);
                string temporary = filePath + ".tmp-" + Guid.NewGuid().ToString("N");
                try
                {
                    string json = serializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
                    {
                        { "schema_version", 1 }, { "release_id", status.ReleaseId },
                        { "target_version", status.TargetVersion }, { "state", status.State },
                        { "reported_at_utc_msc", status.ReportedAtUtcMsc }, { "error_code", status.ErrorCode }
                    });
                    using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(json);
                    if (File.Exists(filePath)) File.Replace(temporary, filePath, null);
                    else File.Move(temporary, filePath);
                }
                finally
                {
                    if (File.Exists(temporary)) File.Delete(temporary);
                }
            }
        }

        private static void Validate(ReleaseActivationStatus status)
        {
            if (status == null) throw Invalid("update_status_invalid");
            Dictionary<string, object> values = new Dictionary<string, object>
            {
                { "release_id", status.ReleaseId }, { "target_version", status.TargetVersion }
            };
            ReadText(values, "release_id", 191);
            ReadVersion(values, "target_version");
            if (!ValidOpaqueId(status.ReleaseId)
                || (status.State != "healthy" && status.State != "rolled_back" && status.State != "failed")
                || status.ReportedAtUtcMsc < 1 || (status.ErrorCode != null
                    && (status.ErrorCode.Length == 0 || status.ErrorCode.Length > 128)))
                throw Invalid("update_status_invalid");
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

        private static string ReadVersion(IDictionary<string, object> values, string key)
        {
            string text = ReadText(values, key, 64);
            Version parsed;
            if (!Version.TryParse(text, out parsed)) throw Invalid("update_status_invalid");
            return parsed.ToString();
        }

        private static string ReadText(IDictionary<string, object> values, string key, int maximum)
        {
            object raw;
            string text;
            if (!values.TryGetValue(key, out raw) || (text = raw as string) == null
                || text.Length < 1 || text.Length > maximum) throw Invalid("update_status_invalid");
            return text;
        }

        private static string ReadOptionalText(IDictionary<string, object> values, string key, int maximum)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null) return null;
            string text = raw as string;
            if (string.IsNullOrEmpty(text) || text.Length > maximum) throw Invalid("update_status_invalid");
            return text;
        }

        private static long ReadLong(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw)) throw Invalid("update_status_invalid");
            if (raw is int) return (int)raw;
            if (raw is long) return (long)raw;
            throw Invalid("update_status_invalid");
        }

        private static InvalidDataException Invalid(string code) { return new InvalidDataException(code); }
    }
}
