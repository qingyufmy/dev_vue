using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SQLite;
using System.Globalization;
using System.IO;

namespace Liangjian.BridgeV4.Storage
{
    /// <summary>
    /// Durable, rebuildable read model for one terminal profile. This store
    /// contains terminal facts and sync evidence only; business authorization
    /// and trading rules remain on the server.
    /// </summary>
    public sealed partial class ProfileDataStore : IDisposable
    {
        public const int MaxPageSize = 500;
        public const int MaxBatchSize = 500;
        public const int DefaultCandleAccessDays = 30;
        public const int DefaultCandleAgeDays = 180;
        public const int DefaultHistoryAgeDays = 365;
        public const int DefaultSnapshotRetentionDays = 7;
        public const int DefaultProjectionRetentionDays = 7;
        public const int DefaultSyncJobRetentionDays = 7;
        public const int DefaultOutboxRetentionDays = 7;
        public const int DefaultInstrumentAccessDays = 30;

        private readonly SQLiteConnection connection;
        private readonly object writeGate;
        private readonly string databasePath;
        private readonly string profileId;
        private readonly string terminalInstanceId;
        private readonly string platform;
        private readonly string brokerServer;
        private readonly string login;
        private long connectionEpoch;
        private bool disposed;

        public ProfileDataStore(
            string databasePath,
            string profileId,
            string terminalInstanceId,
            string platform,
            string brokerServer,
            string login,
            long connectionEpoch)
        {
            RequireText(databasePath, "bridge_cache_path_invalid", 4096);
            RequireText(profileId, "bridge_cache_profile_invalid", 128);
            RequireText(terminalInstanceId, "bridge_cache_terminal_invalid", 191);
            RequireText(platform, "bridge_cache_platform_invalid", 16);
            RequireText(brokerServer, "bridge_cache_broker_invalid", 191);
            RequireText(login, "bridge_cache_login_invalid", 128);
            RequireEpoch(connectionEpoch, "bridge_cache_epoch_invalid");

            string fullPath = Path.GetFullPath(databasePath);
            string directory = Path.GetDirectoryName(fullPath);
            if (string.IsNullOrEmpty(directory))
            {
                throw new ArgumentException("bridge_cache_path_invalid", "databasePath");
            }
            Directory.CreateDirectory(directory);

            this.databasePath = fullPath;
            this.profileId = profileId;
            this.terminalInstanceId = terminalInstanceId;
            this.platform = NormalizePlatform(platform);
            this.brokerServer = brokerServer;
            this.login = login;
            this.connectionEpoch = connectionEpoch;
            writeGate = SqliteDatabaseCoordinator.GetWriteGate(fullPath);
            connection = new SQLiteConnection("Data Source=" + fullPath + ";Version=3;Journal Mode=WAL;Synchronous=Full;Foreign Keys=True;BusyTimeout=5000;");
            try
            {
                connection.Open();
                lock (writeGate)
                {
                    ProfileDataStoreSchema.Apply(connection);
                    InitializeProfileState();
                }
            }
            catch
            {
                connection.Dispose();
                throw;
            }
        }

        public string DatabasePath
        {
            get { return databasePath; }
        }

        public string ProfileId
        {
            get { return profileId; }
        }

        public long ConnectionEpoch
        {
            get { return connectionEpoch; }
        }

        public static string CandleScopeKey(string symbol, string timeframe)
        {
            RequireText(symbol, "bridge_cache_symbol_invalid", 64);
            RequireText(timeframe, "bridge_cache_timeframe_invalid", 32);
            return symbol + "|" + timeframe;
        }

        public static long ReadPersistedConnectionEpoch(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("bridge_cache_path_invalid", "path");
            string fullPath = Path.GetFullPath(path);
            if (!File.Exists(fullPath)) return 1;
            using (SQLiteConnection probe = new SQLiteConnection("Data Source=" + fullPath + ";Version=3;Read Only=True;BusyTimeout=5000;"))
            {
                probe.Open();
                using (SQLiteCommand command = probe.CreateCommand())
                {
                    command.CommandText = "SELECT connection_epoch FROM profile_state WHERE slot = 1 LIMIT 1";
                    object value = command.ExecuteScalar();
                    if (value == null || value == DBNull.Value) return 1;
                    long epoch = Convert.ToInt64(value, CultureInfo.InvariantCulture);
                    RequireEpoch(epoch, "bridge_cache_epoch_invalid");
                    return epoch;
                }
            }
        }

        public void ValidateRoute(
            string expectedProfileId,
            string expectedTerminalInstanceId,
            string expectedPlatform,
            string expectedBrokerServer,
            string expectedLogin,
            long expectedConnectionEpoch)
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                if (!string.Equals(profileId, expectedProfileId, StringComparison.Ordinal)
                    || !string.Equals(terminalInstanceId, expectedTerminalInstanceId, StringComparison.Ordinal)
                    || !string.Equals(platform, NormalizePlatform(expectedPlatform), StringComparison.Ordinal)
                    || !string.Equals(brokerServer, expectedBrokerServer, StringComparison.Ordinal)
                    || !string.Equals(login, expectedLogin, StringComparison.Ordinal))
                {
                    throw new InvalidDataException("bridge_cache_profile_identity_mismatch");
                }
                EnsureExpectedEpoch(expectedConnectionEpoch);
            }
        }

        public void RebindEpoch(long newConnectionEpoch)
        {
            RequireEpoch(newConnectionEpoch, "bridge_cache_epoch_invalid");
            lock (writeGate)
            {
                EnsureNotDisposed();
                if (newConnectionEpoch < connectionEpoch)
                {
                    throw new InvalidDataException("bridge_cache_profile_epoch_regressed");
                }
                if (newConnectionEpoch == connectionEpoch)
                {
                    return;
                }
                PersistConnectionEpoch(connectionEpoch, newConnectionEpoch);
                connectionEpoch = newConnectionEpoch;
            }
        }

        public ProfileStateRecord ReadProfileState()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT profile_id, terminal_instance_id, platform, broker_server, login, connection_epoch, terminal_build, clock_offset_seconds, clock_status, clock_revision, observed_at_utc_msc FROM profile_state WHERE slot = 1 LIMIT 1";
                    using (SQLiteDataReader reader = command.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        if (!reader.Read())
                        {
                            throw new InvalidDataException("bridge_cache_profile_state_missing");
                        }
                        return ReadProfileState(reader);
                    }
                }
            }
        }

        public IList<SchemaMigrationRecord> ReadSchemaMigrations()
        {
            lock (writeGate)
            {
                EnsureNotDisposed();
                List<SchemaMigrationRecord> records = new List<SchemaMigrationRecord>();
                using (SQLiteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT version, name, checksum, applied_at_utc_msc FROM schema_migrations ORDER BY version ASC";
                    using (SQLiteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            records.Add(new SchemaMigrationRecord
                            {
                                Version = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture),
                                Name = reader.GetString(1),
                                Checksum = reader.GetString(2),
                                AppliedAtUtcMsc = Convert.ToInt64(reader.GetValue(3), CultureInfo.InvariantCulture)
                            });
                        }
                    }
                }
                return records;
            }
        }

        public void Dispose()
        {
            lock (writeGate)
            {
                if (!disposed)
                {
                    disposed = true;
                    connection.Dispose();
                }
            }
        }

        private void InitializeProfileState()
        {
            ProfileStateRecord existing = null;
            using (SQLiteCommand select = connection.CreateCommand())
            {
                select.CommandText = "SELECT profile_id, terminal_instance_id, platform, broker_server, login, connection_epoch, terminal_build, clock_offset_seconds, clock_status, clock_revision, observed_at_utc_msc FROM profile_state WHERE slot = 1 LIMIT 1";
                using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                {
                    if (reader.Read())
                    {
                        existing = ReadProfileState(reader);
                    }
                }
            }
            if (existing != null)
            {
                if (!string.Equals(existing.ProfileId, profileId, StringComparison.Ordinal)
                    || !string.Equals(existing.TerminalInstanceId, terminalInstanceId, StringComparison.Ordinal)
                    || !string.Equals(existing.Platform, platform, StringComparison.Ordinal)
                    || !string.Equals(existing.BrokerServer, brokerServer, StringComparison.Ordinal)
                    || !string.Equals(existing.Login, login, StringComparison.Ordinal))
                {
                    throw new InvalidDataException("bridge_cache_profile_identity_mismatch");
                }
                if (connectionEpoch < existing.ConnectionEpoch)
                {
                    throw new InvalidDataException("bridge_cache_profile_epoch_regressed");
                }
                if (connectionEpoch > existing.ConnectionEpoch)
                {
                    PersistConnectionEpoch(existing.ConnectionEpoch, connectionEpoch);
                }
                return;
            }

            using (SQLiteCommand insert = connection.CreateCommand())
            {
                insert.CommandText = "INSERT INTO profile_state (slot, profile_id, terminal_instance_id, platform, broker_server, login, connection_epoch, terminal_build, clock_offset_seconds, clock_status, clock_revision, observed_at_utc_msc) VALUES (1, @profile_id, @terminal_instance_id, @platform, @broker_server, @login, @connection_epoch, 0, NULL, NULL, NULL, @observed_at)";
                AddParameter(insert, "@profile_id", profileId);
                AddParameter(insert, "@terminal_instance_id", terminalInstanceId);
                AddParameter(insert, "@platform", platform);
                AddParameter(insert, "@broker_server", brokerServer);
                AddParameter(insert, "@login", login);
                AddParameter(insert, "@connection_epoch", connectionEpoch);
                AddParameter(insert, "@observed_at", UtcNowMsc());
                insert.ExecuteNonQuery();
            }
        }

        private void PersistConnectionEpoch(long previousConnectionEpoch, long nextConnectionEpoch)
        {
            using (SQLiteCommand update = connection.CreateCommand())
            {
                update.CommandText = "UPDATE profile_state SET connection_epoch = @next_epoch, observed_at_utc_msc = @observed_at WHERE slot = 1 AND profile_id = @profile_id AND terminal_instance_id = @terminal_instance_id AND platform = @platform AND broker_server = @broker_server AND login = @login AND connection_epoch = @previous_epoch";
                AddParameter(update, "@next_epoch", nextConnectionEpoch);
                AddParameter(update, "@observed_at", UtcNowMsc());
                AddParameter(update, "@profile_id", profileId);
                AddParameter(update, "@terminal_instance_id", terminalInstanceId);
                AddParameter(update, "@platform", platform);
                AddParameter(update, "@broker_server", brokerServer);
                AddParameter(update, "@login", login);
                AddParameter(update, "@previous_epoch", previousConnectionEpoch);
                if (update.ExecuteNonQuery() != 1)
                {
                    throw new InvalidDataException("bridge_cache_profile_epoch_conflict");
                }
            }
        }

        private static ProfileStateRecord ReadProfileState(SQLiteDataReader reader)
        {
            return new ProfileStateRecord
            {
                ProfileId = reader.GetString(0),
                TerminalInstanceId = reader.GetString(1),
                Platform = reader.GetString(2),
                BrokerServer = reader.GetString(3),
                Login = reader.GetString(4),
                ConnectionEpoch = Convert.ToInt64(reader.GetValue(5), CultureInfo.InvariantCulture),
                TerminalBuild = Convert.ToInt32(reader.GetValue(6), CultureInfo.InvariantCulture),
                ClockOffsetSeconds = reader.IsDBNull(7) ? (int?)null : Convert.ToInt32(reader.GetValue(7), CultureInfo.InvariantCulture),
                ClockStatus = ReadNullableString(reader, 8),
                ClockRevision = ReadNullableString(reader, 9),
                ObservedAtUtcMsc = Convert.ToInt64(reader.GetValue(10), CultureInfo.InvariantCulture)
            };
        }

        private void EnsureExpectedEpoch(long expectedConnectionEpoch)
        {
            RequireEpoch(expectedConnectionEpoch, "bridge_cache_epoch_invalid");
            if (connectionEpoch != expectedConnectionEpoch)
            {
                throw new InvalidDataException("bridge_cache_profile_epoch_mismatch");
            }
        }

        private static string NormalizePlatform(string value)
        {
            RequireText(value, "bridge_cache_platform_invalid", 16);
            return value.ToLowerInvariant();
        }

        private static void ValidateRange(long start, long end, string error)
        {
            if (start < 1 || end <= start)
            {
                throw new InvalidDataException(error);
            }
        }

        private static int NormalizePageSize(int requested)
        {
            if (requested < 1)
            {
                throw new InvalidDataException("bridge_cache_page_invalid");
            }
            if (requested > MaxPageSize)
            {
                throw new InvalidDataException("bridge_cache_page_too_large");
            }
            return requested;
        }

        private static int NormalizeBatchSize(int requested)
        {
            if (requested < 1)
            {
                throw new InvalidDataException("bridge_cache_batch_invalid");
            }
            if (requested > MaxBatchSize)
            {
                throw new InvalidDataException("bridge_cache_batch_too_large");
            }
            return requested;
        }

        private static void RequireEpoch(long value, string error)
        {
            if (value < 1)
            {
                throw new InvalidDataException(error);
            }
        }

        private static void RequireText(string value, string error, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength)
            {
                throw new InvalidDataException(error);
            }
        }

        private static void RequireNumericIdentifier(string value, string error, int maxLength)
        {
            if (string.IsNullOrEmpty(value) || value.Length > maxLength)
            {
                throw new InvalidDataException(error);
            }
            for (int i = 0; i < value.Length; i++)
            {
                if (value[i] < '0' || value[i] > '9')
                {
                    throw new InvalidDataException(error);
                }
            }
        }

        private static void RequireFinite(double value, string error)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new InvalidDataException(error);
            }
        }

        private static long UtcNowMsc()
        {
            DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            return checked((DateTime.UtcNow.Ticks - epoch.Ticks) / TimeSpan.TicksPerMillisecond);
        }

        private static long SubtractDays(long utcMsc, int days)
        {
            long delta = checked((long)days * 24L * 60L * 60L * 1000L);
            return utcMsc > delta ? utcMsc - delta : 1;
        }

        private void EnsureNotDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("ProfileDataStore");
            }
        }

        private static string ReadNullableString(SQLiteDataReader reader, int index)
        {
            return reader.IsDBNull(index) ? null : Convert.ToString(reader.GetValue(index), CultureInfo.InvariantCulture);
        }

        private static void AddNullableParameter(SQLiteCommand command, string name, object value)
        {
            AddParameter(command, name, value ?? DBNull.Value);
        }

        private static SQLiteParameter AddParameter(SQLiteCommand command, string name, object value)
        {
            SQLiteParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value ?? DBNull.Value;
            command.Parameters.Add(parameter);
            return parameter;
        }
    }
}
