using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Liangjian.BridgeV4.Configuration;

namespace Liangjian.BridgeV4.Migration
{
    public sealed class BridgeProfileRuntimePaths
    {
        public string PythonExecutablePath { get; set; }
        public string WorkerScriptPath { get; set; }
    }

    public interface ILegacyV3RuntimePathProvider
    {
        BridgeProfileRuntimePaths Resolve(LegacyV3ProfileSnapshot profile);
    }

    public sealed class DelegateRuntimePathProvider : ILegacyV3RuntimePathProvider
    {
        private readonly Func<LegacyV3ProfileSnapshot, BridgeProfileRuntimePaths> resolver;

        public DelegateRuntimePathProvider(Func<LegacyV3ProfileSnapshot, BridgeProfileRuntimePaths> resolverValue)
        {
            if (resolverValue == null) throw new ArgumentNullException("resolverValue");
            resolver = resolverValue;
        }

        public BridgeProfileRuntimePaths Resolve(LegacyV3ProfileSnapshot profile)
        {
            return resolver(profile);
        }
    }

    public sealed class LegacyV3MigrationImportResult
    {
        public int ImportedProfileCount { get; internal set; }
        public string InstallationId { get; internal set; }
        public IList<string> ProfileIds { get; internal set; }
    }

    /// <summary>
    /// Completes the local half of V3 migration. Every exchange is completed
    /// before the destination catalog is changed, so a failed later profile
    /// leaves the existing profiles.json byte-for-byte untouched.
    /// </summary>
    public sealed class LegacyV3ProfileImporter
    {
        private readonly BridgeProfileStore store;
        private readonly ILegacyV3RuntimePathProvider runtimePaths;

        public LegacyV3ProfileImporter(BridgeProfileStore storeValue,
            ILegacyV3RuntimePathProvider runtimePathsValue)
        {
            if (storeValue == null) throw new ArgumentNullException("storeValue");
            if (runtimePathsValue == null) throw new ArgumentNullException("runtimePathsValue");
            store = storeValue;
            runtimePaths = runtimePathsValue;
        }

        public LegacyV3MigrationImportResult Import(LegacyV3MigrationSnapshot snapshot,
            IBridgeV4CredentialExchangeClient exchangeClient)
        {
            ValidateSnapshot(snapshot);
            if (exchangeClient == null) throw new ArgumentNullException("exchangeClient");

            Uri control = BridgeV4EndpointPolicy.ValidateControlUri(
                snapshot.EndpointOverride.CandidateControlUri);
            Uri realtime = BridgeV4EndpointPolicy.ValidateRealtimeUri(
                snapshot.EndpointOverride.CandidateRealtimeUri);
            BridgeV4EndpointPolicy.ValidateHostPair(control, realtime);
            BridgeProfileCatalog existing = store.LoadOrCreate();
            if (File.Exists(store.FilePath))
            {
                if (!string.Equals(existing.InstallationId, snapshot.LegacyInstallationId,
                    StringComparison.Ordinal))
                {
                    throw Invalid("bridge_v3_installation_id_mismatch");
                }
            }
            else
            {
                existing.InstallationId = snapshot.LegacyInstallationId;
            }
            List<BridgeProfileSettings> imported = new List<BridgeProfileSettings>();
            List<string> profileIds = new List<string>();

            for (int index = 0; index < snapshot.Profiles.Count; index++)
            {
                LegacyV3ProfileSnapshot source = snapshot.Profiles[index];
                BridgeProfileSettings profile = ImportProfile(snapshot, source, existing.InstallationId,
                    control, realtime, exchangeClient);
                imported.Add(profile);
                profileIds.Add(profile.ProfileId);
            }

            // No target object was mutated before the last profile completed.
            // Save itself uses BridgeProfileStore's temp + replace protocol.
            existing.Profiles = imported;
            store.Save(existing);
            return new LegacyV3MigrationImportResult
            {
                ImportedProfileCount = imported.Count,
                InstallationId = existing.InstallationId,
                ProfileIds = profileIds
            };
        }

        private BridgeProfileSettings ImportProfile(LegacyV3MigrationSnapshot snapshot,
            LegacyV3ProfileSnapshot source, string installationId, Uri control, Uri realtime,
            IBridgeV4CredentialExchangeClient exchangeClient)
        {
            if (source == null || source.Preferences == null || !source.CredentialFilePresent
                || !source.CredentialExchangeRequired)
            {
                throw Invalid("bridge_v3_profile_not_migratable");
            }
            LegacyTerminalBindingSnapshot binding = SelectBinding(source);
            string credentialPath = CredentialPath(snapshot, source);
            BridgeV4CredentialExchangeResult exchange;
            using (LegacyV3RefreshCredential credential = LegacyV3CredentialReader.Read(
                credentialPath, UtcNowMilliseconds()))
            {
                BridgeV4CredentialExchangeRequest request = new BridgeV4CredentialExchangeRequest
                {
                    schema_version = 1,
                    legacy_refresh_token = credential.RefreshToken,
                    installation_id = installationId,
                    profile_id = source.ProfileId,
                    source_fingerprint = snapshot.SourceFingerprint
                };
                try
                {
                    exchange = exchangeClient.Exchange(request, control.AbsoluteUri, realtime.AbsoluteUri);
                }
                catch (InvalidDataException)
                {
                    // Exchange implementations must not propagate response
                    // bodies or request tokens through their errors.
                    throw Invalid("bridge_v4_credential_exchange_failed");
                }
                catch (Exception)
                {
                    throw Invalid("bridge_v4_credential_exchange_failed");
                }
                finally
                {
                    request.legacy_refresh_token = null;
                }
            }
            ValidateExchange(exchange, realtime);

            string platform = binding.Platform.ToLowerInvariant();
            BridgeProfileRuntimePaths paths = runtimePaths.Resolve(source);
            if (paths == null) paths = new BridgeProfileRuntimePaths();
            if (platform == "mt5") ValidateMt5Paths(paths);
            string displayName = DisplayName(source, binding);
            BridgeProfileSettings profile = new BridgeProfileSettings
            {
                ProfileId = source.ProfileId,
                DisplayName = displayName,
                Platform = platform,
                TerminalInstanceId = binding.TerminalInstanceId,
                BrokerServer = binding.BrokerServer,
                Login = binding.Login,
                ServerUri = BridgeV4EndpointPolicy.BuildWebSocketUri(realtime,
                    exchange.WebSocketPath).AbsoluteUri,
                AutoConnect = source.Preferences.AutoStartEnabled.HasValue
                    && source.Preferences.AutoStartEnabled.Value,
                PythonExecutablePath = platform == "mt5" ? paths.PythonExecutablePath : string.Empty,
                WorkerScriptPath = platform == "mt5" ? paths.WorkerScriptPath : string.Empty,
                TerminalPath = binding.TerminalPath
            };
            store.SetRefreshToken(profile, exchange.RefreshToken);
            BridgeProfileStore.ValidateProfile(profile, false);
            return profile;
        }

        private static LegacyTerminalBindingSnapshot SelectBinding(LegacyV3ProfileSnapshot source)
        {
            IList<LegacyTerminalBindingSnapshot> bindings = source.TerminalBindings;
            if (bindings == null || bindings.Count == 0) throw Invalid("bridge_v3_binding_missing");
            string platform = source.Preferences.Platform == null
                ? null : source.Preferences.Platform.ToLowerInvariant();
            string terminalId = platform == "mt5" ? source.Preferences.Mt5TerminalInstanceId
                : platform == "mt4" ? source.Preferences.Mt4TerminalInstanceId : null;
            if (platform != null && platform != "mt4" && platform != "mt5")
                throw Invalid("bridge_v3_platform_invalid");
            if (platform == null)
            {
                if (bindings.Count != 1) throw Invalid("bridge_v3_binding_ambiguous");
                platform = bindings[0].Platform.ToLowerInvariant();
                terminalId = bindings[0].TerminalInstanceId;
            }
            if (string.IsNullOrWhiteSpace(terminalId))
            {
                if (bindings.Count != 1) throw Invalid("bridge_v3_binding_ambiguous");
                terminalId = bindings[0].TerminalInstanceId;
            }
            LegacyTerminalBindingSnapshot selected = null;
            for (int index = 0; index < bindings.Count; index++)
            {
                LegacyTerminalBindingSnapshot candidate = bindings[index];
                if (candidate == null || !string.Equals(candidate.Platform, platform,
                    StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(candidate.TerminalInstanceId, terminalId,
                        StringComparison.OrdinalIgnoreCase)) continue;
                if (selected != null) throw Invalid("bridge_v3_binding_duplicate");
                selected = candidate;
            }
            if (selected == null) throw Invalid("bridge_v3_binding_not_found");
            return selected;
        }

        private static string CredentialPath(LegacyV3MigrationSnapshot snapshot,
            LegacyV3ProfileSnapshot profile)
        {
            string dataRoot = snapshot.LegacySourceRoots.DataRoot;
            if (string.IsNullOrWhiteSpace(dataRoot) || !Path.IsPathRooted(dataRoot))
                throw Invalid("bridge_v3_data_root_invalid");
            string expectedRelative = profile.ProfileId == "default"
                ? string.Empty : "profiles/" + profile.ProfileId;
            if (!string.Equals(profile.SourceRelativePath ?? string.Empty, expectedRelative,
                StringComparison.Ordinal))
            {
                throw Invalid("bridge_v3_profile_path_invalid");
            }
            string profileRoot = string.IsNullOrEmpty(expectedRelative)
                ? Path.GetFullPath(dataRoot)
                : Path.GetFullPath(Path.Combine(dataRoot, "profiles", profile.ProfileId));
            if (!IsInside(profileRoot, dataRoot) || !Directory.Exists(profileRoot)
                || HasReparsePoint(profileRoot))
            {
                throw Invalid("bridge_v3_profile_path_invalid");
            }
            string path = Path.GetFullPath(Path.Combine(profileRoot,
                LegacyV3CredentialReader.CredentialFileName));
            if (!IsInside(path, profileRoot) || !IsRegularFile(path))
                throw Invalid("bridge_v3_credential_invalid");
            return path;
        }

        private static void ValidateSnapshot(LegacyV3MigrationSnapshot snapshot)
        {
            if (snapshot == null || snapshot.SchemaVersion != LegacyV3Migration.SnapshotSchemaVersion
                || snapshot.LegacySourceRoots == null || snapshot.EndpointOverride == null
                || snapshot.Profiles == null || snapshot.Profiles.Count == 0
                || snapshot.Profiles.Count > LegacyV3Migration.MaximumProfiles
                || !snapshot.CredentialExchangeRequired
                || !ValidIdentifier(snapshot.LegacyInstallationId, 128)
                || !ValidFingerprint(snapshot.SourceFingerprint))
            {
                throw Invalid("bridge_v3_snapshot_invalid");
            }
            if (snapshot.EndpointOverride.Status != "candidate"
                || string.IsNullOrWhiteSpace(snapshot.EndpointOverride.CandidateControlUri)
                || string.IsNullOrWhiteSpace(snapshot.EndpointOverride.CandidateRealtimeUri))
            {
                throw Invalid("bridge_v3_endpoint_pending");
            }
            HashSet<string> ids = new HashSet<string>(StringComparer.Ordinal);
            for (int index = 0; index < snapshot.Profiles.Count; index++)
            {
                LegacyV3ProfileSnapshot profile = snapshot.Profiles[index];
                if (profile == null || !ValidIdentifier(profile.ProfileId, 128)
                    || !ids.Add(profile.ProfileId)) throw Invalid("bridge_v3_profile_invalid");
            }
        }

        private static void ValidateExchange(BridgeV4CredentialExchangeResult exchange, Uri realtime)
        {
            if (exchange == null || exchange.CredentialType != "bridge_refresh"
                || !ValidToken(exchange.RefreshToken) || exchange.Generation <= 0
                || exchange.SessionTokenPath != "/api/v4/bridge/session-tokens"
                || exchange.WebSocketPath != "/bridge/v4/ws")
            {
                throw Invalid("bridge_v4_credential_exchange_invalid");
            }
            BridgeV4EndpointPolicy.BuildWebSocketUri(realtime, exchange.WebSocketPath);
        }

        private static string DisplayName(LegacyV3ProfileSnapshot source,
            LegacyTerminalBindingSnapshot binding)
        {
            string value = source.Preferences.ObserverAccountLabel;
            if (string.IsNullOrWhiteSpace(value))
                value = binding.Platform.ToUpperInvariant() + " · " + binding.Login;
            if (value.Length > 80 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
                throw Invalid("bridge_v4_profile_display_name_invalid");
            return value;
        }

        private static void ValidateMt5Paths(BridgeProfileRuntimePaths paths)
        {
            if (!ValidPath(paths.PythonExecutablePath) || !ValidPath(paths.WorkerScriptPath))
                throw Invalid("bridge_v4_mt5_runtime_paths_required");
        }

        private static bool ValidPath(string value)
        {
            return !string.IsNullOrWhiteSpace(value) && value.Length <= 4096
                && Path.IsPathRooted(value) && value.IndexOf('\r') < 0
                && value.IndexOf('\n') < 0 && value.IndexOf('\0') < 0;
        }

        private static bool ValidToken(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length < 40
                || value.Length > LegacyV3CredentialReader.MaximumRefreshTokenLength) return false;
            for (int index = 0; index < value.Length; index++)
                if (value[index] < 0x21 || value[index] == 0x7f || value[index] == '\r'
                    || value[index] == '\n' || value[index] == '\0') return false;
            return true;
        }

        private static bool ValidFingerprint(string value)
        {
            if (value == null || value.Length != 71
                || !value.StartsWith("sha256:", StringComparison.Ordinal)) return false;
            for (int index = 7; index < value.Length; index++)
            {
                char current = value[index];
                if (!((current >= '0' && current <= '9')
                    || (current >= 'a' && current <= 'f'))) return false;
            }
            return true;
        }

        private static bool IsRegularFile(string path)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                return (attributes & FileAttributes.Directory) == 0
                    && (attributes & FileAttributes.ReparsePoint) == 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool HasReparsePoint(string path)
        {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch (Exception) { return true; }
        }

        private static bool IsInside(string candidate, string root)
        {
            string normalizedCandidate = TrimSeparators(Path.GetFullPath(candidate));
            string normalizedRoot = TrimSeparators(Path.GetFullPath(root));
            string prefix = normalizedRoot + Path.DirectorySeparatorChar;
            return string.Equals(normalizedCandidate, normalizedRoot, StringComparison.OrdinalIgnoreCase)
                || normalizedCandidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static string TrimSeparators(string value)
        {
            while (value.Length > 3 && (value[value.Length - 1] == Path.DirectorySeparatorChar
                || value[value.Length - 1] == Path.AltDirectorySeparatorChar))
                value = value.Substring(0, value.Length - 1);
            return value;
        }

        private static long UtcNowMilliseconds()
        {
            return (DateTime.UtcNow.Ticks - new DateTime(1970, 1, 1, 0, 0, 0,
                DateTimeKind.Utc).Ticks) / TimeSpan.TicksPerMillisecond;
        }

        private static InvalidDataException Invalid(string code)
        {
            return new InvalidDataException(code);
        }

        private static bool ValidIdentifier(string value, int maximum)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maximum
                || !IsAsciiAlphaNumeric(value[0])) return false;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (!IsAsciiAlphaNumeric(current) && current != '-' && current != '_'
                    && current != '.') return false;
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
