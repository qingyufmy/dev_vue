use bridge_contract::{
    AccountRef, CommandMessage, CommandResultMessage, DataDeltaMessage, SERVER_MAX_MESSAGE_BYTES,
    TerminalDescriptor, validate_id,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params, params_from_iter};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const BRIDGE_DATABASE_FILE_NAME: &str = "bridge.db";
const DEFAULT_DATA_OUTBOX_LIMIT_PER_STREAM: i64 = 256;
const MAX_HISTORY_BATCH_ITEMS: usize = 250;
const MAX_HISTORY_EVIDENCE_ITEMS: usize = 500;
const MAX_HISTORY_ITEM_BYTES: usize = 16 * 1024;
const MAX_HISTORY_PAGE_PAYLOAD_BYTES: usize = SERVER_MAX_MESSAGE_BYTES - 64 * 1024;

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
pub struct TerminalBinding {
    pub terminal_instance_id: String,
    pub platform: String,
    pub terminal_path: PathBuf,
    pub account_ref: AccountRef,
    pub connection_epoch: i64,
    pub updated_at_utc_msc: i64,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconciliationCandidate {
    pub command: CommandMessage,
    pub record: CommandLedgerRecord,
    pub uncertain_receipt: Option<CommandResultMessage>,
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

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, serde::Deserialize)]
pub struct HistoryCursor {
    pub time_msc: i64,
    pub ticket: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryArchiveBatch {
    pub deals: Vec<serde_json::Value>,
    pub history_orders: Vec<serde_json::Value>,
    pub trades: Vec<serde_json::Value>,
    pub next_cursor: HistoryCursor,
    pub has_more: bool,
    pub observed_at_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryArchiveState {
    pub cursor: HistoryCursor,
    pub is_complete: bool,
    pub updated_at_utc_msc: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalDataCacheEntry {
    pub observed_at_utc_msc: i64,
    pub cached_at_utc_msc: i64,
    pub payload: serde_json::Value,
}

pub struct OutboxStore {
    connection: Mutex<Connection>,
}

#[derive(Clone, Copy)]
struct TerminalBindingActivation {
    remove_other_accounts_for_path: bool,
    connection_epoch_floor: Option<i64>,
}

impl OutboxStore {
    pub fn open_or_create(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        if path.exists() {
            let report = inspect_existing_schema(path)?;
            if report.status == SchemaCompatibilityStatus::Compatible {
                return Self::open_existing(path);
            }
            if !database_is_empty(path)? {
                return Err(StoreError::new("bridge_store_schema_incompatible"));
            }
        } else if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .map_err(|_| StoreError::new("bridge_store_directory_create_failed"))?;
        }
        initialize_fresh_database(path)?;
        Self::open_existing(path)
    }

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
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| StoreError::new("bridge_store_foreign_keys_failed"))?;
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

    pub fn activate_terminal_binding(
        &self,
        terminal_instance_id: &str,
        platform: &str,
        terminal_path: impl AsRef<Path>,
        account_ref: &AccountRef,
        updated_at_utc_msc: i64,
    ) -> Result<TerminalBinding, StoreError> {
        self.activate_terminal_binding_internal(
            terminal_instance_id,
            platform,
            terminal_path.as_ref(),
            account_ref,
            updated_at_utc_msc,
            TerminalBindingActivation {
                remove_other_accounts_for_path: false,
                connection_epoch_floor: None,
            },
        )
    }

    pub fn activate_terminal_binding_for_path(
        &self,
        terminal_instance_id: &str,
        platform: &str,
        terminal_path: impl AsRef<Path>,
        account_ref: &AccountRef,
        updated_at_utc_msc: i64,
    ) -> Result<TerminalBinding, StoreError> {
        self.activate_terminal_binding_internal(
            terminal_instance_id,
            platform,
            terminal_path.as_ref(),
            account_ref,
            updated_at_utc_msc,
            TerminalBindingActivation {
                remove_other_accounts_for_path: true,
                connection_epoch_floor: None,
            },
        )
    }

    pub fn begin_terminal_session(
        &self,
        binding: &TerminalBinding,
        updated_at_utc_msc: i64,
    ) -> Result<TerminalBinding, StoreError> {
        self.activate_terminal_binding_internal(
            &binding.terminal_instance_id,
            &binding.platform,
            &binding.terminal_path,
            &binding.account_ref,
            updated_at_utc_msc,
            TerminalBindingActivation {
                remove_other_accounts_for_path: false,
                connection_epoch_floor: Some(updated_at_utc_msc),
            },
        )
    }

    fn activate_terminal_binding_internal(
        &self,
        terminal_instance_id: &str,
        platform: &str,
        terminal_path: &Path,
        account_ref: &AccountRef,
        updated_at_utc_msc: i64,
        activation: TerminalBindingActivation,
    ) -> Result<TerminalBinding, StoreError> {
        let mut binding = normalize_terminal_binding(
            terminal_instance_id,
            platform,
            terminal_path,
            account_ref,
            updated_at_utc_msc,
        )?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_binding_transaction_failed"))?;
        let previous_epoch = transaction
            .query_row(
                "SELECT connection_epoch FROM terminal_bindings \
                 WHERE terminal_instance_id = ?1;",
                [&binding.terminal_instance_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_binding_query_failed"))?
            .unwrap_or(0);
        binding.connection_epoch = previous_epoch
            .checked_add(1)
            .ok_or_else(|| StoreError::new("terminal_connection_epoch_exhausted"))?
            .max(activation.connection_epoch_floor.unwrap_or(1));
        let terminal_path = binding
            .terminal_path
            .to_str()
            .ok_or_else(|| StoreError::new("bridge_store_terminal_path_invalid"))?;
        transaction
            .execute(
                "INSERT INTO terminal_bindings (\
                   terminal_instance_id, platform, terminal_path, broker_server, login_account, \
                   connection_epoch, updated_at_utc_msc\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)\
                 ON CONFLICT(terminal_instance_id) DO UPDATE SET \
                   platform = excluded.platform, terminal_path = excluded.terminal_path, \
                   broker_server = excluded.broker_server, login_account = excluded.login_account, \
                   connection_epoch = excluded.connection_epoch, \
                   updated_at_utc_msc = excluded.updated_at_utc_msc;",
                params![
                    binding.terminal_instance_id,
                    binding.platform,
                    terminal_path,
                    binding.account_ref.broker_server,
                    binding.account_ref.login,
                    binding.connection_epoch,
                    binding.updated_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_binding_write_failed"))?;
        if activation.remove_other_accounts_for_path {
            transaction
                .execute(
                    "DELETE FROM terminal_bindings \
                     WHERE platform = ?1 AND terminal_path = ?2 COLLATE NOCASE \
                       AND terminal_instance_id <> ?3;",
                    params![
                        binding.platform,
                        terminal_path,
                        binding.terminal_instance_id
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_binding_prune_failed"))?;
        }
        transaction
            .execute(
                "DELETE FROM outbox_messages \
                 WHERE terminal_instance_id = ?1 AND message_type = 'data_delta' \
                   AND connection_epoch < ?2;",
                params![binding.terminal_instance_id, binding.connection_epoch],
            )
            .map_err(|_| StoreError::new("bridge_store_binding_prune_failed"))?;
        transaction
            .execute(
                "DELETE FROM stream_revisions \
                 WHERE terminal_instance_id = ?1 AND connection_epoch < ?2;",
                params![binding.terminal_instance_id, binding.connection_epoch],
            )
            .map_err(|_| StoreError::new("bridge_store_binding_prune_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_binding_commit_failed"))?;
        Ok(binding)
    }

    pub fn terminal_bindings(&self) -> Result<Vec<TerminalBinding>, StoreError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let mut statement = connection
            .prepare(
                "SELECT terminal_instance_id, platform, terminal_path, broker_server, \
                        login_account, connection_epoch, updated_at_utc_msc \
                 FROM terminal_bindings ORDER BY terminal_instance_id;",
            )
            .map_err(|_| StoreError::new("bridge_store_binding_query_failed"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|_| StoreError::new("bridge_store_binding_query_failed"))?;
        rows.map(|row| {
            let (terminal_id, platform, path, server, login, epoch, updated_at) =
                row.map_err(|_| StoreError::new("bridge_store_binding_query_failed"))?;
            let account_ref = AccountRef {
                broker_server: server,
                login,
            };
            if !Path::new(&path).is_absolute() {
                return Err(StoreError::new("bridge_store_terminal_path_invalid"));
            }
            let binding = normalize_terminal_binding(
                &terminal_id,
                &platform,
                Path::new(&path),
                &account_ref,
                updated_at,
            )?;
            if epoch <= 0 {
                return Err(StoreError::new("bridge_store_binding_invalid"));
            }
            Ok(TerminalBinding {
                connection_epoch: epoch,
                ..binding
            })
        })
        .collect()
    }

    pub fn read_terminal_data_cache(
        &self,
        terminal: &TerminalDescriptor,
        action: &str,
        parameters: &serde_json::Value,
        cached_after_utc_msc: i64,
    ) -> Result<Option<TerminalDataCacheEntry>, StoreError> {
        let params_hash =
            terminal_data_cache_key(terminal, action, parameters, cached_after_utc_msc)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let row = connection
            .query_row(
                "SELECT observed_at_utc_msc, cached_at_utc_msc, payload_json \
                 FROM terminal_data_cache \
                 WHERE terminal_instance_id = ?1 \
                   AND broker_server = ?2 COLLATE NOCASE \
                   AND login_account = ?3 AND connection_epoch = ?4 \
                   AND action = ?5 AND params_hash = ?6 \
                   AND cached_at_utc_msc > ?7 LIMIT 1;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.connection_epoch,
                    action,
                    params_hash,
                    cached_after_utc_msc,
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_data_cache_query_failed"))?;
        row.map(|(observed_at_utc_msc, cached_at_utc_msc, payload_json)| {
            let payload = serde_json::from_str::<serde_json::Value>(&payload_json)
                .map_err(|_| StoreError::new("bridge_store_data_cache_payload_invalid"))?;
            if !payload.is_object() {
                return Err(StoreError::new("bridge_store_data_cache_payload_invalid"));
            }
            Ok(TerminalDataCacheEntry {
                observed_at_utc_msc,
                cached_at_utc_msc,
                payload,
            })
        })
        .transpose()
    }

    pub fn persist_terminal_data_cache(
        &self,
        terminal: &TerminalDescriptor,
        action: &str,
        parameters: &serde_json::Value,
        observed_at_utc_msc: i64,
        cached_at_utc_msc: i64,
        payload: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let params_hash = terminal_data_cache_key(terminal, action, parameters, cached_at_utc_msc)?;
        if observed_at_utc_msc <= 0 || !payload.is_object() {
            return Err(StoreError::new("bridge_store_data_cache_payload_invalid"));
        }
        let payload_json = serde_json::to_string(payload)
            .map_err(|_| StoreError::new("bridge_store_data_cache_payload_invalid"))?;
        if payload_json.len() > MAX_HISTORY_PAGE_PAYLOAD_BYTES {
            return Err(StoreError::new("bridge_store_data_cache_payload_too_large"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_data_cache_write_failed"))?;
        transaction
            .execute(
                "INSERT INTO terminal_data_cache (terminal_instance_id, broker_server, \
                    login_account, connection_epoch, action, params_hash, observed_at_utc_msc, \
                    cached_at_utc_msc, payload_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT (terminal_instance_id, broker_server, login_account, \
                    connection_epoch, action, params_hash) DO UPDATE SET \
                    observed_at_utc_msc = excluded.observed_at_utc_msc, \
                    cached_at_utc_msc = excluded.cached_at_utc_msc, \
                    payload_json = excluded.payload_json;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.connection_epoch,
                    action,
                    params_hash,
                    observed_at_utc_msc,
                    cached_at_utc_msc,
                    payload_json,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_data_cache_write_failed"))?;
        transaction
            .execute(
                "DELETE FROM terminal_data_cache WHERE cached_at_utc_msc < ?1;",
                params![cached_at_utc_msc.saturating_sub(7 * 24 * 60 * 60 * 1_000)],
            )
            .map_err(|_| StoreError::new("bridge_store_data_cache_write_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_data_cache_commit_failed"))
    }

    pub fn history_archive_state(
        &self,
        terminal_instance_id: &str,
        account_ref: &AccountRef,
    ) -> Result<HistoryArchiveState, StoreError> {
        validate_history_scope(terminal_instance_id, account_ref)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .query_row(
                "SELECT cursor_value, is_complete, updated_at_utc_msc \
                 FROM history_archive_state \
                 WHERE terminal_instance_id = ?1 \
                   AND broker_server = ?2 COLLATE NOCASE \
                   AND login_account = ?3 LIMIT 1;",
                params![
                    terminal_instance_id,
                    account_ref.broker_server,
                    account_ref.login
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?
            .map(|(cursor_json, complete, updated_at)| {
                let cursor = parse_history_cursor(&cursor_json)?;
                if !matches!(complete, 0 | 1) || updated_at <= 0 {
                    return Err(StoreError::new("bridge_store_history_state_invalid"));
                }
                Ok(HistoryArchiveState {
                    cursor,
                    is_complete: complete == 1,
                    updated_at_utc_msc: updated_at,
                })
            })
            .transpose()
            .map(|state| {
                state.unwrap_or(HistoryArchiveState {
                    cursor: HistoryCursor::default(),
                    is_complete: false,
                    updated_at_utc_msc: 0,
                })
            })
    }

    pub fn persist_history_archive_batch(
        &self,
        terminal: &TerminalDescriptor,
        batch: &HistoryArchiveBatch,
    ) -> Result<(), StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        validate_history_cursor(&batch.next_cursor)?;
        if batch.observed_at_utc_msc <= 0
            || batch.deals.len() > MAX_HISTORY_BATCH_ITEMS
            || batch.history_orders.len() > MAX_HISTORY_BATCH_ITEMS
            || batch.trades.len() > MAX_HISTORY_BATCH_ITEMS
        {
            return Err(StoreError::new("bridge_store_history_batch_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        upsert_history_items(
            &transaction,
            terminal,
            "deal",
            &batch.deals,
            batch.observed_at_utc_msc,
        )?;
        upsert_history_items(
            &transaction,
            terminal,
            "history_order",
            &batch.history_orders,
            batch.observed_at_utc_msc,
        )?;
        upsert_history_items(
            &transaction,
            terminal,
            "trade",
            &batch.trades,
            batch.observed_at_utc_msc,
        )?;
        let current = transaction
            .query_row(
                "SELECT cursor_value FROM history_archive_state \
                 WHERE terminal_instance_id = ?1 \
                   AND broker_server = ?2 COLLATE NOCASE \
                   AND login_account = ?3 LIMIT 1;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?
            .map(|value| parse_history_cursor(&value))
            .transpose()?
            .unwrap_or_default();
        if compare_history_cursor(&batch.next_cursor, &current).is_lt() {
            return Err(StoreError::new("bridge_store_history_cursor_regression"));
        }
        let cursor_json = serde_json::to_string(&batch.next_cursor)
            .map_err(|_| StoreError::new("bridge_store_history_cursor_invalid"))?;
        transaction
            .execute(
                "INSERT INTO history_archive_state (\
                   terminal_instance_id, broker_server, login_account, cursor_value, \
                   is_complete, updated_at_utc_msc\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)\
                 ON CONFLICT(terminal_instance_id, broker_server, login_account) DO UPDATE SET \
                   cursor_value = excluded.cursor_value, is_complete = excluded.is_complete, \
                   updated_at_utc_msc = excluded.updated_at_utc_msc;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    cursor_json,
                    if batch.has_more { 0 } else { 1 },
                    batch.observed_at_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_state_write_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))
    }

    pub fn read_history_archive_page(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let request = parse_history_page_request(parameters)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let scope = history_scope_values(terminal);
        let mut filtered_values = scope.clone();
        filtered_values.extend(request.filter_values.iter().cloned());
        let total = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM history_archive_items \
                     WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
                       AND login_account = ? AND item_kind = 'trade'{};",
                    request.filter_sql
                ),
                params_from_iter(filtered_values.clone()),
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT payload_json FROM history_archive_items \
                 WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
                   AND login_account = ? AND item_kind = 'trade'{} \
                 ORDER BY event_time_msc DESC, item_id DESC LIMIT ? OFFSET ?;",
                request.filter_sql
            ))
            .map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
        let mut page_values = filtered_values.clone();
        page_values.push(SqlValue::Integer(request.page_size));
        page_values.push(SqlValue::Integer(
            (request.page - 1).saturating_mul(request.page_size),
        ));
        let mut rows = read_json_rows(&mut statement, params_from_iter(page_values))?;
        hydrate_history_trade_protection(&connection, terminal, &mut rows)?;
        let (deals, history_orders, evidence_truncated) = if request.include_deals {
            read_history_evidence(&connection, terminal, &rows)?
        } else {
            (Vec::new(), Vec::new(), false)
        };
        let statistics =
            read_history_statistics(&connection, terminal, &request, total, filtered_values)?;
        let state = read_history_state_locked(&connection, terminal)?;
        let mut payload = serde_json::json!({
            "orders": rows,
            "deals": deals,
            "history_orders": history_orders,
            "statistics": statistics,
            "pagination": {
                "current_page": request.page,
                "page_size": request.page_size,
                "total_count": total,
                "total_pages": std::cmp::max((total + request.page_size - 1) / request.page_size, 1),
            },
            "history_sync": {
                "complete": state.is_complete,
                "cursor_time_msc": state.cursor.time_msc,
                "updated_at_utc_msc": state.updated_at_utc_msc,
                "evidence_truncated": evidence_truncated,
            },
            "source": format!("{}_sqlite", terminal.platform),
        });
        enforce_history_payload_budget(&mut payload)?;
        Ok(payload)
    }

    pub fn read_history_chart_data(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let request = parse_history_chart_request(parameters)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let mut values = history_scope_values(terminal);
        values.extend(request.filter_values.iter().cloned());
        let net = "CAST(COALESCE(json_extract(payload_json, '$.net_profit'), \
                   json_extract(payload_json, '$.profit'), 0) AS REAL)";
        let mut daily_statement = connection
            .prepare(&format!(
                "SELECT strftime('%Y-%m-%d', event_time_msc / 1000, 'unixepoch') AS day, \
                   COALESCE(SUM({net}), 0), COUNT(*), \
                   COALESCE(SUM(CASE WHEN {net} > 0 THEN 1 ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN {net} < 0 THEN 1 ELSE 0 END), 0) \
                 FROM history_archive_items WHERE terminal_instance_id = ? \
                   AND broker_server = ? COLLATE NOCASE AND login_account = ? \
                   AND item_kind = 'trade'{} GROUP BY day ORDER BY day;",
                request.filter_sql
            ))
            .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
        let daily = daily_statement
            .query_map(params_from_iter(values.clone()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
        let (total, gross_profit, gross_loss, win_count, loss_count, total_profit) = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*), \
                       COALESCE(SUM(CASE WHEN {net} > 0 THEN {net} ELSE 0 END), 0), \
                       COALESCE(SUM(CASE WHEN {net} < 0 THEN -{net} ELSE 0 END), 0), \
                       COALESCE(SUM(CASE WHEN {net} > 0 THEN 1 ELSE 0 END), 0), \
                       COALESCE(SUM(CASE WHEN {net} < 0 THEN 1 ELSE 0 END), 0), \
                       COALESCE(SUM({net}), 0) \
                     FROM history_archive_items WHERE terminal_instance_id = ? \
                       AND broker_server = ? COLLATE NOCASE AND login_account = ? \
                       AND item_kind = 'trade'{};",
                    request.filter_sql
                ),
                params_from_iter(values),
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, f64>(5)?,
                    ))
                },
            )
            .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
        let balance = connection
            .query_row(
                "SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL) \
                 FROM account_latest WHERE terminal_instance_id = ?1 \
                   AND connection_epoch = ?2 LIMIT 1;",
                params![terminal.terminal_instance_id, terminal.connection_epoch],
                |row| row.get::<_, f64>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?
            .unwrap_or(0.0);
        let round = |value: f64| (value * 100.0).round() / 100.0;
        let initial_capital = (balance - total_profit).max(0.0);
        let mut running = 0.0;
        let mut peak = initial_capital;
        let mut maximum_drawdown: f64 = 0.0;
        let mut cumulative = Vec::with_capacity(daily.len());
        let mut drawdown = Vec::with_capacity(daily.len());
        let daily = daily
            .into_iter()
            .map(|(date, profit, trade_count, wins, losses)| {
                let profit = round(profit);
                running = round(running + profit);
                cumulative.push(running);
                let equity = initial_capital + running;
                peak = peak.max(equity);
                let current_drawdown = if peak > 0.0 {
                    round((1.0 - equity / peak) * 100.0)
                } else {
                    0.0
                };
                maximum_drawdown = maximum_drawdown.max(current_drawdown);
                drawdown.push(current_drawdown);
                serde_json::json!({
                    "date": date,
                    "profit": profit,
                    "trade_count": trade_count,
                    "wins": wins,
                    "losses": losses,
                })
            })
            .collect::<Vec<_>>();
        let average_win = if win_count > 0 {
            gross_profit / win_count as f64
        } else {
            0.0
        };
        let average_loss = if loss_count > 0 {
            gross_loss / loss_count as f64
        } else {
            0.0
        };
        let profit_factor = if average_loss > 0.0 {
            round(average_win / average_loss)
        } else if average_win > 0.0 {
            999.0
        } else {
            0.0
        };
        let state = read_history_state_locked(&connection, terminal)?;
        Ok(serde_json::json!({
            "daily": daily,
            "cumulative": cumulative,
            "drawdown": drawdown,
            "stats": {
                "total_trades": total,
                "win_rate": if total > 0 { round(win_count as f64 / total as f64 * 100.0) } else { 0.0 },
                "profit_factor": profit_factor,
                "max_drawdown": maximum_drawdown,
                "gross_profit": round(gross_profit),
                "gross_loss": round(gross_loss),
            },
            "history_sync": {
                "complete": state.is_complete,
                "cursor_time_msc": state.cursor.time_msc,
                "updated_at_utc_msc": state.updated_at_utc_msc,
            },
            "source": format!("{}_sqlite", terminal.platform),
        }))
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
        validate_account_projection_route(&account, account_ref)?;
        Ok(StoredTerminalProjection {
            account,
            positions,
            orders,
        })
    }

    /// Reads only the current account projection for lightweight status surfaces. The same
    /// terminal/account/epoch fencing as the full projection is retained, without loading every
    /// active position and order merely to render connection or trading-permission state.
    pub fn load_account_projection(
        &self,
        terminal_instance_id: &str,
        account_ref: &AccountRef,
        connection_epoch: i64,
    ) -> Result<StoredStreamProjection, StoreError> {
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
        validate_account_projection_route(&account, account_ref)?;
        Ok(account)
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

    pub fn reconciliation_candidates(
        &self,
        limit: usize,
    ) -> Result<Vec<ReconciliationCandidate>, StoreError> {
        if !(1..=10_000).contains(&limit) {
            return Err(StoreError::new("bridge_store_reconciliation_query_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let mut statement = connection
            .prepare(
                "SELECT ledger.command_id, ledger.payload_json, ledger.status,
                        ledger.result_message_id, ledger.created_at_utc_msc,
                        ledger.updated_at_utc_msc, receipt.result_json
                 FROM native_command_ledger ledger
                 LEFT JOIN execution_receipts receipt
                   ON receipt.command_id = ledger.command_id
                 WHERE ledger.status = 'dispatched'
                    OR (ledger.status = 'acked' AND receipt.status = 'uncertain')
                 ORDER BY ledger.updated_at_utc_msc ASC, ledger.command_id ASC
                 LIMIT ?1;",
            )
            .map_err(|_| StoreError::new("bridge_store_reconciliation_query_failed"))?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok((
                    CommandLedgerRecord {
                        command_id: row.get(0)?,
                        payload_json: row.get(1)?,
                        status: row.get(2)?,
                        result_message_id: row.get(3)?,
                        created_at_utc_msc: row.get(4)?,
                        updated_at_utc_msc: row.get(5)?,
                    },
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|_| StoreError::new("bridge_store_reconciliation_query_failed"))?;
        let mut candidates = Vec::new();
        for row in rows {
            let (record, receipt_json) =
                row.map_err(|_| StoreError::new("bridge_store_reconciliation_query_failed"))?;
            let command: CommandMessage = serde_json::from_str(&record.payload_json)
                .map_err(|_| StoreError::new("bridge_store_reconciliation_record_invalid"))?;
            command
                .validate(command.issued_at_utc_msc.saturating_sub(1))
                .map_err(|_| StoreError::new("bridge_store_reconciliation_record_invalid"))?;
            if command.command_id != record.command_id {
                return Err(StoreError::new(
                    "bridge_store_reconciliation_record_invalid",
                ));
            }
            let uncertain_receipt = receipt_json
                .map(|payload| {
                    let receipt: CommandResultMessage =
                        serde_json::from_str(&payload).map_err(|_| {
                            StoreError::new("bridge_store_reconciliation_record_invalid")
                        })?;
                    receipt.validate().map_err(|_| {
                        StoreError::new("bridge_store_reconciliation_record_invalid")
                    })?;
                    if receipt.status != "uncertain" || !receipt.matches_command(&command) {
                        return Err(StoreError::new(
                            "bridge_store_reconciliation_record_invalid",
                        ));
                    }
                    Ok(receipt)
                })
                .transpose()?;
            if record.status == "dispatched" && uncertain_receipt.is_some()
                || record.status == "acked"
                    && uncertain_receipt.as_ref().is_none_or(|receipt| {
                        record.result_message_id.as_deref() != Some(receipt.message_id.as_str())
                    })
            {
                return Err(StoreError::new(
                    "bridge_store_reconciliation_record_invalid",
                ));
            }
            candidates.push(ReconciliationCandidate {
                command,
                record,
                uncertain_receipt,
            });
        }
        Ok(candidates)
    }

    pub fn resolve_acknowledged_uncertain_receipt(
        &self,
        result: &CommandResultMessage,
    ) -> Result<bool, StoreError> {
        result
            .validate()
            .map_err(|_| StoreError::new("bridge_store_reconciliation_result_invalid"))?;
        if !matches!(result.status.as_str(), "succeeded" | "rejected" | "failed") {
            return Err(StoreError::new(
                "bridge_store_reconciliation_result_invalid",
            ));
        }
        let result_json = serde_json::to_string(result)
            .map_err(|_| StoreError::new("bridge_store_reconciliation_result_invalid"))?;
        if result_json.len() > 4 * 1024 * 1024 {
            return Err(StoreError::new(
                "bridge_store_reconciliation_result_invalid",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?;
        let ledger = transaction
            .query_row(
                "SELECT payload_json, status, result_message_id
                 FROM native_command_ledger WHERE command_id = ?1 LIMIT 1;",
                [&result.command_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?
            .ok_or_else(|| StoreError::new("bridge_store_command_unknown"))?;
        let command: CommandMessage = serde_json::from_str(&ledger.0)
            .map_err(|_| StoreError::new("bridge_store_reconciliation_record_invalid"))?;
        if !result.matches_command(&command) {
            return Err(StoreError::new(
                "bridge_store_reconciliation_transition_invalid",
            ));
        }
        let existing_json = transaction
            .query_row(
                "SELECT result_json FROM execution_receipts WHERE command_id = ?1 LIMIT 1;",
                [&result.command_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?
            .ok_or_else(|| StoreError::new("bridge_store_reconciliation_receipt_missing"))?;
        if existing_json == result_json {
            return Ok(false);
        }
        if ledger.1 != "acked" {
            return Err(StoreError::new(
                "bridge_store_reconciliation_transition_invalid",
            ));
        }
        let existing: CommandResultMessage = serde_json::from_str(&existing_json)
            .map_err(|_| StoreError::new("bridge_store_reconciliation_record_invalid"))?;
        existing
            .validate()
            .map_err(|_| StoreError::new("bridge_store_reconciliation_record_invalid"))?;
        if existing.status != "uncertain"
            || !existing.matches_command(&command)
            || ledger.2.as_deref() != Some(existing.message_id.as_str())
            || result.message_id == existing.message_id
            || result.completed_at_utc_msc < existing.completed_at_utc_msc
            || result.evidence.observed_at_utc_msc < existing.evidence.observed_at_utc_msc
        {
            return Err(StoreError::new(
                "bridge_store_reconciliation_transition_invalid",
            ));
        }
        transaction
            .execute(
                "UPDATE execution_receipts
                 SET terminal_instance_id = ?2, connection_epoch = ?3, status = ?4,
                     result_json = ?5, completed_at_utc_msc = ?6
                 WHERE command_id = ?1 AND status = 'uncertain';",
                params![
                    result.command_id,
                    result.terminal_instance_id,
                    result.connection_epoch,
                    result.status,
                    result_json,
                    result.completed_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?;
        let inserted = transaction
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
                    result_json,
                    result.sent_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?;
        if inserted != 1 {
            return Err(StoreError::new(
                "bridge_store_reconciliation_result_conflict",
            ));
        }
        let updated = transaction
            .execute(
                "UPDATE native_command_ledger
                 SET status = 'confirmed', result_message_id = ?2, updated_at_utc_msc = ?3
                 WHERE command_id = ?1 AND status = 'acked';",
                params![
                    result.command_id,
                    result.message_id,
                    result.completed_at_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?;
        if updated != 1 {
            return Err(StoreError::new(
                "bridge_store_reconciliation_transition_invalid",
            ));
        }
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_reconciliation_write_failed"))?;
        Ok(true)
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

fn database_is_empty(path: &Path) -> Result<bool, StoreError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| StoreError::new("bridge_store_open_failed"))?;
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%';",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count == 0)
        .map_err(|_| StoreError::new("bridge_store_schema_query_failed"))
}

fn normalize_terminal_binding(
    terminal_instance_id: &str,
    platform: &str,
    terminal_path: &Path,
    account_ref: &AccountRef,
    updated_at_utc_msc: i64,
) -> Result<TerminalBinding, StoreError> {
    validate_id(terminal_instance_id)
        .map_err(|_| StoreError::new("bridge_store_binding_invalid"))?;
    account_ref
        .validate()
        .map_err(|_| StoreError::new("bridge_store_binding_invalid"))?;
    let platform = platform.trim().to_ascii_lowercase();
    if !matches!(platform.as_str(), "mt4" | "mt5") || updated_at_utc_msc <= 0 {
        return Err(StoreError::new("bridge_store_binding_invalid"));
    }
    let path_text = terminal_path
        .to_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| StoreError::new("bridge_store_terminal_path_invalid"))?;
    let terminal_path = PathBuf::from(path_text);
    let terminal_path = if terminal_path.is_absolute() {
        terminal_path
    } else {
        env::current_dir()
            .map_err(|_| StoreError::new("bridge_store_terminal_path_invalid"))?
            .join(terminal_path)
    };
    Ok(TerminalBinding {
        terminal_instance_id: terminal_instance_id.to_owned(),
        platform,
        terminal_path,
        account_ref: account_ref.clone(),
        connection_epoch: 0,
        updated_at_utc_msc,
    })
}

fn initialize_fresh_database(path: &Path) -> Result<(), StoreError> {
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| StoreError::new("bridge_store_create_failed"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| StoreError::new("bridge_store_busy_timeout_failed"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|_| StoreError::new("bridge_store_journal_mode_failed"))?;
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .map_err(|_| StoreError::new("bridge_store_journal_mode_failed"))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::new("bridge_store_journal_mode_failed"));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| StoreError::new("bridge_store_synchronous_failed"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| StoreError::new("bridge_store_foreign_keys_failed"))?;
    let transaction = connection
        .transaction()
        .map_err(|_| StoreError::new("bridge_store_schema_transaction_failed"))?;
    transaction
        .execute_batch(include_str!("schema.sql"))
        .map_err(|_| StoreError::new("bridge_store_schema_create_failed"))?;
    transaction
        .commit()
        .map_err(|_| StoreError::new("bridge_store_schema_commit_failed"))?;
    ensure_native_command_ledger_schema(&connection)
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

fn validate_account_projection_route(
    account: &StoredStreamProjection,
    account_ref: &AccountRef,
) -> Result<(), StoreError> {
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
    Ok(())
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

struct HistoryPageRequest {
    page: i64,
    page_size: i64,
    include_deals: bool,
    filter_sql: String,
    filter_values: Vec<SqlValue>,
    capital_filter_sql: String,
    capital_filter_values: Vec<SqlValue>,
}

fn parse_history_chart_request(
    parameters: &serde_json::Value,
) -> Result<HistoryPageRequest, StoreError> {
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_params_invalid"))?;
    const ALLOWED: &[&str] = &[
        "date_from",
        "date_to",
        "direction",
        "profit_filter",
        "force_refresh",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(StoreError::new("history_params_invalid"));
    }
    parse_history_page_request(parameters)
}

fn parse_history_page_request(
    parameters: &serde_json::Value,
) -> Result<HistoryPageRequest, StoreError> {
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_params_invalid"))?;
    const ALLOWED: &[&str] = &[
        "page",
        "page_size",
        "date_from",
        "date_to",
        "entry_from",
        "entry_to",
        "direction",
        "profit_filter",
        "force_refresh",
        "include_deals",
        "compact",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str()))
        || ["force_refresh", "include_deals", "compact"]
            .iter()
            .any(|key| object.get(*key).is_some_and(|value| !value.is_boolean()))
    {
        return Err(StoreError::new("history_params_invalid"));
    }
    let page = history_integer(object.get("page"), 1, 1, 1_000_000)?;
    let page_size = history_integer(object.get("page_size"), 20, 1, 200)?;
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    let mut capital_clauses = Vec::new();
    let mut capital_values = Vec::new();
    for (key, comparison, end_of_day) in [
        ("date_from", ">=", false),
        ("entry_from", ">=", false),
        ("date_to", "<=", true),
        ("entry_to", "<=", true),
    ] {
        if let Some(value) = object.get(key) {
            let text = value
                .as_str()
                .ok_or_else(|| StoreError::new("history_date_invalid"))?;
            let mut timestamp = parse_utc_date_msc(text)?;
            if end_of_day {
                timestamp = timestamp.saturating_add(86_400_000 - 1);
            }
            clauses.push(format!(" AND event_time_msc {comparison} ?"));
            values.push(SqlValue::Integer(timestamp));
            if matches!(key, "date_from" | "date_to") {
                capital_clauses.push(format!(" AND event_time_msc {comparison} ?"));
                capital_values.push(SqlValue::Integer(timestamp));
            }
        }
    }
    if let Some(value) = object.get("direction") {
        let direction = value
            .as_str()
            .filter(|value| matches!(*value, "BUY" | "SELL"))
            .ok_or_else(|| StoreError::new("history_direction_invalid"))?;
        clauses.push(
            " AND UPPER(COALESCE(json_extract(payload_json, '$.type'), \
             json_extract(payload_json, '$.side'), '')) = ?"
                .to_owned(),
        );
        values.push(SqlValue::Text(direction.to_owned()));
    }
    if let Some(value) = object.get("profit_filter") {
        match value.as_str() {
            Some("profit") => clauses.push(
                " AND CAST(COALESCE(json_extract(payload_json, '$.net_profit'), \
                 json_extract(payload_json, '$.profit'), 0) AS REAL) > 0"
                    .to_owned(),
            ),
            Some("loss") => clauses.push(
                " AND CAST(COALESCE(json_extract(payload_json, '$.net_profit'), \
                 json_extract(payload_json, '$.profit'), 0) AS REAL) < 0"
                    .to_owned(),
            ),
            _ => return Err(StoreError::new("history_profit_filter_invalid")),
        }
    }
    Ok(HistoryPageRequest {
        page,
        page_size,
        include_deals: object
            .get("include_deals")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        filter_sql: clauses.concat(),
        filter_values: values,
        capital_filter_sql: capital_clauses.concat(),
        capital_filter_values: capital_values,
    })
}

fn history_integer(
    value: Option<&serde_json::Value>,
    fallback: i64,
    minimum: i64,
    maximum: i64,
) -> Result<i64, StoreError> {
    let result = value.map_or(Some(fallback), serde_json::Value::as_i64);
    result
        .filter(|number| (minimum..=maximum).contains(number))
        .ok_or_else(|| StoreError::new("history_pagination_invalid"))
}

fn parse_utc_date_msc(value: &str) -> Result<i64, StoreError> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return Err(StoreError::new("history_date_invalid"));
    }
    let parse = |start: usize, end: usize| {
        value[start..end]
            .parse::<i64>()
            .map_err(|_| StoreError::new("history_date_invalid"))
    };
    let year = parse(0, 4)?;
    let month = parse(5, 7)?;
    let day = parse(8, 10)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if !(1970..=9999).contains(&year) || day < 1 || day > maximum_day {
        return Err(StoreError::new("history_date_invalid"));
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days_since_epoch = era * 146_097 + day_of_era - 719_468;
    days_since_epoch
        .checked_mul(86_400_000)
        .ok_or_else(|| StoreError::new("history_date_invalid"))
}

fn history_scope_values(terminal: &TerminalDescriptor) -> Vec<SqlValue> {
    vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
    ]
}

fn terminal_data_cache_key(
    terminal: &TerminalDescriptor,
    action: &str,
    parameters: &serde_json::Value,
    timestamp_utc_msc: i64,
) -> Result<String, StoreError> {
    terminal
        .validate()
        .map_err(|_| StoreError::new("bridge_store_data_cache_key_invalid"))?;
    if !matches!(action, "rates" | "symbols" | "performance_daily")
        || !parameters.is_object()
        || timestamp_utc_msc < 0
    {
        return Err(StoreError::new("bridge_store_data_cache_key_invalid"));
    }
    let encoded = serde_json::to_vec(parameters)
        .map_err(|_| StoreError::new("bridge_store_data_cache_key_invalid"))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn read_history_statistics(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    request: &HistoryPageRequest,
    total: i64,
    filtered_values: Vec<SqlValue>,
) -> Result<serde_json::Value, StoreError> {
    let (total_profit, total_volume) = connection
        .query_row(
            &format!(
                "SELECT \
                   COALESCE(SUM(CAST(COALESCE(json_extract(payload_json, '$.net_profit'), \
                     json_extract(payload_json, '$.profit'), 0) AS REAL)), 0), \
                   COALESCE(SUM(CAST(COALESCE(json_extract(payload_json, '$.volume'), 0) AS REAL)), 0) \
                 FROM history_archive_items WHERE terminal_instance_id = ? \
                   AND broker_server = ? COLLATE NOCASE AND login_account = ? \
                   AND item_kind = 'trade'{};",
                request.filter_sql
            ),
            params_from_iter(filtered_values),
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
        )
        .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))?;
    let mut capital_values = history_scope_values(terminal);
    capital_values.extend(request.capital_filter_values.iter().cloned());
    let (deposit, withdrawal, credit) = connection
        .query_row(
            &format!(
                "SELECT \
                   COALESCE(SUM(CASE WHEN CAST(COALESCE(json_extract(payload_json, '$.type'), -1) AS INTEGER) = 2 \
                     AND CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) >= 0 \
                     THEN CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN CAST(COALESCE(json_extract(payload_json, '$.type'), -1) AS INTEGER) = 2 \
                     AND CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) < 0 \
                     THEN -CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN CAST(COALESCE(json_extract(payload_json, '$.type'), -1) AS INTEGER) = 3 \
                     THEN CAST(COALESCE(json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE 0 END), 0) \
                 FROM history_archive_items WHERE terminal_instance_id = ? \
                   AND broker_server = ? COLLATE NOCASE AND login_account = ? \
                   AND item_kind = 'deal'{};",
                request.capital_filter_sql
            ),
            params_from_iter(capital_values),
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))?;
    let balance = connection
        .query_row(
            "SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL) \
             FROM account_latest WHERE terminal_instance_id = ?1 AND connection_epoch = ?2 LIMIT 1;",
            params![terminal.terminal_instance_id, terminal.connection_epoch],
            |row| row.get::<_, f64>(0),
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))?
        .unwrap_or(0.0);
    let net_result = total_profit + credit + deposit - withdrawal;
    let round = |value: f64| (value * 100.0).round() / 100.0;
    Ok(serde_json::json!({
        "account_principal": round(balance - net_result),
        "account_balance": round(balance),
        "total_profit": round(total_profit),
        "credit": round(credit),
        "deposit": round(deposit),
        "withdrawal": round(withdrawal),
        "net_result": round(net_result),
        "trade_count": total,
        "total_volume": round(total_volume),
    }))
}

fn validate_history_scope(
    terminal_instance_id: &str,
    account_ref: &AccountRef,
) -> Result<(), StoreError> {
    if validate_id(terminal_instance_id).is_err() || account_ref.validate().is_err() {
        return Err(StoreError::new("bridge_store_history_scope_invalid"));
    }
    Ok(())
}

fn validate_history_cursor(cursor: &HistoryCursor) -> Result<(), StoreError> {
    if cursor.time_msc < 0
        || cursor.ticket.len() > 32
        || cursor.ticket.bytes().any(|byte| !byte.is_ascii_digit())
        || cursor.time_msc == 0 && !cursor.ticket.is_empty()
        || cursor.time_msc > 0 && cursor.ticket.is_empty()
    {
        return Err(StoreError::new("bridge_store_history_cursor_invalid"));
    }
    Ok(())
}

fn parse_history_cursor(value: &str) -> Result<HistoryCursor, StoreError> {
    let cursor = serde_json::from_str::<HistoryCursor>(value)
        .map_err(|_| StoreError::new("bridge_store_history_cursor_invalid"))?;
    validate_history_cursor(&cursor)?;
    Ok(cursor)
}

fn compare_history_cursor(left: &HistoryCursor, right: &HistoryCursor) -> std::cmp::Ordering {
    left.time_msc
        .cmp(&right.time_msc)
        .then_with(|| compare_decimal_strings(&left.ticket, &right.ticket))
}

fn compare_decimal_strings(left: &str, right: &str) -> std::cmp::Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn history_scalar(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|number| number.to_string()))
                .filter(|text| !text.trim().is_empty())
        })
    })
}

fn history_time_msc(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<i64, StoreError> {
    ["time_msc", "close_time_msc", "event_time_msc"]
        .iter()
        .find_map(|key| object.get(*key).and_then(serde_json::Value::as_i64))
        .filter(|value| *value > 0)
        .ok_or_else(|| StoreError::new("bridge_store_history_item_invalid"))
}

fn upsert_history_items(
    transaction: &Transaction<'_>,
    terminal: &TerminalDescriptor,
    item_kind: &str,
    items: &[serde_json::Value],
    observed_at_utc_msc: i64,
) -> Result<(), StoreError> {
    for item in items {
        let object = item
            .as_object()
            .ok_or_else(|| StoreError::new("bridge_store_history_item_invalid"))?;
        let item_id = match item_kind {
            "deal" => history_scalar(object, &["deal_ticket", "ticket"]),
            "history_order" => history_scalar(object, &["ticket", "order"]),
            "trade" => history_scalar(object, &["deal_ticket", "ticket", "order"]),
            _ => None,
        }
        .filter(|value| {
            value.len() <= 32
                && value.bytes().all(|byte| byte.is_ascii_digit())
                && value.bytes().any(|byte| byte != b'0')
        })
        .ok_or_else(|| StoreError::new("bridge_store_history_item_invalid"))?;
        let event_time_msc = history_time_msc(object)?;
        let position_id = history_scalar(object, &["position_id", "position"]);
        let order_ticket = history_scalar(object, &["order_ticket", "order"]);
        let symbol = history_scalar(object, &["symbol"]);
        if position_id.as_ref().is_some_and(|value| value.len() > 32)
            || order_ticket.as_ref().is_some_and(|value| value.len() > 32)
            || symbol.as_ref().is_some_and(|value| value.len() > 64)
        {
            return Err(StoreError::new("bridge_store_history_item_invalid"));
        }
        let payload_json = serde_json::to_string(item)
            .map_err(|_| StoreError::new("bridge_store_history_item_invalid"))?;
        if payload_json.len() > MAX_HISTORY_ITEM_BYTES {
            return Err(StoreError::new("bridge_store_history_item_too_large"));
        }
        transaction
            .execute(
                "INSERT INTO history_archive_items (\
                   terminal_instance_id, broker_server, login_account, platform, item_kind,\
                   item_id, event_time_msc, position_id, order_ticket, symbol, payload_json, updated_at_utc_msc\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)\
                 ON CONFLICT(terminal_instance_id, broker_server, login_account, item_kind, item_id)\
                 DO UPDATE SET platform = excluded.platform, event_time_msc = excluded.event_time_msc,\
                   position_id = excluded.position_id, order_ticket = excluded.order_ticket,\
                   symbol = excluded.symbol, payload_json = excluded.payload_json,\
                   updated_at_utc_msc = excluded.updated_at_utc_msc;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                    item_kind,
                    item_id,
                    event_time_msc,
                    position_id,
                    order_ticket,
                    symbol,
                    payload_json,
                    observed_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_item_write_failed"))?;
    }
    Ok(())
}

fn read_json_rows<P: rusqlite::Params>(
    statement: &mut rusqlite::Statement<'_>,
    params: P,
) -> Result<Vec<serde_json::Value>, StoreError> {
    let rows = statement
        .query_map(params, |row| row.get::<_, String>(0))
        .map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
    rows.map(|row| {
        let value = row.map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
        serde_json::from_str(&value)
            .ok()
            .filter(serde_json::Value::is_object)
            .ok_or_else(|| StoreError::new("bridge_store_history_payload_invalid"))
    })
    .collect()
}

fn read_history_state_locked(
    connection: &Connection,
    terminal: &TerminalDescriptor,
) -> Result<HistoryArchiveState, StoreError> {
    connection
        .query_row(
            "SELECT cursor_value, is_complete, updated_at_utc_msc FROM history_archive_state \
             WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE \
               AND login_account = ?3 LIMIT 1;",
            params![
                terminal.terminal_instance_id,
                terminal.account_ref.broker_server,
                terminal.account_ref.login
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?
        .map(|(cursor, complete, updated_at)| {
            if !matches!(complete, 0 | 1) || updated_at <= 0 {
                return Err(StoreError::new("bridge_store_history_state_invalid"));
            }
            Ok(HistoryArchiveState {
                cursor: parse_history_cursor(&cursor)?,
                is_complete: complete == 1,
                updated_at_utc_msc: updated_at,
            })
        })
        .transpose()
        .map(|state| {
            state.unwrap_or(HistoryArchiveState {
                cursor: HistoryCursor::default(),
                is_complete: false,
                updated_at_utc_msc: 0,
            })
        })
}

fn read_history_evidence(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    trades: &[serde_json::Value],
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>, bool), StoreError> {
    let mut positions = Vec::new();
    let mut orders = Vec::new();
    for trade in trades {
        let Some(object) = trade.as_object() else {
            continue;
        };
        if let Some(value) = history_scalar(object, &["position_id", "position"]) {
            positions.push(value);
        }
        if let Some(value) = history_scalar(object, &["order_ticket", "order"]) {
            orders.push(value);
        }
    }
    positions.sort();
    positions.dedup();
    orders.sort();
    orders.dedup();
    if positions.is_empty() && orders.is_empty() {
        return Ok((Vec::new(), Vec::new(), false));
    }
    let deals = query_history_evidence(connection, terminal, "deal", &positions, &orders)?;
    let history_orders =
        query_history_evidence(connection, terminal, "history_order", &positions, &orders)?;
    let truncated = deals.len() > MAX_HISTORY_EVIDENCE_ITEMS
        || history_orders.len() > MAX_HISTORY_EVIDENCE_ITEMS;
    Ok((
        deals.into_iter().take(MAX_HISTORY_EVIDENCE_ITEMS).collect(),
        history_orders
            .into_iter()
            .take(MAX_HISTORY_EVIDENCE_ITEMS)
            .collect(),
        truncated,
    ))
}

fn hydrate_history_trade_protection(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    trades: &mut [serde_json::Value],
) -> Result<(), StoreError> {
    let mut opening_orders = trades
        .iter()
        .filter_map(serde_json::Value::as_object)
        .filter_map(|trade| history_scalar(trade, &["ticket", "order"]))
        .collect::<Vec<_>>();
    opening_orders.sort();
    opening_orders.dedup();
    if opening_orders.is_empty() {
        return Ok(());
    }

    let placeholders = std::iter::repeat_n("?", opening_orders.len())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT payload_json FROM history_archive_items \
         WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
           AND login_account = ? AND item_kind = 'history_order' \
           AND (item_id IN ({placeholders}) OR order_ticket IN ({placeholders}));"
    );
    let mut values = history_scope_values(terminal);
    values.extend(opening_orders.iter().cloned().map(SqlValue::Text));
    values.extend(opening_orders.iter().cloned().map(SqlValue::Text));
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
    let history_orders = read_json_rows(&mut statement, params_from_iter(values))?;

    for trade in trades {
        let Some(trade_object) = trade.as_object_mut() else {
            continue;
        };
        let Some(opening_order) = history_scalar(trade_object, &["ticket", "order"]) else {
            continue;
        };
        let Some(protection) = history_orders.iter().find_map(|order| {
            let object = order.as_object()?;
            (history_scalar(object, &["ticket", "order", "order_ticket"]).as_deref()
                == Some(opening_order.as_str()))
            .then_some(object)
        }) else {
            continue;
        };
        for (target, source) in [("stop_loss", "sl"), ("take_profit", "tp")] {
            let current = trade_object
                .get(target)
                .and_then(serde_json::Value::as_f64)
                .unwrap_or_default();
            let replacement = protection
                .get(source)
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0);
            if current <= 0.0
                && let Some(number) = replacement.and_then(serde_json::Number::from_f64)
            {
                trade_object.insert(target.to_owned(), serde_json::Value::Number(number));
            }
        }
    }
    Ok(())
}

fn query_history_evidence(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    kind: &str,
    positions: &[String],
    orders: &[String],
) -> Result<Vec<serde_json::Value>, StoreError> {
    let position_placeholders = std::iter::repeat_n("?", positions.len())
        .collect::<Vec<_>>()
        .join(",");
    let order_placeholders = std::iter::repeat_n("?", orders.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut predicates = Vec::new();
    if !positions.is_empty() {
        predicates.push(format!("position_id IN ({position_placeholders})"));
    }
    if !orders.is_empty() {
        if kind == "history_order" {
            predicates.push(format!(
                "(order_ticket IN ({order_placeholders}) OR item_id IN ({order_placeholders}))"
            ));
        } else {
            predicates.push(format!("order_ticket IN ({order_placeholders})"));
        }
    }
    let query = format!(
        "SELECT payload_json FROM history_archive_items \
         WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
           AND login_account = ? AND item_kind = ? AND ({}) \
         ORDER BY event_time_msc, item_id LIMIT ?;",
        predicates.join(" OR ")
    );
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(kind.to_owned()),
    ];
    values.extend(positions.iter().cloned().map(SqlValue::Text));
    values.extend(orders.iter().cloned().map(SqlValue::Text));
    if kind == "history_order" {
        values.extend(orders.iter().cloned().map(SqlValue::Text));
    }
    values.push(SqlValue::Integer((MAX_HISTORY_EVIDENCE_ITEMS + 1) as i64));
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
    read_json_rows(&mut statement, params_from_iter(values))
}

fn enforce_history_payload_budget(payload: &mut serde_json::Value) -> Result<(), StoreError> {
    let encoded_len = |value: &serde_json::Value| {
        serde_json::to_vec(value)
            .map(|encoded| encoded.len())
            .map_err(|_| StoreError::new("bridge_store_history_payload_invalid"))
    };
    if encoded_len(payload)? <= MAX_HISTORY_PAGE_PAYLOAD_BYTES {
        return Ok(());
    }
    let Some(object) = payload.as_object_mut() else {
        return Err(StoreError::new("bridge_store_history_payload_invalid"));
    };
    object["history_sync"]["evidence_truncated"] = serde_json::Value::Bool(true);
    for key in ["deals", "history_orders"] {
        loop {
            if encoded_len(&serde_json::Value::Object(object.clone()))?
                <= MAX_HISTORY_PAGE_PAYLOAD_BYTES
            {
                return Ok(());
            }
            let removed = object
                .get_mut(key)
                .and_then(serde_json::Value::as_array_mut)
                .and_then(Vec::pop);
            if removed.is_none() {
                break;
            }
        }
    }
    Err(StoreError::new("bridge_store_history_page_too_large"))
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
    fn native_store_creates_a_complete_fresh_database_and_recovers_an_empty_file() {
        for suffix in ["fresh", "empty"] {
            let root = unique_test_directory(suffix);
            let path = root.join("nested").join(BRIDGE_DATABASE_FILE_NAME);
            if suffix == "empty" {
                fs::create_dir_all(path.parent().expect("database parent"))
                    .expect("empty database directory");
                fs::write(&path, []).expect("empty database file");
            }
            {
                let store = OutboxStore::open_or_create(&path).expect("native fresh store");
                assert!(
                    store
                        .enqueue(&NewOutboxRecord {
                            message_id: format!("fresh_message_{suffix}"),
                            message_type: "heartbeat".to_owned(),
                            terminal_instance_id: "mt5_terminal_fresh_01".to_owned(),
                            connection_epoch: 1,
                            priority: "data".to_owned(),
                            payload_json: "{}".to_owned(),
                            created_at_utc_msc: 1_700_000_000_000,
                        })
                        .expect("fresh outbox write")
                );
            }
            let report = inspect_existing_schema(&path).expect("fresh schema report");
            assert_eq!(report.status, SchemaCompatibilityStatus::Compatible);
            assert_eq!(report.journal_mode.as_deref(), Some("wal"));
            let connection = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .expect("fresh schema connection");
            for (table, expected_columns) in REQUIRED_SCHEMA {
                assert_eq!(
                    table_columns(&connection, table).expect("fresh table columns"),
                    expected_columns
                        .iter()
                        .map(|column| (*column).to_owned())
                        .collect::<Vec<_>>(),
                    "fresh native schema drifted for {table}"
                );
            }
            let mut statement = connection
                .prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
                )
                .expect("fresh index query");
            let indices = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("fresh index rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("fresh indices");
            assert_eq!(
                indices,
                vec![
                    "idx_deals_pending_cursor",
                    "idx_execution_receipts_completed",
                    "idx_history_archive_page",
                    "idx_history_archive_position",
                    "idx_native_command_ledger_status",
                    "idx_outbox_ready",
                    "idx_outbox_retry_ready",
                    "idx_outbox_stream_scope",
                    "idx_terminal_data_cache_freshness",
                ]
            );
            drop(statement);
            drop(connection);
            fs::remove_dir_all(root).expect("remove fresh database fixture");
        }
    }

    #[test]
    fn native_store_never_repairs_a_partially_compatible_database_in_place() {
        let root = unique_test_directory("no-repair");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, Some(("account_latest", "payload_json")));
        assert_eq!(
            OutboxStore::open_or_create(&path)
                .err()
                .expect("incompatible database rejected")
                .code(),
            "bridge_store_schema_incompatible"
        );
        let report = inspect_existing_schema(&path).expect("unchanged incompatible schema");
        assert_eq!(
            report.missing_columns,
            vec!["account_latest.payload_json".to_owned()]
        );
        fs::remove_dir_all(root).expect("remove incompatible fixture");
    }

    #[test]
    fn terminal_binding_activation_advances_epoch_and_prunes_only_stale_data_sync_state() {
        let root = unique_test_directory("terminal-binding");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("binding store");
        let terminal_path = root.join("terminal64.exe");
        let first_account = AccountRef {
            broker_server: "Broker-Demo".to_owned(),
            login: "123456".to_owned(),
        };
        let first = store
            .activate_terminal_binding(
                "mt5_terminal_01",
                "MT5",
                &terminal_path,
                &first_account,
                1_700_000_000_000,
            )
            .expect("first binding");
        assert_eq!(first.connection_epoch, 1);
        assert_eq!(first.platform, "mt5");
        assert!(first.terminal_path.is_absolute());

        let mut delta = data_delta(
            "account",
            1,
            0,
            true,
            vec![serde_json::json!({
                "login": 123456,
                "server": "Broker-Demo"
            })],
            Vec::new(),
        );
        delta.connection_epoch = 1;
        store.persist_data_delta(&delta).expect("old epoch delta");
        assert_eq!(
            store
                .activate_terminal_binding(
                    "mt5_terminal_01",
                    "unsupported",
                    &terminal_path,
                    &first_account,
                    1_700_000_000_001,
                )
                .expect_err("invalid platform")
                .code(),
            "bridge_store_binding_invalid"
        );
        let replacement_account = AccountRef {
            broker_server: "Broker-Demo".to_owned(),
            login: "654321".to_owned(),
        };
        let replacement = store
            .activate_terminal_binding(
                "mt5_terminal_01",
                "mt5",
                &terminal_path,
                &replacement_account,
                1_700_000_000_002,
            )
            .expect("replacement binding");
        assert_eq!(replacement.connection_epoch, 2);
        assert_eq!(
            store.terminal_bindings().expect("stored bindings"),
            vec![replacement]
        );
        let connection = store.connection.lock().expect("store lock");
        let stale_revisions: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stream_revisions WHERE connection_epoch = 1;",
                [],
                |row| row.get(0),
            )
            .expect("stale revisions");
        let stale_data_outbox: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM outbox_messages \
                 WHERE message_type = 'data_delta' AND connection_epoch = 1;",
                [],
                |row| row.get(0),
            )
            .expect("stale data outbox");
        assert_eq!((stale_revisions, stale_data_outbox), (0, 0));
        connection
            .execute(
                "INSERT INTO terminal_bindings (\
                   terminal_instance_id, platform, terminal_path, broker_server, login_account, \
                   connection_epoch, updated_at_utc_msc\
                 ) VALUES ('mt4_corrupt', 'mt4', 'terminal.exe', 'Broker-Demo', '111111', 1, 1700000000003);",
                [],
            )
            .expect("insert corrupt relative binding");
        drop(connection);
        assert_eq!(
            store
                .terminal_bindings()
                .expect_err("relative stored path must fail closed")
                .code(),
            "bridge_store_terminal_path_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove binding fixture");
    }

    #[test]
    fn terminal_session_epoch_uses_a_wall_clock_floor_after_runtime_migration() {
        let root = unique_test_directory("terminal-session-epoch");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("binding store");
        let binding = store
            .activate_terminal_binding(
                "mt4_terminal_epoch",
                "mt4",
                root.join("terminal-data"),
                &AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "123456".to_owned(),
                },
                1_700_000_000_000,
            )
            .expect("initial binding");
        assert_eq!(binding.connection_epoch, 1);
        let started = store
            .begin_terminal_session(&binding, 1_800_000_000_123)
            .expect("begin terminal session");
        assert_eq!(started.connection_epoch, 1_800_000_000_123);
        let restarted = store
            .begin_terminal_session(&started, 1_800_000_000_123)
            .expect("restart terminal session");
        assert_eq!(restarted.connection_epoch, 1_800_000_000_124);
        drop(store);
        fs::remove_dir_all(root).expect("remove terminal session epoch fixture");
    }

    #[test]
    fn account_scoped_activation_atomically_replaces_only_the_same_platform_path() {
        let root = unique_test_directory("terminal-binding-account-switch");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("account switch store");
        let mt4_path = root.join("MT4 Data");
        let other_mt4_path = root.join("Other MT4 Data");
        let mt5_path = root.join("terminal64.exe");
        let first_account = AccountRef {
            broker_server: "Broker-Demo".to_owned(),
            login: "1001".to_owned(),
        };
        store
            .activate_terminal_binding(
                "mt4_account_old",
                "mt4",
                &mt4_path,
                &first_account,
                1_700_000_000_000,
            )
            .expect("old MT4 account");
        store
            .activate_terminal_binding(
                "mt4_account_other",
                "mt4",
                &other_mt4_path,
                &first_account,
                1_700_000_000_001,
            )
            .expect("other MT4 terminal");
        store
            .activate_terminal_binding(
                "mt5_account",
                "mt5",
                &mt5_path,
                &first_account,
                1_700_000_000_002,
            )
            .expect("MT5 terminal");
        let replacement_account = AccountRef {
            broker_server: "Broker-Demo".to_owned(),
            login: "1002".to_owned(),
        };
        let replacement = store
            .activate_terminal_binding_for_path(
                "mt4_account_new",
                "mt4",
                &mt4_path,
                &replacement_account,
                1_700_000_000_003,
            )
            .expect("replacement MT4 account");
        assert_eq!(replacement.connection_epoch, 1);
        let bindings = store.terminal_bindings().expect("account switch bindings");
        assert!(
            !bindings
                .iter()
                .any(|binding| binding.terminal_instance_id == "mt4_account_old")
        );
        assert!(bindings.iter().any(|binding| binding == &replacement));
        assert!(
            bindings
                .iter()
                .any(|binding| binding.terminal_instance_id == "mt4_account_other")
        );
        assert!(
            bindings
                .iter()
                .any(|binding| binding.terminal_instance_id == "mt5_account")
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove account switch fixture");
    }

    #[test]
    fn terminal_data_cache_is_fresh_parameter_and_account_scoped() {
        let root = unique_test_directory("terminal-data-cache");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("cache store");
        let terminal = history_terminal("123456");
        let parameters = serde_json::json!({
            "symbol": "XAUUSD",
            "timeframe": "M5",
            "count": 100
        });
        let payload = serde_json::json!({
            "symbol": "XAUUSD.s",
            "timeframe": "M5",
            "count": 0,
            "rates": [],
            "source": "mt5"
        });
        store
            .persist_terminal_data_cache(
                &terminal,
                "rates",
                &parameters,
                1_800_000_000_000,
                1_800_000_000_100,
                &payload,
            )
            .expect("persist cache");
        assert_eq!(
            store
                .read_terminal_data_cache(&terminal, "rates", &parameters, 1_800_000_000_000,)
                .expect("fresh cache")
                .expect("cache entry")
                .payload,
            payload
        );
        assert!(
            store
                .read_terminal_data_cache(&terminal, "rates", &parameters, 1_800_000_000_100,)
                .expect("strict freshness")
                .is_none()
        );
        assert!(
            store
                .read_terminal_data_cache(
                    &terminal,
                    "rates",
                    &serde_json::json!({
                        "symbol": "XAUUSD",
                        "timeframe": "M5",
                        "count": 200
                    }),
                    0,
                )
                .expect("other parameters")
                .is_none()
        );
        assert!(
            store
                .read_terminal_data_cache(&history_terminal("654321"), "rates", &parameters, 0)
                .expect("other account")
                .is_none()
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove cache fixture");
    }

    #[test]
    fn history_archive_is_atomic_paginated_and_isolated_by_account() {
        let root = unique_test_directory("history-archive");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("history store");
        let terminal = history_terminal("123456");
        let batch = HistoryArchiveBatch {
            deals: vec![serde_json::json!({
                "deal_ticket": 5001,
                "order": 1001,
                "position_id": 42,
                "time_msc": 1_700_000_000_100_i64,
                "symbol": "XAUUSD"
            })],
            history_orders: vec![serde_json::json!({
                "ticket": 1001,
                "position_id": 42,
                "time_msc": 1_700_000_000_050_i64,
                "symbol": "XAUUSD",
                "sl": 2290.0,
                "tp": 2320.0
            })],
            trades: vec![serde_json::json!({
                "deal_ticket": 5001,
                "ticket": 1001,
                "order": 1001,
                "order_ticket": 1002,
                "position_id": 42,
                "close_time_msc": 1_700_000_000_100_i64,
                "symbol": "XAUUSD",
                "profit": 12.5,
                "stop_loss": 0.0,
                "take_profit": 0.0
            })],
            next_cursor: HistoryCursor {
                time_msc: 1_700_000_000_100,
                ticket: "5001".to_owned(),
            },
            has_more: false,
            observed_at_utc_msc: 1_700_000_000_200,
        };
        store
            .persist_history_archive_batch(&terminal, &batch)
            .expect("persist history batch");
        store
            .persist_history_archive_batch(&terminal, &batch)
            .expect("same cursor is idempotent");
        assert_eq!(
            store
                .history_archive_state(&terminal.terminal_instance_id, &terminal.account_ref)
                .expect("history state"),
            HistoryArchiveState {
                cursor: batch.next_cursor.clone(),
                is_complete: true,
                updated_at_utc_msc: batch.observed_at_utc_msc,
            }
        );

        let page = store
            .read_history_archive_page(
                &terminal,
                &serde_json::json!({ "page": 1, "page_size": 20, "include_deals": true }),
            )
            .expect("history page");
        assert_eq!(page["orders"].as_array().expect("trades").len(), 1);
        assert_eq!(page["orders"][0]["stop_loss"], 2290.0);
        assert_eq!(page["orders"][0]["take_profit"], 2320.0);
        assert_eq!(page["deals"].as_array().expect("deals").len(), 1);
        assert_eq!(
            page["history_orders"]
                .as_array()
                .expect("history orders")
                .len(),
            1
        );
        assert_eq!(page["pagination"]["total_count"], 1);
        assert_eq!(page["source"], "mt5_sqlite");
        assert_eq!(page["statistics"]["total_profit"], 12.5);
        let filtered = store
            .read_history_archive_page(
                &terminal,
                &serde_json::json!({
                    "page": 1,
                    "page_size": 20,
                    "direction": "SELL",
                    "profit_filter": "profit"
                }),
            )
            .expect("filtered history page");
        assert_eq!(filtered["pagination"]["total_count"], 0);
        assert_eq!(filtered["statistics"]["total_profit"], 0.0);
        assert_eq!(
            store
                .read_history_archive_page(
                    &terminal,
                    &serde_json::json!({ "date_from": "2026-02-30" }),
                )
                .expect_err("invalid calendar date")
                .code(),
            "history_date_invalid"
        );

        let other_account = history_terminal("654321");
        let other_page = store
            .read_history_archive_page(
                &other_account,
                &serde_json::json!({ "page": 1, "page_size": 20, "include_deals": true }),
            )
            .expect("isolated empty page");
        assert_eq!(other_page["pagination"]["total_count"], 0);
        assert!(other_page["orders"].as_array().expect("orders").is_empty());

        let mut regressed = batch.clone();
        regressed.trades = vec![serde_json::json!({
            "deal_ticket": 5002,
            "close_time_msc": 1_700_000_000_101_i64
        })];
        regressed.next_cursor = HistoryCursor {
            time_msc: 1_699_999_999_999,
            ticket: "5002".to_owned(),
        };
        assert_eq!(
            store
                .persist_history_archive_batch(&terminal, &regressed)
                .expect_err("cursor regression must roll back")
                .code(),
            "bridge_store_history_cursor_regression"
        );
        let page_after_rollback = store
            .read_history_archive_page(
                &terminal,
                &serde_json::json!({ "page": 1, "page_size": 20 }),
            )
            .expect("history page after rollback");
        assert_eq!(page_after_rollback["pagination"]["total_count"], 1);

        let mut oversized = batch;
        oversized.trades = (1..=MAX_HISTORY_BATCH_ITEMS + 1)
            .map(|ticket| {
                serde_json::json!({
                    "deal_ticket": ticket,
                    "close_time_msc": 1_700_000_100_000_i64 + ticket as i64
                })
            })
            .collect();
        assert_eq!(
            store
                .persist_history_archive_batch(&terminal, &oversized)
                .expect_err("oversized batch rejected")
                .code(),
            "bridge_store_history_batch_invalid"
        );
        assert_eq!(
            store
                .read_history_archive_page(
                    &terminal,
                    &serde_json::json!({ "page": 0, "page_size": 20 }),
                )
                .expect_err("invalid page")
                .code(),
            "history_pagination_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove history fixture");
    }

    #[test]
    fn history_chart_data_aggregates_in_sql_and_remains_account_scoped() {
        let root = unique_test_directory("history-chart");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("history chart store");
        let terminal = TerminalDescriptor {
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            worker_version: Some("3.0.0".to_owned()),
        };
        store
            .persist_data_delta(&data_delta(
                "account",
                1,
                0,
                true,
                vec![serde_json::json!({
                    "login": 123456,
                    "server": "Broker-Demo",
                    "balance": 10_060.0
                })],
                Vec::new(),
            ))
            .expect("account balance projection");
        let first_day = parse_utc_date_msc("2026-01-01").expect("first day");
        let trades = [
            (5001, first_day + 3_600_000, "BUY", 100.0),
            (5002, first_day + 7_200_000, "SELL", -50.0),
            (5003, first_day + 86_400_000 + 3_600_000, "BUY", 20.0),
            (5004, first_day + 2 * 86_400_000 + 3_600_000, "BUY", -10.0),
        ]
        .into_iter()
        .map(|(ticket, close_time_msc, direction, net_profit)| {
            serde_json::json!({
                "deal_ticket": ticket,
                "order_ticket": ticket + 1_000,
                "position_id": ticket + 2_000,
                "close_time_msc": close_time_msc,
                "symbol": "XAUUSD.s",
                "type": direction,
                "volume": 0.01,
                "net_profit": net_profit
            })
        })
        .collect::<Vec<_>>();
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades,
                    next_cursor: HistoryCursor {
                        time_msc: first_day + 2 * 86_400_000 + 3_600_000,
                        ticket: "5004".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: first_day + 3 * 86_400_000,
                },
            )
            .expect("history chart batch");

        let chart = store
            .read_history_chart_data(&terminal, &serde_json::json!({}))
            .expect("complete chart");
        assert_eq!(chart["daily"].as_array().expect("daily").len(), 3);
        assert_eq!(chart["daily"][0]["profit"], 50.0);
        assert_eq!(chart["cumulative"], serde_json::json!([50.0, 70.0, 60.0]));
        assert_eq!(chart["drawdown"], serde_json::json!([0.0, 0.0, 0.1]));
        assert_eq!(chart["stats"]["total_trades"], 4);
        assert_eq!(chart["stats"]["win_rate"], 50.0);
        assert_eq!(chart["stats"]["profit_factor"], 2.0);
        assert_eq!(chart["stats"]["gross_profit"], 120.0);
        assert_eq!(chart["stats"]["gross_loss"], 60.0);
        assert_eq!(chart["source"], "mt5_sqlite");
        assert_eq!(chart["history_sync"]["complete"], true);

        let filtered = store
            .read_history_chart_data(
                &terminal,
                &serde_json::json!({ "direction": "BUY", "profit_filter": "profit" }),
            )
            .expect("filtered chart");
        assert_eq!(filtered["stats"]["total_trades"], 2);
        assert_eq!(filtered["stats"]["profit_factor"], 999.0);
        assert_eq!(filtered["cumulative"], serde_json::json!([100.0, 120.0]));

        let ranged = store
            .read_history_chart_data(
                &terminal,
                &serde_json::json!({ "date_from": "2026-01-02", "date_to": "2026-01-03" }),
            )
            .expect("date filtered chart");
        assert_eq!(ranged["stats"]["total_trades"], 2);
        assert_eq!(ranged["cumulative"], serde_json::json!([20.0, 10.0]));

        let mut other = terminal.clone();
        other.account_ref.login = "654321".to_owned();
        let isolated = store
            .read_history_chart_data(&other, &serde_json::json!({}))
            .expect("isolated chart");
        assert_eq!(isolated["stats"]["total_trades"], 0);
        assert!(
            isolated["daily"]
                .as_array()
                .expect("isolated daily")
                .is_empty()
        );
        assert_eq!(
            store
                .read_history_chart_data(&terminal, &serde_json::json!({ "page": 1 }),)
                .expect_err("chart rejects history pagination")
                .code(),
            "history_params_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove history chart fixture");
    }

    #[test]
    fn history_response_budget_discards_evidence_but_never_the_requested_page() {
        let oversized_evidence = "x".repeat(MAX_HISTORY_PAGE_PAYLOAD_BYTES);
        let mut payload = serde_json::json!({
            "orders": [{ "deal_ticket": 1, "close_time_msc": 1 }],
            "deals": [{ "deal_ticket": 1, "comment": oversized_evidence }],
            "history_orders": [],
            "history_sync": { "evidence_truncated": false }
        });
        enforce_history_payload_budget(&mut payload).expect("evidence trimmed");
        assert!(payload["deals"].as_array().expect("deals").is_empty());
        assert_eq!(payload["orders"].as_array().expect("orders").len(), 1);
        assert_eq!(payload["history_sync"]["evidence_truncated"], true);

        let mut oversized_page = serde_json::json!({
            "orders": [{ "deal_ticket": 1, "comment": "x".repeat(MAX_HISTORY_PAGE_PAYLOAD_BYTES) }],
            "deals": [],
            "history_orders": [],
            "history_sync": { "evidence_truncated": false }
        });
        assert_eq!(
            enforce_history_payload_budget(&mut oversized_page)
                .expect_err("requested page cannot be silently truncated")
                .code(),
            "bridge_store_history_page_too_large"
        );
    }

    fn history_terminal(login: &str) -> TerminalDescriptor {
        TerminalDescriptor {
            terminal_instance_id: "mt5_terminal_history_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: login.to_owned(),
            },
            connection_epoch: 3,
            worker_version: Some("3.0.0".to_owned()),
        }
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
        let account_only = store
            .load_account_projection(
                &replacement.terminal_instance_id,
                &replacement.account_ref,
                replacement.connection_epoch,
            )
            .expect("account-only projection");
        assert_eq!(account_only, restored.account);
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
        assert_eq!(
            store
                .load_account_projection(
                    &replacement.terminal_instance_id,
                    &wrong_account,
                    replacement.connection_epoch,
                )
                .expect_err("account-only route mismatch")
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
                .reconciliation_candidates(10)
                .expect("interrupted candidate"),
            vec![ReconciliationCandidate {
                command: command.clone(),
                record: store
                    .command_ledger(&command.command_id)
                    .expect("ledger")
                    .expect("command"),
                uncertain_receipt: None,
            }]
        );
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
        assert!(
            store
                .reconciliation_candidates(10)
                .expect("unacknowledged uncertain is not eligible")
                .is_empty()
        );
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
        let candidates = store
            .reconciliation_candidates(10)
            .expect("acknowledged uncertain candidate");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].command, command);
        assert_eq!(candidates[0].uncertain_receipt.as_ref(), Some(&uncertain));

        let resolved = command_result(
            &command.command_id,
            "result_01JLEDGER002",
            1_700_000_000_009,
        );
        assert!(
            store
                .resolve_acknowledged_uncertain_receipt(&resolved)
                .expect("resolve uncertain")
        );
        assert!(
            !store
                .resolve_acknowledged_uncertain_receipt(&resolved)
                .expect("idempotent resolution")
        );
        assert_eq!(
            store
                .execution_receipt(&command.command_id)
                .expect("resolved receipt")
                .expect("receipt"),
            resolved
        );
        assert_eq!(
            store
                .pending(&resolved.message_id)
                .expect("resolved outbox")
                .expect("pending result")
                .priority,
            "trade"
        );
        let resolved_ledger = store
            .command_ledger(&command.command_id)
            .expect("resolved ledger")
            .expect("command");
        assert_eq!(resolved_ledger.status, "confirmed");
        assert_eq!(
            resolved_ledger.result_message_id.as_deref(),
            Some(resolved.message_id.as_str())
        );
        assert!(
            store
                .acknowledge_command_result(
                    &resolved.message_id,
                    &command.command_id,
                    "applied",
                    1_700_000_000_010,
                )
                .expect("ack resolved result")
        );
        assert_eq!(
            store
                .command_ledger(&command.command_id)
                .expect("final ledger")
                .expect("command")
                .status,
            "acked"
        );
        assert!(
            store
                .reconciliation_candidates(10)
                .expect("resolved candidates")
                .is_empty()
        );

        let mut conflicting_final = resolved.clone();
        conflicting_final.message_id = "result_01JLEDGER003".to_owned();
        conflicting_final.status = "failed".to_owned();
        conflicting_final.error_code = Some("reconciliation_conflict".to_owned());
        assert_eq!(
            store
                .resolve_acknowledged_uncertain_receipt(&conflicting_final)
                .expect_err("final result is immutable")
                .code(),
            "bridge_store_reconciliation_transition_invalid"
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
