use bridge_contract::{CommandMessage, CommandResultMessage, ExecutionEvidence};
use bridge_store::{CommandLedgerRecord, OutboxStore, StoreError};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, OnceCell};
use tokio::time::timeout;

const DEFAULT_RECEIPT_LIMIT: usize = 10_000;
type DispatchOutcome = Result<CommandResultMessage, CommandDispatchError>;
type DispatchCell = Arc<OnceCell<DispatchOutcome>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandDispatchError {
    code: String,
}

impl CommandDispatchError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl Display for CommandDispatchError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for CommandDispatchError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandWorkerError {
    code: String,
}

impl CommandWorkerError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

pub trait CommandAdmissionPolicy: Send + Sync {
    fn validate(
        &self,
        command: &CommandMessage,
        now_utc_msc: i64,
    ) -> Result<(), CommandDispatchError>;
}

pub trait CommandWorker: Send + Sync {
    fn execute(
        &self,
        command: CommandMessage,
    ) -> BoxFuture<'_, Result<CommandResultMessage, CommandWorkerError>>;
}

pub trait CommandExecutionObserver: Send + Sync {
    fn command_succeeded(&self, result: &CommandResultMessage);
}

pub struct CommandDispatcher {
    store: Arc<OutboxStore>,
    admission: Arc<dyn CommandAdmissionPolicy>,
    worker: Arc<dyn CommandWorker>,
    execution_observer: Option<Arc<dyn CommandExecutionObserver>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    worker_timeout: Duration,
    receipt_limit: usize,
    sequence: AtomicU64,
    in_flight: Mutex<HashMap<String, DispatchCell>>,
}

impl CommandDispatcher {
    pub fn new(
        store: Arc<OutboxStore>,
        admission: Arc<dyn CommandAdmissionPolicy>,
        worker: Arc<dyn CommandWorker>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        worker_timeout: Duration,
    ) -> Result<Self, CommandDispatchError> {
        if worker_timeout.is_zero() {
            return Err(CommandDispatchError::new("bridge_command_timeout_invalid"));
        }
        Ok(Self {
            store,
            admission,
            worker,
            execution_observer: None,
            clock,
            worker_timeout,
            receipt_limit: DEFAULT_RECEIPT_LIMIT,
            sequence: AtomicU64::new(0),
            in_flight: Mutex::new(HashMap::new()),
        })
    }

    pub fn with_execution_observer(mut self, observer: Arc<dyn CommandExecutionObserver>) -> Self {
        self.execution_observer = Some(observer);
        self
    }

    pub async fn dispatch(
        &self,
        command: CommandMessage,
    ) -> Result<CommandResultMessage, CommandDispatchError> {
        let received_at = self.now()?;
        let recorded = self.record_command(command.clone(), received_at).await?;
        if let Some(receipt) = self.read_receipt(&command.command_id).await? {
            return Ok(receipt);
        }
        let cell = {
            let mut in_flight = self.in_flight.lock().await;
            Arc::clone(
                in_flight
                    .entry(command.command_id.clone())
                    .or_insert_with(|| Arc::new(OnceCell::new())),
            )
        };
        let result = cell
            .get_or_init(|| self.dispatch_once(command.clone(), recorded.clone()))
            .await
            .clone();
        let mut in_flight = self.in_flight.lock().await;
        if in_flight
            .get(&command.command_id)
            .is_some_and(|existing| Arc::ptr_eq(existing, &cell))
        {
            in_flight.remove(&command.command_id);
        }
        result
    }

    pub async fn in_flight_count(&self) -> usize {
        self.in_flight.lock().await.len()
    }

    async fn dispatch_once(
        &self,
        command: CommandMessage,
        recorded: bridge_store::RecordedCommand,
    ) -> Result<CommandResultMessage, CommandDispatchError> {
        if let Some(receipt) = self.read_receipt(&command.command_id).await? {
            return Ok(receipt);
        }
        if recorded.record.status != "persisted" {
            return self
                .persist_result(self.synthetic_result(
                    &command,
                    "uncertain",
                    "worker_execution_interrupted",
                )?)
                .await;
        }

        let now = self.now()?;
        if let Err(error) = self.admission.validate(&command, now) {
            if error.code() == "bridge_command_admission_paused" {
                return Err(error);
            }
            return self
                .persist_result(self.synthetic_result(&command, "rejected", error.code())?)
                .await;
        }

        self.mark_dispatched(command.command_id.clone(), now)
            .await?;
        let remaining_msc = command.deadline_utc_msc.saturating_sub(now);
        if remaining_msc <= 0 {
            return self
                .persist_result(self.synthetic_result(&command, "rejected", "command_expired")?)
                .await;
        }
        let execution_timeout = self
            .worker_timeout
            .min(Duration::from_millis(remaining_msc as u64));
        let execution = AssertUnwindSafe(self.worker.execute(command.clone())).catch_unwind();
        let result = match timeout(execution_timeout, execution).await {
            Err(_) => self.synthetic_result(&command, "uncertain", "worker_execution_timeout")?,
            Ok(Err(_)) => {
                self.synthetic_result(&command, "uncertain", "worker_execution_exception")?
            }
            Ok(Ok(Err(error))) => self.synthetic_result(
                &command,
                "uncertain",
                normalized_worker_error_code(error.code()),
            )?,
            Ok(Ok(Ok(result))) => {
                if result.validate().is_err() || !result.matches_command(&command) {
                    self.synthetic_result(&command, "uncertain", "worker_result_route_mismatch")?
                } else {
                    result
                }
            }
        };
        let persisted = self.persist_result(result).await?;
        if persisted.status == "succeeded"
            && let Some(observer) = &self.execution_observer
        {
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
                observer.command_succeeded(&persisted);
            }));
        }
        Ok(persisted)
    }

    async fn read_receipt(
        &self,
        command_id: &str,
    ) -> Result<Option<CommandResultMessage>, CommandDispatchError> {
        let store = Arc::clone(&self.store);
        let command_id = command_id.to_owned();
        tokio::task::spawn_blocking(move || store.execution_receipt(&command_id))
            .await
            .map_err(|_| CommandDispatchError::new("bridge_command_store_worker_failed"))?
            .map_err(store_error)
    }

    async fn record_command(
        &self,
        command: CommandMessage,
        now_utc_msc: i64,
    ) -> Result<bridge_store::RecordedCommand, CommandDispatchError> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.record_command(&command, now_utc_msc))
            .await
            .map_err(|_| CommandDispatchError::new("bridge_command_store_worker_failed"))?
            .map_err(store_error)
    }

    async fn mark_dispatched(
        &self,
        command_id: String,
        now_utc_msc: i64,
    ) -> Result<(), CommandDispatchError> {
        let store = Arc::clone(&self.store);
        tokio::task::spawn_blocking(move || store.mark_command_dispatched(&command_id, now_utc_msc))
            .await
            .map_err(|_| CommandDispatchError::new("bridge_command_store_worker_failed"))?
            .map_err(store_error)
    }

    async fn persist_result(
        &self,
        result: CommandResultMessage,
    ) -> Result<CommandResultMessage, CommandDispatchError> {
        let store = Arc::clone(&self.store);
        let persisted = result.clone();
        let receipt_limit = self.receipt_limit;
        tokio::task::spawn_blocking(move || {
            store.save_execution_receipt(&persisted, receipt_limit)
        })
        .await
        .map_err(|_| CommandDispatchError::new("bridge_command_store_worker_failed"))?
        .map_err(store_error)?;
        Ok(result)
    }

    fn synthetic_result(
        &self,
        command: &CommandMessage,
        status: &str,
        error_code: &str,
    ) -> Result<CommandResultMessage, CommandDispatchError> {
        let now = self.now()?;
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let result = CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: format!("result_{now:x}_{sequence:x}"),
            sent_at_utc_msc: now,
            command_id: command.command_id.clone(),
            terminal_instance_id: command.terminal_instance_id.clone(),
            account_ref: command.account_ref.clone(),
            connection_epoch: command.connection_epoch,
            status: status.to_owned(),
            completed_at_utc_msc: now,
            error_code: Some(error_code.to_owned()),
            error_message: None,
            raw_result: Some(serde_json::json!({})),
            evidence: ExecutionEvidence {
                observed_at_utc_msc: now,
                order_tickets: Vec::new(),
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: None,
            },
        };
        result
            .validate()
            .map_err(|_| CommandDispatchError::new("bridge_command_result_invalid"))?;
        Ok(result)
    }

    fn now(&self) -> Result<i64, CommandDispatchError> {
        let now = (self.clock)();
        if now <= 0 {
            Err(CommandDispatchError::new(
                "bridge_message_timestamp_invalid",
            ))
        } else {
            Ok(now)
        }
    }
}

fn store_error(error: StoreError) -> CommandDispatchError {
    CommandDispatchError::new(error.code())
}

fn normalized_worker_error_code(code: &str) -> &str {
    if !code.is_empty()
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        code
    } else {
        "worker_execution_exception"
    }
}

pub fn ledger_requires_reconciliation(record: &CommandLedgerRecord) -> bool {
    matches!(record.status.as_str(), "dispatched" | "uncertain")
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::{AccountRef, TerminalDescriptor};
    use bridge_store::{BRIDGE_DATABASE_FILE_NAME, REQUIRED_SCHEMA};
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const NOW: i64 = 1_800_000_000_000;

    struct AllowAdmission;

    impl CommandAdmissionPolicy for AllowAdmission {
        fn validate(
            &self,
            command: &CommandMessage,
            now_utc_msc: i64,
        ) -> Result<(), CommandDispatchError> {
            command
                .validate(now_utc_msc)
                .map_err(CommandDispatchError::new)
        }
    }

    struct RejectAdmission(&'static str);

    impl CommandAdmissionPolicy for RejectAdmission {
        fn validate(
            &self,
            _command: &CommandMessage,
            _now_utc_msc: i64,
        ) -> Result<(), CommandDispatchError> {
            Err(CommandDispatchError::new(self.0))
        }
    }

    #[derive(Clone, Copy)]
    enum WorkerMode {
        Success,
        Delay,
        InvalidError,
        Mismatch,
        Panic,
    }

    struct FakeWorker {
        mode: WorkerMode,
        calls: AtomicUsize,
    }

    #[derive(Default)]
    struct CountingObserver(AtomicUsize);

    impl CommandExecutionObserver for CountingObserver {
        fn command_succeeded(&self, _result: &CommandResultMessage) {
            self.0.fetch_add(1, AtomicOrdering::SeqCst);
        }
    }

    struct PanickingObserver;

    impl CommandExecutionObserver for PanickingObserver {
        fn command_succeeded(&self, _result: &CommandResultMessage) {
            panic!("simulated post-execution observer failure");
        }
    }

    impl FakeWorker {
        fn new(mode: WorkerMode) -> Self {
            Self {
                mode,
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl CommandWorker for FakeWorker {
        fn execute(
            &self,
            command: CommandMessage,
        ) -> BoxFuture<'_, Result<CommandResultMessage, CommandWorkerError>> {
            self.calls.fetch_add(1, AtomicOrdering::SeqCst);
            let mode = self.mode;
            Box::pin(async move {
                match mode {
                    WorkerMode::Delay => tokio::time::sleep(Duration::from_millis(100)).await,
                    WorkerMode::InvalidError => {
                        return Err(CommandWorkerError::new("invalid-worker-error!"));
                    }
                    WorkerMode::Panic => panic!("simulated worker panic"),
                    WorkerMode::Success | WorkerMode::Mismatch => {}
                }
                let mut result = success(&command);
                if matches!(mode, WorkerMode::Mismatch) {
                    result.connection_epoch += 1;
                }
                Ok(result)
            })
        }
    }

    fn terminal() -> TerminalDescriptor {
        TerminalDescriptor {
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            worker_version: Some("3.0.0".to_owned()),
        }
    }

    fn command(command_id: &str) -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: format!("message_{command_id}"),
            sent_at_utc_msc: NOW,
            command_id: command_id.to_owned(),
            terminal_instance_id: terminal().terminal_instance_id,
            account_ref: terminal().account_ref,
            connection_epoch: 7,
            issued_at_utc_msc: NOW,
            deadline_utc_msc: NOW + 10_000,
            action: "place_order".to_owned(),
            params: serde_json::json!({ "symbol": "XAUUSD", "volume": 0.01 }),
        }
    }

    fn success(command: &CommandMessage) -> CommandResultMessage {
        CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: format!("result_{}", command.command_id),
            sent_at_utc_msc: NOW + 1,
            command_id: command.command_id.clone(),
            terminal_instance_id: command.terminal_instance_id.clone(),
            account_ref: command.account_ref.clone(),
            connection_epoch: command.connection_epoch,
            status: "succeeded".to_owned(),
            completed_at_utc_msc: NOW + 1,
            error_code: None,
            error_message: None,
            raw_result: Some(serde_json::json!({ "retcode": 10009 })),
            evidence: ExecutionEvidence {
                observed_at_utc_msc: NOW + 1,
                order_tickets: vec!["1001".to_owned()],
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: Some(10009),
            },
        }
    }

    fn dispatcher(
        store: Arc<OutboxStore>,
        admission: Arc<dyn CommandAdmissionPolicy>,
        worker: Arc<dyn CommandWorker>,
        worker_timeout: Duration,
    ) -> Arc<CommandDispatcher> {
        Arc::new(
            CommandDispatcher::new(store, admission, worker, Arc::new(|| NOW), worker_timeout)
                .expect("dispatcher"),
        )
    }

    #[tokio::test]
    async fn concurrent_duplicates_execute_once_and_restart_uses_the_receipt() {
        let fixture = StoreFixture::new("single-flight");
        let worker = Arc::new(FakeWorker::new(WorkerMode::Delay));
        let observer = Arc::new(CountingObserver::default());
        let active_dispatcher = Arc::new(
            CommandDispatcher::new(
                fixture.store(),
                Arc::new(AllowAdmission),
                worker.clone(),
                Arc::new(|| NOW),
                Duration::from_secs(1),
            )
            .expect("dispatcher")
            .with_execution_observer(observer.clone()),
        );
        let command = command("command_01JSINGLEFLT");
        let results = futures_util::future::join_all((0..64).map(|_| {
            let dispatcher = Arc::clone(&active_dispatcher);
            let command = command.clone();
            async move { dispatcher.dispatch(command).await }
        }))
        .await;
        assert!(results.iter().all(|result| {
            result
                .as_ref()
                .is_ok_and(|result| result.status == "succeeded")
        }));
        assert_eq!(worker.calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(observer.0.load(AtomicOrdering::SeqCst), 1);

        let restarted_worker = Arc::new(FakeWorker::new(WorkerMode::Success));
        let restarted = dispatcher(
            fixture.store(),
            Arc::new(AllowAdmission),
            restarted_worker.clone(),
            Duration::from_secs(1),
        );
        assert_eq!(
            restarted
                .dispatch(command)
                .await
                .expect("persisted receipt")
                .status,
            "succeeded"
        );
        assert_eq!(restarted_worker.calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(observer.0.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_conflicting_command_id_is_rejected_during_and_after_execution() {
        let fixture = StoreFixture::new("command-id-conflict");
        let worker = Arc::new(FakeWorker::new(WorkerMode::Delay));
        let dispatcher = dispatcher(
            fixture.store(),
            Arc::new(AllowAdmission),
            worker.clone(),
            Duration::from_secs(1),
        );
        let original = command("command_01JCONFLICT1");
        let mut conflicting = original.clone();
        conflicting.params = serde_json::json!({ "symbol": "XAUUSD", "volume": 1.0 });
        let active = {
            let dispatcher = dispatcher.clone();
            let original = original.clone();
            tokio::spawn(async move { dispatcher.dispatch(original).await })
        };
        while worker.calls.load(AtomicOrdering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            dispatcher
                .dispatch(conflicting.clone())
                .await
                .expect_err("in-flight command id conflict")
                .code(),
            "bridge_command_id_conflict"
        );
        assert_eq!(
            active
                .await
                .expect("active task")
                .expect("original result")
                .status,
            "succeeded"
        );
        assert_eq!(
            dispatcher
                .dispatch(conflicting)
                .await
                .expect_err("persisted command id conflict")
                .code(),
            "bridge_command_id_conflict"
        );
        assert_eq!(worker.calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn post_execution_observer_failure_never_changes_the_durable_success() {
        let fixture = StoreFixture::new("observer-panic");
        let worker = Arc::new(FakeWorker::new(WorkerMode::Success));
        let dispatcher = CommandDispatcher::new(
            fixture.store(),
            Arc::new(AllowAdmission),
            worker.clone(),
            Arc::new(|| NOW),
            Duration::from_secs(1),
        )
        .expect("dispatcher")
        .with_execution_observer(Arc::new(PanickingObserver));
        let command = command("command_01JOBSERVER1");
        let first = dispatcher
            .dispatch(command.clone())
            .await
            .expect("persisted success");
        let duplicate = dispatcher
            .dispatch(command)
            .await
            .expect("durable duplicate");
        assert_eq!(first.status, "succeeded");
        assert_eq!(duplicate, first);
        assert_eq!(worker.calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn timeout_panic_and_route_mismatch_are_durable_uncertain_results() {
        for (suffix, mode, timeout_duration, expected) in [
            (
                "TIMEOUT",
                WorkerMode::Delay,
                Duration::from_millis(5),
                "worker_execution_timeout",
            ),
            (
                "PANIC01",
                WorkerMode::Panic,
                Duration::from_secs(1),
                "worker_execution_exception",
            ),
            (
                "BADERR1",
                WorkerMode::InvalidError,
                Duration::from_secs(1),
                "worker_execution_exception",
            ),
            (
                "ROUTE01",
                WorkerMode::Mismatch,
                Duration::from_secs(1),
                "worker_result_route_mismatch",
            ),
        ] {
            let fixture = StoreFixture::new(suffix);
            let worker = Arc::new(FakeWorker::new(mode));
            let dispatcher = dispatcher(
                fixture.store(),
                Arc::new(AllowAdmission),
                worker.clone(),
                timeout_duration,
            );
            let command = command(&format!("command_01J{suffix}01"));
            let first = dispatcher
                .dispatch(command.clone())
                .await
                .expect("uncertain result");
            let duplicate = dispatcher.dispatch(command).await.expect("durable result");
            assert_eq!(first.status, "uncertain");
            assert_eq!(first.error_code.as_deref(), Some(expected));
            assert_eq!(duplicate, first);
            assert_eq!(worker.calls.load(AtomicOrdering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn a_dispatched_command_without_a_receipt_is_never_replayed_after_restart() {
        let fixture = StoreFixture::new("interrupted");
        let command = command("command_01JINTERRUPT");
        fixture
            .store_ref()
            .record_command(&command, NOW)
            .expect("persist command");
        fixture
            .store_ref()
            .mark_command_dispatched(&command.command_id, NOW + 1)
            .expect("mark dispatched");
        let worker = Arc::new(FakeWorker::new(WorkerMode::Success));
        let dispatcher = dispatcher(
            fixture.store(),
            Arc::new(AllowAdmission),
            worker.clone(),
            Duration::from_secs(1),
        );
        let result = dispatcher
            .dispatch(command)
            .await
            .expect("interrupted result");
        assert_eq!(result.status, "uncertain");
        assert_eq!(
            result.error_code.as_deref(),
            Some("worker_execution_interrupted")
        );
        assert_eq!(worker.calls.load(AtomicOrdering::SeqCst), 0);
    }

    #[tokio::test]
    async fn validation_rejection_is_persisted_but_pause_is_not_admitted() {
        let rejected_fixture = StoreFixture::new("rejected");
        let worker = Arc::new(FakeWorker::new(WorkerMode::Success));
        let rejected = dispatcher(
            rejected_fixture.store(),
            Arc::new(RejectAdmission("command_route_mismatch")),
            worker.clone(),
            Duration::from_secs(1),
        )
        .dispatch(command("command_01JREJECT01"))
        .await
        .expect("rejected result");
        assert_eq!(rejected.status, "rejected");
        assert_eq!(
            rejected.error_code.as_deref(),
            Some("command_route_mismatch")
        );
        assert_eq!(worker.calls.load(AtomicOrdering::SeqCst), 0);

        let paused_fixture = StoreFixture::new("paused");
        let paused = dispatcher(
            paused_fixture.store(),
            Arc::new(RejectAdmission("bridge_command_admission_paused")),
            worker,
            Duration::from_secs(1),
        )
        .dispatch(command("command_01JPAUSED001"))
        .await
        .expect_err("paused admission");
        assert_eq!(paused.code(), "bridge_command_admission_paused");
    }

    struct StoreFixture {
        root: PathBuf,
        store: Option<Arc<OutboxStore>>,
    }

    impl StoreFixture {
        fn new(suffix: &str) -> Self {
            let root = unique_test_directory(suffix);
            fs::create_dir_all(&root).expect("fixture directory");
            let path = root.join(BRIDGE_DATABASE_FILE_NAME);
            create_schema_fixture(&path);
            Self {
                root,
                store: Some(Arc::new(OutboxStore::open_existing(path).expect("store"))),
            }
        }

        fn store(&self) -> Arc<OutboxStore> {
            Arc::clone(self.store_ref())
        }

        fn store_ref(&self) -> &Arc<OutboxStore> {
            self.store.as_ref().expect("fixture store")
        }
    }

    impl Drop for StoreFixture {
        fn drop(&mut self) {
            drop(self.store.take());
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn create_schema_fixture(path: &Path) {
        let connection = Connection::open(path).expect("fixture sqlite");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("fixture wal");
        for (table, columns) in REQUIRED_SCHEMA {
            match *table {
                "outbox_messages" => connection
                    .execute_batch(
                        "CREATE TABLE outbox_messages (
                           id INTEGER PRIMARY KEY AUTOINCREMENT,
                           message_id TEXT NOT NULL UNIQUE,
                           message_type TEXT NOT NULL,
                           terminal_instance_id TEXT NOT NULL,
                           connection_epoch INTEGER NOT NULL,
                           priority TEXT NOT NULL,
                           payload_json TEXT NOT NULL,
                           attempt_count INTEGER NOT NULL DEFAULT 0,
                           next_attempt_at_utc_msc INTEGER,
                           created_at_utc_msc INTEGER NOT NULL,
                           acked_at_utc_msc INTEGER
                         );",
                    )
                    .expect("outbox schema"),
                "execution_receipts" => connection
                    .execute_batch(
                        "CREATE TABLE execution_receipts (
                           command_id TEXT PRIMARY KEY,
                           terminal_instance_id TEXT NOT NULL,
                           connection_epoch INTEGER NOT NULL,
                           status TEXT NOT NULL,
                           result_json TEXT NOT NULL,
                           completed_at_utc_msc INTEGER NOT NULL
                         );",
                    )
                    .expect("receipt schema"),
                _ => {
                    let definitions = columns
                        .iter()
                        .map(|column| format!("{column} TEXT"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    connection
                        .execute_batch(&format!("CREATE TABLE {table} ({definitions});"))
                        .expect("fixture table");
                }
            }
        }
    }

    fn unique_test_directory(suffix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-command-{}-{}-{suffix}",
            std::process::id(),
            stamp
        ))
    }
}
