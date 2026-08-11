use bridge_contract::{
    AccountRef, CommandMessage, CommandResultMessage, DataDeltaMessage, SERVER_MAX_MESSAGE_BYTES,
    TerminalDescriptor, validate_id,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
    params_from_iter,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const BRIDGE_DATABASE_FILE_NAME: &str = "bridge.db";
const DEFAULT_DATA_OUTBOX_LIMIT_PER_STREAM: i64 = 256;
const MAX_HISTORY_BATCH_ITEMS: usize = 250;
const MAX_HISTORY_EVIDENCE_ITEMS: usize = 500;
const MAX_HISTORY_EVIDENCE_REFS: usize = 100;
const MAX_HISTORY_ITEM_BYTES: usize = 16 * 1024;
const MAX_HISTORY_PAGE_PAYLOAD_BYTES: usize = SERVER_MAX_MESSAGE_BYTES - 64 * 1024;
const MAX_LEGACY_HISTORY_PAGE: i64 = 500;
const MAX_HISTORY_CURSOR_PAGE_SIZE: i64 = 200;
const MAX_HISTORY_SNAPSHOTS: usize = 256;
const MAX_HISTORY_SNAPSHOT_CURSORS: usize = 512;
const HISTORY_SNAPSHOT_TTL_MSC: i64 = 10 * 60 * 1_000;
const HISTORY_TAIL_WINDOW_MSC: i64 = 7 * 24 * 60 * 60 * 1_000;
const HISTORY_CURSOR_TOKEN_BYTES: usize = 32;
const HISTORY_DAY_MSC: i64 = 86_400_000;
/// Earliest history timestamp that the native archive planner and request
/// contract may accept.  Rows older than this are retained as rebuildable
/// evidence, but are never included in a newly planned/query range.
pub const HISTORY_COVERAGE_START_UTC_MSC: i64 = 946_684_800_000;
/// Smallest MT5 history sub-window accepted by the native scheduler.  Dense
/// ranges are retried with progressively smaller positive UTC-millisecond
/// windows; one second is the safety floor used to recover older blocked
/// backfill rows without silently dropping evidence.
pub const HISTORY_MIN_WINDOW_MSC: i64 = 1_000;
const MT4_HISTORY_SOURCE_NOTE: &str = "mt4_account_history_tab_range";

const NATIVE_COMMAND_LEDGER_REQUIRED_COLUMNS: &[&str] = &[
    "command_id",
    "payload_json",
    "status",
    "result_message_id",
    "created_at_utc_msc",
    "updated_at_utc_msc",
];

const HISTORY_RUNTIME_REQUIRED_TABLES: &[(&str, &[&str])] = &[
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
        "account_initialization_state",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "platform",
            "schema_version",
            "state",
            "local_operational_ready",
            "last_error_code",
            "initialized_at_utc_msc",
            "updated_at_utc_msc",
        ],
    ),
    (
        "history_sync_jobs",
        &[
            "job_id",
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "job_kind",
            "priority",
            "range_start_utc_msc",
            "range_end_utc_msc",
            "cursor_time_msc",
            "cursor_ticket",
            "window_msc",
            "state",
            "attempt_count",
            "next_attempt_at_utc_msc",
            "last_error_code",
            "lease_generation",
            "lease_expires_at_utc_msc",
            "created_at_utc_msc",
            "updated_at_utc_msc",
        ],
    ),
    (
        "history_coverage_ranges",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "range_start_utc_msc",
            "range_end_utc_msc",
            "observed_at_utc_msc",
            "updated_at_utc_msc",
        ],
    ),
    (
        "history_scope_state",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "platform",
            "head_ready",
            "head_range_start_utc_msc",
            "head_range_end_utc_msc",
            "coverage_complete",
            "freshness_state",
            "fresh_through_utc_msc",
            "history_revision",
            "summary_revision",
            "summary_status",
            "updated_at_utc_msc",
        ],
    ),
    (
        "history_daily_summary",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "platform",
            "generation",
            "summary_day_utc_msc",
            "item_kind",
            "direction",
            "profit_bucket",
            "trade_count",
            "net_profit",
            "volume",
            "deal_deposit",
            "deal_withdrawal",
            "deal_credit",
        ],
    ),
    (
        "history_summary_builds",
        &[
            "terminal_instance_id",
            "broker_server",
            "login_account",
            "platform",
            "active_generation",
            "building_generation",
            "updated_at_utc_msc",
        ],
    ),
];

const NATIVE_COMMAND_LEDGER_REQUIRED_INDEXES: &[&str] = &["idx_native_command_ledger_status"];
const HISTORY_RUNTIME_REQUIRED_INDEXES: &[&str] = &[
    "idx_account_initialization_updated",
    "idx_history_archive_order",
    "idx_history_sync_jobs_claim",
    "idx_history_sync_jobs_scope",
    "idx_history_coverage_ranges_scope",
    "idx_history_scope_state_updated",
    "idx_history_archive_summary_scope",
    "idx_history_archive_trade_filter",
    "idx_history_archive_trade_close",
    "idx_history_daily_summary_active",
    "idx_history_daily_summary_v2_active",
    "idx_history_summary_builds_updated",
];

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryJobBatchStatus {
    Checkpointed,
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryJobBatchResult {
    pub status: HistoryJobBatchStatus,
    pub job: HistorySyncJob,
    pub persisted_item_count: usize,
    /// Number of rows whose payload or indexed identity columns actually
    /// changed. Duplicate batches leave this at zero.
    pub changed_item_count: usize,
    pub history_changed: bool,
    pub history_revision: i64,
    pub duplicate_item_count: usize,
    pub immutable_conflict_count: usize,
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

/// Runtime freshness/version state for one terminal account and platform.
/// The legacy `history_archive_state` cursor remains for MT4 compatibility;
/// this additive state drives new metadata, invalidation, and MT5 tail plans.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryScopeState {
    pub scope: HistoryScope,
    pub platform: String,
    pub head_ready: bool,
    pub head_range_start_utc_msc: Option<i64>,
    pub head_range_end_utc_msc: Option<i64>,
    pub coverage_complete: bool,
    pub freshness_state: String,
    pub fresh_through_utc_msc: Option<i64>,
    pub history_revision: i64,
    pub summary_revision: i64,
    pub summary_status: String,
    pub duplicate_count: i64,
    pub immutable_conflict_count: i64,
    pub updated_at_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryTailRefreshRequest {
    pub scope: HistoryScope,
    pub platform: String,
    pub range_start_utc_msc: i64,
    pub range_end_utc_msc: i64,
    pub now_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryScope {
    pub terminal_instance_id: String,
    pub broker_server: String,
    pub login_account: String,
}

impl HistoryScope {
    pub fn new(terminal_instance_id: &str, account_ref: &AccountRef) -> Result<Self, StoreError> {
        let scope = Self {
            terminal_instance_id: terminal_instance_id.to_owned(),
            broker_server: account_ref.broker_server.clone(),
            login_account: account_ref.login.clone(),
        };
        validate_history_scope_values(&scope)?;
        Ok(scope)
    }

    fn account_ref(&self) -> AccountRef {
        AccountRef {
            broker_server: self.broker_server.clone(),
            login: self.login_account.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountInitializationState {
    pub scope: HistoryScope,
    pub platform: String,
    pub schema_version: i64,
    pub state: String,
    pub local_operational_ready: bool,
    pub last_error_code: Option<String>,
    pub initialized_at_utc_msc: i64,
    pub updated_at_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewHistorySyncJob {
    pub job_id: String,
    pub scope: HistoryScope,
    pub job_kind: String,
    pub priority: String,
    pub range_start_utc_msc: i64,
    pub range_end_utc_msc: i64,
    pub cursor_time_msc: i64,
    pub cursor_ticket: String,
    pub window_msc: i64,
    pub created_at_utc_msc: i64,
}

/// Atomic request for planning one bounded history range.  The planner owns
/// coverage subtraction, active-job attachment and deterministic job identity;
/// callers should not construct a synthetic `NewHistorySyncJob` for this path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryJobPlanningRequest {
    pub scope: HistoryScope,
    pub job_kind: String,
    pub priority: String,
    pub range_start_utc_msc: i64,
    pub range_end_utc_msc: i64,
    pub window_msc: i64,
    pub now_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct HistoryJobPlanningResult {
    pub created_jobs: Vec<HistorySyncJob>,
    pub attached_jobs: Vec<HistorySyncJob>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistorySyncJob {
    pub job_id: String,
    pub scope: HistoryScope,
    pub job_kind: String,
    pub priority: String,
    pub range_start_utc_msc: i64,
    pub range_end_utc_msc: i64,
    pub cursor_time_msc: i64,
    pub cursor_ticket: String,
    pub window_msc: i64,
    pub state: String,
    pub attempt_count: i64,
    pub next_attempt_at_utc_msc: i64,
    pub last_error_code: Option<String>,
    pub lease_generation: i64,
    pub lease_expires_at_utc_msc: Option<i64>,
    pub created_at_utc_msc: i64,
    pub updated_at_utc_msc: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryCoverageRange {
    pub scope: HistoryScope,
    pub range_start_utc_msc: i64,
    pub range_end_utc_msc: i64,
    pub observed_at_utc_msc: i64,
    pub updated_at_utc_msc: i64,
}

/// A user-requested history range represented as a UTC half-open interval.
///
/// The range is deliberately independent from the SQL date filters.  It is
/// used only to prove that the requested evidence is covered by the archive,
/// so adjacent pages can use the same fixed endpoint without changing their
/// completeness result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryRequestedRange {
    pub range_start_utc_msc: i64,
    pub range_end_utc_msc: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalDataCacheEntry {
    pub observed_at_utc_msc: i64,
    pub cached_at_utc_msc: i64,
    pub payload: serde_json::Value,
}

pub struct OutboxStore {
    connection: Mutex<Connection>,
    history_read_connection: Mutex<Connection>,
    history_snapshots: Mutex<HashMap<String, HistorySnapshotState>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HistoryCursorQuery {
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
    page_size: i64,
    entry_from_utc_msc: Option<i64>,
    entry_to_utc_msc: Option<i64>,
    close_from_utc_msc: Option<i64>,
    close_to_utc_msc: Option<i64>,
    direction: Option<String>,
    profit_filter: Option<String>,
}

#[derive(Clone)]
struct HistoryCursorPageRequest {
    query: HistoryCursorQuery,
    requested_range: HistoryRequestedRange,
    snapshot_id: Option<String>,
    cursor: Option<String>,
    filter_sql: String,
    filter_values: Vec<SqlValue>,
    capital_filter_sql: String,
    capital_filter_values: Vec<SqlValue>,
}

#[derive(Clone)]
struct HistorySnapshotState {
    terminal_instance_id: String,
    broker_server: String,
    login_account: String,
    platform: String,
    query: HistoryCursorQuery,
    effective_range_start_utc_msc: i64,
    effective_range_end_utc_msc: i64,
    highwater_rowid: i64,
    total_count: i64,
    statistics: serde_json::Value,
    history_sync: serde_json::Value,
    chart_data: serde_json::Value,
    history_revision: i64,
    summary_revision: i64,
    expires_at_utc_msc: i64,
    cursors: HashMap<String, HistorySnapshotCursor>,
    cursor_order: VecDeque<String>,
}

#[derive(Clone)]
struct HistorySnapshotCursor {
    page: i64,
    last_time_msc: i64,
    last_item_id: String,
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
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|_| StoreError::new("bridge_store_open_failed"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| StoreError::new("bridge_store_busy_timeout_failed"))?;
        match runtime_schema_status(&connection)? {
            RuntimeSchemaStatus::Complete => {
                // A legacy 2.x writer may still advance history_archive_state
                // after the runtime tables have been created.  Preserve that
                // compatibility only when a read-only comparison proves a
                // newer valid cursor needs seeding; ordinary 3.0 opens stay
                // entirely free of schema writes.
                let seed_needed = legacy_history_seed_needed(&connection)?;
                configure_open_connection(&connection)?;
                if seed_needed {
                    ensure_history_runtime_schema(&mut connection)?;
                    if runtime_schema_status(&connection)? != RuntimeSchemaStatus::Complete {
                        return Err(StoreError::new("bridge_store_schema_incompatible"));
                    }
                }
            }
            RuntimeSchemaStatus::Incompatible => {
                return Err(StoreError::new("bridge_store_schema_incompatible"));
            }
            RuntimeSchemaStatus::NeedsMigration => {
                // The common path is deliberately read-only: CREATE IF NOT
                // EXISTS still takes SQLite's schema write lock even when all
                // objects already exist.  Only genuinely old databases enter
                // the migration path below.
                configure_open_connection(&connection)?;
                ensure_native_command_ledger_schema(&connection)?;
                ensure_history_runtime_schema(&mut connection)?;
                if runtime_schema_status(&connection)? != RuntimeSchemaStatus::Complete {
                    return Err(StoreError::new("bridge_store_schema_incompatible"));
                }
            }
        }
        let history_read_connection = open_history_read_connection(path)?;
        Ok(Self {
            connection: Mutex::new(connection),
            history_read_connection: Mutex::new(history_read_connection),
            history_snapshots: Mutex::new(HashMap::new()),
        })
    }

    pub fn read_account_initialization_state(
        &self,
        scope: &HistoryScope,
    ) -> Result<Option<AccountInitializationState>, StoreError> {
        validate_history_scope_values(scope)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        read_account_initialization_state_locked(&connection, scope)
    }

    pub fn account_initialization_state(
        &self,
        scope: &HistoryScope,
    ) -> Result<Option<AccountInitializationState>, StoreError> {
        self.read_account_initialization_state(scope)
    }

    pub fn write_account_initialization_state(
        &self,
        state: &AccountInitializationState,
    ) -> Result<(), StoreError> {
        validate_account_initialization_state(state)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .execute(
                "INSERT INTO account_initialization_state (
                   terminal_instance_id, broker_server, login_account, platform,
                   schema_version, state, local_operational_ready, last_error_code,
                   initialized_at_utc_msc, updated_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(terminal_instance_id, broker_server, login_account) DO UPDATE SET
                   platform = excluded.platform,
                   schema_version = excluded.schema_version,
                   state = excluded.state,
                   local_operational_ready = excluded.local_operational_ready,
                   last_error_code = excluded.last_error_code,
                   initialized_at_utc_msc = excluded.initialized_at_utc_msc,
                   updated_at_utc_msc = excluded.updated_at_utc_msc;",
                params![
                    state.scope.terminal_instance_id,
                    state.scope.broker_server,
                    state.scope.login_account,
                    state.platform,
                    state.schema_version,
                    state.state,
                    i64::from(state.local_operational_ready),
                    state.last_error_code,
                    state.initialized_at_utc_msc,
                    state.updated_at_utc_msc,
                ],
            )
            .map(|_| ())
            .map_err(|_| StoreError::new("bridge_store_initialization_state_write_failed"))
    }

    pub fn enqueue_history_job(
        &self,
        job: &NewHistorySyncJob,
    ) -> Result<HistorySyncJob, StoreError> {
        validate_new_history_sync_job(job)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_history_job_transaction_failed"))?;
        if let Some(existing) = read_history_sync_job_by_id(&transaction, &job.job_id)? {
            if !history_scopes_equal(&existing.scope, &job.scope)
                || existing.job_kind != job.job_kind
                || existing.priority != job.priority
                || existing.range_start_utc_msc != job.range_start_utc_msc
                || existing.range_end_utc_msc != job.range_end_utc_msc
                || existing.cursor_time_msc != job.cursor_time_msc
                || existing.cursor_ticket != job.cursor_ticket
                || existing.window_msc != job.window_msc
                || existing.created_at_utc_msc != job.created_at_utc_msc
            {
                return Err(StoreError::new("bridge_store_history_job_conflict"));
            }
            transaction
                .commit()
                .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
            return Ok(existing);
        }
        transaction
            .execute(
                "INSERT INTO history_sync_jobs (
                   job_id, terminal_instance_id, broker_server, login_account,
                   job_kind, priority, range_start_utc_msc, range_end_utc_msc,
                   cursor_time_msc, cursor_ticket, window_msc, state, attempt_count,
                   next_attempt_at_utc_msc, last_error_code, lease_generation,
                   lease_expires_at_utc_msc, created_at_utc_msc, updated_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                           'queued', 0, ?12, NULL, 0, NULL, ?12, ?12)
                 ON CONFLICT(
                   terminal_instance_id, broker_server, login_account,
                   range_start_utc_msc, range_end_utc_msc
                 ) DO NOTHING;",
                params![
                    job.job_id,
                    job.scope.terminal_instance_id,
                    job.scope.broker_server,
                    job.scope.login_account,
                    job.job_kind,
                    job.priority,
                    job.range_start_utc_msc,
                    job.range_end_utc_msc,
                    job.cursor_time_msc,
                    job.cursor_ticket,
                    job.window_msc,
                    job.created_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_job_write_failed"))?;
        let existing = read_history_sync_job_by_range(
            &transaction,
            &job.scope,
            job.range_start_utc_msc,
            job.range_end_utc_msc,
        )?
        .ok_or_else(|| StoreError::new("bridge_store_history_job_write_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
        Ok(existing)
    }

    pub fn enqueue_history_sync_job(
        &self,
        job: &NewHistorySyncJob,
    ) -> Result<HistorySyncJob, StoreError> {
        self.enqueue_history_job(job)
    }

    /// Enqueue a history job, promoting an existing lower-priority request for
    /// the exact same account scope and half-open range when the new request is
    /// P1.  The ordinary `enqueue_history_job` immutability contract remains
    /// unchanged; this entry point is intentionally the only path that may
    /// promote P2/P3 work.
    pub fn enqueue_or_promote_history_job(
        &self,
        job: &NewHistorySyncJob,
    ) -> Result<HistorySyncJob, StoreError> {
        validate_new_history_sync_job(job)?;
        if job.priority != "p1" {
            return self.enqueue_history_job(job);
        }
        let now_utc_msc = job.created_at_utc_msc;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_job_transaction_failed"))?;

        if let Some(existing_by_id) = read_history_sync_job_by_id(&transaction, &job.job_id)?
            && (!history_scopes_equal(&existing_by_id.scope, &job.scope)
                || existing_by_id.range_start_utc_msc != job.range_start_utc_msc
                || existing_by_id.range_end_utc_msc != job.range_end_utc_msc)
        {
            return Err(StoreError::new("bridge_store_history_job_conflict"));
        }

        // The insert is intentionally idempotent on the schema's unique
        // (scope, range) key.  Reading again after the insert handles a race
        // in which another writer created the same range just before us.
        transaction
            .execute(
                "INSERT INTO history_sync_jobs (
                   job_id, terminal_instance_id, broker_server, login_account,
                   job_kind, priority, range_start_utc_msc, range_end_utc_msc,
                   cursor_time_msc, cursor_ticket, window_msc, state, attempt_count,
                   next_attempt_at_utc_msc, last_error_code, lease_generation,
                   lease_expires_at_utc_msc, created_at_utc_msc, updated_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                           'queued', 0, ?12, NULL, 0, NULL, ?12, ?12)
                 ON CONFLICT(
                   terminal_instance_id, broker_server, login_account,
                   range_start_utc_msc, range_end_utc_msc
                 ) DO NOTHING;",
                params![
                    job.job_id,
                    job.scope.terminal_instance_id,
                    job.scope.broker_server,
                    job.scope.login_account,
                    job.job_kind,
                    job.priority,
                    job.range_start_utc_msc,
                    job.range_end_utc_msc,
                    job.cursor_time_msc,
                    job.cursor_ticket,
                    job.window_msc,
                    job.created_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_job_write_failed"))?;
        let existing = read_history_sync_job_by_range(
            &transaction,
            &job.scope,
            job.range_start_utc_msc,
            job.range_end_utc_msc,
        )?
        .ok_or_else(|| StoreError::new("bridge_store_history_job_write_failed"))?;

        let promoted = if existing.priority == "p1" {
            match existing.state.as_str() {
                "queued" | "retrying" | "running" | "completed" => existing,
                "blocked" | "superseded" => {
                    return Err(StoreError::new(
                        "bridge_store_history_job_promotion_invalid",
                    ));
                }
                _ => return Err(StoreError::new("bridge_store_history_job_invalid")),
            }
        } else if matches!(existing.priority.as_str(), "p2" | "p3") {
            match existing.state.as_str() {
                "queued" | "retrying" | "running" => {
                    let affected = transaction
                        .execute(
                            "UPDATE history_sync_jobs
                             SET priority = 'p1',
                                 next_attempt_at_utc_msc = CASE
                                   WHEN next_attempt_at_utc_msc > ?1 THEN ?1
                                   ELSE next_attempt_at_utc_msc
                                 END,
                                 updated_at_utc_msc = ?1
                             WHERE terminal_instance_id = ?2
                               AND broker_server = ?3 COLLATE NOCASE
                               AND login_account = ?4
                               AND range_start_utc_msc = ?5
                               AND range_end_utc_msc = ?6
                               AND priority IN ('p2', 'p3')
                               AND state IN ('queued', 'retrying', 'running');",
                            params![
                                now_utc_msc,
                                job.scope.terminal_instance_id,
                                job.scope.broker_server,
                                job.scope.login_account,
                                job.range_start_utc_msc,
                                job.range_end_utc_msc,
                            ],
                        )
                        .map_err(|_| StoreError::new("bridge_store_history_job_promote_failed"))?;
                    if affected != 1 {
                        return Err(StoreError::new(
                            "bridge_store_history_job_promotion_invalid",
                        ));
                    }
                    read_history_sync_job_by_range(
                        &transaction,
                        &job.scope,
                        job.range_start_utc_msc,
                        job.range_end_utc_msc,
                    )?
                    .ok_or_else(|| StoreError::new("bridge_store_history_job_promote_failed"))?
                }
                "completed" => existing,
                "blocked" | "superseded" => {
                    return Err(StoreError::new(
                        "bridge_store_history_job_promotion_invalid",
                    ));
                }
                _ => return Err(StoreError::new("bridge_store_history_job_invalid")),
            }
        } else {
            return Err(StoreError::new(
                "bridge_store_history_job_promotion_invalid",
            ));
        };
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
        Ok(promoted)
    }

    /// Atomically subtract completed coverage and in-flight allowed jobs from
    /// a requested range, creating deterministic gap jobs and returning the
    /// jobs that were attached to by the request.  Only the semantic
    /// combinations used by the new scheduler are accepted.  Backfill rows
    /// created before the modern floor remain collision-safe; a precise
    /// modern backfill re-plan may requeue one blocked dense row at the new
    /// minimum window, while all other terminal collisions stay fail-closed.
    pub fn plan_history_jobs(
        &self,
        request: &HistoryJobPlanningRequest,
    ) -> Result<HistoryJobPlanningResult, StoreError> {
        validate_history_job_planning_request(request)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_planning_transaction_failed"))?;

        let coverage = read_history_coverage_ranges_locked(&transaction, &request.scope)?;
        let mut active_jobs = read_active_history_jobs_locked(&transaction, &request.scope)?;
        let exact_existing = read_history_sync_job_by_range(
            &transaction,
            &request.scope,
            request.range_start_utc_msc,
            request.range_end_utc_msc,
        )?;
        let mut attached_jobs = Vec::new();

        // An exact active lower-priority allowed job is promoted in place for
        // P1.  Preserve progress and lease ownership while making a delayed
        // retry immediately claimable, matching the existing promotion path.
        if request.priority == "p1"
            && exact_existing.as_ref().is_some_and(|job| {
                is_allowed_history_job_kind(&job.job_kind)
                    && !(job.job_kind == "backfill"
                        && request.now_utc_msc < HISTORY_COVERAGE_START_UTC_MSC)
                    && matches!(job.state.as_str(), "queued" | "retrying" | "running")
                    && matches!(job.priority.as_str(), "p2" | "p3")
            })
        {
            let affected = transaction
                .execute(
                    "UPDATE history_sync_jobs
                     SET priority = 'p1',
                         next_attempt_at_utc_msc = CASE
                           WHEN next_attempt_at_utc_msc > ?1 THEN ?1
                           ELSE next_attempt_at_utc_msc
                         END,
                         updated_at_utc_msc = ?1
                     WHERE terminal_instance_id = ?2
                       AND broker_server = ?3 COLLATE NOCASE
                       AND login_account = ?4
                       AND range_start_utc_msc = ?5
                       AND range_end_utc_msc = ?6
                       AND job_kind IN ('recent', 'on_demand', 'backfill')
                       AND priority IN ('p2', 'p3')
                       AND state IN ('queued', 'retrying', 'running');",
                    params![
                        request.now_utc_msc,
                        request.scope.terminal_instance_id,
                        request.scope.broker_server,
                        request.scope.login_account,
                        request.range_start_utc_msc,
                        request.range_end_utc_msc,
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_planning_promote_failed"))?;
            if affected != 1 {
                return Err(StoreError::new(
                    "bridge_store_history_planning_promote_failed",
                ));
            }
            let promoted = read_history_sync_job_by_range(
                &transaction,
                &request.scope,
                request.range_start_utc_msc,
                request.range_end_utc_msc,
            )?
            .ok_or_else(|| StoreError::new("bridge_store_history_planning_promote_failed"))?;
            active_jobs.retain(|job| job.job_id != promoted.job_id);
            active_jobs.push(promoted.clone());
            attached_jobs.push(promoted);
        }

        let mut blockers = coverage
            .iter()
            .map(|range| (range.range_start_utc_msc, range.range_end_utc_msc))
            .collect::<Vec<_>>();
        for job in &active_jobs {
            if !is_allowed_history_job_kind(&job.job_kind)
                || (job.job_kind == "backfill"
                    && request.now_utc_msc < HISTORY_COVERAGE_START_UTC_MSC)
                || !matches!(job.state.as_str(), "queued" | "retrying" | "running")
            {
                continue;
            }
            if request.priority == "p1" && job.priority != "p1" {
                continue;
            }
            blockers.push((job.range_start_utc_msc, job.range_end_utc_msc));
            if ranges_overlap(
                request.range_start_utc_msc,
                request.range_end_utc_msc,
                job.range_start_utc_msc,
                job.range_end_utc_msc,
            ) {
                attached_jobs.push(job.clone());
            }
        }
        let gaps = subtract_history_ranges(
            request.range_start_utc_msc,
            request.range_end_utc_msc,
            &blockers,
        );

        let mut created_jobs = Vec::new();
        for (range_start_utc_msc, range_end_utc_msc) in gaps {
            let job_id = history_job_identity(
                &request.scope,
                &request.job_kind,
                range_start_utc_msc,
                range_end_utc_msc,
            );
            let affected = transaction
                .execute(
                    "INSERT INTO history_sync_jobs (
                       job_id, terminal_instance_id, broker_server, login_account,
                       job_kind, priority, range_start_utc_msc, range_end_utc_msc,
                       cursor_time_msc, cursor_ticket, window_msc, state, attempt_count,
                       next_attempt_at_utc_msc, last_error_code, lease_generation,
                       lease_expires_at_utc_msc, created_at_utc_msc, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7, '0', ?9,
                               'queued', 0, ?10, NULL, 0, NULL, ?10, ?10)
                     ON CONFLICT(
                       terminal_instance_id, broker_server, login_account,
                       range_start_utc_msc, range_end_utc_msc
                     ) DO NOTHING;",
                    params![
                        job_id,
                        request.scope.terminal_instance_id,
                        request.scope.broker_server,
                        request.scope.login_account,
                        request.job_kind,
                        request.priority,
                        range_start_utc_msc,
                        range_end_utc_msc,
                        request.window_msc,
                        request.now_utc_msc,
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_planning_write_failed"))?;
            let existing = read_history_sync_job_by_range(
                &transaction,
                &request.scope,
                range_start_utc_msc,
                range_end_utc_msc,
            )?
            .ok_or_else(|| StoreError::new("bridge_store_history_planning_write_failed"))?;
            if affected == 1 {
                created_jobs.push(existing);
                continue;
            }
            if existing.job_kind == "backfill" {
                // A blocked dense backfill created with the old 15-minute
                // floor gets exactly one recovery attempt after the modern
                // floor is in effect.  Keep its identity, range, cursor,
                // ticket, priority and attempt count; only make the smaller
                // sub-window claimable again and clear the terminal error.
                // The request must itself be the scheduler's backfill plan,
                // so an on-demand read can never revive a terminal row.
                if request.now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC
                    && request.job_kind == "backfill"
                    && existing.state == "blocked"
                    && existing.last_error_code.as_deref() == Some("blocked_dense_range")
                    && existing.window_msc > HISTORY_MIN_WINDOW_MSC
                {
                    let affected = transaction
                        .execute(
                            "UPDATE history_sync_jobs
                             SET window_msc = ?1,
                                 state = 'queued',
                                 next_attempt_at_utc_msc = ?2,
                                 last_error_code = NULL,
                                 lease_expires_at_utc_msc = NULL,
                                 updated_at_utc_msc = ?2
                             WHERE job_id = ?3
                               AND terminal_instance_id = ?4
                               AND broker_server = ?5 COLLATE NOCASE
                               AND login_account = ?6
                               AND job_kind = 'backfill'
                               AND state = 'blocked'
                               AND last_error_code = 'blocked_dense_range'
                               AND window_msc > ?1;",
                            params![
                                HISTORY_MIN_WINDOW_MSC,
                                request.now_utc_msc,
                                existing.job_id,
                                request.scope.terminal_instance_id,
                                request.scope.broker_server,
                                request.scope.login_account,
                            ],
                        )
                        .map_err(|_| {
                            StoreError::new("bridge_store_history_planning_requeue_failed")
                        })?;
                    if affected != 1 {
                        return Err(StoreError::new(
                            "bridge_store_history_planning_requeue_failed",
                        ));
                    }
                    // Match the ordinary retry path: once the terminal row is
                    // claimable again, expose the scope as refreshing rather
                    // than leaving the old terminal freshness marker visible
                    // while the scheduler resumes the bounded archive flight.
                    if let Some(platform) = transaction
                        .query_row(
                            "SELECT platform FROM terminal_bindings
                             WHERE terminal_instance_id = ?1
                               AND broker_server = ?2 COLLATE NOCASE
                               AND login_account = ?3 LIMIT 1;",
                            params![
                                request.scope.terminal_instance_id,
                                request.scope.broker_server,
                                request.scope.login_account
                            ],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()
                        .map_err(|_| {
                            StoreError::new("bridge_store_history_planning_state_query_failed")
                        })?
                    {
                        let mut state = read_history_scope_state_locked(
                            &transaction,
                            &request.scope,
                            &platform,
                        )?;
                        state.freshness_state = "refreshing".to_owned();
                        state.updated_at_utc_msc = request.now_utc_msc;
                        write_history_scope_state_tx(&transaction, &state)?;
                    }
                    let resumed = read_history_sync_job_by_id(&transaction, &existing.job_id)?
                        .ok_or_else(|| {
                            StoreError::new("bridge_store_history_planning_requeue_failed")
                        })?;
                    attached_jobs.push(resumed);
                    continue;
                }
                // A dense-range backfill is deliberately terminal once it
                // has already reached the modern floor.  An exact re-plan is
                // an attachment, not a legacy collision; keep every field
                // untouched so a second planner pass cannot revive it in a
                // loop.  Legacy clocks, non-dense terminal rows and all
                // other backfill collisions keep the conservative contract.
                if request.now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC
                    && existing.state == "blocked"
                    && existing.last_error_code.as_deref() == Some("blocked_dense_range")
                {
                    attached_jobs.push(existing);
                    continue;
                }
                return Err(StoreError::new(
                    "bridge_store_history_planning_legacy_collision",
                ));
            }
            if is_allowed_history_job_kind(&existing.job_kind)
                && !(existing.job_kind == "backfill"
                    && request.now_utc_msc < HISTORY_COVERAGE_START_UTC_MSC)
                && matches!(existing.state.as_str(), "queued" | "retrying" | "running")
            {
                if request.priority == "p1" && matches!(existing.priority.as_str(), "p2" | "p3") {
                    let affected = transaction
                        .execute(
                            "UPDATE history_sync_jobs
                             SET priority = 'p1',
                                 next_attempt_at_utc_msc = CASE
                                   WHEN next_attempt_at_utc_msc > ?1 THEN ?1
                                   ELSE next_attempt_at_utc_msc
                                 END,
                                 updated_at_utc_msc = ?1
                             WHERE job_id = ?2 AND priority IN ('p2', 'p3')
                               AND state IN ('queued', 'retrying', 'running');",
                            params![request.now_utc_msc, existing.job_id.as_str()],
                        )
                        .map_err(|_| {
                            StoreError::new("bridge_store_history_planning_promote_failed")
                        })?;
                    if affected != 1 {
                        return Err(StoreError::new(
                            "bridge_store_history_planning_promote_failed",
                        ));
                    }
                    let promoted = read_history_sync_job_by_id(&transaction, &existing.job_id)?
                        .ok_or_else(|| {
                            StoreError::new("bridge_store_history_planning_promote_failed")
                        })?;
                    attached_jobs.push(promoted);
                } else {
                    attached_jobs.push(existing);
                }
                continue;
            }
            return Err(StoreError::new("bridge_store_history_planning_collision"));
        }
        dedup_history_jobs(&mut attached_jobs);
        attached_jobs.sort_by(history_job_order);
        created_jobs.sort_by(history_job_order);
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_planning_commit_failed"))?;
        Ok(HistoryJobPlanningResult {
            created_jobs,
            attached_jobs,
        })
    }

    /// Plan a repeatable MT5 tail refresh.  Unlike coverage planning this
    /// path intentionally ignores existing coverage ranges and may reactivate
    /// a completed tail row.  Active overlapping tail flights are merged in
    /// place and their endpoint is only ever extended, so a later trigger
    /// cannot be lost.
    pub fn plan_history_tail_refresh(
        &self,
        request: &HistoryTailRefreshRequest,
    ) -> Result<HistoryJobPlanningResult, StoreError> {
        validate_history_tail_refresh_request(request)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_planning_transaction_failed"))?;

        // Keep completed tail rows bounded.  A small cap avoids an unbounded
        // history_sync_jobs table while preserving recent audit evidence.
        let prune_before = request.now_utc_msc.saturating_sub(10 * 60 * 1_000);
        transaction
            .execute(
                "DELETE FROM history_sync_jobs
                 WHERE job_id IN (
                   SELECT job_id FROM history_sync_jobs
                   WHERE terminal_instance_id = ?1
                     AND broker_server = ?2 COLLATE NOCASE
                     AND login_account = ?3
                     AND job_id LIKE 'tail_refresh_%'
                     AND state IN ('completed', 'superseded')
                     AND updated_at_utc_msc < ?4
                   ORDER BY updated_at_utc_msc LIMIT 100
                 );",
                params![
                    request.scope.terminal_instance_id,
                    request.scope.broker_server,
                    request.scope.login_account,
                    prune_before,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_tail_prune_failed"))?;

        let mut statement = transaction
            .prepare(&format!(
                "{} FROM history_sync_jobs
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3
                   AND job_id LIKE 'tail_refresh_%'
                   AND state IN ('queued', 'retrying', 'running')
                 ORDER BY range_start_utc_msc, range_end_utc_msc, job_id;",
                history_sync_job_select()
            ))
            .map_err(|_| StoreError::new("bridge_store_history_tail_query_failed"))?;
        let active_rows = statement
            .query_map(
                params![
                    request.scope.terminal_instance_id,
                    request.scope.broker_server,
                    request.scope.login_account
                ],
                history_sync_job_row_from_sql,
            )
            .map_err(|_| StoreError::new("bridge_store_history_tail_query_failed"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoreError::new("bridge_store_history_tail_query_failed"))?;
        let active_rows = active_rows
            .into_iter()
            .map(history_sync_job_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);

        let mut attached_jobs = Vec::new();
        if let Some(row) = active_rows.into_iter().find(|row| {
            ranges_overlap(
                row.range_start_utc_msc,
                row.range_end_utc_msc,
                request.range_start_utc_msc,
                request.range_end_utc_msc,
            )
        }) {
            let merged_start = row.range_start_utc_msc.min(request.range_start_utc_msc);
            let merged_end = row.range_end_utc_msc.max(request.range_end_utc_msc);
            if merged_start != row.range_start_utc_msc || merged_end != row.range_end_utc_msc {
                let affected = transaction
                    .execute(
                        "UPDATE history_sync_jobs
                         SET range_start_utc_msc = ?2, range_end_utc_msc = ?3,
                             cursor_time_msc = CASE WHEN cursor_time_msc > ?2 THEN ?2 ELSE cursor_time_msc END,
                             cursor_ticket = CASE WHEN cursor_time_msc > ?2 THEN '' ELSE cursor_ticket END,
                             updated_at_utc_msc = ?4
                         WHERE job_id = ?1 AND state IN ('queued', 'retrying', 'running');",
                        params![row.job_id, merged_start, merged_end, request.now_utc_msc],
                    )
                    .map_err(|_| StoreError::new("bridge_store_history_tail_merge_failed"))?;
                if affected != 1 {
                    return Err(StoreError::new("bridge_store_history_tail_merge_failed"));
                }
            }
            let merged = read_history_sync_job_by_id(&transaction, &row.job_id)?
                .ok_or_else(|| StoreError::new("bridge_store_history_tail_query_failed"))?;
            attached_jobs.push(merged);
        } else {
            let job_id = format!(
                "tail_refresh_{}",
                history_job_identity(
                    &request.scope,
                    "tail_refresh",
                    request.range_start_utc_msc,
                    request.range_end_utc_msc,
                )
            );
            let existing = read_history_sync_job_by_range(
                &transaction,
                &request.scope,
                request.range_start_utc_msc,
                request.range_end_utc_msc,
            )?;
            let job = if let Some(existing) = existing {
                if !existing.job_id.starts_with("tail_refresh_") {
                    return Err(StoreError::new("bridge_store_history_tail_collision"));
                }
                if existing.state == "completed" || existing.state == "superseded" {
                    transaction
                        .execute(
                            "UPDATE history_sync_jobs
                             SET state = 'queued', cursor_time_msc = range_start_utc_msc,
                                 cursor_ticket = '', attempt_count = 0,
                                 next_attempt_at_utc_msc = ?2, last_error_code = NULL,
                                 lease_expires_at_utc_msc = NULL, updated_at_utc_msc = ?2
                             WHERE job_id = ?1;",
                            params![existing.job_id, request.now_utc_msc],
                        )
                        .map_err(|_| StoreError::new("bridge_store_history_tail_requeue_failed"))?;
                    read_history_sync_job_by_id(&transaction, &existing.job_id)?
                        .ok_or_else(|| StoreError::new("bridge_store_history_tail_query_failed"))?
                } else {
                    existing
                }
            } else {
                transaction
                    .execute(
                        "INSERT INTO history_sync_jobs (
                           job_id, terminal_instance_id, broker_server, login_account,
                           job_kind, priority, range_start_utc_msc, range_end_utc_msc,
                           cursor_time_msc, cursor_ticket, window_msc, state, attempt_count,
                           next_attempt_at_utc_msc, last_error_code, lease_generation,
                           lease_expires_at_utc_msc, created_at_utc_msc, updated_at_utc_msc
                         ) VALUES (?1, ?2, ?3, ?4, 'on_demand', 'p1', ?5, ?6, ?5, '',
                                   ?7, 'queued', 0, ?8, NULL, 0, NULL, ?8, ?8);",
                        params![
                            job_id,
                            request.scope.terminal_instance_id,
                            request.scope.broker_server,
                            request.scope.login_account,
                            request.range_start_utc_msc,
                            request.range_end_utc_msc,
                            HISTORY_TAIL_WINDOW_MSC,
                            request.now_utc_msc,
                        ],
                    )
                    .map_err(|_| StoreError::new("bridge_store_history_tail_write_failed"))?;
                read_history_sync_job_by_id(&transaction, &job_id)?
                    .ok_or_else(|| StoreError::new("bridge_store_history_tail_write_failed"))?
            };
            attached_jobs.push(job);
        }

        let mut scope_state =
            read_history_scope_state_locked(&transaction, &request.scope, &request.platform)?;
        scope_state.freshness_state = "refreshing".to_owned();
        scope_state.updated_at_utc_msc = request.now_utc_msc;
        write_history_scope_state_tx(&transaction, &scope_state)?;
        attached_jobs.sort_by(history_job_order);
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_planning_commit_failed"))?;
        Ok(HistoryJobPlanningResult {
            created_jobs: Vec::new(),
            attached_jobs,
        })
    }

    pub fn history_sync_job(&self, job_id: &str) -> Result<Option<HistorySyncJob>, StoreError> {
        validate_history_job_id(job_id)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        read_history_sync_job_by_id(&connection, job_id)
    }

    pub fn claim_history_job(
        &self,
        scope: &HistoryScope,
        now_utc_msc: i64,
        lease_duration_msc: i64,
    ) -> Result<Option<HistorySyncJob>, StoreError> {
        self.claim_history_job_internal(scope, now_utc_msc, lease_duration_msc, None)
    }

    /// Claim only jobs whose kind is present in `allowed_job_kinds`.
    ///
    /// The old `claim_history_job` entry point intentionally remains
    /// unrestricted for rollback compatibility, including legacy `backfill`
    /// rows.  New schedulers should pass the explicit allow-list so those
    /// rows remain inert without changing the database CHECK constraint.
    pub fn claim_history_job_with_allowed_kinds<K: AsRef<str>>(
        &self,
        scope: &HistoryScope,
        now_utc_msc: i64,
        lease_duration_msc: i64,
        allowed_job_kinds: &[K],
    ) -> Result<Option<HistorySyncJob>, StoreError> {
        let allowed_job_kinds = normalize_history_job_kinds(allowed_job_kinds)?;
        self.claim_history_job_internal(
            scope,
            now_utc_msc,
            lease_duration_msc,
            Some(&allowed_job_kinds),
        )
    }

    fn claim_history_job_internal(
        &self,
        scope: &HistoryScope,
        now_utc_msc: i64,
        lease_duration_msc: i64,
        allowed_job_kinds: Option<&[String]>,
    ) -> Result<Option<HistorySyncJob>, StoreError> {
        validate_history_scope_values(scope)?;
        let lease_expires_at_utc_msc = now_utc_msc
            .checked_add(lease_duration_msc)
            .ok_or_else(|| StoreError::new("bridge_store_history_lease_invalid"))?;
        if now_utc_msc <= 0 || lease_duration_msc <= 0 || lease_expires_at_utc_msc <= now_utc_msc {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_job_transaction_failed"))?;
        let candidate =
            read_claimable_history_job(&transaction, scope, now_utc_msc, allowed_job_kinds)?;
        let Some(mut job) = candidate else {
            transaction
                .commit()
                .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
            return Ok(None);
        };
        let lease_generation = job
            .lease_generation
            .checked_add(1)
            .ok_or_else(|| StoreError::new("bridge_store_history_lease_generation_exhausted"))?;
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET state = 'running', attempt_count = attempt_count + 1,
                     lease_generation = ?2, lease_expires_at_utc_msc = ?3,
                     updated_at_utc_msc = ?4
                 WHERE job_id = ?1
                   AND (
                     (state IN ('queued', 'retrying') AND next_attempt_at_utc_msc <= ?4)
                     OR (state = 'running' AND lease_expires_at_utc_msc <= ?4)
                   );",
                params![
                    job.job_id,
                    lease_generation,
                    lease_expires_at_utc_msc,
                    now_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_job_claim_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_job_claim_failed"));
        }
        job.state = "running".to_owned();
        job.attempt_count = job
            .attempt_count
            .checked_add(1)
            .ok_or_else(|| StoreError::new("bridge_store_history_attempt_exhausted"))?;
        job.lease_generation = lease_generation;
        job.lease_expires_at_utc_msc = Some(lease_expires_at_utc_msc);
        job.updated_at_utc_msc = now_utc_msc;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
        Ok(Some(job))
    }

    /// Yield a running lower-priority history job when a due P1 job for the
    /// same account scope is waiting.  This is a normal scheduler handoff,
    /// not a retry: the current cursor, window, attempt count and last error
    /// are deliberately preserved and no failure is recorded.
    pub fn yield_history_job_if_higher_priority_waiting(
        &self,
        job_id: &str,
        lease_generation: i64,
        now_utc_msc: i64,
    ) -> Result<bool, StoreError> {
        validate_history_job_id(job_id)?;
        validate_history_lease_generation(lease_generation)?;
        if now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_history_yield_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_job_transaction_failed"))?;
        let current = read_history_sync_job_by_id(&transaction, job_id)?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        if current.state != "running"
            || current.lease_generation != lease_generation
            || current
                .lease_expires_at_utc_msc
                .is_none_or(|expires| expires <= now_utc_msc)
        {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        let should_yield = matches!(current.priority.as_str(), "p2" | "p3")
            && transaction
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM history_sync_jobs
                       WHERE terminal_instance_id = ?1
                         AND broker_server = ?2 COLLATE NOCASE
                         AND login_account = ?3
                         AND priority = 'p1'
                         AND (
                           (state IN ('queued', 'retrying') AND next_attempt_at_utc_msc <= ?4)
                           OR (state = 'running' AND lease_expires_at_utc_msc <= ?4)
                         )
                     );",
                    params![
                        current.scope.terminal_instance_id,
                        current.scope.broker_server,
                        current.scope.login_account,
                        now_utc_msc
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|_| StoreError::new("bridge_store_history_job_query_failed"))?
                == 1;
        if !should_yield {
            transaction
                .commit()
                .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
            return Ok(false);
        }
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET state = 'queued', next_attempt_at_utc_msc = ?2,
                     lease_expires_at_utc_msc = NULL, updated_at_utc_msc = ?2
                 WHERE job_id = ?1 AND state = 'running'
                   AND lease_generation = ?3
                   AND lease_expires_at_utc_msc > ?2;",
                params![job_id, now_utc_msc, lease_generation],
            )
            .map_err(|_| StoreError::new("bridge_store_history_yield_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
        Ok(true)
    }

    pub fn checkpoint_history_job(
        &self,
        job_id: &str,
        lease_generation: i64,
        cursor_time_msc: i64,
        cursor_ticket: &str,
        window_msc: i64,
        now_utc_msc: i64,
    ) -> Result<(), StoreError> {
        validate_history_job_id(job_id)?;
        validate_history_lease_generation(lease_generation)?;
        validate_job_cursor(cursor_time_msc, cursor_ticket)?;
        if window_msc <= 0 || now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_history_checkpoint_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_history_job_transaction_failed"))?;
        let (range_start, range_end, current_cursor_time, current_cursor_ticket) = transaction
            .query_row(
                "SELECT range_start_utc_msc, range_end_utc_msc,
                        cursor_time_msc, cursor_ticket
                 FROM history_sync_jobs WHERE job_id = ?1 LIMIT 1;",
                [job_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_job_query_failed"))?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        if cursor_time_msc < range_start
            || cursor_time_msc > range_end
            || cursor_time_msc == range_end && !cursor_ticket.is_empty()
        {
            return Err(StoreError::new("bridge_store_history_checkpoint_invalid"));
        }
        if cursor_time_msc < current_cursor_time
            || cursor_time_msc == current_cursor_time
                && compare_decimal_strings(cursor_ticket, &current_cursor_ticket).is_lt()
        {
            return Err(StoreError::new(
                "bridge_store_history_checkpoint_regression",
            ));
        }
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET cursor_time_msc = ?2, cursor_ticket = ?3, window_msc = ?4,
                     updated_at_utc_msc = ?5
                 WHERE job_id = ?1 AND state = 'running'
                   AND lease_generation = ?6
                   AND lease_expires_at_utc_msc > ?5;",
                params![
                    job_id,
                    cursor_time_msc,
                    cursor_ticket,
                    window_msc,
                    now_utc_msc,
                    lease_generation
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_checkpoint_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))
    }

    pub fn persist_history_job_batch(
        &self,
        terminal: &TerminalDescriptor,
        job_id: &str,
        lease_generation: i64,
        batch: &HistoryArchiveBatch,
        window_msc: i64,
        now_utc_msc: i64,
    ) -> Result<HistoryJobBatchResult, StoreError> {
        validate_history_job_id(job_id)?;
        validate_history_lease_generation(lease_generation)?;
        if window_msc <= 0 || now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_history_batch_invalid"));
        }
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        if terminal.platform != "mt5" {
            return Err(StoreError::new("bridge_store_history_scope_invalid"));
        }
        validate_history_archive_batch_shape(batch)?;

        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        let job = read_history_sync_job_by_id(&transaction, job_id)?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        if job.state != "running"
            || job.lease_generation != lease_generation
            || job
                .lease_expires_at_utc_msc
                .is_none_or(|expires| expires <= now_utc_msc)
        {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        if !history_scope_matches_terminal(&job.scope, terminal) {
            return Err(StoreError::new("bridge_store_history_scope_mismatch"));
        }
        validate_history_job_batch_cursor(&job, &batch.next_cursor, batch.has_more)?;
        validate_history_items_in_range(
            "deal",
            &batch.deals,
            job.range_start_utc_msc,
            job.range_end_utc_msc,
        )?;
        validate_history_items_in_range(
            "history_order",
            &batch.history_orders,
            job.range_start_utc_msc,
            job.range_end_utc_msc,
        )?;
        validate_history_items_in_range(
            "trade",
            &batch.trades,
            job.range_start_utc_msc,
            job.range_end_utc_msc,
        )?;
        let mut upsert_result = upsert_history_items(
            &transaction,
            terminal,
            "deal",
            &batch.deals,
            batch.observed_at_utc_msc,
        )?;
        let history_order_result = upsert_history_items(
            &transaction,
            terminal,
            "history_order",
            &batch.history_orders,
            batch.observed_at_utc_msc,
        )?;
        let trade_result = upsert_history_items(
            &transaction,
            terminal,
            "trade",
            &batch.trades,
            batch.observed_at_utc_msc,
        )?;
        upsert_result.changed_item_count = upsert_result
            .changed_item_count
            .saturating_add(history_order_result.changed_item_count)
            .saturating_add(trade_result.changed_item_count);
        upsert_result.sealed_trade_changed_count = trade_result.sealed_trade_changed_count;
        upsert_result.capital_changed_count = upsert_result
            .capital_changed_count
            .saturating_add(trade_result.capital_changed_count)
            .saturating_add(history_order_result.capital_changed_count);
        upsert_result.duplicate_item_count = upsert_result
            .duplicate_item_count
            .saturating_add(history_order_result.duplicate_item_count)
            .saturating_add(trade_result.duplicate_item_count);
        upsert_result.immutable_conflict_count = upsert_result
            .immutable_conflict_count
            .saturating_add(history_order_result.immutable_conflict_count)
            .saturating_add(trade_result.immutable_conflict_count);
        upsert_result
            .affected_days
            .extend(history_order_result.affected_days);
        upsert_result
            .affected_days
            .extend(trade_result.affected_days);
        upsert_result.affected_days.sort_unstable();
        upsert_result.affected_days.dedup();
        // A no-more response can terminate either the current sub-window or
        // the complete job range.  Only the latter is allowed to write
        // coverage and transition the job to `completed`; sub-window
        // endpoints remain lease-owned `running` checkpoints.
        let is_complete = !batch.has_more
            && batch.next_cursor.time_msc == job.range_end_utc_msc
            && batch.next_cursor.ticket == "0";
        let (cursor_time_msc, cursor_ticket) = if is_complete {
            merge_history_coverage_range_tx(
                &transaction,
                &job.scope,
                job.range_start_utc_msc,
                job.range_end_utc_msc,
                batch.observed_at_utc_msc,
                now_utc_msc,
            )?;
            (job.range_end_utc_msc, String::new())
        } else {
            (batch.next_cursor.time_msc, batch.next_cursor.ticket.clone())
        };
        let mut scope_state =
            read_history_scope_state_locked(&transaction, &job.scope, &terminal.platform)?;
        scope_state.duplicate_count = scope_state
            .duplicate_count
            .saturating_add(upsert_result.duplicate_item_count as i64);
        scope_state.immutable_conflict_count = scope_state
            .immutable_conflict_count
            .saturating_add(upsert_result.immutable_conflict_count as i64);
        let history_changed = upsert_result.changed_item_count > 0;
        let summary_changed =
            upsert_result.sealed_trade_changed_count > 0 || upsert_result.capital_changed_count > 0;
        let summary_was_ready = scope_state.summary_status == "ready"
            && scope_state.summary_revision == scope_state.history_revision;
        if upsert_result.sealed_trade_changed_count > 0 {
            scope_state.history_revision = scope_state
                .history_revision
                .checked_add(1)
                .ok_or_else(|| StoreError::new("bridge_store_history_revision_exhausted"))?;
            // Keep a ready active generation synchronized incrementally when
            // possible.  A scope without one remains pending until the
            // generation-safe rebuild API is invoked.
            scope_state.summary_status = "pending".to_owned();
        }
        if summary_changed
            && summary_was_ready
            && let Some(build) =
                read_history_summary_build_locked(&transaction, &job.scope, &terminal.platform)?
            && let Some(generation) = build.active_generation
        {
            refresh_history_summary_days_tx(
                &transaction,
                &job.scope,
                &terminal.platform,
                generation,
                &upsert_result.affected_days,
            )?;
            refresh_history_summary_v2_days_tx(
                &transaction,
                &job.scope,
                &terminal.platform,
                generation,
                &upsert_result.affected_days,
            )?;
            scope_state.summary_revision = scope_state.history_revision;
            scope_state.summary_status = "ready".to_owned();
        }
        let is_recent_flight = job.job_kind == "recent";
        let is_tail_flight = job.job_id.starts_with("tail_refresh_");
        let is_freshness_flight = is_recent_flight || is_tail_flight;
        if is_freshness_flight {
            if is_complete {
                // Freshness describes the fixed endpoint that the completed
                // recent/tail flight covered, not the timestamp attached to
                // an intermediate batch.  Keep an already newer endpoint
                // monotonic when an old retry completes late.
                scope_state.fresh_through_utc_msc = Some(
                    scope_state
                        .fresh_through_utc_msc
                        .unwrap_or(0)
                        .max(job.range_end_utc_msc),
                );
                scope_state.freshness_state = "fresh".to_owned();
            } else {
                // A partial flight is still refreshing.  Do not advance
                // fresh_through until its fixed endpoint has completed.
                scope_state.freshness_state = "refreshing".to_owned();
            }
        }
        if is_complete && job.job_kind == "recent" {
            let start = scope_state
                .head_range_start_utc_msc
                .map_or(job.range_start_utc_msc, |value| {
                    value.min(job.range_start_utc_msc)
                });
            let end = scope_state
                .head_range_end_utc_msc
                .map_or(job.range_end_utc_msc, |value| {
                    value.max(job.range_end_utc_msc)
                });
            scope_state.head_ready = true;
            scope_state.head_range_start_utc_msc = Some(start);
            scope_state.head_range_end_utc_msc = Some(end);
        } else if is_complete && job.job_id.starts_with("tail_refresh_") {
            let start = scope_state
                .head_range_start_utc_msc
                .map_or(job.range_start_utc_msc, |value| {
                    value.min(job.range_start_utc_msc)
                });
            let end = scope_state
                .head_range_end_utc_msc
                .map_or(job.range_end_utc_msc, |value| {
                    value.max(job.range_end_utc_msc)
                });
            scope_state.head_ready = true;
            scope_state.head_range_start_utc_msc = Some(start);
            scope_state.head_range_end_utc_msc = Some(end);
        }
        let coverage_ranges = read_history_coverage_ranges_locked(&transaction, &job.scope)?;
        scope_state.coverage_complete = scope_state.head_ready
            && scope_state.head_range_end_utc_msc.is_some_and(|head_end| {
                history_ranges_cover(&coverage_ranges, HISTORY_COVERAGE_START_UTC_MSC, head_end)
            });
        scope_state.updated_at_utc_msc = now_utc_msc;
        write_history_scope_state_tx(&transaction, &scope_state)?;
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET state = CASE WHEN ?2 = 1 THEN 'completed' ELSE 'running' END,
                     cursor_time_msc = ?3, cursor_ticket = ?4, window_msc = ?5,
                     next_attempt_at_utc_msc = ?6,
                     last_error_code = NULL,
                     lease_expires_at_utc_msc = CASE WHEN ?2 = 1 THEN NULL
                                                    ELSE lease_expires_at_utc_msc END,
                     updated_at_utc_msc = ?6
                 WHERE job_id = ?1 AND state = 'running'
                   AND lease_generation = ?7
                   AND lease_expires_at_utc_msc > ?6;",
                params![
                    job_id,
                    i64::from(is_complete),
                    cursor_time_msc,
                    cursor_ticket,
                    window_msc,
                    now_utc_msc,
                    lease_generation,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_batch_write_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        let updated_job = read_history_sync_job_by_id(&transaction, job_id)?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))?;
        if history_changed {
            self.invalidate_history_home_snapshots(terminal)?;
        }
        Ok(HistoryJobBatchResult {
            status: if is_complete {
                HistoryJobBatchStatus::Completed
            } else {
                HistoryJobBatchStatus::Checkpointed
            },
            job: updated_job,
            persisted_item_count: batch.deals.len()
                + batch.history_orders.len()
                + batch.trades.len(),
            changed_item_count: upsert_result.changed_item_count,
            history_changed,
            history_revision: scope_state.history_revision,
            duplicate_item_count: upsert_result.duplicate_item_count,
            immutable_conflict_count: upsert_result.immutable_conflict_count,
        })
    }

    pub fn renew_history_job(
        &self,
        job_id: &str,
        lease_generation: i64,
        now_utc_msc: i64,
        lease_duration_msc: i64,
    ) -> Result<HistorySyncJob, StoreError> {
        validate_history_job_id(job_id)?;
        validate_history_lease_generation(lease_generation)?;
        let lease_expires_at_utc_msc = now_utc_msc
            .checked_add(lease_duration_msc)
            .ok_or_else(|| StoreError::new("bridge_store_history_lease_invalid"))?;
        if now_utc_msc <= 0 || lease_duration_msc <= 0 || lease_expires_at_utc_msc <= now_utc_msc {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_history_job_transaction_failed"))?;
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET lease_expires_at_utc_msc = ?3, updated_at_utc_msc = ?4
                 WHERE job_id = ?1 AND state = 'running'
                   AND lease_generation = ?2
                   AND lease_expires_at_utc_msc > ?4;",
                params![
                    job_id,
                    lease_generation,
                    lease_expires_at_utc_msc,
                    now_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_renew_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        let job = read_history_sync_job_by_id(&transaction, job_id)?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_job_commit_failed"))?;
        Ok(job)
    }

    pub fn heartbeat_history_job(
        &self,
        job_id: &str,
        lease_generation: i64,
        now_utc_msc: i64,
        lease_duration_msc: i64,
    ) -> Result<HistorySyncJob, StoreError> {
        self.renew_history_job(job_id, lease_generation, now_utc_msc, lease_duration_msc)
    }

    pub fn retry_history_job(
        &self,
        job_id: &str,
        lease_generation: i64,
        next_attempt_at_utc_msc: i64,
        error_code: &str,
        now_utc_msc: i64,
    ) -> Result<(), StoreError> {
        validate_history_job_id(job_id)?;
        validate_history_lease_generation(lease_generation)?;
        validate_history_error_code(error_code)?;
        if next_attempt_at_utc_msc <= 0 || now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_history_retry_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        let job = read_history_sync_job_by_id(&transaction, job_id)?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET state = 'retrying', next_attempt_at_utc_msc = ?3,
                     last_error_code = ?4, lease_expires_at_utc_msc = NULL,
                     updated_at_utc_msc = ?5
                 WHERE job_id = ?1 AND state = 'running'
                   AND lease_generation = ?2
                   AND lease_expires_at_utc_msc > ?5;",
                params![
                    job_id,
                    lease_generation,
                    next_attempt_at_utc_msc,
                    error_code,
                    now_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_retry_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        if let Some(platform) = transaction
            .query_row(
                "SELECT platform FROM terminal_bindings
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 LIMIT 1;",
                params![
                    job.scope.terminal_instance_id,
                    job.scope.broker_server,
                    job.scope.login_account
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?
        {
            let mut state = read_history_scope_state_locked(&transaction, &job.scope, &platform)?;
            state.freshness_state = "refreshing".to_owned();
            state.updated_at_utc_msc = now_utc_msc;
            write_history_scope_state_tx(&transaction, &state)?;
        }
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))
    }

    pub fn block_history_job(
        &self,
        job_id: &str,
        lease_generation: i64,
        error_code: &str,
        now_utc_msc: i64,
    ) -> Result<(), StoreError> {
        validate_history_job_id(job_id)?;
        validate_history_lease_generation(lease_generation)?;
        validate_history_error_code(error_code)?;
        if now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_history_block_invalid"));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        let job = read_history_sync_job_by_id(&transaction, job_id)?
            .ok_or_else(|| StoreError::new("bridge_store_history_job_unknown"))?;
        let affected = transaction
            .execute(
                "UPDATE history_sync_jobs
                 SET state = 'blocked', last_error_code = ?3,
                     lease_expires_at_utc_msc = NULL, updated_at_utc_msc = ?4
                 WHERE job_id = ?1 AND state = 'running'
                   AND lease_generation = ?2
                   AND lease_expires_at_utc_msc > ?4;",
                params![job_id, lease_generation, error_code, now_utc_msc],
            )
            .map_err(|_| StoreError::new("bridge_store_history_block_failed"))?;
        if affected != 1 {
            return Err(StoreError::new("bridge_store_history_lease_invalid"));
        }
        if let Some(platform) = transaction
            .query_row(
                "SELECT platform FROM terminal_bindings
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 LIMIT 1;",
                params![
                    job.scope.terminal_instance_id,
                    job.scope.broker_server,
                    job.scope.login_account
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?
        {
            let mut state = read_history_scope_state_locked(&transaction, &job.scope, &platform)?;
            state.freshness_state = "blocked".to_owned();
            state.updated_at_utc_msc = now_utc_msc;
            write_history_scope_state_tx(&transaction, &state)?;
        }
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))
    }

    pub fn supersede_history_scope(
        &self,
        scope: &HistoryScope,
        now_utc_msc: i64,
    ) -> Result<usize, StoreError> {
        validate_history_scope_values(scope)?;
        if now_utc_msc <= 0 {
            return Err(StoreError::new("bridge_store_history_supersede_invalid"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let affected = connection
            .execute(
                "UPDATE history_sync_jobs
                 SET state = 'superseded', last_error_code = 'scope_superseded',
                     lease_expires_at_utc_msc = NULL, updated_at_utc_msc = ?4
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3
                   AND state NOT IN ('completed', 'superseded');",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    now_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_supersede_failed"))?;
        Ok(affected)
    }

    pub fn history_coverage_ranges(
        &self,
        scope: &HistoryScope,
    ) -> Result<Vec<HistoryCoverageRange>, StoreError> {
        validate_history_scope_values(scope)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        read_history_coverage_ranges_locked(&connection, scope)
    }

    pub fn is_history_range_covered(
        &self,
        scope: &HistoryScope,
        range_start_utc_msc: i64,
        range_end_utc_msc: i64,
    ) -> Result<bool, StoreError> {
        validate_history_scope_values(scope)?;
        validate_history_range(range_start_utc_msc, range_end_utc_msc)?;
        let ranges = self.history_coverage_ranges(scope)?;
        Ok(history_ranges_cover(
            &ranges,
            range_start_utc_msc,
            range_end_utc_msc,
        ))
    }

    pub fn history_range_is_covered(
        &self,
        scope: &HistoryScope,
        range_start_utc_msc: i64,
        range_end_utc_msc: i64,
    ) -> Result<bool, StoreError> {
        self.is_history_range_covered(scope, range_start_utc_msc, range_end_utc_msc)
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

    /// Read additive runtime state for the terminal's account/platform.  A
    /// missing row is a valid pre-migration/never-synced state and returns the
    /// conservative pending/stale defaults.
    pub fn history_scope_state(
        &self,
        terminal: &TerminalDescriptor,
    ) -> Result<HistoryScopeState, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let scope = HistoryScope {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        read_history_scope_state_locked(&connection, &scope, &terminal.platform)
    }

    /// Return the newest immutable trade close cursor for this account.  The
    /// tail scheduler uses this boundary to refresh only the bounded mutable
    /// suffix instead of re-reading an arbitrary historical overlap.
    pub fn latest_sealed_trade_cursor(
        &self,
        terminal: &TerminalDescriptor,
    ) -> Result<Option<HistoryCursor>, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let connection = self
            .history_read_connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        connection
            .query_row(
                "SELECT close_time_utc_msc, item_id
                 FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND item_kind = 'trade' AND immutable_state = 'sealed'
                   AND close_time_utc_msc IS NOT NULL
                 ORDER BY close_time_utc_msc DESC, item_id DESC LIMIT 1;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform
                ],
                |row| {
                    Ok(HistoryCursor {
                        time_msc: row.get(0)?,
                        ticket: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_cursor_query_failed"))
    }

    /// Scope-oriented alias used by schedulers that already have a normalized
    /// account scope and platform string.
    pub fn history_scope_state_for_scope(
        &self,
        scope: &HistoryScope,
        platform: &str,
    ) -> Result<HistoryScopeState, StoreError> {
        validate_history_scope_values(scope)?;
        validate_history_platform(platform)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        read_history_scope_state_locked(&connection, scope, platform)
    }

    /// Mark an archive flight as active without changing coverage ranges.
    pub fn mark_history_scope_refreshing(
        &self,
        terminal: &TerminalDescriptor,
        now_utc_msc: i64,
    ) -> Result<HistoryScopeState, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        if now_utc_msc <= 0 {
            return Err(StoreError::new(
                "bridge_store_history_state_timestamp_invalid",
            ));
        }
        let scope = HistoryScope {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
        };
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        let mut state = read_history_scope_state_locked(&transaction, &scope, &terminal.platform)?;
        state.freshness_state = "refreshing".to_owned();
        state.updated_at_utc_msc = now_utc_msc;
        write_history_scope_state_tx(&transaction, &state)?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))?;
        Ok(state)
    }

    /// Rebuild the account/platform summary into a new generation and switch
    /// the active pointer only after the generation has been fully written.
    /// A failed build leaves the previous active generation untouched and
    /// records `unavailable` instead of exposing partial aggregates.
    pub fn rebuild_history_summary(
        &self,
        terminal: &TerminalDescriptor,
        now_utc_msc: i64,
    ) -> Result<HistoryScopeState, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        if now_utc_msc <= 0 {
            return Err(StoreError::new(
                "bridge_store_history_summary_timestamp_invalid",
            ));
        }
        let scope = HistoryScope {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
        };
        let build_generation = {
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| StoreError::new("bridge_store_history_summary_transaction_failed"))?;
            let active_generation =
                read_history_summary_build_locked(&transaction, &scope, &terminal.platform)?
                    .and_then(|build| build.active_generation);
            let maximum_generation = transaction
                .query_row(
                    "SELECT COALESCE(MAX(generation), 0) FROM history_daily_summary
                     WHERE terminal_instance_id = ?1
                       AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_query_failed"))?;
            let next_generation = active_generation
                .unwrap_or(0)
                .max(maximum_generation)
                .checked_add(1)
                .ok_or_else(|| {
                    StoreError::new("bridge_store_history_summary_generation_exhausted")
                })?;
            transaction
                .execute(
                    "INSERT INTO history_summary_builds (
                       terminal_instance_id, broker_server, login_account, platform,
                       active_generation, building_generation, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(terminal_instance_id, broker_server, login_account, platform)
                     DO UPDATE SET building_generation = excluded.building_generation,
                       updated_at_utc_msc = excluded.updated_at_utc_msc;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform,
                        active_generation,
                        next_generation,
                        now_utc_msc
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_build_failed"))?;
            let mut state =
                read_history_scope_state_locked(&transaction, &scope, &terminal.platform)?;
            state.summary_status = "rebuilding".to_owned();
            state.updated_at_utc_msc = now_utc_msc;
            write_history_scope_state_tx(&transaction, &state)?;
            transaction
                .commit()
                .map_err(|_| StoreError::new("bridge_store_history_summary_commit_failed"))?;
            next_generation
        };

        let build_result = (|| {
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| StoreError::new("bridge_store_history_summary_transaction_failed"))?;
            transaction
                .execute(
                    "DELETE FROM history_daily_summary
                     WHERE terminal_instance_id = ?1
                       AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4 AND generation = ?5;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform,
                        build_generation
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_build_failed"))?;
            transaction
                .execute(
                    "DELETE FROM history_daily_summary_v2
                     WHERE terminal_instance_id = ?1
                       AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4 AND generation = ?5;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform,
                        build_generation
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_build_failed"))?;
            insert_history_summary_generation_tx(
                &transaction,
                &scope,
                &terminal.platform,
                build_generation,
            )?;
            insert_history_summary_v2_generation_tx(
                &transaction,
                &scope,
                &terminal.platform,
                build_generation,
            )?;
            validate_history_summary_generation_tx(
                &transaction,
                &scope,
                &terminal.platform,
                build_generation,
            )?;
            transaction
                .execute(
                    "DELETE FROM history_daily_summary
                     WHERE terminal_instance_id = ?1
                       AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4 AND generation <> ?5;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform,
                        build_generation
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_cleanup_failed"))?;
            transaction
                .execute(
                    "DELETE FROM history_daily_summary_v2
                     WHERE terminal_instance_id = ?1
                       AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4 AND generation <> ?5;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform,
                        build_generation
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_cleanup_failed"))?;
            transaction
                .execute(
                    "UPDATE history_summary_builds
                     SET active_generation = ?5, building_generation = NULL,
                         updated_at_utc_msc = ?6
                     WHERE terminal_instance_id = ?1
                       AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4;",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        terminal.platform,
                        build_generation,
                        now_utc_msc
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_summary_activate_failed"))?;
            let mut state =
                read_history_scope_state_locked(&transaction, &scope, &terminal.platform)?;
            state.summary_revision = state.history_revision;
            state.summary_status = "ready".to_owned();
            state.updated_at_utc_msc = now_utc_msc;
            write_history_scope_state_tx(&transaction, &state)?;
            transaction
                .commit()
                .map_err(|_| StoreError::new("bridge_store_history_summary_commit_failed"))?;
            Ok::<_, StoreError>(state)
        })();
        match build_result {
            Ok(state) => Ok(state),
            Err(error) => {
                let _ =
                    self.mark_history_summary_unavailable(&scope, &terminal.platform, now_utc_msc);
                Err(error)
            }
        }
    }

    /// Ensure an active summary generation is available for this scope.  The
    /// operation is idempotent when `summary_revision` already matches the
    /// current `history_revision`.
    pub fn ensure_history_summary(
        &self,
        terminal: &TerminalDescriptor,
        now_utc_msc: i64,
    ) -> Result<HistoryScopeState, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let scope = HistoryScope {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
        };
        let state = self.history_scope_state(terminal)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let active = read_history_summary_build_locked(&connection, &scope, &terminal.platform)?
            .and_then(|build| build.active_generation);
        drop(connection);
        if state.summary_status == "ready"
            && state.summary_revision == state.history_revision
            && active.is_some()
        {
            return Ok(state);
        }
        self.rebuild_history_summary(terminal, now_utc_msc)
    }

    fn mark_history_summary_unavailable(
        &self,
        scope: &HistoryScope,
        platform: &str,
        now_utc_msc: i64,
    ) -> Result<(), StoreError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::new("bridge_store_history_summary_transaction_failed"))?;
        let mut state = read_history_scope_state_locked(&transaction, scope, platform)?;
        state.summary_status = "unavailable".to_owned();
        state.updated_at_utc_msc = now_utc_msc;
        write_history_scope_state_tx(&transaction, &state)?;
        transaction
            .execute(
                "UPDATE history_summary_builds
                 SET building_generation = NULL, updated_at_utc_msc = ?5
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    platform,
                    now_utc_msc
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_summary_state_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_summary_commit_failed"))
    }

    fn invalidate_history_home_snapshots(
        &self,
        terminal: &TerminalDescriptor,
    ) -> Result<(), StoreError> {
        let mut snapshots = self
            .history_snapshots
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        snapshots.retain(|_, snapshot| {
            !(snapshot.platform == terminal.platform
                && snapshot.terminal_instance_id == terminal.terminal_instance_id
                && snapshot
                    .broker_server
                    .eq_ignore_ascii_case(&terminal.account_ref.broker_server)
                && snapshot.login_account == terminal.account_ref.login
                && snapshot.cursors.is_empty())
        });
        Ok(())
    }

    /// Mark an MT4 archive as pending before starting a full rescan of the
    /// terminal-visible Account History range.
    ///
    /// The persisted cursor is reset to the coverage boundary so an interrupted
    /// manual rescan remains recoverable after a process restart. Existing
    /// archive rows are retained and deterministically upserted by the scan.
    pub fn mark_mt4_history_rescan_pending(
        &self,
        terminal: &TerminalDescriptor,
        now_utc_msc: i64,
    ) -> Result<(), StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        if terminal.platform != "mt4" {
            return Err(StoreError::new("bridge_store_history_platform_invalid"));
        }
        if now_utc_msc <= 0 {
            return Err(StoreError::new(
                "bridge_store_history_state_timestamp_invalid",
            ));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        let cursor_json = serde_json::to_string(&HistoryCursor {
            time_msc: HISTORY_COVERAGE_START_UTC_MSC,
            ticket: "0".to_owned(),
        })
        .map_err(|_| StoreError::new("bridge_store_history_cursor_invalid"))?;
        transaction
            .execute(
                "INSERT INTO history_archive_state (\
                   terminal_instance_id, broker_server, login_account, cursor_value, \
                   is_complete, updated_at_utc_msc\
                 ) VALUES (?1, ?2, ?3, ?4, 0, ?5)\
                 ON CONFLICT(terminal_instance_id, broker_server, login_account) DO UPDATE SET \
                   cursor_value = excluded.cursor_value, is_complete = 0, \
                   updated_at_utc_msc = excluded.updated_at_utc_msc;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    cursor_json,
                    now_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_state_write_failed"))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))?;
        drop(connection);

        let mut snapshots = self
            .history_snapshots
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        snapshots.retain(|_, snapshot| {
            !(snapshot.platform == terminal.platform
                && snapshot.terminal_instance_id == terminal.terminal_instance_id
                && snapshot
                    .broker_server
                    .eq_ignore_ascii_case(&terminal.account_ref.broker_server)
                && snapshot.login_account == terminal.account_ref.login)
        });
        Ok(())
    }

    pub fn persist_history_archive_batch(
        &self,
        terminal: &TerminalDescriptor,
        batch: &HistoryArchiveBatch,
    ) -> Result<(), StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        validate_history_archive_batch_shape(batch)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new("bridge_store_history_transaction_failed"))?;
        let mut upsert_result = upsert_history_items(
            &transaction,
            terminal,
            "deal",
            &batch.deals,
            batch.observed_at_utc_msc,
        )?;
        let history_order_result = upsert_history_items(
            &transaction,
            terminal,
            "history_order",
            &batch.history_orders,
            batch.observed_at_utc_msc,
        )?;
        let trade_result = upsert_history_items(
            &transaction,
            terminal,
            "trade",
            &batch.trades,
            batch.observed_at_utc_msc,
        )?;
        upsert_result.changed_item_count = upsert_result
            .changed_item_count
            .saturating_add(history_order_result.changed_item_count)
            .saturating_add(trade_result.changed_item_count);
        upsert_result.sealed_trade_changed_count = trade_result.sealed_trade_changed_count;
        upsert_result.capital_changed_count = upsert_result
            .capital_changed_count
            .saturating_add(trade_result.capital_changed_count)
            .saturating_add(history_order_result.capital_changed_count);
        upsert_result.duplicate_item_count = upsert_result
            .duplicate_item_count
            .saturating_add(history_order_result.duplicate_item_count)
            .saturating_add(trade_result.duplicate_item_count);
        upsert_result.immutable_conflict_count = upsert_result
            .immutable_conflict_count
            .saturating_add(history_order_result.immutable_conflict_count)
            .saturating_add(trade_result.immutable_conflict_count);
        upsert_result
            .affected_days
            .extend(history_order_result.affected_days);
        upsert_result
            .affected_days
            .extend(trade_result.affected_days);
        upsert_result.affected_days.sort_unstable();
        upsert_result.affected_days.dedup();
        let current = transaction
            .query_row(
                "SELECT cursor_value, is_complete FROM history_archive_state \
                 WHERE terminal_instance_id = ?1 \
                   AND broker_server = ?2 COLLATE NOCASE \
                   AND login_account = ?3 LIMIT 1;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?
            .map(|(value, complete)| {
                if !matches!(complete, 0 | 1) {
                    return Err(StoreError::new("bridge_store_history_state_invalid"));
                }
                Ok((parse_history_cursor(&value)?, complete == 1))
            })
            .transpose()?
            .unwrap_or((HistoryCursor::default(), false));
        if compare_history_cursor(&batch.next_cursor, &current.0).is_lt() {
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
        let scope = HistoryScope {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
        };
        let mut scope_state =
            read_history_scope_state_locked(&transaction, &scope, &terminal.platform)?;
        scope_state.duplicate_count = scope_state
            .duplicate_count
            .saturating_add(upsert_result.duplicate_item_count as i64);
        scope_state.immutable_conflict_count = scope_state
            .immutable_conflict_count
            .saturating_add(upsert_result.immutable_conflict_count as i64);
        let history_changed = upsert_result.changed_item_count > 0;
        let summary_changed =
            upsert_result.sealed_trade_changed_count > 0 || upsert_result.capital_changed_count > 0;
        let summary_was_ready = scope_state.summary_status == "ready"
            && scope_state.summary_revision == scope_state.history_revision;
        if upsert_result.sealed_trade_changed_count > 0 {
            scope_state.history_revision = scope_state
                .history_revision
                .checked_add(1)
                .ok_or_else(|| StoreError::new("bridge_store_history_revision_exhausted"))?;
            scope_state.summary_status = "pending".to_owned();
        }
        if summary_changed
            && summary_was_ready
            && let Some(build) =
                read_history_summary_build_locked(&transaction, &scope, &terminal.platform)?
            && let Some(generation) = build.active_generation
        {
            refresh_history_summary_days_tx(
                &transaction,
                &scope,
                &terminal.platform,
                generation,
                &upsert_result.affected_days,
            )?;
            refresh_history_summary_v2_days_tx(
                &transaction,
                &scope,
                &terminal.platform,
                generation,
                &upsert_result.affected_days,
            )?;
            scope_state.summary_revision = scope_state.history_revision;
            scope_state.summary_status = "ready".to_owned();
        }
        if batch.has_more {
            scope_state.freshness_state = "refreshing".to_owned();
        } else {
            scope_state.fresh_through_utc_msc = Some(
                scope_state
                    .fresh_through_utc_msc
                    .unwrap_or(0)
                    .max(batch.next_cursor.time_msc)
                    .max(batch.observed_at_utc_msc),
            );
            scope_state.freshness_state = "fresh".to_owned();
        }
        if !batch.has_more && batch.next_cursor.time_msc > HISTORY_COVERAGE_START_UTC_MSC {
            scope_state.head_ready = true;
            scope_state.head_range_start_utc_msc = Some(HISTORY_COVERAGE_START_UTC_MSC);
            scope_state.head_range_end_utc_msc = Some(batch.next_cursor.time_msc);
        }
        let coverage_ranges = read_history_coverage_ranges_locked(&transaction, &scope)?;
        scope_state.coverage_complete = history_ranges_cover(
            &coverage_ranges,
            HISTORY_COVERAGE_START_UTC_MSC,
            batch
                .next_cursor
                .time_msc
                .max(HISTORY_COVERAGE_START_UTC_MSC + 1),
        );
        scope_state.updated_at_utc_msc = batch.observed_at_utc_msc;
        write_history_scope_state_tx(&transaction, &scope_state)?;
        transaction
            .commit()
            .map_err(|_| StoreError::new("bridge_store_history_commit_failed"))?;
        if history_changed {
            self.invalidate_history_home_snapshots(terminal)?;
        }
        Ok(())
    }

    pub fn read_history_archive_page(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        self.read_history_archive_page_at(terminal, parameters, current_utc_msc()?)
    }

    pub fn read_history_archive_page_at(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
        now_utc_msc: i64,
    ) -> Result<serde_json::Value, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let request = parse_history_page_request(parameters, now_utc_msc)?;
        let connection = self
            .history_read_connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let mut scope = history_scope_values(terminal);
        scope.push(SqlValue::Text(terminal.platform.clone()));
        let mut filtered_values = scope.clone();
        filtered_values.extend(request.filter_values.iter().cloned());
        let total = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM history_archive_items \
                     WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
                       AND login_account = ? AND platform = ? AND item_kind = 'trade' \
                       AND close_time_utc_msc >= 946684800000 \
                       AND close_time_utc_msc IS NOT NULL{};",
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
                   AND login_account = ? AND platform = ? AND item_kind = 'trade' \
                   AND close_time_utc_msc >= 946684800000 \
                   AND close_time_utc_msc IS NOT NULL{} \
                 ORDER BY close_time_utc_msc DESC, item_id DESC LIMIT ? OFFSET ?;",
                request.filter_sql
            ))
            .map_err(|_| StoreError::new("bridge_store_history_page_query_failed"))?;
        let mut page_values = filtered_values.clone();
        page_values.push(SqlValue::Integer(request.page_size));
        page_values.push(SqlValue::Integer(
            (request.page - 1).saturating_mul(request.page_size),
        ));
        let mut rows = read_json_rows(&mut statement, params_from_iter(page_values))?;
        hydrate_history_trade_protection(
            &connection,
            terminal,
            &mut rows,
            request.requested_range.as_ref(),
        )?;
        let (deals, history_orders, evidence_truncated) = if request.include_deals {
            read_history_evidence_for_page(
                &connection,
                terminal,
                &rows,
                &request.evidence_position_ids,
                &request.evidence_order_tickets,
                request.requested_range.as_ref(),
            )?
        } else {
            (Vec::new(), Vec::new(), false)
        };
        let statistics =
            read_history_statistics(&connection, terminal, &request, total, filtered_values)?;
        let state = read_history_state_locked(&connection, terminal)?;
        let mut history_sync = read_history_sync_metadata_locked(
            &connection,
            terminal,
            &request,
            &state,
            now_utc_msc,
        )?;
        history_sync["evidence_truncated"] = serde_json::Value::Bool(evidence_truncated);
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
            "history_sync": history_sync,
            "source": format!("{}_sqlite", terminal.platform),
        });
        enforce_history_payload_budget(&mut payload)?;
        Ok(payload)
    }

    /// Read one exact-range history page using an opaque, bounded keyset
    /// cursor.  The legacy `history` action remains OFFSET based; this path
    /// deliberately has its own strict request parser and in-process state so
    /// a caller cannot accidentally turn a cursor into an unbounded archive
    /// scan.
    pub fn read_history_cursor_page(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        self.read_history_cursor_page_at(terminal, parameters, current_utc_msc()?)
    }

    pub fn read_history_cursor_page_at(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
        now_utc_msc: i64,
    ) -> Result<serde_json::Value, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let request = parse_history_cursor_page_request(parameters, now_utc_msc)?;
        let requested_snapshot = request.snapshot_id.clone();
        let requested_cursor = request.cursor.clone();
        let existing_snapshot = {
            let mut snapshots = self
                .history_snapshots
                .lock()
                .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
            cleanup_history_snapshots(&mut snapshots, now_utc_msc);
            requested_snapshot
                .as_deref()
                .map(|snapshot_id| {
                    snapshots
                        .get(snapshot_id)
                        .cloned()
                        .ok_or_else(|| StoreError::new("history_snapshot_invalid"))
                })
                .transpose()?
        };

        let (snapshot_id, snapshot, page_boundary, page) = if let Some(snapshot) = existing_snapshot
        {
            validate_history_snapshot_request(terminal, &request, &snapshot)?;
            let (boundary, page) = if let Some(cursor) = requested_cursor.as_deref() {
                let cursor_state = snapshot
                    .cursors
                    .get(cursor)
                    .ok_or_else(|| StoreError::new("history_cursor_invalid"))?;
                (
                    Some((
                        cursor_state.last_time_msc,
                        cursor_state.last_item_id.clone(),
                    )),
                    cursor_state.page.saturating_add(1),
                )
            } else {
                (None, 1)
            };
            (
                requested_snapshot.ok_or_else(|| StoreError::new("history_snapshot_invalid"))?,
                snapshot,
                boundary,
                page,
            )
        } else {
            if requested_cursor.is_some() {
                return Err(StoreError::new("history_cursor_invalid"));
            }
            let (snapshot_id, snapshot) =
                self.create_history_snapshot(terminal, &request, now_utc_msc)?;
            (snapshot_id, snapshot, None, 1)
        };

        let connection = self
            .history_read_connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let mut query = String::from(
            "SELECT payload_json, close_time_utc_msc, item_id FROM history_archive_items \
             WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
               AND login_account = ? AND platform = ? AND item_kind = 'trade' \
               AND close_time_utc_msc IS NOT NULL \
               AND rowid <= ? AND close_time_utc_msc >= ? AND close_time_utc_msc < ?",
        );
        query.push_str(&request.filter_sql);
        if page_boundary.is_some() {
            query.push_str(
                " AND (close_time_utc_msc < ? OR (close_time_utc_msc = ? AND item_id < ?))",
            );
        }
        query.push_str(" ORDER BY close_time_utc_msc DESC, item_id DESC LIMIT ?;");
        let mut values = history_scope_values(terminal);
        values.push(SqlValue::Text(terminal.platform.clone()));
        values.push(SqlValue::Integer(snapshot.highwater_rowid));
        values.push(SqlValue::Integer(snapshot.effective_range_start_utc_msc));
        values.push(SqlValue::Integer(snapshot.effective_range_end_utc_msc));
        values.extend(request.filter_values.iter().cloned());
        if let Some((last_time_msc, last_item_id)) = page_boundary.as_ref() {
            values.push(SqlValue::Integer(*last_time_msc));
            values.push(SqlValue::Integer(*last_time_msc));
            values.push(SqlValue::Text(last_item_id.clone()));
        }
        values.push(SqlValue::Integer(request.query.page_size.saturating_add(1)));
        let mut statement = connection
            .prepare(&query)
            .map_err(|_| StoreError::new("bridge_store_history_cursor_query_failed"))?;
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| StoreError::new("bridge_store_history_cursor_query_failed"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoreError::new("bridge_store_history_cursor_query_failed"))?;
        let has_more = rows.len() > request.query.page_size as usize;
        let rows = rows
            .into_iter()
            .take(request.query.page_size as usize)
            .collect::<Vec<_>>();
        let orders = rows
            .iter()
            .map(|(payload, _, _)| {
                serde_json::from_str(payload)
                    .ok()
                    .filter(serde_json::Value::is_object)
                    .ok_or_else(|| StoreError::new("bridge_store_history_payload_invalid"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);

        let next_cursor = if has_more {
            rows.last()
                .map(|(_, time_msc, item_id)| (*time_msc, item_id.clone()))
        } else {
            None
        };
        let next_cursor_token = if let Some((last_time_msc, last_item_id)) = next_cursor {
            let cursor_state = HistorySnapshotCursor {
                page,
                last_time_msc,
                last_item_id,
            };
            let mut snapshots = self
                .history_snapshots
                .lock()
                .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
            cleanup_history_snapshots(&mut snapshots, now_utc_msc);
            let snapshot_entry = snapshots
                .get_mut(&snapshot_id)
                .ok_or_else(|| StoreError::new("history_snapshot_invalid"))?;
            if let Some((token, _)) = snapshot_entry.cursors.iter().find(|(_, state)| {
                state.page == cursor_state.page
                    && state.last_time_msc == cursor_state.last_time_msc
                    && state.last_item_id == cursor_state.last_item_id
            }) {
                Some(token.clone())
            } else {
                let token = loop {
                    let candidate = random_history_token("hc_")?;
                    if !snapshot_entry.cursors.contains_key(&candidate) {
                        break candidate;
                    }
                };
                while snapshot_entry.cursors.len() >= MAX_HISTORY_SNAPSHOT_CURSORS {
                    let Some(oldest) = snapshot_entry.cursor_order.pop_front() else {
                        break;
                    };
                    snapshot_entry.cursors.remove(&oldest);
                }
                snapshot_entry.cursor_order.push_back(token.clone());
                snapshot_entry.cursors.insert(token.clone(), cursor_state);
                Some(token)
            }
        } else {
            None
        };

        let mut payload = serde_json::json!({
            "orders": orders,
            "deals": [],
            "history_orders": [],
            "statistics": snapshot.statistics,
            "pagination": {
                "current_page": page,
                "page_size": request.query.page_size,
                "total_count": snapshot.total_count,
                "total_pages": std::cmp::max(
                    (snapshot.total_count + request.query.page_size - 1)
                        / request.query.page_size,
                    1,
                ),
            },
            "history_snapshot_id": snapshot_id,
            "next_cursor": next_cursor_token,
            "has_more": has_more,
            "history_sync": snapshot.history_sync,
            "source": format!("{}_sqlite", terminal.platform),
        });
        if page == 1 {
            payload["chart_data"] = snapshot.chart_data.clone();
        }
        enforce_history_payload_budget(&mut payload)?;
        Ok(payload)
    }

    fn create_history_snapshot(
        &self,
        terminal: &TerminalDescriptor,
        request: &HistoryCursorPageRequest,
        now_utc_msc: i64,
    ) -> Result<(String, HistorySnapshotState), StoreError> {
        let connection = self
            .history_read_connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let metadata_request = HistoryPageRequest {
            page: 1,
            page_size: request.query.page_size,
            include_deals: false,
            evidence_position_ids: Vec::new(),
            evidence_order_tickets: Vec::new(),
            requested_range: Some(request.requested_range.clone()),
            filter_sql: request.filter_sql.clone(),
            filter_values: request.filter_values.clone(),
            direction: request.query.direction.clone(),
            profit_filter: request.query.profit_filter.clone(),
            capital_filter_sql: request.capital_filter_sql.clone(),
            capital_filter_values: request.capital_filter_values.clone(),
        };
        let state = read_history_state_locked(&connection, terminal)?;
        let history_sync = read_history_sync_metadata_locked(
            &connection,
            terminal,
            &metadata_request,
            &state,
            now_utc_msc,
        )?;
        let range_is_complete = if terminal.platform.eq_ignore_ascii_case("mt5") {
            history_sync["requested_range_complete"] == serde_json::Value::Bool(true)
        } else if terminal.platform == "mt4" {
            history_sync["terminal_visible_history_complete"] == serde_json::Value::Bool(true)
        } else {
            false
        };
        let (effective_range_start_utc_msc, effective_range_end_utc_msc) = if range_is_complete {
            (
                request.query.range_start_utc_msc,
                request.query.range_end_utc_msc,
            )
        } else if history_sync["head_ready"] == serde_json::Value::Bool(true) {
            let head_start = history_sync["head_range_start_utc_msc"]
                .as_i64()
                .ok_or_else(|| StoreError::new("history_cursor_range_incomplete"))?;
            let head_end = history_sync["head_range_end_utc_msc"]
                .as_i64()
                .ok_or_else(|| StoreError::new("history_cursor_range_incomplete"))?;
            let effective_start = request.query.range_start_utc_msc.max(head_start);
            let effective_end = request.query.range_end_utc_msc.min(head_end);
            if effective_start >= effective_end {
                return Err(StoreError::new("history_cursor_range_incomplete"));
            }
            (effective_start, effective_end)
        } else {
            return Err(StoreError::new("history_cursor_range_incomplete"));
        };
        let highwater_rowid = connection
            .query_row(
                "SELECT COALESCE(MAX(rowid), 0) FROM history_archive_items \
                 WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
                   AND login_account = ? AND platform = ?;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                ],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| StoreError::new("bridge_store_history_cursor_query_failed"))?;
        let mut total_sql = String::from(
            "SELECT COUNT(*) FROM history_archive_items \
             WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
               AND login_account = ? AND platform = ? AND item_kind = 'trade' \
               AND close_time_utc_msc IS NOT NULL \
               AND rowid <= ? AND close_time_utc_msc >= ? AND close_time_utc_msc < ?",
        );
        total_sql.push_str(&request.filter_sql);
        let mut total_values = history_scope_values(terminal);
        total_values.push(SqlValue::Text(terminal.platform.clone()));
        total_values.push(SqlValue::Integer(highwater_rowid));
        total_values.push(SqlValue::Integer(effective_range_start_utc_msc));
        total_values.push(SqlValue::Integer(effective_range_end_utc_msc));
        total_values.extend(request.filter_values.iter().cloned());
        let total = connection
            .query_row(&total_sql, params_from_iter(total_values), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| StoreError::new("bridge_store_history_cursor_query_failed"))?;
        let mut statistics_request = request.clone();
        statistics_request.query.range_start_utc_msc = effective_range_start_utc_msc;
        statistics_request.query.range_end_utc_msc = effective_range_end_utc_msc;
        let statistics = read_history_cursor_statistics(
            &connection,
            terminal,
            &statistics_request,
            total,
            highwater_rowid,
        )?;
        let chart_data = {
            let mut chart_request = metadata_request.clone();
            chart_request.requested_range = Some(HistoryRequestedRange {
                range_start_utc_msc: effective_range_start_utc_msc,
                range_end_utc_msc: effective_range_end_utc_msc,
            });
            let scope = HistoryScope {
                terminal_instance_id: terminal.terminal_instance_id.clone(),
                broker_server: terminal.account_ref.broker_server.clone(),
                login_account: terminal.account_ref.login.clone(),
            };
            let summary_v2_generation =
                history_summary_v2_ready_generation(&connection, &scope, &terminal.platform)?;
            match history_summary_ready_generation(&connection, &scope, &terminal.platform)? {
                Some(generation) => read_history_chart_data_from_summary(
                    &connection,
                    terminal,
                    &chart_request,
                    generation,
                    summary_v2_generation == Some(generation),
                    history_sync.clone(),
                )?,
                None => serde_json::Value::Null,
            }
        };
        drop(connection);

        let expires_at_utc_msc = now_utc_msc
            .checked_add(HISTORY_SNAPSHOT_TTL_MSC)
            .ok_or_else(|| StoreError::new("history_snapshot_invalid"))?;
        let snapshot_history_revision = history_sync["history_revision"]
            .as_i64()
            .ok_or_else(|| StoreError::new("history_snapshot_invalid"))?;
        let snapshot_summary_revision = history_sync["summary_revision"]
            .as_i64()
            .ok_or_else(|| StoreError::new("history_snapshot_invalid"))?;
        let snapshot = HistorySnapshotState {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
            platform: terminal.platform.clone(),
            query: request.query.clone(),
            effective_range_start_utc_msc,
            effective_range_end_utc_msc,
            highwater_rowid,
            total_count: total,
            statistics,
            history_sync,
            chart_data,
            history_revision: snapshot_history_revision,
            summary_revision: snapshot_summary_revision,
            expires_at_utc_msc,
            cursors: HashMap::new(),
            cursor_order: VecDeque::new(),
        };
        let mut snapshots = self
            .history_snapshots
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        cleanup_history_snapshots(&mut snapshots, now_utc_msc);
        let snapshot_id = loop {
            let candidate = random_history_token("hs_")?;
            if !snapshots.contains_key(&candidate) {
                break candidate;
            }
        };
        while snapshots.len() >= MAX_HISTORY_SNAPSHOTS {
            let oldest = snapshots
                .iter()
                .min_by_key(|(_, snapshot)| snapshot.expires_at_utc_msc)
                .map(|(snapshot_id, _)| snapshot_id.clone())
                .ok_or_else(|| StoreError::new("history_snapshot_invalid"))?;
            snapshots.remove(&oldest);
        }
        snapshots.insert(snapshot_id.clone(), snapshot.clone());
        Ok((snapshot_id, snapshot))
    }

    pub fn read_history_evidence(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
    ) -> Result<serde_json::Value, StoreError> {
        self.read_history_evidence_at(terminal, parameters, current_utc_msc()?)
    }

    pub fn read_history_evidence_at(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
        now_utc_msc: i64,
    ) -> Result<serde_json::Value, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let request = parse_history_evidence_request(parameters, now_utc_msc)?;
        let connection = self
            .history_read_connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        let deals = query_history_evidence(
            &connection,
            terminal,
            "deal",
            &request.evidence_position_ids,
            &request.evidence_order_tickets,
            Some(&request.requested_range),
        )?;
        let history_orders = query_history_evidence(
            &connection,
            terminal,
            "history_order",
            &request.evidence_position_ids,
            &request.evidence_order_tickets,
            Some(&request.requested_range),
        )?;
        let evidence_truncated = deals.len() > MAX_HISTORY_EVIDENCE_ITEMS
            || history_orders.len() > MAX_HISTORY_EVIDENCE_ITEMS;
        let state = read_history_state_locked(&connection, terminal)?;
        let page_request = HistoryPageRequest {
            page: 1,
            page_size: 1,
            include_deals: true,
            evidence_position_ids: request.evidence_position_ids.clone(),
            evidence_order_tickets: request.evidence_order_tickets.clone(),
            requested_range: Some(request.requested_range.clone()),
            filter_sql: String::new(),
            filter_values: Vec::new(),
            direction: None,
            profit_filter: None,
            capital_filter_sql: String::new(),
            capital_filter_values: Vec::new(),
        };
        let mut history_sync = read_history_sync_metadata_locked(
            &connection,
            terminal,
            &page_request,
            &state,
            now_utc_msc,
        )?;
        history_sync["evidence_truncated"] = serde_json::Value::Bool(evidence_truncated);
        let mut payload = serde_json::json!({
            "deals": deals.into_iter().take(MAX_HISTORY_EVIDENCE_ITEMS).collect::<Vec<_>>(),
            "history_orders": history_orders
                .into_iter()
                .take(MAX_HISTORY_EVIDENCE_ITEMS)
                .collect::<Vec<_>>(),
            "history_sync": history_sync,
            "evidence_truncated": evidence_truncated,
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
        self.read_history_chart_data_at(terminal, parameters, current_utc_msc()?)
    }

    pub fn read_history_chart_data_at(
        &self,
        terminal: &TerminalDescriptor,
        parameters: &serde_json::Value,
        now_utc_msc: i64,
    ) -> Result<serde_json::Value, StoreError> {
        terminal
            .validate()
            .map_err(|_| StoreError::new("bridge_store_history_scope_invalid"))?;
        let request = parse_history_chart_request(parameters, now_utc_msc)?;
        let connection = self
            .history_read_connection
            .lock()
            .map_err(|_| StoreError::new("bridge_store_lock_poisoned"))?;
        // Materialized summaries are the only source for aggregate chart
        // data.  A failed/pending build must fail closed rather than falling
        // back to a payload JSON table scan or returning fabricated zeros.
        let scope = HistoryScope {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            broker_server: terminal.account_ref.broker_server.clone(),
            login_account: terminal.account_ref.login.clone(),
        };
        let summary_v2_generation =
            history_summary_v2_ready_generation(&connection, &scope, &terminal.platform)?;
        let summary_generation =
            history_summary_ready_generation(&connection, &scope, &terminal.platform)?;
        let state = read_history_state_locked(&connection, terminal)?;
        let history_sync = read_history_sync_metadata_locked(
            &connection,
            terminal,
            &request,
            &state,
            now_utc_msc,
        )?;
        let Some(generation) = summary_generation else {
            return Ok(serde_json::json!({
                "daily": [],
                "cumulative": [],
                "drawdown": [],
                "stats": serde_json::Value::Null,
                "history_sync": history_sync,
                "source": format!("{}_sqlite", terminal.platform),
            }));
        };
        read_history_chart_data_from_summary(
            &connection,
            terminal,
            &request,
            generation,
            summary_v2_generation == Some(generation),
            history_sync,
        )
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
        let trim_candidates = {
            let mut statement = transaction
                .prepare(
                    "SELECT receipt.command_id
                     FROM execution_receipts receipt
                     LEFT JOIN native_command_ledger ledger
                       ON ledger.command_id = receipt.command_id
                     WHERE receipt.command_id IN (
                         SELECT command_id FROM execution_receipts
                         ORDER BY completed_at_utc_msc DESC, command_id DESC
                         LIMIT -1 OFFSET ?1
                       )
                       AND receipt.status != 'uncertain'
                       AND (ledger.command_id IS NULL OR ledger.status = 'acked')
                       AND NOT EXISTS (
                         SELECT 1 FROM outbox_messages pending
                         WHERE pending.acked_at_utc_msc IS NULL
                           AND pending.message_type = 'command_result'
                           AND json_valid(pending.payload_json) = 1
                           AND json_extract(pending.payload_json, '$.command_id') = receipt.command_id
                       )
                     ORDER BY receipt.completed_at_utc_msc DESC, receipt.command_id DESC;",
                )
                .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
            statement
                .query_map([receipt_limit as i64], |row| row.get::<_, String>(0))
                .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?
        };
        for command_id in trim_candidates {
            transaction
                .execute(
                    "DELETE FROM execution_receipts WHERE command_id = ?1;",
                    [&command_id],
                )
                .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
            transaction
                .execute(
                    "DELETE FROM native_command_ledger
                     WHERE command_id = ?1 AND status = 'acked';",
                    [&command_id],
                )
                .map_err(|_| StoreError::new("bridge_store_execution_receipt_write_failed"))?;
        }
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
        if !result.matches_reconciliation_command(&command) {
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

/// Open the short-lived history read model on an independent read-only
/// connection.  Schema checks and migrations must always run through the
/// writer connection before this is called; this connection only executes
/// connection-local/read-only pragmas and history queries.
fn open_history_read_connection(path: &Path) -> Result<Connection, StoreError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| StoreError::new("bridge_store_history_read_open_failed"))?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|_| StoreError::new("bridge_store_history_read_busy_timeout_failed"))?;
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .map_err(|_| StoreError::new("bridge_store_history_read_journal_mode_failed"))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::new(
            "bridge_store_history_read_journal_mode_failed",
        ));
    }
    // query_only is connection-local and is intentionally the only setting
    // performed on this read-only handle.  Do not run schema ensure or any
    // write-style journal/synchronous PRAGMA here.
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|_| StoreError::new("bridge_store_history_read_query_only_failed"))?;
    Ok(connection)
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
    ensure_native_command_ledger_schema(&connection)?;
    ensure_history_runtime_schema(&mut connection)
}

const HISTORY_RUNTIME_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS account_initialization_state (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0 AND schema_version <= 1000),
  state TEXT NOT NULL CHECK (
    state IN (
      'detected', 'verifying_identity', 'warming_realtime_snapshot',
      'reconciling_local_commands', 'ready', 'retrying', 'blocked', 'superseded'
    )
  ),
  local_operational_ready INTEGER NOT NULL CHECK (local_operational_ready IN (0, 1)),
  last_error_code TEXT,
  initialized_at_utc_msc INTEGER NOT NULL CHECK (initialized_at_utc_msc > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc > 0),
  CHECK (
    (state = 'ready' AND local_operational_ready = 1)
    OR (state <> 'ready' AND local_operational_ready = 0)
  ),
  PRIMARY KEY (terminal_instance_id, broker_server, login_account)
);
CREATE INDEX IF NOT EXISTS idx_account_initialization_updated
  ON account_initialization_state (
    terminal_instance_id, broker_server, login_account, updated_at_utc_msc DESC
  );
CREATE TABLE IF NOT EXISTS history_sync_jobs (
  job_id TEXT PRIMARY KEY,
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('recent', 'on_demand', 'backfill')),
  priority TEXT NOT NULL CHECK (priority IN ('p1', 'p2', 'p3')),
  range_start_utc_msc INTEGER NOT NULL CHECK (range_start_utc_msc > 0),
  range_end_utc_msc INTEGER NOT NULL CHECK (range_end_utc_msc > range_start_utc_msc),
  cursor_time_msc INTEGER NOT NULL CHECK (cursor_time_msc > 0),
  cursor_ticket TEXT NOT NULL CHECK (
    length(cursor_ticket) <= 32
    AND (cursor_ticket = '' OR cursor_ticket NOT GLOB '*[^0-9]*')
  ),
  window_msc INTEGER NOT NULL CHECK (window_msc > 0),
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'running', 'retrying', 'blocked', 'superseded', 'completed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 1000000),
  next_attempt_at_utc_msc INTEGER NOT NULL CHECK (next_attempt_at_utc_msc > 0),
  last_error_code TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at_utc_msc INTEGER CHECK (
    lease_expires_at_utc_msc IS NULL OR lease_expires_at_utc_msc > 0
  ),
  created_at_utc_msc INTEGER NOT NULL CHECK (created_at_utc_msc > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc > 0),
  UNIQUE (
    terminal_instance_id, broker_server, login_account,
    range_start_utc_msc, range_end_utc_msc
  )
);
CREATE INDEX IF NOT EXISTS idx_history_sync_jobs_claim
  ON history_sync_jobs (
    terminal_instance_id, broker_server, login_account,
    state, priority, next_attempt_at_utc_msc, created_at_utc_msc
  );
CREATE INDEX IF NOT EXISTS idx_history_sync_jobs_scope
  ON history_sync_jobs (
    terminal_instance_id, broker_server, login_account, updated_at_utc_msc DESC
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_order
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account,
    item_kind, order_ticket, event_time_msc, item_id
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_trade_close
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account, platform,
    item_kind, close_time_utc_msc DESC, item_id DESC
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_summary_scope
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account, platform,
    item_kind, summary_day_utc_msc, direction, event_time_msc, item_id
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_trade_filter
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account, platform,
    item_kind, direction, net_profit, event_time_msc, item_id
  );
CREATE TABLE IF NOT EXISTS history_coverage_ranges (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  range_start_utc_msc INTEGER NOT NULL CHECK (range_start_utc_msc > 0),
  range_end_utc_msc INTEGER NOT NULL CHECK (range_end_utc_msc > range_start_utc_msc),
  observed_at_utc_msc INTEGER NOT NULL CHECK (observed_at_utc_msc > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc > 0),
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, range_start_utc_msc
  )
);
CREATE INDEX IF NOT EXISTS idx_history_coverage_ranges_scope
  ON history_coverage_ranges (
    terminal_instance_id, broker_server, login_account,
    range_start_utc_msc, range_end_utc_msc
  );
CREATE TABLE IF NOT EXISTS history_scope_state (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  head_ready INTEGER NOT NULL DEFAULT 0 CHECK (head_ready IN (0, 1)),
  head_range_start_utc_msc INTEGER,
  head_range_end_utc_msc INTEGER,
  coverage_complete INTEGER NOT NULL DEFAULT 0 CHECK (coverage_complete IN (0, 1)),
  freshness_state TEXT NOT NULL CHECK (freshness_state IN ('fresh', 'refreshing', 'stale', 'blocked')),
  fresh_through_utc_msc INTEGER,
  history_revision INTEGER NOT NULL DEFAULT 0 CHECK (history_revision >= 0),
  summary_revision INTEGER NOT NULL DEFAULT 0 CHECK (summary_revision >= 0),
  summary_status TEXT NOT NULL CHECK (summary_status IN ('pending', 'rebuilding', 'ready', 'unavailable')),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  immutable_conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (immutable_conflict_count >= 0),
  updated_at_utc_msc INTEGER NOT NULL DEFAULT 0 CHECK (updated_at_utc_msc >= 0),
  CHECK (
    (head_ready = 0 AND head_range_start_utc_msc IS NULL AND head_range_end_utc_msc IS NULL)
    OR (head_ready = 1 AND head_range_start_utc_msc IS NOT NULL
        AND head_range_end_utc_msc IS NOT NULL
        AND head_range_end_utc_msc > head_range_start_utc_msc)
  ),
  CHECK (fresh_through_utc_msc IS NULL OR fresh_through_utc_msc > 0),
  PRIMARY KEY (terminal_instance_id, broker_server, login_account, platform)
);
CREATE INDEX IF NOT EXISTS idx_history_scope_state_updated
  ON history_scope_state (
    terminal_instance_id, broker_server, login_account, platform,
    updated_at_utc_msc DESC
  );
CREATE TABLE IF NOT EXISTS history_daily_summary (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  summary_day_utc_msc INTEGER NOT NULL CHECK (summary_day_utc_msc >= 0),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('trade', 'deal')),
  direction TEXT NOT NULL DEFAULT '',
  profit_bucket TEXT NOT NULL DEFAULT '',
  trade_count INTEGER NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  net_profit REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  deal_deposit REAL NOT NULL DEFAULT 0,
  deal_withdrawal REAL NOT NULL DEFAULT 0,
  deal_credit REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, platform,
    generation, summary_day_utc_msc, item_kind, direction, profit_bucket
  )
);
CREATE INDEX IF NOT EXISTS idx_history_daily_summary_active
  ON history_daily_summary (
    terminal_instance_id, broker_server, login_account, platform,
    generation, summary_day_utc_msc, item_kind, direction, profit_bucket
  );
CREATE TABLE IF NOT EXISTS history_summary_builds (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  active_generation INTEGER CHECK (active_generation IS NULL OR active_generation > 0),
  building_generation INTEGER CHECK (building_generation IS NULL OR building_generation > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc >= 0),
  PRIMARY KEY (terminal_instance_id, broker_server, login_account, platform)
);
CREATE INDEX IF NOT EXISTS idx_history_summary_builds_updated
  ON history_summary_builds (
    terminal_instance_id, broker_server, login_account, platform,
    updated_at_utc_msc DESC
  );

CREATE TABLE IF NOT EXISTS history_daily_summary_v2 (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  business_date TEXT NOT NULL CHECK (business_date GLOB '????-??-??'),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('trade', 'deal')),
  direction TEXT NOT NULL DEFAULT '',
  profit_bucket TEXT NOT NULL DEFAULT '',
  trade_count INTEGER NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  net_profit REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  deal_deposit REAL NOT NULL DEFAULT 0,
  deal_withdrawal REAL NOT NULL DEFAULT 0,
  deal_credit REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, platform,
    generation, business_date, item_kind, direction, profit_bucket
  )
);
CREATE INDEX IF NOT EXISTS idx_history_daily_summary_v2_active
  ON history_daily_summary_v2 (
    terminal_instance_id, broker_server, login_account, platform,
    generation, business_date, item_kind, direction, profit_bucket
  );
"#;

fn ensure_history_runtime_schema(connection: &mut Connection) -> Result<(), StoreError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| StoreError::new("bridge_store_history_schema_transaction_failed"))?;
    let scalar_columns_added = ensure_history_archive_scalar_columns(&transaction)?;
    if scalar_columns_added {
        backfill_history_archive_scalar_columns(&transaction)?;
    }
    ensure_history_scope_state_columns(&transaction)?;
    transaction
        .execute_batch(HISTORY_RUNTIME_SCHEMA_SQL)
        .map_err(|_| StoreError::new("bridge_store_history_schema_failed"))?;
    seed_history_coverage_from_legacy(&transaction)?;
    seed_history_scope_state_from_legacy(&transaction)?;
    transaction
        .commit()
        .map_err(|_| StoreError::new("bridge_store_history_schema_commit_failed"))
}

fn ensure_history_scope_state_columns(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    if !table_exists(transaction, "history_scope_state")? {
        return Ok(());
    }
    let columns = table_columns(transaction, "history_scope_state")?;
    for (column, definition) in [
        ("duplicate_count", "INTEGER NOT NULL DEFAULT 0"),
        ("immutable_conflict_count", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            transaction
                .execute(
                    &format!("ALTER TABLE history_scope_state ADD COLUMN {column} {definition};"),
                    [],
                )
                .map_err(|_| {
                    StoreError::new("bridge_store_history_scope_state_migration_failed")
                })?;
        }
    }
    Ok(())
}

fn ensure_history_archive_scalar_columns(
    transaction: &Transaction<'_>,
) -> Result<bool, StoreError> {
    let columns = table_columns(transaction, "history_archive_items")?;
    let mut added = false;
    for (column, definition) in [
        ("direction", "TEXT"),
        ("net_profit", "REAL"),
        ("volume", "REAL"),
        ("capital_kind", "TEXT"),
        ("capital_amount", "REAL"),
        ("summary_day_utc_msc", "INTEGER"),
        ("close_time_utc_msc", "INTEGER"),
        ("close_time_server_msc", "INTEGER"),
        ("close_timezone_offset_minutes", "INTEGER"),
        ("close_business_date", "TEXT"),
        ("immutable_state", "TEXT NOT NULL DEFAULT 'legacy'"),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            transaction
                .execute(
                    &format!("ALTER TABLE history_archive_items ADD COLUMN {column} {definition};"),
                    [],
                )
                .map_err(|_| StoreError::new("bridge_store_history_scalar_migration_failed"))?;
            added = true;
        }
    }
    Ok(added)
}

fn backfill_history_archive_scalar_columns(
    transaction: &Transaction<'_>,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "UPDATE history_archive_items
             SET direction = CASE
                 WHEN item_kind = 'trade' THEN CASE UPPER(COALESCE(
                     json_extract(payload_json, '$.type'),
                     json_extract(payload_json, '$.side'), ''))
                     WHEN '0' THEN 'BUY' WHEN '1' THEN 'SELL'
                     ELSE UPPER(COALESCE(json_extract(payload_json, '$.type'),
                                         json_extract(payload_json, '$.side'), '')) END
                 ELSE NULL END,
                 net_profit = CASE WHEN item_kind = 'trade' THEN CAST(COALESCE(
                     json_extract(payload_json, '$.net_profit'),
                     json_extract(payload_json, '$.profit'), 0) AS REAL) ELSE NULL END,
                 volume = CASE WHEN item_kind = 'trade' THEN CAST(COALESCE(
                     json_extract(payload_json, '$.volume'), 0) AS REAL) ELSE NULL END,
                 capital_kind = CASE
                     WHEN item_kind = 'deal'
                          AND CAST(COALESCE(json_extract(payload_json, '$.type'),
                                            json_extract(payload_json, '$.deal_type'), -1) AS INTEGER)
                                IN (2, 6)
                          AND CAST(COALESCE(json_extract(payload_json, '$.capital_amount'),
                                            json_extract(payload_json, '$.amount'),
                                            json_extract(payload_json, '$.profit'), 0) AS REAL) >= 0
                       THEN 'deposit'
                     WHEN item_kind = 'deal'
                          AND CAST(COALESCE(json_extract(payload_json, '$.type'),
                                            json_extract(payload_json, '$.deal_type'), -1) AS INTEGER)
                                IN (2, 6)
                          AND CAST(COALESCE(json_extract(payload_json, '$.capital_amount'),
                                            json_extract(payload_json, '$.amount'),
                                            json_extract(payload_json, '$.profit'), 0) AS REAL) < 0
                       THEN 'withdrawal'
                     WHEN item_kind = 'deal'
                          AND CAST(COALESCE(json_extract(payload_json, '$.type'),
                                            json_extract(payload_json, '$.deal_type'), -1) AS INTEGER)
                                IN (3, 7)
                       THEN 'credit'
                     ELSE NULL END,
                 capital_amount = CASE
                     WHEN item_kind = 'deal'
                          AND CAST(COALESCE(json_extract(payload_json, '$.type'),
                                            json_extract(payload_json, '$.deal_type'), -1) AS INTEGER)
                                IN (2, 6)
                       THEN ABS(CAST(COALESCE(json_extract(payload_json, '$.capital_amount'),
                                              json_extract(payload_json, '$.amount'),
                                              json_extract(payload_json, '$.profit'), 0) AS REAL))
                     WHEN item_kind = 'deal'
                          AND CAST(COALESCE(json_extract(payload_json, '$.type'),
                                            json_extract(payload_json, '$.deal_type'), -1) AS INTEGER)
                                IN (3, 7)
                       THEN CAST(COALESCE(json_extract(payload_json, '$.capital_amount'),
                                          json_extract(payload_json, '$.amount'),
                                          json_extract(payload_json, '$.profit'), 0) AS REAL)
                     ELSE NULL END,
                 summary_day_utc_msc = CASE
                     WHEN item_kind = 'trade'
                          AND CAST(COALESCE(
                              json_extract(payload_json, '$.close_time_server_msc'),
                              json_extract(payload_json, '$.close_time_utc_msc'),
                              json_extract(payload_json, '$.close_time_msc'), 0) AS INTEGER) > 0
                       THEN CAST(strftime('%s', COALESCE(
                           json_extract(payload_json, '$.close_business_date'),
                           json_extract(payload_json, '$.business_date'),
                           strftime('%Y-%m-%d', CAST(COALESCE(
                               json_extract(payload_json, '$.close_time_server_msc'),
                               json_extract(payload_json, '$.close_time_utc_msc'),
                               json_extract(payload_json, '$.close_time_msc'), 0) AS INTEGER)
                               / 1000, 'unixepoch'))) AS INTEGER) * 1000
                     ELSE event_time_msc - (event_time_msc % 86400000)
                 END,
                 close_time_utc_msc = CASE WHEN item_kind = 'trade' THEN CAST(COALESCE(
                     json_extract(payload_json, '$.close_time_utc_msc'),
                     json_extract(payload_json, '$.close_time_msc')) AS INTEGER) ELSE NULL END,
                 close_time_server_msc = CASE WHEN item_kind = 'trade' THEN CAST(COALESCE(
                     json_extract(payload_json, '$.close_time_server_msc'),
                     json_extract(payload_json, '$.close_time_utc_msc'),
                     json_extract(payload_json, '$.close_time_msc')) AS INTEGER) ELSE NULL END,
                 close_timezone_offset_minutes = CASE WHEN item_kind = 'trade' THEN CAST(COALESCE(
                     json_extract(payload_json, '$.close_timezone_offset_minutes'),
                     json_extract(payload_json, '$.timezone_offset_minutes'),
                     (CAST(COALESCE(json_extract(payload_json, '$.close_time_server_msc'),
                                    json_extract(payload_json, '$.close_time_utc_msc'),
                                    json_extract(payload_json, '$.close_time_msc'), 0) AS INTEGER)
                      - CAST(COALESCE(json_extract(payload_json, '$.close_time_utc_msc'),
                                      json_extract(payload_json, '$.close_time_msc'), 0) AS INTEGER))
                     / 60000, 0) AS INTEGER) ELSE NULL END,
                 close_business_date = CASE WHEN item_kind = 'trade' THEN COALESCE(
                     json_extract(payload_json, '$.close_business_date'),
                     json_extract(payload_json, '$.business_date'),
                     strftime('%Y-%m-%d',
                       CAST(COALESCE(json_extract(payload_json, '$.close_time_server_msc'),
                                     json_extract(payload_json, '$.close_time_utc_msc'),
                                     json_extract(payload_json, '$.close_time_msc'), 0) AS INTEGER)
                       / 1000, 'unixepoch')) ELSE NULL END,
                 immutable_state = CASE WHEN item_kind = 'trade'
                     AND CAST(json_extract(payload_json, '$.close_time_utc_msc') AS INTEGER) > 0
                     AND CAST(json_extract(payload_json, '$.close_time_server_msc') AS INTEGER) > 0
                     THEN 'sealed' ELSE 'legacy_incomplete' END;",
            [],
        )
        .map(|_| ())
        .map_err(|_| StoreError::new("bridge_store_history_scalar_backfill_failed"))
}

fn seed_history_scope_state_from_legacy(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    // A binding is the only legacy source that carries the platform.  Do not
    // guess MT4/MT5 for orphaned rows; the new state is lazily created by the
    // first platform-specific archive write instead.
    transaction
        .execute(
            "INSERT INTO history_scope_state (
               terminal_instance_id, broker_server, login_account, platform,
               head_ready, head_range_start_utc_msc, head_range_end_utc_msc,
               coverage_complete, freshness_state, fresh_through_utc_msc,
               history_revision, summary_revision, summary_status, updated_at_utc_msc
             )
             SELECT s.terminal_instance_id, s.broker_server, s.login_account,
                    LOWER(b.platform), 0, NULL, NULL, 0, 'stale', NULL, 0, 0,
                    'pending', s.updated_at_utc_msc
             FROM history_archive_state AS s
             JOIN terminal_bindings AS b
               ON b.terminal_instance_id = s.terminal_instance_id
              AND b.broker_server = s.broker_server COLLATE NOCASE
              AND b.login_account = s.login_account
             WHERE LOWER(b.platform) IN ('mt4', 'mt5')
             ON CONFLICT(terminal_instance_id, broker_server, login_account, platform)
             DO NOTHING;",
            [],
        )
        .map(|_| ())
        .map_err(|_| StoreError::new("bridge_store_history_seed_write_failed"))
}

fn seed_history_coverage_from_legacy(transaction: &Transaction<'_>) -> Result<(), StoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT terminal_instance_id, broker_server, login_account,
                    cursor_value, CAST(is_complete AS TEXT),
                    CAST(updated_at_utc_msc AS TEXT)
             FROM history_archive_state;",
        )
        .map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?;
    let mut legacy_rows = Vec::new();
    for row in rows {
        legacy_rows
            .push(row.map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?);
    }
    drop(statement);
    for (
        terminal_instance_id,
        broker_server,
        login_account,
        cursor_value,
        is_complete_text,
        updated_at_utc_msc_text,
    ) in legacy_rows
    {
        let Some((scope, cursor_time_msc, updated_at_utc_msc)) = parse_legacy_history_seed_row(
            terminal_instance_id,
            broker_server,
            login_account,
            cursor_value,
            is_complete_text,
            updated_at_utc_msc_text,
        )?
        else {
            continue;
        };
        transaction
            .execute(
                "INSERT INTO history_coverage_ranges (
                   terminal_instance_id, broker_server, login_account,
                   range_start_utc_msc, range_end_utc_msc,
                   observed_at_utc_msc, updated_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(terminal_instance_id, broker_server, login_account,
                             range_start_utc_msc) DO UPDATE SET
                   range_end_utc_msc = excluded.range_end_utc_msc,
                   observed_at_utc_msc = excluded.observed_at_utc_msc,
                   updated_at_utc_msc = excluded.updated_at_utc_msc
                 WHERE history_coverage_ranges.range_end_utc_msc
                       < excluded.range_end_utc_msc;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    HISTORY_COVERAGE_START_UTC_MSC,
                    cursor_time_msc,
                    updated_at_utc_msc,
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_seed_write_failed"))?;
    }
    Ok(())
}

fn parse_legacy_history_seed_row(
    terminal_instance_id: String,
    broker_server: String,
    login_account: String,
    cursor_value: String,
    is_complete_text: String,
    updated_at_utc_msc_text: String,
) -> Result<Option<(HistoryScope, i64, i64)>, StoreError> {
    let scope = HistoryScope {
        terminal_instance_id,
        broker_server,
        login_account,
    };
    validate_history_scope_values(&scope)
        .map_err(|_| StoreError::new("bridge_store_history_seed_invalid"))?;
    let is_complete = is_complete_text
        .parse::<i64>()
        .map_err(|_| StoreError::new("bridge_store_history_seed_invalid"))?;
    let updated_at_utc_msc = updated_at_utc_msc_text
        .parse::<i64>()
        .map_err(|_| StoreError::new("bridge_store_history_seed_invalid"))?;
    if !matches!(is_complete, 0 | 1) || updated_at_utc_msc <= 0 {
        return Err(StoreError::new("bridge_store_history_seed_invalid"));
    }
    let cursor = parse_history_cursor(&cursor_value)
        .map_err(|_| StoreError::new("bridge_store_history_seed_invalid"))?;
    if cursor.time_msc <= HISTORY_COVERAGE_START_UTC_MSC {
        return Ok(None);
    }
    Ok(Some((scope, cursor.time_msc, updated_at_utc_msc)))
}

fn legacy_history_seed_needed(connection: &Connection) -> Result<bool, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT terminal_instance_id, broker_server, login_account,
                    cursor_value, CAST(is_complete AS TEXT),
                    CAST(updated_at_utc_msc AS TEXT)
             FROM history_archive_state;",
        )
        .map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?;
    let mut legacy_rows = Vec::new();
    for row in rows {
        legacy_rows
            .push(row.map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?);
    }
    drop(statement);

    for (
        terminal_instance_id,
        broker_server,
        login_account,
        cursor_value,
        is_complete_text,
        updated_at_utc_msc_text,
    ) in legacy_rows
    {
        let Some((scope, cursor_time_msc, _updated_at_utc_msc)) = parse_legacy_history_seed_row(
            terminal_instance_id,
            broker_server,
            login_account,
            cursor_value,
            is_complete_text,
            updated_at_utc_msc_text,
        )?
        else {
            continue;
        };
        let existing_end = connection
            .query_row(
                "SELECT range_end_utc_msc
                 FROM history_coverage_ranges
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3
                   AND range_start_utc_msc = ?4
                 LIMIT 1;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    HISTORY_COVERAGE_START_UTC_MSC,
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_seed_query_failed"))?;
        if existing_end.is_none_or(|existing_end| existing_end < cursor_time_msc) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_history_scope_values(scope: &HistoryScope) -> Result<(), StoreError> {
    if validate_id(&scope.terminal_instance_id).is_err() || scope.account_ref().validate().is_err()
    {
        return Err(StoreError::new("bridge_store_history_scope_invalid"));
    }
    Ok(())
}

fn validate_history_platform(platform: &str) -> Result<(), StoreError> {
    if !matches!(platform, "mt4" | "mt5") {
        return Err(StoreError::new("bridge_store_history_platform_invalid"));
    }
    Ok(())
}

fn default_history_scope_state(scope: &HistoryScope, platform: &str) -> HistoryScopeState {
    HistoryScopeState {
        scope: scope.clone(),
        platform: platform.to_owned(),
        head_ready: false,
        head_range_start_utc_msc: None,
        head_range_end_utc_msc: None,
        coverage_complete: false,
        freshness_state: "stale".to_owned(),
        fresh_through_utc_msc: None,
        history_revision: 0,
        summary_revision: 0,
        summary_status: "pending".to_owned(),
        duplicate_count: 0,
        immutable_conflict_count: 0,
        updated_at_utc_msc: 0,
    }
}

fn read_history_scope_state_locked(
    connection: &Connection,
    scope: &HistoryScope,
    platform: &str,
) -> Result<HistoryScopeState, StoreError> {
    validate_history_scope_values(scope)?;
    let platform = platform.trim().to_ascii_lowercase();
    validate_history_platform(&platform)?;
    let row = connection
        .query_row(
            "SELECT head_ready, head_range_start_utc_msc, head_range_end_utc_msc,
                    coverage_complete, freshness_state, fresh_through_utc_msc,
                    history_revision, summary_revision, summary_status,
                    duplicate_count, immutable_conflict_count, updated_at_utc_msc
             FROM history_scope_state
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
             LIMIT 1;",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?;
    let Some((
        head_ready,
        head_start,
        head_end,
        coverage_complete,
        freshness,
        fresh_through,
        history_revision,
        summary_revision,
        summary_status,
        duplicate_count,
        immutable_conflict_count,
        updated_at,
    )) = row
    else {
        return Ok(default_history_scope_state(scope, &platform));
    };
    let state = HistoryScopeState {
        scope: scope.clone(),
        platform,
        head_ready: match head_ready {
            0 => false,
            1 => true,
            _ => return Err(StoreError::new("bridge_store_history_state_invalid")),
        },
        head_range_start_utc_msc: head_start,
        head_range_end_utc_msc: head_end,
        coverage_complete: match coverage_complete {
            0 => false,
            1 => true,
            _ => return Err(StoreError::new("bridge_store_history_state_invalid")),
        },
        freshness_state: freshness,
        fresh_through_utc_msc: fresh_through,
        history_revision,
        summary_revision,
        summary_status,
        duplicate_count,
        immutable_conflict_count,
        updated_at_utc_msc: updated_at,
    };
    validate_history_scope_state(&state)?;
    Ok(state)
}

fn validate_history_scope_state(state: &HistoryScopeState) -> Result<(), StoreError> {
    validate_history_scope_values(&state.scope)?;
    validate_history_platform(&state.platform)?;
    if !matches!(
        state.freshness_state.as_str(),
        "fresh" | "refreshing" | "stale" | "blocked"
    ) || !matches!(
        state.summary_status.as_str(),
        "pending" | "rebuilding" | "ready" | "unavailable"
    ) || state.history_revision < 0
        || state.summary_revision < 0
        || state.duplicate_count < 0
        || state.immutable_conflict_count < 0
        || state.updated_at_utc_msc < 0
        || state.fresh_through_utc_msc.is_some_and(|value| value <= 0)
        || state.head_ready
            && (state.head_range_start_utc_msc.is_none()
                || state.head_range_end_utc_msc.is_none()
                || state.head_range_end_utc_msc <= state.head_range_start_utc_msc)
        || !state.head_ready
            && (state.head_range_start_utc_msc.is_some() || state.head_range_end_utc_msc.is_some())
    {
        return Err(StoreError::new("bridge_store_history_state_invalid"));
    }
    Ok(())
}

fn write_history_scope_state_tx(
    transaction: &Transaction<'_>,
    state: &HistoryScopeState,
) -> Result<(), StoreError> {
    validate_history_scope_state(state)?;
    transaction
        .execute(
            "INSERT INTO history_scope_state (
               terminal_instance_id, broker_server, login_account, platform,
               head_ready, head_range_start_utc_msc, head_range_end_utc_msc,
               coverage_complete, freshness_state, fresh_through_utc_msc,
               history_revision, summary_revision, summary_status,
               duplicate_count, immutable_conflict_count, updated_at_utc_msc
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(terminal_instance_id, broker_server, login_account, platform)
             DO UPDATE SET
               head_ready = excluded.head_ready,
               head_range_start_utc_msc = excluded.head_range_start_utc_msc,
               head_range_end_utc_msc = excluded.head_range_end_utc_msc,
               coverage_complete = excluded.coverage_complete,
               freshness_state = excluded.freshness_state,
               fresh_through_utc_msc = excluded.fresh_through_utc_msc,
               history_revision = excluded.history_revision,
               summary_revision = excluded.summary_revision,
               summary_status = excluded.summary_status,
               duplicate_count = excluded.duplicate_count,
               immutable_conflict_count = excluded.immutable_conflict_count,
               updated_at_utc_msc = excluded.updated_at_utc_msc;",
            params![
                state.scope.terminal_instance_id,
                state.scope.broker_server,
                state.scope.login_account,
                state.platform,
                i64::from(state.head_ready),
                state.head_range_start_utc_msc,
                state.head_range_end_utc_msc,
                i64::from(state.coverage_complete),
                state.freshness_state,
                state.fresh_through_utc_msc,
                state.history_revision,
                state.summary_revision,
                state.summary_status,
                state.duplicate_count,
                state.immutable_conflict_count,
                state.updated_at_utc_msc,
            ],
        )
        .map(|_| ())
        .map_err(|_| StoreError::new("bridge_store_history_state_write_failed"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct HistorySummaryBuild {
    active_generation: Option<i64>,
    building_generation: Option<i64>,
}

fn read_history_summary_build_locked(
    connection: &Connection,
    scope: &HistoryScope,
    platform: &str,
) -> Result<Option<HistorySummaryBuild>, StoreError> {
    connection
        .query_row(
            "SELECT active_generation, building_generation
             FROM history_summary_builds
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4 LIMIT 1;",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform
            ],
            |row| {
                Ok(HistorySummaryBuild {
                    active_generation: row.get(0)?,
                    building_generation: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_summary_query_failed"))
}

fn insert_history_summary_generation_tx(
    transaction: &Transaction<'_>,
    scope: &HistoryScope,
    platform: &str,
    generation: i64,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT INTO history_daily_summary (
               terminal_instance_id, broker_server, login_account, platform,
               generation, summary_day_utc_msc, item_kind, direction, profit_bucket,
               trade_count, net_profit, volume, deal_deposit, deal_withdrawal, deal_credit
             )
             SELECT ?1, ?2, ?3, ?4, ?5, summary_day_utc_msc, 'trade',
                    COALESCE(direction, ''),
                    CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                         WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END,
                    COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                    COALESCE(SUM(COALESCE(volume, 0)), 0), 0, 0, 0
             FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND item_kind = 'trade' AND close_time_utc_msc >= 946684800000
               AND immutable_state = 'sealed'
               AND summary_day_utc_msc IS NOT NULL
             GROUP BY summary_day_utc_msc, COALESCE(direction, ''),
                      CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                           WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END
             UNION ALL
             SELECT ?1, ?2, ?3, ?4, ?5, summary_day_utc_msc, 'deal', '', capital_kind,
                    0, 0, 0,
                    COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0)
             FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND item_kind = 'deal' AND event_time_msc >= 946684800000
               AND capital_kind IS NOT NULL
               AND summary_day_utc_msc IS NOT NULL
             GROUP BY summary_day_utc_msc, capital_kind;",
            params![scope.terminal_instance_id, scope.broker_server, scope.login_account, platform, generation],
        )
        .map(|_| ())
        .map_err(|_| StoreError::new("bridge_store_history_summary_build_failed"))
}

fn insert_history_summary_v2_generation_tx(
    transaction: &Transaction<'_>,
    scope: &HistoryScope,
    platform: &str,
    generation: i64,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT INTO history_daily_summary_v2 (
               terminal_instance_id, broker_server, login_account, platform,
               generation, business_date, item_kind, direction, profit_bucket,
               trade_count, net_profit, volume, deal_deposit, deal_withdrawal, deal_credit
             )
             SELECT ?1, ?2, ?3, ?4, ?5, close_business_date, 'trade',
                    COALESCE(direction, ''),
                    CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                         WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END,
                    COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                    COALESCE(SUM(COALESCE(volume, 0)), 0), 0, 0, 0
             FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND item_kind = 'trade' AND close_time_utc_msc >= 946684800000
               AND immutable_state = 'sealed'
               AND close_business_date IS NOT NULL
             GROUP BY close_business_date, COALESCE(direction, ''),
                      CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                           WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END
             UNION ALL
             SELECT ?1, ?2, ?3, ?4, ?5,
                    strftime('%Y-%m-%d', summary_day_utc_msc / 1000, 'unixepoch'),
                    'deal', '', capital_kind,
                    0, 0, 0,
                    COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0)
             FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND item_kind = 'deal' AND event_time_msc >= 946684800000
               AND capital_kind IS NOT NULL
               AND summary_day_utc_msc IS NOT NULL
             GROUP BY strftime('%Y-%m-%d', summary_day_utc_msc / 1000, 'unixepoch'), capital_kind;",
            params![scope.terminal_instance_id, scope.broker_server, scope.login_account, platform, generation],
        )
        .map(|_| ())
        .map_err(|_| StoreError::new("bridge_store_history_summary_build_failed"))
}

fn validate_history_summary_generation_tx(
    transaction: &Transaction<'_>,
    scope: &HistoryScope,
    platform: &str,
    generation: i64,
) -> Result<(), StoreError> {
    let malformed_scalar_count = transaction
        .query_row(
            "SELECT COUNT(*) FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND ((item_kind = 'trade' AND close_time_utc_msc >= ?5
                     AND immutable_state = 'sealed')
                    OR (item_kind = 'deal' AND event_time_msc >= ?5))
               AND ((item_kind = 'trade'
                     AND (net_profit IS NULL OR volume IS NULL
                          OR typeof(net_profit) NOT IN ('integer', 'real')
                          OR typeof(volume) NOT IN ('integer', 'real')))
                    OR (item_kind = 'deal' AND capital_kind IS NOT NULL
                        AND (capital_amount IS NULL
                             OR typeof(capital_amount) NOT IN ('integer', 'real'))));",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                HISTORY_COVERAGE_START_UTC_MSC
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_validate_failed"))?;
    if malformed_scalar_count > 0 {
        return Err(StoreError::new(
            "bridge_store_history_summary_validation_mismatch",
        ));
    }
    let raw_trade = transaction
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                    COALESCE(SUM(COALESCE(volume, 0)), 0)
             FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND item_kind = 'trade' AND close_time_utc_msc >= ?5
               AND immutable_state = 'sealed';",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                HISTORY_COVERAGE_START_UTC_MSC
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_validate_failed"))?;
    let summary_trade = transaction
        .query_row(
            "SELECT COALESCE(SUM(trade_count), 0), COALESCE(SUM(net_profit), 0),
                    COALESCE(SUM(volume), 0)
             FROM history_daily_summary
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND generation = ?5 AND item_kind = 'trade';",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                generation
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_validate_failed"))?;
    let raw_capital = transaction
        .query_row(
            "SELECT COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0)
             FROM history_archive_items
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND item_kind = 'deal' AND event_time_msc >= ?5;",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                HISTORY_COVERAGE_START_UTC_MSC
            ],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_validate_failed"))?;
    let summary_capital = transaction
        .query_row(
            "SELECT COALESCE(SUM(deal_deposit), 0), COALESCE(SUM(deal_withdrawal), 0),
                    COALESCE(SUM(deal_credit), 0)
             FROM history_daily_summary
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4
               AND generation = ?5 AND item_kind = 'deal';",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                generation
            ],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_validate_failed"))?;
    let close = |left: f64, right: f64| {
        let tolerance = 1.0e-9_f64.max(left.abs().max(right.abs()) * 1.0e-9);
        (left - right).abs() <= tolerance
    };
    if raw_trade.0 != summary_trade.0
        || !close(raw_trade.1, summary_trade.1)
        || !close(raw_trade.2, summary_trade.2)
        || !close(raw_capital.0, summary_capital.0)
        || !close(raw_capital.1, summary_capital.1)
        || !close(raw_capital.2, summary_capital.2)
    {
        return Err(StoreError::new(
            "bridge_store_history_summary_validation_mismatch",
        ));
    }
    Ok(())
}

fn refresh_history_summary_days_tx(
    transaction: &Transaction<'_>,
    scope: &HistoryScope,
    platform: &str,
    generation: i64,
    days: &[i64],
) -> Result<(), StoreError> {
    for day in days {
        transaction
            .execute(
                "DELETE FROM history_daily_summary
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND generation = ?5 AND summary_day_utc_msc = ?6;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    platform,
                    generation,
                    day
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_summary_incremental_failed"))?;
        transaction
            .execute(
                "INSERT INTO history_daily_summary (
                   terminal_instance_id, broker_server, login_account, platform,
                   generation, summary_day_utc_msc, item_kind, direction, profit_bucket,
                   trade_count, net_profit, volume, deal_deposit, deal_withdrawal, deal_credit
                 )
                 SELECT ?1, ?2, ?3, ?4, ?5, summary_day_utc_msc, 'trade',
                        COALESCE(direction, ''),
                        CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                             WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END,
                        COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                        COALESCE(SUM(COALESCE(volume, 0)), 0), 0, 0, 0
                 FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND item_kind = 'trade' AND close_time_utc_msc >= 946684800000
                   AND immutable_state = 'sealed'
                   AND summary_day_utc_msc = ?6
                 GROUP BY summary_day_utc_msc, COALESCE(direction, ''),
                          CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                               WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END
                 UNION ALL
                 SELECT ?1, ?2, ?3, ?4, ?5, summary_day_utc_msc, 'deal', '', capital_kind,
                        0, 0, 0,
                        COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0)
                 FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND item_kind = 'deal' AND event_time_msc >= 946684800000
                   AND capital_kind IS NOT NULL
                   AND summary_day_utc_msc = ?6
                 GROUP BY summary_day_utc_msc, capital_kind;",
                params![scope.terminal_instance_id, scope.broker_server, scope.login_account, platform, generation, day],
            )
            .map_err(|_| StoreError::new("bridge_store_history_summary_incremental_failed"))?;
    }
    Ok(())
}

fn refresh_history_summary_v2_days_tx(
    transaction: &Transaction<'_>,
    scope: &HistoryScope,
    platform: &str,
    generation: i64,
    days: &[i64],
) -> Result<(), StoreError> {
    for day in days {
        let business_date = business_date_from_server_msc(*day)?;
        transaction
            .execute(
                "DELETE FROM history_daily_summary_v2
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND generation = ?5 AND business_date = ?6;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    platform,
                    generation,
                    business_date
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_summary_incremental_failed"))?;
        transaction
            .execute(
                "INSERT INTO history_daily_summary_v2 (
                   terminal_instance_id, broker_server, login_account, platform,
                   generation, business_date, item_kind, direction, profit_bucket,
                   trade_count, net_profit, volume, deal_deposit, deal_withdrawal, deal_credit
                 )
                 SELECT ?1, ?2, ?3, ?4, ?5, close_business_date, 'trade',
                        COALESCE(direction, ''),
                        CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                             WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END,
                        COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                        COALESCE(SUM(COALESCE(volume, 0)), 0), 0, 0, 0
                 FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND item_kind = 'trade' AND close_time_utc_msc >= 946684800000
                   AND immutable_state = 'sealed'
                   AND close_business_date = ?6
                 GROUP BY close_business_date, COALESCE(direction, ''),
                          CASE WHEN COALESCE(net_profit, 0) > 0 THEN 'profit'
                               WHEN COALESCE(net_profit, 0) < 0 THEN 'loss' ELSE 'flat' END
                 UNION ALL
                 SELECT ?1, ?2, ?3, ?4, ?5,
                        strftime('%Y-%m-%d', summary_day_utc_msc / 1000, 'unixepoch'),
                        'deal', '', capital_kind,
                        0, 0, 0,
                        COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0)
                 FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND item_kind = 'deal' AND event_time_msc >= 946684800000
                   AND capital_kind IS NOT NULL
                   AND strftime('%Y-%m-%d', summary_day_utc_msc / 1000, 'unixepoch') = ?6
                 GROUP BY strftime('%Y-%m-%d', summary_day_utc_msc / 1000, 'unixepoch'), capital_kind;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    platform,
                    generation,
                    business_date
                ],
            )
            .map_err(|_| StoreError::new("bridge_store_history_summary_incremental_failed"))?;
    }
    Ok(())
}

fn history_scopes_equal(left: &HistoryScope, right: &HistoryScope) -> bool {
    left.terminal_instance_id == right.terminal_instance_id
        && left.login_account == right.login_account
        && left
            .broker_server
            .eq_ignore_ascii_case(&right.broker_server)
}

fn validate_history_job_id(job_id: &str) -> Result<(), StoreError> {
    validate_id(job_id).map_err(|_| StoreError::new("bridge_store_history_job_id_invalid"))
}

fn history_job_identity(
    scope: &HistoryScope,
    job_kind: &str,
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        scope.terminal_instance_id.as_str(),
        scope.broker_server.as_str(),
        scope.login_account.as_str(),
        job_kind,
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    hasher.update(range_start_utc_msc.to_be_bytes());
    hasher.update(range_end_utc_msc.to_be_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_history_lease_generation(lease_generation: i64) -> Result<(), StoreError> {
    if lease_generation <= 0 {
        return Err(StoreError::new("bridge_store_history_lease_invalid"));
    }
    Ok(())
}

fn validate_history_error_code(error_code: &str) -> Result<(), StoreError> {
    if !(1..=128).contains(&error_code.len())
        || !error_code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(StoreError::new("bridge_store_history_error_code_invalid"));
    }
    Ok(())
}

fn validate_history_state(state: &str) -> Result<(), StoreError> {
    if !matches!(
        state,
        "queued" | "running" | "retrying" | "blocked" | "superseded" | "completed"
    ) {
        return Err(StoreError::new("bridge_store_history_state_invalid"));
    }
    Ok(())
}

fn validate_initialization_state(state: &str) -> Result<(), StoreError> {
    if !matches!(
        state,
        "detected"
            | "verifying_identity"
            | "warming_realtime_snapshot"
            | "reconciling_local_commands"
            | "ready"
            | "retrying"
            | "blocked"
            | "superseded"
    ) {
        return Err(StoreError::new("bridge_store_initialization_state_invalid"));
    }
    Ok(())
}

fn validate_history_job_kind(job_kind: &str) -> Result<(), StoreError> {
    if !matches!(job_kind, "recent" | "on_demand" | "backfill") {
        return Err(StoreError::new("bridge_store_history_job_kind_invalid"));
    }
    Ok(())
}

fn is_allowed_history_job_kind(job_kind: &str) -> bool {
    matches!(job_kind, "recent" | "on_demand" | "backfill")
}

fn validate_history_job_planning_request(
    request: &HistoryJobPlanningRequest,
) -> Result<(), StoreError> {
    validate_history_scope_values(&request.scope)?;
    validate_history_job_kind(&request.job_kind)?;
    validate_history_priority(&request.priority)?;
    validate_history_range(request.range_start_utc_msc, request.range_end_utc_msc)?;
    if request.range_start_utc_msc < HISTORY_COVERAGE_START_UTC_MSC
        && request.now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC
    {
        return Err(StoreError::new("bridge_store_history_range_before_floor"));
    }
    if request.window_msc <= 0 || request.now_utc_msc <= 0 {
        return Err(StoreError::new("bridge_store_history_planning_invalid"));
    }
    let valid_combination = matches!(
        (request.job_kind.as_str(), request.priority.as_str()),
        ("recent", "p2") | ("on_demand", "p1") | ("on_demand", "p3")
    ) || request.job_kind == "backfill"
        && request.priority == "p3"
        && request.now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC;
    if !valid_combination {
        return Err(StoreError::new(
            "bridge_store_history_planning_combination_invalid",
        ));
    }
    Ok(())
}

fn validate_history_tail_refresh_request(
    request: &HistoryTailRefreshRequest,
) -> Result<(), StoreError> {
    validate_history_scope_values(&request.scope)?;
    validate_history_platform(&request.platform)?;
    if request.platform != "mt5"
        || (request.range_start_utc_msc < HISTORY_COVERAGE_START_UTC_MSC
            && request.now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC)
        || request.range_end_utc_msc <= request.range_start_utc_msc
        || request.now_utc_msc <= 0
        || request.range_end_utc_msc > request.now_utc_msc.saturating_add(60_000)
    {
        return Err(StoreError::new("bridge_store_history_tail_invalid"));
    }
    Ok(())
}

fn normalize_history_job_kinds<K: AsRef<str>>(
    allowed_job_kinds: &[K],
) -> Result<Vec<String>, StoreError> {
    if allowed_job_kinds.is_empty() {
        return Err(StoreError::new(
            "bridge_store_history_allowed_job_kinds_invalid",
        ));
    }
    let mut normalized = Vec::with_capacity(allowed_job_kinds.len());
    for job_kind in allowed_job_kinds {
        let job_kind = job_kind.as_ref();
        validate_history_job_kind(job_kind)
            .map_err(|_| StoreError::new("bridge_store_history_allowed_job_kinds_invalid"))?;
        if !normalized.iter().any(|existing| existing == job_kind) {
            normalized.push(job_kind.to_owned());
        }
    }
    if normalized.is_empty() {
        return Err(StoreError::new(
            "bridge_store_history_allowed_job_kinds_invalid",
        ));
    }
    Ok(normalized)
}

fn validate_history_priority(priority: &str) -> Result<(), StoreError> {
    if !matches!(priority, "p1" | "p2" | "p3") {
        return Err(StoreError::new("bridge_store_history_priority_invalid"));
    }
    Ok(())
}

fn validate_history_range(
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
) -> Result<(), StoreError> {
    if range_start_utc_msc <= 0 || range_end_utc_msc <= range_start_utc_msc {
        return Err(StoreError::new("bridge_store_history_range_invalid"));
    }
    Ok(())
}

fn validate_job_cursor(cursor_time_msc: i64, cursor_ticket: &str) -> Result<(), StoreError> {
    if cursor_time_msc <= 0
        || cursor_ticket.len() > 32
        || cursor_ticket.bytes().any(|byte| !byte.is_ascii_digit())
    {
        return Err(StoreError::new("bridge_store_history_cursor_invalid"));
    }
    Ok(())
}

fn validate_account_initialization_state(
    state: &AccountInitializationState,
) -> Result<(), StoreError> {
    validate_history_scope_values(&state.scope)?;
    if !matches!(state.platform.as_str(), "mt4" | "mt5")
        || !(1..=1000).contains(&state.schema_version)
        || state.initialized_at_utc_msc <= 0
        || state.updated_at_utc_msc < state.initialized_at_utc_msc
    {
        return Err(StoreError::new("bridge_store_initialization_state_invalid"));
    }
    validate_initialization_state(&state.state)?;
    if (state.state == "ready") != state.local_operational_ready {
        return Err(StoreError::new("bridge_store_initialization_state_invalid"));
    }
    if let Some(error_code) = state.last_error_code.as_deref() {
        validate_history_error_code(error_code)?;
    }
    Ok(())
}

fn validate_new_history_sync_job(job: &NewHistorySyncJob) -> Result<(), StoreError> {
    validate_history_job_id(&job.job_id)?;
    validate_history_scope_values(&job.scope)?;
    validate_history_job_kind(&job.job_kind)?;
    validate_history_priority(&job.priority)?;
    validate_history_range(job.range_start_utc_msc, job.range_end_utc_msc)?;
    validate_job_cursor(job.cursor_time_msc, &job.cursor_ticket)?;
    if job.cursor_time_msc < job.range_start_utc_msc
        || job.cursor_time_msc > job.range_end_utc_msc
        || job.cursor_time_msc == job.range_end_utc_msc && !job.cursor_ticket.is_empty()
        || job.window_msc <= 0
        || job.created_at_utc_msc <= 0
    {
        return Err(StoreError::new("bridge_store_history_job_invalid"));
    }
    Ok(())
}

fn read_account_initialization_state_locked(
    connection: &Connection,
    scope: &HistoryScope,
) -> Result<Option<AccountInitializationState>, StoreError> {
    let row = connection
        .query_row(
            "SELECT platform, schema_version, state, local_operational_ready,
                    last_error_code, initialized_at_utc_msc, updated_at_utc_msc
             FROM account_initialization_state
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 LIMIT 1;",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_initialization_state_query_failed"))?;
    let Some((platform, schema_version, state, ready, last_error_code, initialized_at, updated_at)) =
        row
    else {
        return Ok(None);
    };
    let state = AccountInitializationState {
        scope: scope.clone(),
        platform,
        schema_version,
        state,
        local_operational_ready: match ready {
            0 => false,
            1 => true,
            _ => {
                return Err(StoreError::new("bridge_store_initialization_state_invalid"));
            }
        },
        last_error_code,
        initialized_at_utc_msc: initialized_at,
        updated_at_utc_msc: updated_at,
    };
    validate_account_initialization_state(&state)
        .map_err(|_| StoreError::new("bridge_store_initialization_state_invalid"))?;
    Ok(Some(state))
}

type HistorySyncJobRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    String,
    i64,
    String,
    i64,
    i64,
    Option<String>,
    i64,
    Option<i64>,
    i64,
    i64,
);

fn history_sync_job_select() -> &'static str {
    "SELECT job_id, terminal_instance_id, broker_server, login_account,
            job_kind, priority, range_start_utc_msc, range_end_utc_msc,
            cursor_time_msc, cursor_ticket, window_msc, state, attempt_count,
            next_attempt_at_utc_msc, last_error_code, lease_generation,
            lease_expires_at_utc_msc, created_at_utc_msc, updated_at_utc_msc"
}

fn read_history_sync_job_by_id(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<HistorySyncJob>, StoreError> {
    let row = connection
        .query_row(
            &format!(
                "{} FROM history_sync_jobs WHERE job_id = ?1 LIMIT 1;",
                history_sync_job_select()
            ),
            [job_id],
            history_sync_job_row_from_sql,
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_job_query_failed"))?;
    row.map(history_sync_job_from_row).transpose()
}

fn read_history_sync_job_by_range(
    connection: &Connection,
    scope: &HistoryScope,
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
) -> Result<Option<HistorySyncJob>, StoreError> {
    let row = connection
        .query_row(
            &format!(
                "{} FROM history_sync_jobs
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3
                   AND range_start_utc_msc = ?4
                   AND range_end_utc_msc = ?5 LIMIT 1;",
                history_sync_job_select()
            ),
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                range_start_utc_msc,
                range_end_utc_msc
            ],
            history_sync_job_row_from_sql,
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_job_query_failed"))?;
    row.map(history_sync_job_from_row).transpose()
}

fn read_active_history_jobs_locked(
    connection: &Connection,
    scope: &HistoryScope,
) -> Result<Vec<HistorySyncJob>, StoreError> {
    let mut statement = connection
        .prepare(&format!(
            "{} FROM history_sync_jobs
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3
               AND job_kind IN ('recent', 'on_demand', 'backfill')
               AND state IN ('queued', 'retrying', 'running')
             ORDER BY range_start_utc_msc, range_end_utc_msc, job_id;",
            history_sync_job_select()
        ))
        .map_err(|_| StoreError::new("bridge_store_history_planning_query_failed"))?;
    let rows = statement
        .query_map(
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account
            ],
            history_sync_job_row_from_sql,
        )
        .map_err(|_| StoreError::new("bridge_store_history_planning_query_failed"))?;
    rows.map(|row| {
        row.map_err(|_| StoreError::new("bridge_store_history_planning_query_failed"))
            .and_then(history_sync_job_from_row)
    })
    .collect()
}

fn history_job_order(left: &HistorySyncJob, right: &HistorySyncJob) -> std::cmp::Ordering {
    left.range_start_utc_msc
        .cmp(&right.range_start_utc_msc)
        .then_with(|| left.range_end_utc_msc.cmp(&right.range_end_utc_msc))
        .then_with(|| left.job_id.cmp(&right.job_id))
}

fn dedup_history_jobs(jobs: &mut Vec<HistorySyncJob>) {
    jobs.sort_by(history_job_order);
    jobs.dedup_by(|left, right| left.job_id == right.job_id);
}

fn ranges_overlap(left_start: i64, left_end: i64, right_start: i64, right_end: i64) -> bool {
    left_start < right_end && right_start < left_end
}

fn subtract_history_ranges(
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
    blockers: &[(i64, i64)],
) -> Vec<(i64, i64)> {
    let mut sorted = blockers
        .iter()
        .copied()
        .filter(|(start, end)| *end > *start)
        .collect::<Vec<_>>();
    sorted.sort_unstable();
    let mut cursor = range_start_utc_msc;
    let mut gaps = Vec::new();
    for (blocker_start, blocker_end) in sorted {
        if blocker_end <= cursor {
            continue;
        }
        if blocker_start >= range_end_utc_msc {
            break;
        }
        if blocker_start > cursor {
            gaps.push((cursor, blocker_start.min(range_end_utc_msc)));
        }
        cursor = cursor.max(blocker_end.min(range_end_utc_msc));
        if cursor >= range_end_utc_msc {
            break;
        }
    }
    if cursor < range_end_utc_msc {
        gaps.push((cursor, range_end_utc_msc));
    }
    gaps.retain(|(start, end)| end > start);
    gaps
}

fn history_sync_job_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistorySyncJobRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
        row.get(16)?,
        row.get(17)?,
        row.get(18)?,
    ))
}

fn history_sync_job_from_row(row: HistorySyncJobRow) -> Result<HistorySyncJob, StoreError> {
    let (
        job_id,
        terminal_instance_id,
        broker_server,
        login_account,
        job_kind,
        priority,
        range_start_utc_msc,
        range_end_utc_msc,
        cursor_time_msc,
        cursor_ticket,
        window_msc,
        state,
        attempt_count,
        next_attempt_at_utc_msc,
        last_error_code,
        lease_generation,
        lease_expires_at_utc_msc,
        created_at_utc_msc,
        updated_at_utc_msc,
    ) = row;
    let job = HistorySyncJob {
        job_id,
        scope: HistoryScope {
            terminal_instance_id,
            broker_server,
            login_account,
        },
        job_kind,
        priority,
        range_start_utc_msc,
        range_end_utc_msc,
        cursor_time_msc,
        cursor_ticket,
        window_msc,
        state,
        attempt_count,
        next_attempt_at_utc_msc,
        last_error_code,
        lease_generation,
        lease_expires_at_utc_msc,
        created_at_utc_msc,
        updated_at_utc_msc,
    };
    validate_history_sync_job_record(&job)?;
    Ok(job)
}

fn validate_history_sync_job_record(job: &HistorySyncJob) -> Result<(), StoreError> {
    validate_history_job_id(&job.job_id)?;
    validate_history_scope_values(&job.scope)?;
    validate_history_job_kind(&job.job_kind)?;
    validate_history_priority(&job.priority)?;
    validate_history_range(job.range_start_utc_msc, job.range_end_utc_msc)?;
    validate_job_cursor(job.cursor_time_msc, &job.cursor_ticket)?;
    validate_history_state(&job.state)?;
    if job.cursor_time_msc < job.range_start_utc_msc
        || job.cursor_time_msc > job.range_end_utc_msc
        || job.cursor_time_msc == job.range_end_utc_msc && !job.cursor_ticket.is_empty()
        || job.window_msc <= 0
        || !(0..=1_000_000).contains(&job.attempt_count)
        || job.next_attempt_at_utc_msc <= 0
        || job.lease_generation < 0
        || job.lease_expires_at_utc_msc.is_some_and(|value| value <= 0)
        || job.created_at_utc_msc <= 0
        || job.updated_at_utc_msc < job.created_at_utc_msc
    {
        return Err(StoreError::new("bridge_store_history_job_invalid"));
    }
    if let Some(error_code) = job.last_error_code.as_deref() {
        validate_history_error_code(error_code)?;
    }
    if job.state == "running" && job.lease_expires_at_utc_msc.is_none() {
        return Err(StoreError::new("bridge_store_history_job_invalid"));
    }
    Ok(())
}

fn read_claimable_history_job(
    connection: &Connection,
    scope: &HistoryScope,
    now_utc_msc: i64,
    allowed_job_kinds: Option<&[String]>,
) -> Result<Option<HistorySyncJob>, StoreError> {
    let mut sql = format!(
        "{} FROM history_sync_jobs
         WHERE terminal_instance_id = ?1
           AND broker_server = ?2 COLLATE NOCASE
           AND login_account = ?3
           AND (
             (state IN ('queued', 'retrying') AND next_attempt_at_utc_msc <= ?4)
             OR (state = 'running' AND lease_expires_at_utc_msc <= ?4)
           )",
        history_sync_job_select()
    );
    let mut values = vec![
        SqlValue::Text(scope.terminal_instance_id.clone()),
        SqlValue::Text(scope.broker_server.clone()),
        SqlValue::Text(scope.login_account.clone()),
        SqlValue::Integer(now_utc_msc),
    ];
    if let Some(allowed_job_kinds) = allowed_job_kinds {
        sql.push_str(" AND job_kind IN (");
        for (index, job_kind) in allowed_job_kinds.iter().enumerate() {
            if index > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&format!("?{}", index + 5));
            values.push(SqlValue::Text(job_kind.clone()));
        }
        sql.push(')');
    }
    sql.push_str(
        " ORDER BY CASE priority WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
                  created_at_utc_msc, job_id LIMIT 1;",
    );
    let row = connection
        .query_row(
            &sql,
            params_from_iter(values),
            history_sync_job_row_from_sql,
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_job_query_failed"))?;
    row.map(history_sync_job_from_row).transpose()
}

fn read_history_coverage_ranges_locked(
    connection: &Connection,
    scope: &HistoryScope,
) -> Result<Vec<HistoryCoverageRange>, StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT range_start_utc_msc, range_end_utc_msc,
                    observed_at_utc_msc, updated_at_utc_msc
             FROM history_coverage_ranges
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3
             ORDER BY range_start_utc_msc, range_end_utc_msc;",
        )
        .map_err(|_| StoreError::new("bridge_store_history_coverage_query_failed"))?;
    let rows = statement
        .query_map(
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account
            ],
            |row| {
                Ok(HistoryCoverageRange {
                    scope: scope.clone(),
                    range_start_utc_msc: row.get(0)?,
                    range_end_utc_msc: row.get(1)?,
                    observed_at_utc_msc: row.get(2)?,
                    updated_at_utc_msc: row.get(3)?,
                })
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_coverage_query_failed"))?;
    let mut ranges = Vec::new();
    for row in rows {
        let range =
            row.map_err(|_| StoreError::new("bridge_store_history_coverage_query_failed"))?;
        validate_history_coverage_range(&range)?;
        ranges.push(range);
    }
    Ok(ranges)
}

fn validate_history_coverage_range(range: &HistoryCoverageRange) -> Result<(), StoreError> {
    validate_history_scope_values(&range.scope)?;
    validate_history_range(range.range_start_utc_msc, range.range_end_utc_msc)?;
    if range.observed_at_utc_msc <= 0
        || range.updated_at_utc_msc <= 0
        || range.updated_at_utc_msc < range.observed_at_utc_msc
    {
        return Err(StoreError::new("bridge_store_history_coverage_invalid"));
    }
    Ok(())
}

fn history_ranges_cover(
    ranges: &[HistoryCoverageRange],
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
) -> bool {
    let mut covered_until = range_start_utc_msc;
    for range in ranges {
        if range.range_end_utc_msc <= covered_until {
            continue;
        }
        if range.range_start_utc_msc > covered_until {
            return false;
        }
        covered_until = covered_until.max(range.range_end_utc_msc);
        if covered_until >= range_end_utc_msc {
            return true;
        }
    }
    covered_until >= range_end_utc_msc
}

fn history_ranges_covering_bounds(
    ranges: &[HistoryCoverageRange],
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
) -> Option<(i64, i64)> {
    let mut covered_until = range_start_utc_msc;
    let mut covered_start = None;
    for range in ranges {
        if range.range_end_utc_msc <= covered_until {
            continue;
        }
        if range.range_start_utc_msc > covered_until {
            return None;
        }
        covered_start = Some(
            covered_start.map_or(range.range_start_utc_msc, |start: i64| {
                start.min(range.range_start_utc_msc)
            }),
        );
        covered_until = covered_until.max(range.range_end_utc_msc);
        if covered_until >= range_end_utc_msc {
            return covered_start.map(|start| (start, covered_until));
        }
    }
    None
}

fn merge_history_coverage_range_tx(
    transaction: &Transaction<'_>,
    scope: &HistoryScope,
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
    observed_at_utc_msc: i64,
    updated_at_utc_msc: i64,
) -> Result<(), StoreError> {
    validate_history_scope_values(scope)?;
    validate_history_range(range_start_utc_msc, range_end_utc_msc)?;
    if observed_at_utc_msc <= 0 || updated_at_utc_msc < observed_at_utc_msc {
        return Err(StoreError::new("bridge_store_history_coverage_invalid"));
    }
    let mut merged_start = range_start_utc_msc;
    let mut merged_end = range_end_utc_msc;
    loop {
        let mut statement = transaction
            .prepare(
                "SELECT range_start_utc_msc, range_end_utc_msc
                 FROM history_coverage_ranges
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3
                   AND range_end_utc_msc >= ?4
                   AND range_start_utc_msc <= ?5;",
            )
            .map_err(|_| StoreError::new("bridge_store_history_coverage_query_failed"))?;
        let rows = statement
            .query_map(
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account,
                    merged_start,
                    merged_end
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|_| StoreError::new("bridge_store_history_coverage_query_failed"))?;
        let mut changed = false;
        for row in rows {
            let (existing_start, existing_end) =
                row.map_err(|_| StoreError::new("bridge_store_history_coverage_query_failed"))?;
            let next_start = merged_start.min(existing_start);
            let next_end = merged_end.max(existing_end);
            changed |= next_start != merged_start || next_end != merged_end;
            merged_start = next_start;
            merged_end = next_end;
        }
        drop(statement);
        if !changed {
            break;
        }
    }
    transaction
        .execute(
            "DELETE FROM history_coverage_ranges
             WHERE terminal_instance_id = ?1
               AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3
               AND range_end_utc_msc >= ?4
               AND range_start_utc_msc <= ?5;",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                merged_start,
                merged_end
            ],
        )
        .map_err(|_| StoreError::new("bridge_store_history_coverage_write_failed"))?;
    transaction
        .execute(
            "INSERT INTO history_coverage_ranges (
               terminal_instance_id, broker_server, login_account,
               range_start_utc_msc, range_end_utc_msc,
               observed_at_utc_msc, updated_at_utc_msc
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                merged_start,
                merged_end,
                observed_at_utc_msc,
                updated_at_utc_msc
            ],
        )
        .map_err(|_| StoreError::new("bridge_store_history_coverage_write_failed"))?;
    Ok(())
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

#[derive(Clone)]
struct HistoryPageRequest {
    page: i64,
    page_size: i64,
    include_deals: bool,
    evidence_position_ids: Vec<String>,
    evidence_order_tickets: Vec<String>,
    requested_range: Option<HistoryRequestedRange>,
    filter_sql: String,
    filter_values: Vec<SqlValue>,
    direction: Option<String>,
    profit_filter: Option<String>,
    capital_filter_sql: String,
    capital_filter_values: Vec<SqlValue>,
}

fn parse_history_cursor_page_request(
    parameters: &serde_json::Value,
    now_utc_msc: i64,
) -> Result<HistoryCursorPageRequest, StoreError> {
    if now_utc_msc <= 0 {
        return Err(StoreError::new("history_range_now_invalid"));
    }
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_cursor_params_invalid"))?;
    const ALLOWED: &[&str] = &[
        "range_start_utc_msc",
        "range_end_utc_msc",
        "allowed_start_utc_msc",
        "system_start_utc_msc",
        "effective_start_utc_msc",
        "captured_end_utc_msc",
        "page_size",
        "entry_from",
        "entry_to",
        "filter_close_from",
        "filter_close_to",
        "direction",
        "profit_filter",
        "force_refresh",
        "snapshot_id",
        "cursor",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(StoreError::new("history_cursor_params_invalid"));
    }
    if object
        .get("force_refresh")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(StoreError::new("history_cursor_params_invalid"));
    }
    if !object.contains_key("range_start_utc_msc") || !object.contains_key("range_end_utc_msc") {
        return Err(StoreError::new("history_cursor_range_invalid"));
    }
    let requested_range = parse_history_requested_range(parameters, now_utc_msc)?
        .ok_or_else(|| StoreError::new("history_cursor_range_invalid"))?;
    let page_size = history_integer(object.get("page_size"), 20, 1, MAX_HISTORY_CURSOR_PAGE_SIZE)?;
    let entry_from_utc_msc = object
        .get("entry_from")
        .map(|value| parse_history_filter_bound(value, false))
        .transpose()?;
    let entry_to_utc_msc = object
        .get("entry_to")
        .map(|value| parse_history_filter_bound(value, true))
        .transpose()?;
    let close_from_utc_msc = object
        .get("filter_close_from")
        .map(|value| parse_history_filter_bound(value, false))
        .transpose()?;
    let close_to_utc_msc = object
        .get("filter_close_to")
        .map(|value| parse_history_filter_bound(value, true))
        .transpose()?;
    if entry_from_utc_msc.is_some_and(|start| entry_to_utc_msc.is_some_and(|end| start > end)) {
        return Err(StoreError::new("history_range_invalid"));
    }
    if close_from_utc_msc.is_some_and(|start| close_to_utc_msc.is_some_and(|end| start > end)) {
        return Err(StoreError::new("history_range_invalid"));
    }
    let direction = object
        .get("direction")
        .map(|value| {
            value
                .as_str()
                .filter(|value| matches!(*value, "BUY" | "SELL"))
                .map(str::to_owned)
                .ok_or_else(|| StoreError::new("history_direction_invalid"))
        })
        .transpose()?;
    let profit_filter = object
        .get("profit_filter")
        .map(|value| {
            value
                .as_str()
                .filter(|value| matches!(*value, "profit" | "loss" | "flat"))
                .map(str::to_owned)
                .ok_or_else(|| StoreError::new("history_profit_filter_invalid"))
        })
        .transpose()?;
    let snapshot_id = object
        .get("snapshot_id")
        .map(parse_history_token)
        .transpose()?;
    let cursor = object.get("cursor").map(parse_history_token).transpose()?;
    if cursor.is_some() && snapshot_id.is_none() {
        return Err(StoreError::new("history_cursor_invalid"));
    }

    let mut filter_sql = String::new();
    let mut filter_values = Vec::new();
    if let Some(entry_from) = entry_from_utc_msc {
        filter_sql.push_str(
            " AND CAST(json_extract(payload_json, '$.entry_time_utc_msc') AS INTEGER) >= ?",
        );
        filter_values.push(SqlValue::Integer(entry_from));
    }
    if let Some(entry_to) = entry_to_utc_msc {
        filter_sql.push_str(
            " AND CAST(json_extract(payload_json, '$.entry_time_utc_msc') AS INTEGER) <= ?",
        );
        filter_values.push(SqlValue::Integer(entry_to));
    }
    if let Some(close_from) = close_from_utc_msc {
        filter_sql.push_str(" AND close_time_utc_msc >= ?");
        filter_values.push(SqlValue::Integer(close_from));
    }
    if let Some(close_to) = close_to_utc_msc {
        filter_sql.push_str(" AND close_time_utc_msc <= ?");
        filter_values.push(SqlValue::Integer(close_to));
    }
    if let Some(direction) = direction.as_deref() {
        filter_sql.push_str(" AND direction = ?");
        filter_values.push(SqlValue::Text(direction.to_owned()));
    }
    if let Some(profit_filter) = profit_filter.as_deref() {
        filter_sql.push_str(match profit_filter {
            "profit" => " AND net_profit > 0",
            "loss" => " AND net_profit < 0",
            "flat" => " AND net_profit = 0",
            _ => unreachable!("profit filter validated above"),
        });
    }
    let query = HistoryCursorQuery {
        range_start_utc_msc: requested_range.range_start_utc_msc,
        range_end_utc_msc: requested_range.range_end_utc_msc,
        page_size,
        entry_from_utc_msc,
        entry_to_utc_msc,
        close_from_utc_msc,
        close_to_utc_msc,
        direction,
        profit_filter,
    };
    Ok(HistoryCursorPageRequest {
        query,
        requested_range,
        snapshot_id,
        cursor,
        filter_sql,
        filter_values,
        capital_filter_sql: String::new(),
        capital_filter_values: Vec::new(),
    })
}

fn parse_history_token(value: &serde_json::Value) -> Result<String, StoreError> {
    let token = value
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| StoreError::new("history_cursor_invalid"))?;
    if token
        .bytes()
        .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
    {
        return Err(StoreError::new("history_cursor_invalid"));
    }
    Ok(token.to_owned())
}

fn validate_history_snapshot_request(
    terminal: &TerminalDescriptor,
    request: &HistoryCursorPageRequest,
    snapshot: &HistorySnapshotState,
) -> Result<(), StoreError> {
    let same_scope = snapshot.terminal_instance_id == terminal.terminal_instance_id
        && snapshot.login_account == terminal.account_ref.login
        && snapshot
            .broker_server
            .eq_ignore_ascii_case(&terminal.account_ref.broker_server)
        && snapshot.platform == terminal.platform;
    if !same_scope {
        return Err(StoreError::new("history_snapshot_invalid"));
    }
    if snapshot.history_sync["history_revision"].as_i64() != Some(snapshot.history_revision)
        || snapshot.history_sync["summary_revision"].as_i64() != Some(snapshot.summary_revision)
    {
        return Err(StoreError::new("history_snapshot_invalid"));
    }
    if snapshot.query != request.query {
        return Err(StoreError::new("history_cursor_invalid"));
    }
    Ok(())
}

fn cleanup_history_snapshots(
    snapshots: &mut HashMap<String, HistorySnapshotState>,
    now_utc_msc: i64,
) {
    snapshots.retain(|_, snapshot| snapshot.expires_at_utc_msc > now_utc_msc);
}

fn random_history_token(prefix: &str) -> Result<String, StoreError> {
    let mut bytes = [0_u8; HISTORY_CURSOR_TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| StoreError::new("history_cursor_random_failed"))?;
    let mut token = String::with_capacity(prefix.len() + bytes.len() * 2);
    token.push_str(prefix);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}")
            .map_err(|_| StoreError::new("history_cursor_random_failed"))?;
    }
    Ok(token)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryEvidenceRequest {
    pub requested_range: HistoryRequestedRange,
    pub evidence_position_ids: Vec<String>,
    pub evidence_order_tickets: Vec<String>,
}

/// Parse the deliberately narrow request accepted by `history_evidence`.
///
/// Evidence is never an unbounded history query: callers must provide one
/// exact half-open UTC range and at least one positive position/order
/// reference.  Calendar, paging, filter, refresh, and unknown fields are
/// rejected so a future caller cannot silently turn this path back into a
/// history scan.
pub fn parse_history_evidence_request(
    parameters: &serde_json::Value,
    now_utc_msc: i64,
) -> Result<HistoryEvidenceRequest, StoreError> {
    if now_utc_msc <= 0 {
        return Err(StoreError::new("history_range_now_invalid"));
    }
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_evidence_params_invalid"))?;
    const ALLOWED: &[&str] = &[
        "range_start_utc_msc",
        "range_end_utc_msc",
        "allowed_start_utc_msc",
        "system_start_utc_msc",
        "effective_start_utc_msc",
        "captured_end_utc_msc",
        "evidence_position_ids",
        "evidence_order_tickets",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(StoreError::new("history_evidence_params_invalid"));
    }
    let range_start_utc_msc = object
        .get("range_start_utc_msc")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| StoreError::new("history_evidence_range_invalid"))?;
    let range_end_utc_msc = object
        .get("range_end_utc_msc")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| StoreError::new("history_evidence_range_invalid"))?;
    let max_endpoint = now_utc_msc
        .checked_add(60_000)
        .ok_or_else(|| StoreError::new("history_evidence_range_invalid"))?;
    if (range_start_utc_msc < HISTORY_COVERAGE_START_UTC_MSC
        && now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC)
        || range_start_utc_msc >= range_end_utc_msc
        || range_end_utc_msc > max_endpoint
    {
        return Err(StoreError::new("history_evidence_range_invalid"));
    }
    let raw_position_count = object
        .get("evidence_position_ids")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let raw_order_count = object
        .get("evidence_order_tickets")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    if raw_position_count + raw_order_count > MAX_HISTORY_EVIDENCE_REFS {
        return Err(StoreError::new("history_evidence_refs_invalid"));
    }
    let evidence_position_ids = history_reference_list(object.get("evidence_position_ids"))?;
    let evidence_order_tickets = history_reference_list(object.get("evidence_order_tickets"))?;
    if evidence_position_ids.is_empty() && evidence_order_tickets.is_empty()
        || evidence_position_ids.len() + evidence_order_tickets.len() > MAX_HISTORY_EVIDENCE_REFS
    {
        return Err(StoreError::new("history_evidence_refs_invalid"));
    }
    Ok(HistoryEvidenceRequest {
        requested_range: HistoryRequestedRange {
            range_start_utc_msc,
            range_end_utc_msc,
        },
        evidence_position_ids,
        evidence_order_tickets,
    })
}

/// Parse the explicit history range used for coverage decisions.
///
/// `date_from` is the inclusive start date at midnight UTC.  The returned
/// interval is half-open: the end is either the explicit millisecond endpoint
/// or the earlier of the explicit `date_to` next-day boundary and `now`.  A
/// missing `date_from` intentionally returns `None`; an unbounded history
/// request must never be reported as a covered range.
pub fn parse_history_requested_range(
    parameters: &serde_json::Value,
    now_utc_msc: i64,
) -> Result<Option<HistoryRequestedRange>, StoreError> {
    if now_utc_msc <= 0 {
        return Err(StoreError::new("history_range_now_invalid"));
    }
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_params_invalid"))?;
    let has_exact_start = object.contains_key("range_start_utc_msc");
    let has_exact_end = object.contains_key("range_end_utc_msc");
    let has_date_bounds = object.contains_key("date_from") || object.contains_key("date_to");

    // A millisecond request is a separate mode.  It is deliberately strict:
    // accepting a lone endpoint or mixing it with calendar dates would make
    // the returned coverage metadata ambiguous.
    if has_exact_start {
        if !has_exact_end || has_date_bounds {
            return Err(StoreError::new("history_range_invalid"));
        }
        let range_start_utc_msc = object
            .get("range_start_utc_msc")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value > 0)
            .ok_or_else(|| StoreError::new("history_range_start_invalid"))?;
        let range_end_utc_msc = object
            .get("range_end_utc_msc")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value > 0)
            .ok_or_else(|| StoreError::new("history_range_end_invalid"))?;
        let max_endpoint = now_utc_msc
            .checked_add(60_000)
            .ok_or_else(|| StoreError::new("history_range_end_invalid"))?;
        if (range_start_utc_msc < HISTORY_COVERAGE_START_UTC_MSC
            && now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC)
            || range_end_utc_msc > max_endpoint
            || range_start_utc_msc >= range_end_utc_msc
        {
            return Err(StoreError::new("history_range_invalid"));
        }
        return Ok(Some(HistoryRequestedRange {
            range_start_utc_msc,
            range_end_utc_msc,
        }));
    }

    let date_to_end_utc_msc = object
        .get("date_to")
        .map(|value| {
            let date_to = value
                .as_str()
                .ok_or_else(|| StoreError::new("history_date_invalid"))?;
            let date_to_start = parse_utc_date_msc(date_to)?;
            date_to_start
                .checked_add(86_400_000)
                .ok_or_else(|| StoreError::new("history_date_invalid"))
        })
        .transpose()?;
    let explicit_range_end_utc_msc = if let Some(value) = object.get("range_end_utc_msc") {
        let endpoint = value
            .as_i64()
            .filter(|endpoint| *endpoint > 0)
            .ok_or_else(|| StoreError::new("history_range_end_invalid"))?;
        let max_endpoint = now_utc_msc
            .checked_add(60_000)
            .ok_or_else(|| StoreError::new("history_range_end_invalid"))?;
        if endpoint > max_endpoint
            || date_to_end_utc_msc.is_some_and(|date_to_end| endpoint > date_to_end)
        {
            return Err(StoreError::new("history_range_end_invalid"));
        }
        Some(endpoint)
    } else {
        None
    };
    let Some(date_from) = object.get("date_from") else {
        if explicit_range_end_utc_msc.is_some() {
            return Err(StoreError::new("history_range_invalid"));
        }
        // Keep this fail-closed even when the caller supplies only date_to or
        // an endpoint: there is no explicit lower bound to prove complete.
        return Ok(None);
    };
    let date_from = date_from
        .as_str()
        .ok_or_else(|| StoreError::new("history_date_invalid"))?;
    let range_start_utc_msc = parse_utc_date_msc(date_from)?;
    let range_end_utc_msc = explicit_range_end_utc_msc.unwrap_or_else(|| {
        date_to_end_utc_msc.map_or(now_utc_msc, |date_to_end| date_to_end.min(now_utc_msc))
    });
    if (range_start_utc_msc < HISTORY_COVERAGE_START_UTC_MSC
        && now_utc_msc >= HISTORY_COVERAGE_START_UTC_MSC)
        || range_end_utc_msc <= range_start_utc_msc
    {
        return Err(StoreError::new("history_range_invalid"));
    }
    Ok(Some(HistoryRequestedRange {
        range_start_utc_msc,
        range_end_utc_msc,
    }))
}

fn parse_history_chart_request(
    parameters: &serde_json::Value,
    now_utc_msc: i64,
) -> Result<HistoryPageRequest, StoreError> {
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_params_invalid"))?;
    const ALLOWED: &[&str] = &[
        "date_from",
        "date_to",
        "range_start_utc_msc",
        "range_end_utc_msc",
        "allowed_start_utc_msc",
        "system_start_utc_msc",
        "effective_start_utc_msc",
        "captured_end_utc_msc",
        "direction",
        "profit_filter",
        "force_refresh",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(StoreError::new("history_params_invalid"));
    }
    parse_history_page_request(parameters, now_utc_msc)
}

fn parse_history_page_request(
    parameters: &serde_json::Value,
    now_utc_msc: i64,
) -> Result<HistoryPageRequest, StoreError> {
    let object = parameters
        .as_object()
        .ok_or_else(|| StoreError::new("history_params_invalid"))?;
    const ALLOWED: &[&str] = &[
        "page",
        "page_size",
        "date_from",
        "date_to",
        "range_start_utc_msc",
        "allowed_start_utc_msc",
        "system_start_utc_msc",
        "effective_start_utc_msc",
        "captured_end_utc_msc",
        "entry_from",
        "entry_to",
        "filter_close_from",
        "filter_close_to",
        "direction",
        "profit_filter",
        "force_refresh",
        "range_end_utc_msc",
        "include_deals",
        "compact",
        "evidence_position_ids",
        "evidence_order_tickets",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str()))
        || ["force_refresh", "include_deals", "compact"]
            .iter()
            .any(|key| object.get(*key).is_some_and(|value| !value.is_boolean()))
    {
        return Err(StoreError::new("history_params_invalid"));
    }
    let page = history_integer(object.get("page"), 1, 1, MAX_LEGACY_HISTORY_PAGE)?;
    let page_size = history_integer(object.get("page_size"), 20, 1, 200)?;
    let requested_range = parse_history_requested_range(parameters, now_utc_msc)?;
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    let mut capital_clauses = Vec::new();
    let mut capital_values = Vec::new();
    let mut direction = None;
    let mut profit_filter = None;
    for (key, comparison, end_of_day) in [
        ("date_from", ">=", false),
        ("entry_from", ">=", false),
        ("date_to", "<=", true),
        ("entry_to", "<=", true),
    ] {
        if let Some(value) = object.get(key) {
            let timestamp = parse_history_filter_bound(value, end_of_day)?;
            let trade_expression = if key.starts_with("entry_") {
                "CAST(json_extract(payload_json, '$.entry_time_utc_msc') AS INTEGER)"
            } else {
                "close_time_utc_msc"
            };
            clauses.push(format!(" AND {trade_expression} {comparison} ?"));
            values.push(SqlValue::Integer(timestamp));
            if matches!(key, "date_from" | "date_to") {
                capital_clauses.push(format!(" AND event_time_msc {comparison} ?"));
                capital_values.push(SqlValue::Integer(timestamp));
            }
        }
    }
    for (key, comparison, end_of_day) in [
        ("filter_close_from", ">=", false),
        ("filter_close_to", "<=", true),
    ] {
        if let Some(value) = object.get(key) {
            let timestamp = parse_history_filter_bound(value, end_of_day)?;
            clauses.push(format!(" AND close_time_utc_msc {comparison} ?"));
            values.push(SqlValue::Integer(timestamp));
        }
    }
    if object.contains_key("range_start_utc_msc") {
        let range = requested_range
            .as_ref()
            .ok_or_else(|| StoreError::new("history_range_invalid"))?;
        clauses.push(" AND close_time_utc_msc >= ?".to_owned());
        values.push(SqlValue::Integer(range.range_start_utc_msc));
        clauses.push(" AND close_time_utc_msc < ?".to_owned());
        values.push(SqlValue::Integer(range.range_end_utc_msc));
        capital_clauses.push(" AND event_time_msc >= ?".to_owned());
        capital_values.push(SqlValue::Integer(range.range_start_utc_msc));
        capital_clauses.push(" AND event_time_msc < ?".to_owned());
        capital_values.push(SqlValue::Integer(range.range_end_utc_msc));
    } else if object.contains_key("range_end_utc_msc") {
        // Legacy calendar mode may pin its upper endpoint while retaining
        // date_from/date_to semantics.  Keep that endpoint as a half-open SQL
        // bound, while exact mode above remains the only path that accepts a
        // millisecond start.
        let range_end = requested_range
            .as_ref()
            .map(|range| range.range_end_utc_msc)
            .ok_or_else(|| StoreError::new("history_range_invalid"))?;
        clauses.push(" AND close_time_utc_msc < ?".to_owned());
        values.push(SqlValue::Integer(range_end));
        capital_clauses.push(" AND event_time_msc < ?".to_owned());
        capital_values.push(SqlValue::Integer(range_end));
    }
    if let Some(value) = object.get("direction") {
        let parsed_direction = value
            .as_str()
            .filter(|value| matches!(*value, "BUY" | "SELL"))
            .ok_or_else(|| StoreError::new("history_direction_invalid"))?;
        clauses.push(" AND direction = ?".to_owned());
        values.push(SqlValue::Text(parsed_direction.to_owned()));
        direction = Some(parsed_direction.to_owned());
    }
    if let Some(value) = object.get("profit_filter") {
        match value.as_str() {
            Some("profit") => clauses.push(" AND net_profit > 0".to_owned()),
            Some("loss") => clauses.push(" AND net_profit < 0".to_owned()),
            Some("flat") => clauses.push(" AND net_profit = 0".to_owned()),
            _ => return Err(StoreError::new("history_profit_filter_invalid")),
        };
        profit_filter = value.as_str().map(str::to_owned);
    }
    let evidence_position_ids = history_reference_list(object.get("evidence_position_ids"))?;
    let evidence_order_tickets = history_reference_list(object.get("evidence_order_tickets"))?;
    if evidence_position_ids.len() + evidence_order_tickets.len() > MAX_HISTORY_EVIDENCE_REFS {
        return Err(StoreError::new("history_params_invalid"));
    }
    Ok(HistoryPageRequest {
        page,
        page_size,
        include_deals: object
            .get("include_deals")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        evidence_position_ids,
        evidence_order_tickets,
        requested_range,
        filter_sql: clauses.concat(),
        filter_values: values,
        direction,
        profit_filter,
        capital_filter_sql: capital_clauses.concat(),
        capital_filter_values: capital_values,
    })
}

fn history_reference_list(value: Option<&serde_json::Value>) -> Result<Vec<String>, StoreError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .filter(|values| values.len() <= MAX_HISTORY_EVIDENCE_REFS)
        .ok_or_else(|| StoreError::new("history_params_invalid"))?;
    let mut references = values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|number| number.to_string()))
                .filter(|reference| {
                    !reference.is_empty()
                        && reference.len() <= 32
                        && reference.bytes().all(|byte| byte.is_ascii_digit())
                        && reference.bytes().any(|byte| byte != b'0')
                })
                .ok_or_else(|| StoreError::new("history_params_invalid"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    references.sort();
    references.dedup();
    Ok(references)
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

fn parse_history_filter_bound(
    value: &serde_json::Value,
    end_of_day: bool,
) -> Result<i64, StoreError> {
    let timestamp = if let Some(number) = value.as_i64() {
        number
    } else if let Some(number) = value.as_u64() {
        i64::try_from(number).map_err(|_| StoreError::new("history_date_invalid"))?
    } else if let Some(text) = value.as_str() {
        if let Ok(number) = text.trim().parse::<i64>() {
            number
        } else {
            let date = parse_utc_date_msc(text.trim())?;
            if end_of_day {
                date.checked_add(HISTORY_DAY_MSC - 1)
                    .ok_or_else(|| StoreError::new("history_date_invalid"))?
            } else {
                date
            }
        }
    } else {
        return Err(StoreError::new("history_date_invalid"));
    };
    if timestamp < HISTORY_COVERAGE_START_UTC_MSC {
        return Err(StoreError::new("history_date_invalid"));
    }
    Ok(timestamp)
}

fn current_utc_msc() -> Result<i64, StoreError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::new("history_range_now_invalid"))?;
    i64::try_from(duration.as_millis()).map_err(|_| StoreError::new("history_range_now_invalid"))
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
    let scope = HistoryScope {
        terminal_instance_id: terminal.terminal_instance_id.clone(),
        broker_server: terminal.account_ref.broker_server.clone(),
        login_account: terminal.account_ref.login.clone(),
    };
    let summary_v2_generation =
        history_summary_v2_ready_generation(connection, &scope, &terminal.platform)?;
    let summary_generation =
        history_summary_ready_generation(connection, &scope, &terminal.platform)?;
    let Some(summary_generation) = summary_generation else {
        return Ok(serde_json::Value::Null);
    };
    // A materialized summary can answer unfiltered totals, but table filters
    // (including close-time and entry-time predicates) must be evaluated on
    // the archive rows before aggregation so the counts cannot drift from the
    // page query.
    if request.filter_sql.is_empty() {
        if let Some(summary_v2_generation) = summary_v2_generation {
            return read_history_statistics_from_summary_v2(
                connection,
                terminal,
                request,
                summary_v2_generation,
                total,
            );
        }
        return read_history_statistics_from_summary(
            connection,
            terminal,
            request,
            summary_generation,
            total,
        );
    }
    let (total_profit, total_volume) = connection
        .query_row(
            &format!(
                "SELECT \
                   COALESCE(SUM(COALESCE(net_profit, 0)), 0), \
                   COALESCE(SUM(COALESCE(volume, 0)), 0) \
                 FROM history_archive_items WHERE terminal_instance_id = ? \
                   AND broker_server = ? COLLATE NOCASE AND login_account = ? \
                   AND platform = ? AND item_kind = 'trade'
                   AND close_time_utc_msc >= 946684800000
                   AND close_time_utc_msc IS NOT NULL
                   AND immutable_state = 'sealed'{};",
                request.filter_sql
            ),
            params_from_iter(filtered_values),
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?)),
        )
        .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))?;
    let mut capital_values = history_scope_values(terminal);
    capital_values.push(SqlValue::Text(terminal.platform.clone()));
    capital_values.extend(request.capital_filter_values.iter().cloned());
    let (deposit, withdrawal, credit) = connection
        .query_row(
                &format!(
                "SELECT \
                   COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0) \
                 FROM history_archive_items WHERE terminal_instance_id = ? \
                   AND broker_server = ? COLLATE NOCASE AND login_account = ? \
                   AND platform = ? AND item_kind = 'deal'{};",
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
    let time_semantics = if request.requested_range.is_some() {
        "exact_close_utc"
    } else {
        "server_business_date"
    };
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
        "summary_source": "sqlite_archive_raw_close_time",
        "time_semantics": time_semantics,
    }))
}

fn history_summary_ready_generation(
    connection: &Connection,
    scope: &HistoryScope,
    platform: &str,
) -> Result<Option<i64>, StoreError> {
    let state = read_history_scope_state_locked(connection, scope, platform)?;
    if state.summary_status != "ready" || state.summary_revision != state.history_revision {
        return Ok(None);
    }
    read_history_summary_build_locked(connection, scope, platform)
        .map(|build| build.and_then(|value| value.active_generation))
}

/// Return the active summary generation only when the v2 materialization is
/// present for this scope.  The v1 build marker predates the business-date
/// table, so it is not sufficient evidence that v2 is ready (notably on an
/// additive migration of an older database).  Callers must explicitly mark a
/// v1 fallback instead of silently mixing the two time semantics.
fn history_summary_v2_ready_generation(
    connection: &Connection,
    scope: &HistoryScope,
    platform: &str,
) -> Result<Option<i64>, StoreError> {
    let Some(generation) = history_summary_ready_generation(connection, scope, platform)? else {
        return Ok(None);
    };
    if !table_exists(connection, "history_daily_summary_v2")? {
        return Ok(None);
    }
    let has_rows = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM history_daily_summary_v2
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND generation = ?5
            );",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                generation
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_v2_query_failed"))?;
    if has_rows == 1 {
        return Ok(Some(generation));
    }
    // An empty account can legitimately have no v2 rows.  Treat that as a
    // ready empty generation only when there are no eligible sealed trades or
    // capital events that the missing rows would hide; otherwise fall back to
    // v1 explicitly rather than returning fabricated v2 zeros.
    let has_eligible_archive = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4
                   AND ((item_kind = 'trade' AND immutable_state = 'sealed'
                         AND close_time_utc_msc >= ?5)
                        OR (item_kind = 'deal' AND event_time_msc >= ?5
                            AND capital_kind IS NOT NULL))
            );",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account,
                platform,
                HISTORY_COVERAGE_START_UTC_MSC,
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| StoreError::new("bridge_store_history_summary_v2_query_failed"))?;
    Ok((has_eligible_archive == 0).then_some(generation))
}

fn history_summary_source(
    connection: &Connection,
    scope: &HistoryScope,
    platform: &str,
) -> Result<(&'static str, &'static str), StoreError> {
    if history_summary_v2_ready_generation(connection, scope, platform)?.is_some() {
        Ok(("sqlite_summary_v2", "server_business_date"))
    } else if history_summary_ready_generation(connection, scope, platform)?.is_some() {
        Ok(("sqlite_summary_v1", "legacy_utc_day"))
    } else {
        Ok(("unavailable", "unavailable"))
    }
}

fn query_history_raw_statistics_segment(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    start: Option<i64>,
    end: Option<i64>,
    direction: Option<&str>,
    profit_filter: Option<&str>,
) -> Result<(i64, f64, f64), StoreError> {
    let mut predicates = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND item_kind = 'trade'
          AND immutable_state = 'sealed'",
    );
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
    ];
    let mut index = 5;
    if let Some(start) = start {
        predicates.push_str(&format!(" AND close_time_utc_msc >= ?{index}"));
        values.push(SqlValue::Integer(start));
        index += 1;
    }
    if let Some(end) = end {
        predicates.push_str(&format!(" AND close_time_utc_msc < ?{index}"));
        values.push(SqlValue::Integer(end));
        index += 1;
    }
    if let Some(direction) = direction {
        predicates.push_str(&format!(" AND direction = ?{index}"));
        values.push(SqlValue::Text(direction.to_owned()));
        index += 1;
    }
    if let Some(profit_filter) = profit_filter {
        predicates.push_str(match profit_filter {
            "profit" => " AND net_profit > 0",
            "loss" => " AND net_profit < 0",
            "flat" => " AND net_profit = 0",
            _ => "",
        });
    }
    let query = format!(
        "SELECT COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                COALESCE(SUM(COALESCE(volume, 0)), 0)
         FROM history_archive_items{predicates};"
    );
    let _ = index;
    connection
        .query_row(&query, params_from_iter(values), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))
}

fn query_history_raw_capital_segment(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    start: Option<i64>,
    end: Option<i64>,
) -> Result<(f64, f64, f64), StoreError> {
    let mut predicates = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND item_kind = 'deal'",
    );
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
    ];
    let mut index = 5;
    if let Some(start) = start {
        predicates.push_str(&format!(" AND event_time_msc >= ?{index}"));
        values.push(SqlValue::Integer(start));
        index += 1;
    }
    if let Some(end) = end {
        predicates.push_str(&format!(" AND event_time_msc < ?{index}"));
        values.push(SqlValue::Integer(end));
    }
    let query = format!(
        "SELECT COALESCE(SUM(CASE WHEN capital_kind = 'deposit' THEN capital_amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN capital_kind = 'withdrawal' THEN capital_amount ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN capital_kind = 'credit' THEN capital_amount ELSE 0 END), 0)
         FROM history_archive_items{predicates};"
    );
    connection
        .query_row(&query, params_from_iter(values), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))
}

#[derive(Clone, Copy, Debug, Default)]
struct HistoryTradeAggregate {
    trade_count: i64,
    gross_profit: f64,
    gross_loss: f64,
    win_count: i64,
    loss_count: i64,
    total_profit: f64,
}

impl HistoryTradeAggregate {
    fn add(&mut self, other: Self) {
        self.trade_count = self.trade_count.saturating_add(other.trade_count);
        self.gross_profit += other.gross_profit;
        self.gross_loss += other.gross_loss;
        self.win_count = self.win_count.saturating_add(other.win_count);
        self.loss_count = self.loss_count.saturating_add(other.loss_count);
        self.total_profit += other.total_profit;
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct HistoryDailyTrade {
    profit: f64,
    trade_count: i64,
    wins: i64,
    losses: i64,
}

impl HistoryDailyTrade {
    fn add(&mut self, other: Self) {
        self.profit += other.profit;
        self.trade_count = self.trade_count.saturating_add(other.trade_count);
        self.wins = self.wins.saturating_add(other.wins);
        self.losses = self.losses.saturating_add(other.losses);
    }
}

fn summary_trade_predicates(
    index: &mut usize,
    values: &mut Vec<SqlValue>,
    direction: Option<&str>,
    profit_filter: Option<&str>,
) -> String {
    let mut predicates = String::new();
    if let Some(direction) = direction {
        predicates.push_str(&format!(" AND direction = ?{index}"));
        values.push(SqlValue::Text(direction.to_owned()));
        *index += 1;
    }
    if let Some(profit_filter) = profit_filter {
        predicates.push_str(&format!(" AND profit_bucket = ?{index}"));
        values.push(SqlValue::Text(profit_filter.to_owned()));
        *index += 1;
    }
    predicates
}

fn read_history_summary_trade_rows(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    generation: i64,
    start: Option<i64>,
    end: Option<i64>,
    direction: Option<&str>,
    profit_filter: Option<&str>,
) -> Result<(BTreeMap<i64, HistoryDailyTrade>, HistoryTradeAggregate), StoreError> {
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
        SqlValue::Integer(generation),
    ];
    let mut index = 6;
    let mut predicates = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND generation = ?5
          AND item_kind = 'trade'",
    );
    if let Some(start) = start {
        predicates.push_str(&format!(" AND summary_day_utc_msc >= ?{index}"));
        values.push(SqlValue::Integer(start));
        index += 1;
    }
    if let Some(end) = end {
        predicates.push_str(&format!(" AND summary_day_utc_msc < ?{index}"));
        values.push(SqlValue::Integer(end));
        index += 1;
    }
    predicates.push_str(&summary_trade_predicates(
        &mut index,
        &mut values,
        direction,
        profit_filter,
    ));
    let query = format!(
        "SELECT summary_day_utc_msc, profit_bucket,
                COALESCE(trade_count, 0), COALESCE(net_profit, 0),
                COALESCE(volume, 0)
         FROM history_daily_summary{predicates}
         ORDER BY summary_day_utc_msc, direction, profit_bucket;"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
    let mut daily: BTreeMap<i64, HistoryDailyTrade> = BTreeMap::new();
    let mut aggregate = HistoryTradeAggregate::default();
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
    for row in rows {
        let (day, bucket, count, profit, _volume) =
            row.map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
        let day_entry = daily.entry(day).or_default();
        day_entry.profit += profit;
        day_entry.trade_count = day_entry.trade_count.saturating_add(count);
        match bucket.as_str() {
            "profit" => {
                day_entry.wins = day_entry.wins.saturating_add(count);
                aggregate.gross_profit += profit;
                aggregate.win_count = aggregate.win_count.saturating_add(count);
            }
            "loss" => {
                day_entry.losses = day_entry.losses.saturating_add(count);
                aggregate.gross_loss += -profit;
                aggregate.loss_count = aggregate.loss_count.saturating_add(count);
            }
            _ => {}
        }
        aggregate.trade_count = aggregate.trade_count.saturating_add(count);
        aggregate.total_profit += profit;
    }
    Ok((daily, aggregate))
}

fn read_history_summary_trade_rows_v2(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    generation: i64,
    direction: Option<&str>,
    profit_filter: Option<&str>,
) -> Result<(BTreeMap<i64, HistoryDailyTrade>, HistoryTradeAggregate), StoreError> {
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
        SqlValue::Integer(generation),
    ];
    let mut index = 6;
    let mut predicates = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND generation = ?5
          AND item_kind = 'trade'",
    );
    if let Some(direction) = direction {
        predicates.push_str(&format!(" AND direction = ?{index}"));
        values.push(SqlValue::Text(direction.to_owned()));
        index += 1;
    }
    if let Some(profit_filter) = profit_filter {
        predicates.push_str(&format!(" AND profit_bucket = ?{index}"));
        values.push(SqlValue::Text(profit_filter.to_owned()));
    }
    let query = format!(
        "SELECT business_date, profit_bucket,
                COALESCE(trade_count, 0), COALESCE(net_profit, 0),
                COALESCE(volume, 0)
         FROM history_daily_summary_v2{predicates}
         ORDER BY business_date, direction, profit_bucket;"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
    let mut daily: BTreeMap<i64, HistoryDailyTrade> = BTreeMap::new();
    let mut aggregate = HistoryTradeAggregate::default();
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
    for row in rows {
        let (business_date, bucket, count, profit, _volume) =
            row.map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
        let day = parse_utc_date_msc(&business_date)?;
        let day_entry = daily.entry(day).or_default();
        day_entry.profit += profit;
        day_entry.trade_count = day_entry.trade_count.saturating_add(count);
        match bucket.as_str() {
            "profit" => {
                day_entry.wins = day_entry.wins.saturating_add(count);
                aggregate.gross_profit += profit;
                aggregate.win_count = aggregate.win_count.saturating_add(count);
            }
            "loss" => {
                day_entry.losses = day_entry.losses.saturating_add(count);
                aggregate.gross_loss += -profit;
                aggregate.loss_count = aggregate.loss_count.saturating_add(count);
            }
            _ => {}
        }
        aggregate.trade_count = aggregate.trade_count.saturating_add(count);
        aggregate.total_profit += profit;
    }
    Ok((daily, aggregate))
}

fn read_history_raw_trade_rows(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    start: i64,
    end: i64,
    direction: Option<&str>,
    profit_filter: Option<&str>,
) -> Result<(BTreeMap<i64, HistoryDailyTrade>, HistoryTradeAggregate), StoreError> {
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
        SqlValue::Integer(start),
        SqlValue::Integer(end),
    ];
    let index = 7;
    let mut predicates = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND item_kind = 'trade'
          AND close_time_utc_msc >= ?5 AND close_time_utc_msc < ?6
          AND immutable_state = 'sealed'",
    );
    if let Some(direction) = direction {
        predicates.push_str(&format!(" AND direction = ?{index}"));
        values.push(SqlValue::Text(direction.to_owned()));
    }
    if let Some(profit_filter) = profit_filter {
        predicates.push_str(match profit_filter {
            "profit" => " AND net_profit > 0",
            "loss" => " AND net_profit < 0",
            "flat" => " AND net_profit = 0",
            _ => "",
        });
    }
    let query = format!(
        "SELECT COALESCE(summary_day_utc_msc,
                   close_time_utc_msc - (close_time_utc_msc % 86400000)),
                COUNT(*), COALESCE(SUM(COALESCE(net_profit, 0)), 0),
                COALESCE(SUM(CASE WHEN COALESCE(net_profit, 0) > 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN COALESCE(net_profit, 0) < 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN COALESCE(net_profit, 0) > 0 THEN net_profit ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN COALESCE(net_profit, 0) < 0 THEN -net_profit ELSE 0 END), 0)
         FROM history_archive_items{predicates}
         GROUP BY COALESCE(summary_day_utc_msc,
                   close_time_utc_msc - (close_time_utc_msc % 86400000))
         ORDER BY 1;"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, f64>(6)?,
            ))
        })
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
    let mut daily = BTreeMap::new();
    let mut aggregate = HistoryTradeAggregate::default();
    for row in rows {
        let (day, count, profit, wins, losses, gross_profit, gross_loss) =
            row.map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
        daily
            .entry(day)
            .or_insert_with(HistoryDailyTrade::default)
            .add(HistoryDailyTrade {
                profit,
                trade_count: count,
                wins,
                losses,
            });
        aggregate.trade_count = aggregate.trade_count.saturating_add(count);
        aggregate.total_profit += profit;
        aggregate.win_count = aggregate.win_count.saturating_add(wins);
        aggregate.loss_count = aggregate.loss_count.saturating_add(losses);
        aggregate.gross_profit += gross_profit;
        aggregate.gross_loss += gross_loss;
    }
    Ok((daily, aggregate))
}

fn history_chart_range_parts(
    range: Option<&HistoryRequestedRange>,
) -> (Option<i64>, Option<i64>, Vec<(i64, i64)>) {
    const DAY_MSC: i64 = 86_400_000;
    let Some(range) = range else {
        return (None, None, Vec::new());
    };
    let summary_start = if range.range_start_utc_msc.rem_euclid(DAY_MSC) == 0 {
        range.range_start_utc_msc
    } else {
        range
            .range_start_utc_msc
            .saturating_add(DAY_MSC - range.range_start_utc_msc.rem_euclid(DAY_MSC))
    };
    let summary_end = range.range_end_utc_msc - range.range_end_utc_msc.rem_euclid(DAY_MSC);
    let mut raw_segments = Vec::with_capacity(2);
    let first_end = summary_start.min(range.range_end_utc_msc);
    if range.range_start_utc_msc < first_end {
        raw_segments.push((range.range_start_utc_msc, first_end));
    }
    let second_start = summary_end.max(range.range_start_utc_msc);
    if second_start < range.range_end_utc_msc {
        raw_segments.push((second_start, range.range_end_utc_msc));
    }
    let (summary_start, summary_end) = if summary_start < summary_end {
        (Some(summary_start), Some(summary_end))
    } else {
        (None, None)
    };
    (summary_start, summary_end, raw_segments)
}

fn read_history_chart_data_from_summary(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    request: &HistoryPageRequest,
    generation: i64,
    use_summary_v2: bool,
    history_sync: serde_json::Value,
) -> Result<serde_json::Value, StoreError> {
    let mut history_sync = history_sync;
    if use_summary_v2 && request.requested_range.is_some() {
        history_sync["summary_source"] =
            serde_json::Value::String("sqlite_archive_raw_close_time".to_owned());
        history_sync["time_semantics"] = serde_json::Value::String("exact_close_utc".to_owned());
    }
    let (daily, aggregate) = if use_summary_v2 {
        if let Some(range) = request.requested_range.as_ref() {
            // v2 groups by terminal business date. A numeric UTC range can
            // cut through a business-day boundary, so preserve exact close
            // semantics with one bounded raw segment instead of guessing a
            // conversion from UTC midnight.
            read_history_raw_trade_rows(
                connection,
                terminal,
                range.range_start_utc_msc,
                range.range_end_utc_msc,
                request.direction.as_deref(),
                request.profit_filter.as_deref(),
            )?
        } else {
            read_history_summary_trade_rows_v2(
                connection,
                terminal,
                generation,
                request.direction.as_deref(),
                request.profit_filter.as_deref(),
            )?
        }
    } else {
        let (summary_start, summary_end, raw_segments) =
            history_chart_range_parts(request.requested_range.as_ref());
        let (mut daily, mut aggregate) = read_history_summary_trade_rows(
            connection,
            terminal,
            generation,
            summary_start,
            summary_end,
            request.direction.as_deref(),
            request.profit_filter.as_deref(),
        )?;
        for (start, end) in raw_segments {
            let (raw_daily, raw_aggregate) = read_history_raw_trade_rows(
                connection,
                terminal,
                start,
                end,
                request.direction.as_deref(),
                request.profit_filter.as_deref(),
            )?;
            for (day, value) in raw_daily {
                daily.entry(day).or_default().add(value);
            }
            aggregate.add(raw_aggregate);
        }
        (daily, aggregate)
    };
    let balance = connection
        .query_row(
            "SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL)
             FROM account_latest WHERE terminal_instance_id = ?1
               AND connection_epoch = ?2 LIMIT 1;",
            params![terminal.terminal_instance_id, terminal.connection_epoch],
            |row| row.get::<_, f64>(0),
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?
        .unwrap_or(0.0);
    let round = |value: f64| (value * 100.0).round() / 100.0;
    let initial_capital = (balance - aggregate.total_profit).max(0.0);
    let mut running = 0.0;
    let mut peak = initial_capital;
    let mut maximum_drawdown: f64 = 0.0;
    let mut cumulative = Vec::with_capacity(daily.len());
    let mut drawdown = Vec::with_capacity(daily.len());
    let daily = daily
        .into_iter()
        .map(|(day, value)| {
            let profit = round(value.profit);
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
            let date = connection
                .query_row(
                    "SELECT strftime('%Y-%m-%d', ?1 / 1000, 'unixepoch');",
                    params![day],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| StoreError::new("bridge_store_history_chart_query_failed"))?;
            Ok::<_, StoreError>(serde_json::json!({
                "date": date,
                "profit": profit,
                "trade_count": value.trade_count,
                "wins": value.wins,
                "losses": value.losses,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let average_win = if aggregate.win_count > 0 {
        aggregate.gross_profit / aggregate.win_count as f64
    } else {
        0.0
    };
    let average_loss = if aggregate.loss_count > 0 {
        aggregate.gross_loss / aggregate.loss_count as f64
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
    let summary_source = if use_summary_v2 && request.requested_range.is_some() {
        "sqlite_archive_raw_close_time"
    } else if use_summary_v2 {
        "sqlite_summary_v2"
    } else {
        "sqlite_summary_v1"
    };
    let time_semantics = if use_summary_v2 && request.requested_range.is_some() {
        "exact_close_utc"
    } else if use_summary_v2 {
        "server_business_date"
    } else {
        "legacy_utc_day"
    };
    Ok(serde_json::json!({
        "daily": daily,
        "cumulative": cumulative,
        "drawdown": drawdown,
        "stats": {
            "total_trades": aggregate.trade_count,
            "win_rate": if aggregate.trade_count > 0 {
                round(aggregate.win_count as f64 / aggregate.trade_count as f64 * 100.0)
            } else {
                0.0
            },
            "profit_factor": profit_factor,
            "max_drawdown": maximum_drawdown,
            "gross_profit": round(aggregate.gross_profit),
            "gross_loss": round(aggregate.gross_loss),
        },
        "history_sync": history_sync,
        "summary_source": summary_source,
        "time_semantics": time_semantics,
        "source": format!("{}_sqlite", terminal.platform),
    }))
}

fn read_history_statistics_from_summary_v2(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    request: &HistoryPageRequest,
    generation: i64,
    total_hint: i64,
) -> Result<serde_json::Value, StoreError> {
    if let Some(range) = request.requested_range.as_ref() {
        // A numeric range can cut through a terminal business day.  v2 only
        // stores the business-date bucket, so keep exact range statistics on
        // the immutable close/event timestamps rather than widening to the
        // whole active generation.
        let (trade_count, total_profit, total_volume) = query_history_raw_statistics_segment(
            connection,
            terminal,
            Some(range.range_start_utc_msc),
            Some(range.range_end_utc_msc),
            request.direction.as_deref(),
            request.profit_filter.as_deref(),
        )?;
        let (deposit, withdrawal, credit) = query_history_raw_capital_segment(
            connection,
            terminal,
            Some(range.range_start_utc_msc),
            Some(range.range_end_utc_msc),
        )?;
        let balance = connection
            .query_row(
                "SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL)
                 FROM account_latest WHERE terminal_instance_id = ?1 AND connection_epoch = ?2 LIMIT 1;",
                params![terminal.terminal_instance_id, terminal.connection_epoch],
                |row| row.get::<_, f64>(0),
            )
            .optional()
            .map_err(|_| StoreError::new("bridge_store_history_statistics_query_failed"))?
            .unwrap_or(0.0);
        let net_result = total_profit + credit + deposit - withdrawal;
        let round = |value: f64| (value * 100.0).round() / 100.0;
        let _ = total_hint;
        return Ok(serde_json::json!({
            "account_principal": round(balance - net_result),
            "account_balance": round(balance),
            "total_profit": round(total_profit),
            "credit": round(credit),
            "deposit": round(deposit),
            "withdrawal": round(withdrawal),
            "net_result": round(net_result),
            "trade_count": trade_count,
            "total_volume": round(total_volume),
            "summary_source": "sqlite_archive_raw_close_time",
            "time_semantics": "exact_close_utc",
        }));
    }
    let mut trade_values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
        SqlValue::Integer(generation),
    ];
    let mut trade_predicates = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND generation = ?5
          AND item_kind = 'trade'",
    );
    let mut index = 6;
    if let Some(direction) = request.direction.as_deref() {
        trade_predicates.push_str(&format!(" AND direction = ?{index}"));
        trade_values.push(SqlValue::Text(direction.to_owned()));
        index += 1;
    }
    if let Some(profit_filter) = request.profit_filter.as_deref() {
        trade_predicates.push_str(&format!(" AND profit_bucket = ?{index}"));
        trade_values.push(SqlValue::Text(profit_filter.to_owned()));
    }
    let (trade_count, total_profit, total_volume) = connection
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(trade_count), 0),
                        COALESCE(SUM(net_profit), 0),
                        COALESCE(SUM(volume), 0)
                 FROM history_daily_summary_v2{trade_predicates};"
            ),
            params_from_iter(trade_values),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_statistics_summary_v2_failed"))?;
    let (deposit, withdrawal, credit) = connection
        .query_row(
            "SELECT COALESCE(SUM(deal_deposit), 0),
                    COALESCE(SUM(deal_withdrawal), 0),
                    COALESCE(SUM(deal_credit), 0)
             FROM history_daily_summary_v2
             WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3 AND platform = ?4 AND generation = ?5
               AND item_kind = 'deal';",
            params![
                terminal.terminal_instance_id,
                terminal.account_ref.broker_server,
                terminal.account_ref.login,
                terminal.platform,
                generation
            ],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_statistics_summary_v2_failed"))?;
    let balance = connection
        .query_row(
            "SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL)
             FROM account_latest WHERE terminal_instance_id = ?1 AND connection_epoch = ?2 LIMIT 1;",
            params![terminal.terminal_instance_id, terminal.connection_epoch],
            |row| row.get::<_, f64>(0),
        )
        .optional()
        .map_err(|_| StoreError::new("bridge_store_history_statistics_summary_v2_failed"))?
        .unwrap_or(0.0);
    let net_result = total_profit + credit + deposit - withdrawal;
    let round = |value: f64| (value * 100.0).round() / 100.0;
    let _ = total_hint;
    Ok(serde_json::json!({
        "account_principal": round(balance - net_result),
        "account_balance": round(balance),
        "total_profit": round(total_profit),
        "credit": round(credit),
        "deposit": round(deposit),
        "withdrawal": round(withdrawal),
        "net_result": round(net_result),
        "trade_count": trade_count,
        "total_volume": round(total_volume),
        "summary_source": "sqlite_summary_v2",
        "time_semantics": "server_business_date",
    }))
}

fn read_history_statistics_from_summary(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    request: &HistoryPageRequest,
    generation: i64,
    total_hint: i64,
) -> Result<serde_json::Value, StoreError> {
    const DAY_MSC: i64 = 86_400_000;
    let range = request.requested_range.as_ref();
    let (summary_start, summary_end, raw_segments) = if let Some(range) = range {
        let summary_start = if range.range_start_utc_msc.rem_euclid(DAY_MSC) == 0 {
            range.range_start_utc_msc
        } else {
            range
                .range_start_utc_msc
                .saturating_add(DAY_MSC - range.range_start_utc_msc.rem_euclid(DAY_MSC))
        };
        let summary_end = range.range_end_utc_msc - range.range_end_utc_msc.rem_euclid(DAY_MSC);
        let segments = if summary_start < summary_end {
            vec![
                (range.range_start_utc_msc, Some(summary_start)),
                (summary_end, Some(range.range_end_utc_msc)),
            ]
        } else {
            vec![(range.range_start_utc_msc, Some(range.range_end_utc_msc))]
        };
        (Some(summary_start), Some(summary_end), segments)
    } else {
        (None, None, Vec::new())
    };
    let mut summary_predicate = String::from(
        " WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
          AND login_account = ?3 AND platform = ?4 AND generation = ?5
          AND item_kind = 'trade'",
    );
    let mut summary_values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
        SqlValue::Integer(generation),
    ];
    let mut index = 6;
    if let (Some(start), Some(end)) = (summary_start, summary_end)
        && start < end
    {
        summary_predicate.push_str(&format!(" AND summary_day_utc_msc >= ?{index}"));
        summary_values.push(SqlValue::Integer(start));
        index += 1;
        summary_predicate.push_str(&format!(" AND summary_day_utc_msc < ?{index}"));
        summary_values.push(SqlValue::Integer(end));
        index += 1;
    }
    if let Some(direction) = request.direction.as_deref() {
        summary_predicate.push_str(&format!(" AND direction = ?{index}"));
        summary_values.push(SqlValue::Text(direction.to_owned()));
        index += 1;
    }
    if let Some(bucket) = request.profit_filter.as_deref() {
        summary_predicate.push_str(&format!(" AND profit_bucket = ?{index}"));
        summary_values.push(SqlValue::Text(bucket.to_owned()));
    }
    let summary = connection
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(trade_count), 0), COALESCE(SUM(net_profit), 0),
                        COALESCE(SUM(volume), 0)
                 FROM history_daily_summary{summary_predicate};"
            ),
            params_from_iter(summary_values),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .map_err(|_| StoreError::new("bridge_store_history_statistics_summary_failed"))?;
    let mut trade_count = summary.0;
    let mut total_profit = summary.1;
    let mut total_volume = summary.2;
    let mut deposit = 0.0;
    let mut withdrawal = 0.0;
    let mut credit = 0.0;
    if let (Some(start), Some(end)) = (summary_start, summary_end) {
        if start < end {
            let capital = connection
                .query_row(
                    "SELECT COALESCE(SUM(deal_deposit), 0),
                            COALESCE(SUM(deal_withdrawal), 0),
                            COALESCE(SUM(deal_credit), 0)
                     FROM history_daily_summary
                     WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4 AND generation = ?5
                       AND item_kind = 'deal' AND summary_day_utc_msc >= ?6
                       AND summary_day_utc_msc < ?7;",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                        generation,
                        start,
                        end
                    ],
                    |row| {
                        Ok((
                            row.get::<_, f64>(0)?,
                            row.get::<_, f64>(1)?,
                            row.get::<_, f64>(2)?,
                        ))
                    },
                )
                .map_err(|_| {
                    StoreError::new("bridge_store_history_statistics_capital_range_failed")
                })?;
            deposit += capital.0;
            withdrawal += capital.1;
            credit += capital.2;
        }
    } else {
        let capital = connection
            .query_row(
                "SELECT COALESCE(SUM(deal_deposit), 0), COALESCE(SUM(deal_withdrawal), 0),
                        COALESCE(SUM(deal_credit), 0)
                 FROM history_daily_summary
                 WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4 AND generation = ?5
                   AND item_kind = 'deal';",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                    generation
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| StoreError::new("bridge_store_history_statistics_capital_failed"))?;
        deposit = capital.0;
        withdrawal = capital.1;
        credit = capital.2;
    }
    for (start, end) in raw_segments {
        let Some(end) = end else { continue };
        if start >= end {
            continue;
        }
        let raw = query_history_raw_statistics_segment(
            connection,
            terminal,
            Some(start),
            Some(end),
            request.direction.as_deref(),
            request.profit_filter.as_deref(),
        )?;
        trade_count += raw.0;
        total_profit += raw.1;
        total_volume += raw.2;
        let capital =
            query_history_raw_capital_segment(connection, terminal, Some(start), Some(end))?;
        deposit += capital.0;
        withdrawal += capital.1;
        credit += capital.2;
    }
    // The materialized generation is authoritative for aggregate totals.  A
    // caller-provided page COUNT is retained only for API compatibility and
    // must never turn a partial/empty summary into a fabricated larger total.
    let _ = total_hint;
    let total = trade_count;
    let balance = connection
        .query_row(
            "SELECT CAST(COALESCE(json_extract(payload_json, '$.balance'), 0) AS REAL)
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
        "summary_source": "sqlite_summary_v1",
        "time_semantics": "legacy_utc_day",
    }))
}

fn read_history_cursor_statistics(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    request: &HistoryCursorPageRequest,
    total: i64,
    highwater_rowid: i64,
) -> Result<serde_json::Value, StoreError> {
    let bounded_prefix = " AND rowid <= ? AND close_time_utc_msc >= ? \
                          AND close_time_utc_msc < ?";
    let capital_bounded_prefix = " AND rowid <= ? AND event_time_msc >= ? \
                                  AND event_time_msc < ?";
    let statistics_request = HistoryPageRequest {
        page: 1,
        page_size: request.query.page_size,
        include_deals: false,
        evidence_position_ids: Vec::new(),
        evidence_order_tickets: Vec::new(),
        requested_range: Some(request.requested_range.clone()),
        filter_sql: format!("{bounded_prefix}{}", request.filter_sql),
        filter_values: Vec::new(),
        direction: request.query.direction.clone(),
        profit_filter: request.query.profit_filter.clone(),
        capital_filter_sql: format!("{capital_bounded_prefix}{}", request.capital_filter_sql),
        capital_filter_values: {
            let mut values = vec![
                SqlValue::Integer(highwater_rowid),
                SqlValue::Integer(request.query.range_start_utc_msc),
                SqlValue::Integer(request.query.range_end_utc_msc),
            ];
            values.extend(request.capital_filter_values.iter().cloned());
            values
        },
    };
    let mut filtered_values = history_scope_values(terminal);
    filtered_values.push(SqlValue::Text(terminal.platform.clone()));
    filtered_values.push(SqlValue::Integer(highwater_rowid));
    filtered_values.push(SqlValue::Integer(request.query.range_start_utc_msc));
    filtered_values.push(SqlValue::Integer(request.query.range_end_utc_msc));
    filtered_values.extend(request.filter_values.iter().cloned());
    read_history_statistics(
        connection,
        terminal,
        &statistics_request,
        total,
        filtered_values,
    )
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

fn validate_history_archive_batch_shape(batch: &HistoryArchiveBatch) -> Result<(), StoreError> {
    validate_history_cursor(&batch.next_cursor)?;
    if batch.observed_at_utc_msc <= 0
        || batch.deals.len() > MAX_HISTORY_BATCH_ITEMS
        || batch.history_orders.len() > MAX_HISTORY_BATCH_ITEMS
        || batch.trades.len() > MAX_HISTORY_BATCH_ITEMS
    {
        return Err(StoreError::new("bridge_store_history_batch_invalid"));
    }
    Ok(())
}

fn history_scope_matches_terminal(scope: &HistoryScope, terminal: &TerminalDescriptor) -> bool {
    scope.terminal_instance_id == terminal.terminal_instance_id
        && scope.login_account == terminal.account_ref.login
        && scope
            .broker_server
            .eq_ignore_ascii_case(&terminal.account_ref.broker_server)
}

fn validate_history_job_batch_cursor(
    job: &HistorySyncJob,
    next_cursor: &HistoryCursor,
    has_more: bool,
) -> Result<(), StoreError> {
    validate_history_cursor(next_cursor)?;
    let current = HistoryCursor {
        time_msc: job.cursor_time_msc,
        ticket: job.cursor_ticket.clone(),
    };
    if compare_history_cursor(next_cursor, &current) != std::cmp::Ordering::Greater
        || next_cursor.time_msc < job.range_start_utc_msc
        || next_cursor.time_msc > job.range_end_utc_msc
    {
        return Err(StoreError::new("bridge_store_history_cursor_regression"));
    }
    if has_more {
        if next_cursor.time_msc >= job.range_end_utc_msc
            || compare_decimal_strings(&next_cursor.ticket, "0") != std::cmp::Ordering::Greater
        {
            return Err(StoreError::new("bridge_store_history_cursor_invalid"));
        }
    } else if next_cursor.ticket != "0" {
        return Err(StoreError::new("bridge_store_history_cursor_invalid"));
    }
    Ok(())
}

fn validate_history_items_in_range(
    item_kind: &str,
    items: &[serde_json::Value],
    range_start_utc_msc: i64,
    range_end_utc_msc: i64,
) -> Result<(), StoreError> {
    for item in items {
        let object = item
            .as_object()
            .ok_or_else(|| StoreError::new("bridge_store_history_item_invalid"))?;
        let event_time_msc = history_time_fields(item_kind, object)?.event_time_msc;
        if event_time_msc < range_start_utc_msc || event_time_msc >= range_end_utc_msc {
            return Err(StoreError::new("bridge_store_history_item_out_of_range"));
        }
        let payload_json = serde_json::to_string(item)
            .map_err(|_| StoreError::new("bridge_store_history_item_invalid"))?;
        if payload_json.len() > MAX_HISTORY_ITEM_BYTES {
            return Err(StoreError::new("bridge_store_history_item_too_large"));
        }
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

fn history_number(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<f64> {
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|number| number as f64))
                .or_else(|| value.as_u64().map(|number| number as f64))
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
                .filter(|number| number.is_finite())
        })
    })
}

fn history_i64(object: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<i64>().ok())
                })
                .filter(|number| *number > 0)
        })
    })
}

fn history_i64_any(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<i64> {
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<i64>().ok())
                })
        })
    })
}

fn business_date_from_server_msc(server_msc: i64) -> Result<String, StoreError> {
    if server_msc <= 0 {
        return Err(StoreError::new("bridge_store_history_item_invalid"));
    }
    // Convert a Unix-millisecond day number to an ISO date without relying on
    // the host timezone.  The same civil-date algorithm is used by the
    // persisted server-time evidence and summary v2.
    let days = server_msc.div_euclid(HISTORY_DAY_MSC);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HistoryTimeFields {
    event_time_msc: i64,
    close_time_utc_msc: Option<i64>,
    close_time_server_msc: Option<i64>,
    close_timezone_offset_minutes: Option<i64>,
    close_business_date: Option<String>,
    immutable_state: &'static str,
}

fn history_time_fields(
    item_kind: &str,
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<HistoryTimeFields, StoreError> {
    if item_kind == "trade" {
        let explicit_close_utc = history_i64(object, &["close_time_utc_msc"]);
        // `close_time_msc` is the explicit compatibility field emitted by old
        // Bridge workers.  It is never inferred from generic `time_msc` or
        // entry time, and is accepted only as a legacy close-time contract.
        let close_time_utc_msc =
            explicit_close_utc.or_else(|| history_i64(object, &["close_time_msc"]));
        let Some(close_time_utc_msc) = close_time_utc_msc else {
            return Err(StoreError::new(
                "bridge_store_history_trade_close_time_missing",
            ));
        };
        let close_time_server_msc =
            history_i64(object, &["close_time_server_msc"]).or(Some(close_time_utc_msc));
        let close_timezone_offset_minutes = history_i64_any(
            object,
            &["close_timezone_offset_minutes", "timezone_offset_minutes"],
        )
        .or_else(|| {
            close_time_server_msc
                .zip(Some(close_time_utc_msc))
                .map(|(server, utc)| (server - utc).div_euclid(60_000))
        });
        let close_business_date = history_scalar(object, &["close_business_date", "business_date"])
            .or_else(|| {
                close_time_server_msc.and_then(|value| business_date_from_server_msc(value).ok())
            });
        if close_time_utc_msc <= 0
            || close_time_server_msc.is_none()
            || close_timezone_offset_minutes.is_none()
            || close_business_date.is_none()
        {
            return Err(StoreError::new(
                "bridge_store_history_trade_close_time_invalid",
            ));
        }
        let immutable_state = if explicit_close_utc.is_some()
            && object.contains_key("close_time_server_msc")
            && (object.contains_key("close_timezone_offset_minutes")
                || object.contains_key("timezone_offset_minutes"))
            && (object.contains_key("close_business_date") || object.contains_key("business_date"))
        {
            "sealed"
        } else {
            // Explicit old `close_time_msc` remains readable for compatibility;
            // it is marked legacy so a later migration can distinguish it from
            // a fully evidenced close-time row.
            "legacy_incomplete"
        };
        return Ok(HistoryTimeFields {
            event_time_msc: close_time_utc_msc,
            close_time_utc_msc: Some(close_time_utc_msc),
            close_time_server_msc,
            close_timezone_offset_minutes,
            close_business_date,
            immutable_state,
        });
    }
    let event_time_msc = history_i64(object, &["time_msc", "event_time_msc"])
        .ok_or_else(|| StoreError::new("bridge_store_history_item_invalid"))?;
    Ok(HistoryTimeFields {
        event_time_msc,
        close_time_utc_msc: None,
        close_time_server_msc: None,
        close_timezone_offset_minutes: None,
        close_business_date: None,
        immutable_state: "sealed",
    })
}

fn history_normalized_direction(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    history_scalar(object, &["type", "side"]).map(|value| {
        match value.to_ascii_uppercase().as_str() {
            // MT4/MT5 encode BUY/SELL as the first two deal/order type values.
            "0" => "BUY".to_owned(),
            "1" => "SELL".to_owned(),
            value => value.to_owned(),
        }
    })
}

fn history_capital_columns(
    item_kind: &str,
    object: &serde_json::Map<String, serde_json::Value>,
) -> (Option<String>, Option<f64>) {
    if item_kind != "deal" {
        return (None, None);
    }
    // MT5 emits DEAL_TYPE_BALANCE/DEAL_TYPE_CREDIT (2/3), while the MT4 EA
    // keeps the original OP_BALANCE/OP_CREDIT values in `deal_type` (6/7).
    // Accept an already-normalized capital kind as well so replayed archive
    // rows do not depend on one terminal's wire naming.
    let explicit_kind = history_scalar(object, &["capital_kind"]).and_then(|value| {
        match value.to_ascii_lowercase().as_str() {
            "deposit" | "withdrawal" | "credit" => Some(value.to_ascii_lowercase()),
            _ => None,
        }
    });
    let amount = history_number(object, &["capital_amount", "amount", "profit"]).unwrap_or(0.0);
    if let Some(kind) = explicit_kind {
        let normalized_amount = if kind == "withdrawal" {
            amount.abs()
        } else {
            amount
        };
        return (Some(kind), Some(normalized_amount));
    }
    let Some(type_code) = history_number(object, &["type", "deal_type"]) else {
        return (None, None);
    };
    if (type_code - 2.0).abs() < f64::EPSILON || (type_code - 6.0).abs() < f64::EPSILON {
        return (
            Some(if amount >= 0.0 {
                "deposit".to_owned()
            } else {
                "withdrawal".to_owned()
            }),
            Some(amount.abs()),
        );
    }
    if (type_code - 3.0).abs() < f64::EPSILON || (type_code - 7.0).abs() < f64::EPSILON {
        return (Some("credit".to_owned()), Some(amount));
    }
    (None, None)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct HistoryUpsertResult {
    changed_item_count: usize,
    sealed_trade_changed_count: usize,
    capital_changed_count: usize,
    duplicate_item_count: usize,
    immutable_conflict_count: usize,
    affected_days: Vec<i64>,
}

#[derive(Clone, Debug)]
struct ExistingHistoryArchiveItem {
    payload_json: String,
}

fn prefetch_history_items(
    transaction: &Transaction<'_>,
    terminal: &TerminalDescriptor,
    item_kind: &str,
    item_ids: &[String],
) -> Result<HashMap<String, ExistingHistoryArchiveItem>, StoreError> {
    let mut existing = HashMap::new();
    if item_ids.is_empty() {
        return Ok(existing);
    }
    let placeholders = std::iter::repeat_n("?", item_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT item_id, payload_json FROM history_archive_items
         WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE
           AND login_account = ? AND item_kind = ? AND item_id IN ({placeholders});"
    );
    let mut values = history_scope_values(terminal);
    values.push(SqlValue::Text(item_kind.to_owned()));
    values.extend(item_ids.iter().cloned().map(SqlValue::Text));
    let mut statement = transaction
        .prepare(&query)
        .map_err(|_| StoreError::new("bridge_store_history_item_query_failed"))?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| StoreError::new("bridge_store_history_item_query_failed"))?;
    for row in rows {
        let (item_id, payload_json) =
            row.map_err(|_| StoreError::new("bridge_store_history_item_query_failed"))?;
        existing.insert(item_id, ExistingHistoryArchiveItem { payload_json });
    }
    Ok(existing)
}

fn upsert_history_items(
    transaction: &Transaction<'_>,
    terminal: &TerminalDescriptor,
    item_kind: &str,
    items: &[serde_json::Value],
    observed_at_utc_msc: i64,
) -> Result<HistoryUpsertResult, StoreError> {
    let mut result = HistoryUpsertResult::default();
    let mut item_ids = Vec::with_capacity(items.len());
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
        item_ids.push(item_id);
    }
    item_ids.sort();
    item_ids.dedup();
    let mut existing_items = prefetch_history_items(transaction, terminal, item_kind, &item_ids)?;
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
        let time_fields = history_time_fields(item_kind, object)?;
        let event_time_msc = time_fields.event_time_msc;
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
        let direction = (item_kind == "trade")
            .then(|| history_normalized_direction(object))
            .flatten();
        let net_profit = (item_kind == "trade")
            .then(|| history_number(object, &["net_profit", "profit"]).unwrap_or(0.0));
        let volume =
            (item_kind == "trade").then(|| history_number(object, &["volume"]).unwrap_or(0.0));
        let (capital_kind, capital_amount) = history_capital_columns(item_kind, object);
        let summary_day_utc_msc = if let Some(date) = time_fields.close_business_date.as_deref() {
            parse_utc_date_msc(date)?
        } else {
            event_time_msc - event_time_msc.rem_euclid(HISTORY_DAY_MSC)
        };
        let Some(existing) = existing_items.remove(&item_id) else {
            transaction
                .execute(
                    "INSERT INTO history_archive_items (
                       terminal_instance_id, broker_server, login_account, platform, item_kind,
                       item_id, event_time_msc, position_id, order_ticket, symbol, payload_json,
                       direction, net_profit, volume, capital_kind, capital_amount,
                       summary_day_utc_msc, close_time_utc_msc, close_time_server_msc,
                       close_timezone_offset_minutes, close_business_date, immutable_state,
                       updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                               ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23);",
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
                        direction,
                        net_profit,
                        volume,
                        capital_kind,
                        capital_amount,
                        summary_day_utc_msc,
                        time_fields.close_time_utc_msc,
                        time_fields.close_time_server_msc,
                        time_fields.close_timezone_offset_minutes,
                        time_fields.close_business_date,
                        time_fields.immutable_state,
                        observed_at_utc_msc,
                    ],
                )
                .map_err(|_| StoreError::new("bridge_store_history_item_write_failed"))?;
            result.changed_item_count = result.changed_item_count.saturating_add(1);
            if item_kind == "trade" && time_fields.immutable_state == "sealed" {
                result.sealed_trade_changed_count =
                    result.sealed_trade_changed_count.saturating_add(1);
            }
            if item_kind == "deal" && capital_kind.is_some() {
                result.capital_changed_count = result.capital_changed_count.saturating_add(1);
            }
            result.affected_days.push(summary_day_utc_msc);
            existing_items.insert(item_id, ExistingHistoryArchiveItem { payload_json });
            continue;
        };
        if existing.payload_json == payload_json {
            result.duplicate_item_count = result.duplicate_item_count.saturating_add(1);
        } else {
            // Archive rows are sealed evidence.  A later source payload is
            // observable but cannot overwrite the local truth or revision.
            result.immutable_conflict_count = result.immutable_conflict_count.saturating_add(1);
        }
        // Keep the first immutable payload in the in-batch lookup so repeated
        // IDs in one page cannot turn a duplicate/conflict into an insert.
        existing_items.insert(item_id, existing);
    }
    Ok(result)
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

fn read_history_sync_metadata_locked(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    request: &HistoryPageRequest,
    state: &HistoryArchiveState,
    now_utc_msc: i64,
) -> Result<serde_json::Value, StoreError> {
    if now_utc_msc <= 0 {
        return Err(StoreError::new("history_range_now_invalid"));
    }
    let scope = HistoryScope {
        terminal_instance_id: terminal.terminal_instance_id.clone(),
        broker_server: terminal.account_ref.broker_server.clone(),
        login_account: terminal.account_ref.login.clone(),
    };
    let ranges = read_history_coverage_ranges_locked(connection, &scope)?;
    let scope_state = read_history_scope_state_locked(connection, &scope, &terminal.platform)?;
    let (summary_source, time_semantics) =
        history_summary_source(connection, &scope, &terminal.platform)?;
    const HOUR_MSC: i64 = 60 * 60 * 1_000;
    let is_mt5 = terminal.platform.eq_ignore_ascii_case("mt5");
    let is_mt4 = terminal.platform == "mt4";
    let archive_complete = if is_mt5 {
        let archive_end = now_utc_msc.div_euclid(HOUR_MSC) * HOUR_MSC;
        archive_end >= HISTORY_COVERAGE_START_UTC_MSC
            && history_ranges_cover(&ranges, HISTORY_COVERAGE_START_UTC_MSC, archive_end)
    } else if is_mt4 {
        // MT4's legacy flag only proves that the terminal reached the end of
        // the currently visible Account History range.  It is not broker-wide
        // coverage and must never satisfy exact-range completeness on its own.
        false
    } else {
        false
    };
    let requested_range_complete = request.requested_range.as_ref().map(|range| {
        if is_mt5 {
            history_ranges_cover(&ranges, range.range_start_utc_msc, range.range_end_utc_msc)
        } else if is_mt4 {
            // MT4 has no broker-side range coverage proof.  Keep this false
            // even after the terminal-visible scan reaches its current end.
            false
        } else {
            state.is_complete
        }
    });
    let coverage_bounds = request.requested_range.as_ref().and_then(|range| {
        if !is_mt5 || requested_range_complete != Some(true) {
            return None;
        }
        history_ranges_covering_bounds(&ranges, range.range_start_utc_msc, range.range_end_utc_msc)
    });
    let latest_job_progress = connection
        .query_row(
            "SELECT COALESCE(MAX(updated_at_utc_msc), 0) FROM history_sync_jobs
             WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
               AND login_account = ?3;",
            params![
                scope.terminal_instance_id,
                scope.broker_server,
                scope.login_account
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| StoreError::new("bridge_store_history_state_query_failed"))?;
    let latest_coverage_progress = ranges
        .iter()
        .map(|range| range.updated_at_utc_msc)
        .max()
        .unwrap_or(0);
    let last_progress_at_utc_msc = state
        .updated_at_utc_msc
        .max(latest_job_progress)
        .max(latest_coverage_progress);
    let backfill_pending = !archive_complete || requested_range_complete == Some(false);
    let coverage_complete =
        requested_range_complete.unwrap_or(archive_complete) && scope_state.coverage_complete;
    let (requested_start, requested_end, coverage_start, coverage_end) =
        if let Some(range) = request.requested_range.as_ref() {
            let coverage_start = coverage_bounds.map(|(start, _)| start);
            let coverage_end = coverage_bounds.map(|(_, end)| end);
            (
                serde_json::Value::from(range.range_start_utc_msc),
                serde_json::Value::from(range.range_end_utc_msc),
                coverage_start.map_or(serde_json::Value::Null, serde_json::Value::from),
                coverage_end.map_or(serde_json::Value::Null, serde_json::Value::from),
            )
        } else {
            (
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
            )
        };
    let mut metadata = serde_json::json!({
        "complete": state.is_complete,
        "cursor_time_msc": state.cursor.time_msc,
        "updated_at_utc_msc": state.updated_at_utc_msc,
        "requested_range_complete": requested_range_complete
            .map_or(serde_json::Value::Null, serde_json::Value::from),
        "requested_range_start_utc_msc": requested_start,
        "requested_range_end_utc_msc": requested_end,
        "archive_complete": archive_complete,
        "coverage_start_utc_msc": coverage_start,
        "coverage_end_utc_msc": coverage_end,
        "backfill_pending": backfill_pending,
        "last_progress_at_utc_msc": last_progress_at_utc_msc,
        "coverage_complete": coverage_complete,
        "head_ready": scope_state.head_ready,
        "head_range_start_utc_msc": scope_state
            .head_range_start_utc_msc
            .map_or(serde_json::Value::Null, serde_json::Value::from),
        "head_range_end_utc_msc": scope_state
            .head_range_end_utc_msc
            .map_or(serde_json::Value::Null, serde_json::Value::from),
        "freshness_state": scope_state.freshness_state,
        "fresh_through_utc_msc": scope_state
            .fresh_through_utc_msc
            .map_or(serde_json::Value::Null, serde_json::Value::from),
        "history_revision": scope_state.history_revision,
        "summary_revision": scope_state.summary_revision,
        "summary_status": scope_state.summary_status,
        "summary_source": summary_source,
        "time_semantics": time_semantics,
        "history_duplicate_count": scope_state.duplicate_count,
        "history_immutable_conflict_count": scope_state.immutable_conflict_count,
        "duplicate_count": scope_state.duplicate_count,
        "immutable_conflict_count": scope_state.immutable_conflict_count,
    });
    if is_mt4 {
        metadata["terminal_visible_history_complete"] = serde_json::Value::Bool(state.is_complete);
        metadata["history_source_complete"] = serde_json::Value::Bool(false);
        metadata["history_source_note"] = serde_json::Value::String(MT4_HISTORY_SOURCE_NOTE.into());
    }
    Ok(metadata)
}

fn read_history_evidence_for_page(
    connection: &Connection,
    terminal: &TerminalDescriptor,
    trades: &[serde_json::Value],
    requested_positions: &[String],
    requested_orders: &[String],
    requested_range: Option<&HistoryRequestedRange>,
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>, bool), StoreError> {
    let mut positions = requested_positions.to_vec();
    let mut orders = requested_orders.to_vec();
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
    let deals = query_history_evidence(
        connection,
        terminal,
        "deal",
        &positions,
        &orders,
        requested_range,
    )?;
    let history_orders = query_history_evidence(
        connection,
        terminal,
        "history_order",
        &positions,
        &orders,
        requested_range,
    )?;
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
    requested_range: Option<&HistoryRequestedRange>,
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
    let range_sql = requested_range
        .map(|_| " AND event_time_msc >= ? AND event_time_msc < ?")
        .unwrap_or("");
    let query = format!(
        "SELECT payload_json FROM history_archive_items \
         WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
           AND login_account = ? AND platform = ? AND item_kind = 'history_order' \
           AND (item_id IN ({placeholders}) OR order_ticket IN ({placeholders})){range_sql};"
    );
    let mut values = history_scope_values(terminal);
    values.push(SqlValue::Text(terminal.platform.clone()));
    values.extend(opening_orders.iter().cloned().map(SqlValue::Text));
    values.extend(opening_orders.iter().cloned().map(SqlValue::Text));
    if let Some(range) = requested_range {
        values.push(SqlValue::Integer(range.range_start_utc_msc));
        values.push(SqlValue::Integer(range.range_end_utc_msc));
    }
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
    requested_range: Option<&HistoryRequestedRange>,
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
    let range_sql = requested_range
        .map(|_| " AND event_time_msc >= ? AND event_time_msc < ?")
        .unwrap_or("");
    let query = format!(
        "SELECT payload_json FROM history_archive_items \
         WHERE terminal_instance_id = ? AND broker_server = ? COLLATE NOCASE \
           AND login_account = ? AND platform = ? AND item_kind = ? AND ({}) \
         {range_sql} ORDER BY event_time_msc, item_id LIMIT ?;",
        predicates.join(" OR ")
    );
    let mut values = vec![
        SqlValue::Text(terminal.terminal_instance_id.clone()),
        SqlValue::Text(terminal.account_ref.broker_server.clone()),
        SqlValue::Text(terminal.account_ref.login.clone()),
        SqlValue::Text(terminal.platform.clone()),
        SqlValue::Text(kind.to_owned()),
    ];
    values.extend(positions.iter().cloned().map(SqlValue::Text));
    values.extend(orders.iter().cloned().map(SqlValue::Text));
    if kind == "history_order" {
        values.extend(orders.iter().cloned().map(SqlValue::Text));
    }
    if let Some(range) = requested_range {
        values.push(SqlValue::Integer(range.range_start_utc_msc));
        values.push(SqlValue::Integer(range.range_end_utc_msc));
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
    object.insert(
        "evidence_truncated".to_owned(),
        serde_json::Value::Bool(true),
    );
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RuntimeSchemaStatus {
    Complete,
    NeedsMigration,
    Incompatible,
}

fn configure_open_connection(connection: &Connection) -> Result<(), StoreError> {
    let synchronous = connection
        .query_row("PRAGMA synchronous;", [], |row| row.get::<_, i64>(0))
        .map_err(|_| StoreError::new("bridge_store_synchronous_failed"))?;
    if synchronous != 2 {
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| StoreError::new("bridge_store_synchronous_failed"))?;
    }
    let foreign_keys = connection
        .query_row("PRAGMA foreign_keys;", [], |row| row.get::<_, i64>(0))
        .map_err(|_| StoreError::new("bridge_store_foreign_keys_failed"))?;
    if foreign_keys != 1 {
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| StoreError::new("bridge_store_foreign_keys_failed"))?;
    }
    Ok(())
}

fn runtime_schema_status(connection: &Connection) -> Result<RuntimeSchemaStatus, StoreError> {
    let mut needs_migration = false;
    for (table, required_columns) in HISTORY_RUNTIME_REQUIRED_TABLES {
        if !table_exists(connection, table)? {
            needs_migration = true;
            continue;
        }
        let columns = table_columns(connection, table)?;
        if required_columns
            .iter()
            .any(|required| !columns.iter().any(|existing| existing == required))
        {
            return Ok(RuntimeSchemaStatus::Incompatible);
        }
        if *table == "history_scope_state"
            && ["duplicate_count", "immutable_conflict_count"]
                .iter()
                .any(|required| !columns.iter().any(|existing| existing == required))
        {
            needs_migration = true;
        }
        // These scalar archive columns were added after the original history
        // table and are repaired additively below.  Their absence is a normal
        // migration state, not evidence that the user's database is corrupt.
        if *table == "history_archive_items"
            && [
                "direction",
                "net_profit",
                "volume",
                "capital_kind",
                "capital_amount",
                "summary_day_utc_msc",
                "close_time_utc_msc",
                "close_time_server_msc",
                "close_timezone_offset_minutes",
                "close_business_date",
                "immutable_state",
            ]
            .iter()
            .any(|required| !columns.iter().any(|existing| existing == required))
        {
            needs_migration = true;
        }
    }

    if !table_exists(connection, "native_command_ledger")? {
        needs_migration = true;
    } else {
        let columns = table_columns(connection, "native_command_ledger")?;
        if NATIVE_COMMAND_LEDGER_REQUIRED_COLUMNS
            .iter()
            .any(|required| !columns.iter().any(|existing| existing == required))
        {
            return Ok(RuntimeSchemaStatus::Incompatible);
        }
    }

    for index in NATIVE_COMMAND_LEDGER_REQUIRED_INDEXES
        .iter()
        .chain(HISTORY_RUNTIME_REQUIRED_INDEXES.iter())
    {
        let exists = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1
                 );",
                [*index],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value == 1)
            .map_err(|_| StoreError::new("bridge_store_schema_query_failed"))?;
        if !exists {
            needs_migration = true;
        }
    }

    Ok(if needs_migration {
        RuntimeSchemaStatus::NeedsMigration
    } else {
        RuntimeSchemaStatus::Complete
    })
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
    use std::sync::Arc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
            for table in [
                "account_initialization_state",
                "history_sync_jobs",
                "history_coverage_ranges",
            ] {
                assert!(table_exists(&connection, table).expect("runtime table"));
            }
            for (table, expected_columns) in REQUIRED_SCHEMA {
                let mut expected = expected_columns
                    .iter()
                    .map(|column| (*column).to_owned())
                    .collect::<Vec<_>>();
                if *table == "history_archive_items" {
                    expected.splice(
                        expected.len() - 1..expected.len() - 1,
                        [
                            "direction",
                            "net_profit",
                            "volume",
                            "capital_kind",
                            "capital_amount",
                            "summary_day_utc_msc",
                        ]
                        .into_iter()
                        .map(str::to_owned),
                    );
                    expected.extend(
                        [
                            "close_time_utc_msc",
                            "close_time_server_msc",
                            "close_timezone_offset_minutes",
                            "close_business_date",
                            "immutable_state",
                        ]
                        .into_iter()
                        .map(str::to_owned),
                    );
                }
                assert_eq!(
                    table_columns(&connection, table).expect("fresh table columns"),
                    expected,
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
                    "idx_account_initialization_updated",
                    "idx_deals_pending_cursor",
                    "idx_execution_receipts_completed",
                    "idx_history_archive_order",
                    "idx_history_archive_page",
                    "idx_history_archive_position",
                    "idx_history_archive_summary_scope",
                    "idx_history_archive_trade_close",
                    "idx_history_archive_trade_filter",
                    "idx_history_coverage_ranges_scope",
                    "idx_history_daily_summary_active",
                    "idx_history_daily_summary_v2_active",
                    "idx_history_scope_state_updated",
                    "idx_history_summary_builds_updated",
                    "idx_history_sync_jobs_claim",
                    "idx_history_sync_jobs_scope",
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
    fn complete_schema_open_skips_schema_writes_while_another_handle_holds_write_lock() {
        let root = unique_test_directory("schema-open-read-only-fast-path");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let first_store = OutboxStore::open_or_create(&path).expect("first store");
        drop(first_store);

        let mut writer = Connection::open(&path).expect("writer connection");
        let transaction = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("writer transaction");
        let started_at = Instant::now();
        let second_store = OutboxStore::open_existing(&path).expect("read-only fast path");
        assert!(
            started_at.elapsed() < Duration::from_millis(500),
            "complete-schema open unexpectedly waited on a schema write lock"
        );
        drop(second_store);
        transaction.rollback().expect("rollback writer transaction");
        drop(writer);
        fs::remove_dir_all(root).expect("remove schema lock fixture");
    }

    #[test]
    fn partial_runtime_table_fails_closed_instead_of_being_treated_as_legacy() {
        let root = unique_test_directory("partial-runtime-schema");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        Connection::open(&path)
            .expect("partial schema connection")
            .execute_batch(
                "CREATE TABLE account_initialization_state (
                   terminal_instance_id TEXT NOT NULL
                 );",
            )
            .expect("partial runtime table");

        let error = OutboxStore::open_existing(&path)
            .err()
            .expect("partial runtime schema must fail closed");
        assert_eq!(error.code(), "bridge_store_schema_incompatible");
        fs::remove_dir_all(root).expect("remove partial schema fixture");
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
            deals: vec![
                serde_json::json!({
                    "deal_ticket": 5001,
                    "order": 1001,
                    "position_id": 42,
                    "time_msc": 1_700_000_000_100_i64,
                    "symbol": "XAUUSD"
                }),
                serde_json::json!({
                    "deal_ticket": 6001,
                    "order": 2001,
                    "position_id": 77,
                    "time_msc": 1_700_000_000_150_i64,
                    "symbol": "EURUSD"
                }),
            ],
            history_orders: vec![
                serde_json::json!({
                    "ticket": 1001,
                    "position_id": 42,
                    "time_msc": 1_700_000_000_050_i64,
                    "symbol": "XAUUSD",
                    "sl": 2290.0,
                    "tp": 2320.0
                }),
                serde_json::json!({
                    "ticket": 2001,
                    "position_id": 77,
                    "time_msc": 1_700_000_000_125_i64,
                    "symbol": "EURUSD"
                }),
            ],
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
        assert_eq!(page["statistics"], serde_json::Value::Null);
        let scoped_open_position = store
            .read_history_archive_page(
                &terminal,
                &serde_json::json!({
                    "page": 1,
                    "page_size": 20,
                    "include_deals": true,
                    "evidence_position_ids": ["77"]
                }),
            )
            .expect("open-position evidence page");
        assert!(
            scoped_open_position["deals"]
                .as_array()
                .expect("scoped deals")
                .iter()
                .any(|deal| deal["deal_ticket"] == 6001)
        );
        assert!(
            scoped_open_position["history_orders"]
                .as_array()
                .expect("scoped history orders")
                .iter()
                .any(|order| order["ticket"] == 2001)
        );
        let exact_evidence = store
            .read_history_evidence_at(
                &terminal,
                &serde_json::json!({
                    "range_start_utc_msc": 1_700_000_000_000_i64,
                    "range_end_utc_msc": 1_700_000_000_130_i64,
                    "evidence_position_ids": ["42"],
                    "evidence_order_tickets": ["1001"]
                }),
                1_700_000_000_300,
            )
            .expect("exact scoped evidence");
        assert_eq!(
            exact_evidence["deals"]
                .as_array()
                .expect("exact deals")
                .iter()
                .map(|item| item["deal_ticket"].as_i64().expect("deal ticket"))
                .collect::<Vec<_>>(),
            vec![5001]
        );
        assert_eq!(
            exact_evidence["history_orders"]
                .as_array()
                .expect("exact history orders")
                .iter()
                .map(|item| item["ticket"].as_i64().expect("order ticket"))
                .collect::<Vec<_>>(),
            vec![1001]
        );
        assert_eq!(
            exact_evidence["history_sync"]["requested_range_start_utc_msc"],
            1_700_000_000_000_i64
        );
        assert_eq!(exact_evidence["evidence_truncated"], false);
        assert_eq!(
            store
                .read_history_archive_page(
                    &terminal,
                    &serde_json::json!({
                        "page": 1,
                        "page_size": 20,
                        "include_deals": true,
                        "evidence_position_ids": ["not-a-ticket"]
                    }),
                )
                .expect_err("invalid evidence reference")
                .code(),
            "history_params_invalid"
        );
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
        assert_eq!(filtered["statistics"], serde_json::Value::Null);
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
                &serde_json::json!({
                    "page": 1,
                    "page_size": 20,
                    "include_deals": true,
                    "evidence_position_ids": ["77"]
                }),
            )
            .expect("isolated empty page");
        assert_eq!(other_page["pagination"]["total_count"], 0);
        assert!(other_page["orders"].as_array().expect("orders").is_empty());
        assert!(other_page["deals"].as_array().expect("deals").is_empty());
        let other_evidence = store
            .read_history_evidence_at(
                &other_account,
                &serde_json::json!({
                    "range_start_utc_msc": 1_700_000_000_000_i64,
                    "range_end_utc_msc": 1_700_000_000_200_i64,
                    "evidence_position_ids": ["42"]
                }),
                1_700_000_000_300,
            )
            .expect("isolated empty evidence");
        assert!(
            other_evidence["deals"]
                .as_array()
                .expect("isolated deals")
                .is_empty()
        );

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
        assert_eq!(
            store
                .read_history_archive_page(
                    &terminal,
                    &serde_json::json!({ "page": MAX_LEGACY_HISTORY_PAGE + 1, "page_size": 20 }),
                )
                .expect_err("deep legacy offset rejected")
                .code(),
            "history_pagination_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove history fixture");
    }

    fn seed_cursor_history(
        store: &OutboxStore,
        terminal: &TerminalDescriptor,
        range_start_utc_msc: i64,
        range_end_utc_msc: i64,
        count: usize,
    ) {
        let mut connection = store.connection.lock().expect("cursor store lock");
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("cursor seed transaction");
        transaction
            .execute(
                "INSERT INTO history_coverage_ranges (
                   terminal_instance_id, broker_server, login_account,
                   range_start_utc_msc, range_end_utc_msc,
                   observed_at_utc_msc, updated_at_utc_msc
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(terminal_instance_id, broker_server, login_account, range_start_utc_msc)
                 DO UPDATE SET range_end_utc_msc = excluded.range_end_utc_msc,
                   observed_at_utc_msc = excluded.observed_at_utc_msc,
                   updated_at_utc_msc = excluded.updated_at_utc_msc;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    range_start_utc_msc,
                    range_end_utc_msc,
                    range_end_utc_msc,
                ],
            )
            .expect("cursor seed coverage");
        for index in 0..count {
            let item_id = format!("{:08}", index + 1);
            let event_time_msc = range_start_utc_msc + (index as i64 / 2);
            let payload = serde_json::json!({
                "deal_ticket": item_id,
                "ticket": item_id,
                "entry_time_utc_msc": event_time_msc,
                "close_time_utc_msc": event_time_msc,
                "close_time_server_msc": event_time_msc,
                "close_timezone_offset_minutes": 0,
                "close_business_date": business_date_from_server_msc(event_time_msc)
                    .expect("cursor seed business date"),
                "close_time_msc": event_time_msc,
                "profit": if index % 2 == 0 { 1.0 } else { -1.0 },
                "volume": 0.1,
            });
            transaction
                .execute(
                    "INSERT INTO history_archive_items (
                       terminal_instance_id, broker_server, login_account, platform,
                       item_kind, item_id, event_time_msc, position_id, order_ticket,
                       symbol, payload_json, updated_at_utc_msc,
                       close_time_utc_msc, close_time_server_msc,
                       close_timezone_offset_minutes, close_business_date, immutable_state
                     ) VALUES (?1, ?2, ?3, ?4, 'trade', ?5, ?6, NULL, NULL, 'XAUUSD', ?7, ?8,
                               ?6, ?6, 0, ?9, 'sealed');",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                        item_id,
                        event_time_msc,
                        payload.to_string(),
                        range_end_utc_msc,
                        business_date_from_server_msc(event_time_msc)
                            .expect("cursor seed business date"),
                    ],
                )
                .expect("cursor seed item");
        }
        transaction.commit().expect("cursor seed commit");
    }

    #[test]
    fn history_cursor_pages_are_keyset_bounded_and_snapshot_consistent() {
        let root = unique_test_directory("history-cursor");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("cursor store");
        let terminal = history_terminal("123456");
        let range_start = 1_700_000_000_000_i64;
        let range_end = range_start + 20_000;
        seed_cursor_history(&store, &terminal, range_start, range_end, 10_000);

        let base_parameters = serde_json::json!({
            "range_start_utc_msc": range_start,
            "range_end_utc_msc": range_end,
            "page_size": 37,
        });
        let first = store
            .read_history_cursor_page_at(&terminal, &base_parameters, range_end)
            .expect("first cursor page");
        let snapshot_id = first["history_snapshot_id"]
            .as_str()
            .expect("snapshot id")
            .to_owned();
        let first_cursor = first["next_cursor"]
            .as_str()
            .expect("first cursor")
            .to_owned();
        assert_eq!(first["pagination"]["total_count"], 10_000);
        assert_eq!(first["has_more"], true);
        assert!(first["deals"].as_array().expect("empty deals").is_empty());
        assert!(
            first["history_orders"]
                .as_array()
                .expect("empty history orders")
                .is_empty()
        );

        let second_parameters = serde_json::json!({
            "range_start_utc_msc": range_start,
            "range_end_utc_msc": range_end,
            "page_size": 37,
            "snapshot_id": snapshot_id,
            "cursor": first_cursor,
        });
        let second = store
            .read_history_cursor_page_at(&terminal, &second_parameters, range_end)
            .expect("second cursor page");
        let second_repeat = store
            .read_history_cursor_page_at(&terminal, &second_parameters, range_end)
            .expect("repeat second cursor page");
        assert_eq!(second["orders"], second_repeat["orders"]);
        assert_eq!(second["next_cursor"], second_repeat["next_cursor"]);
        assert_eq!(second["statistics"], first["statistics"]);
        assert_eq!(second["pagination"]["total_count"], 10_000);
        {
            let connection = store.connection.lock().expect("insert new row lock");
            connection
                .execute(
                    "INSERT INTO history_archive_items (
                       terminal_instance_id, broker_server, login_account, platform,
                       item_kind, item_id, event_time_msc, position_id, order_ticket,
                       symbol, payload_json, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, 'trade', '99999999', ?5, NULL, NULL,
                       'XAUUSD', ?6, ?7);",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                        range_end - 1,
                        serde_json::json!({
                            "deal_ticket": "99999999",
                            "close_time_msc": range_end - 1,
                            "profit": 999.0
                        })
                        .to_string(),
                        range_end,
                    ],
                )
                .expect("insert post-snapshot row");
        }
        let mut page_parameters = second_parameters.clone();
        let mut cursor = second["next_cursor"].as_str().map(str::to_owned);
        let mut seen = first["orders"]
            .as_array()
            .expect("first orders")
            .iter()
            .chain(second["orders"].as_array().expect("second orders").iter())
            .map(|item| item["deal_ticket"].as_str().expect("ticket").to_owned())
            .collect::<std::collections::HashSet<_>>();
        while let Some(next) = cursor {
            page_parameters["cursor"] = serde_json::Value::String(next);
            let page = store
                .read_history_cursor_page_at(&terminal, &page_parameters, range_end)
                .expect("cursor continuation");
            for item in page["orders"].as_array().expect("page orders") {
                let ticket = item["deal_ticket"].as_str().expect("ticket").to_owned();
                assert_ne!(ticket, "99999999");
                assert!(seen.insert(ticket), "duplicate cursor item");
            }
            cursor = page["next_cursor"].as_str().map(str::to_owned);
        }
        assert_eq!(seen.len(), 10_000);

        assert_eq!(
            store
                .read_history_cursor_page_at(
                    &terminal,
                    &serde_json::json!({
                        "range_start_utc_msc": range_start + 1,
                        "range_end_utc_msc": range_end,
                        "page_size": 37,
                        "snapshot_id": snapshot_id,
                        "cursor": first["next_cursor"],
                    }),
                    range_end,
                )
                .expect_err("changed range rejected")
                .code(),
            "history_cursor_invalid"
        );
        assert_eq!(
            store
                .read_history_cursor_page_at(
                    &history_terminal("654321"),
                    &second_parameters,
                    range_end,
                )
                .expect_err("cross-account snapshot rejected")
                .code(),
            "history_snapshot_invalid"
        );
        assert_eq!(
            store
                .read_history_cursor_page_at(
                    &terminal,
                    &serde_json::json!({
                        "range_start_utc_msc": range_start,
                        "range_end_utc_msc": range_end,
                        "page_size": 37,
                        "snapshot_id": "hs_forged",
                    }),
                    range_end,
                )
                .expect_err("forged snapshot rejected")
                .code(),
            "history_snapshot_invalid"
        );
        assert_eq!(
            store
                .read_history_cursor_page_at(
                    &terminal,
                    &serde_json::json!({
                        "range_start_utc_msc": range_start,
                        "range_end_utc_msc": range_end,
                        "page_size": 37,
                        "cursor": "hc_forged",
                    }),
                    range_end,
                )
                .expect_err("cursor without snapshot rejected")
                .code(),
            "history_cursor_invalid"
        );
        assert_eq!(
            store
                .read_history_cursor_page_at(
                    &terminal,
                    &serde_json::json!({
                        "range_start_utc_msc": range_start,
                        "range_end_utc_msc": range_end,
                        "page_size": 37,
                        "snapshot_id": snapshot_id,
                    }),
                    range_end + HISTORY_SNAPSHOT_TTL_MSC,
                )
                .expect_err("expired snapshots cleaned")
                .code(),
            "history_snapshot_invalid"
        );

        for _ in 0..(MAX_HISTORY_SNAPSHOTS + 8) {
            store
                .read_history_cursor_page_at(&terminal, &base_parameters, range_end + 1)
                .expect("bounded snapshot creation");
        }
        assert!(
            store
                .history_snapshots
                .lock()
                .expect("snapshot map lock")
                .len()
                <= MAX_HISTORY_SNAPSHOTS
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove cursor fixture");
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
                "close_time_utc_msc": close_time_msc,
                "close_time_server_msc": close_time_msc,
                "close_timezone_offset_minutes": 0,
                "close_business_date": business_date_from_server_msc(close_time_msc)
                    .expect("close business date"),
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
        store
            .ensure_history_summary(&terminal, first_day + 4 * 86_400_000)
            .expect("history chart summary");

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
        assert_eq!(isolated["stats"], serde_json::Value::Null);
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
    fn history_requested_range_is_fixed_half_open_and_fail_closed_without_start() {
        let now = parse_utc_date_msc("2026-08-08").expect("today") + 12 * 60 * 60 * 1_000;
        let today = parse_history_requested_range(
            &serde_json::json!({
                "date_from": "2026-08-08",
                "range_end_utc_msc": now + 1_000,
            }),
            now,
        )
        .expect("today range")
        .expect("explicit range");
        assert_eq!(
            today.range_start_utc_msc,
            parse_utc_date_msc("2026-08-08").unwrap()
        );
        assert_eq!(today.range_end_utc_msc, now + 1_000);

        let date_to = parse_history_requested_range(
            &serde_json::json!({
                "date_from": "2026-08-01",
                "date_to": "2026-08-02",
            }),
            now,
        )
        .expect("date range")
        .expect("date range value");
        assert_eq!(
            date_to.range_end_utc_msc,
            parse_utc_date_msc("2026-08-03").unwrap()
        );

        let explicit_end = parse_history_requested_range(
            &serde_json::json!({
                "date_from": "2026-08-01",
                "date_to": "2026-08-02",
                "range_end_utc_msc": parse_utc_date_msc("2026-08-02").unwrap() + 1,
            }),
            now,
        )
        .expect("explicit end")
        .expect("explicit range");
        assert_eq!(
            explicit_end.range_end_utc_msc,
            parse_utc_date_msc("2026-08-02").unwrap() + 1
        );

        assert!(
            parse_history_requested_range(&serde_json::json!({ "date_to": "2026-08-02" }), now)
                .expect("no date_from")
                .is_none()
        );
        for parameters in [
            serde_json::json!({
                "date_from": "2026-08-01",
                "range_end_utc_msc": now + 60_001,
            }),
            serde_json::json!({
                "date_from": "2026-08-01",
                "date_to": "2026-08-02",
                "range_end_utc_msc": parse_utc_date_msc("2026-08-03").unwrap() + 1,
            }),
            serde_json::json!({
                "date_from": "2026-08-08",
                "range_end_utc_msc": parse_utc_date_msc("2026-08-08").unwrap(),
            }),
            serde_json::json!({
                "date_from": "2026-08-01",
                "range_end_utc_msc": "not-an-integer",
            }),
        ] {
            assert!(
                parse_history_requested_range(&parameters, now).is_err(),
                "invalid range accepted: {parameters}"
            );
        }
    }

    #[test]
    fn exact_history_range_is_strict_and_filters_the_half_open_interval() {
        let now = 1_800_000_000_000_i64;
        let start = now - 2_000;
        let end = now - 1_000;
        let exact = parse_history_requested_range(
            &serde_json::json!({
                "range_start_utc_msc": start,
                "range_end_utc_msc": end,
            }),
            now,
        )
        .expect("exact range")
        .expect("exact range value");
        assert_eq!(
            exact,
            HistoryRequestedRange {
                range_start_utc_msc: start,
                range_end_utc_msc: end,
            }
        );
        for parameters in [
            serde_json::json!({ "range_start_utc_msc": start }),
            serde_json::json!({ "range_end_utc_msc": end }),
            serde_json::json!({
                "range_start_utc_msc": start,
                "range_end_utc_msc": end,
                "date_from": "2026-01-01",
            }),
            serde_json::json!({
                "range_start_utc_msc": start,
                "range_end_utc_msc": now + 60_001,
            }),
            serde_json::json!({
                "range_start_utc_msc": end,
                "range_end_utc_msc": start,
            }),
            serde_json::json!({
                "range_start_utc_msc": "not-an-integer",
                "range_end_utc_msc": end,
            }),
        ] {
            assert!(
                parse_history_requested_range(&parameters, now).is_err(),
                "invalid exact range accepted: {parameters}"
            );
        }

        let root = unique_test_directory("history-exact-filter");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("exact range store");
        let terminal = history_terminal("123456");
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![
                        serde_json::json!({
                            "deal_ticket": 7001,
                            "ticket": 7001,
                            "close_time_msc": start,
                            "profit": 1.0,
                        }),
                        serde_json::json!({
                            "deal_ticket": 7002,
                            "ticket": 7002,
                            "close_time_msc": end,
                            "profit": 2.0,
                        }),
                    ],
                    next_cursor: HistoryCursor {
                        time_msc: end,
                        ticket: "7002".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: now,
                },
            )
            .expect("persist exact filter rows");
        let page = store
            .read_history_archive_page_at(
                &terminal,
                &serde_json::json!({
                    "range_start_utc_msc": start,
                    "range_end_utc_msc": end,
                }),
                now,
            )
            .expect("exact page");
        assert_eq!(page["pagination"]["total_count"], 1);
        assert_eq!(page["orders"][0]["deal_ticket"], 7001);
        assert_eq!(page["history_sync"]["requested_range_start_utc_msc"], start);
        assert_eq!(page["history_sync"]["requested_range_end_utc_msc"], end);
        drop(store);
        fs::remove_dir_all(root).expect("remove exact filter fixture");
    }

    #[test]
    fn allowed_history_claim_skips_legacy_backfill_and_rejects_invalid_lists() {
        let root = unique_test_directory("history-allowed-claim");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("allowed claim store");
        let scope = history_scope_for("123456");
        let mut legacy = history_job_for("job_01JALLOW0001", &scope, 1_000, 2_000, "p1");
        legacy.job_kind = "backfill".to_owned();
        let recent = history_job_for("job_01JALLOW0002", &scope, 2_000, 3_000, "p2");
        store.enqueue_history_job(&legacy).expect("legacy job");
        store.enqueue_history_job(&recent).expect("recent job");

        let claimed = store
            .claim_history_job_with_allowed_kinds(
                &scope,
                1_700_000_000_001,
                10_000,
                &["recent", "on_demand", "recent"],
            )
            .expect("allowed claim")
            .expect("recent claim");
        assert_eq!(claimed.job_id, recent.job_id);
        assert_eq!(claimed.job_kind, "on_demand");

        let legacy_claim = store
            .claim_history_job(&scope, 1_700_000_000_002, 10_000)
            .expect("legacy compatible claim")
            .expect("legacy claim");
        assert_eq!(legacy_claim.job_id, legacy.job_id);
        assert_eq!(legacy_claim.job_kind, "backfill");

        for allowed in [
            Vec::<&str>::new(),
            vec!["archive_explicit"],
            vec!["recent", "recent"],
        ] {
            if allowed == vec!["recent", "recent"] {
                // Duplicate allowed kinds are normalized and remain valid.
                continue;
            }
            assert_eq!(
                store
                    .claim_history_job_with_allowed_kinds(
                        &scope,
                        1_700_000_000_003,
                        10_000,
                        &allowed,
                    )
                    .expect_err("invalid allow list")
                    .code(),
                "bridge_store_history_allowed_job_kinds_invalid"
            );
        }
        drop(store);
        fs::remove_dir_all(root).expect("remove allowed claim fixture");
    }

    #[test]
    fn atomic_history_planner_subtracts_coverage_and_active_ranges() {
        let root = unique_test_directory("history-planner");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("planner store");
        let scope = history_scope_for("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        {
            let connection = store.connection.lock().expect("coverage lock");
            connection
                .execute(
                    "INSERT INTO history_coverage_ranges (
                       terminal_instance_id, broker_server, login_account,
                       range_start_utc_msc, range_end_utc_msc,
                       observed_at_utc_msc, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?5, ?6, ?4, ?4),
                              (?1, ?2, ?3, ?7, ?8, ?4, ?4);",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        1_700_000_000_000_i64,
                        floor + 2_000,
                        floor + 3_000,
                        floor + 5_000,
                        floor + 6_000,
                    ],
                )
                .expect("coverage rows");
        }
        let request = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "recent".to_owned(),
            priority: "p2".to_owned(),
            range_start_utc_msc: floor + 1_000,
            range_end_utc_msc: floor + 10_000,
            window_msc: 1_000,
            now_utc_msc: 1_700_000_000_100,
        };
        let planned = store.plan_history_jobs(&request).expect("plan gaps");
        assert_eq!(planned.attached_jobs, Vec::new());
        assert_eq!(
            planned
                .created_jobs
                .iter()
                .map(|job| (job.range_start_utc_msc, job.range_end_utc_msc))
                .collect::<Vec<_>>(),
            vec![
                (floor + 1_000, floor + 2_000),
                (floor + 3_000, floor + 5_000),
                (floor + 6_000, floor + 10_000),
            ]
        );
        let repeated = store.plan_history_jobs(&request).expect("repeat plan");
        assert!(repeated.created_jobs.is_empty());
        assert_eq!(repeated.attached_jobs.len(), 3);

        let p1_request = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "on_demand".to_owned(),
            priority: "p1".to_owned(),
            range_start_utc_msc: floor + 1_500,
            range_end_utc_msc: floor + 6_500,
            window_msc: 1_000,
            now_utc_msc: 1_700_000_000_200,
        };
        let p1 = store.plan_history_jobs(&p1_request).expect("p1 bypass");
        assert_eq!(
            p1.created_jobs
                .iter()
                .map(|job| (job.range_start_utc_msc, job.range_end_utc_msc))
                .collect::<Vec<_>>(),
            vec![
                (floor + 1_500, floor + 2_000),
                (floor + 6_000, floor + 6_500)
            ]
        );
        assert_eq!(
            p1.attached_jobs
                .iter()
                .map(|job| (
                    job.range_start_utc_msc,
                    job.range_end_utc_msc,
                    job.priority.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![(floor + 3_000, floor + 5_000, "p1")]
        );

        for (kind, priority) in [
            ("recent", "p1"),
            ("recent", "p3"),
            ("on_demand", "p2"),
            ("backfill", "p2"),
        ] {
            let invalid = HistoryJobPlanningRequest {
                scope: scope.clone(),
                job_kind: kind.to_owned(),
                priority: priority.to_owned(),
                range_start_utc_msc: floor + 20_000,
                range_end_utc_msc: floor + 21_000,
                window_msc: 1_000,
                now_utc_msc: 1_700_000_000_300,
            };
            assert_eq!(
                store
                    .plan_history_jobs(&invalid)
                    .expect_err("invalid planning combination")
                    .code(),
                "bridge_store_history_planning_combination_invalid"
            );
        }
        drop(store);
        fs::remove_dir_all(root).expect("remove planner fixture");
    }

    #[test]
    fn atomic_history_planner_promotes_exact_allowed_jobs_and_rejects_legacy_collision() {
        let root = unique_test_directory("history-planner-promotion");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("promotion planner store");
        let scope = history_scope_for("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let p3 = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "on_demand".to_owned(),
            priority: "p3".to_owned(),
            range_start_utc_msc: floor + 30_000,
            range_end_utc_msc: floor + 40_000,
            window_msc: 5_000,
            now_utc_msc: 1_700_000_000_400,
        };
        let planned = store.plan_history_jobs(&p3).expect("p3 plan");
        let p3_job = planned.created_jobs.first().expect("p3 job").clone();
        let running = store
            .claim_history_job(&scope, 1_700_000_000_401, 50_000)
            .expect("p3 claim")
            .expect("p3 lease");
        store
            .checkpoint_history_job(
                &running.job_id,
                running.lease_generation,
                floor + 35_000,
                "35",
                2_500,
                1_700_000_000_402,
            )
            .expect("p3 checkpoint");
        let before = store
            .history_sync_job(&p3_job.job_id)
            .expect("before lookup")
            .expect("before job");
        let p1 = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "on_demand".to_owned(),
            priority: "p1".to_owned(),
            range_start_utc_msc: floor + 30_000,
            range_end_utc_msc: floor + 40_000,
            window_msc: 9_000,
            now_utc_msc: 1_700_000_000_403,
        };
        let promoted = store.plan_history_jobs(&p1).expect("promote exact");
        assert!(promoted.created_jobs.is_empty());
        assert_eq!(promoted.attached_jobs.len(), 1);
        let after = promoted.attached_jobs.first().expect("promoted job");
        assert_eq!(after.job_id, before.job_id);
        assert_eq!(after.priority, "p1");
        assert_eq!(after.lease_generation, before.lease_generation);
        assert_eq!(
            after.lease_expires_at_utc_msc,
            before.lease_expires_at_utc_msc
        );
        assert_eq!(after.cursor_time_msc, before.cursor_time_msc);
        assert_eq!(after.cursor_ticket, before.cursor_ticket);
        assert_eq!(after.window_msc, before.window_msc);
        assert_eq!(after.attempt_count, before.attempt_count);
        assert_eq!(
            after.next_attempt_at_utc_msc,
            before.next_attempt_at_utc_msc.min(p1.now_utc_msc)
        );
        assert_eq!(after.updated_at_utc_msc, p1.now_utc_msc);

        let legacy = history_job_for(
            "job_01JPLANLEGACY1",
            &scope,
            floor + 50_000,
            floor + 60_000,
            "p3",
        );
        let mut legacy = legacy;
        legacy.job_kind = "backfill".to_owned();
        store
            .enqueue_history_job(&legacy)
            .expect("legacy collision row");
        let collision = HistoryJobPlanningRequest {
            scope,
            job_kind: "on_demand".to_owned(),
            priority: "p1".to_owned(),
            range_start_utc_msc: floor + 50_000,
            range_end_utc_msc: floor + 60_000,
            window_msc: 1_000,
            now_utc_msc: floor - 1,
        };
        assert_eq!(
            store
                .plan_history_jobs(&collision)
                .expect_err("legacy exact collision")
                .code(),
            "bridge_store_history_planning_legacy_collision"
        );
        let legacy_after = store
            .history_sync_job(&legacy.job_id)
            .expect("legacy lookup")
            .expect("legacy row");
        assert_eq!(legacy_after.job_kind, "backfill");
        assert_eq!(legacy_after.priority, "p3");
        assert_eq!(legacy_after.state, "queued");
        drop(store);
        fs::remove_dir_all(root).expect("remove promotion planner fixture");
    }

    #[test]
    fn atomic_history_planner_requeues_old_blocked_dense_backfill_once() {
        let root = unique_test_directory("history-planner-dense-recovery");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("dense recovery planner store");
        let scope = history_scope_for("123456");
        let now = HISTORY_COVERAGE_START_UTC_MSC + 1_000_000;
        let range_start = HISTORY_COVERAGE_START_UTC_MSC + 10_000;
        let range_end = HISTORY_COVERAGE_START_UTC_MSC + 20_000;
        let old_window = 15 * 60 * 1_000;
        let job = store
            .enqueue_history_job(&NewHistorySyncJob {
                job_id: "job_01JDENSEREC01".to_owned(),
                scope: scope.clone(),
                job_kind: "backfill".to_owned(),
                priority: "p3".to_owned(),
                range_start_utc_msc: range_start,
                range_end_utc_msc: range_end,
                cursor_time_msc: range_start + 1_000,
                cursor_ticket: "100".to_owned(),
                window_msc: old_window,
                created_at_utc_msc: now,
            })
            .expect("enqueue old dense backfill");
        let running = store
            .claim_history_job(&scope, now + 1, 60_000)
            .expect("claim old dense backfill")
            .expect("old dense backfill lease");
        store
            .checkpoint_history_job(
                &running.job_id,
                running.lease_generation,
                range_start + 4_000,
                "400",
                old_window,
                now + 2,
            )
            .expect("checkpoint old dense backfill");
        store
            .block_history_job(
                &running.job_id,
                running.lease_generation,
                "blocked_dense_range",
                now + 3,
            )
            .expect("block old dense backfill");
        let before = store
            .history_sync_job(&job.job_id)
            .expect("old dense lookup")
            .expect("old dense row");
        assert_eq!(before.window_msc, old_window);
        assert_eq!(before.state, "blocked");
        assert_eq!(before.attempt_count, 1);

        let request = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "backfill".to_owned(),
            priority: "p3".to_owned(),
            range_start_utc_msc: range_start,
            range_end_utc_msc: range_end,
            window_msc: HISTORY_MIN_WINDOW_MSC,
            now_utc_msc: now + 4,
        };
        let resumed = store
            .plan_history_jobs(&request)
            .expect("requeue old dense backfill")
            .attached_jobs;
        assert_eq!(resumed.len(), 1);
        let resumed = &resumed[0];
        assert_eq!(resumed.job_id, before.job_id);
        assert_eq!(resumed.range_start_utc_msc, before.range_start_utc_msc);
        assert_eq!(resumed.range_end_utc_msc, before.range_end_utc_msc);
        assert_eq!(resumed.cursor_time_msc, before.cursor_time_msc);
        assert_eq!(resumed.cursor_ticket, before.cursor_ticket);
        assert_eq!(resumed.priority, before.priority);
        assert_eq!(resumed.attempt_count, before.attempt_count);
        assert_eq!(resumed.window_msc, HISTORY_MIN_WINDOW_MSC);
        assert_eq!(resumed.state, "queued");
        assert_eq!(resumed.last_error_code, None);
        assert_eq!(resumed.lease_generation, before.lease_generation);
        assert_eq!(resumed.lease_expires_at_utc_msc, None);
        assert_eq!(resumed.updated_at_utc_msc, request.now_utc_msc);

        let resumed_running = store
            .claim_history_job(&scope, now + 5, 60_000)
            .expect("claim resumed dense backfill")
            .expect("resumed dense backfill lease");
        assert_eq!(resumed_running.job_id, before.job_id);
        assert_eq!(resumed_running.window_msc, HISTORY_MIN_WINDOW_MSC);
        store
            .block_history_job(
                &resumed_running.job_id,
                resumed_running.lease_generation,
                "blocked_dense_range",
                now + 6,
            )
            .expect("block resumed dense backfill");
        let floor_blocked = store
            .history_sync_job(&job.job_id)
            .expect("floor blocked lookup")
            .expect("floor blocked row");
        assert_eq!(floor_blocked.window_msc, HISTORY_MIN_WINDOW_MSC);
        assert_eq!(floor_blocked.state, "blocked");
        assert_eq!(
            floor_blocked.last_error_code.as_deref(),
            Some("blocked_dense_range")
        );
        let attached = store
            .plan_history_jobs(&HistoryJobPlanningRequest {
                now_utc_msc: now + 7,
                ..request.clone()
            })
            .expect("floor blocked exact attachment")
            .attached_jobs;
        assert_eq!(attached, vec![floor_blocked.clone()]);
        assert_eq!(
            store
                .history_sync_job(&job.job_id)
                .expect("floor blocked after attachment")
                .expect("floor blocked after attachment row"),
            floor_blocked,
            "a floor-sized terminal row must not be revived repeatedly"
        );

        let other_scope = history_scope_for("654321");
        let other = store
            .plan_history_jobs(&HistoryJobPlanningRequest {
                scope: other_scope.clone(),
                now_utc_msc: now + 8,
                ..request.clone()
            })
            .expect("other account independent dense plan");
        assert!(other.attached_jobs.is_empty());
        assert_eq!(other.created_jobs.len(), 1);
        assert_eq!(other.created_jobs[0].scope, other_scope);

        let other_error_job = store
            .enqueue_history_job(&NewHistorySyncJob {
                job_id: "job_01JDENSEERR01".to_owned(),
                scope: scope.clone(),
                job_kind: "backfill".to_owned(),
                priority: "p3".to_owned(),
                range_start_utc_msc: range_start + 30_000,
                range_end_utc_msc: range_end + 30_000,
                cursor_time_msc: range_start + 30_000,
                cursor_ticket: String::new(),
                window_msc: old_window,
                created_at_utc_msc: now,
            })
            .expect("enqueue non-dense terminal row");
        let other_error_running = store
            .claim_history_job(&scope, now + 9, 60_000)
            .expect("claim non-dense terminal row")
            .expect("non-dense terminal row lease");
        assert_eq!(other_error_running.job_id, other_error_job.job_id);
        store
            .block_history_job(
                &other_error_running.job_id,
                other_error_running.lease_generation,
                "blocked_history_evidence_pending",
                now + 10,
            )
            .expect("block non-dense terminal row");
        assert_eq!(
            store
                .plan_history_jobs(&HistoryJobPlanningRequest {
                    scope,
                    range_start_utc_msc: range_start + 30_000,
                    range_end_utc_msc: range_end + 30_000,
                    now_utc_msc: now + 11,
                    ..request
                })
                .expect_err("non-dense terminal collision")
                .code(),
            "bridge_store_history_planning_legacy_collision"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove dense recovery planner fixture");
    }

    #[test]
    fn atomic_history_planner_attaches_modern_blocked_dense_backfill_without_mutation() {
        let root = unique_test_directory("history-planner-blocked-dense");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("blocked planner store");
        let scope = history_scope_for("123456");
        let now = HISTORY_COVERAGE_START_UTC_MSC + 1_000_000;
        let range_start = HISTORY_COVERAGE_START_UTC_MSC + 10_000;
        let range_end = HISTORY_COVERAGE_START_UTC_MSC + 20_000;
        let backfill = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "backfill".to_owned(),
            priority: "p3".to_owned(),
            range_start_utc_msc: range_start,
            range_end_utc_msc: range_end,
            window_msc: HISTORY_MIN_WINDOW_MSC,
            now_utc_msc: now,
        };
        let created = store
            .plan_history_jobs(&backfill)
            .expect("create modern backfill")
            .created_jobs
            .pop()
            .expect("modern backfill job");
        let running = store
            .claim_history_job(&scope, now + 1, 60_000)
            .expect("claim modern backfill")
            .expect("modern backfill lease");
        store
            .block_history_job(
                &running.job_id,
                running.lease_generation,
                "blocked_dense_range",
                now + 2,
            )
            .expect("block dense modern backfill");
        let before = store
            .history_sync_job(&created.job_id)
            .expect("blocked backfill lookup")
            .expect("blocked backfill row");
        assert_eq!(before.job_kind, "backfill");
        assert_eq!(before.state, "blocked");
        assert_eq!(
            before.last_error_code.as_deref(),
            Some("blocked_dense_range")
        );

        let on_demand = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "on_demand".to_owned(),
            priority: "p1".to_owned(),
            range_start_utc_msc: range_start,
            range_end_utc_msc: range_end,
            window_msc: 9_000,
            now_utc_msc: now + 3,
        };
        let attached = store
            .plan_history_jobs(&on_demand)
            .expect("attach blocked dense backfill")
            .attached_jobs;
        assert_eq!(attached, vec![before.clone()]);
        let after = store
            .history_sync_job(&created.job_id)
            .expect("blocked backfill after attach lookup")
            .expect("blocked backfill after attach");
        assert_eq!(
            after, before,
            "exact attachment must not mutate terminal job"
        );

        let replan = store
            .plan_history_jobs(&backfill)
            .expect("automatic backfill replan attachment")
            .attached_jobs;
        assert_eq!(replan, vec![before.clone()]);

        // A different account may plan the same range independently; the
        // blocked row above must not leak across the history scope key.
        let other_scope = history_scope_for("654321");
        let other = HistoryJobPlanningRequest {
            scope: other_scope,
            ..on_demand
        };
        let other_result = store
            .plan_history_jobs(&other)
            .expect("other account remains independent");
        assert_eq!(other_result.attached_jobs, Vec::new());
        assert_eq!(other_result.created_jobs.len(), 1);
        assert_eq!(other_result.created_jobs[0].job_kind, "on_demand");
        drop(store);
        fs::remove_dir_all(root).expect("remove blocked planner fixture");
    }

    #[test]
    fn atomic_history_planner_promotion_releases_future_retry_without_clearing_state() {
        let root = unique_test_directory("history-planner-retry-promotion");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("retry promotion planner store");
        let scope = history_scope_for("654321");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let p3 = HistoryJobPlanningRequest {
            scope: scope.clone(),
            job_kind: "on_demand".to_owned(),
            priority: "p3".to_owned(),
            range_start_utc_msc: floor + 70_000,
            range_end_utc_msc: floor + 80_000,
            window_msc: 5_000,
            now_utc_msc: 1_700_000_000_500,
        };
        let planned = store.plan_history_jobs(&p3).expect("p3 plan");
        let job = planned.created_jobs.first().expect("p3 job").clone();
        let running = store
            .claim_history_job(&scope, 1_700_000_000_501, 50_000)
            .expect("p3 claim")
            .expect("p3 lease");
        store
            .checkpoint_history_job(
                &running.job_id,
                running.lease_generation,
                floor + 75_000,
                "75",
                2_500,
                1_700_000_000_502,
            )
            .expect("p3 checkpoint");
        store
            .retry_history_job(
                &running.job_id,
                running.lease_generation,
                1_700_001_000_000,
                "bridge_store_history_retry",
                1_700_000_000_503,
            )
            .expect("future retry");
        let before = store
            .history_sync_job(&job.job_id)
            .expect("before lookup")
            .expect("before job");
        assert_eq!(before.state, "retrying");
        assert!(before.next_attempt_at_utc_msc > 1_700_000_000_504);

        let p1 = HistoryJobPlanningRequest {
            scope,
            job_kind: "on_demand".to_owned(),
            priority: "p1".to_owned(),
            range_start_utc_msc: floor + 70_000,
            range_end_utc_msc: floor + 80_000,
            window_msc: 9_000,
            now_utc_msc: 1_700_000_000_504,
        };
        let promoted = store.plan_history_jobs(&p1).expect("p1 promotion");
        let after = promoted.attached_jobs.first().expect("promoted job");
        assert_eq!(after.job_id, before.job_id);
        assert_eq!(after.priority, "p1");
        assert_eq!(after.next_attempt_at_utc_msc, p1.now_utc_msc);
        assert_eq!(after.updated_at_utc_msc, p1.now_utc_msc);
        assert_eq!(after.last_error_code, before.last_error_code);
        assert_eq!(after.cursor_time_msc, before.cursor_time_msc);
        assert_eq!(after.cursor_ticket, before.cursor_ticket);
        assert_eq!(after.window_msc, before.window_msc);
        assert_eq!(after.attempt_count, before.attempt_count);
        assert_eq!(after.lease_generation, before.lease_generation);
        assert_eq!(
            after.lease_expires_at_utc_msc,
            before.lease_expires_at_utc_msc
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove retry promotion planner fixture");
    }

    #[test]
    fn history_page_reader_isolated_from_uncommitted_writer_and_cannot_write() {
        let root = unique_test_directory("history-read-connection");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("read connection store");
        let terminal = history_terminal("123456");
        let committed_time = 1_800_000_000_000_i64;
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![serde_json::json!({
                        "deal_ticket": 8001,
                        "close_time_msc": committed_time,
                        "profit": 1.0,
                    })],
                    next_cursor: HistoryCursor {
                        time_msc: committed_time,
                        ticket: "8001".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: committed_time,
                },
            )
            .expect("committed history row");

        let mut writer = store.connection.lock().expect("writer lock");
        let transaction = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("uncommitted writer transaction");
        transaction
            .execute(
                "INSERT INTO history_archive_items (
                   terminal_instance_id, broker_server, login_account, platform,
                   item_kind, item_id, event_time_msc, position_id, order_ticket,
                   symbol, payload_json, updated_at_utc_msc
                 ) VALUES (?1, ?2, ?3, 'mt5', 'trade', '8002', ?4,
                           NULL, NULL, NULL, ?5, ?4);",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    committed_time + 1_000,
                    serde_json::json!({
                        "deal_ticket": 8002,
                        "close_time_msc": committed_time + 1_000,
                        "profit": 2.0,
                    })
                    .to_string(),
                ],
            )
            .expect("uncommitted history row");

        let started = Instant::now();
        let page = store
            .read_history_archive_page_at(&terminal, &serde_json::json!({}), committed_time + 2_000)
            .expect("reader sees committed snapshot");
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(page["pagination"]["total_count"], 1);
        assert_eq!(page["orders"][0]["deal_ticket"], 8001);
        {
            let reader = store.history_read_connection.lock().expect("reader lock");
            assert!(
                reader
                    .execute(
                        "UPDATE history_archive_items SET payload_json = payload_json WHERE 1 = 0;",
                        [],
                    )
                    .is_err(),
                "history reader must remain read-only"
            );
        }
        transaction.rollback().expect("rollback uncommitted row");
        drop(writer);
        drop(store);
        fs::remove_dir_all(root).expect("remove read connection fixture");
    }

    #[test]
    fn history_sync_metadata_reports_requested_coverage_and_preserves_mt4_contract() {
        let root = unique_test_directory("history-sync-metadata");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let terminal = history_terminal("123456");
        let day_one = parse_utc_date_msc("2026-01-01").expect("day one");
        let day_two = parse_utc_date_msc("2026-01-02").expect("day two");
        let day_three = parse_utc_date_msc("2026-01-03").expect("day three");
        let day_four = parse_utc_date_msc("2026-01-04").expect("day four");
        {
            let connection = store.connection.lock().expect("coverage lock");
            connection
                .execute(
                    "INSERT INTO history_coverage_ranges (
                       terminal_instance_id, broker_server, login_account,
                       range_start_utc_msc, range_end_utc_msc,
                       observed_at_utc_msc, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7),
                              (?1, ?2, ?3, ?5, ?8, ?6, ?7);",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        day_one,
                        day_two,
                        1_700_000_000_000_i64,
                        1_700_000_000_100_i64,
                        day_three,
                    ],
                )
                .expect("coverage fixture");
        }
        let contiguous = store
            .read_history_archive_page_at(
                &terminal,
                &serde_json::json!({
                    "date_from": "2026-01-01",
                    "date_to": "2026-01-02",
                    "page": 1,
                }),
                day_four,
            )
            .expect("contiguous metadata");
        assert_eq!(contiguous["history_sync"]["complete"], false);
        assert_eq!(contiguous["history_sync"]["requested_range_complete"], true);
        assert_eq!(
            contiguous["history_sync"]["requested_range_start_utc_msc"],
            day_one
        );
        assert_eq!(
            contiguous["history_sync"]["requested_range_end_utc_msc"],
            day_three
        );
        assert_eq!(
            contiguous["history_sync"]["coverage_start_utc_msc"],
            day_one
        );
        assert_eq!(
            contiguous["history_sync"]["coverage_end_utc_msc"],
            day_three
        );
        assert_eq!(
            contiguous["history_sync"]["last_progress_at_utc_msc"],
            1_700_000_000_100_i64
        );
        assert_eq!(contiguous["history_sync"]["evidence_truncated"], false);
        let contiguous_page_two = store
            .read_history_archive_page_at(
                &terminal,
                &serde_json::json!({
                    "date_from": "2026-01-01",
                    "date_to": "2026-01-02",
                    "page": 2,
                }),
                day_four,
            )
            .expect("second page metadata");
        assert_eq!(
            contiguous_page_two["history_sync"]["requested_range_end_utc_msc"],
            contiguous["history_sync"]["requested_range_end_utc_msc"]
        );
        assert_eq!(
            contiguous_page_two["history_sync"]["requested_range_complete"],
            contiguous["history_sync"]["requested_range_complete"]
        );

        let hole = store
            .read_history_chart_data_at(
                &terminal,
                &serde_json::json!({
                    "date_from": "2026-01-01",
                    "range_end_utc_msc": day_four,
                }),
                day_four,
            )
            .expect("hole metadata");
        assert_eq!(hole["history_sync"]["requested_range_complete"], false);
        assert_eq!(
            hole["history_sync"]["coverage_start_utc_msc"],
            serde_json::Value::Null
        );
        assert_eq!(
            hole["history_sync"]["coverage_end_utc_msc"],
            serde_json::Value::Null
        );
        assert_eq!(hole["history_sync"]["backfill_pending"], true);
        assert_eq!(
            hole["history_sync"]["requested_range_end_utc_msc"],
            day_four
        );

        let no_range = store
            .read_history_chart_data_at(&terminal, &serde_json::json!({}), day_four)
            .expect("unbounded metadata");
        assert_eq!(
            no_range["history_sync"]["requested_range_complete"],
            serde_json::Value::Null
        );
        assert_eq!(
            no_range["history_sync"]["requested_range_start_utc_msc"],
            serde_json::Value::Null
        );
        assert_eq!(no_range["history_sync"]["archive_complete"], false);

        let mut mt4 = terminal.clone();
        mt4.platform = "mt4".to_owned();
        {
            let connection = store.connection.lock().expect("legacy state lock");
            connection
                .execute(
                    "INSERT INTO history_archive_state (
                       terminal_instance_id, broker_server, login_account,
                       cursor_value, is_complete, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, 1, ?5);",
                    params![
                        mt4.terminal_instance_id,
                        mt4.account_ref.broker_server,
                        mt4.account_ref.login,
                        serde_json::json!({ "time_msc": day_three, "ticket": "0" }).to_string(),
                        1_700_000_001_000_i64,
                    ],
                )
                .expect("legacy state fixture");
        }
        let mt4_page = store
            .read_history_archive_page_at(
                &mt4,
                &serde_json::json!({
                    "date_from": "2026-01-01",
                    "date_to": "2026-01-02",
                }),
                day_four,
            )
            .expect("mt4 metadata");
        assert_eq!(mt4_page["history_sync"]["complete"], true);
        assert_eq!(mt4_page["history_sync"]["archive_complete"], false);
        assert_eq!(mt4_page["history_sync"]["requested_range_complete"], false);
        assert_eq!(
            mt4_page["history_sync"]["terminal_visible_history_complete"],
            true
        );
        assert_eq!(mt4_page["history_sync"]["history_source_complete"], false);
        assert_eq!(
            mt4_page["history_sync"]["history_source_note"],
            MT4_HISTORY_SOURCE_NOTE
        );

        let cursor_parameters = serde_json::json!({
            "range_start_utc_msc": day_one,
            "range_end_utc_msc": day_three,
            "page_size": 20,
        });
        let cursor_page = store
            .read_history_cursor_page_at(&mt4, &cursor_parameters, day_four)
            .expect("mt4 terminal-visible cursor snapshot");
        let snapshot_id = cursor_page["history_snapshot_id"]
            .as_str()
            .expect("mt4 snapshot id")
            .to_owned();
        store
            .mark_mt4_history_rescan_pending(&mt4, day_four + 1)
            .expect("mark mt4 history pending");
        assert!(
            !store
                .history_archive_state(&mt4.terminal_instance_id, &mt4.account_ref)
                .expect("pending state")
                .is_complete
        );
        let mut continuation = cursor_parameters;
        continuation["snapshot_id"] = serde_json::Value::String(snapshot_id);
        assert_eq!(
            store
                .read_history_cursor_page_at(&mt4, &continuation, day_four + 1)
                .expect_err("pending MT4 snapshot must be invalidated")
                .code(),
            "history_snapshot_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove metadata fixture");
    }

    #[test]
    fn mt4_rescan_marker_resets_cursor_and_all_platforms_reject_regression() {
        let root = unique_test_directory("mt4-history-rescan-regression");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("rescan store");
        let mut mt4 = history_terminal("123456");
        mt4.platform = "mt4".to_owned();
        let mt5 = history_terminal("654321");
        {
            let connection = store.connection.lock().expect("rescan state lock");
            for terminal in [&mt4, &mt5] {
                connection
                    .execute(
                        "INSERT INTO history_archive_state (
                           terminal_instance_id, broker_server, login_account,
                           cursor_value, is_complete, updated_at_utc_msc
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
                        params![
                            terminal.terminal_instance_id,
                            terminal.account_ref.broker_server,
                            terminal.account_ref.login,
                            serde_json::json!({
                                "time_msc": HISTORY_COVERAGE_START_UTC_MSC + 100_000,
                                "ticket": "100"
                            })
                            .to_string(),
                            1,
                            1_700_000_000_000_i64,
                        ],
                    )
                    .expect("rescan state fixture");
            }
        }
        let regressed = HistoryArchiveBatch {
            deals: Vec::new(),
            history_orders: Vec::new(),
            trades: vec![serde_json::json!({
                "deal_ticket": 9001,
                "close_time_msc": HISTORY_COVERAGE_START_UTC_MSC + 10_000,
                "profit": 1.0,
            })],
            next_cursor: HistoryCursor {
                time_msc: HISTORY_COVERAGE_START_UTC_MSC + 10_000,
                ticket: "10".to_owned(),
            },
            has_more: true,
            observed_at_utc_msc: 1_700_000_000_100,
        };
        store
            .mark_mt4_history_rescan_pending(&mt4, 1_700_000_000_050)
            .expect("mark MT4 rescan pending");
        assert_eq!(
            store
                .history_archive_state(&mt4.terminal_instance_id, &mt4.account_ref)
                .expect("mt4 state")
                .cursor,
            HistoryCursor {
                time_msc: HISTORY_COVERAGE_START_UTC_MSC,
                ticket: "0".to_owned(),
            }
        );
        store
            .persist_history_archive_batch(&mt4, &regressed)
            .expect("MT4 rescan advances from the reset boundary");
        assert_eq!(
            store
                .persist_history_archive_batch(&mt5, &regressed)
                .expect_err("mt5 cursor regression must fail closed")
                .code(),
            "bridge_store_history_cursor_regression"
        );
        assert_eq!(
            store
                .mark_mt4_history_rescan_pending(&mt5, 1_700_000_000_200)
                .expect_err("MT5 cannot use the MT4 rescan marker")
                .code(),
            "bridge_store_history_platform_invalid"
        );
        assert_eq!(
            store
                .mark_mt4_history_rescan_pending(&mt4, 0)
                .expect_err("invalid rescan timestamp")
                .code(),
            "bridge_store_history_state_timestamp_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove rescan fixture");
    }

    #[test]
    fn history_job_yield_is_priority_handoff_without_retry_side_effects() {
        let root = unique_test_directory("history-job-yield");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let p2 = history_job_for("job_01JYIELD0001", &scope, 1_000, 2_000, "p2");
        store.enqueue_history_job(&p2).expect("p2 enqueue");
        let running = store
            .claim_history_job(&scope, 1_700_000_000_001, 10_000)
            .expect("p2 claim")
            .expect("p2 running");
        let before = running.clone();
        assert!(
            !store
                .yield_history_job_if_higher_priority_waiting(
                    &running.job_id,
                    running.lease_generation,
                    1_700_000_000_002,
                )
                .expect("no p1")
        );

        let p1 = history_job_for("job_01JYIELD0002", &scope, 2_000, 3_000, "p1");
        store.enqueue_history_job(&p1).expect("p1 enqueue");
        assert!(
            store
                .yield_history_job_if_higher_priority_waiting(
                    &running.job_id,
                    running.lease_generation,
                    1_700_000_000_003,
                )
                .expect("yield p2")
        );
        let yielded = store
            .history_sync_job(&running.job_id)
            .expect("yielded lookup")
            .expect("yielded job");
        assert_eq!(yielded.state, "queued");
        assert_eq!(yielded.lease_expires_at_utc_msc, None);
        assert_eq!(yielded.next_attempt_at_utc_msc, 1_700_000_000_003);
        assert_eq!(yielded.cursor_time_msc, before.cursor_time_msc);
        assert_eq!(yielded.cursor_ticket, before.cursor_ticket);
        assert_eq!(yielded.window_msc, before.window_msc);
        assert_eq!(yielded.attempt_count, before.attempt_count);
        assert_eq!(yielded.last_error_code, before.last_error_code);
        let next = store
            .claim_history_job(&scope, 1_700_000_000_004, 10_000)
            .expect("p1 claim")
            .expect("p1 running");
        assert_eq!(next.job_id, p1.job_id);

        let stale_generation = store
            .yield_history_job_if_higher_priority_waiting(
                &next.job_id,
                next.lease_generation - 1,
                1_700_000_000_005,
            )
            .expect_err("stale generation");
        assert_eq!(
            stale_generation.code(),
            "bridge_store_history_lease_invalid"
        );

        let expiring = history_job_for("job_01JYIELD0003", &scope, 3_000, 4_000, "p2");
        store
            .enqueue_history_job(&expiring)
            .expect("expiring enqueue");
        let expiring = store
            .claim_history_job(&scope, 1_700_000_000_006, 10)
            .expect("expiring claim")
            .expect("expiring running");
        let expired = store
            .yield_history_job_if_higher_priority_waiting(
                &expiring.job_id,
                expiring.lease_generation,
                1_700_000_000_017,
            )
            .expect_err("expired lease");
        assert_eq!(expired.code(), "bridge_store_history_lease_invalid");
        drop(store);
        fs::remove_dir_all(root).expect("remove yield fixture");
    }

    #[test]
    fn history_p1_promotion_is_atomic_and_does_not_reset_completed_or_blocked_jobs() {
        let root = unique_test_directory("history-p1-promotion");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");

        let queued = history_job_for("job_01JPROMOTE001", &scope, 1_000, 2_000, "p2");
        store.enqueue_history_job(&queued).expect("queued p2");
        {
            let connection = store.connection.lock().expect("queued lock");
            connection
                .execute(
                    "UPDATE history_sync_jobs SET next_attempt_at_utc_msc = ?1
                     WHERE job_id = ?2;",
                    params![1_700_000_000_300_i64, queued.job_id],
                )
                .expect("future retry timestamp");
        }
        let mut queued_p1 = queued.clone();
        queued_p1.job_id = "job_01JPROMOTE002".to_owned();
        queued_p1.job_kind = "on_demand".to_owned();
        queued_p1.priority = "p1".to_owned();
        queued_p1.created_at_utc_msc = 1_700_000_000_200;
        queued_p1.cursor_time_msc = 1_000;
        queued_p1.window_msc = 250;
        let promoted = store
            .enqueue_or_promote_history_job(&queued_p1)
            .expect("queued p1 promotion");
        assert_eq!(promoted.job_id, queued.job_id);
        assert_eq!(promoted.priority, "p1");
        assert_eq!(
            promoted.next_attempt_at_utc_msc,
            queued_p1.created_at_utc_msc
        );
        assert_eq!(promoted.cursor_time_msc, queued.cursor_time_msc);
        assert_eq!(promoted.window_msc, queued.window_msc);
        let claimed = store
            .claim_history_job(&scope, queued_p1.created_at_utc_msc, 10_000)
            .expect("claim promoted p1")
            .expect("promoted claim");
        assert_eq!(claimed.job_id, queued.job_id);
        assert_eq!(claimed.priority, "p1");

        let running = history_job_for("job_01JPROMOTE003", &scope, 2_000, 3_000, "p2");
        store.enqueue_history_job(&running).expect("running p2");
        let running = store
            .claim_history_job(&scope, 1_700_000_001_000, 10_000)
            .expect("claim running p2")
            .expect("running job");
        store
            .checkpoint_history_job(
                &running.job_id,
                running.lease_generation,
                2_500,
                "55",
                500,
                1_700_000_001_100,
            )
            .expect("running checkpoint");
        let running_before = store
            .history_sync_job(&running.job_id)
            .expect("running lookup")
            .expect("running row");
        let mut running_p1 = history_job_for("job_01JPROMOTE004", &scope, 2_000, 3_000, "p1");
        running_p1.created_at_utc_msc = 1_700_000_001_200;
        let promoted_running = store
            .enqueue_or_promote_history_job(&running_p1)
            .expect("running p1 promotion");
        assert_eq!(promoted_running.state, "running");
        assert_eq!(promoted_running.priority, "p1");
        assert_eq!(
            promoted_running.lease_generation,
            running_before.lease_generation
        );
        assert_eq!(
            promoted_running.lease_expires_at_utc_msc,
            running_before.lease_expires_at_utc_msc
        );
        assert_eq!(promoted_running.cursor_time_msc, 2_500);
        assert_eq!(promoted_running.cursor_ticket, "55");
        assert_eq!(promoted_running.window_msc, 500);
        assert_eq!(promoted_running.attempt_count, running_before.attempt_count);

        let completed = history_job_for("job_01JPROMOTE005", &scope, 3_000, 4_000, "p2");
        store.enqueue_history_job(&completed).expect("completed p2");
        let completed_claim = store
            .claim_history_job(&scope, 1_700_000_002_000, 10_000)
            .expect("claim completed p2")
            .expect("completed lease");
        let terminal = history_terminal_for(&scope);
        let completed_result = store
            .persist_history_job_batch(
                &terminal,
                &completed_claim.job_id,
                completed_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 4_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_002_100,
                },
                1_000,
                1_700_000_002_100,
            )
            .expect("completed batch");
        let completed_p1 = history_job_for("job_01JPROMOTE006", &scope, 3_000, 4_000, "p1");
        let existing_completed = store
            .enqueue_or_promote_history_job(&completed_p1)
            .expect("completed remains immutable");
        assert_eq!(existing_completed.job_id, completed_result.job.job_id);
        assert_eq!(existing_completed.state, "completed");
        assert_eq!(existing_completed.priority, "p2");
        assert_eq!(
            existing_completed.attempt_count,
            completed_result.job.attempt_count
        );

        let blocked = history_job_for("job_01JPROMOTE007", &scope, 4_000, 5_000, "p2");
        store.enqueue_history_job(&blocked).expect("blocked p2");
        let blocked_claim = store
            .claim_history_job(&scope, 1_700_000_003_000, 10_000)
            .expect("claim blocked p2")
            .expect("blocked lease");
        store
            .block_history_job(
                &blocked_claim.job_id,
                blocked_claim.lease_generation,
                "history_range_invalid",
                1_700_000_003_100,
            )
            .expect("block p2");
        let blocked_p1 = history_job_for("job_01JPROMOTE008", &scope, 4_000, 5_000, "p1");
        assert_eq!(
            store
                .enqueue_or_promote_history_job(&blocked_p1)
                .expect_err("blocked promotion rejected")
                .code(),
            "bridge_store_history_job_promotion_invalid"
        );
        assert_eq!(
            store
                .history_sync_job(&blocked_claim.job_id)
                .expect("blocked lookup")
                .expect("blocked row")
                .state,
            "blocked"
        );

        let mut same_id_wrong_range = queued.clone();
        same_id_wrong_range.priority = "p1".to_owned();
        same_id_wrong_range.range_end_utc_msc = 2_500;
        same_id_wrong_range.created_at_utc_msc = 1_700_000_003_200;
        assert_eq!(
            store
                .enqueue_or_promote_history_job(&same_id_wrong_range)
                .expect_err("same id range mismatch rejected")
                .code(),
            "bridge_store_history_job_conflict"
        );

        let mut ordinary_conflict = queued.clone();
        ordinary_conflict.window_msc = queued.window_msc + 1;
        assert_eq!(
            store
                .enqueue_or_promote_history_job(&ordinary_conflict)
                .expect_err("ordinary enqueue retains immutable contract")
                .code(),
            "bridge_store_history_job_conflict"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove promotion fixture");
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

    fn history_terminal_for(scope: &HistoryScope) -> TerminalDescriptor {
        TerminalDescriptor {
            terminal_instance_id: scope.terminal_instance_id.clone(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: scope.broker_server.clone(),
                login: scope.login_account.clone(),
            },
            connection_epoch: 3,
            worker_version: Some("3.0.0".to_owned()),
        }
    }

    fn normalized_trade(
        ticket: i64,
        event_time_msc: i64,
        direction: &str,
        profit: f64,
        volume: f64,
    ) -> serde_json::Value {
        serde_json::json!({
            "deal_ticket": ticket,
            "ticket": ticket,
            "time_msc": event_time_msc,
            "entry_time_utc_msc": event_time_msc,
            "close_time_utc_msc": event_time_msc,
            "close_time_server_msc": event_time_msc,
            "close_timezone_offset_minutes": 0,
            "close_business_date": business_date_from_server_msc(event_time_msc)
                .expect("normalized trade business date"),
            "close_deal_ticket": ticket,
            "type": direction,
            "profit": profit,
            "volume": volume,
            "symbol": "EURUSD",
        })
    }

    #[test]
    fn trade_pages_filter_and_order_by_immutable_close_time() {
        let root = unique_test_directory("history-close-time-page");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("close-time store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let rows = [
            (1_i64, floor + 100, floor + 300),
            (2_i64, floor + 200, floor + 100),
            (3_i64, floor + 50, floor + 200),
        ];
        {
            let connection = store.connection.lock().expect("close-time lock");
            for (ticket, event_time, close_time) in rows {
                let payload = serde_json::json!({
                    "deal_ticket": ticket,
                    "ticket": ticket,
                    "entry_time_utc_msc": event_time,
                    "close_time_utc_msc": close_time,
                    "close_time_server_msc": close_time,
                    "close_timezone_offset_minutes": 0,
                    "close_business_date": business_date_from_server_msc(close_time)
                        .expect("close business date"),
                    "profit": ticket as f64,
                    "volume": 0.1,
                });
                connection
                    .execute(
                        "INSERT INTO history_archive_items (
                           terminal_instance_id, broker_server, login_account, platform,
                           item_kind, item_id, event_time_msc, payload_json,
                           close_time_utc_msc, close_time_server_msc,
                           close_timezone_offset_minutes, close_business_date,
                           immutable_state, updated_at_utc_msc
                         ) VALUES (?1, ?2, ?3, ?4, 'trade', ?5, ?6, ?7, ?8, ?8, 0, ?9,
                                   'sealed', ?8);",
                        params![
                            terminal.terminal_instance_id,
                            terminal.account_ref.broker_server,
                            terminal.account_ref.login,
                            terminal.platform,
                            ticket.to_string(),
                            event_time,
                            payload.to_string(),
                            close_time,
                            business_date_from_server_msc(close_time).expect("close business date"),
                        ],
                    )
                    .expect("close-time row");
            }
        }
        let page = store
            .read_history_archive_page_at(
                &terminal,
                &serde_json::json!({
                    "range_start_utc_msc": floor,
                    "range_end_utc_msc": floor + 1_000,
                    "filter_close_from": floor + 200,
                    "page_size": 20,
                }),
                floor + 2_000,
            )
            .expect("close-time page");
        assert_eq!(page["pagination"]["total_count"], 2);
        let orders = page["orders"].as_array().expect("trade page orders");
        assert_eq!(orders[0]["deal_ticket"], 1);
        assert_eq!(orders[1]["deal_ticket"], 3);
        drop(store);
        fs::remove_dir_all(root).expect("remove close-time fixture");
    }

    #[test]
    fn trade_close_filters_use_utc_even_when_server_business_date_crosses_day() {
        let root = unique_test_directory("history-close-utc-offset");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("close offset store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let close_before_midnight = floor + 86_400_000 - 30_000;
        let close_after_midnight = floor + 86_400_000 + 30_000;
        let trade = |ticket: i64, close_utc: i64, server_utc: i64| {
            serde_json::json!({
                "deal_ticket": ticket,
                "ticket": ticket,
                "entry_time_utc_msc": close_utc,
                "close_time_utc_msc": close_utc,
                "close_time_server_msc": server_utc,
                "close_timezone_offset_minutes": (server_utc - close_utc) / 60_000,
                "close_business_date": business_date_from_server_msc(server_utc)
                    .expect("offset business date"),
                "type": "BUY",
                "profit": ticket as f64,
                "volume": 0.1,
            })
        };
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![
                        trade(
                            1,
                            close_before_midnight,
                            close_before_midnight + 2 * 3_600_000,
                        ),
                        trade(
                            2,
                            close_after_midnight,
                            close_after_midnight - 2 * 3_600_000,
                        ),
                    ],
                    next_cursor: HistoryCursor {
                        time_msc: close_after_midnight,
                        ticket: "2".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: close_after_midnight + 1_000,
                },
            )
            .expect("offset trades");
        let page = store
            .read_history_archive_page_at(
                &terminal,
                &serde_json::json!({
                    "date_from": "2000-01-02",
                    "date_to": "2000-01-02",
                    "filter_close_from": close_after_midnight,
                    "filter_close_to": close_after_midnight,
                    "entry_from": close_after_midnight,
                    "entry_to": close_after_midnight,
                    "page_size": 20,
                }),
                close_after_midnight + 2_000,
            )
            .expect("offset close page");
        assert_eq!(page["pagination"]["total_count"], 1);
        assert_eq!(page["orders"][0]["deal_ticket"], 2);
        drop(store);
        fs::remove_dir_all(root).expect("remove close offset fixture");
    }

    #[test]
    fn summary_v2_is_default_and_v1_fallback_is_explicit() {
        let root = unique_test_directory("history-summary-v2-source");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("summary source store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let close_utc = floor + 86_400_000 - 30 * 60_000;
        let close_server = close_utc + 3 * 60 * 60_000;
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![serde_json::json!({
                        "deal_ticket": 9001,
                        "ticket": 9001,
                        "entry_time_utc_msc": close_utc,
                        "close_time_utc_msc": close_utc,
                        "close_time_server_msc": close_server,
                        "close_timezone_offset_minutes": 180,
                        "close_business_date": business_date_from_server_msc(close_server)
                            .expect("server business date"),
                        "type": "BUY",
                        "profit": 7.0,
                        "volume": 0.7,
                    })],
                    next_cursor: HistoryCursor {
                        time_msc: close_utc,
                        ticket: "9001".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: close_utc + 1_000,
                },
            )
            .expect("summary source batch");
        store
            .ensure_history_summary(&terminal, close_utc + 2_000)
            .expect("summary source ready");
        let page = store
            .read_history_archive_page_at(&terminal, &serde_json::json!({}), close_utc + 3_000)
            .expect("v2 summary page");
        assert_eq!(page["statistics"]["summary_source"], "sqlite_summary_v2");
        assert_eq!(page["statistics"]["time_semantics"], "server_business_date");
        assert_eq!(page["history_sync"]["summary_source"], "sqlite_summary_v2");
        assert_eq!(
            page["history_sync"]["time_semantics"],
            "server_business_date"
        );
        let chart = store
            .read_history_chart_data_at(&terminal, &serde_json::json!({}), close_utc + 3_000)
            .expect("v2 summary chart");
        assert_eq!(chart["summary_source"], "sqlite_summary_v2");
        assert_eq!(chart["time_semantics"], "server_business_date");
        assert_eq!(chart["daily"][0]["date"], "2000-01-02");

        let generation = {
            let connection = store.connection.lock().expect("summary source lock");
            connection
                .query_row(
                    "SELECT active_generation FROM history_summary_builds
                     WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4;",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .expect("summary source generation")
        };
        {
            let connection = store
                .connection
                .lock()
                .expect("summary source mismatch lock");
            connection
                .execute(
                    "UPDATE history_daily_summary_v2 SET generation = ?1
                     WHERE terminal_instance_id = ?2 AND broker_server = ?3 COLLATE NOCASE
                       AND login_account = ?4 AND platform = ?5 AND generation = ?6;",
                    params![
                        generation + 1,
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                        generation,
                    ],
                )
                .expect("mismatch v2 generation");
        }
        let fallback = store
            .read_history_archive_page_at(&terminal, &serde_json::json!({}), close_utc + 4_000)
            .expect("v1 fallback page");
        assert_eq!(
            fallback["statistics"]["summary_source"],
            "sqlite_summary_v1"
        );
        assert_eq!(fallback["statistics"]["time_semantics"], "legacy_utc_day");
        assert_eq!(
            fallback["history_sync"]["summary_source"],
            "sqlite_summary_v1"
        );
        assert_eq!(fallback["history_sync"]["time_semantics"], "legacy_utc_day");
        drop(store);
        fs::remove_dir_all(root).expect("remove summary source fixture");
    }

    #[test]
    fn summary_v2_exact_range_uses_close_utc_raw_edges_for_timezone_offsets() {
        let root = unique_test_directory("history-summary-v2-range-offset");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("summary range store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let older_close_utc = floor + 86_400_000 + 10_000;
        let target_close_utc = floor + 2 * 86_400_000 + 10_000;
        let make_trade = |ticket: i64, close_utc: i64, offset_minutes: i64| {
            let server = close_utc + offset_minutes * 60_000;
            serde_json::json!({
                "deal_ticket": ticket,
                "ticket": ticket,
                "entry_time_utc_msc": close_utc,
                "close_time_utc_msc": close_utc,
                "close_time_server_msc": server,
                "close_timezone_offset_minutes": offset_minutes,
                "close_business_date": business_date_from_server_msc(server)
                    .expect("offset business date"),
                "type": "BUY",
                "profit": ticket as f64,
                "volume": 0.1,
            })
        };
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![
                        make_trade(9101, older_close_utc, -300),
                        make_trade(9102, target_close_utc, 180),
                    ],
                    next_cursor: HistoryCursor {
                        time_msc: target_close_utc,
                        ticket: "9102".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: target_close_utc + 1_000,
                },
            )
            .expect("offset range batch");
        store
            .ensure_history_summary(&terminal, target_close_utc + 2_000)
            .expect("offset range summary");
        let chart = store
            .read_history_chart_data_at(
                &terminal,
                &serde_json::json!({
                    "range_start_utc_msc": target_close_utc - 1,
                    "range_end_utc_msc": target_close_utc + 1,
                }),
                target_close_utc + 3_000,
            )
            .expect("offset range chart");
        assert_eq!(chart["summary_source"], "sqlite_archive_raw_close_time");
        assert_eq!(chart["time_semantics"], "exact_close_utc");
        assert_eq!(
            chart["history_sync"]["summary_source"],
            "sqlite_archive_raw_close_time"
        );
        assert_eq!(chart["history_sync"]["time_semantics"], "exact_close_utc");
        assert_eq!(chart["stats"]["total_trades"], 1);
        assert_eq!(chart["stats"]["gross_profit"], 9102.0);
        assert_eq!(chart["daily"].as_array().expect("offset daily").len(), 1);
        assert_eq!(
            chart["daily"][0]["date"],
            business_date_from_server_msc(target_close_utc + 180 * 60_000)
                .expect("target business date")
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove offset range fixture");
    }

    #[test]
    fn legacy_history_scalars_migrate_backfill_and_respect_2000_summary_floor() {
        let root = unique_test_directory("history-scalar-migration");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        let terminal = history_terminal("123456");
        let old_time = HISTORY_COVERAGE_START_UTC_MSC - 86_400_000;
        let current_time = HISTORY_COVERAGE_START_UTC_MSC + 86_400_000 + 123;
        let cross_utc_time = HISTORY_COVERAGE_START_UTC_MSC + 2 * 86_400_000 - 30_000;
        let cross_server_time = cross_utc_time + 2 * 3_600_000;
        {
            let connection = Connection::open(&path).expect("legacy connection");
            for (item_id, event_time, server_time, direction, profit) in [
                ("old", old_time, old_time, "BUY", 5.0),
                ("new", current_time, current_time, "SELL", -2.0),
                ("cross", cross_utc_time, cross_server_time, "BUY", 3.0),
            ] {
                connection
                    .execute(
                        "INSERT INTO history_archive_items (
                           terminal_instance_id, broker_server, login_account, platform,
                           item_kind, item_id, event_time_msc, position_id, order_ticket,
                           symbol, payload_json, updated_at_utc_msc
                         ) VALUES (?1, ?2, ?3, ?4, 'trade', ?5, ?6, NULL, NULL,
                           'EURUSD', ?7, ?8);",
                        params![
                            terminal.terminal_instance_id,
                            terminal.account_ref.broker_server,
                            terminal.account_ref.login,
                            terminal.platform,
                            item_id,
                            event_time,
                            serde_json::json!({
                                "deal_ticket": item_id,
                                "time_msc": event_time,
                                "close_time_utc_msc": event_time,
                                "close_time_server_msc": server_time,
                                "type": direction,
                                "profit": profit,
                                "volume": 0.2,
                            })
                            .to_string(),
                            current_time,
                        ],
                    )
                    .expect("legacy archive row");
            }
        }
        let store = OutboxStore::open_existing(&path).expect("additive scalar migration");
        {
            let connection = store.connection.lock().expect("scalar migration lock");
            let columns =
                table_columns(&connection, "history_archive_items").expect("scalar columns");
            for column in [
                "direction",
                "net_profit",
                "volume",
                "capital_kind",
                "capital_amount",
                "summary_day_utc_msc",
            ] {
                assert!(columns.iter().any(|existing| existing == column));
            }
            let migrated = connection
                .query_row(
                    "SELECT direction, net_profit, volume, summary_day_utc_msc,
                            close_timezone_offset_minutes, close_business_date, immutable_state
                     FROM history_archive_items WHERE item_id = 'new';",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, f64>(1)?,
                            row.get::<_, f64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                        ))
                    },
                )
                .expect("migrated scalar values");
            assert_eq!(migrated.0, "SELL");
            assert_eq!(migrated.1, -2.0);
            assert_eq!(migrated.2, 0.2);
            assert_eq!(
                migrated.3,
                current_time - current_time.rem_euclid(86_400_000)
            );
            assert_eq!(migrated.4, 0);
            assert_eq!(
                migrated.5,
                business_date_from_server_msc(current_time).expect("derived business date")
            );
            assert_eq!(migrated.6, "sealed");
        }
        let state = store
            .rebuild_history_summary(&terminal, current_time + 1_000)
            .expect("summary rebuild after migration");
        assert_eq!(state.summary_status, "ready");
        let connection = store.connection.lock().expect("summary migration lock");
        let (summary_count, summary_profit) = connection
            .query_row(
                "SELECT COALESCE(SUM(trade_count), 0), COALESCE(SUM(net_profit), 0)
                 FROM history_daily_summary
                 WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4 AND generation = ?5;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                    1_i64,
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)),
            )
            .expect("summary floor query");
        assert_eq!(summary_count, 2);
        assert_eq!(summary_profit, 1.0);
        let cross_summary_day = connection
            .query_row(
                "SELECT summary_day_utc_msc, close_business_date, immutable_state
                 FROM history_archive_items WHERE item_id = 'cross';",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .expect("cross-day migration row");
        assert_eq!(
            cross_summary_day.0,
            HISTORY_COVERAGE_START_UTC_MSC + 2 * 86_400_000
        );
        assert_eq!(
            cross_summary_day.1,
            business_date_from_server_msc(cross_server_time).expect("cross business date")
        );
        assert_eq!(cross_summary_day.2, "sealed");
        drop(connection);
        drop(store);
        fs::remove_dir_all(root).expect("remove scalar migration fixture");
    }

    #[test]
    fn history_summary_generation_validation_keeps_old_active_on_failure() {
        let root = unique_test_directory("history-summary-generation");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("summary generation store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![normalized_trade(8001, floor + 1_000, "BUY", 2.5, 0.4)],
                    next_cursor: HistoryCursor {
                        time_msc: floor + 2_000,
                        ticket: "8001".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: floor + 3_000,
                },
            )
            .expect("summary source batch");
        let first = store
            .rebuild_history_summary(&terminal, floor + 4_000)
            .expect("first summary generation");
        assert_eq!(first.summary_status, "ready");
        let active_generation = {
            let connection = store.connection.lock().expect("generation lock");
            connection
                .query_row(
                    "SELECT active_generation FROM history_summary_builds
                     WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4;",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .expect("active generation")
        };
        {
            let connection = store.connection.lock().expect("corrupt scalar lock");
            connection
                .execute(
                    "UPDATE history_archive_items SET net_profit = 'bad'
                     WHERE terminal_instance_id = ?1 AND item_id = '8001';",
                    params![terminal.terminal_instance_id],
                )
                .expect("corrupt scalar for validation");
        }
        let failed = store
            .rebuild_history_summary(&terminal, floor + 5_000)
            .expect_err("raw/summary mismatch must fail closed");
        assert_eq!(
            failed.code(),
            "bridge_store_history_summary_validation_mismatch"
        );
        let unavailable = store
            .history_scope_state(&terminal)
            .expect("unavailable state");
        assert_eq!(unavailable.summary_status, "unavailable");
        let (active_after_failure, building_after_failure) = {
            let connection = store.connection.lock().expect("generation after failure");
            connection
                .query_row(
                    "SELECT active_generation, building_generation FROM history_summary_builds
                     WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4;",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                    ],
                    |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
                )
                .expect("generation after failure")
        };
        assert_eq!(active_after_failure, Some(active_generation));
        assert_eq!(building_after_failure, None);
        {
            let connection = store.connection.lock().expect("repair scalar lock");
            connection
                .execute(
                    "UPDATE history_archive_items SET net_profit = 2.5
                     WHERE terminal_instance_id = ?1 AND item_id = '8001';",
                    params![terminal.terminal_instance_id],
                )
                .expect("repair scalar");
        }
        let repaired = store
            .ensure_history_summary(&terminal, floor + 6_000)
            .expect("rebuild after repair");
        assert_eq!(repaired.summary_status, "ready");
        assert_eq!(repaired.summary_revision, repaired.history_revision);
        drop(store);
        fs::remove_dir_all(root).expect("remove generation fixture");
    }

    #[test]
    fn ready_summary_duplicate_batch_is_stable_and_cross_day_changes_rebuild_both_days() {
        let root = unique_test_directory("history-summary-incremental");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("incremental summary store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let day_one = floor + 86_400_000;
        let day_two = floor + 2 * 86_400_000;
        let day_three = floor + 3 * 86_400_000;
        let first_batch = HistoryArchiveBatch {
            deals: Vec::new(),
            history_orders: Vec::new(),
            trades: vec![
                normalized_trade(8101, day_one + 100, "BUY", 1.0, 0.1),
                normalized_trade(8102, day_two + 100, "SELL", -0.5, 0.2),
            ],
            next_cursor: HistoryCursor {
                time_msc: day_three,
                ticket: "8102".to_owned(),
            },
            has_more: false,
            observed_at_utc_msc: day_three + 100,
        };
        store
            .persist_history_archive_batch(&terminal, &first_batch)
            .expect("initial summary batch");
        let ready = store
            .ensure_history_summary(&terminal, day_three + 200)
            .expect("initial summary ready");
        assert_eq!(ready.summary_revision, ready.history_revision);
        {
            let connection = store.connection.lock().expect("v2 summary lock");
            let v2_count = connection
                .query_row(
                    "SELECT COALESCE(SUM(trade_count), 0)
                     FROM history_daily_summary_v2
                     WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                       AND login_account = ?3 AND platform = ?4 AND generation = ?5
                       AND item_kind = 'trade';",
                    params![
                        terminal.terminal_instance_id,
                        terminal.account_ref.broker_server,
                        terminal.account_ref.login,
                        terminal.platform,
                        ready.summary_revision,
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .expect("v2 summary count");
            assert_eq!(v2_count, 2);
        }
        let before = store
            .history_scope_state(&terminal)
            .expect("before duplicate");
        store
            .persist_history_archive_batch(&terminal, &first_batch)
            .expect("duplicate summary batch");
        let after_duplicate = store
            .history_scope_state(&terminal)
            .expect("after duplicate");
        assert_eq!(after_duplicate.history_revision, before.history_revision);
        assert_eq!(after_duplicate.summary_revision, before.summary_revision);
        let moved = HistoryArchiveBatch {
            deals: Vec::new(),
            history_orders: Vec::new(),
            trades: vec![normalized_trade(8101, day_three + 100, "BUY", 1.0, 0.1)],
            next_cursor: HistoryCursor {
                time_msc: day_three + 200,
                ticket: "8101".to_owned(),
            },
            has_more: false,
            observed_at_utc_msc: day_three + 300,
        };
        store
            .persist_history_archive_batch(&terminal, &moved)
            .expect("cross-day replacement");
        let after_move = store.history_scope_state(&terminal).expect("after move");
        assert_eq!(after_move.history_revision, before.history_revision);
        assert_eq!(after_move.immutable_conflict_count, 1);
        assert_eq!(after_move.summary_revision, after_move.history_revision);
        let connection = store.connection.lock().expect("incremental summary lock");
        let generation = connection
            .query_row(
                "SELECT active_generation FROM history_summary_builds
                 WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4;",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                ],
                |row| row.get::<_, i64>(0),
            )
            .expect("incremental generation");
        let old_day_count = connection
            .query_row(
                "SELECT COALESCE(SUM(trade_count), 0) FROM history_daily_summary
                 WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4 AND generation = ?5
                   AND summary_day_utc_msc = ?6 AND item_kind = 'trade';",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                    generation,
                    day_one,
                ],
                |row| row.get::<_, i64>(0),
            )
            .expect("old day summary");
        let new_day_count = connection
            .query_row(
                "SELECT COALESCE(SUM(trade_count), 0) FROM history_daily_summary
                 WHERE terminal_instance_id = ?1 AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3 AND platform = ?4 AND generation = ?5
                   AND summary_day_utc_msc = ?6 AND item_kind = 'trade';",
                params![
                    terminal.terminal_instance_id,
                    terminal.account_ref.broker_server,
                    terminal.account_ref.login,
                    terminal.platform,
                    generation,
                    day_three,
                ],
                |row| row.get::<_, i64>(0),
            )
            .expect("new day summary");
        assert_eq!(old_day_count, 1);
        assert_eq!(new_day_count, 0);
        drop(connection);
        drop(store);
        fs::remove_dir_all(root).expect("remove incremental summary fixture");
    }

    #[test]
    fn summary_stats_and_chart_are_exact_for_millisecond_edges_and_filters() {
        let root = unique_test_directory("history-summary-boundaries");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("boundary summary store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let day_one = floor + 86_400_000;
        let day_two = floor + 2 * 86_400_000;
        let day_three = floor + 3 * 86_400_000;
        let start = day_one + 1_000;
        let end = day_three + 1_000;
        let trades = vec![
            normalized_trade(8200, day_one + 500, "BUY", 100.0, 1.0),
            normalized_trade(8201, day_one + 1_234, "BUY", 2.0, 0.2),
            normalized_trade(8202, day_two + 1_000, "BUY", 3.0, 0.3),
            normalized_trade(8203, day_two + 2_000, "SELL", 4.0, 0.4),
            normalized_trade(8204, day_three + 500, "BUY", 5.0, 0.5),
            normalized_trade(8205, day_three + 2_000, "BUY", -9.0, 0.6),
        ];
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades,
                    next_cursor: HistoryCursor {
                        time_msc: day_three + 3_000,
                        ticket: "8205".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: day_three + 4_000,
                },
            )
            .expect("boundary trades");
        store
            .ensure_history_summary(&terminal, day_three + 5_000)
            .expect("boundary summary");
        let parameters = serde_json::json!({
            "range_start_utc_msc": start,
            "range_end_utc_msc": end,
            "direction": "BUY",
            "profit_filter": "profit",
            "page": 1,
            "page_size": 20,
        });
        let page = store
            .read_history_archive_page_at(&terminal, &parameters, end + 1)
            .expect("boundary page");
        assert_eq!(page["pagination"]["total_count"], 3);
        assert_eq!(page["statistics"]["trade_count"], 3);
        assert_eq!(page["statistics"]["total_profit"], 10.0);
        assert_eq!(page["statistics"]["total_volume"], 1.0);
        assert_eq!(
            page["statistics"]["summary_source"],
            "sqlite_archive_raw_close_time"
        );
        assert_eq!(page["statistics"]["time_semantics"], "exact_close_utc");
        let chart_parameters = serde_json::json!({
            "range_start_utc_msc": start,
            "range_end_utc_msc": end,
            "direction": "BUY",
            "profit_filter": "profit",
        });
        let chart = store
            .read_history_chart_data_at(&terminal, &chart_parameters, end + 1)
            .expect("boundary chart");
        assert_eq!(chart["stats"]["total_trades"], 3);
        assert_eq!(chart["stats"]["gross_profit"], 10.0);
        assert_eq!(chart["daily"].as_array().expect("boundary daily").len(), 3);
        assert_eq!(chart["cumulative"], serde_json::json!([2.0, 5.0, 10.0]));
        drop(store);
        fs::remove_dir_all(root).expect("remove boundary fixture");
    }

    #[test]
    fn pending_cursor_snapshot_has_null_aggregates_then_ready_first_page_has_one_chart() {
        let root = unique_test_directory("history-cursor-summary");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("cursor summary store");
        let terminal = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let range_end = floor + 3 * 86_400_000;
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![
                        normalized_trade(8301, floor + 1_000, "BUY", 1.0, 0.1),
                        normalized_trade(8302, floor + 86_400_000 + 1_000, "SELL", -2.0, 0.2),
                        normalized_trade(8303, floor + 2 * 86_400_000 + 1_000, "BUY", 3.0, 0.3),
                    ],
                    next_cursor: HistoryCursor {
                        time_msc: range_end,
                        ticket: "8303".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: range_end + 1_000,
                },
            )
            .expect("cursor summary source");
        let parameters = serde_json::json!({
            "range_start_utc_msc": floor,
            "range_end_utc_msc": range_end,
            "page_size": 2,
        });
        let pending = store
            .read_history_cursor_page_at(&terminal, &parameters, range_end + 2_000)
            .expect("pending cursor page");
        assert_eq!(pending["statistics"], serde_json::Value::Null);
        assert_eq!(pending["chart_data"], serde_json::Value::Null);
        let snapshot_id = pending["history_snapshot_id"]
            .as_str()
            .expect("pending snapshot")
            .to_owned();
        let pending_cursor = pending["next_cursor"]
            .as_str()
            .expect("pending cursor")
            .to_owned();
        store
            .ensure_history_summary(&terminal, range_end + 3_000)
            .expect("cursor summary ready");
        let ready = store
            .read_history_cursor_page_at(&terminal, &parameters, range_end + 4_000)
            .expect("ready cursor page");
        assert!(ready["chart_data"].is_object());
        assert_eq!(ready["chart_data"]["stats"]["total_trades"], 3);
        let ready_snapshot_id = ready["history_snapshot_id"]
            .as_str()
            .expect("ready snapshot")
            .to_owned();
        let ready_cursor = ready["next_cursor"]
            .as_str()
            .expect("ready cursor")
            .to_owned();
        let continuation = store
            .read_history_cursor_page_at(
                &terminal,
                &serde_json::json!({
                    "range_start_utc_msc": floor,
                    "range_end_utc_msc": range_end,
                    "page_size": 2,
                    "snapshot_id": ready_snapshot_id,
                    "cursor": ready_cursor,
                }),
                range_end + 5_000,
            )
            .expect("ready cursor continuation");
        assert!(continuation.get("chart_data").is_none());
        assert!(!pending_cursor.is_empty());
        assert!(!snapshot_id.is_empty());
        drop(store);
        fs::remove_dir_all(root).expect("remove cursor summary fixture");
    }

    #[test]
    fn mt4_mt5_summary_scopes_are_isolated_for_same_account() {
        let root = unique_test_directory("history-platform-scope");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("platform scope store");
        let mut mt4 = history_terminal("123456");
        mt4.platform = "mt4".to_owned();
        let mt5 = history_terminal("123456");
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        for (terminal, ticket, profit) in [(&mt4, 8401, 4.0), (&mt5, 8402, 7.0)] {
            store
                .persist_history_archive_batch(
                    terminal,
                    &HistoryArchiveBatch {
                        deals: Vec::new(),
                        history_orders: Vec::new(),
                        trades: vec![normalized_trade(ticket, floor + ticket, "BUY", profit, 0.1)],
                        next_cursor: HistoryCursor {
                            time_msc: floor + ticket + 1,
                            ticket: ticket.to_string(),
                        },
                        has_more: false,
                        observed_at_utc_msc: floor + ticket + 2,
                    },
                )
                .expect("platform archive batch");
            store
                .ensure_history_summary(terminal, floor + ticket + 3)
                .expect("platform summary");
        }
        let mt4_state = store.history_scope_state(&mt4).expect("mt4 state");
        let mt5_state = store.history_scope_state(&mt5).expect("mt5 state");
        assert_eq!(mt4_state.history_revision, 1);
        assert_eq!(mt5_state.history_revision, 1);
        assert_eq!(mt4_state.summary_revision, mt4_state.history_revision);
        assert_eq!(mt5_state.summary_revision, mt5_state.history_revision);
        let mt4_chart = store
            .read_history_chart_data_at(&mt4, &serde_json::json!({}), floor + 1_000_000)
            .expect("mt4 chart");
        let mt5_chart = store
            .read_history_chart_data_at(&mt5, &serde_json::json!({}), floor + 1_000_000)
            .expect("mt5 chart");
        assert_eq!(mt4_chart["stats"]["total_trades"], 1);
        assert_eq!(mt5_chart["stats"]["total_trades"], 1);
        assert_eq!(mt4_chart["stats"]["gross_profit"], 4.0);
        assert_eq!(mt5_chart["stats"]["gross_profit"], 7.0);
        drop(store);
        fs::remove_dir_all(root).expect("remove platform scope fixture");
    }

    #[test]
    fn mt4_capital_events_normalize_into_materialized_summary() {
        let root = unique_test_directory("history-mt4-capital-summary");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("MT4 capital summary store");
        let mut terminal = history_terminal("123456");
        terminal.platform = "mt4".to_owned();
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let day_end = floor + 86_400_000;
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: vec![
                        serde_json::json!({
                            "category": "capital",
                            "ticket": 8501,
                            "deal_type": 6,
                            "amount": 100.0,
                            "time_msc": floor + 100,
                        }),
                        serde_json::json!({
                            "category": "capital",
                            "ticket": 8502,
                            "deal_type": 6,
                            "amount": -20.0,
                            "time_msc": floor + 200,
                        }),
                        serde_json::json!({
                            "category": "capital",
                            "ticket": 8503,
                            "deal_type": 7,
                            "amount": 3.0,
                            "time_msc": floor + 300,
                        }),
                    ],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: day_end,
                        ticket: "8503".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: day_end + 100,
                },
            )
            .expect("MT4 capital batch");
        store
            .ensure_history_summary(&terminal, day_end + 200)
            .expect("MT4 capital summary");
        let page = store
            .read_history_archive_page_at(&terminal, &serde_json::json!({}), day_end + 300)
            .expect("MT4 capital stats");
        assert_eq!(page["statistics"]["deposit"], 100.0);
        assert_eq!(page["statistics"]["withdrawal"], 20.0);
        assert_eq!(page["statistics"]["credit"], 3.0);
        let before = store
            .history_scope_state(&terminal)
            .expect("capital state before append");
        store
            .persist_history_archive_batch(
                &terminal,
                &HistoryArchiveBatch {
                    deals: vec![serde_json::json!({
                        "category": "capital",
                        "ticket": 8504,
                        "deal_type": 6,
                        "amount": 50.0,
                        "time_msc": floor + 400,
                    })],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: day_end + 1,
                        ticket: "8504".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: day_end + 400,
                },
            )
            .expect("append capital event");
        let after = store
            .history_scope_state(&terminal)
            .expect("capital state after append");
        assert_eq!(after.history_revision, before.history_revision);
        assert_eq!(after.summary_revision, before.summary_revision);
        let refreshed = store
            .read_history_archive_page_at(&terminal, &serde_json::json!({}), day_end + 500)
            .expect("refreshed capital stats");
        assert_eq!(refreshed["statistics"]["deposit"], 150.0);
        drop(store);
        fs::remove_dir_all(root).expect("remove MT4 capital summary fixture");
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

        let trim_probe_one = command_result(
            "command_01JTRIMSAFE01",
            "result_01JTRIMSAFE001",
            1_700_000_000_008,
        );
        let trim_probe_two = command_result(
            "command_01JTRIMSAFE02",
            "result_01JTRIMSAFE002",
            1_700_000_000_009,
        );
        store
            .save_execution_receipt(&trim_probe_one, 1)
            .expect("first trim probe");
        assert!(
            store
                .acknowledge(&trim_probe_one.message_id, "applied")
                .expect("ack trim probe")
        );
        store
            .save_execution_receipt(&trim_probe_two, 1)
            .expect("second trim probe");
        assert_eq!(
            store
                .execution_receipt(&command.command_id)
                .expect("uncertain receipt survives trimming")
                .as_ref(),
            Some(&uncertain)
        );
        assert_eq!(
            store
                .reconciliation_candidates(10)
                .expect("uncertain candidate survives trimming")
                .len(),
            1
        );

        let mut resolved = command_result(
            &command.command_id,
            "result_01JLEDGER002",
            1_700_000_000_010,
        );
        resolved.connection_epoch = command.connection_epoch + 1;
        let mut stale_resolved = resolved.clone();
        stale_resolved.message_id = "result_01JLEDGER002STALE".to_owned();
        stale_resolved.connection_epoch = command.connection_epoch - 1;
        assert_eq!(
            store
                .resolve_acknowledged_uncertain_receipt(&stale_resolved)
                .expect_err("reconciliation epoch cannot move backwards")
                .code(),
            "bridge_store_reconciliation_transition_invalid"
        );
        let mut wrong_route = resolved.clone();
        wrong_route.message_id = "result_01JLEDGER002ROUTE".to_owned();
        wrong_route.account_ref.login = "999999".to_owned();
        assert_eq!(
            store
                .resolve_acknowledged_uncertain_receipt(&wrong_route)
                .expect_err("reconciliation account cannot change")
                .code(),
            "bridge_store_reconciliation_transition_invalid"
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

    fn history_scope_for(login: &str) -> HistoryScope {
        HistoryScope {
            terminal_instance_id: "mt5_terminal_runtime_01".to_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login_account: login.to_owned(),
        }
    }

    fn history_job_for(
        job_id: &str,
        scope: &HistoryScope,
        start: i64,
        end: i64,
        priority: &str,
    ) -> NewHistorySyncJob {
        NewHistorySyncJob {
            job_id: job_id.to_owned(),
            scope: scope.clone(),
            job_kind: "on_demand".to_owned(),
            priority: priority.to_owned(),
            range_start_utc_msc: start,
            range_end_utc_msc: end,
            cursor_time_msc: start,
            cursor_ticket: String::new(),
            window_msc: end - start,
            created_at_utc_msc: HISTORY_COVERAGE_START_UTC_MSC + 1_000,
        }
    }

    fn history_item_count(store: &OutboxStore, scope: &HistoryScope) -> i64 {
        let connection = store.connection.lock().expect("history item count lock");
        connection
            .query_row(
                "SELECT COUNT(*) FROM history_archive_items
                 WHERE terminal_instance_id = ?1
                   AND broker_server = ?2 COLLATE NOCASE
                   AND login_account = ?3;",
                params![
                    scope.terminal_instance_id,
                    scope.broker_server,
                    scope.login_account
                ],
                |row| row.get(0),
            )
            .expect("history item count")
    }

    #[test]
    fn compatible_legacy_database_gets_runtime_tables_and_idempotent_legacy_seed() {
        let root = unique_test_directory("history-runtime-migration");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path, None);
        {
            let connection = Connection::open(&path).expect("legacy connection");
            let insert_legacy = |login: &str, cursor_time: i64, ticket: &str, complete: i64| {
                connection
                    .execute(
                        "INSERT INTO history_archive_state (
                           terminal_instance_id, broker_server, login_account,
                           cursor_value, is_complete, updated_at_utc_msc
                         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
                        params![
                            "mt5_terminal_runtime_01",
                            "Broker-Demo",
                            login,
                            serde_json::json!({
                                "time_msc": cursor_time,
                                "ticket": ticket
                            })
                            .to_string(),
                            complete,
                            1_700_000_000_001_i64
                        ],
                    )
                    .expect("legacy state");
            };
            insert_legacy("123456", HISTORY_COVERAGE_START_UTC_MSC + 10_000, "100", 0);
            insert_legacy("654321", HISTORY_COVERAGE_START_UTC_MSC + 30_000, "300", 1);
            insert_legacy("777777", 0, "", 0);
            insert_legacy("888888", HISTORY_COVERAGE_START_UTC_MSC, "0", 1);
        }
        let store = OutboxStore::open_existing(&path).expect("incremental migration");
        let scope = history_scope_for("123456");
        assert_eq!(
            store.history_coverage_ranges(&scope).expect("seed ranges"),
            vec![HistoryCoverageRange {
                scope: scope.clone(),
                range_start_utc_msc: HISTORY_COVERAGE_START_UTC_MSC,
                range_end_utc_msc: HISTORY_COVERAGE_START_UTC_MSC + 10_000,
                observed_at_utc_msc: 1_700_000_000_001,
                updated_at_utc_msc: 1_700_000_000_001,
            }]
        );
        let complete_ranges = store
            .history_coverage_ranges(&history_scope_for("654321"))
            .expect("complete seed");
        assert_eq!(complete_ranges.len(), 1);
        assert_eq!(
            complete_ranges[0].range_end_utc_msc,
            HISTORY_COVERAGE_START_UTC_MSC + 30_000
        );
        assert!(
            store
                .history_coverage_ranges(&history_scope_for("777777"))
                .expect("empty seed")
                .is_empty()
        );
        assert!(
            store
                .history_coverage_ranges(&history_scope_for("888888"))
                .expect("boundary seed")
                .is_empty()
        );
        drop(store);
        {
            let connection = Connection::open(&path).expect("legacy update connection");
            connection
                .execute(
                    "UPDATE history_archive_state
                     SET cursor_value = ?1
                     WHERE terminal_instance_id = ?2 AND login_account = ?3;",
                    params![
                        serde_json::json!({
                            "time_msc": HISTORY_COVERAGE_START_UTC_MSC + 20_000,
                            "ticket": "200"
                        })
                        .to_string(),
                        "mt5_terminal_runtime_01",
                        "123456"
                    ],
                )
                .expect("legacy update");
        }
        let store = OutboxStore::open_existing(&path).expect("idempotent migration");
        let ranges = store.history_coverage_ranges(&scope).expect("seed ranges");
        assert_eq!(ranges.len(), 1);
        assert_eq!(
            ranges[0].range_end_utc_msc,
            HISTORY_COVERAGE_START_UTC_MSC + 20_000
        );
        for (login, expected_complete, expected_time) in [
            ("654321", 1_i64, HISTORY_COVERAGE_START_UTC_MSC + 30_000),
            ("777777", 0_i64, 0_i64),
            ("888888", 1_i64, HISTORY_COVERAGE_START_UTC_MSC),
        ] {
            let (cursor_value, is_complete): (String, i64) = Connection::open(&path)
                .expect("legacy state read connection")
                .query_row(
                    "SELECT cursor_value, CAST(is_complete AS INTEGER)
                     FROM history_archive_state WHERE login_account = ?1;",
                    [login],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("legacy state");
            assert_eq!(is_complete, expected_complete);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&cursor_value).expect("legacy cursor")["time_msc"],
                expected_time
            );
        }
        let legacy_cursor: String = Connection::open(&path)
            .expect("legacy read connection")
            .query_row(
                "SELECT cursor_value FROM history_archive_state WHERE terminal_instance_id = ?1;",
                ["mt5_terminal_runtime_01"],
                |row| row.get(0),
            )
            .expect("legacy cursor");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&legacy_cursor).expect("cursor json")["time_msc"],
            HISTORY_COVERAGE_START_UTC_MSC + 20_000
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove migration fixture");
    }

    #[test]
    fn initialization_state_is_account_scoped_and_validated() {
        let root = unique_test_directory("initialization-state");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let state = AccountInitializationState {
            scope: scope.clone(),
            platform: "mt5".to_owned(),
            schema_version: 1,
            state: "ready".to_owned(),
            local_operational_ready: true,
            last_error_code: None,
            initialized_at_utc_msc: 1_700_000_000_001,
            updated_at_utc_msc: 1_700_000_000_002,
        };
        store
            .write_account_initialization_state(&state)
            .expect("write initialization");
        assert_eq!(
            store
                .read_account_initialization_state(&scope)
                .expect("read initialization"),
            Some(state.clone())
        );
        assert!(
            store
                .read_account_initialization_state(&history_scope_for("654321"))
                .expect("other account")
                .is_none()
        );
        let mut invalid = state.clone();
        invalid.state = "unknown".to_owned();
        assert_eq!(
            store
                .write_account_initialization_state(&invalid)
                .expect_err("invalid state")
                .code(),
            "bridge_store_initialization_state_invalid"
        );
        let mut invalid_ready_flag = state.clone();
        invalid_ready_flag.state = "retrying".to_owned();
        assert_eq!(
            store
                .write_account_initialization_state(&invalid_ready_flag)
                .expect_err("ready flag invariant")
                .code(),
            "bridge_store_initialization_state_invalid"
        );
        let mut invalid_ready_state = state;
        invalid_ready_state.local_operational_ready = false;
        assert_eq!(
            store
                .write_account_initialization_state(&invalid_ready_state)
                .expect_err("ready state invariant")
                .code(),
            "bridge_store_initialization_state_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove initialization fixture");
    }

    #[test]
    fn history_jobs_are_idempotent_claimable_and_scope_supersedable() {
        let root = unique_test_directory("history-jobs");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let job = history_job_for("job_01JHISTORY001", &scope, 1_000, 2_000, "p1");
        let inserted = store.enqueue_history_job(&job).expect("enqueue");
        assert_eq!(inserted.state, "queued");
        assert_eq!(
            store.enqueue_history_job(&job).expect("idempotent").job_id,
            inserted.job_id
        );
        let mut case_variant_scope = job.clone();
        case_variant_scope.scope.broker_server = "broker-demo".to_owned();
        assert_eq!(
            store
                .enqueue_history_job(&case_variant_scope)
                .expect("NOCASE idempotent")
                .job_id,
            inserted.job_id
        );
        for mut conflicting in [
            {
                let mut value = job.clone();
                value.job_kind = "recent".to_owned();
                value
            },
            {
                let mut value = job.clone();
                value.priority = "p2".to_owned();
                value
            },
            {
                let mut value = job.clone();
                value.range_start_utc_msc = 1_001;
                value.cursor_time_msc = 1_001;
                value
            },
            {
                let mut value = job.clone();
                value.range_end_utc_msc = 2_001;
                value
            },
            {
                let mut value = job.clone();
                value.cursor_time_msc = 1_001;
                value
            },
            {
                let mut value = job.clone();
                value.cursor_ticket = "123".to_owned();
                value
            },
            {
                let mut value = job.clone();
                value.window_msc = 500;
                value
            },
            {
                let mut value = job.clone();
                value.created_at_utc_msc += 1;
                value
            },
        ] {
            conflicting.job_id = job.job_id.clone();
            assert_eq!(
                store
                    .enqueue_history_job(&conflicting)
                    .expect_err("immutable enqueue conflict")
                    .code(),
                "bridge_store_history_job_conflict"
            );
        }
        let mut same_range_different_id = job.clone();
        same_range_different_id.job_id = "job_01JHISTORY003".to_owned();
        assert_eq!(
            store
                .enqueue_history_job(&same_range_different_id)
                .expect("same range idempotent")
                .job_id,
            inserted.job_id
        );
        let claim = store
            .claim_history_job(&scope, 1_700_000_000_100, 1_000)
            .expect("claim")
            .expect("claimed");
        assert_eq!(claim.lease_generation, 1);
        assert_eq!(claim.attempt_count, 1);
        assert!(
            store
                .claim_history_job(&scope, 1_700_000_000_101, 1_000)
                .expect("single claim")
                .is_none()
        );
        store
            .checkpoint_history_job(
                &claim.job_id,
                claim.lease_generation,
                1_500,
                "123",
                500,
                1_700_000_000_200,
            )
            .expect("checkpoint");
        store
            .retry_history_job(
                &claim.job_id,
                claim.lease_generation,
                1_700_000_000_400,
                "worker_request_timeout",
                1_700_000_000_201,
            )
            .expect("retry");
        assert_eq!(
            store
                .history_sync_job(&claim.job_id)
                .expect("job")
                .expect("job row")
                .state,
            "retrying"
        );
        let other_scope = history_scope_for("654321");
        let other_job = history_job_for("job_01JHISTORY002", &other_scope, 1_000, 2_000, "p2");
        store
            .enqueue_history_job(&other_job)
            .expect("other enqueue");
        assert_eq!(
            store
                .supersede_history_scope(&scope, 1_700_000_000_300)
                .expect("supersede"),
            1
        );
        assert_eq!(
            store
                .history_sync_job(&claim.job_id)
                .expect("superseded job")
                .expect("superseded row")
                .state,
            "superseded"
        );
        assert_eq!(
            store
                .history_sync_job(&other_job.job_id)
                .expect("other job")
                .expect("other row")
                .state,
            "queued"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove jobs fixture");
    }

    #[test]
    fn history_coverage_merges_adjacent_ranges_without_crossing_holes() {
        let root = unique_test_directory("history-coverage");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        for (job_id, start, end) in [
            ("job_01JCOVERAGE001", 1_000, 2_000),
            ("job_01JCOVERAGE002", 2_000, 3_000),
            ("job_01JCOVERAGE003", 4_000, 5_000),
        ] {
            let job = history_job_for(job_id, &scope, start, end, "p1");
            store.enqueue_history_job(&job).expect("enqueue coverage");
            let claim = store
                .claim_history_job(&scope, 1_700_000_000_000 + start, 1_000_000_000)
                .expect("claim coverage")
                .expect("coverage lease");
            let terminal = history_terminal_for(&scope);
            if start == 1_000 {
                assert_eq!(
                    store
                        .persist_history_job_batch(
                            &terminal,
                            &claim.job_id,
                            claim.lease_generation,
                            &HistoryArchiveBatch {
                                deals: Vec::new(),
                                history_orders: Vec::new(),
                                trades: Vec::new(),
                                next_cursor: HistoryCursor {
                                    time_msc: end,
                                    ticket: "1".to_owned(),
                                },
                                has_more: false,
                                observed_at_utc_msc: 1_700_000_050_000,
                            },
                            end - start,
                            1_700_000_050_000,
                        )
                        .expect_err("premature complete")
                        .code(),
                    "bridge_store_history_cursor_invalid"
                );
                assert!(
                    store
                        .history_coverage_ranges(&scope)
                        .expect("coverage unchanged")
                        .is_empty()
                );
            }
            let result = store
                .persist_history_job_batch(
                    &terminal,
                    &claim.job_id,
                    claim.lease_generation,
                    &HistoryArchiveBatch {
                        deals: Vec::new(),
                        history_orders: Vec::new(),
                        trades: Vec::new(),
                        next_cursor: HistoryCursor {
                            time_msc: end,
                            ticket: "0".to_owned(),
                        },
                        has_more: false,
                        observed_at_utc_msc: 1_700_000_050_000 + start,
                    },
                    end - start,
                    1_700_000_100_000 + end,
                )
                .expect("complete coverage");
            assert_eq!(result.status, HistoryJobBatchStatus::Completed);
        }
        let ranges = store
            .history_coverage_ranges(&scope)
            .expect("coverage ranges");
        assert_eq!(ranges.len(), 2);
        assert_eq!(
            (ranges[0].range_start_utc_msc, ranges[0].range_end_utc_msc),
            (1_000, 3_000)
        );
        assert_eq!(
            (ranges[1].range_start_utc_msc, ranges[1].range_end_utc_msc),
            (4_000, 5_000)
        );
        assert!(
            store
                .is_history_range_covered(&scope, 1_100, 2_900)
                .expect("covered")
        );
        assert!(
            !store
                .is_history_range_covered(&scope, 1_000, 5_000)
                .expect("hole")
        );

        let blocked_job = history_job_for("job_01JCOVERAGE004", &scope, 5_000, 6_000, "p2");
        store
            .enqueue_history_job(&blocked_job)
            .expect("enqueue blocked");
        let blocked = store
            .claim_history_job(&scope, 1_700_000_200_000, 100_000)
            .expect("claim blocked")
            .expect("blocked lease");
        store
            .block_history_job(
                &blocked.job_id,
                blocked.lease_generation,
                "history_range_invalid",
                1_700_000_200_001,
            )
            .expect("block");
        assert!(
            !store
                .is_history_range_covered(&scope, 5_000, 6_000)
                .expect("blocked not covered")
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove coverage fixture");
    }

    #[test]
    fn history_job_batch_persists_partial_and_final_atomically_without_legacy_progress() {
        let root = unique_test_directory("history-job-batch");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let terminal = history_terminal_for(&scope);
        let legacy_before = store
            .history_archive_state(&terminal.terminal_instance_id, &terminal.account_ref)
            .expect("legacy baseline");
        let job = history_job_for("job_01JBATCH0001", &scope, 10_000, 20_000, "p1");
        store.enqueue_history_job(&job).expect("enqueue batch");
        let claim = store
            .claim_history_job(&scope, 1_700_000_000_001, 1_000_000)
            .expect("claim batch")
            .expect("batch lease");

        let partial = store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![serde_json::json!({
                        "deal_ticket": 1001,
                        "time_msc": 12_000,
                        "symbol": "EURUSD"
                    })],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 15_000,
                        ticket: "1001".to_owned(),
                    },
                    has_more: true,
                    observed_at_utc_msc: 1_700_000_000_002,
                },
                5_000,
                1_700_000_000_003,
            )
            .expect("partial batch");
        assert_eq!(partial.status, HistoryJobBatchStatus::Checkpointed);
        assert_eq!(partial.persisted_item_count, 1);
        assert_eq!(partial.job.state, "running");
        assert_eq!(partial.job.cursor_time_msc, 15_000);
        assert_eq!(partial.job.cursor_ticket, "1001");
        assert_eq!(history_item_count(&store, &scope), 1);
        assert!(
            store
                .history_coverage_ranges(&scope)
                .expect("partial coverage")
                .is_empty()
        );
        assert_eq!(
            store
                .history_archive_state(&terminal.terminal_instance_id, &terminal.account_ref)
                .expect("legacy after partial"),
            legacy_before
        );

        let completed = store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![serde_json::json!({
                        "deal_ticket": 1002,
                        "time_msc": 19_000,
                        "symbol": "EURUSD"
                    })],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 20_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_000_004,
                },
                5_000,
                1_700_000_000_005,
            )
            .expect("final batch");
        assert_eq!(completed.status, HistoryJobBatchStatus::Completed);
        assert_eq!(completed.persisted_item_count, 1);
        assert_eq!(completed.job.state, "completed");
        assert_eq!(completed.job.cursor_time_msc, 20_000);
        assert!(completed.job.cursor_ticket.is_empty());
        assert_eq!(completed.job.lease_expires_at_utc_msc, None);
        assert_eq!(history_item_count(&store, &scope), 2);
        assert!(
            store
                .is_history_range_covered(&scope, 10_000, 20_000)
                .expect("final coverage")
        );
        assert_eq!(
            store
                .history_archive_state(&terminal.terminal_instance_id, &terminal.account_ref)
                .expect("legacy after final"),
            legacy_before
        );

        let subwindow_job = history_job_for("job_01JBATCH0002", &scope, 30_000, 50_000, "p1");
        store
            .enqueue_history_job(&subwindow_job)
            .expect("enqueue subwindow");
        let subwindow_claim = store
            .claim_history_job(&scope, 1_700_000_000_010, 1_000_000)
            .expect("claim subwindow")
            .expect("subwindow lease");
        let subwindow = store
            .persist_history_job_batch(
                &terminal,
                &subwindow_claim.job_id,
                subwindow_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 40_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_000_011,
                },
                10_000,
                1_700_000_000_012,
            )
            .expect("empty subwindow");
        assert_eq!(subwindow.status, HistoryJobBatchStatus::Checkpointed);
        assert_eq!(subwindow.job.state, "running");
        assert_eq!(subwindow.job.cursor_time_msc, 40_000);
        assert_eq!(subwindow.job.cursor_ticket, "0");
        assert!(
            !store
                .is_history_range_covered(&scope, 30_000, 50_000)
                .expect("subwindow not covered")
        );
        let subwindow_complete = store
            .persist_history_job_batch(
                &terminal,
                &subwindow_claim.job_id,
                subwindow_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 50_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_000_013,
                },
                10_000,
                1_700_000_000_014,
            )
            .expect("complete subwindow job");
        assert_eq!(subwindow_complete.status, HistoryJobBatchStatus::Completed);
        assert!(
            store
                .is_history_range_covered(&scope, 30_000, 50_000)
                .expect("subwindow coverage")
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove batch fixture");
    }

    #[test]
    fn history_revision_ignores_deal_duplicates_and_conflicts() {
        let root = unique_test_directory("history-revision");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("revision store");
        let scope = history_scope_for("123456");
        let terminal = history_terminal_for(&scope);
        let start = HISTORY_COVERAGE_START_UTC_MSC + 1_000;
        let item_time = HISTORY_COVERAGE_START_UTC_MSC + 6_000;
        let first = history_job_for("job_01JREVISION01", &scope, start, start + 9_000, "p1");
        store
            .enqueue_history_job(&first)
            .expect("first revision job");
        let first_claim = store
            .claim_history_job(&scope, HISTORY_COVERAGE_START_UTC_MSC + 100_000, 100_000)
            .expect("first claim")
            .expect("first lease");
        let original = serde_json::json!({
            "deal_ticket": 7001,
            "time_msc": item_time,
            "symbol": "EURUSD",
            "profit": 1.0
        });
        let first_result = store
            .persist_history_job_batch(
                &terminal,
                &first_claim.job_id,
                first_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![original.clone()],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: first.range_end_utc_msc,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: HISTORY_COVERAGE_START_UTC_MSC + 110_000,
                },
                7_000,
                HISTORY_COVERAGE_START_UTC_MSC + 120_000,
            )
            .expect("first persist");
        assert_eq!(first_result.changed_item_count, 1);
        assert_eq!(first_result.history_revision, 0);

        let duplicate = history_job_for(
            "job_01JREVISION02",
            &scope,
            item_time - 1_000,
            item_time + 4_000,
            "p1",
        );
        store
            .enqueue_history_job(&duplicate)
            .expect("duplicate revision job");
        let duplicate_claim = store
            .claim_history_job(&scope, HISTORY_COVERAGE_START_UTC_MSC + 130_000, 100_000)
            .expect("duplicate claim")
            .expect("duplicate lease");
        let duplicate_result = store
            .persist_history_job_batch(
                &terminal,
                &duplicate_claim.job_id,
                duplicate_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![original],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: duplicate.range_end_utc_msc,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: HISTORY_COVERAGE_START_UTC_MSC + 140_000,
                },
                5_000,
                HISTORY_COVERAGE_START_UTC_MSC + 150_000,
            )
            .expect("duplicate persist");
        assert_eq!(duplicate_result.changed_item_count, 0);
        assert_eq!(duplicate_result.duplicate_item_count, 1);
        assert_eq!(duplicate_result.history_revision, 0);

        let changed = history_job_for(
            "job_01JREVISION03",
            &scope,
            item_time - 500,
            item_time + 5_000,
            "p1",
        );
        store
            .enqueue_history_job(&changed)
            .expect("changed revision job");
        let changed_claim = store
            .claim_history_job(&scope, HISTORY_COVERAGE_START_UTC_MSC + 160_000, 100_000)
            .expect("changed claim")
            .expect("changed lease");
        let mut replacement = serde_json::json!({
            "deal_ticket": 7001,
            "time_msc": item_time,
            "symbol": "GBPUSD",
            "profit": 1.0
        });
        replacement["comment"] = serde_json::Value::String("revision".to_owned());
        let changed_result = store
            .persist_history_job_batch(
                &terminal,
                &changed_claim.job_id,
                changed_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![replacement],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: changed.range_end_utc_msc,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: HISTORY_COVERAGE_START_UTC_MSC + 170_000,
                },
                5_000,
                HISTORY_COVERAGE_START_UTC_MSC + 180_000,
            )
            .expect("changed persist");
        assert_eq!(changed_result.changed_item_count, 0);
        assert_eq!(changed_result.immutable_conflict_count, 1);
        assert_eq!(changed_result.history_revision, 0);
        let state = store
            .history_scope_state(&terminal)
            .expect("revision state");
        assert_eq!(state.history_revision, 0);
        assert_eq!(state.duplicate_count, 1);
        assert_eq!(state.immutable_conflict_count, 1);
        // An on-demand P1 revision is not a recent/tail freshness proof.
        assert_eq!(state.freshness_state, "stale");
        drop(store);
        fs::remove_dir_all(root).expect("remove revision fixture");
    }

    #[test]
    fn tail_refresh_ignores_coverage_merges_later_endpoint_and_marks_refreshing() {
        let root = unique_test_directory("history-tail-planner");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("tail planner store");
        let scope = history_scope_for("123456");
        let terminal = history_terminal_for(&scope);
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        {
            let connection = store.connection.lock().expect("coverage lock");
            connection
                .execute(
                    "INSERT INTO history_coverage_ranges (
                       terminal_instance_id, broker_server, login_account,
                       range_start_utc_msc, range_end_utc_msc,
                       observed_at_utc_msc, updated_at_utc_msc
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6);",
                    params![
                        scope.terminal_instance_id,
                        scope.broker_server,
                        scope.login_account,
                        floor,
                        floor + 20_000,
                        floor + 30_000
                    ],
                )
                .expect("seed coverage");
        }
        let first = store
            .plan_history_tail_refresh(&HistoryTailRefreshRequest {
                scope: scope.clone(),
                platform: "mt5".to_owned(),
                range_start_utc_msc: floor + 1_000,
                range_end_utc_msc: floor + 10_000,
                now_utc_msc: floor + 10_000,
            })
            .expect("first tail plan");
        assert_eq!(first.attached_jobs.len(), 1);
        assert!(first.attached_jobs[0].job_id.starts_with("tail_refresh_"));
        let second = store
            .plan_history_tail_refresh(&HistoryTailRefreshRequest {
                scope,
                platform: "mt5".to_owned(),
                range_start_utc_msc: floor + 2_000,
                range_end_utc_msc: floor + 15_000,
                now_utc_msc: floor + 15_000,
            })
            .expect("merged tail plan");
        assert_eq!(second.attached_jobs.len(), 1);
        assert_eq!(
            second.attached_jobs[0].job_id,
            first.attached_jobs[0].job_id
        );
        assert_eq!(second.attached_jobs[0].range_end_utc_msc, floor + 15_000);
        assert_eq!(
            store
                .history_scope_state(&terminal)
                .expect("tail state")
                .freshness_state,
            "refreshing"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove tail planner fixture");
    }

    #[test]
    fn recent_freshness_waits_for_fixed_endpoint_and_backfill_does_not_fake_it() {
        let root = unique_test_directory("history-freshness-boundary");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("freshness store");
        let scope = history_scope_for("123456");
        let terminal = history_terminal_for(&scope);
        let floor = HISTORY_COVERAGE_START_UTC_MSC;

        let mut backfill =
            history_job_for("job_01JFRESHBACKFILL", &scope, floor, floor + 100, "p3");
        backfill.job_kind = "backfill".to_owned();
        store.enqueue_history_job(&backfill).expect("backfill job");
        let backfill_claim = store
            .claim_history_job(&scope, floor + 1_000, 100_000)
            .expect("backfill claim")
            .expect("backfill lease");
        store
            .persist_history_job_batch(
                &terminal,
                &backfill_claim.job_id,
                backfill_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: backfill.range_end_utc_msc,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: floor + 1_100,
                },
                7_000,
                floor + 1_200,
            )
            .expect("backfill persist");
        let after_backfill = store
            .history_scope_state(&terminal)
            .expect("backfill state");
        assert!(!after_backfill.head_ready);
        assert!(!after_backfill.coverage_complete);
        assert_eq!(after_backfill.freshness_state, "stale");
        assert_eq!(after_backfill.fresh_through_utc_msc, None);

        let mut recent = history_job_for(
            "job_01JFRESHRECENT",
            &scope,
            floor + 100,
            floor + 1_000,
            "p2",
        );
        recent.job_kind = "recent".to_owned();
        store.enqueue_history_job(&recent).expect("recent job");
        let recent_claim = store
            .claim_history_job(&scope, floor + 2_000, 100_000)
            .expect("recent claim")
            .expect("recent lease");
        let partial = store
            .persist_history_job_batch(
                &terminal,
                &recent_claim.job_id,
                recent_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: floor + 500,
                        ticket: "11".to_owned(),
                    },
                    has_more: true,
                    observed_at_utc_msc: floor + 2_100,
                },
                7_000,
                floor + 2_200,
            )
            .expect("recent partial persist");
        assert_eq!(partial.status, HistoryJobBatchStatus::Checkpointed);
        let refreshing = store
            .history_scope_state(&terminal)
            .expect("refreshing state");
        assert_eq!(refreshing.freshness_state, "refreshing");
        assert_eq!(refreshing.fresh_through_utc_msc, None);
        assert!(!refreshing.head_ready);

        store
            .persist_history_job_batch(
                &terminal,
                &recent_claim.job_id,
                recent_claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: recent.range_end_utc_msc,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: floor + 2_300,
                },
                7_000,
                floor + 2_400,
            )
            .expect("recent completion persist");
        let fresh = store.history_scope_state(&terminal).expect("fresh state");
        assert_eq!(fresh.freshness_state, "fresh");
        assert_eq!(fresh.fresh_through_utc_msc, Some(recent.range_end_utc_msc));
        assert!(fresh.head_ready);
        assert_eq!(
            fresh.head_range_start_utc_msc,
            Some(recent.range_start_utc_msc)
        );
        assert_eq!(fresh.head_range_end_utc_msc, Some(recent.range_end_utc_msc));
        assert!(fresh.coverage_complete);
        drop(store);
        fs::remove_dir_all(root).expect("remove freshness fixture");
    }

    #[test]
    fn incomplete_full_range_cursor_uses_ready_head_without_pseudo_zero_or_leakage() {
        let root = unique_test_directory("history-head-cursor");
        let store = OutboxStore::open_or_create(root.join(BRIDGE_DATABASE_FILE_NAME))
            .expect("head cursor store");
        let scope = history_scope_for("123456");
        let terminal = history_terminal_for(&scope);
        let floor = HISTORY_COVERAGE_START_UTC_MSC;
        let job = NewHistorySyncJob {
            job_id: "job_01JHEADREADY01".to_owned(),
            scope: scope.clone(),
            job_kind: "recent".to_owned(),
            priority: "p2".to_owned(),
            range_start_utc_msc: floor + 1_000,
            range_end_utc_msc: floor + 10_000,
            cursor_time_msc: floor + 1_000,
            cursor_ticket: String::new(),
            window_msc: 9_000,
            created_at_utc_msc: floor + 100_000,
        };
        store.enqueue_history_job(&job).expect("head job");
        let claim = store
            .claim_history_job(&scope, floor + 101_000, 100_000)
            .expect("head claim")
            .expect("head lease");
        store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: vec![serde_json::json!({
                        "deal_ticket": 8001,
                        "time_msc": floor + 9_000,
                        "entry_time_utc_msc": floor + 8_000,
                        "close_time_utc_msc": floor + 9_000,
                        "close_time_server_msc": floor + 9_000,
                        "close_timezone_offset_minutes": 0,
                        "close_business_date": business_date_from_server_msc(floor + 9_000)
                            .expect("head trade business date"),
                        "symbol": "EURUSD",
                        "profit": 2.0
                    })],
                    next_cursor: HistoryCursor {
                        time_msc: floor + 10_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: floor + 102_000,
                },
                9_000,
                floor + 103_000,
            )
            .expect("head persist");
        let page = store
            .read_history_cursor_page_at(
                &terminal,
                &serde_json::json!({
                    "range_start_utc_msc": floor,
                    "range_end_utc_msc": floor + 20_000,
                    "page_size": 20
                }),
                floor + 20_000,
            )
            .expect("incomplete head page");
        assert_eq!(page["orders"].as_array().map(Vec::len), Some(1));
        assert_eq!(page["pagination"]["total_count"], 1);
        assert_eq!(page["history_sync"]["coverage_complete"], false);
        assert_eq!(page["history_sync"]["head_ready"], true);
        assert_eq!(page["history_sync"]["summary_status"], "pending");
        assert_eq!(page["has_more"], false);
        drop(store);
        fs::remove_dir_all(root).expect("remove head cursor fixture");
    }

    #[test]
    fn history_job_batch_validation_and_lease_failures_leave_zero_side_effects() {
        let root = unique_test_directory("history-job-batch-invalid");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let terminal = history_terminal_for(&scope);
        let job = history_job_for("job_01JBATCH0003", &scope, 60_000, 70_000, "p1");
        store
            .enqueue_history_job(&job)
            .expect("enqueue invalid batch");
        let claim = store
            .claim_history_job(&scope, 1_700_000_000_020, 100)
            .expect("claim invalid batch")
            .expect("invalid batch lease");

        let invalid_id = store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![
                        serde_json::json!({
                            "deal_ticket": 2001,
                            "time_msc": 61_000,
                            "symbol": "EURUSD"
                        }),
                        serde_json::json!({
                            "deal_ticket": 0,
                            "time_msc": 62_000,
                            "symbol": "EURUSD"
                        }),
                    ],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 65_000,
                        ticket: "2001".to_owned(),
                    },
                    has_more: true,
                    observed_at_utc_msc: 1_700_000_000_021,
                },
                5_000,
                1_700_000_000_022,
            )
            .expect_err("invalid item id");
        assert_eq!(invalid_id.code(), "bridge_store_history_item_invalid");
        assert_eq!(history_item_count(&store, &scope), 0);
        let unchanged = store
            .history_sync_job(&claim.job_id)
            .expect("unchanged job")
            .expect("unchanged row");
        assert_eq!(unchanged.cursor_time_msc, 60_000);
        assert_eq!(unchanged.cursor_ticket, "");
        assert_eq!(unchanged.state, "running");
        assert!(
            store
                .history_coverage_ranges(&scope)
                .expect("invalid coverage")
                .is_empty()
        );

        let out_of_range = store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![serde_json::json!({
                        "deal_ticket": 2002,
                        "time_msc": 70_000,
                        "symbol": "EURUSD"
                    })],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 65_000,
                        ticket: "2002".to_owned(),
                    },
                    has_more: true,
                    observed_at_utc_msc: 1_700_000_000_023,
                },
                5_000,
                1_700_000_000_024,
            )
            .expect_err("out of range item");
        assert_eq!(
            out_of_range.code(),
            "bridge_store_history_item_out_of_range"
        );
        assert_eq!(history_item_count(&store, &scope), 0);

        let cursor_regression = store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 60_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_000_025,
                },
                5_000,
                1_700_000_000_026,
            )
            .expect_err("cursor regression");
        assert_eq!(
            cursor_regression.code(),
            "bridge_store_history_cursor_regression"
        );
        assert_eq!(history_item_count(&store, &scope), 0);

        let expired = store
            .persist_history_job_batch(
                &terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: vec![serde_json::json!({
                        "deal_ticket": 2003,
                        "time_msc": 63_000,
                        "symbol": "EURUSD"
                    })],
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 65_000,
                        ticket: "2003".to_owned(),
                    },
                    has_more: true,
                    observed_at_utc_msc: 1_700_000_000_027,
                },
                5_000,
                1_700_000_000_121,
            )
            .expect_err("expired lease");
        assert_eq!(expired.code(), "bridge_store_history_lease_invalid");
        assert_eq!(history_item_count(&store, &scope), 0);
        let mismatch_terminal = TerminalDescriptor {
            platform: "mt4".to_owned(),
            ..terminal.clone()
        };
        let platform_error = store
            .persist_history_job_batch(
                &mismatch_terminal,
                &claim.job_id,
                claim.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 65_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_000_028,
                },
                5_000,
                1_700_000_000_029,
            )
            .expect_err("mt4 rejected");
        assert_eq!(platform_error.code(), "bridge_store_history_scope_invalid");
        drop(store);
        fs::remove_dir_all(root).expect("remove invalid batch fixture");
    }

    #[test]
    fn independent_store_handles_compete_for_only_one_history_claim() {
        let root = unique_test_directory("history-claim-race");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let first_store = Arc::new(OutboxStore::open_or_create(&path).expect("first store"));
        let second_store = Arc::new(OutboxStore::open_existing(&path).expect("second store"));
        let scope = history_scope_for("123456");
        first_store
            .enqueue_history_job(&history_job_for(
                "job_01JRACE0001",
                &scope,
                11_000,
                12_000,
                "p1",
            ))
            .expect("enqueue race");
        let first_for_thread = Arc::clone(&first_store);
        let second_for_thread = Arc::clone(&second_store);
        let first_scope = scope.clone();
        let second_scope = scope.clone();
        let (first_result, second_result) = std::thread::scope(|threads| {
            let first = threads.spawn(move || {
                first_for_thread.claim_history_job(&first_scope, 1_700_000_000_000, 10_000)
            });
            let second = threads.spawn(move || {
                second_for_thread.claim_history_job(&second_scope, 1_700_000_000_000, 10_000)
            });
            (
                first.join().expect("first claim thread"),
                second.join().expect("second claim thread"),
            )
        });
        assert_eq!(
            usize::from(first_result.as_ref().expect("first claim result").is_some())
                + usize::from(
                    second_result
                        .as_ref()
                        .expect("second claim result")
                        .is_some()
                ),
            1
        );
        drop(first_store);
        drop(second_store);
        fs::remove_dir_all(root).expect("remove claim race fixture");
    }

    #[test]
    fn expired_history_lease_can_be_reclaimed_but_old_generation_cannot_write() {
        let root = unique_test_directory("history-lease");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let job = history_job_for("job_01JLEASE0001", &scope, 7_000, 8_000, "p1");
        store.enqueue_history_job(&job).expect("enqueue lease");
        let first = store
            .claim_history_job(&scope, 1_700_000_000_000, 10)
            .expect("first claim")
            .expect("first lease");
        store
            .checkpoint_history_job(
                &first.job_id,
                first.lease_generation,
                7_500,
                "123",
                500,
                1_700_000_000_005,
            )
            .expect("forward checkpoint");
        assert_eq!(
            store
                .checkpoint_history_job(
                    &first.job_id,
                    first.lease_generation,
                    7_400,
                    "124",
                    500,
                    1_700_000_000_006,
                )
                .expect_err("cursor regression")
                .code(),
            "bridge_store_history_checkpoint_regression"
        );
        assert_eq!(
            store
                .checkpoint_history_job(
                    &first.job_id,
                    first.lease_generation,
                    8_000,
                    "1",
                    500,
                    1_700_000_000_007,
                )
                .expect_err("endpoint ticket")
                .code(),
            "bridge_store_history_checkpoint_invalid"
        );
        let second = store
            .claim_history_job(&scope, 1_700_000_000_011, 10)
            .expect("reclaim")
            .expect("second lease");
        assert_eq!(second.lease_generation, first.lease_generation + 1);
        assert_eq!(
            store
                .checkpoint_history_job(
                    &first.job_id,
                    first.lease_generation,
                    7_500,
                    "123",
                    500,
                    1_700_000_000_012,
                )
                .expect_err("old checkpoint")
                .code(),
            "bridge_store_history_lease_invalid"
        );
        assert_eq!(
            store
                .persist_history_job_batch(
                    &history_terminal_for(&scope),
                    &first.job_id,
                    first.lease_generation,
                    &HistoryArchiveBatch {
                        deals: Vec::new(),
                        history_orders: Vec::new(),
                        trades: Vec::new(),
                        next_cursor: HistoryCursor {
                            time_msc: 8_000,
                            ticket: "0".to_owned(),
                        },
                        has_more: false,
                        observed_at_utc_msc: 1_700_000_000_012,
                    },
                    1_000,
                    1_700_000_000_012,
                )
                .expect_err("old complete")
                .code(),
            "bridge_store_history_lease_invalid"
        );
        let result = store
            .persist_history_job_batch(
                &history_terminal_for(&scope),
                &second.job_id,
                second.lease_generation,
                &HistoryArchiveBatch {
                    deals: Vec::new(),
                    history_orders: Vec::new(),
                    trades: Vec::new(),
                    next_cursor: HistoryCursor {
                        time_msc: 8_000,
                        ticket: "0".to_owned(),
                    },
                    has_more: false,
                    observed_at_utc_msc: 1_700_000_000_013,
                },
                1_000,
                1_700_000_000_013,
            )
            .expect("new complete");
        assert_eq!(result.status, HistoryJobBatchStatus::Completed);
        assert!(
            store
                .is_history_range_covered(&scope, 7_000, 8_000)
                .expect("coverage")
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove lease fixture");
    }

    #[test]
    fn history_lease_renewal_preserves_generation_and_rejects_stale_or_expired_leases() {
        let root = unique_test_directory("history-renew");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let job = history_job_for("job_01JRENEW0001", &scope, 9_000, 10_000, "p1");
        store.enqueue_history_job(&job).expect("enqueue renew");
        let claim = store
            .claim_history_job(&scope, 1_700_000_000_000, 100)
            .expect("claim renew")
            .expect("renew lease");
        let renewed = store
            .renew_history_job(
                &claim.job_id,
                claim.lease_generation,
                1_700_000_000_010,
                200,
            )
            .expect("renew");
        assert_eq!(renewed.lease_generation, claim.lease_generation);
        assert_eq!(renewed.lease_expires_at_utc_msc, Some(1_700_000_000_210));
        assert_eq!(
            store
                .renew_history_job(
                    &claim.job_id,
                    claim.lease_generation - 1,
                    1_700_000_000_020,
                    200,
                )
                .expect_err("stale generation")
                .code(),
            "bridge_store_history_lease_invalid"
        );
        assert_eq!(
            store
                .renew_history_job(
                    &claim.job_id,
                    claim.lease_generation,
                    1_700_000_000_211,
                    200,
                )
                .expect_err("expired lease")
                .code(),
            "bridge_store_history_lease_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove renew fixture");
    }

    #[test]
    fn history_job_rejects_invalid_ranges_states_priorities_and_ids() {
        let root = unique_test_directory("history-invalid");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        let store = OutboxStore::open_or_create(&path).expect("store");
        let scope = history_scope_for("123456");
        let mut invalid = history_job_for("job_01JINVALID01", &scope, 1_000, 2_000, "p1");
        invalid.range_end_utc_msc = invalid.range_start_utc_msc;
        assert_eq!(
            store
                .enqueue_history_job(&invalid)
                .expect_err("range")
                .code(),
            "bridge_store_history_range_invalid"
        );
        let mut invalid_priority =
            history_job_for("job_01JINVALID02", &scope, 1_000, 2_000, "urgent");
        assert_eq!(
            store
                .enqueue_history_job(&invalid_priority)
                .expect_err("priority")
                .code(),
            "bridge_store_history_priority_invalid"
        );
        invalid_priority.priority = "p1".to_owned();
        invalid_priority.job_id = "bad id".to_owned();
        assert_eq!(
            store
                .enqueue_history_job(&invalid_priority)
                .expect_err("id")
                .code(),
            "bridge_store_history_job_id_invalid"
        );
        drop(store);
        fs::remove_dir_all(root).expect("remove invalid fixture");
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
