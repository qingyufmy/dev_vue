use bridge_contract::{CommandResultMessage, validate_id};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

pub const BRIDGE_DATABASE_FILE_NAME: &str = "bridge.db";

const REQUIRED_SCHEMA: &[(&str, &[&str])] = &[
    (
        "terminal_bindings",
        &[
            "terminal_instance_id",
            "platform",
            "terminal_path",
            "broker_server",
            "login_account",
            "connection_epoch",
            "updated_at_utc_msc",
        ],
    ),
    (
        "stream_revisions",
        &[
            "terminal_instance_id",
            "connection_epoch",
            "stream",
            "revision",
            "message_id",
            "payload_hash",
            "observed_at_utc_msc",
            "source_time_msc",
        ],
    ),
    (
        "account_latest",
        &[
            "terminal_instance_id",
            "connection_epoch",
            "revision",
            "observed_at_utc_msc",
            "source_time_msc",
            "payload_json",
        ],
    ),
    (
        "positions_latest",
        &[
            "terminal_instance_id",
            "ticket",
            "connection_epoch",
            "revision",
            "observed_at_utc_msc",
            "source_time_msc",
            "payload_json",
        ],
    ),
    (
        "orders_latest",
        &[
            "terminal_instance_id",
            "ticket",
            "connection_epoch",
            "revision",
            "observed_at_utc_msc",
            "source_time_msc",
            "payload_json",
        ],
    ),
    (
        "deals_pending",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "ticket",
            "connection_epoch",
            "revision",
            "deal_time_msc",
            "observed_at_utc_msc",
            "source_time_msc",
            "payload_json",
        ],
    ),
    (
        "history_cursors",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "stream",
            "cursor_value",
            "updated_at_utc_msc",
        ],
    ),
    (
        "outbox_messages",
        &[
            "id",
            "message_id",
            "message_type",
            "terminal_instance_id",
            "connection_epoch",
            "priority",
            "payload_json",
            "attempt_count",
            "next_attempt_at_utc_msc",
            "created_at_utc_msc",
            "acked_at_utc_msc",
        ],
    ),
    (
        "execution_receipts",
        &[
            "command_id",
            "terminal_instance_id",
            "connection_epoch",
            "status",
            "result_json",
            "completed_at_utc_msc",
        ],
    ),
    (
        "terminal_data_cache",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "connection_epoch",
            "action",
            "params_hash",
            "observed_at_utc_msc",
            "cached_at_utc_msc",
            "payload_json",
        ],
    ),
    (
        "module_versions",
        &["module_id", "version", "content_hash", "updated_at_utc_msc"],
    ),
    (
        "update_state",
        &[
            "id",
            "active_version",
            "staged_version",
            "last_known_good_version",
            "status",
            "updated_at_utc_msc",
        ],
    ),
    (
        "history_archive_items",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "platform",
            "item_kind",
            "item_id",
            "event_time_msc",
            "position_id",
            "order_ticket",
            "symbol",
            "payload_json",
            "updated_at_utc_msc",
        ],
    ),
    (
        "history_archive_state",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "cursor_value",
            "is_complete",
            "updated_at_utc_msc",
        ],
    ),
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaCompatibilityStatus {
    NotPresent,
    Compatible,
    Incompatible,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SchemaCompatibilityReport {
    pub status: SchemaCompatibilityStatus,
    pub journal_mode: Option<String>,
    pub quick_check_ok: bool,
    pub missing_tables: Vec<String>,
    pub missing_columns: Vec<String>,
}

impl SchemaCompatibilityReport {
    pub fn is_compatible(&self) -> bool {
        matches!(
            self.status,
            SchemaCompatibilityStatus::NotPresent | SchemaCompatibilityStatus::Compatible
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoreError {
    code: &'static str,
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl Display for StoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for StoreError {}

pub fn inspect_existing_schema(
    path: impl AsRef<Path>,
) -> Result<SchemaCompatibilityReport, StoreError> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(SchemaCompatibilityReport {
            status: SchemaCompatibilityStatus::NotPresent,
            journal_mode: None,
            quick_check_ok: true,
            missing_tables: Vec::new(),
            missing_columns: Vec::new(),
        });
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| StoreError::new("bridge_store_open_failed"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| StoreError::new("bridge_store_busy_timeout_failed"))?;

    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .map_err(|_| StoreError::new("bridge_store_journal_mode_failed"))?;
    let quick_check: String = connection
        .query_row("PRAGMA quick_check(1);", [], |row| row.get(0))
        .map_err(|_| StoreError::new("bridge_store_quick_check_failed"))?;
    let quick_check_ok = quick_check.eq_ignore_ascii_case("ok");

    let mut missing_tables = Vec::new();
    let mut missing_columns = Vec::new();
    for (table, required_columns) in REQUIRED_SCHEMA {
        if !table_exists(&connection, table)? {
            missing_tables.push((*table).to_owned());
            continue;
        }
        let columns = table_columns(&connection, table)?;
        for column in *required_columns {
            if !columns.iter().any(|existing| existing == column) {
                missing_columns.push(format!("{table}.{column}"));
            }
        }
    }
    let compatible = quick_check_ok
        && journal_mode.eq_ignore_ascii_case("wal")
        && missing_tables.is_empty()
        && missing_columns.is_empty();
    Ok(SchemaCompatibilityReport {
        status: if compatible {
            SchemaCompatibilityStatus::Compatible
        } else {
            SchemaCompatibilityStatus::Incompatible
        },
        journal_mode: Some(journal_mode),
        quick_check_ok,
        missing_tables,
        missing_columns,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboxRecord {
    pub id: i64,
    pub message_id: String,
    pub message_type: String,
    pub terminal_instance_id: String,
    pub connection_epoch: i64,
    pub priority: String,
    pub payload_json: String,
    pub attempt_count: i64,
    pub created_at_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewOutboxRecord {
    pub message_id: String,
    pub message_type: String,
    pub terminal_instance_id: String,
    pub connection_epoch: i64,
    pub priority: String,
    pub payload_json: String,
    pub created_at_utc_msc: i64,
}

pub struct OutboxStore {
    connection: Mutex<Connection>,
}

impl OutboxStore {
    pub fn open_existing(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        let report = inspect_existing_schema(path)?;
        if report.status != SchemaCompatibilityStatus::Compatible {
            return Err(StoreError::new("bridge_store_schema_incompatible"));
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| StoreError::new("bridge_store_open_failed"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| StoreError::new("bridge_store_busy_timeout_failed"))?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| StoreError::new("bridge_store_synchronous_failed"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn enqueue(&self, record: &NewOutboxRecord) -> Result<bool, StoreError> {
        validate_new_outbox_record(record)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .execute(
                "INSERT INTO outbox_messages (\
                   message_id, message_type, terminal_instance_id, connection_epoch, priority, \
                   payload_json, attempt_count, next_attempt_at_utc_msc, created_at_utc_msc, acked_at_utc_msc\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, NULL)\
                 ON CONFLICT(message_id) DO NOTHING;",
                params![
                    record.message_id,
                    record.message_type,
                    record.terminal_instance_id,
                    record.connection_epoch,
                    record.priority,
                    record.payload_json,
                    record.created_at_utc_msc,
                ],
            )
            .map(|affected| affected == 1)
            .map_err(|_| StoreError::new("bridge_store_outbox_enqueue_failed"))
    }

    pub fn ready_for_terminals(
        &self,
        now_utc_msc: i64,
        terminal_instance_ids: Option<&[String]>,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, StoreError> {
        if now_utc_msc <= 0 || !(1..=1_000).contains(&limit) {
            return Err(StoreError::new("bridge_store_outbox_query_invalid"));
        }
        if terminal_instance_ids.is_some_and(|values| values.is_empty()) {
            return Ok(Vec::new());
        }
        let mut values = vec![SqlValue::Integer(now_utc_msc)];
        let terminal_filter = terminal_instance_ids
            .map(|identifiers| {
                values.extend(identifiers.iter().cloned().map(SqlValue::Text));
                format!(
                    " AND terminal_instance_id IN ({})",
                    (0..identifiers.len())
                        .map(|index| format!("?{}", index + 2))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
            .unwrap_or_default();
        values.push(SqlValue::Integer(limit as i64));
        let limit_parameter = values.len();
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT id, message_id, message_type, terminal_instance_id, connection_epoch, \
                        priority, payload_json, attempt_count, created_at_utc_msc \
                 FROM outbox_messages \
                 WHERE acked_at_utc_msc IS NULL \
                   AND (next_attempt_at_utc_msc IS NULL OR next_attempt_at_utc_msc <= ?1) \
                   {terminal_filter} \
                 ORDER BY CASE priority WHEN 'trade' THEN 0 ELSE 1 END, id \
                 LIMIT ?{limit_parameter};"
            ))
            .map_err(|_| StoreError::new("bridge_store_outbox_query_failed"))?;
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                Ok(OutboxRecord {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    message_type: row.get(2)?,
                    terminal_instance_id: row.get(3)?,
                    connection_epoch: row.get(4)?,
                    priority: row.get(5)?,
                    payload_json: row.get(6)?,
                    attempt_count: row.get(7)?,
                    created_at_utc_msc: row.get(8)?,
                })
            })
            .map_err(|_| StoreError::new("bridge_store_outbox_query_failed"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoreError::new("bridge_store_outbox_query_failed"))
    }

    pub fn record_attempt(
        &self,
        message_id: &str,
        expected_attempt_count: i64,
        next_attempt_at_utc_msc: i64,
    ) -> Result<bool, StoreError> {
        if message_id.trim().is_empty()
            || expected_attempt_count < 0
            || next_attempt_at_utc_msc <= 0
        {
            return Err(StoreError::new("bridge_store_outbox_attempt_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .execute(
                "UPDATE outbox_messages \
                 SET attempt_count = attempt_count + 1, next_attempt_at_utc_msc = ?1 \
                 WHERE message_id = ?2 AND acked_at_utc_msc IS NULL AND attempt_count = ?3;",
                params![next_attempt_at_utc_msc, message_id, expected_attempt_count],
            )
            .map(|affected| affected == 1)
            .map_err(|_| StoreError::new("bridge_store_outbox_attempt_failed"))
    }

    pub fn pending(&self, message_id: &str) -> Result<Option<OutboxRecord>, StoreError> {
        if message_id.trim().is_empty() {
            return Err(StoreError::new("bridge_store_outbox_query_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .query_row(
                "SELECT id, message_id, message_type, terminal_instance_id, connection_epoch, \
                        priority, payload_json, attempt_count, created_at_utc_msc \
                 FROM outbox_messages \
                 WHERE message_id = ?1 AND acked_at_utc_msc IS NULL \
                 LIMIT 1;",
                [message_id],
                |row| {
                    Ok(OutboxRecord {
                        id: row.get(0)?,
                        message_id: row.get(1)?,
                        message_type: row.get(2)?,
                        terminal_instance_id: row.get(3)?,
                        connection_epoch: row.get(4)?,
                        priority: row.get(5)?,
                        payload_json: row.get(6)?,
                        attempt_count: row.get(7)?,
                        created_at_utc_msc: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_outbox_query_failed"))
    }

    pub fn acknowledge(
        &self,
        message_id: &str,
        acknowledgement_status: &str,
    ) -> Result<bool, StoreError> {
        if !matches!(acknowledgement_status, "applied" | "duplicate") {
            return Ok(false);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .execute(
                "DELETE FROM outbox_messages \
                 WHERE message_id = ?1 AND acked_at_utc_msc IS NULL;",
                [message_id],
            )
            .map(|affected| affected == 1)
            .map_err(|_| StoreError::new("bridge_store_outbox_ack_failed"))
    }

    pub fn execution_receipt(
        &self,
        command_id: &str,
    ) -> Result<Option<CommandResultMessage>, StoreError> {
        validate_id(command_id)
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_query_invalid"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let payload = connection
            .query_row(
                "SELECT result_json FROM execution_receipts WHERE command_id = ?1 LIMIT 1;",
                [command_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_query_failed"))?;
        payload
            .map(|payload| {
                let result: CommandResultMessage = serde_json::from_str(&payload)
                    .map_err(|_| StoreError::new("bridge_store_execution_receipt_invalid"))?;
                result
                    .validate()
                    .map_err(|_| StoreError::new("bridge_store_execution_receipt_invalid"))?;
                if result.command_id != command_id {
                    return Err(StoreError::new("bridge_store_execution_receipt_invalid"));
                }
                Ok(result)
            })
            .transpose()
    }

    pub fn save_execution_receipt(
        &self,
        result: &CommandResultMessage,
        receipt_limit: usize,
    ) -> Result<(), StoreError> {
        result
            .validate()
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_invalid"))?;
        let receipt_limit = receipt_limit.clamp(1, 100_000);
        let payload = serde_json::to_string(result)
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_invalid"))?;
        if payload.len() > 4 * 1024 * 1024 {
            return Err(StoreError::new("bridge_store_execution_receipt_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
        transaction
            .execute(
                "INSERT INTO execution_receipts (
                   command_id, terminal_instance_id, connection_epoch, status,
                   result_json, completed_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(command_id) DO UPDATE SET
                   terminal_instance_id = excluded.terminal_instance_id,
                   connection_epoch = excluded.connection_epoch,
                   status = excluded.status,
                   result_json = excluded.result_json,
                   completed_at_utc_msc = excluded.completed_at_utc_msc;",
                params![
                    result.command_id,
                    result.terminal_instance_id,
                    result.connection_epoch,
                    result.status,
                    payload,
                    result.completed_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
        transaction
            .execute(
                "INSERT INTO outbox_messages (
                   message_id, message_type, terminal_instance_id, connection_epoch, priority,
                   payload_json, created_at_utc_msc
                 ) VALUES (?1, 'command_result', ?2, ?3, 'trade', ?4, ?5)
                 ON CONFLICT(message_id) DO NOTHING;",
                params![
                    result.message_id,
                    result.terminal_instance_id,
                    result.connection_epoch,
                    payload,
                    result.sent_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
        transaction
            .execute(
                "DELETE FROM execution_receipts
                 WHERE command_id IN (
                   SELECT command_id FROM execution_receipts
                   ORDER BY completed_at_utc_msc DESC, command_id DESC
                   LIMIT -1 OFFSET ?1
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM outbox_messages pending
                   WHERE pending.acked_at_utc_msc IS NULL
                     AND pending.message_type = 'command_result'
                     AND json_valid(pending.payload_json) = 1
                     AND json_extract(pending.payload_json, '$.command_id') = execution_receipts.command_id
                 );",
                [receipt_limit as i64],
            )
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))
    }

    pub fn count_execution_receipts(&self) -> Result<usize, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .query_row("SELECT COUNT(*) FROM execution_receipts;", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| count.max(0) as usize)
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_query_failed"))
    }
}

fn validate_new_outbox_record(record: &NewOutboxRecord) -> Result<(), StoreError> {
    const MAXIMUM_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
    if record.message_id.trim().is_empty()
        || record.message_type.trim().is_empty()
        || record.terminal_instance_id.trim().is_empty()
        || record.connection_epoch <= 0
        || !matches!(record.priority.as_str(), "trade" | "data")
        || record.payload_json.len() > MAXIMUM_PAYLOAD_BYTES
        || record.created_at_utc_msc <= 0
        || !serde_json::from_str::<serde_json::Value>(&record.payload_json)
            .is_ok_and(|value| value.is_object())
    {
        return Err(StoreError::new("bridge_store_outbox_record_invalid"));
    }
    Ok(())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1);",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value == 1)
        .map_err(|_| StoreError::new("bridge_store_schema_query_failed"))
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, StoreError> {
    if !table
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(StoreError::new("bridge_store_table_name_invalid"));
    }
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table});"))
        .map_err(|_| StoreError::new("bridge_store_schema_query_failed"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| StoreError::new("bridge_store_schema_query_failed"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| StoreError::new("bridge_store_schema_query_failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn missing_database_is_safe_for_fresh_install() {
        let path = unique_test_directory("missing").join(BRIDGE_DATABASE_FILE_NAME);
        let report = inspect_existing_schema(path).expect("missing database report");
        assert_eq!(report.status, SchemaCompatibilityStatus::NotPresent);
        assert!(report.is_compatible());
    }

    #[test]
    fn v3_table_and_column_contract_is_compatible() {
        let root = unique_test_directory("compatible");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);

        let report = inspect_existing_schema(&path).expect("compatible schema");
        assert_eq!(report.status, SchemaCompatibilityStatus::Compatible);
        assert!(report.quick_check_ok);
        assert_eq!(report.journal_mode.as_deref(), Some("wal"));
        assert!(report.missing_tables.is_empty());
        assert!(report.missing_columns.is_empty());

        fs::remove_dir_all(root).expect("remove schema fixture");
    }

    #[test]
    fn required_schema_matches_the_current_csharp_v3_authority() {
        let csharp_sources = format!(
            "{}\n{}",
            include_str!("../../../../app/AurumBridge/Storage/BridgeStore.cs"),
            include_str!("../../../../app/AurumBridge/Storage/BridgeStore.History.cs")
        );
        for (table, expected_columns) in REQUIRED_SCHEMA {
            let actual_columns = extract_csharp_create_table_columns(&csharp_sources, table);
            assert_eq!(
                actual_columns, *expected_columns,
                "Rust compatibility contract drifted from C# table {table}"
            );
        }
    }

    #[test]
    fn missing_v3_column_fails_closed() {
        let root = unique_test_directory("incompatible");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, Some(("account_latest", "payload_json")));

        let report = inspect_existing_schema(&path).expect("incompatible schema");
        assert_eq!(report.status, SchemaCompatibilityStatus::Incompatible);
        assert_eq!(
            report.missing_columns,
            vec!["account_latest.payload_json".to_owned()]
        );

        fs::remove_dir_all(root).expect("remove schema fixture");
    }

    fn create_schema_fixture(path: &Path, omitted: Option<(&str, &str)>) {
        let connection = Connection::open(path).expect("fixture sqlite");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("fixture wal");
        for (table, columns) in REQUIRED_SCHEMA {
            if *table == "outbox_messages" && omitted.is_none() {
                connection
                    .execute_batch(
                        "CREATE TABLE outbox_messages (\
                           id INTEGER PRIMARY KEY AUTOINCREMENT,\
                           message_id TEXT NOT NULL UNIQUE,\
                           message_type TEXT NOT NULL,\
                           terminal_instance_id TEXT NOT NULL,\
                           connection_epoch INTEGER NOT NULL,\
                           priority TEXT NOT NULL,\
                           payload_json TEXT NOT NULL,\
                           attempt_count INTEGER NOT NULL DEFAULT 0,\
                           next_attempt_at_utc_msc INTEGER,\
                           created_at_utc_msc INTEGER NOT NULL,\
                           acked_at_utc_msc INTEGER\
                         );",
                    )
                    .expect("fixture outbox table");
                continue;
            }
            if *table == "execution_receipts" && omitted.is_none() {
                connection
                    .execute_batch(
                        "CREATE TABLE execution_receipts (\
                           command_id TEXT PRIMARY KEY,\
                           terminal_instance_id TEXT NOT NULL,\
                           connection_epoch INTEGER NOT NULL,\
                           status TEXT NOT NULL,\
                           result_json TEXT NOT NULL,\
                           completed_at_utc_msc INTEGER NOT NULL\
                         );",
                    )
                    .expect("fixture execution receipts table");
                continue;
            }
            let definitions = columns
                .iter()
                .filter(|column| omitted != Some((table, **column)))
                .map(|column| format!("{column} TEXT"))
                .collect::<Vec<_>>()
                .join(", ");
            connection
                .execute_batch(&format!("CREATE TABLE {table} ({definitions});"))
                .expect("fixture table");
        }
    }

    #[test]
    fn native_outbox_preserves_v3_priority_retry_and_ack_semantics() {
        let root = unique_test_directory("native-outbox");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        let store = OutboxStore::open_existing(&path).expect("outbox store");
        let data = NewOutboxRecord {
            message_id: "data_01JTEST0001".to_owned(),
            message_type: "data_delta".to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            connection_epoch: 1,
            priority: "data".to_owned(),
            payload_json: "{\"v\":3,\"type\":\"data_delta\"}".to_owned(),
            created_at_utc_msc: 1_700_000_000_000,
        };
        let trade = NewOutboxRecord {
            message_id: "result_01JTEST01".to_owned(),
            message_type: "command_result".to_owned(),
            priority: "trade".to_owned(),
            payload_json: "{\"v\":3,\"type\":\"command_result\"}".to_owned(),
            ..data.clone()
        };
        assert!(store.enqueue(&data).expect("enqueue data"));
        assert!(store.enqueue(&trade).expect("enqueue trade"));
        assert!(!store.enqueue(&trade).expect("duplicate is idempotent"));

        let ready = store
            .ready_for_terminals(1_700_000_000_001, None, 10)
            .expect("ready");
        assert_eq!(
            ready
                .iter()
                .map(|record| record.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["result_01JTEST01", "data_01JTEST0001"]
        );
        assert!(
            store
                .record_attempt("result_01JTEST01", 0, 1_700_000_002_000)
                .expect("attempt")
        );
        let ready = store
            .ready_for_terminals(1_700_000_000_001, None, 10)
            .expect("deferred ready");
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].message_id, "data_01JTEST0001");
        assert!(
            !store
                .acknowledge("data_01JTEST0001", "gap")
                .expect("gap retained")
        );
        assert!(
            store
                .acknowledge("data_01JTEST0001", "applied")
                .expect("applied removed")
        );
        assert!(
            store
                .acknowledge("result_01JTEST01", "duplicate")
                .expect("duplicate removed")
        );
        assert!(
            store
                .ready_for_terminals(1_700_000_100_000, None, 10)
                .expect("empty")
                .is_empty()
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove outbox fixture");
    }

    fn command_result(
        command_id: &str,
        message_id: &str,
        completed_at: i64,
    ) -> CommandResultMessage {
        CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: message_id.to_owned(),
            sent_at_utc_msc: completed_at,
            command_id: command_id.to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            status: "succeeded".to_owned(),
            completed_at_utc_msc: completed_at,
            error_code: None,
            error_message: None,
            raw_result: Some(serde_json::json!({ "retcode": 10009 })),
            evidence: bridge_contract::ExecutionEvidence {
                observed_at_utc_msc: completed_at,
                order_tickets: vec!["1001".to_owned()],
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: Some(10009),
            },
        }
    }

    #[test]
    fn execution_receipt_and_trade_outbox_commit_atomically_and_trim_only_acknowledged_rows() {
        let root = unique_test_directory("execution-receipts");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        let store = OutboxStore::open_existing(&path).expect("store");
        let first = command_result(
            "command_01JRECEIPT01",
            "result_01JRECEIPT001",
            1_700_000_000_001,
        );
        let second = command_result(
            "command_01JRECEIPT02",
            "result_01JRECEIPT002",
            1_700_000_000_002,
        );
        store
            .save_execution_receipt(&first, 1)
            .expect("first receipt");
        store
            .save_execution_receipt(&second, 1)
            .expect("second receipt");
        assert_eq!(store.count_execution_receipts().expect("count"), 2);
        assert_eq!(
            store
                .execution_receipt(&first.command_id)
                .expect("first")
                .expect("first receipt"),
            first
        );
        assert_eq!(
            store
                .pending(&second.message_id)
                .expect("second outbox")
                .expect("pending")
                .priority,
            "trade"
        );

        assert!(
            store
                .acknowledge(&first.message_id, "applied")
                .expect("ack first")
        );
        let third = command_result(
            "command_01JRECEIPT03",
            "result_01JRECEIPT003",
            1_700_000_000_003,
        );
        store
            .save_execution_receipt(&third, 1)
            .expect("third receipt");
        assert!(
            store
                .execution_receipt(&first.command_id)
                .expect("trimmed")
                .is_none()
        );
        assert_eq!(store.count_execution_receipts().expect("count"), 2);

        drop(store);
        fs::remove_dir_all(root).expect("remove receipt fixture");
    }

    fn extract_csharp_create_table_columns<'a>(source: &'a str, table: &str) -> Vec<&'a str> {
        let marker = format!("CREATE TABLE IF NOT EXISTS {table} (");
        let body = source
            .split_once(&marker)
            .unwrap_or_else(|| panic!("C# schema table missing: {table}"))
            .1
            .split_once("\n        );")
            .or_else(|| {
                source
                    .split_once(&marker)
                    .and_then(|(_, remainder)| remainder.split_once("\n            );"))
            })
            .unwrap_or_else(|| panic!("C# schema table terminator missing: {table}"))
            .0;
        body.lines()
            .map(str::trim)
            .take_while(|line| !line.starts_with("PRIMARY KEY"))
            .filter(|line| !line.is_empty())
            .map(|line| {
                line.split_ascii_whitespace()
                    .next()
                    .expect("C# schema column")
                    .trim_end_matches(',')
            })
            .collect()
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-store-{}-{}-{suffix}",
            std::process::id(),
            stamp
        ))
    }
}
