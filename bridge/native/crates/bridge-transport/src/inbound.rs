use crate::{DataAckDisposition, NativeCommandAdmission, OutboxPump, TransportError};
use bridge_contract::{BridgeEnvelope, CommandMessage, TerminalDescriptor};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseAvailableNotification {
    pub release_id: Option<String>,
    pub release_version: String,
    pub rollout_channel: String,
    pub reason: String,
}

pub trait InboundEventSink: Send + Sync {
    fn full_snapshot_required(
        &self,
        terminal_instance_id: &str,
        connection_epoch: i64,
        stream: &str,
        expected_revision: i64,
    ) -> Result<(), TransportError>;

    fn release_available(
        &self,
        notification: ReleaseAvailableNotification,
    ) -> Result<(), TransportError>;
}

#[derive(Default)]
pub struct NoopInboundEventSink;

impl InboundEventSink for NoopInboundEventSink {
    fn full_snapshot_required(
        &self,
        _terminal_instance_id: &str,
        _connection_epoch: i64,
        _stream: &str,
        _expected_revision: i64,
    ) -> Result<(), TransportError> {
        Ok(())
    }

    fn release_available(
        &self,
        _notification: ReleaseAvailableNotification,
    ) -> Result<(), TransportError> {
        Ok(())
    }
}

pub struct NativeInboundRouter {
    outbox: Arc<OutboxPump>,
    events: Arc<dyn InboundEventSink>,
    command_admission: Arc<NativeCommandAdmission>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl NativeInboundRouter {
    pub fn new(outbox: Arc<OutboxPump>, events: Arc<dyn InboundEventSink>) -> Self {
        Self {
            outbox,
            events,
            command_admission: Arc::new(NativeCommandAdmission::default()),
            clock: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0)
            }),
        }
    }

    pub fn with_command_admission(
        mut self,
        command_admission: Arc<NativeCommandAdmission>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        self.command_admission = command_admission;
        self.clock = clock;
        self
    }

    pub fn begin_session(
        &self,
        session_id: &str,
        terminals: &[TerminalDescriptor],
    ) -> Result<(), TransportError> {
        self.command_admission.begin_session(session_id, terminals)
    }

    pub fn end_session(&self, session_id: &str) -> Result<(), TransportError> {
        self.command_admission.end_session(session_id)
    }

    pub async fn route(&self, payload_json: &str) -> Result<(), TransportError> {
        let envelope: BridgeEnvelope = serde_json::from_str(payload_json)
            .map_err(|_| TransportError::new("bridge_inbound_message_invalid"))?;
        envelope.validate_header().map_err(TransportError::new)?;

        match envelope.message_type.as_str() {
            "data_ack" => {
                match self
                    .outbox
                    .handle_data_acknowledgement(payload_json)
                    .await?
                {
                    DataAckDisposition::Gap {
                        terminal_instance_id,
                        connection_epoch,
                        stream,
                        expected_revision,
                    } => self.events.full_snapshot_required(
                        &terminal_instance_id,
                        connection_epoch,
                        &stream,
                        expected_revision,
                    )?,
                    DataAckDisposition::AppliedSnapshot {
                        terminal_instance_id,
                        connection_epoch,
                        stream,
                    } => {
                        self.command_admission.acknowledge_initial_snapshot(
                            &terminal_instance_id,
                            connection_epoch,
                            &stream,
                        )?;
                    }
                    DataAckDisposition::Applied | DataAckDisposition::Unknown => {}
                }
                Ok(())
            }
            "heartbeat" => Ok(()),
            "release_available" => {
                let release: ReleaseAvailableWire = serde_json::from_str(payload_json)
                    .map_err(|_| TransportError::new("bridge_release_notification_invalid"))?;
                let notification = release.validate()?;
                self.events.release_available(notification)
            }
            "error" => {
                let error: ServerErrorWire = serde_json::from_str(payload_json)
                    .map_err(|_| TransportError::new("bridge_server_error_invalid"))?;
                error.validate()?;
                Err(TransportError::new(error.error_code))
            }
            "hello_ack" => Err(TransportError::new("bridge_hello_ack_unexpected")),
            "command_result_ack" => {
                self.outbox
                    .handle_command_result_acknowledgement(payload_json)
                    .await?;
                Ok(())
            }
            "command" => {
                let command: CommandMessage = serde_json::from_str(payload_json)
                    .map_err(|_| TransportError::new("bridge_command_invalid"))?;
                self.command_admission.validate(&command, (self.clock)())?;
                Err(TransportError::new("native_bridge_runtime_not_ready"))
            }
            "quote_request" | "data_request" => {
                Err(TransportError::new("native_bridge_runtime_not_ready"))
            }
            _ => Err(TransportError::new("bridge_message_type_unexpected")),
        }
    }
}

#[derive(Deserialize)]
struct ReleaseAvailableWire {
    release_id: Option<String>,
    release_version: String,
    rollout_channel: String,
    reason: String,
}

impl ReleaseAvailableWire {
    fn validate(self) -> Result<ReleaseAvailableNotification, TransportError> {
        if self.release_id.as_ref().is_some_and(|value| {
            value.trim().is_empty()
                || value.len() > 128
                || !value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                })
        }) || !is_version(&self.release_version)
            || !matches!(self.rollout_channel.as_str(), "internal" | "stable")
            || !matches!(self.reason.as_str(), "published" | "rollback")
        {
            return Err(TransportError::new("bridge_release_notification_invalid"));
        }
        Ok(ReleaseAvailableNotification {
            release_id: self.release_id,
            release_version: self.release_version,
            rollout_channel: self.rollout_channel,
            reason: self.reason,
        })
    }
}

fn is_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

#[derive(Deserialize)]
struct ServerErrorWire {
    error_code: String,
}

impl ServerErrorWire {
    fn validate(&self) -> Result<(), TransportError> {
        if self.error_code.is_empty()
            || self.error_code.len() > 128
            || !self
                .error_code
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(TransportError::new("bridge_server_error_invalid"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MessagePriority, OutboxPersistence, PriorityMessageQueue};
    use bridge_contract::{AccountRef, TerminalDescriptor};
    use bridge_store::{OutboxRecord, StoreError};
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeOutbox {
        records: Mutex<Vec<OutboxRecord>>,
    }

    impl OutboxPersistence for FakeOutbox {
        fn ready_for_terminals(
            &self,
            _now_utc_msc: i64,
            _terminal_instance_ids: Option<&[String]>,
            _limit: usize,
        ) -> Result<Vec<OutboxRecord>, StoreError> {
            Ok(Vec::new())
        }

        fn record_attempt(
            &self,
            _message_id: &str,
            _expected_attempt_count: i64,
            _next_attempt_at_utc_msc: i64,
        ) -> Result<bool, StoreError> {
            Ok(false)
        }

        fn pending(&self, message_id: &str) -> Result<Option<OutboxRecord>, StoreError> {
            Ok(self
                .records
                .lock()
                .expect("records")
                .iter()
                .find(|record| record.message_id == message_id)
                .cloned())
        }

        fn acknowledge(&self, _message_id: &str, _status: &str) -> Result<bool, StoreError> {
            Ok(true)
        }
    }

    #[derive(Default)]
    struct CapturingEvents {
        gaps: Mutex<Vec<(String, i64, String, i64)>>,
        releases: Mutex<Vec<ReleaseAvailableNotification>>,
    }

    impl InboundEventSink for CapturingEvents {
        fn full_snapshot_required(
            &self,
            terminal_instance_id: &str,
            connection_epoch: i64,
            stream: &str,
            expected_revision: i64,
        ) -> Result<(), TransportError> {
            self.gaps.lock().expect("gaps").push((
                terminal_instance_id.to_owned(),
                connection_epoch,
                stream.to_owned(),
                expected_revision,
            ));
            Ok(())
        }

        fn release_available(
            &self,
            notification: ReleaseAvailableNotification,
        ) -> Result<(), TransportError> {
            self.releases.lock().expect("releases").push(notification);
            Ok(())
        }
    }

    fn router(store: Arc<FakeOutbox>, events: Arc<CapturingEvents>) -> NativeInboundRouter {
        let queue = PriorityMessageQueue::new(1, 1).expect("queue");
        let pump = Arc::new(OutboxPump::new(store, queue, None));
        NativeInboundRouter::new(pump, events)
    }

    #[tokio::test]
    async fn gap_is_route_checked_before_requesting_a_full_snapshot() {
        let store = Arc::new(FakeOutbox::default());
        store.records.lock().expect("records").push(OutboxRecord {
            id: 1,
            message_id: "data_01JINBOUND01".to_owned(),
            message_type: "data_delta".to_owned(),
            terminal_instance_id: "mt4_terminal_01".to_owned(),
            connection_epoch: 3,
            priority: match MessagePriority::Data {
                MessagePriority::Trade => "trade",
                MessagePriority::Data => "data",
            }
            .to_owned(),
            payload_json: serde_json::json!({
                "v": 3,
                "type": "data_delta",
                "message_id": "data_01JINBOUND01",
                "sent_at_utc_msc": 1_700_000_000_000_i64,
                "terminal_instance_id": "mt4_terminal_01",
                "connection_epoch": 3,
                "stream": "deals",
                "revision": 8
            })
            .to_string(),
            attempt_count: 0,
            created_at_utc_msc: 1_700_000_000_000,
        });
        let events = Arc::new(CapturingEvents::default());
        let router = router(store, events.clone());
        router
            .route(
                &serde_json::json!({
                    "v": 3,
                    "type": "data_ack",
                    "message_id": "ack_01JINBOUND001",
                    "sent_at_utc_msc": 1_700_000_000_001_i64,
                    "acked_message_id": "data_01JINBOUND01",
                    "terminal_instance_id": "mt4_terminal_01",
                    "connection_epoch": 3,
                    "stream": "deals",
                    "revision": 8,
                    "status": "gap",
                    "expected_revision": 4
                })
                .to_string(),
            )
            .await
            .expect("gap");
        assert_eq!(
            events.gaps.lock().expect("gaps").as_slice(),
            &[("mt4_terminal_01".to_owned(), 3, "deals".to_owned(), 4)]
        );
    }

    #[tokio::test]
    async fn release_and_server_errors_are_validated_and_commands_fail_closed() {
        let events = Arc::new(CapturingEvents::default());
        let admission = Arc::new(NativeCommandAdmission::default());
        admission
            .begin_session(
                "session_01JINBOUND",
                &[TerminalDescriptor {
                    terminal_instance_id: "mt5_terminal_01".to_owned(),
                    platform: "mt5".to_owned(),
                    account_ref: AccountRef {
                        broker_server: "Broker-Demo".to_owned(),
                        login: "123456".to_owned(),
                    },
                    connection_epoch: 7,
                    worker_version: Some("4.0.0".to_owned()),
                }],
            )
            .expect("session");
        for stream in ["account", "positions", "orders"] {
            admission
                .acknowledge_initial_snapshot("mt5_terminal_01", 7, stream)
                .expect("snapshot");
        }
        let router = router(Arc::new(FakeOutbox::default()), events.clone())
            .with_command_admission(admission, Arc::new(|| 1_700_000_000_001));
        router
            .route(
                &serde_json::json!({
                    "v": 3,
                    "type": "release_available",
                    "message_id": "release_01JTEST01",
                    "sent_at_utc_msc": 1_700_000_000_000_i64,
                    "release_id": "stable_4.0.1",
                    "release_version": "4.0.1",
                    "rollout_channel": "stable",
                    "reason": "published"
                })
                .to_string(),
            )
            .await
            .expect("release");
        assert_eq!(events.releases.lock().expect("releases").len(), 1);

        for (payload, expected) in [
            (
                serde_json::json!({
                    "v": 3,
                    "type": "error",
                    "message_id": "error_01JTEST0001",
                    "sent_at_utc_msc": 1_700_000_000_001_i64,
                    "error_code": "bridge_message_route_mismatch"
                }),
                "bridge_message_route_mismatch",
            ),
            (
                serde_json::json!({
                    "v": 3,
                    "type": "command",
                    "message_id": "command_01JTEST01",
                    "sent_at_utc_msc": 1_700_000_000_002_i64,
                    "command_id": "command_01JTEST02",
                    "terminal_instance_id": "mt5_terminal_01",
                    "account_ref": { "broker_server": "Broker-Demo", "login": "123456" },
                    "connection_epoch": 7,
                    "issued_at_utc_msc": 1_700_000_000_000_i64,
                    "deadline_utc_msc": 1_700_000_010_000_i64,
                    "action": "place_order",
                    "params": {}
                }),
                "native_bridge_runtime_not_ready",
            ),
        ] {
            assert_eq!(
                router
                    .route(&payload.to_string())
                    .await
                    .expect_err("must fail closed")
                    .code(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn only_acknowledged_full_initial_snapshots_unlock_trade_admission() {
        let store = Arc::new(FakeOutbox::default());
        let admission = Arc::new(NativeCommandAdmission::default());
        admission
            .begin_session(
                "session_01JINBOUND",
                &[TerminalDescriptor {
                    terminal_instance_id: "mt5_terminal_01".to_owned(),
                    platform: "mt5".to_owned(),
                    account_ref: AccountRef {
                        broker_server: "Broker-Demo".to_owned(),
                        login: "123456".to_owned(),
                    },
                    connection_epoch: 7,
                    worker_version: Some("4.0.0".to_owned()),
                }],
            )
            .expect("session");
        let router = router(store.clone(), Arc::new(CapturingEvents::default()))
            .with_command_admission(admission, Arc::new(|| 1_700_000_000_001));
        let command = serde_json::json!({
            "v": 3,
            "type": "command",
            "message_id": "command_01JREADY001",
            "sent_at_utc_msc": 1_700_000_000_002_i64,
            "command_id": "command_01JREADY002",
            "terminal_instance_id": "mt5_terminal_01",
            "account_ref": { "broker_server": "Broker-Demo", "login": "123456" },
            "connection_epoch": 7,
            "issued_at_utc_msc": 1_700_000_000_000_i64,
            "deadline_utc_msc": 1_700_000_010_000_i64,
            "action": "place_order",
            "params": {}
        });
        assert_eq!(
            router
                .route(&command.to_string())
                .await
                .expect_err("initial sync")
                .code(),
            "terminal_initial_sync_pending"
        );

        for (index, stream) in ["account", "positions", "orders"].into_iter().enumerate() {
            let message_id = format!("data_01JREADY00{index}");
            store.records.lock().expect("records").push(OutboxRecord {
                id: index as i64 + 1,
                message_id: message_id.clone(),
                message_type: "data_delta".to_owned(),
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 7,
                priority: "data".to_owned(),
                payload_json: serde_json::json!({
                    "v": 3,
                    "type": "data_delta",
                    "message_id": message_id,
                    "sent_at_utc_msc": 1_700_000_000_000_i64,
                    "terminal_instance_id": "mt5_terminal_01",
                    "connection_epoch": 7,
                    "stream": stream,
                    "revision": 1,
                    "full_snapshot": true
                })
                .to_string(),
                attempt_count: 0,
                created_at_utc_msc: 1_700_000_000_000,
            });
            router
                .route(
                    &serde_json::json!({
                        "v": 3,
                        "type": "data_ack",
                        "message_id": format!("ack_01JREADY000{index}"),
                        "sent_at_utc_msc": 1_700_000_000_001_i64,
                        "acked_message_id": message_id,
                        "terminal_instance_id": "mt5_terminal_01",
                        "connection_epoch": 7,
                        "stream": stream,
                        "revision": 1,
                        "status": "applied"
                    })
                    .to_string(),
                )
                .await
                .expect("snapshot acknowledgement");
        }
        assert_eq!(
            router
                .route(&command.to_string())
                .await
                .expect_err("worker remains disabled")
                .code(),
            "native_bridge_runtime_not_ready"
        );
    }
}
