using System;
using System.Collections.Generic;
using System.Data.SQLite;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Migration
{
    public static partial class LegacyV3Migration
    {
        private static bool TryNormalizeEndpoint(
            string value,
            bool realtime,
            out string legacyUri,
            out Uri candidate)
        {
            legacyUri = null;
            candidate = null;
            Uri parsed;
            if (!Uri.TryCreate(value, UriKind.Absolute, out parsed)
                || string.IsNullOrEmpty(parsed.Host)
                || !string.IsNullOrEmpty(parsed.UserInfo)
                || !string.IsNullOrEmpty(parsed.Query)
                || !string.IsNullOrEmpty(parsed.Fragment))
            {
                return false;
            }
            bool isHttp = string.Equals(parsed.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase);
            bool isHttps = string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
            bool isWs = string.Equals(parsed.Scheme, "ws", StringComparison.OrdinalIgnoreCase);
            bool isWss = string.Equals(parsed.Scheme, "wss", StringComparison.OrdinalIgnoreCase);
            if (realtime ? !(isHttp || isHttps || isWs || isWss) : !(isHttp || isHttps))
            {
                return false;
            }
            UriBuilder builder = new UriBuilder(parsed);
            if (realtime && (isHttp || isHttps))
            {
                builder.Scheme = isHttps ? "wss" : "ws";
            }
            if (parsed.IsDefaultPort)
            {
                builder.Port = -1;
            }
            legacyUri = parsed.AbsoluteUri;
            candidate = builder.Uri;
            return true;
        }

        private static IDictionary<string, object> ParseJsonObject(byte[] bytes, string errorCode)
        {
            if (bytes == null || bytes.Length == 0 || bytes.Length > MaximumJsonBytes)
            {
                throw Invalid(errorCode);
            }
            string json;
            try
            {
                json = new UTF8Encoding(false, true).GetString(bytes);
                if (json.Length > 0 && json[0] == '\ufeff')
                {
                    json = json.Substring(1);
                }
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaximumJsonBytes;
                serializer.RecursionLimit = MaximumJsonDepth;
                IDictionary<string, object> root = serializer.DeserializeObject(json) as IDictionary<string, object>;
                if (root == null)
                {
                    throw Invalid(errorCode);
                }
                return root;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
        }

        private static void RequireKnownFields(
            IDictionary<string, object> root,
            ISet<string> allowed,
            string errorCode)
        {
            foreach (string key in root.Keys)
            {
                if (!allowed.Contains(key))
                {
                    throw Invalid(errorCode);
                }
            }
        }

        private static string ReadInstallationId(string path)
        {
            byte[] bytes;
            if (!TryReadOptionalFile(path, out bytes, "legacy_v3_installation_id_invalid"))
            {
                throw Invalid("legacy_v3_installation_id_missing");
            }
            string value;
            try
            {
                value = new UTF8Encoding(false, true).GetString(bytes).Trim();
            }
            catch (Exception error)
            {
                throw new InvalidDataException("legacy_v3_installation_id_invalid", error);
            }
            ValidateIdentifier(value, MaximumInstallationIdLength, "legacy_v3_installation_id_invalid");
            return value;
        }

        private static bool TryReadOptionalFile(string path, out byte[] bytes, string errorCode)
        {
            bytes = null;
            FileAttributes attributes;
            if (!TryGetAttributes(path, out attributes, errorCode))
            {
                return false;
            }
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) != 0)
            {
                throw Invalid(errorCode);
            }
            FileInfo info = new FileInfo(path);
            if (info.Length <= 0 || info.Length > MaximumJsonBytes)
            {
                throw Invalid(errorCode);
            }
            try
            {
                bytes = File.ReadAllBytes(path);
                if (bytes.Length == 0 || bytes.Length > MaximumJsonBytes)
                {
                    throw Invalid(errorCode);
                }
                return true;
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
        }

        private static bool ReadOptionalRegularFileState(string path, string errorCode)
        {
            FileAttributes attributes;
            if (!TryGetAttributes(path, out attributes, errorCode))
            {
                return false;
            }
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) != 0)
            {
                throw Invalid(errorCode);
            }
            return true;
        }

        private static bool TryGetAttributes(string path, out FileAttributes attributes, string errorCode)
        {
            attributes = default(FileAttributes);
            try
            {
                attributes = File.GetAttributes(path);
                return true;
            }
            catch (FileNotFoundException)
            {
                return false;
            }
            catch (DirectoryNotFoundException)
            {
                return false;
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
        }

        private static string ReadOptionalText(IDictionary<string, object> root, string key, int maximum, string errorCode)
        {
            object value;
            if (!root.TryGetValue(key, out value) || value == null)
            {
                return null;
            }
            string text = value as string;
            if (text == null)
            {
                throw Invalid(errorCode);
            }
            ValidateText(text, maximum, errorCode);
            return text;
        }

        private static string ReadRequiredText(IDictionary<string, object> root, string key, int maximum, string errorCode)
        {
            string value = ReadOptionalText(root, key, maximum, errorCode);
            if (string.IsNullOrWhiteSpace(value))
            {
                throw Invalid(errorCode);
            }
            return value;
        }

        private static string ReadOptionalPath(IDictionary<string, object> root, string key, string errorCode)
        {
            string value = ReadOptionalText(root, key, MaximumTerminalPathLength, errorCode);
            if (value != null && !Path.IsPathRooted(value))
            {
                throw Invalid(errorCode);
            }
            return value;
        }

        private static bool? ReadOptionalBoolean(IDictionary<string, object> root, string key, string errorCode)
        {
            object value;
            if (!root.TryGetValue(key, out value) || value == null)
            {
                return null;
            }
            if (!(value is bool))
            {
                throw Invalid(errorCode);
            }
            return (bool)value;
        }

        private static long? ReadOptionalPositiveInt64(IDictionary<string, object> root, string key, string errorCode)
        {
            object value;
            if (!root.TryGetValue(key, out value) || value == null)
            {
                return null;
            }
            long number = ReadInt64(value, errorCode);
            if (number <= 0)
            {
                throw Invalid(errorCode);
            }
            return number;
        }

        private static long ReadInt64(object value, string errorCode)
        {
            try
            {
                if (value is decimal)
                {
                    decimal decimalValue = (decimal)value;
                    if (decimal.Truncate(decimalValue) != decimalValue
                        || decimalValue < long.MinValue || decimalValue > long.MaxValue)
                    {
                        throw Invalid(errorCode);
                    }
                    return (long)decimalValue;
                }
                if (value is double || value is float)
                {
                    double doubleValue = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                    if (double.IsNaN(doubleValue) || double.IsInfinity(doubleValue)
                        || Math.Truncate(doubleValue) != doubleValue
                        || doubleValue < long.MinValue || doubleValue > long.MaxValue)
                    {
                        throw Invalid(errorCode);
                    }
                }
                if (!(value is byte) && !(value is sbyte) && !(value is short) && !(value is ushort)
                    && !(value is int) && !(value is uint) && !(value is long) && !(value is ulong)
                    && !(value is double) && !(value is float))
                {
                    throw Invalid(errorCode);
                }
                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
        }

        private static string ReadColumnText(SQLiteDataReader reader, int ordinal, int maximum, string errorCode)
        {
            if (reader.IsDBNull(ordinal))
            {
                throw Invalid(errorCode);
            }
            string value = reader.GetValue(ordinal) as string;
            if (value == null)
            {
                throw Invalid(errorCode);
            }
            ValidateText(value, maximum, errorCode);
            return value;
        }

        private static long ReadColumnInt64(SQLiteDataReader reader, int ordinal, string errorCode)
        {
            if (reader.IsDBNull(ordinal))
            {
                throw Invalid(errorCode);
            }
            return ReadInt64(reader.GetValue(ordinal), errorCode);
        }

        private static bool SameBinding(LegacyTerminalBindingSnapshot first, LegacyTerminalBindingSnapshot second)
        {
            return string.Equals(first.TerminalInstanceId, second.TerminalInstanceId, StringComparison.OrdinalIgnoreCase)
                && string.Equals(first.Platform, second.Platform, StringComparison.OrdinalIgnoreCase)
                && string.Equals(first.TerminalPath, second.TerminalPath, StringComparison.Ordinal)
                && string.Equals(first.BrokerServer, second.BrokerServer, StringComparison.Ordinal)
                && string.Equals(first.Login, second.Login, StringComparison.Ordinal)
                && first.ConnectionEpoch == second.ConnectionEpoch
                && first.UpdatedAtUtcMsc == second.UpdatedAtUtcMsc;
        }

        private static string BuildSourceFingerprint(
            string installRoot,
            string dataRoot,
            IList<FingerprintSource> sources)
        {
            using (SHA256 hash = SHA256.Create())
            {
                TransformText(hash, "install_root\n" + installRoot + "\n");
                TransformText(hash, "data_root\n" + dataRoot + "\n");
                FingerprintSource[] sortedSources = SortSources(sources);
                for (int index = 0; index < sortedSources.Length; index++)
                {
                    FingerprintSource source = sortedSources[index];
                    TransformText(hash, source.Label + "\n" + source.Path + "\n" + (source.Exists ? "present\n" : "missing\n"));
                    if (source.Bytes != null)
                    {
                        TransformBytes(hash, source.Bytes);
                    }
                    else
                    {
                        TransformText(hash, "length=" + source.LengthBytes.ToString(CultureInfo.InvariantCulture) + "\n");
                        TransformText(hash, "last_write_utc_ticks=" + source.LastWriteUtcTicks.ToString(CultureInfo.InvariantCulture) + "\n");
                        if (source.Semantic != null)
                        {
                            TransformText(hash, source.Semantic);
                        }
                    }
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                byte[] digest = hash.Hash;
                if (digest == null)
                {
                    throw Invalid("legacy_v3_fingerprint_failed");
                }
                StringBuilder hex = new StringBuilder(digest.Length * 2);
                for (int index = 0; index < digest.Length; index++)
                {
                    hex.Append(digest[index].ToString("x2", CultureInfo.InvariantCulture));
                }
                return "sha256:" + hex.ToString();
            }
        }

        private static void TransformText(SHA256 hash, string value)
        {
            TransformBytes(hash, Encoding.UTF8.GetBytes(value));
        }

        private static void TransformBytes(SHA256 hash, byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0)
            {
                return;
            }
            hash.TransformBlock(bytes, 0, bytes.Length, bytes, 0);
        }

        private static FingerprintSource[] SortSources(IList<FingerprintSource> sources)
        {
            List<FingerprintSource> sorted = new List<FingerprintSource>(sources);
            sorted.Sort(delegate(FingerprintSource first, FingerprintSource second)
            {
                int labelComparison = StringComparer.Ordinal.Compare(first.Label, second.Label);
                return labelComparison != 0
                    ? labelComparison
                    : StringComparer.Ordinal.Compare(first.Path, second.Path);
            });
            return sorted.ToArray();
        }

        private static string NormalizeRoot(string value, string errorCode)
        {
            if (string.IsNullOrWhiteSpace(value) || value.IndexOf('%') >= 0 || !Path.IsPathRooted(value))
            {
                throw Invalid(errorCode);
            }
            string fullPath;
            try
            {
                fullPath = TrimTrailingSeparators(Path.GetFullPath(value));
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
            EnsureDirectory(fullPath, errorCode);
            return fullPath;
        }

        private static string NormalizeDestination(string value, string installRoot, string dataRoot)
        {
            if (string.IsNullOrWhiteSpace(value) || value.IndexOf('%') >= 0 || !Path.IsPathRooted(value))
            {
                throw Invalid("legacy_v3_snapshot_path_invalid");
            }
            string path;
            try
            {
                path = Path.GetFullPath(value);
            }
            catch (Exception error)
            {
                throw new InvalidDataException("legacy_v3_snapshot_path_invalid", error);
            }
            if (IsInside(path, installRoot) || IsInside(path, dataRoot))
            {
                throw Invalid("legacy_v3_snapshot_writes_source");
            }
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw Invalid("legacy_v3_snapshot_reparse_point");
            }
            return path;
        }

        private static void EnsureNoReparseAncestor(string directory)
        {
            string current = Path.GetFullPath(directory);
            while (!string.IsNullOrEmpty(current))
            {
                if (Directory.Exists(current))
                {
                    FileAttributes attributes = File.GetAttributes(current);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                    {
                        throw Invalid("legacy_v3_snapshot_reparse_point");
                    }
                }
                DirectoryInfo parent = Directory.GetParent(current);
                if (parent == null)
                {
                    break;
                }
                current = parent.FullName;
            }
        }

        private static string CombineInside(string root, string child, string errorCode)
        {
            if (string.IsNullOrWhiteSpace(child) || child.IndexOf('%') >= 0 || Path.IsPathRooted(child))
            {
                throw Invalid(errorCode);
            }
            string combined;
            try
            {
                combined = Path.GetFullPath(Path.Combine(root, child));
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
            if (!IsInside(combined, root))
            {
                throw Invalid(errorCode);
            }
            return combined;
        }

        private static bool IsInside(string candidate, string root)
        {
            string normalizedCandidate = TrimTrailingSeparators(candidate);
            string normalizedRoot = TrimTrailingSeparators(root);
            string rootPrefix = normalizedRoot.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                || normalizedRoot.EndsWith(Path.AltDirectorySeparatorChar.ToString(), StringComparison.Ordinal)
                ? normalizedRoot
                : normalizedRoot + Path.DirectorySeparatorChar;
            return string.Equals(normalizedCandidate, normalizedRoot, StringComparison.OrdinalIgnoreCase)
                || normalizedCandidate.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase);
        }

        private static string TrimTrailingSeparators(string value)
        {
            string result = value;
            while (result.Length > 3 && (result[result.Length - 1] == Path.DirectorySeparatorChar || result[result.Length - 1] == Path.AltDirectorySeparatorChar))
            {
                result = result.Substring(0, result.Length - 1);
            }
            return result;
        }

        private static void EnsureDirectory(string path, string errorCode)
        {
            if (!Directory.Exists(path))
            {
                throw Invalid(errorCode);
            }
            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
                {
                    throw Invalid(errorCode);
                }
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new InvalidDataException(errorCode, error);
            }
        }

        private static void ValidateProfileId(string value)
        {
            ValidateIdentifier(value, MaximumProfileIdLength, "legacy_v3_profile_id_invalid");
        }

        private static void ValidateIdentifier(string value, int maximum, string errorCode)
        {
            ValidateText(value, maximum, errorCode);
            if (!IsAsciiAlphaNumeric(value[0])) throw Invalid(errorCode);
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (!IsAsciiAlphaNumeric(current) && current != '-' && current != '_' && current != '.')
                {
                    throw Invalid(errorCode);
                }
            }
        }

        private static bool IsAsciiAlphaNumeric(char value)
        {
            return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
                || (value >= '0' && value <= '9');
        }

        private static void ValidateText(string value, int maximum, string errorCode)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximum
                || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0 || value.IndexOf('\0') >= 0)
            {
                throw Invalid(errorCode);
            }
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }

        private static long UtcNowMilliseconds()
        {
            return (DateTime.UtcNow.Ticks - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks)
                / TimeSpan.TicksPerMillisecond;
        }

        private sealed class FingerprintSource
        {
            public string Label;
            public string Path;
            public bool Exists;
            public byte[] Bytes;
            public long LengthBytes;
            public long LastWriteUtcTicks;
            public string Semantic;

            public static FingerprintSource ForFile(string label, string path, bool exists)
            {
                return new FingerprintSource { Label = label, Path = path, Exists = exists };
            }

            public static FingerprintSource ForBytes(string label, string path, byte[] bytes)
            {
                return new FingerprintSource { Label = label, Path = path, Exists = true, Bytes = bytes };
            }

            public static FingerprintSource ForMetadata(string label, string path, bool exists)
            {
                FingerprintSource source = new FingerprintSource { Label = label, Path = path, Exists = exists };
                if (exists)
                {
                    try
                    {
                        FileInfo info = new FileInfo(path);
                        source.LengthBytes = info.Length;
                        source.LastWriteUtcTicks = info.LastWriteTimeUtc.Ticks;
                    }
                    catch (Exception error)
                    {
                        throw new InvalidDataException("legacy_v3_fingerprint_metadata_failed", error);
                    }
                }
                return source;
            }

            public static FingerprintSource ForSemantic(string label, string path, string semantic)
            {
                return new FingerprintSource { Label = label, Path = path, Exists = true, Semantic = semantic };
            }

            public static FingerprintSource ForBindings(
                string label,
                string path,
                IList<LegacyTerminalBindingSnapshot> bindings)
            {
                StringBuilder value = new StringBuilder();
                for (int index = 0; index < bindings.Count; index++)
                {
                    LegacyTerminalBindingSnapshot binding = bindings[index];
                    AppendField(value, binding.TerminalInstanceId);
                    AppendField(value, binding.Platform);
                    AppendField(value, binding.TerminalPath);
                    AppendField(value, binding.BrokerServer);
                    AppendField(value, binding.Login);
                    AppendField(value, binding.ConnectionEpoch.ToString(CultureInfo.InvariantCulture));
                    AppendField(value, binding.UpdatedAtUtcMsc.ToString(CultureInfo.InvariantCulture));
                }
                FingerprintSource source = ForMetadata(label, path, true);
                source.Semantic = value.ToString();
                return source;
            }

            private static void AppendField(StringBuilder target, string value)
            {
                string safe = value ?? string.Empty;
                target.Append(safe.Length.ToString(CultureInfo.InvariantCulture));
                target.Append(':');
                target.Append(safe);
                target.Append(';');
            }
        }
    }

}
