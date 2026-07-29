use bridge_contract::{
    AccountRef, CommandMessage, CommandResultMessage, DataDeltaMessage, validate_id,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params, params_from_iter};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

pub const BRIDGE_DATABASE_FILE_NAME: &str = "bridge.db";
const DEFAULT_DATA_OUTBOX_LIMIT_PER_STREAM: i64 = 256;

pub const REQUIRED_SCHEMA: &[(&str, &[&str])] = &[
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandLedgerRecord {
    pub command_id: String,
    pub payload_json: String,
    pub status: String,
    pub result_message_id: Option<String>,
    pub created_at_utc_msc: i64,
    pub updated_at_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedCommand {
    pub created: bool,
    pub record: CommandLedgerRecord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PersistDeltaStatus {
    Applied,
    Duplicate,
    Gap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PersistDeltaResult {
    pub status: PersistDeltaStatus,
    pub current_revision: i64,
    pub next_revision: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredStreamProjection {
    pub revision: i64,
    pub items: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredTerminalProjection {
    pub account: StoredStreamProjection,
    pub positions: StoredStreamProjection,
    pub orders: StoredStreamProjection,
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
        ensure_native_command_ledger_schema(&connection)?;
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

    pub fn persist_data_delta(
        &self,
        message: &DataDeltaMessage,
    ) -> Result<PersistDeltaResult, StoreError> {
        message
            .validate()
            .map_err(|_| StoreError::new("bridge_store_data_delta_invalid"))?;
        if !matches!(message.stream.as_str(), "account" | "positions" | "orders") {
            return Err(StoreError::new("bridge_store_data_stream_not_implemented"));
        }
        let original_payload_json = serde_json::to_string(message)
            .map_err(|_| StoreError::new("bridge_store_data_serialize_failed"))?;
        if original_payload_json.len() > 4 * 1024 * 1024 {
            return Err(StoreError::new("bridge_store_data_payload_too_large"));
        }
        let payload_hash = format!("{:x}", Sha256::digest(original_payload_json.as_bytes()));
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_data_transaction_failed"))?;
        let current = transaction
            .query_row(
                "SELECT revision, message_id, payload_hash FROM stream_revisions \
                 WHERE terminal_instance_id = ?1 AND connection_epoch = ?2 AND stream = ?3;",
                params![
                    message.terminal_instance_id,
                    message.connection_epoch,
                    message.stream
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_data_revision_query_failed"))?;
        let current_revision = current.as_ref().map_or(0, |value| value.0);
        if message.revision == current_revision {
            let Some((_, current_message_id, current_hash)) = current else {
                return Err(StoreError::new("bridge_store_data_revision_conflict"));
            };
            if current_message_id != message.message_id || current_hash != payload_hash {
                return Err(StoreError::new("bridge_store_data_revision_conflict"));
            }
            return Ok(PersistDeltaResult {
                status: PersistDeltaStatus::Duplicate,
                current_revision,
                next_revision: current_revision + 1,
            });
        }
        if message.revision < current_revision
            || (!message.full_snapshot && message.base_revision != current_revision)
        {
            return Ok(PersistDeltaResult {
                status: PersistDeltaStatus::Gap,
                current_revision,
                next_revision: current_revision + 1,
            });
        }
        persist_latest_stream(&transaction, message)?;
        transaction
            .execute(
                "INSERT INTO stream_revisions (\
                   terminal_instance_id, connection_epoch, stream, revision, message_id, payload_hash,\
                   observed_at_utc_msc, source_time_msc\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)\
                 ON CONFLICT(terminal_instance_id, connection_epoch, stream) DO UPDATE SET \
                   revision = excluded.revision, message_id = excluded.message_id,\
                   payload_hash = excluded.payload_hash, observed_at_utc_msc = excluded.observed_at_utc_msc,\
                   source_time_msc = excluded.source_time_msc;",
                params![
                    message.terminal_instance_id,
                    message.connection_epoch,
                    message.stream,
                    message.revision,
                    message.message_id,
                    payload_hash,
                    message.observed_at_utc_msc,
                    message.source_time_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_data_revision_write_failed"))?;
        let pending_for_stream = transaction
            .query_row(
                "SELECT COUNT(*) FROM outbox_messages \
                 WHERE acked_at_utc_msc IS NULL AND message_type = 'data_delta' \
                   AND terminal_instance_id = ?1 AND connection_epoch = ?2 \
                   AND json_valid(payload_json) = 1 \
                   AND json_extract(payload_json, '$.stream') = ?3;",
                params![
                    message.terminal_instance_id,
                    message.connection_epoch,
                    message.stream
                ],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| StoreError::new("bridge_store_data_outbox_query_failed"))?;
        let compact =
            message.full_snapshot || pending_for_stream >= DEFAULT_DATA_OUTBOX_LIMIT_PER_STREAM - 1;
        let payload_json = if compact && !message.full_snapshot {
            let mut full_snapshot = message.clone();
            full_snapshot.base_revision = 0;
            full_snapshot.full_snapshot = true;
            full_snapshot.upserts = read_latest_stream(&transaction, message)?;
            full_snapshot.deletes.clear();
            serde_json::to_string(&full_snapshot)
                .map_err(|_| StoreError::new("bridge_store_data_serialize_failed"))?
        } else {
            original_payload_json
        };
        if compact {
            transaction
                .execute(
                    "DELETE FROM outbox_messages \
                     WHERE acked_at_utc_msc IS NULL AND message_type = 'data_delta' \
                       AND terminal_instance_id = ?1 AND connection_epoch = ?2 \
                       AND json_valid(payload_json) = 1 \
                       AND json_extract(payload_json, '$.stream') = ?3;",
                    params![
                        message.terminal_instance_id,
                        message.connection_epoch,
                        message.stream
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_data_outbox_compact_failed"))?;
        }
        transaction
            .execute(
                "INSERT INTO outbox_messages (\
                   message_id, message_type, terminal_instance_id, connection_epoch, priority,\
                   payload_json, attempt_count, next_attempt_at_utc_msc, created_at_utc_msc, acked_at_utc_msc\
                 ) VALUES (?1, 'data_delta', ?2, ?3, 'data', ?4, 0, NULL, ?5, NULL);",
                params![
                    message.message_id,
                    message.terminal_instance_id,
                    message.connection_epoch,
                    payload_json,
                    message.sent_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_data_outbox_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_data_commit_failed"))?;
        Ok(PersistDeltaResult {
            status: PersistDeltaStatus::Applied,
            current_revision: message.revision,
            next_revision: message.revision + 1,
        })
    }

    pub fn load_terminal_projection(
        &self,
        terminal_instance_id: &str,
        account_ref: &AccountRef,
        connection_epoch: i64,
    ) -> Result<StoredTerminalProjection, StoreError> {
        if validate_id(terminal_instance_id).is_err()
            || account_ref.validate().is_err()
            || connection_epoch <= 0
        {
            return Err(StoreError::new("bridge_store_projection_route_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let account = load_stored_stream(
            &connection,
            terminal_instance_id,
            connection_epoch,
            "account",
        )?;
        let positions = load_stored_stream(
            &connection,
            terminal_instance_id,
            connection_epoch,
            "positions",
        )?;
        let orders = load_stored_stream(
            &connection,
            terminal_instance_id,
            connection_epoch,
            "orders",
        )?;
        if account.items.len() > 1 {
            return Err(StoreError::new("bridge_store_projection_account_invalid"));
        }
        if let Some(value) = account.items.first() {
            let Some(object) = value.as_object() else {
                return Err(StoreError::new("bridge_store_projection_account_invalid"));
            };
            let login_matches = object.get("login").is_some_and(|value| {
                value.as_str() == Some(account_ref.login.as_str())
                    || value
                        .as_u64()
                        .is_some_and(|login| login.to_string() == account_ref.login)
            });
            let server_matches = object
                .get("server")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|server| server == account_ref.broker_server);
            if !login_matches || !server_matches {
                return Err(StoreError::new(
                    "bridge_store_projection_account_route_mismatch",
                ));
            }
        }
        Ok(StoredTerminalProjection {
            account,
            positions,
            orders,
        })
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

    pub fn acknowledge_command_result(
        &self,
        message_id: &str,
        command_id: &str,
        acknowledgement_status: &str,
        acknowledged_at_utc_msc: i64,
    ) -> Result<bool, StoreError> {
        if !matches!(acknowledgement_status, "applied" | "duplicate") {
            return Ok(false);
        }
        if acknowledged_at_utc_msc <= 0
            || validate_id(message_id).is_err()
            || validate_id(command_id).is_err()
        {
            return Err(StoreError::new("bridge_store_command_ack_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_command_ack_failed"))?;
        let receipt_matches = transaction
            .query_row(
                "SELECT EXISTS (
                   SELECT 1 FROM execution_receipts
                   WHERE command_id = ?1
                     AND json_valid(result_json) = 1
                     AND json_extract(result_json, '$.message_id') = ?2
                 );",
                params![command_id, message_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| StoreError::new("bridge_store_command_ack_failed"))?
            == 1;
        if !receipt_matches {
            return Err(StoreError::new("bridge_store_command_ack_unknown"));
        }
        let ledger = transaction
            .query_row(
                "SELECT status, result_message_id
                 FROM native_command_ledger WHERE command_id = ?1 LIMIT 1;",
                [command_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_command_ack_failed"))?;
        if ledger.as_ref().is_some_and(|(status, result_message_id)| {
            !matches!(status.as_str(), "confirmed" | "uncertain" | "acked")
                || result_message_id.as_deref() != Some(message_id)
        }) {
            return Err(StoreError::new("bridge_store_command_ack_mismatch"));
        }
        transaction
            .execute(
                "DELETE FROM outbox_messages
                 WHERE message_id = ?1
                   AND message_type = 'command_result'
                   AND acked_at_utc_msc IS NULL;",
                [message_id],
            )
            .map_err(|_| StoreError::new("bridge_store_command_ack_failed"))?;
        transaction
            .execute(
                "UPDATE native_command_ledger
                 SET status = 'acked', updated_at_utc_msc = ?3
                 WHERE command_id = ?1
                   AND result_message_id = ?2
                   AND status IN ('confirmed', 'uncertain', 'acked');",
                params![command_id, message_id, acknowledged_at_utc_msc],
            )
            .map_err(|_| StoreError::new("bridge_store_command_ack_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_command_ack_failed"))?;
        Ok(true)
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
        let existing_receipt = transaction
            .query_row(
                "SELECT result_json FROM execution_receipts WHERE command_id = ?1 LIMIT 1;",
                [&result.command_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
        if let Some(existing) = existing_receipt {
            if existing == payload {
                return Ok(());
            }
            return Err(StoreError::new("bridge_store_execution_receipt_conflict"));
        }
        transaction
            .execute(
                "INSERT INTO execution_receipts (
                   command_id, terminal_instance_id, connection_epoch, status,
                   result_json, completed_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
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
        let outbox_inserted = transaction
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
        if outbox_inserted == 0 {
            let matching_outbox = transaction
                .query_row(
                    "SELECT EXISTS (
                       SELECT 1 FROM outbox_messages
                       WHERE message_id = ?1
                         AND message_type = 'command_result'
                         AND payload_json = ?2
                     );",
                    params![result.message_id, payload],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?
                == 1;
            if !matching_outbox {
                return Err(StoreError::new("bridge_store_execution_receipt_conflict"));
            }
        }
        transaction
            .execute(
                "UPDATE native_command_ledger
                 SET status = ?2, result_message_id = ?3, updated_at_utc_msc = ?4
                 WHERE command_id = ?1
                   AND status IN ('persisted', 'dispatched', 'uncertain');",
                params![
                    result.command_id,
                    if result.status == "uncertain" {
                        "uncertain"
                    } else {
                        "confirmed"
                    },
                    result.message_id,
                    result.completed_at_utc_msc,
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

    pub fn record_command(
        &self,
        command: &CommandMessage,
        now_utc_msc: i64,
    ) -> Result<RecordedCommand, StoreError> {
        if now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_command_invalid"));
        }
        command
            .validate(command.issued_at_utc_msc.saturating_sub(1))
            .map_err(|_| StoreError::new("bridge_store_command_invalid"))?;
        let payload_json = serde_json::to_string(command)
            .map_err(|_| StoreError::new("bridge_store_command_invalid"))?;
        if payload_json.len() > 4 * 1024 * 1024 {
            return Err(StoreError::new("bridge_store_command_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let affected = connection
            .execute(
                "INSERT INTO native_command_ledger (
                   command_id, payload_json, status, result_message_id,
                   created_at_utc_msc, updated_at_utc_msc
                 ) VALUES (?1, ?2, 'persisted', NULL, ?3, ?3)
                 ON CONFLICT(command_id) DO NOTHING;",
                params![command.command_id, payload_json, now_utc_msc],
            )
            .map_err(|_| StoreError::new("bridge_store_command_write_failed"))?;
        let record = read_command_ledger_record(&connection, &command.command_id)?
            .ok_or_else(|| StoreError::new("bridge_store_command_write_failed"))?;
        if record.payload_json != payload_json {
            return Err(StoreError::new("bridge_command_id_conflict"));
        }
        Ok(RecordedCommand {
            created: affected == 1,
            record,
        })
    }

    pub fn command_ledger(
        &self,
        command_id: &str,
    ) -> Result<Option<CommandLedgerRecord>, StoreError> {
        validate_id(command_id)
            .map_err(|_| StoreError::new("bridge_store_command_query_invalid"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        read_command_ledger_record(&connection, command_id)
    }

    pub fn mark_command_dispatched(
        &self,
        command_id: &str,
        now_utc_msc: i64,
    ) -> Result<(), StoreError> {
        if now_utc_msc <= 0 || validate_id(command_id).is_err() {
            return Err(StoreError::new("bridge_store_command_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let affected = connection
            .execute(
                "UPDATE native_command_ledger
                 SET status = 'dispatched', updated_at_utc_msc = ?2
                 WHERE command_id = ?1 AND status = 'persisted';",
                params![command_id, now_utc_msc],
            )
            .map_err(|_| StoreError::new("bridge_store_command_write_failed"))?;
        if affected == 1 {
            return Ok(());
        }
        match read_command_ledger_record(&connection, command_id)? {
            None => Err(StoreError::new("bridge_store_command_unknown")),
            Some(_) => Err(StoreError::new("bridge_command_reconciliation_required")),
        }
    }
}

fn ensure_native_command_ledger_schema(connection: &Connection) -> Result<(), StoreError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS native_command_ledger (
               command_id TEXT PRIMARY KEY,
               payload_json TEXT NOT NULL,
               status TEXT NOT NULL CHECK (
                 status IN ('persisted', 'dispatched', 'confirmed', 'uncertain', 'acked')
               ),
               result_message_id TEXT,
               created_at_utc_msc INTEGER NOT NULL,
               updated_at_utc_msc INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_native_command_ledger_status
               ON native_command_ledger (status, updated_at_utc_msc);",
        )
        .map_err(|_| StoreError::new("bridge_store_command_schema_failed"))
}

fn read_command_ledger_record(
    connection: &Connection,
    command_id: &str,
) -> Result<Option<CommandLedgerRecord>, StoreError> {
    connection
        .query_row(
            "SELECT command_id, payload_json, status, result_message_id,
                    created_at_utc_msc, updated_at_utc_msc
             FROM native_command_ledger WHERE command_id = ?1 LIMIT 1;",
            [command_id],
            |row| {
                Ok(CommandLedgerRecord {
                    command_id: row.get(0)?,
                    payload_json: row.get(1)?,
                    status: row.get(2)?,
                    result_message_id: row.get(3)?,
                    created_at_utc_msc: row.get(4)?,
                    updated_at_utc_msc: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_command_query_failed"))
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

fn persist_latest_stream(
    transaction: &Transaction<'_>,
    message: &DataDeltaMessage,
) -> Result<(), StoreError> {
    if message.stream == "account" {
        let payload = serde_json::to_string(&message.upserts[0])
            .map_err(|_| StoreError::new("bridge_store_data_serialize_failed"))?;
        transaction
            .execute(
                "INSERT INTO account_latest (\
                   terminal_instance_id, connection_epoch, revision, observed_at_utc_msc, source_time_msc, payload_json\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)\
                 ON CONFLICT(terminal_instance_id) DO UPDATE SET \
                   connection_epoch = excluded.connection_epoch, revision = excluded.revision,\
                   observed_at_utc_msc = excluded.observed_at_utc_msc,\
                   source_time_msc = excluded.source_time_msc, payload_json = excluded.payload_json;",
                params![
                    message.terminal_instance_id,
                    message.connection_epoch,
                    message.revision,
                    message.observed_at_utc_msc,
                    message.source_time_msc,
                    payload,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_account_write_failed"))?;
        return Ok(());
    }

    let table = match message.stream.as_str() {
        "positions" => "positions_latest",
        "orders" => "orders_latest",
        _ => return Err(StoreError::new("bridge_store_data_stream_not_implemented")),
    };
    if message.full_snapshot {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE terminal_instance_id = ?1;"),
                [&message.terminal_instance_id],
            )
            .map_err(|_| StoreError::new("bridge_store_collection_clear_failed"))?;
    }
    for item in &message.upserts {
        let ticket = object_ticket(item)?;
        let payload = serde_json::to_string(item)
            .map_err(|_| StoreError::new("bridge_store_data_serialize_failed"))?;
        transaction
            .execute(
                &format!(
                    "INSERT INTO {table} (\
                       terminal_instance_id, ticket, connection_epoch, revision, observed_at_utc_msc, source_time_msc, payload_json\
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)\
                     ON CONFLICT(terminal_instance_id, ticket) DO UPDATE SET \
                       connection_epoch = excluded.connection_epoch, revision = excluded.revision,\
                       observed_at_utc_msc = excluded.observed_at_utc_msc,\
                       source_time_msc = excluded.source_time_msc, payload_json = excluded.payload_json;"
                ),
                params![
                    message.terminal_instance_id,
                    ticket,
                    message.connection_epoch,
                    message.revision,
                    message.observed_at_utc_msc,
                    message.source_time_msc,
                    payload,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_collection_write_failed"))?;
    }
    for item in &message.deletes {
        let ticket = scalar_ticket(item)?;
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE terminal_instance_id = ?1 AND ticket = ?2;"),
                params![message.terminal_instance_id, ticket],
            )
            .map_err(|_| StoreError::new("bridge_store_collection_delete_failed"))?;
    }
    Ok(())
}

fn read_latest_stream(
    transaction: &Transaction<'_>,
    message: &DataDeltaMessage,
) -> Result<Vec<serde_json::Value>, StoreError> {
    let query = match message.stream.as_str() {
        "account" => {
            "SELECT payload_json FROM account_latest WHERE terminal_instance_id = ?1;".to_owned()
        }
        "positions" => {
            "SELECT payload_json FROM positions_latest WHERE terminal_instance_id = ?1 ORDER BY ticket;"
                .to_owned()
        }
        "orders" => {
            "SELECT payload_json FROM orders_latest WHERE terminal_instance_id = ?1 ORDER BY ticket;"
                .to_owned()
        }
        _ => return Err(StoreError::new("bridge_store_data_stream_not_implemented")),
    };
    let mut statement = transaction
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_latest_query_failed"))?;
    let rows = statement
        .query_map([&message.terminal_instance_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|_| StoreError::new("bridge_store_latest_query_failed"))?;
    rows.map(|row| {
        let payload = row.map_err(|_| StoreError::new("bridge_store_latest_query_failed"))?;
        serde_json::from_str(&payload)
            .map_err(|_| StoreError::new("bridge_store_latest_payload_invalid"))
    })
    .collect()
}

fn load_stored_stream(
    connection: &Connection,
    terminal_instance_id: &str,
    connection_epoch: i64,
    stream: &str,
) -> Result<StoredStreamProjection, StoreError> {
    let stored_revision = connection
        .query_row(
            "SELECT revision FROM stream_revisions \
             WHERE terminal_instance_id = ?1 AND connection_epoch = ?2 AND stream = ?3;",
            params![terminal_instance_id, connection_epoch, stream],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_projection_revision_query_failed"))?;
    if stored_revision.is_some_and(|revision| revision <= 0) {
        return Err(StoreError::new("bridge_store_projection_revision_invalid"));
    }
    let revision = stored_revision.unwrap_or(0);
    let items = if stream == "account" {
        connection
            .query_row(
                "SELECT payload_json FROM account_latest \
                 WHERE terminal_instance_id = ?1 AND connection_epoch = ?2;",
                params![terminal_instance_id, connection_epoch],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_projection_query_failed"))?
            .map(|payload| parse_projection_payload(&payload))
            .transpose()?
            .into_iter()
            .collect()
    } else {
        let table = match stream {
            "positions" => "positions_latest",
            "orders" => "orders_latest",
            _ => return Err(StoreError::new("bridge_store_projection_stream_invalid")),
        };
        let mut statement = connection
            .prepare(&format!(
                "SELECT ticket, payload_json FROM {table} \
                 WHERE terminal_instance_id = ?1 AND connection_epoch = ?2 ORDER BY ticket;"
            ))
            .map_err(|_| StoreError::new("bridge_store_projection_query_failed"))?;
        let rows = statement
            .query_map(params![terminal_instance_id, connection_epoch], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| StoreError::new("bridge_store_projection_query_failed"))?;
        rows.map(|row| {
            let (stored_ticket, payload) =
                row.map_err(|_| StoreError::new("bridge_store_projection_query_failed"))?;
            let value = parse_projection_payload(&payload)?;
            if object_ticket(&value)? != stored_ticket {
                return Err(StoreError::new("bridge_store_projection_ticket_mismatch"));
            }
            Ok(value)
        })
        .collect::<Result<Vec<_>, StoreError>>()?
    };
    if revision == 0 && !items.is_empty() || stream == "account" && revision > 0 && items.len() != 1
    {
        return Err(StoreError::new("bridge_store_projection_state_invalid"));
    }
    Ok(StoredStreamProjection { revision, items })
}

fn parse_projection_payload(payload: &str) -> Result<serde_json::Value, StoreError> {
    serde_json::from_str(payload)
        .ok()
        .filter(serde_json::Value::is_object)
        .ok_or_else(|| StoreError::new("bridge_store_projection_payload_invalid"))
}

fn object_ticket(item: &serde_json::Value) -> Result<String, StoreError> {
    item.as_object()
        .and_then(|object| object.get("ticket"))
        .ok_or_else(|| StoreError::new("bridge_store_collection_ticket_invalid"))
        .and_then(scalar_ticket)
}

fn scalar_ticket(value: &serde_json::Value) -> Result<String, StoreError> {
    let ticket = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
        .filter(|value| value.parse::<u64>().is_ok_and(|value| value > 0))
        .ok_or_else(|| StoreError::new("bridge_store_collection_ticket_invalid"))?;
    Ok(ticket)
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
            if omitted.is_none()
                && matches!(
                    *table,
                    "stream_revisions" | "account_latest" | "positions_latest" | "orders_latest"
                )
            {
                let schema = match *table {
                    "stream_revisions" => {
                        "CREATE TABLE stream_revisions (\
                           terminal_instance_id TEXT NOT NULL, connection_epoch INTEGER NOT NULL,\
                           stream TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT NOT NULL,\
                           payload_hash TEXT NOT NULL, observed_at_utc_msc INTEGER NOT NULL,\
                           source_time_msc INTEGER,\
                           PRIMARY KEY (terminal_instance_id, connection_epoch, stream)\
                         );"
                    }
                    "account_latest" => {
                        "CREATE TABLE account_latest (\
                           terminal_instance_id TEXT PRIMARY KEY, connection_epoch INTEGER NOT NULL,\
                           revision INTEGER NOT NULL, observed_at_utc_msc INTEGER NOT NULL,\
                           source_time_msc INTEGER, payload_json TEXT NOT NULL\
                         );"
                    }
                    "positions_latest" => {
                        "CREATE TABLE positions_latest (\
                           terminal_instance_id TEXT NOT NULL, ticket TEXT NOT NULL,\
                           connection_epoch INTEGER NOT NULL, revision INTEGER NOT NULL,\
                           observed_at_utc_msc INTEGER NOT NULL, source_time_msc INTEGER,\
                           payload_json TEXT NOT NULL, PRIMARY KEY (terminal_instance_id, ticket)\
                         );"
                    }
                    "orders_latest" => {
                        "CREATE TABLE orders_latest (\
                           terminal_instance_id TEXT NOT NULL, ticket TEXT NOT NULL,\
                           connection_epoch INTEGER NOT NULL, revision INTEGER NOT NULL,\
                           observed_at_utc_msc INTEGER NOT NULL, source_time_msc INTEGER,\
                           payload_json TEXT NOT NULL, PRIMARY KEY (terminal_instance_id, ticket)\
                         );"
                    }
                    _ => unreachable!(),
                };
                connection
                    .execute_batch(schema)
                    .expect("fixture data table");
                continue;
            }
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

    fn data_delta(
        stream: &str,
        revision: i64,
        base_revision: i64,
        full_snapshot: bool,
        upserts: Vec<serde_json::Value>,
        deletes: Vec<serde_json::Value>,
    ) -> DataDeltaMessage {
        DataDeltaMessage {
            v: 3,
            message_type: "data_delta".to_owned(),
            message_id: format!("delta_mt5_terminal_01_{stream}_{revision}_01JTEST"),
            sent_at_utc_msc: 1_700_000_000_000 + revision,
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            stream: stream.to_owned(),
            revision,
            base_revision,
            observed_at_utc_msc: 1_700_000_000_000 + revision,
            source_time_msc: Some(1_700_000_000_000),
            full_snapshot,
            upserts,
            deletes,
        }
    }

    #[test]
    fn data_delta_commits_latest_revision_and_outbox_atomically() {
        let root = unique_test_directory("data-delta");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        let store = OutboxStore::open_existing(&path).expect("store");

        let account = data_delta(
            "account",
            1,
            0,
            true,
            vec![serde_json::json!({ "login": 123456, "server": "Broker-Demo" })],
            Vec::new(),
        );
        assert_eq!(
            store.persist_data_delta(&account).expect("account").status,
            PersistDeltaStatus::Applied
        );
        assert_eq!(
            store
                .persist_data_delta(&account)
                .expect("duplicate account")
                .status,
            PersistDeltaStatus::Duplicate
        );
        let mut conflicting_account = account.clone();
        conflicting_account.message_id = "delta_01JCONFLICT01".to_owned();
        assert_eq!(
            store
                .persist_data_delta(&conflicting_account)
                .expect_err("revision conflict")
                .code(),
            "bridge_store_data_revision_conflict"
        );

        let positions = data_delta(
            "positions",
            1,
            0,
            true,
            vec![
                serde_json::json!({ "ticket": 101, "volume": 0.01 }),
                serde_json::json!({ "ticket": "102", "volume": 0.02 }),
            ],
            Vec::new(),
        );
        store.persist_data_delta(&positions).expect("positions");
        let incremental = data_delta(
            "positions",
            2,
            1,
            false,
            vec![serde_json::json!({ "ticket": 101, "volume": 0.03 })],
            vec![serde_json::json!("102")],
        );
        store.persist_data_delta(&incremental).expect("incremental");

        let replacement = data_delta(
            "positions",
            3,
            0,
            true,
            vec![serde_json::json!({ "ticket": 105, "volume": 0.05 })],
            Vec::new(),
        );
        store
            .persist_data_delta(&replacement)
            .expect("replacement full snapshot");
        let restored = store
            .load_terminal_projection(
                &replacement.terminal_instance_id,
                &replacement.account_ref,
                replacement.connection_epoch,
            )
            .expect("restored projection");
        assert_eq!(restored.account.revision, 1);
        assert_eq!(restored.positions.revision, 3);
        assert_eq!(restored.positions.items, replacement.upserts);
        assert_eq!(restored.orders.revision, 0);
        assert!(restored.orders.items.is_empty());
        let switched = store
            .load_terminal_projection(
                &replacement.terminal_instance_id,
                &replacement.account_ref,
                replacement.connection_epoch + 1,
            )
            .expect("new epoch projection");
        assert_eq!(switched.account.revision, 0);
        assert!(switched.account.items.is_empty());
        let mut wrong_account = replacement.account_ref.clone();
        wrong_account.login = "999999".to_owned();
        assert_eq!(
            store
                .load_terminal_projection(
                    &replacement.terminal_instance_id,
                    &wrong_account,
                    replacement.connection_epoch,
                )
                .expect_err("account route mismatch")
                .code(),
            "bridge_store_projection_account_route_mismatch"
        );

        let gap = data_delta(
            "positions",
            5,
            4,
            false,
            vec![serde_json::json!({ "ticket": 104 })],
            Vec::new(),
        );
        let gap_result = store.persist_data_delta(&gap).expect("gap result");
        assert_eq!(gap_result.status, PersistDeltaStatus::Gap);
        assert_eq!(gap_result.current_revision, 3);
        assert!(
            store
                .pending(&gap.message_id)
                .expect("gap outbox")
                .is_none()
        );

        let invalid = data_delta(
            "orders",
            1,
            0,
            true,
            vec![serde_json::json!({ "symbol": "XAUUSD" })],
            Vec::new(),
        );
        assert_eq!(
            store
                .persist_data_delta(&invalid)
                .expect_err("invalid ticket")
                .code(),
            "bridge_store_collection_ticket_invalid"
        );
        assert!(
            store
                .pending(&invalid.message_id)
                .expect("invalid outbox")
                .is_none()
        );

        let reader = Connection::open(&path).expect("reader");
        let account_payload: String = reader
            .query_row(
                "SELECT payload_json FROM account_latest WHERE terminal_instance_id = ?1;",
                [&account.terminal_instance_id],
                |row| row.get(0),
            )
            .expect("account latest");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&account_payload).expect("account json"),
            account.upserts[0]
        );
        let latest_positions: Vec<(String, String)> = {
            let mut statement = reader
                .prepare(
                    "SELECT ticket, payload_json FROM positions_latest \
                     WHERE terminal_instance_id = ?1 ORDER BY ticket;",
                )
                .expect("positions statement");
            statement
                .query_map([&positions.terminal_instance_id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .expect("positions rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("positions")
        };
        assert_eq!(latest_positions.len(), 1);
        assert_eq!(latest_positions[0].0, "105");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&latest_positions[0].1)
                .expect("position json")["volume"],
            0.05
        );
        let pending = store
            .ready_for_terminals(1_700_000_000_100, None, 10)
            .expect("outbox");
        assert_eq!(pending.len(), 2);
        let pending_position: DataDeltaMessage = serde_json::from_str(
            &pending
                .iter()
                .find(|record| {
                    record.terminal_instance_id == replacement.terminal_instance_id
                        && record.message_id == replacement.message_id
                })
                .expect("replacement outbox")
                .payload_json,
        )
        .expect("replacement payload");
        assert!(pending_position.full_snapshot);
        assert_eq!(pending_position.base_revision, 0);
        assert_eq!(pending_position.upserts, replacement.upserts);
        drop(reader);
        drop(store);
        fs::remove_dir_all(root).expect("remove fixture");
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

    fn command_message() -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JLEDGER001".to_owned(),
            sent_at_utc_msc: 1_700_000_000_000,
            command_id: "command_01JLEDGER01".to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: 1_700_000_000_000,
            deadline_utc_msc: 1_700_000_010_000,
            action: "place_order".to_owned(),
            params: serde_json::json!({ "symbol": "XAUUSD", "volume": 0.01 }),
        }
    }

    #[test]
    fn native_command_ledger_is_immutable_and_dispatched_commands_require_reconciliation() {
        let root = unique_test_directory("command-ledger");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        let store = OutboxStore::open_existing(&path).expect("store");
        let command = command_message();
        let recorded = store
            .record_command(&command, 1_700_000_000_001)
            .expect("record command");
        assert!(recorded.created);
        assert_eq!(recorded.record.status, "persisted");
        assert!(
            !store
                .record_command(&command, 1_700_000_000_002)
                .expect("idempotent command")
                .created
        );
        let mut conflicting = command.clone();
        conflicting.params = serde_json::json!({ "symbol": "XAUUSD", "volume": 1.0 });
        assert_eq!(
            store
                .record_command(&conflicting, 1_700_000_000_003)
                .expect_err("command id conflict")
                .code(),
            "bridge_command_id_conflict"
        );

        store
            .mark_command_dispatched(&command.command_id, 1_700_000_000_004)
            .expect("dispatch");
        assert_eq!(
            store
                .mark_command_dispatched(&command.command_id, 1_700_000_000_005)
                .expect_err("no redispatch")
                .code(),
            "bridge_command_reconciliation_required"
        );
        let mut uncertain = command_result(
            &command.command_id,
            "result_01JLEDGER001",
            1_700_000_000_006,
        );
        uncertain.status = "uncertain".to_owned();
        uncertain.error_code = Some("worker_execution_interrupted".to_owned());
        store
            .save_execution_receipt(&uncertain, 10_000)
            .expect("uncertain receipt");
        let ledger = store
            .command_ledger(&command.command_id)
            .expect("ledger")
            .expect("command");
        assert_eq!(ledger.status, "uncertain");
        assert_eq!(
            ledger.result_message_id.as_deref(),
            Some(uncertain.message_id.as_str())
        );
        assert!(
            store
                .acknowledge_command_result(
                    &uncertain.message_id,
                    &command.command_id,
                    "applied",
                    1_700_000_000_007,
                )
                .expect("ack command result")
        );
        assert!(
            store
                .pending(&uncertain.message_id)
                .expect("pending result")
                .is_none()
        );
        assert_eq!(
            store
                .command_ledger(&command.command_id)
                .expect("ledger")
                .expect("command")
                .status,
            "acked"
        );
        assert!(
            store
                .acknowledge_command_result(
                    &uncertain.message_id,
                    &command.command_id,
                    "duplicate",
                    1_700_000_000_008,
                )
                .expect("idempotent command result ack")
        );

        drop(store);
        fs::remove_dir_all(root).expect("remove ledger fixture");
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

    #[test]
    fn execution_receipts_are_immutable_and_message_id_collisions_roll_back() {
        let root = unique_test_directory("execution-receipt-conflicts");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        let store = OutboxStore::open_existing(&path).expect("store");
        let original = command_result(
            "command_01JIMMUTABLE1",
            "result_01JIMMUTABLE01",
            1_700_000_000_001,
        );
        store
            .save_execution_receipt(&original, 10)
            .expect("original receipt");
        store
            .save_execution_receipt(&original, 10)
            .expect("idempotent receipt");

        let mut conflicting_result = original.clone();
        conflicting_result.status = "failed".to_owned();
        conflicting_result.error_code = Some("worker_execution_failed".to_owned());
        assert_eq!(
            store
                .save_execution_receipt(&conflicting_result, 10)
                .expect_err("immutable command result")
                .code(),
            "bridge_store_execution_receipt_conflict"
        );

        let mut colliding_message = command_result(
            "command_01JIMMUTABLE2",
            "result_01JIMMUTABLE02",
            1_700_000_000_002,
        );
        colliding_message.message_id = original.message_id.clone();
        assert_eq!(
            store
                .save_execution_receipt(&colliding_message, 10)
                .expect_err("message id collision")
                .code(),
            "bridge_store_execution_receipt_conflict"
        );
        assert!(
            store
                .execution_receipt(&colliding_message.command_id)
                .expect("rolled back receipt")
                .is_none()
        );

        drop(store);
        fs::remove_dir_all(root).expect("remove receipt conflict fixture");
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
