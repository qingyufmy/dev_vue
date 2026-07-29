use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::Path;
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
