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
    /// <summary>
    /// Reads the explicitly supplied Bridge V3 roots and writes a pending
    /// migration snapshot. The snapshot is not a V4 profile catalog and is
    /// never consumed as active configuration by this class.
    /// </summary>
    public static partial class LegacyV3Migration
    {
        public const int SnapshotSchemaVersion = 1;
        public const int MaximumJsonBytes = 1024 * 1024;
        public const int MaximumProfiles = 64;

        private const int MaximumInstallationIdLength = 128;
        private const int MaximumEndpointLength = 2048;
        private const int MaximumProfileIdLength = 128;
        private const int MaximumTerminalIdLength = 191;
        private const int MaximumTerminalPathLength = 4096;
        private const int MaximumBrokerLength = 191;
        private const int MaximumLoginLength = 128;
        private const int MaximumLabelLength = 256;
        private const int MaximumJsonDepth = 32;
        private const int MaximumBindingRows = 64;
        private const int FingerprintBufferSize = 64 * 1024;

        private static readonly HashSet<string> EndpointFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "schema_version", "control_url", "realtime_url"
        };

        private static readonly HashSet<string> PreferenceFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "Platform", "Mt5TerminalInstanceId", "Mt5TerminalPath", "Mt4TerminalInstanceId",
            "Mt4TerminalPath", "ObserverEnabled", "ObserverBridgeUserId", "ObserverAccountLabel",
            "ObserverTradingAccountId", "ObserverTradingAccountLabel", "ObserverClaimedTerminalInstanceId",
            "AutoStartEnabled"
        };

        private static readonly string[] DiscardedCategories =
        {
            "cache", "log", "runtime-status", "snapshots", "cursors", "outbox",
            "sqlite-history", "credential-content"
        };

        public static LegacyV3MigrationSnapshot Generate(
            string legacyInstallRoot,
            string legacyDataRoot,
            string destinationSnapshotPath)
        {
            string installRoot = NormalizeRoot(legacyInstallRoot, "legacy_v3_install_root_invalid");
            string dataRoot = NormalizeRoot(legacyDataRoot, "legacy_v3_data_root_invalid");
            string destination = NormalizeDestination(destinationSnapshotPath, installRoot, dataRoot);

            List<FingerprintSource> fingerprintSources = new List<FingerprintSource>();
            string installationPath = CombineInside(installRoot, "installation-id", "legacy_v3_installation_id_path_invalid");
            string installationId = ReadInstallationId(installationPath);
            fingerprintSources.Add(FingerprintSource.ForSemantic("install/installation-id", installationPath, installationId));

            string endpointPath = CombineInside(dataRoot, "endpoint-settings.json", "legacy_v3_endpoint_path_invalid");
            LegacyEndpointOverride endpoint = ReadEndpoint(endpointPath, fingerprintSources);

            List<string> profileIds = DiscoverProfileIds(dataRoot);
            if (profileIds.Count + 1 > MaximumProfiles)
            {
                throw Invalid("legacy_v3_profile_limit_exceeded");
            }

            List<LegacyV3ProfileSnapshot> profiles = new List<LegacyV3ProfileSnapshot>();
            profiles.Add(ReadProfile("default", string.Empty, dataRoot, fingerprintSources));
            for (int index = 0; index < profileIds.Count; index++)
            {
                string profileId = profileIds[index];
                string profilePath = CombineInside(
                    CombineInside(dataRoot, "profiles", "legacy_v3_profiles_path_invalid"),
                    profileId,
                    "legacy_v3_profile_path_invalid");
                profiles.Add(ReadProfile(
                    profileId,
                    "profiles/" + profileId,
                    profilePath,
                    fingerprintSources));
            }

            string sourceFingerprint = BuildSourceFingerprint(installRoot, dataRoot, fingerprintSources);
            LegacyV3MigrationSnapshot snapshot = new LegacyV3MigrationSnapshot
            {
                SchemaVersion = SnapshotSchemaVersion,
                LegacyInstallationId = installationId,
                LegacySourceRoots = new LegacySourceRoots
                {
                    InstallRoot = installRoot,
                    DataRoot = dataRoot
                },
                EndpointOverride = endpoint,
                Profiles = profiles,
                CredentialExchangeRequired = true,
                DiscardedCategories = new List<string>(DiscardedCategories),
                CreatedAtUtcMsc = UtcNowMilliseconds(),
                SourceFingerprint = sourceFingerprint
            };

            WriteSnapshotAtomically(destination, snapshot);
            return snapshot;
        }

        private static LegacyV3ProfileSnapshot ReadProfile(
            string profileId,
            string relativePath,
            string profileRoot,
            IList<FingerprintSource> fingerprintSources)
        {
            ValidateProfileId(profileId);
            EnsureDirectory(profileRoot, "legacy_v3_profile_root_invalid");

            string preferencesPath = CombineInside(profileRoot, "preferences.json", "legacy_v3_preferences_path_invalid");
            LegacyV3PreferencesSnapshot preferences = ReadPreferences(preferencesPath, fingerprintSources);

            string databasePath = CombineInside(profileRoot, "bridge.db", "legacy_v3_database_path_invalid");
            IList<LegacyTerminalBindingSnapshot> bindings = ReadBindings(databasePath, fingerprintSources);

            string credentialPath = CombineInside(profileRoot, "credential.dat", "legacy_v3_credential_path_invalid");
            bool credentialPresent = ReadOptionalRegularFileState(credentialPath, "legacy_v3_credential_path_invalid");
            fingerprintSources.Add(FingerprintSource.ForMetadata(
                "profile/" + profileId + "/credential.dat",
                credentialPath,
                credentialPresent));

            return new LegacyV3ProfileSnapshot
            {
                ProfileId = profileId,
                SourceRelativePath = relativePath,
                Preferences = preferences,
                TerminalBindings = new List<LegacyTerminalBindingSnapshot>(bindings),
                CredentialFilePresent = credentialPresent,
                CredentialState = credentialPresent ? "present_pending_exchange" : "missing_pending_pairing",
                CredentialExchangeRequired = true
            };
        }

        private static LegacyV3PreferencesSnapshot ReadPreferences(
            string path,
            IList<FingerprintSource> fingerprintSources)
        {
            byte[] bytes;
            if (!TryReadOptionalFile(path, out bytes, "legacy_v3_preferences_path_invalid"))
            {
                fingerprintSources.Add(FingerprintSource.ForFile("preferences/" + path, path, false));
                return new LegacyV3PreferencesSnapshot { Present = false };
            }
            fingerprintSources.Add(FingerprintSource.ForBytes("preferences/" + path, path, bytes));

            IDictionary<string, object> root = ParseJsonObject(bytes, "legacy_v3_preferences_invalid");
            RequireKnownFields(root, PreferenceFields, "legacy_v3_preferences_unknown_field");

            string platform = ReadOptionalText(root, "Platform", 16, "legacy_v3_preferences_platform_invalid");
            if (platform != null)
            {
                platform = platform.Trim().ToLowerInvariant();
                if (platform != "mt4" && platform != "mt5")
                {
                    throw Invalid("legacy_v3_preferences_platform_invalid");
                }
            }

            string mt5TerminalId = ReadOptionalText(root, "Mt5TerminalInstanceId", MaximumTerminalIdLength, "legacy_v3_preferences_terminal_invalid");
            string mt4TerminalId = ReadOptionalText(root, "Mt4TerminalInstanceId", MaximumTerminalIdLength, "legacy_v3_preferences_terminal_invalid");
            string mt5TerminalPath = ReadOptionalPath(root, "Mt5TerminalPath", "legacy_v3_preferences_terminal_path_invalid");
            string mt4TerminalPath = ReadOptionalPath(root, "Mt4TerminalPath", "legacy_v3_preferences_terminal_path_invalid");
            string claimedTerminalId = ReadOptionalText(root, "ObserverClaimedTerminalInstanceId", MaximumTerminalIdLength, "legacy_v3_preferences_terminal_invalid");
            string accountLabel = ReadOptionalText(root, "ObserverAccountLabel", MaximumLabelLength, "legacy_v3_preferences_label_invalid");
            string tradingAccountLabel = ReadOptionalText(root, "ObserverTradingAccountLabel", MaximumLabelLength, "legacy_v3_preferences_label_invalid");

            return new LegacyV3PreferencesSnapshot
            {
                Present = true,
                Platform = platform,
                Mt5TerminalInstanceId = mt5TerminalId,
                Mt5TerminalPath = mt5TerminalPath,
                Mt4TerminalInstanceId = mt4TerminalId,
                Mt4TerminalPath = mt4TerminalPath,
                ObserverEnabled = ReadOptionalBoolean(root, "ObserverEnabled", "legacy_v3_preferences_boolean_invalid"),
                ObserverBridgeUserId = ReadOptionalPositiveInt64(root, "ObserverBridgeUserId", "legacy_v3_preferences_account_id_invalid"),
                ObserverAccountLabel = accountLabel,
                ObserverTradingAccountId = ReadOptionalPositiveInt64(root, "ObserverTradingAccountId", "legacy_v3_preferences_account_id_invalid"),
                ObserverTradingAccountLabel = tradingAccountLabel,
                ObserverClaimedTerminalInstanceId = claimedTerminalId,
                AutoStartEnabled = ReadOptionalBoolean(root, "AutoStartEnabled", "legacy_v3_preferences_boolean_invalid")
            };
        }

        private static IList<LegacyTerminalBindingSnapshot> ReadBindings(
            string path,
            IList<FingerprintSource> fingerprintSources)
        {
            bool present = ReadOptionalRegularFileState(path, "legacy_v3_database_path_invalid");
            List<LegacyTerminalBindingSnapshot> bindings = new List<LegacyTerminalBindingSnapshot>();
            if (!present)
            {
                fingerprintSources.Add(FingerprintSource.ForMetadata("database/" + path, path, false));
                return bindings;
            }

            Dictionary<string, LegacyTerminalBindingSnapshot> byTerminal =
                new Dictionary<string, LegacyTerminalBindingSnapshot>(StringComparer.OrdinalIgnoreCase);
            try
            {
                using (SQLiteConnection connection = new SQLiteConnection(
                    "Data Source=" + path + ";Version=3;Read Only=True;FailIfMissing=True;BusyTimeout=5000;"))
                {
                    connection.Open();
                    using (SQLiteCommand pragma = connection.CreateCommand())
                    {
                        pragma.CommandText = "PRAGMA query_only = ON;";
                        pragma.ExecuteNonQuery();
                    }

                    using (SQLiteCommand command = connection.CreateCommand())
                    {
                        command.CommandText =
                            "SELECT terminal_instance_id, platform, terminal_path, broker_server, " +
                            "login_account, connection_epoch, updated_at_utc_msc " +
                            "FROM terminal_bindings ORDER BY terminal_instance_id LIMIT 65;";
                        using (SQLiteDataReader reader = command.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                if (byTerminal.Count >= MaximumBindingRows)
                                {
                                    throw Invalid("legacy_v3_binding_limit_exceeded");
                                }
                                LegacyTerminalBindingSnapshot binding = ReadBinding(reader);
                                LegacyTerminalBindingSnapshot previous;
                                if (byTerminal.TryGetValue(binding.TerminalInstanceId, out previous))
                                {
                                    if (!SameBinding(previous, binding))
                                    {
                                        throw Invalid("legacy_v3_binding_duplicate_conflict");
                                    }
                                    continue;
                                }
                                byTerminal.Add(binding.TerminalInstanceId, binding);
                            }
                        }
                    }
                }
            }
            catch (InvalidDataException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new InvalidDataException("legacy_v3_database_read_failed", error);
            }

            foreach (LegacyTerminalBindingSnapshot binding in byTerminal.Values)
            {
                bindings.Add(binding);
            }
            bindings.Sort(delegate(LegacyTerminalBindingSnapshot first, LegacyTerminalBindingSnapshot second)
            {
                return StringComparer.OrdinalIgnoreCase.Compare(first.TerminalInstanceId, second.TerminalInstanceId);
            });
            fingerprintSources.Add(FingerprintSource.ForBindings("database/" + path, path, bindings));
            return bindings;
        }

        private static LegacyTerminalBindingSnapshot ReadBinding(SQLiteDataReader reader)
        {
            string terminalId = ReadColumnText(reader, 0, MaximumTerminalIdLength, "legacy_v3_binding_terminal_invalid");
            string platform = ReadColumnText(reader, 1, 16, "legacy_v3_binding_platform_invalid").ToLowerInvariant();
            string terminalPath = ReadColumnText(reader, 2, MaximumTerminalPathLength, "legacy_v3_binding_path_invalid");
            string brokerServer = ReadColumnText(reader, 3, MaximumBrokerLength, "legacy_v3_binding_broker_invalid");
            string login = ReadColumnText(reader, 4, MaximumLoginLength, "legacy_v3_binding_login_invalid");
            if (platform != "mt4" && platform != "mt5")
            {
                throw Invalid("legacy_v3_binding_platform_invalid");
            }
            if (!Path.IsPathRooted(terminalPath) || terminalPath.Length > MaximumTerminalPathLength)
            {
                throw Invalid("legacy_v3_binding_path_invalid");
            }
            long epoch = ReadColumnInt64(reader, 5, "legacy_v3_binding_epoch_invalid");
            long updatedAt = ReadColumnInt64(reader, 6, "legacy_v3_binding_updated_at_invalid");
            if (epoch <= 0 || updatedAt < 0)
            {
                throw Invalid("legacy_v3_binding_timestamp_invalid");
            }
            return new LegacyTerminalBindingSnapshot
            {
                TerminalInstanceId = terminalId,
                Platform = platform,
                TerminalPath = terminalPath,
                BrokerServer = brokerServer,
                Login = login,
                ConnectionEpoch = epoch,
                UpdatedAtUtcMsc = updatedAt
            };
        }

        private static LegacyEndpointOverride ReadEndpoint(
            string path,
            IList<FingerprintSource> fingerprintSources)
        {
            byte[] bytes;
            if (!TryReadOptionalFile(path, out bytes, "legacy_v3_endpoint_path_invalid"))
            {
                fingerprintSources.Add(FingerprintSource.ForFile("endpoint/" + path, path, false));
                return new LegacyEndpointOverride { Status = "none", ActivationReady = false };
            }
            fingerprintSources.Add(FingerprintSource.ForBytes("endpoint/" + path, path, bytes));

            IDictionary<string, object> root = ParseJsonObject(bytes, "legacy_v3_endpoint_invalid");
            RequireKnownFields(root, EndpointFields, "legacy_v3_endpoint_unknown_field");
            object schemaValue;
            if (root.TryGetValue("schema_version", out schemaValue)
                && ReadInt64(schemaValue, "legacy_v3_endpoint_schema_invalid") != 1)
            {
                throw Invalid("legacy_v3_endpoint_schema_invalid");
            }
            string controlUrl = ReadRequiredText(root, "control_url", MaximumEndpointLength, "legacy_v3_endpoint_url_invalid");
            string realtimeUrl = ReadRequiredText(root, "realtime_url", MaximumEndpointLength, "legacy_v3_endpoint_url_invalid");
            Uri controlCandidate;
            Uri realtimeCandidate;
            string controlLegacy;
            string realtimeLegacy;
            if (!TryNormalizeEndpoint(controlUrl, false, out controlLegacy, out controlCandidate)
                || !TryNormalizeEndpoint(realtimeUrl, true, out realtimeLegacy, out realtimeCandidate))
            {
                return new LegacyEndpointOverride
                {
                    Status = "pending",
                    ActivationReady = false,
                    Reason = "legacy_endpoint_invalid_or_server_confirmation_required"
                };
            }
            return new LegacyEndpointOverride
            {
                Status = "candidate",
                LegacyControlUri = controlLegacy,
                LegacyRealtimeUri = realtimeLegacy,
                CandidateControlUri = controlCandidate.AbsoluteUri,
                CandidateRealtimeUri = realtimeCandidate.AbsoluteUri,
                ActivationReady = false,
                Reason = "v4_endpoint_confirmation_required"
            };
        }

        private static List<string> DiscoverProfileIds(string dataRoot)
        {
            string profilesRoot = CombineInside(dataRoot, "profiles", "legacy_v3_profiles_path_invalid");
            FileAttributes profileRootAttributes;
            if (!TryGetAttributes(profilesRoot, out profileRootAttributes, "legacy_v3_profiles_root_invalid"))
            {
                return new List<string>();
            }
            EnsureDirectory(profilesRoot, "legacy_v3_profiles_root_invalid");
            string[] directories;
            try
            {
                directories = Directory.GetDirectories(profilesRoot, "*", SearchOption.TopDirectoryOnly);
            }
            catch (Exception error)
            {
                throw new InvalidDataException("legacy_v3_profiles_read_failed", error);
            }
            if (directories.Length > MaximumProfiles)
            {
                throw Invalid("legacy_v3_profile_limit_exceeded");
            }
            List<string> ids = new List<string>();
            HashSet<string> uniqueIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < directories.Length; index++)
            {
                DirectoryInfo info = new DirectoryInfo(directories[index]);
                if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    throw Invalid("legacy_v3_profile_reparse_point");
                }
                ValidateProfileId(info.Name);
                if (string.Equals(info.Name, "default", StringComparison.OrdinalIgnoreCase)
                    || !uniqueIds.Add(info.Name))
                {
                    throw Invalid("legacy_v3_profile_duplicate");
                }
                ids.Add(info.Name);
            }
            ids.Sort(StringComparer.OrdinalIgnoreCase);
            return ids;
        }

        private static void WriteSnapshotAtomically(string path, LegacyV3MigrationSnapshot snapshot)
        {
            string directory = Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(directory))
            {
                throw Invalid("legacy_v3_snapshot_path_invalid");
            }
            EnsureNoReparseAncestor(directory);
            Directory.CreateDirectory(directory);

            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumJsonBytes;
            serializer.RecursionLimit = MaximumJsonDepth;
            string json = serializer.Serialize(ToDocument(snapshot));
            byte[] payload = new UTF8Encoding(false).GetBytes(json);
            if (payload.Length > MaximumJsonBytes)
            {
                throw Invalid("legacy_v3_snapshot_too_large");
            }

            string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                using (FileStream stream = new FileStream(
                    temporary,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    64 * 1024,
                    FileOptions.WriteThrough))
                {
                    stream.Write(payload, 0, payload.Length);
                    stream.Flush(true);
                }
                if (File.Exists(path))
                {
                    if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    {
                        throw Invalid("legacy_v3_snapshot_reparse_point");
                    }
                    File.Replace(temporary, path, null, true);
                }
                else
                {
                    File.Move(temporary, path);
                }
            }
            finally
            {
                if (File.Exists(temporary))
                {
                    File.Delete(temporary);
                }
            }
        }

        private static IDictionary<string, object> ToDocument(LegacyV3MigrationSnapshot snapshot)
        {
            Dictionary<string, object> root = new Dictionary<string, object>(StringComparer.Ordinal);
            root.Add("schema_version", snapshot.SchemaVersion);
            root.Add("legacy_installation_id", snapshot.LegacyInstallationId);
            root.Add("legacy_source_roots", new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "install_root", snapshot.LegacySourceRoots.InstallRoot },
                { "data_root", snapshot.LegacySourceRoots.DataRoot }
            });
            LegacyEndpointOverride endpoint = snapshot.EndpointOverride;
            root.Add("endpoint_override", new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "status", endpoint.Status },
                { "legacy_control_uri", endpoint.LegacyControlUri },
                { "legacy_realtime_uri", endpoint.LegacyRealtimeUri },
                { "candidate_control_uri", endpoint.CandidateControlUri },
                { "candidate_realtime_uri", endpoint.CandidateRealtimeUri },
                { "activation_ready", endpoint.ActivationReady },
                { "reason", endpoint.Reason }
            });
            List<object> profiles = new List<object>();
            foreach (LegacyV3ProfileSnapshot profile in snapshot.Profiles)
            {
                profiles.Add(ToProfileDocument(profile));
            }
            root.Add("profiles", profiles);
            root.Add("credential_exchange_required", snapshot.CredentialExchangeRequired);
            root.Add("discarded_categories", snapshot.DiscardedCategories);
            root.Add("created_at_utc_msc", snapshot.CreatedAtUtcMsc);
            root.Add("source_fingerprint", snapshot.SourceFingerprint);
            return root;
        }

        private static IDictionary<string, object> ToProfileDocument(LegacyV3ProfileSnapshot profile)
        {
            LegacyV3PreferencesSnapshot preferences = profile.Preferences;
            Dictionary<string, object> preferenceDocument = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "present", preferences.Present },
                { "platform", preferences.Platform },
                { "mt5_terminal_instance_id", preferences.Mt5TerminalInstanceId },
                { "mt5_terminal_path", preferences.Mt5TerminalPath },
                { "mt4_terminal_instance_id", preferences.Mt4TerminalInstanceId },
                { "mt4_terminal_path", preferences.Mt4TerminalPath },
                { "observer_enabled", preferences.ObserverEnabled },
                { "observer_bridge_user_id", preferences.ObserverBridgeUserId },
                { "observer_account_label", preferences.ObserverAccountLabel },
                { "observer_trading_account_id", preferences.ObserverTradingAccountId },
                { "observer_trading_account_label", preferences.ObserverTradingAccountLabel },
                { "observer_claimed_terminal_instance_id", preferences.ObserverClaimedTerminalInstanceId },
                { "auto_start_enabled", preferences.AutoStartEnabled }
            };
            List<object> bindings = new List<object>();
            foreach (LegacyTerminalBindingSnapshot binding in profile.TerminalBindings)
            {
                bindings.Add(new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    { "terminal_instance_id", binding.TerminalInstanceId },
                    { "platform", binding.Platform },
                    { "terminal_path", binding.TerminalPath },
                    { "broker_server", binding.BrokerServer },
                    { "login", binding.Login },
                    { "connection_epoch", binding.ConnectionEpoch },
                    { "updated_at_utc_msc", binding.UpdatedAtUtcMsc }
                });
            }
            return new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "profile_id", profile.ProfileId },
                { "source_relative_path", profile.SourceRelativePath },
                { "preferences", preferenceDocument },
                { "terminal_bindings", bindings },
                { "credential_file_present", profile.CredentialFilePresent },
                { "credential_state", profile.CredentialState },
                { "credential_exchange_required", profile.CredentialExchangeRequired }
            };
        }

    }
}
