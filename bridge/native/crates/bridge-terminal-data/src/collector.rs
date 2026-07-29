use crate::{ProjectionError, ProjectionStore, SnapshotProjector, new_random_id};
use bridge_worker_host::{
    SnapshotRequest, SnapshotStream, TerminalSnapshot, WorkerDataRouter, WorkerHostError,
    WorkerRoute,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, watch};

const CONTROL_QUEUE_CAPACITY: usize = 32;
const SNAPSHOT_STREAMS: [SnapshotStream; 3] = [
    SnapshotStream::Account,
    SnapshotStream::Positions,
    SnapshotStream::Orders,
];

pub trait SnapshotSource: Send + Sync {
    fn collect_snapshot<'a>(
        &'a self,
        route: WorkerRoute,
        request_id: String,
        streams: Vec<SnapshotStream>,
    ) -> Pin<Box<dyn Future<Output = Result<TerminalSnapshot, WorkerHostError>> + Send + 'a>>;
}

impl<S> SnapshotSource for WorkerDataRouter<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    fn collect_snapshot<'a>(
        &'a self,
        route: WorkerRoute,
        request_id: String,
        streams: Vec<SnapshotStream>,
    ) -> Pin<Box<dyn Future<Output = Result<TerminalSnapshot, WorkerHostError>> + Send + 'a>> {
        Box::pin(WorkerDataRouter::collect_snapshot(
            self, route, request_id, streams,
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CollectorPolicy {
    pub active_interval: Duration,
    pub idle_interval: Duration,
    pub retry_initial: Duration,
    pub retry_max: Duration,
}

impl Default for CollectorPolicy {
    fn default() -> Self {
        Self {
            active_interval: Duration::from_millis(250),
            idle_interval: Duration::from_secs(1),
            retry_initial: Duration::from_millis(500),
            retry_max: Duration::from_secs(10),
        }
    }
}

impl CollectorPolicy {
    fn validate(&self) -> Result<(), ProjectionError> {
        if self.active_interval.is_zero()
            || self.idle_interval.is_zero()
            || self.retry_initial.is_zero()
            || self.retry_max.is_zero()
            || self.active_interval > self.idle_interval
            || self.retry_initial > self.retry_max
        {
            return Err(ProjectionError::new("terminal_collector_policy_invalid"));
        }
        Ok(())
    }

    fn retry_delay(&self, consecutive_failures: u32) -> Duration {
        let shift = consecutive_failures.saturating_sub(1).min(31);
        self.retry_initial
            .checked_mul(1_u32 << shift)
            .unwrap_or(self.retry_max)
            .min(self.retry_max)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CollectorLifecycleState {
    Starting,
    Ready,
    Retrying,
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectorStatus {
    pub route: WorkerRoute,
    pub state: CollectorLifecycleState,
    pub active_positions_or_orders: bool,
    pub consecutive_failures: u32,
    pub last_success_at_utc_msc: Option<i64>,
    pub error_code: Option<String>,
}

#[derive(Clone)]
pub struct CollectorHandle {
    control_tx: mpsc::Sender<CollectorControl>,
    stop_tx: watch::Sender<bool>,
    status_rx: watch::Receiver<CollectorStatus>,
}

impl CollectorHandle {
    pub fn wake(&self) -> Result<(), ProjectionError> {
        self.send_control(CollectorControl::Wake)
    }

    pub fn request_full_snapshot(&self, stream: &str) -> Result<(), ProjectionError> {
        if !matches!(stream, "account" | "positions" | "orders") {
            return Err(ProjectionError::new("terminal_projection_stream_invalid"));
        }
        self.send_control(CollectorControl::RequestFullSnapshot(stream.to_owned()))
    }

    pub fn request_all_full_snapshots(&self) -> Result<(), ProjectionError> {
        self.send_control(CollectorControl::RequestAllFullSnapshots)
    }

    pub fn stop(&self) {
        self.stop_tx.send_replace(true);
    }

    pub fn status(&self) -> CollectorStatus {
        self.status_rx.borrow().clone()
    }

    pub fn subscribe_status(&self) -> watch::Receiver<CollectorStatus> {
        self.status_rx.clone()
    }

    fn send_control(&self, control: CollectorControl) -> Result<(), ProjectionError> {
        self.control_tx
            .try_send(control)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    ProjectionError::new("terminal_collector_control_queue_full")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    ProjectionError::new("terminal_collector_stopped")
                }
            })
    }
}

enum CollectorControl {
    Wake,
    RequestFullSnapshot(String),
    RequestAllFullSnapshots,
}

pub struct SnapshotCollector<S, P> {
    source: Arc<S>,
    projector: SnapshotProjector<P>,
    route: WorkerRoute,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    policy: CollectorPolicy,
    control_rx: mpsc::Receiver<CollectorControl>,
    stop_rx: watch::Receiver<bool>,
    status_tx: watch::Sender<CollectorStatus>,
    active_positions_or_orders: bool,
    consecutive_failures: u32,
}

impl<S, P> SnapshotCollector<S, P>
where
    S: SnapshotSource,
    P: ProjectionStore,
{
    pub fn new(
        source: Arc<S>,
        projector: SnapshotProjector<P>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        policy: CollectorPolicy,
    ) -> Result<(Self, CollectorHandle), ProjectionError> {
        policy.validate()?;
        let route = projector.route().clone();
        route.validate()?;
        let initial_status = CollectorStatus {
            route: route.clone(),
            state: CollectorLifecycleState::Starting,
            active_positions_or_orders: false,
            consecutive_failures: 0,
            last_success_at_utc_msc: None,
            error_code: None,
        };
        let (control_tx, control_rx) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
        let (stop_tx, stop_rx) = watch::channel(false);
        let (status_tx, status_rx) = watch::channel(initial_status);
        let handle = CollectorHandle {
            control_tx,
            stop_tx,
            status_rx,
        };
        Ok((
            Self {
                source,
                projector,
                route,
                clock,
                policy,
                control_rx,
                stop_rx,
                status_tx,
                active_positions_or_orders: false,
                consecutive_failures: 0,
            },
            handle,
        ))
    }

    pub async fn run(mut self) {
        let mut next_delay = Duration::ZERO;
        let mut control_open = true;
        loop {
            tokio::select! {
                biased;
                changed = self.stop_rx.changed() => {
                    if changed.is_err() || *self.stop_rx.borrow() {
                        break;
                    }
                }
                control = self.control_rx.recv(), if control_open => {
                    match control {
                        Some(control) => {
                            if let Err(error) = self.apply_control(control) {
                                self.publish_failure(error.code());
                                next_delay = self.policy.retry_delay(self.consecutive_failures);
                            } else {
                                next_delay = Duration::ZERO;
                            }
                        }
                        None => control_open = false,
                    }
                }
                _ = tokio::time::sleep(next_delay) => {
                    next_delay = match self.collect_once().await {
                        Ok(active) => {
                            self.publish_success(active);
                            if active {
                                self.policy.active_interval
                            } else {
                                self.policy.idle_interval
                            }
                        }
                        Err(error) => {
                            self.publish_failure(error.code());
                            self.policy.retry_delay(self.consecutive_failures)
                        }
                    };
                }
            }
        }
        let mut status = self.status_tx.borrow().clone();
        status.state = CollectorLifecycleState::Stopped;
        status.error_code = None;
        self.status_tx.send_replace(status);
    }

    async fn collect_once(&mut self) -> Result<bool, ProjectionError> {
        let request_id = new_random_id("snapshot_")?;
        let streams = SNAPSHOT_STREAMS.to_vec();
        let snapshot = self
            .source
            .collect_snapshot(self.route.clone(), request_id, streams.clone())
            .await?;
        snapshot.validate_for(&SnapshotRequest { streams }, &self.route)?;
        let active = snapshot
            .streams
            .positions
            .as_ref()
            .is_some_and(|items| !items.is_empty())
            || snapshot
                .streams
                .orders
                .as_ref()
                .is_some_and(|items| !items.is_empty());
        self.projector.ingest(snapshot, (self.clock)())?;
        Ok(active)
    }

    fn apply_control(&mut self, control: CollectorControl) -> Result<(), ProjectionError> {
        match control {
            CollectorControl::Wake => Ok(()),
            CollectorControl::RequestFullSnapshot(stream) => {
                self.projector.request_full_snapshot(&stream)
            }
            CollectorControl::RequestAllFullSnapshots => {
                self.projector.request_all_full_snapshots();
                Ok(())
            }
        }
    }

    fn publish_success(&mut self, active: bool) {
        self.active_positions_or_orders = active;
        self.consecutive_failures = 0;
        self.status_tx.send_replace(CollectorStatus {
            route: self.route.clone(),
            state: CollectorLifecycleState::Ready,
            active_positions_or_orders: active,
            consecutive_failures: 0,
            last_success_at_utc_msc: Some((self.clock)()),
            error_code: None,
        });
    }

    fn publish_failure(&mut self, error_code: &str) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let last_success_at_utc_msc = self.status_tx.borrow().last_success_at_utc_msc;
        self.status_tx.send_replace(CollectorStatus {
            route: self.route.clone(),
            state: CollectorLifecycleState::Retrying,
            active_positions_or_orders: self.active_positions_or_orders,
            consecutive_failures: self.consecutive_failures,
            last_success_at_utc_msc,
            error_code: Some(error_code.to_owned()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::{AccountRef, DataDeltaMessage};
    use bridge_store::{
        PersistDeltaResult, PersistDeltaStatus, StoreError, StoredStreamProjection,
        StoredTerminalProjection,
    };
    use bridge_worker_host::SnapshotStreams;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    struct MemoryStore {
        state: Mutex<MemoryStoreState>,
    }

    struct MemoryStoreState {
        projection: StoredTerminalProjection,
        messages: Vec<DataDeltaMessage>,
    }

    impl MemoryStore {
        fn empty() -> Self {
            let empty = || StoredStreamProjection {
                revision: 0,
                items: Vec::new(),
            };
            Self {
                state: Mutex::new(MemoryStoreState {
                    projection: StoredTerminalProjection {
                        account: empty(),
                        positions: empty(),
                        orders: empty(),
                    },
                    messages: Vec::new(),
                }),
            }
        }

        fn messages(&self) -> Vec<DataDeltaMessage> {
            self.state.lock().expect("store lock").messages.clone()
        }
    }

    impl ProjectionStore for MemoryStore {
        fn load_terminal_projection(
            &self,
            _route: &WorkerRoute,
        ) -> Result<StoredTerminalProjection, StoreError> {
            Ok(self.state.lock().expect("store lock").projection.clone())
        }

        fn persist_data_delta(
            &self,
            message: &DataDeltaMessage,
        ) -> Result<PersistDeltaResult, StoreError> {
            let mut state = self.state.lock().expect("store lock");
            let projection = match message.stream.as_str() {
                "account" => &mut state.projection.account,
                "positions" => &mut state.projection.positions,
                "orders" => &mut state.projection.orders,
                _ => panic!("unexpected test stream"),
            };
            projection.revision = message.revision;
            if message.full_snapshot || message.stream == "account" {
                projection.items = message.upserts.clone();
            } else {
                for upsert in &message.upserts {
                    let ticket = upsert["ticket"].as_u64().expect("upsert ticket");
                    projection
                        .items
                        .retain(|item| item["ticket"].as_u64() != Some(ticket));
                    projection.items.push(upsert.clone());
                }
                for deleted in &message.deletes {
                    let ticket = deleted.as_str().expect("delete ticket");
                    projection.items.retain(|item| {
                        item["ticket"]
                            .as_u64()
                            .is_none_or(|value| value.to_string() != ticket)
                    });
                }
            }
            state.messages.push(message.clone());
            Ok(PersistDeltaResult {
                status: PersistDeltaStatus::Applied,
                current_revision: message.revision,
                next_revision: message.revision + 1,
            })
        }
    }

    struct FakeSource {
        responses: Mutex<VecDeque<Result<TerminalSnapshot, WorkerHostError>>>,
        fallback: TerminalSnapshot,
        calls: AtomicUsize,
        routes: Mutex<Vec<WorkerRoute>>,
    }

    impl FakeSource {
        fn new(
            responses: Vec<Result<TerminalSnapshot, WorkerHostError>>,
            fallback: TerminalSnapshot,
        ) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                fallback,
                calls: AtomicUsize::new(0),
                routes: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl SnapshotSource for FakeSource {
        fn collect_snapshot<'a>(
            &'a self,
            route: WorkerRoute,
            _request_id: String,
            _streams: Vec<SnapshotStream>,
        ) -> Pin<Box<dyn Future<Output = Result<TerminalSnapshot, WorkerHostError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.routes.lock().expect("routes lock").push(route);
                self.responses
                    .lock()
                    .expect("responses lock")
                    .pop_front()
                    .unwrap_or_else(|| Ok(self.fallback.clone()))
            })
        }
    }

    fn route() -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_collector_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 9,
        }
    }

    fn snapshot(active: bool) -> TerminalSnapshot {
        TerminalSnapshot {
            source_time_msc: 1_700_000_000_000,
            streams: SnapshotStreams {
                account: Some(serde_json::json!({
                    "login": 123456,
                    "server": "Broker-Demo",
                    "balance": 10_000.0
                })),
                positions: Some(if active {
                    vec![serde_json::json!({ "ticket": 101, "volume": 0.01 })]
                } else {
                    Vec::new()
                }),
                orders: Some(Vec::new()),
            },
        }
    }

    fn test_clock() -> Arc<dyn Fn() -> i64 + Send + Sync> {
        let clock = Arc::new(AtomicI64::new(1_700_000_000_100));
        Arc::new(move || clock.fetch_add(1, Ordering::SeqCst))
    }

    fn projector(store: Arc<MemoryStore>) -> SnapshotProjector<MemoryStore> {
        SnapshotProjector::restore(store, route()).expect("projector")
    }

    async fn wait_for_calls(source: &FakeSource, expected: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while source.calls() < expected {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("collector calls");
    }

    async fn wait_for_order_revision(store: &MemoryStore, expected: i64) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !store
                .messages()
                .iter()
                .any(|message| message.stream == "orders" && message.revision == expected)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("order revision persisted");
    }

    #[tokio::test]
    async fn collection_detects_activity_and_revalidates_the_account_route() {
        let store = Arc::new(MemoryStore::empty());
        let source = Arc::new(FakeSource::new(
            vec![Ok(snapshot(false)), Ok(snapshot(true))],
            snapshot(true),
        ));
        let (mut collector, _handle) = SnapshotCollector::new(
            source,
            projector(Arc::clone(&store)),
            test_clock(),
            CollectorPolicy::default(),
        )
        .expect("collector");
        assert!(!collector.collect_once().await.expect("idle snapshot"));
        assert!(collector.collect_once().await.expect("active snapshot"));

        let mut mismatched = snapshot(false);
        mismatched.streams.account.as_mut().expect("account")["login"] = serde_json::json!(999999);
        let source = Arc::new(FakeSource::new(vec![Ok(mismatched)], snapshot(false)));
        let store = Arc::new(MemoryStore::empty());
        let (mut collector, _handle) = SnapshotCollector::new(
            source,
            projector(store),
            test_clock(),
            CollectorPolicy::default(),
        )
        .expect("collector");
        assert_eq!(
            collector
                .collect_once()
                .await
                .expect_err("route mismatch")
                .code(),
            "worker_snapshot_account_route_mismatch"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_recovers_wakes_reconciles_and_stops_without_waiting_for_idle_polling() {
        let store = Arc::new(MemoryStore::empty());
        let source = Arc::new(FakeSource::new(
            vec![
                Err(WorkerHostError::new("worker_registry_not_ready")),
                Ok(snapshot(false)),
            ],
            snapshot(false),
        ));
        let policy = CollectorPolicy {
            active_interval: Duration::from_millis(10),
            idle_interval: Duration::from_secs(5),
            retry_initial: Duration::from_millis(10),
            retry_max: Duration::from_millis(20),
        };
        let (collector, handle) = SnapshotCollector::new(
            Arc::clone(&source),
            projector(Arc::clone(&store)),
            test_clock(),
            policy,
        )
        .expect("collector");
        let task = tokio::spawn(collector.run());
        wait_for_calls(&source, 2).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            let mut status = handle.subscribe_status();
            while status.borrow().state != CollectorLifecycleState::Ready {
                status.changed().await.expect("status sender");
            }
        })
        .await
        .expect("ready status");
        assert_eq!(handle.status().consecutive_failures, 0);

        handle.wake().expect("wake collector");
        wait_for_calls(&source, 3).await;
        handle
            .request_full_snapshot("orders")
            .expect("reconcile orders");
        wait_for_calls(&source, 4).await;
        wait_for_order_revision(&store, 2).await;
        assert_eq!(
            handle
                .request_full_snapshot("history")
                .expect_err("invalid stream")
                .code(),
            "terminal_projection_stream_invalid"
        );

        handle.stop();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("collector stop timeout")
            .expect("collector task");
        assert_eq!(handle.status().state, CollectorLifecycleState::Stopped);
    }

    #[test]
    fn policy_rejects_zero_or_inverted_intervals_and_caps_retry_backoff() {
        let policy = CollectorPolicy {
            active_interval: Duration::ZERO,
            ..CollectorPolicy::default()
        };
        assert_eq!(
            policy.validate().expect_err("zero interval").code(),
            "terminal_collector_policy_invalid"
        );
        let policy = CollectorPolicy {
            active_interval: Duration::from_millis(20),
            idle_interval: Duration::from_millis(10),
            retry_initial: Duration::from_millis(5),
            retry_max: Duration::from_millis(20),
        };
        assert_eq!(
            policy.validate().expect_err("inverted interval").code(),
            "terminal_collector_policy_invalid"
        );
        let policy = CollectorPolicy {
            active_interval: Duration::from_millis(10),
            idle_interval: Duration::from_millis(20),
            retry_initial: Duration::from_millis(5),
            retry_max: Duration::from_millis(20),
        };
        assert_eq!(policy.retry_delay(1), Duration::from_millis(5));
        assert_eq!(policy.retry_delay(4), Duration::from_millis(20));
        assert_eq!(policy.retry_delay(u32::MAX), Duration::from_millis(20));
    }
}
