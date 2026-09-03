using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Liangjian.BridgeV4.Update
{
    /// <summary>
    /// The signed release contract shared with the previous Bridge updater.
    /// The bridge only trusts schema version 2; policy decisions remain on the
    /// server and the launcher owns process activation.
    /// </summary>
    public sealed class ReleaseManifest
    {
        public int SchemaVersion { get; set; }
        public string ReleaseVersion { get; set; }
        public string ReleaseId { get; set; }
        public long GeneratedAtUtcMsc { get; set; }
        public long? PublishedAtUtcMsc { get; set; }
        public long? ExpiresAtUtcMsc { get; set; }
        public string Priority { get; set; }
        public string MinimumLauncherVersion { get; set; }
        public uint? MinimumIdleSeconds { get; set; }
        public long? ActivationDeadlineUtcMsc { get; set; }
        public string RolloutChannel { get; set; }
        public uint? RolloutPercentage { get; set; }
        public IList<ReleasePackage> Packages { get; set; }
        public string Signature { get; set; }

        public ReleaseManifest()
        {
            Packages = new List<ReleasePackage>();
        }
    }

    public sealed class ReleasePackage
    {
        public string ModuleId { get; set; }
        public string Version { get; set; }
        public string Url { get; set; }
        public long SizeBytes { get; set; }
        public string Sha256 { get; set; }
        public string Signature { get; set; }
        public string MinimumCoreVersion { get; set; }
        public string MaximumCoreVersion { get; set; }
    }

    public static class ReleaseManifestParser
    {
        public const int MaximumManifestBytes = 128 * 1024;
        private static readonly HashSet<string> ManifestFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "schema_version", "release_version", "release_id", "generated_at_utc_msc",
            "published_at_utc_msc", "expires_at_utc_msc", "priority", "minimum_launcher_version",
            "minimum_idle_seconds", "activation_deadline_utc_msc", "rollout_channel",
            "rollout_percentage", "packages", "signature"
        };

        private static readonly HashSet<string> PackageFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "module_id", "version", "url", "size_bytes", "sha256", "signature",
            "minimum_core_version", "maximum_core_version"
        };

        public static ReleaseManifest Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json) || Encoding.UTF8.GetByteCount(json) > MaximumManifestBytes)
            {
                throw Invalid("update_manifest_too_large");
            }

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumManifestBytes;
            IDictionary<string, object> root;
            try
            {
                root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                throw Invalid("update_manifest_invalid");
            }
            catch (InvalidOperationException)
            {
                throw Invalid("update_manifest_invalid");
            }
            if (root == null)
            {
                throw Invalid("update_manifest_invalid");
            }
            RejectUnknown(root, ManifestFields, "update_manifest_unknown_field");
            RequireFields(root, new[]
            {
                "schema_version", "release_version", "release_id", "generated_at_utc_msc",
                "published_at_utc_msc", "expires_at_utc_msc", "priority", "minimum_launcher_version",
                "packages", "signature", "rollout_channel", "rollout_percentage"
            }, "update_manifest_invalid");

            ReleaseManifest manifest = new ReleaseManifest();
            manifest.SchemaVersion = ReadInt(root, "schema_version", false);
            manifest.ReleaseVersion = ReadText(root, "release_version", 64, false);
            manifest.ReleaseId = ReadText(root, "release_id", 128, true);
            manifest.GeneratedAtUtcMsc = ReadLong(root, "generated_at_utc_msc", false);
            manifest.PublishedAtUtcMsc = ReadNullableLong(root, "published_at_utc_msc");
            manifest.ExpiresAtUtcMsc = ReadNullableLong(root, "expires_at_utc_msc");
            manifest.Priority = ReadText(root, "priority", 16, true);
            manifest.MinimumLauncherVersion = ReadText(root, "minimum_launcher_version", 64, false);
            manifest.MinimumIdleSeconds = ReadNullableUInt(root, "minimum_idle_seconds");
            manifest.ActivationDeadlineUtcMsc = ReadNullableLong(root, "activation_deadline_utc_msc");
            manifest.RolloutChannel = ReadText(root, "rollout_channel", 16, true);
            manifest.RolloutPercentage = ReadNullableUInt(root, "rollout_percentage");
            manifest.Signature = ReadText(root, "signature", 1024, false);

            object packagesValue;
            if (!root.TryGetValue("packages", out packagesValue) || packagesValue == null)
            {
                throw Invalid("update_manifest_package_invalid");
            }
            IEnumerable packages = packagesValue as IEnumerable;
            if (packages == null || packagesValue is string)
            {
                throw Invalid("update_manifest_package_invalid");
            }
            foreach (object packageValue in packages)
            {
                IDictionary<string, object> packageObject = packageValue as IDictionary<string, object>;
                if (packageObject == null)
                {
                    throw Invalid("update_manifest_package_invalid");
                }
                RejectUnknown(packageObject, PackageFields, "update_manifest_package_unknown_field");
                RequireFields(packageObject, new[]
                {
                    "module_id", "version", "url", "size_bytes", "sha256", "signature"
                }, "update_manifest_package_invalid");
                ReleasePackage package = new ReleasePackage
                {
                    ModuleId = ReadText(packageObject, "module_id", 64, false),
                    Version = ReadText(packageObject, "version", 64, false),
                    Url = ReadText(packageObject, "url", 2048, false),
                    SizeBytes = ReadLong(packageObject, "size_bytes", false),
                    Sha256 = ReadText(packageObject, "sha256", 128, false),
                    Signature = ReadText(packageObject, "signature", 1024, false),
                    MinimumCoreVersion = ReadNullableText(packageObject, "minimum_core_version", 64),
                    MaximumCoreVersion = ReadNullableText(packageObject, "maximum_core_version", 64)
                };
                manifest.Packages.Add(package);
            }
            return manifest;
        }

        private static void RejectUnknown(IDictionary<string, object> values, HashSet<string> allowed, string code)
        {
            foreach (string key in values.Keys)
            {
                if (!allowed.Contains(key))
                {
                    throw Invalid(code);
                }
            }
        }

        private static void RequireFields(IDictionary<string, object> values, string[] required, string code)
        {
            foreach (string key in required)
            {
                if (!values.ContainsKey(key))
                {
                    throw Invalid(code);
                }
            }
        }

        private static string ReadText(IDictionary<string, object> values, string key, int max, bool allowNull)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                if (allowNull)
                {
                    return null;
                }
                throw Invalid("update_manifest_invalid");
            }
            string value = raw as string;
            if (value == null || value.Length == 0 || value.Length > max)
            {
                throw Invalid("update_manifest_invalid");
            }
            return value;
        }

        private static string ReadNullableText(IDictionary<string, object> values, string key, int max)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return null;
            }
            string value = raw as string;
            if (value == null || value.Length == 0 || value.Length > max)
            {
                throw Invalid("update_manifest_package_invalid");
            }
            return value;
        }

        private static int ReadInt(IDictionary<string, object> values, string key, bool allowNull)
        {
            long value = ReadNumber(values, key, allowNull);
            if (value < int.MinValue || value > int.MaxValue)
            {
                throw Invalid("update_manifest_invalid");
            }
            return (int)value;
        }

        private static long ReadLong(IDictionary<string, object> values, string key, bool allowNull)
        {
            return ReadNumber(values, key, allowNull);
        }

        private static long? ReadNullableLong(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return null;
            }
            return ReadNumber(values, key, false);
        }

        private static uint? ReadNullableUInt(IDictionary<string, object> values, string key)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                return null;
            }
            long value = ReadNumber(values, key, false);
            if (value < 0 || value > uint.MaxValue)
            {
                throw Invalid("update_manifest_invalid");
            }
            return (uint)value;
        }

        private static long ReadNumber(IDictionary<string, object> values, string key, bool allowNull)
        {
            object raw;
            if (!values.TryGetValue(key, out raw) || raw == null)
            {
                if (allowNull)
                {
                    return 0;
                }
                throw Invalid("update_manifest_invalid");
            }
            try
            {
                if (raw is int) return (int)raw;
                if (raw is long) return (long)raw;
                if (raw is short) return (short)raw;
                if (raw is byte) return (byte)raw;
                if (raw is decimal)
                {
                    decimal decimalValue = (decimal)raw;
                    if (decimal.Truncate(decimalValue) != decimalValue) throw Invalid("update_manifest_invalid");
                    return checked(decimal.ToInt64(decimalValue));
                }
                if (raw is double)
                {
                    double doubleValue = (double)raw;
                    if (double.IsNaN(doubleValue) || double.IsInfinity(doubleValue) || Math.Truncate(doubleValue) != doubleValue) throw Invalid("update_manifest_invalid");
                    return checked((long)doubleValue);
                }
                if (raw is float)
                {
                    float floatValue = (float)raw;
                    if (float.IsNaN(floatValue) || float.IsInfinity(floatValue) || Math.Truncate(floatValue) != floatValue) throw Invalid("update_manifest_invalid");
                    return checked((long)floatValue);
                }
            }
            catch (OverflowException)
            {
                throw Invalid("update_manifest_invalid");
            }
            throw Invalid("update_manifest_invalid");
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }
    }

    public sealed class ReleaseManifestVerifier : IDisposable
    {
        private readonly ReleaseSignatureVerifier verifier;
        private readonly Func<long> clock;
        private readonly object gate = new object();
        private bool disposed;

        public ReleaseManifestVerifier(string subjectPublicKeyPem)
            : this(subjectPublicKeyPem, null)
        {
        }

        public ReleaseManifestVerifier(string subjectPublicKeyPem, Func<long> nowUtcMsc)
        {
            if (string.IsNullOrWhiteSpace(subjectPublicKeyPem) || subjectPublicKeyPem.Length > 16 * 1024)
            {
                throw Invalid("update_public_key_invalid");
            }
            verifier = new ReleaseSignatureVerifier(subjectPublicKeyPem);
            clock = nowUtcMsc ?? CurrentUtcMsc;
        }

        internal ReleaseManifestVerifier(byte[] eccPublicBlob, Func<long> nowUtcMsc)
        {
            verifier = new ReleaseSignatureVerifier(eccPublicBlob);
            clock = nowUtcMsc ?? CurrentUtcMsc;
        }

        internal static ReleaseManifestVerifier FromEccPublicBlob(byte[] eccPublicBlob, Func<long> nowUtcMsc)
        {
            return new ReleaseManifestVerifier(eccPublicBlob, nowUtcMsc);
        }

        public void Verify(ReleaseManifest manifest, string launcherVersion)
        {
            if (manifest == null)
            {
                throw Invalid("update_manifest_invalid");
            }
            ValidateManifest(manifest, launcherVersion, clock());
            VerifySignature(manifest.Signature, CanonicalizeManifest(manifest), "update_manifest_signature_invalid");
            foreach (ReleasePackage package in manifest.Packages)
            {
                VerifySignature(package.Signature, CanonicalizePackage(package), "update_package_signature_invalid");
            }
        }

        public ReleaseManifest VerifyJson(string json, string launcherVersion)
        {
            ReleaseManifest manifest = ReleaseManifestParser.Parse(json);
            Verify(manifest, launcherVersion);
            return manifest;
        }

        public static string CanonicalizeManifest(ReleaseManifest manifest)
        {
            if (manifest == null || manifest.SchemaVersion != 2 || manifest.Packages == null)
            {
                throw Invalid("update_manifest_schema_unsupported");
            }
            StringBuilder value = new StringBuilder();
            value.Append("AURUM-RELEASE-V2\n");
            value.Append(manifest.SchemaVersion.ToString(CultureInfo.InvariantCulture)).Append('\n');
            value.Append(manifest.ReleaseId ?? string.Empty).Append('\n');
            value.Append(manifest.ReleaseVersion ?? string.Empty).Append('\n');
            value.Append(manifest.GeneratedAtUtcMsc.ToString(CultureInfo.InvariantCulture)).Append('\n');
            value.Append(Display(manifest.PublishedAtUtcMsc)).Append('\n');
            value.Append(Display(manifest.ExpiresAtUtcMsc)).Append('\n');
            value.Append(manifest.Priority ?? string.Empty).Append('\n');
            value.Append(manifest.MinimumLauncherVersion ?? string.Empty).Append('\n');
            value.Append(Display(manifest.MinimumIdleSeconds)).Append('\n');
            value.Append(Display(manifest.ActivationDeadlineUtcMsc)).Append('\n');
            value.Append(manifest.RolloutChannel ?? string.Empty).Append('\n');
            value.Append(Display(manifest.RolloutPercentage)).Append('\n');

            List<ReleasePackage> packages = new List<ReleasePackage>(manifest.Packages);
            packages.Sort(delegate(ReleasePackage left, ReleasePackage right)
            {
                return StringComparer.Ordinal.Compare(left.ModuleId, right.ModuleId);
            });
            foreach (ReleasePackage package in packages)
            {
                value.Append(package.ModuleId ?? string.Empty).Append('|');
                value.Append(package.Version ?? string.Empty).Append('|');
                value.Append(package.Url ?? string.Empty).Append('|');
                value.Append(package.SizeBytes.ToString(CultureInfo.InvariantCulture)).Append('|');
                value.Append((package.Sha256 ?? string.Empty).ToLowerInvariant()).Append('|');
                value.Append(package.Signature ?? string.Empty).Append('|');
                value.Append(package.MinimumCoreVersion ?? string.Empty).Append('|');
                value.Append(package.MaximumCoreVersion ?? string.Empty).Append('\n');
            }
            return value.ToString();
        }

        public static string CanonicalizePackage(ReleasePackage package)
        {
            if (package == null)
            {
                throw Invalid("update_manifest_package_invalid");
            }
            return string.Concat(
                "AURUM-PACKAGE-V1\n",
                package.ModuleId ?? string.Empty, "\n",
                package.Version ?? string.Empty, "\n",
                package.Url ?? string.Empty, "\n",
                package.SizeBytes.ToString(CultureInfo.InvariantCulture), "\n",
                (package.Sha256 ?? string.Empty).ToLowerInvariant(), "\n",
                package.MinimumCoreVersion ?? string.Empty, "\n",
                package.MaximumCoreVersion ?? string.Empty, "\n");
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed)
                {
                    return;
                }
                disposed = true;
                verifier.Dispose();
            }
        }

        private void VerifySignature(string text, string canonical, string code)
        {
            byte[] signature = DecodeSignature(text, code);
            bool valid;
            lock (gate)
            {
                if (disposed)
                {
                    throw new ObjectDisposedException("ReleaseManifestVerifier");
                }
                valid = verifier.Verify(Encoding.UTF8.GetBytes(canonical), signature);
            }
            if (!valid)
            {
                throw Invalid(code);
            }
        }

        private static void ValidateManifest(ReleaseManifest manifest, string launcherVersion, long nowUtcMsc)
        {
            DotNetVersion launcher = DotNetVersion.Parse(launcherVersion);
            DotNetVersion minimumLauncher = DotNetVersion.Parse(manifest.MinimumLauncherVersion);
            if (manifest.SchemaVersion != 2
                || DotNetVersion.Parse(manifest.ReleaseVersion) == null
                || manifest.GeneratedAtUtcMsc <= 0
                || launcher == null
                || minimumLauncher == null
                || launcher.CompareTo(minimumLauncher) < 0
                || manifest.Packages == null
                || manifest.Packages.Count < 1
                || manifest.Packages.Count > 16
                || !ValidSignatureText(manifest.Signature)
                || !ValidReleaseId(manifest.ReleaseId)
                || (manifest.Priority != "normal" && manifest.Priority != "urgent")
                || !manifest.PublishedAtUtcMsc.HasValue
                || manifest.PublishedAtUtcMsc.Value <= 0
                || !manifest.ExpiresAtUtcMsc.HasValue
                || manifest.ExpiresAtUtcMsc.Value <= 0
                || manifest.ExpiresAtUtcMsc.Value <= manifest.PublishedAtUtcMsc.Value
                || manifest.ExpiresAtUtcMsc.Value <= nowUtcMsc
                || manifest.GeneratedAtUtcMsc > manifest.ExpiresAtUtcMsc.Value
                || !manifest.MinimumIdleSeconds.HasValue
                || manifest.MinimumIdleSeconds.Value < 30
                || manifest.MinimumIdleSeconds.Value > 3600
                || (manifest.ActivationDeadlineUtcMsc.HasValue && (manifest.ActivationDeadlineUtcMsc.Value <= manifest.PublishedAtUtcMsc.Value || manifest.ActivationDeadlineUtcMsc.Value > manifest.ExpiresAtUtcMsc.Value))
                || (manifest.RolloutChannel != "internal" && manifest.RolloutChannel != "stable")
                || !manifest.RolloutPercentage.HasValue
                || manifest.RolloutPercentage.Value < 1
                || manifest.RolloutPercentage.Value > 100)
            {
                throw Invalid("update_manifest_invalid");
            }

            HashSet<string> modules = new HashSet<string>(StringComparer.Ordinal);
            foreach (ReleasePackage package in manifest.Packages)
            {
                if (!ValidatePackage(package) || !modules.Add(package.ModuleId))
                {
                    throw Invalid("update_manifest_package_invalid");
                }
            }
        }

        internal static bool ValidatePackage(ReleasePackage package)
        {
            if (package == null || package.ModuleId == null || package.Version == null || package.Url == null
                || package.Sha256 == null || package.Signature == null)
            {
                return false;
            }
            if (package.ModuleId != "core" && package.ModuleId != "adapter.mt5.python"
                && package.ModuleId != "adapter.mt4" && package.ModuleId != "data.symbol-map")
            {
                return false;
            }
            if (DotNetVersion.Parse(package.Version) == null || package.SizeBytes < 1
                || package.SizeBytes > 512L * 1024L * 1024L || !ValidSha256(package.Sha256)
                || !ValidSignatureText(package.Signature) || !ValidPackageUrl(package.Url))
            {
                return false;
            }
            return (package.MinimumCoreVersion == null || DotNetVersion.Parse(package.MinimumCoreVersion) != null)
                && (package.MaximumCoreVersion == null || DotNetVersion.Parse(package.MaximumCoreVersion) != null);
        }

        internal static bool ValidSha256(string value)
        {
            if (value == null || value.Length != 64)
            {
                return false;
            }
            foreach (char character in value)
            {
                if (!(character >= '0' && character <= '9')
                    && !(character >= 'a' && character <= 'f')
                    && !(character >= 'A' && character <= 'F'))
                {
                    return false;
                }
            }
            return true;
        }

        internal static bool ValidPackageUrl(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.UserInfo.Length != 0 || uri.Host.Length == 0)
            {
                return false;
            }
            if (uri.Scheme == Uri.UriSchemeHttps)
            {
                return true;
            }
            return uri.Scheme == Uri.UriSchemeHttp
                && (uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "::1");
        }

        internal static bool ValidSignatureText(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && value.Length <= 1024;
        }

        private static bool ValidReleaseId(string value)
        {
            if (value == null || value.Length < 8 || value.Length > 128)
            {
                return false;
            }
            foreach (char character in value)
            {
                if (!(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z')
                    && !(character >= '0' && character <= '9') && character != '.' && character != '_'
                    && character != ':' && character != '-')
                {
                    return false;
                }
            }
            return true;
        }

        private static byte[] DecodeSignature(string value, string code)
        {
            if (!ValidSignatureText(value))
            {
                throw Invalid(code);
            }
            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(value);
            }
            catch (FormatException)
            {
                throw Invalid(code);
            }
            if (bytes.Length != 64)
            {
                throw Invalid(code);
            }
            return bytes;
        }

        private static string Display(object value)
        {
            if (value == null) return string.Empty;
            IFormattable formattable = value as IFormattable;
            return formattable == null ? value.ToString() : formattable.ToString(null, CultureInfo.InvariantCulture);
        }

        private static long CurrentUtcMsc()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }

        private sealed class DotNetVersion : IComparable<DotNetVersion>
        {
            private readonly int[] parts;

            private DotNetVersion(int[] value)
            {
                parts = value;
            }

            public static DotNetVersion Parse(string value)
            {
                if (string.IsNullOrEmpty(value)) return null;
                string[] components = value.Split('.');
                if (components.Length < 2 || components.Length > 4) return null;
                int[] result = new int[4] { -1, -1, -1, -1 };
                for (int index = 0; index < components.Length; index++)
                {
                    if (components[index].Length == 0) return null;
                    int parsed;
                    if (!int.TryParse(components[index], NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || parsed < 0)
                    {
                        return null;
                    }
                    result[index] = parsed;
                }
                return new DotNetVersion(result);
            }

            public int CompareTo(DotNetVersion other)
            {
                for (int index = 0; index < parts.Length; index++)
                {
                    if (parts[index] < other.parts[index]) return -1;
                    if (parts[index] > other.parts[index]) return 1;
                }
                return 0;
            }
        }
    }
}
