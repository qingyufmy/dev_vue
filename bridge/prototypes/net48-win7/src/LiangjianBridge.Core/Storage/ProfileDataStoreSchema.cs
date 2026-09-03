using System;
using System.Data;
using System.Data.SQLite;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Liangjian.BridgeV4.Storage
{
    internal static class ProfileDataStoreSchema
    {
        public const int LatestVersion = 2;
        public const string MigrationName = "profile_data_store_v1";
        public const string MigrationV2Name = "profile_data_store_v2";

        private const string MigrationSql = @"
CREATE TABLE IF NOT EXISTS profile_state (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    profile_id TEXT NOT NULL UNIQUE,
    terminal_instance_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    broker_server TEXT NOT NULL,
    login TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    terminal_build INTEGER NOT NULL DEFAULT 0,
    clock_offset_seconds INTEGER NULL,
    clock_status TEXT NULL,
    clock_revision TEXT NULL,
    observed_at_utc_msc INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_candles (
    profile_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time_utc_msc INTEGER NOT NULL,
    open_price REAL NOT NULL,
    high_price REAL NOT NULL,
    low_price REAL NOT NULL,
    close_price REAL NOT NULL,
    tick_volume INTEGER NOT NULL,
    real_volume INTEGER NOT NULL,
    spread REAL NOT NULL,
    closed INTEGER NOT NULL CHECK (closed = 1),
    source_revision TEXT NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    last_accessed_utc_msc INTEGER NOT NULL,
    PRIMARY KEY (profile_id, symbol, timeframe, open_time_utc_msc)
);
CREATE INDEX IF NOT EXISTS idx_market_candles_time
    ON market_candles (profile_id, symbol, timeframe, open_time_utc_msc);
CREATE TABLE IF NOT EXISTS history_items (
    profile_id TEXT NOT NULL,
    item_kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    event_time_utc_msc INTEGER NOT NULL,
    ticket TEXT NULL,
    order_id TEXT NULL,
    position_id TEXT NULL,
    symbol TEXT NULL,
    funds_kind TEXT NULL,
    amount_text TEXT NULL,
    fact_json TEXT NOT NULL,
    source_revision TEXT NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    last_accessed_utc_msc INTEGER NOT NULL,
    PRIMARY KEY (profile_id, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_history_items_keyset
    ON history_items (profile_id, item_kind, event_time_utc_msc, item_id);
CREATE INDEX IF NOT EXISTS idx_history_items_refs
    ON history_items (profile_id, ticket, order_id, position_id);
CREATE TABLE IF NOT EXISTS coverage_ranges (
    profile_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    range_start_utc_msc INTEGER NOT NULL,
    range_end_utc_msc INTEGER NOT NULL,
    completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete', 'refreshing')),
    source_revision TEXT NULL,
    updated_at_utc_msc INTEGER NOT NULL,
    PRIMARY KEY (profile_id, resource, scope_key, range_start_utc_msc),
    CHECK (range_end_utc_msc > range_start_utc_msc)
);
CREATE INDEX IF NOT EXISTS idx_coverage_ranges_scope
    ON coverage_ranges (profile_id, resource, scope_key, range_start_utc_msc, range_end_utc_msc);
CREATE TABLE IF NOT EXISTS server_coverage_acks (
    profile_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    range_start_utc_msc INTEGER NOT NULL,
    range_end_utc_msc INTEGER NOT NULL,
    source_revision TEXT NOT NULL,
    acked_at_utc_msc INTEGER NOT NULL,
    PRIMARY KEY (profile_id, resource, scope_key, range_start_utc_msc, range_end_utc_msc, source_revision),
    CHECK (range_end_utc_msc > range_start_utc_msc)
);
CREATE INDEX IF NOT EXISTS idx_server_coverage_acks_range
    ON server_coverage_acks (profile_id, resource, scope_key, range_start_utc_msc, range_end_utc_msc);
CREATE TABLE IF NOT EXISTS query_snapshots (
    profile_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    frozen_revision TEXT NULL,
    range_start_utc_msc INTEGER NOT NULL,
    range_end_utc_msc INTEGER NOT NULL,
    created_at_utc_msc INTEGER NOT NULL,
    expires_at_utc_msc INTEGER NOT NULL,
    PRIMARY KEY (profile_id, snapshot_id),
    CHECK (range_end_utc_msc > range_start_utc_msc),
    CHECK (expires_at_utc_msc > created_at_utc_msc)
);
CREATE INDEX IF NOT EXISTS idx_query_snapshots_active
    ON query_snapshots (profile_id, resource, scope_key, expires_at_utc_msc, range_start_utc_msc, range_end_utc_msc);
";

        // Keep this as a separate append-only migration. Never edit MigrationSql
        // after it has been released: its checksum is part of the on-disk contract.
        private const string MigrationV2Sql = @"
ALTER TABLE query_snapshots ADD COLUMN connection_epoch INTEGER;
CREATE INDEX IF NOT EXISTS idx_query_snapshots_active_epoch
    ON query_snapshots (profile_id, connection_epoch, resource, scope_key, expires_at_utc_msc, range_start_utc_msc, range_end_utc_msc);
CREATE TABLE IF NOT EXISTS stream_state (
    profile_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    revision TEXT NULL,
    payload_hash TEXT NULL,
    source_time_utc_msc INTEGER NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('live', 'stale', 'offline', 'unknown')),
    PRIMARY KEY (profile_id, resource)
);
CREATE INDEX IF NOT EXISTS idx_stream_state_status
    ON stream_state (profile_id, status, observed_at_utc_msc);
CREATE TABLE IF NOT EXISTS account_latest (
    profile_id TEXT PRIMARY KEY,
    connection_epoch INTEGER NOT NULL,
    revision TEXT NULL,
    account_number TEXT NULL,
    currency TEXT NULL,
    balance_text TEXT NULL,
    equity_text TEXT NULL,
    margin_text TEXT NULL,
    free_margin_text TEXT NULL,
    margin_level_text TEXT NULL,
    profit_text TEXT NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    fact_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions_latest (
    profile_id TEXT NOT NULL,
    ticket TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    revision TEXT NOT NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    volume_text TEXT NOT NULL,
    open_price_text TEXT NULL,
    stop_loss_text TEXT NULL,
    take_profit_text TEXT NULL,
    current_price_text TEXT NULL,
    profit_text TEXT NULL,
    fact_json TEXT NOT NULL,
    PRIMARY KEY (profile_id, ticket)
);
CREATE INDEX IF NOT EXISTS idx_positions_latest_revision
    ON positions_latest (profile_id, connection_epoch, revision, observed_at_utc_msc);
CREATE INDEX IF NOT EXISTS idx_positions_latest_cleanup
    ON positions_latest (profile_id, connection_epoch, observed_at_utc_msc);
CREATE TABLE IF NOT EXISTS pending_orders_latest (
    profile_id TEXT NOT NULL,
    ticket TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    revision TEXT NOT NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    order_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    volume_text TEXT NOT NULL,
    requested_price_text TEXT NULL,
    stop_loss_text TEXT NULL,
    take_profit_text TEXT NULL,
    fact_json TEXT NOT NULL,
    PRIMARY KEY (profile_id, ticket)
);
CREATE INDEX IF NOT EXISTS idx_pending_orders_latest_revision
    ON pending_orders_latest (profile_id, connection_epoch, revision, observed_at_utc_msc);
CREATE INDEX IF NOT EXISTS idx_pending_orders_latest_cleanup
    ON pending_orders_latest (profile_id, connection_epoch, observed_at_utc_msc);
CREATE TABLE IF NOT EXISTS instrument_cache (
    profile_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    terminal_build INTEGER NOT NULL,
    spec_revision TEXT NULL,
    observed_at_utc_msc INTEGER NOT NULL,
    last_accessed_utc_msc INTEGER NOT NULL,
    expires_at_utc_msc INTEGER NOT NULL,
    fact_json TEXT NOT NULL,
    PRIMARY KEY (profile_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_instrument_cache_expiry
    ON instrument_cache (profile_id, expires_at_utc_msc, last_accessed_utc_msc, symbol);
CREATE TABLE IF NOT EXISTS sync_jobs (
    profile_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    resource TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    range_start_utc_msc INTEGER NOT NULL,
    range_end_utc_msc INTEGER NOT NULL,
    cursor TEXT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'retry_wait', 'completed', 'blocked', 'superseded')),
    lease_owner TEXT NULL,
    lease_expires_at_utc_msc INTEGER NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_utc_msc INTEGER NOT NULL,
    last_error_code TEXT NULL,
    last_error_detail TEXT NULL,
    created_at_utc_msc INTEGER NOT NULL,
    updated_at_utc_msc INTEGER NOT NULL,
    PRIMARY KEY (profile_id, job_id),
    CHECK (range_end_utc_msc > range_start_utc_msc),
    CHECK (attempt >= 0)
);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_claim
    ON sync_jobs (profile_id, state, next_attempt_at_utc_msc, lease_expires_at_utc_msc, updated_at_utc_msc, job_id);
CREATE TABLE IF NOT EXISTS outbox_messages (
    profile_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,
    message_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    priority INTEGER NOT NULL,
    next_attempt_at_utc_msc INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    acked_at_utc_msc INTEGER NULL,
    created_at_utc_msc INTEGER NOT NULL,
    last_error_code TEXT NULL,
    last_error_detail TEXT NULL,
    PRIMARY KEY (profile_id, message_id),
    CHECK (attempt >= 0)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox_messages (profile_id, acked_at_utc_msc, next_attempt_at_utc_msc, priority, created_at_utc_msc, message_id);
CREATE TABLE IF NOT EXISTS maintenance_state (
    profile_id TEXT PRIMARY KEY,
    last_cleanup_at_utc_msc INTEGER NULL,
    last_checkpoint_at_utc_msc INTEGER NULL,
    last_disk_check_at_utc_msc INTEGER NULL,
    disk_used_bytes INTEGER NULL,
    disk_free_bytes INTEGER NULL,
    disk_watermark TEXT NULL,
    last_error_code TEXT NULL,
    last_error_at_utc_msc INTEGER NULL,
    cleanup_cursor INTEGER NOT NULL DEFAULT 0,
    updated_at_utc_msc INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS command_ledger (
    profile_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    action TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('recorded', 'accepted', 'succeeded', 'rejected', 'failed', 'uncertain')),
    accepted_at_utc_msc INTEGER NOT NULL,
    completed_at_utc_msc INTEGER NULL,
    result_json TEXT NULL,
    PRIMARY KEY (profile_id, idempotency_key),
    UNIQUE (profile_id, command_id)
);
CREATE INDEX IF NOT EXISTS idx_command_ledger_state
    ON command_ledger (profile_id, state, accepted_at_utc_msc);
";

        public static void Apply(SQLiteConnection connection)
        {
            using (SQLiteCommand command = connection.CreateCommand())
            {
                command.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at_utc_msc INTEGER NOT NULL);";
                command.ExecuteNonQuery();
            }

            using (SQLiteCommand latest = connection.CreateCommand())
            {
                latest.CommandText = "SELECT MAX(version) FROM schema_migrations";
                object value = latest.ExecuteScalar();
                if (value != null && value != DBNull.Value && Convert.ToInt32(value, CultureInfo.InvariantCulture) > LatestVersion)
                {
                    throw new InvalidDataException("bridge_cache_migration_version_newer");
                }
            }

            ApplyMigration(connection, 1, MigrationName, MigrationSql);
            ApplyMigration(connection, 2, MigrationV2Name, MigrationV2Sql);
        }

        private static void ApplyMigration(SQLiteConnection connection, int version, string name, string sql)
        {
            string checksum = ComputeChecksum(sql);
            using (SQLiteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable))
            {
                string existingName = null;
                string existingChecksum = null;
                using (SQLiteCommand select = connection.CreateCommand())
                {
                    select.Transaction = transaction;
                    select.CommandText = "SELECT name, checksum FROM schema_migrations WHERE version = @version LIMIT 1";
                    AddParameter(select, "@version", version);
                    using (SQLiteDataReader reader = select.ExecuteReader(CommandBehavior.SingleRow))
                    {
                        if (reader.Read())
                        {
                            existingName = reader.GetString(0);
                            existingChecksum = reader.GetString(1);
                        }
                    }
                }

                if (existingChecksum != null)
                {
                    if (!string.Equals(existingName, name, StringComparison.Ordinal))
                    {
                        throw new InvalidDataException("bridge_cache_migration_name_mismatch");
                    }
                    if (!string.Equals(existingChecksum, checksum, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("bridge_cache_migration_checksum_mismatch");
                    }
                }
                else
                {
                    using (SQLiteCommand apply = connection.CreateCommand())
                    {
                        apply.Transaction = transaction;
                        apply.CommandText = sql;
                        apply.ExecuteNonQuery();
                    }
                    using (SQLiteCommand insert = connection.CreateCommand())
                    {
                        insert.Transaction = transaction;
                        insert.CommandText = "INSERT INTO schema_migrations (version, name, checksum, applied_at_utc_msc) VALUES (@version, @name, @checksum, @applied_at)";
                        AddParameter(insert, "@version", version);
                        AddParameter(insert, "@name", name);
                        AddParameter(insert, "@checksum", checksum);
                        AddParameter(insert, "@applied_at", UtcNowMsc());
                        insert.ExecuteNonQuery();
                    }
                }
                transaction.Commit();
            }
        }

        public static string ComputeChecksumForTests()
        {
            return ComputeChecksum(MigrationSql);
        }

        private static long UtcNowMsc()
        {
            DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            return checked((DateTime.UtcNow.Ticks - epoch.Ticks) / TimeSpan.TicksPerMillisecond);
        }

        private static string ComputeChecksum(string text)
        {
            using (SHA256 sha256 = SHA256.Create())
            {
                byte[] bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(text));
                StringBuilder builder = new StringBuilder(bytes.Length * 2);
                for (int i = 0; i < bytes.Length; i++)
                {
                    builder.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString();
            }
        }

        private static void AddParameter(SQLiteCommand command, string name, object value)
        {
            SQLiteParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value;
            command.Parameters.Add(parameter);
        }
    }
}
