mod collector;

pub use collector::{
    CollectorHandle, CollectorLifecycleState, CollectorPolicy, CollectorStatus, SnapshotCollector,
    SnapshotSource,
};

use bridge_contract::DataDeltaMessage;
use bridge_store::{
    OutboxStore, PersistDeltaResult, PersistDeltaStatus, StoreError, StoredStreamProjection,
    StoredTerminalProjection,
};
use bridge_worker_host::{SnapshotStreams, TerminalSnapshot, WorkerRoute};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter, Write};
use std::ptr::null_mut;
use std::sync::Arc;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};

pub trait ProjectionStore: Send + Sync {
    fn load_terminal_projection(
        &self,
        route: &WorkerRoute,
    ) -> Result<StoredTerminalProjection, StoreError>;

    fn persist_data_delta(
        &self,
        message: &DataDeltaMessage,
    ) -> Result<PersistDeltaResult, StoreError>;
}

impl ProjectionStore for OutboxStore {
    fn load_terminal_projection(
        &self,
        route: &WorkerRoute,
    ) -> Result<StoredTerminalProjection, StoreError> {
        self.load_terminal_projection(
            &route.terminal_instance_id,
            &route.account_ref,
            route.connection_epoch,
        )
    }

    fn persist_data_delta(
        &self,
        message: &DataDeltaMessage,
    ) -> Result<PersistDeltaResult, StoreError> {
        self.persist_data_delta(message)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionError {
    code: String,
}

impl ProjectionError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl Display for ProjectionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for ProjectionError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionIngestResult {
    pub persisted_streams: Vec<String>,
    pub observed_streams: Vec<String>,
}

struct StreamState {
    revision: i64,
    items: BTreeMap<String, serde_json::Value>,
    full_snapshot_required: bool,
}

pub struct SnapshotProjector<S> {
    store: Arc<S>,
    route: WorkerRoute,
    streams: BTreeMap<String, StreamState>,
    freshness: BTreeMap<String, i64>,
}

impl<S> SnapshotProjector<S>
where
    S: ProjectionStore,
{
    pub fn restore(store: Arc<S>, route: WorkerRoute) -> Result<Self, ProjectionError> {
        route.validate()?;
        let stored = store
            .load_terminal_projection(&route)
            .map_err(store_error)?;
        let streams = BTreeMap::from([
            (
                "account".to_owned(),
                stream_state("account", stored.account)?,
            ),
            (
                "positions".to_owned(),
                stream_state("positions", stored.positions)?,
            ),
            ("orders".to_owned(), stream_state("orders", stored.orders)?),
        ]);
        Ok(Self {
            store,
            route,
            streams,
            freshness: BTreeMap::new(),
        })
    }

    pub fn route(&self) -> &WorkerRoute {
        &self.route
    }

    pub fn revision(&self, stream: &str) -> Option<i64> {
        self.streams.get(stream).map(|state| state.revision)
    }

    pub fn freshness(&self) -> BTreeMap<String, i64> {
        self.freshness.clone()
    }

    pub fn request_full_snapshot(&mut self, stream: &str) -> Result<(), ProjectionError> {
        let state = self
            .streams
            .get_mut(stream)
            .ok_or_else(|| ProjectionError::new("terminal_projection_stream_invalid"))?;
        state.full_snapshot_required = true;
        Ok(())
    }

    pub fn request_all_full_snapshots(&mut self) {
        for state in self.streams.values_mut() {
            state.full_snapshot_required = true;
        }
    }

    pub fn ingest(
        &mut self,
        snapshot: TerminalSnapshot,
        observed_at_utc_msc: i64,
    ) -> Result<ProjectionIngestResult, ProjectionError> {
        if snapshot.source_time_msc <= 0 || observed_at_utc_msc <= 0 {
            return Err(ProjectionError::new("terminal_projection_time_invalid"));
        }
        let SnapshotStreams {
            account,
            positions,
            orders,
        } = snapshot.streams;
        let mut observed = Vec::new();
        let mut persisted = Vec::new();
        if let Some(account) = account {
            let current = BTreeMap::from([("account".to_owned(), account)]);
            let changed = self.project_stream(
                "account",
                current,
                snapshot.source_time_msc,
                observed_at_utc_msc,
            )?;
            observed.push("account".to_owned());
            if changed {
                persisted.push("account".to_owned());
            }
        }
        if let Some(positions) = positions {
            let current = collection_items(positions)?;
            let changed = self.project_stream(
                "positions",
                current,
                snapshot.source_time_msc,
                observed_at_utc_msc,
            )?;
            observed.push("positions".to_owned());
            if changed {
                persisted.push("positions".to_owned());
            }
        }
        if let Some(orders) = orders {
            let current = collection_items(orders)?;
            let changed = self.project_stream(
                "orders",
                current,
                snapshot.source_time_msc,
                observed_at_utc_msc,
            )?;
            observed.push("orders".to_owned());
            if changed {
                persisted.push("orders".to_owned());
            }
        }
        for stream in &observed {
            self.freshness.insert(stream.clone(), observed_at_utc_msc);
        }
        Ok(ProjectionIngestResult {
            persisted_streams: persisted,
            observed_streams: observed,
        })
    }

    fn project_stream(
        &mut self,
        stream: &str,
        current: BTreeMap<String, serde_json::Value>,
        source_time_msc: i64,
        observed_at_utc_msc: i64,
    ) -> Result<bool, ProjectionError> {
        let state = self
            .streams
            .get_mut(stream)
            .ok_or_else(|| ProjectionError::new("terminal_projection_stream_invalid"))?;
        let full_snapshot = state.full_snapshot_required;
        let upserts = if full_snapshot {
            current.values().cloned().collect::<Vec<_>>()
        } else {
            current
                .iter()
                .filter(|(key, value)| state.items.get(*key) != Some(*value))
                .map(|(_, value)| value.clone())
                .collect()
        };
        let deletes = if full_snapshot {
            Vec::new()
        } else {
            state
                .items
                .keys()
                .filter(|key| !current.contains_key(*key))
                .cloned()
                .map(serde_json::Value::String)
                .collect::<Vec<_>>()
        };
        if !full_snapshot && upserts.is_empty() && deletes.is_empty() {
            return Ok(false);
        }
        let revision = state
            .revision
            .checked_add(1)
            .ok_or_else(|| ProjectionError::new("terminal_projection_revision_exhausted"))?;
        let message = DataDeltaMessage {
            v: 3,
            message_type: "data_delta".to_owned(),
            message_id: new_message_id()?,
            sent_at_utc_msc: observed_at_utc_msc,
            terminal_instance_id: self.route.terminal_instance_id.clone(),
            account_ref: self.route.account_ref.clone(),
            connection_epoch: self.route.connection_epoch,
            stream: stream.to_owned(),
            revision,
            base_revision: if full_snapshot { 0 } else { state.revision },
            observed_at_utc_msc,
            source_time_msc: Some(source_time_msc),
            full_snapshot,
            upserts,
            deletes,
        };
        let result = self
            .store
            .persist_data_delta(&message)
            .map_err(store_error)?;
        match result.status {
            PersistDeltaStatus::Applied | PersistDeltaStatus::Duplicate => {
                if result.current_revision != revision || result.next_revision != revision + 1 {
                    return Err(ProjectionError::new(
                        "terminal_projection_store_result_invalid",
                    ));
                }
                state.revision = revision;
                state.items = current;
                state.full_snapshot_required = false;
                Ok(true)
            }
            PersistDeltaStatus::Gap => {
                if result.current_revision < 0
                    || result.next_revision != result.current_revision + 1
                {
                    return Err(ProjectionError::new(
                        "terminal_projection_store_result_invalid",
                    ));
                }
                state.revision = result.current_revision;
                state.full_snapshot_required = true;
                Err(ProjectionError::new("terminal_projection_revision_gap"))
            }
        }
    }
}

fn stream_state(
    stream: &str,
    stored: StoredStreamProjection,
) -> Result<StreamState, ProjectionError> {
    if stored.revision < 0 || stored.revision == i64::MAX {
        return Err(ProjectionError::new("terminal_projection_revision_invalid"));
    }
    if stored.revision == 0 && !stored.items.is_empty()
        || stream == "account" && stored.revision > 0 && stored.items.len() != 1
    {
        return Err(ProjectionError::new("terminal_projection_state_invalid"));
    }
    let items = if stream == "account" {
        stored
            .items
            .into_iter()
            .map(|value| ("account".to_owned(), value))
            .collect()
    } else {
        collection_items(stored.items)?
    };
    Ok(StreamState {
        revision: stored.revision,
        items,
        full_snapshot_required: stored.revision == 0,
    })
}

fn collection_items(
    values: Vec<serde_json::Value>,
) -> Result<BTreeMap<String, serde_json::Value>, ProjectionError> {
    let mut items = BTreeMap::new();
    for value in values {
        let ticket = value
            .as_object()
            .and_then(|object| object.get("ticket"))
            .and_then(|ticket| {
                ticket
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| ticket.as_u64().map(|value| value.to_string()))
            })
            .filter(|ticket| ticket.parse::<u64>().is_ok_and(|value| value > 0))
            .ok_or_else(|| ProjectionError::new("terminal_projection_ticket_invalid"))?;
        if items.insert(ticket, value).is_some() {
            return Err(ProjectionError::new("terminal_projection_ticket_duplicate"));
        }
    }
    Ok(items)
}

fn new_message_id() -> Result<String, ProjectionError> {
    new_random_id("delta_")
}

fn new_random_id(prefix: &str) -> Result<String, ProjectionError> {
    let mut bytes = [0_u8; 16];
    // SAFETY: BCryptGenRandom writes exactly the supplied mutable buffer length.
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(ProjectionError::new("terminal_projection_random_failed"));
    }
    let mut message_id = String::from(prefix);
    for byte in bytes {
        write!(&mut message_id, "{byte:02x}")
            .map_err(|_| ProjectionError::new("terminal_projection_random_failed"))?;
    }
    Ok(message_id)
}

fn store_error(error: StoreError) -> ProjectionError {
    ProjectionError::new(error.code())
}

impl From<bridge_worker_host::WorkerHostError> for ProjectionError {
    fn from(error: bridge_worker_host::WorkerHostError) -> Self {
        Self::new(error.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::AccountRef;
    use std::sync::Mutex;

    const DATA_STREAMS: [&str; 3] = ["account", "positions", "orders"];

    struct FakeState {
        projection: StoredTerminalProjection,
        messages: Vec<DataDeltaMessage>,
        force_gap: bool,
    }

    struct FakeStore {
        state: Mutex<FakeState>,
    }

    impl FakeStore {
        fn new(projection: StoredTerminalProjection) -> Self {
            Self {
                state: Mutex::new(FakeState {
                    projection,
                    messages: Vec::new(),
                    force_gap: false,
                }),
            }
        }

        fn messages(&self) -> Vec<DataDeltaMessage> {
            self.state.lock().expect("fake lock").messages.clone()
        }

        fn force_gap(&self, value: bool) {
            self.state.lock().expect("fake lock").force_gap = value;
        }
    }

    impl ProjectionStore for FakeStore {
        fn load_terminal_projection(
            &self,
            _route: &WorkerRoute,
        ) -> Result<StoredTerminalProjection, StoreError> {
            Ok(self.state.lock().expect("fake lock").projection.clone())
        }

        fn persist_data_delta(
            &self,
            message: &DataDeltaMessage,
        ) -> Result<PersistDeltaResult, StoreError> {
            let mut state = self.state.lock().expect("fake lock");
            if state.force_gap {
                return Ok(PersistDeltaResult {
                    status: PersistDeltaStatus::Gap,
                    current_revision: 5,
                    next_revision: 6,
                });
            }
            let projection = match message.stream.as_str() {
                "account" => &mut state.projection.account,
                "positions" => &mut state.projection.positions,
                "orders" => &mut state.projection.orders,
                _ => unreachable!(),
            };
            if message.full_snapshot || message.stream == "account" {
                projection.items = message.upserts.clone();
            } else {
                let mut items = collection_items(projection.items.clone()).expect("stored items");
                for item in &message.upserts {
                    let ticket = collection_items(vec![item.clone()])
                        .expect("upsert")
                        .into_keys()
                        .next()
                        .expect("ticket");
                    items.insert(ticket, item.clone());
                }
                for ticket in &message.deletes {
                    items.remove(ticket.as_str().expect("delete ticket"));
                }
                projection.items = items.into_values().collect();
            }
            projection.revision = message.revision;
            state.messages.push(message.clone());
            Ok(PersistDeltaResult {
                status: PersistDeltaStatus::Applied,
                current_revision: message.revision,
                next_revision: message.revision + 1,
            })
        }
    }

    fn route() -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_projection_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
        }
    }

    fn account(balance: f64) -> serde_json::Value {
        serde_json::json!({
            "login": 123456,
            "server": "Broker-Demo",
            "balance": balance
        })
    }

    fn projection() -> StoredTerminalProjection {
        StoredTerminalProjection {
            account: StoredStreamProjection {
                revision: 1,
                items: vec![account(10_000.0)],
            },
            positions: StoredStreamProjection {
                revision: 2,
                items: vec![
                    serde_json::json!({ "ticket": 101, "volume": 0.01 }),
                    serde_json::json!({ "ticket": 102, "volume": 0.02 }),
                ],
            },
            orders: StoredStreamProjection {
                revision: 1,
                items: Vec::new(),
            },
        }
    }

    fn snapshot(
        account_value: Option<serde_json::Value>,
        positions: Option<Vec<serde_json::Value>>,
        orders: Option<Vec<serde_json::Value>>,
    ) -> TerminalSnapshot {
        TerminalSnapshot {
            source_time_msc: 1_700_000_000_000,
            streams: SnapshotStreams {
                account: account_value,
                positions,
                orders,
            },
        }
    }

    #[test]
    fn restored_projection_emits_only_changes_and_can_force_a_full_stream() {
        let store = Arc::new(FakeStore::new(projection()));
        let mut projector =
            SnapshotProjector::restore(Arc::clone(&store), route()).expect("restored projector");
        let current_positions = vec![
            serde_json::json!({ "ticket": 101, "volume": 0.03 }),
            serde_json::json!({ "ticket": 103, "volume": 0.01 }),
        ];
        let first = projector
            .ingest(
                snapshot(
                    Some(account(10_000.0)),
                    Some(current_positions.clone()),
                    Some(Vec::new()),
                ),
                1_700_000_000_100,
            )
            .expect("first ingest");
        assert_eq!(first.persisted_streams, vec!["positions"]);
        assert_eq!(first.observed_streams, DATA_STREAMS.map(str::to_owned));
        let messages = store.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].revision, 3);
        assert_eq!(messages[0].base_revision, 2);
        assert!(!messages[0].full_snapshot);
        assert_eq!(messages[0].upserts.len(), 2);
        assert_eq!(messages[0].deletes, vec![serde_json::json!("102")]);

        let second = projector
            .ingest(
                snapshot(
                    Some(account(10_000.0)),
                    Some(current_positions),
                    Some(Vec::new()),
                ),
                1_700_000_000_200,
            )
            .expect("unchanged ingest");
        assert!(second.persisted_streams.is_empty());
        assert_eq!(store.messages().len(), 1);
        assert_eq!(projector.freshness()["positions"], 1_700_000_000_200);

        projector
            .request_full_snapshot("orders")
            .expect("full orders");
        let forced = projector
            .ingest(snapshot(None, None, Some(Vec::new())), 1_700_000_000_300)
            .expect("forced ingest");
        assert_eq!(forced.persisted_streams, vec!["orders"]);
        let messages = store.messages();
        assert_eq!(messages.len(), 2);
        assert!(messages[1].full_snapshot);
        assert_eq!(messages[1].revision, 2);
        assert_eq!(messages[1].base_revision, 0);
    }

    #[test]
    fn a_store_gap_forces_the_next_retry_to_be_a_full_snapshot() {
        let store = Arc::new(FakeStore::new(projection()));
        let mut projector =
            SnapshotProjector::restore(Arc::clone(&store), route()).expect("restored projector");
        store.force_gap(true);
        assert_eq!(
            projector
                .ingest(
                    snapshot(Some(account(10_001.0)), None, None),
                    1_700_000_000_100,
                )
                .expect_err("gap")
                .code(),
            "terminal_projection_revision_gap"
        );
        store.force_gap(false);
        projector
            .ingest(
                snapshot(Some(account(10_001.0)), None, None),
                1_700_000_000_200,
            )
            .expect("full retry");
        let messages = store.messages();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].full_snapshot);
        assert_eq!(messages[0].base_revision, 0);
        assert_eq!(messages[0].revision, 6);
    }

    #[test]
    fn a_fresh_route_starts_with_full_snapshots_for_every_observed_stream() {
        let empty = StoredTerminalProjection {
            account: StoredStreamProjection {
                revision: 0,
                items: Vec::new(),
            },
            positions: StoredStreamProjection {
                revision: 0,
                items: Vec::new(),
            },
            orders: StoredStreamProjection {
                revision: 0,
                items: Vec::new(),
            },
        };
        let store = Arc::new(FakeStore::new(empty));
        let mut projector =
            SnapshotProjector::restore(Arc::clone(&store), route()).expect("fresh projector");
        let result = projector
            .ingest(
                snapshot(Some(account(10_000.0)), Some(Vec::new()), Some(Vec::new())),
                1_700_000_000_100,
            )
            .expect("first snapshot");
        assert_eq!(result.persisted_streams, DATA_STREAMS.map(str::to_owned));
        assert!(store.messages().iter().all(|message| message.full_snapshot));
    }

    #[test]
    fn restore_fails_closed_for_an_invalid_store_projection() {
        let mut invalid = projection();
        invalid.account.revision = 0;
        let store = Arc::new(FakeStore::new(invalid));
        let error = match SnapshotProjector::restore(store, route()) {
            Ok(_) => panic!("invalid projection was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "terminal_projection_state_invalid");

        let mut exhausted = projection();
        exhausted.positions.revision = i64::MAX;
        let store = Arc::new(FakeStore::new(exhausted));
        let error = match SnapshotProjector::restore(store, route()) {
            Ok(_) => panic!("exhausted revision was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "terminal_projection_revision_invalid");
    }
}
