use crate::admission::REQUIRED_INITIAL_STREAMS;
use crate::{DataAckDisposition, NativeCommandAdmission, OutboxPump, TransportError};
use bridge_command::CommandDispatcher;
use bridge_contract::{
    BridgeEnvelope, CommandMessage, DataRequestMessage, DataResponseMessage, TerminalDescriptor,
};
use serde::Deserialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::{MessagePriority, OutboundMessage};

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

pub trait InboundDataHandler: Send + Sync {
    fn handle<'a>(
        &'a self,
        request: &'a DataRequestMessage,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, TransportError>> + Send + 'a>>;
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
    command_dispatcher: Option<Arc<CommandDispatcher>>,
    data_handler: Option<Arc<dyn InboundDataHandler>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    response_sequence: AtomicU64,
}

impl NativeInboundRouter {
    pub fn new(outbox: Arc<OutboxPump>, events: Arc<dyn InboundEventSink>) -> Self {
        Self {
            outbox,
            events,
            command_admission: Arc::new(NativeCommandAdmission::default()),
            command_dispatcher: None,
            data_handler: None,
            clock: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0)
            }),
            response_sequence: AtomicU64::new(0),
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

    pub fn with_command_dispatcher(mut self, command_dispatcher: Arc<CommandDispatcher>) -> Self {
        self.command_dispatcher = Some(command_dispatcher);
        self
    }

    pub fn with_data_handler(mut self, data_handler: Arc<dyn InboundDataHandler>) -> Self {
        self.data_handler = Some(data_handler);
        self
    }

    pub fn begin_session(
        &self,
        session_id: &str,
        terminals: &[TerminalDescriptor],
    ) -> Result<(), TransportError> {
        self.command_admission
            .begin_session(session_id, terminals)?;
        for terminal in terminals {
            for stream in REQUIRED_INITIAL_STREAMS {
                if let Err(error) = self.events.full_snapshot_required(
                    &terminal.terminal_instance_id,
                    terminal.connection_epoch,
                    stream,
                    1,
                ) {
                    let _ = self.command_admission.end_session(session_id);
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub fn end_session(&self, session_id: &str) -> Result<(), TransportError> {
        self.command_admission.end_session(session_id)
    }

    pub async fn route(
        &self,
        payload_json: &str,
    ) -> Result<Option<OutboundMessage>, TransportError> {
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
                Ok(None)
            }
            "heartbeat" => Ok(None),
            "release_available" => {
                let release: ReleaseAvailableWire = serde_json::from_str(payload_json)
                    .map_err(|_| TransportError::new("bridge_release_notification_invalid"))?;
                let notification = release.validate()?;
                self.events.release_available(notification)?;
                Ok(None)
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
                Ok(None)
            }
            "command" => {
                let command: CommandMessage = serde_json::from_str(payload_json)
                    .map_err(|_| TransportError::new("bridge_command_invalid"))?;
                let Some(dispatcher) = &self.command_dispatcher else {
                    self.command_admission.validate(&command, (self.clock)())?;
                    return Err(TransportError::new("native_bridge_runtime_not_ready"));
                };
                dispatcher
                    .dispatch(command)
                    .await
                    .map_err(|error| TransportError::new(error.code()))?;
                Ok(None)
            }
            "data_request" => {
                let request: DataRequestMessage = serde_json::from_str(payload_json)
                    .map_err(|_| TransportError::new("bridge_data_request_invalid"))?;
                request.validate().map_err(TransportError::new)?;
                let Some(handler) = &self.data_handler else {
                    return Err(TransportError::new("native_bridge_runtime_not_ready"));
                };
                let observed_at = (self.clock)();
                if observed_at <= 0 {
                    return Err(TransportError::new("bridge_message_timestamp_invalid"));
                }
                let result = handler.handle(&request).await;
                let sequence = self.response_sequence.fetch_add(1, Ordering::Relaxed);
                let response = match result {
                    Ok(payload) => DataResponseMessage {
                        v: 3,
                        message_type: "data_response".to_owned(),
                        message_id: format!("data_{observed_at:x}_{sequence:x}"),
                        sent_at_utc_msc: observed_at,
                        request_id: request.request_id.clone(),
                        terminal_instance_id: request.terminal_instance_id.clone(),
                        account_ref: request.account_ref.clone(),
                        connection_epoch: request.connection_epoch,
                        action: request.action.clone(),
                        params: request.params.clone(),
                        observed_at_utc_msc: observed_at,
                        status: "succeeded".to_owned(),
                        payload: Some(payload),
                        error_code: None,
                    },
                    Err(error) => DataResponseMessage {
                        v: 3,
                        message_type: "data_response".to_owned(),
                        message_id: format!("data_{observed_at:x}_{sequence:x}"),
                        sent_at_utc_msc: observed_at,
                        request_id: request.request_id.clone(),
                        terminal_instance_id: request.terminal_instance_id.clone(),
                        account_ref: request.account_ref.clone(),
                        connection_epoch: request.connection_epoch,
                        action: request.action.clone(),
                        params: request.params.clone(),
                        observed_at_utc_msc: observed_at,
                        status: "rejected".to_owned(),
                        payload: None,
                        error_code: Some(error.code().to_owned()),
                    },
                };
                response
                    .validate_for(&request)
                    .map_err(TransportError::new)?;
                Ok(Some(OutboundMessage {
                    message_id: response.message_id.clone(),
                    payload_json: serde_json::to_string(&response)
                        .map_err(|_| TransportError::new("bridge_data_response_invalid"))?,
                    priority: MessagePriority::Data,
                }))
            }
            "quote_request" => Err(TransportError::new("native_bridge_runtime_not_ready")),
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
    use bridge_command::{CommandDispatcher, CommandWorker, CommandWorkerError};
    use bridge_contract::{
        AccountRef, CommandResultMessage, ExecutionEvidence, TerminalDescriptor,
    };
    use bridge_store::{
        BRIDGE_DATABASE_FILE_NAME, OutboxRecord, OutboxStore, REQUIRED_SCHEMA, StoreError,
    };
    use futures_util::future::BoxFuture;
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

    struct SuccessfulWorker {
        calls: AtomicUsize,
    }

    struct HistoryDataHandler;

    impl InboundDataHandler for HistoryDataHandler {
        fn handle<'a>(
            &'a self,
            request: &'a DataRequestMessage,
        ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, TransportError>> + Send + 'a>>
        {
            Box::pin(async move {
                if request.action != "history" {
                    return Err(TransportError::new("terminal_data_action_unavailable"));
                }
                Ok(serde_json::json!({
                    "orders": [],
                    "pagination": { "current_page": request.params["page"] }
                }))
            })
        }
    }

    #[tokio::test]
    async fn data_request_returns_a_direct_correlated_response_without_using_outbox() {
        let store = Arc::new(FakeOutbox::default());
        let router = router(store.clone(), Arc::new(CapturingEvents::default()))
            .with_command_admission(
                Arc::new(NativeCommandAdmission::default()),
                Arc::new(|| 1_700_000_000_100),
            )
            .with_data_handler(Arc::new(HistoryDataHandler));
        let request = serde_json::json!({
            "v": 3,
            "type": "data_request",
            "message_id": "message_01JDATAREQ01",
            "sent_at_utc_msc": 1_700_000_000_000_i64,
            "request_id": "data_01JDATAREQ001",
            "terminal_instance_id": "mt5_terminal_01",
            "account_ref": { "broker_server": "Broker-Demo", "login": "123456" },
            "connection_epoch": 7,
            "action": "history",
            "params": { "page": 2, "page_size": 20 }
        });
        let outbound = router
            .route(&request.to_string())
            .await
            .expect("data route")
            .expect("direct response");
        assert_eq!(outbound.priority, MessagePriority::Data);
        let response: DataResponseMessage =
            serde_json::from_str(&outbound.payload_json).expect("data response");
        response
            .validate_for(&serde_json::from_value(request).expect("request"))
            .expect("correlated response");
        assert_eq!(response.status, "succeeded");
        assert_eq!(
            response.payload.expect("payload")["pagination"]["current_page"],
            2
        );
        assert!(store.records.lock().expect("records").is_empty());
    }

    impl CommandWorker for SuccessfulWorker {
        fn execute(
            &self,
            command: CommandMessage,
        ) -> BoxFuture<'_, Result<CommandResultMessage, CommandWorkerError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(CommandResultMessage {
                    v: 3,
                    message_type: "command_result".to_owned(),
                    message_id: format!("result_{}", command.command_id),
                    sent_at_utc_msc: 1_700_000_000_003,
                    command_id: command.command_id,
                    terminal_instance_id: command.terminal_instance_id,
                    account_ref: command.account_ref,
                    connection_epoch: command.connection_epoch,
                    status: "succeeded".to_owned(),
                    completed_at_utc_msc: 1_700_000_000_003,
                    error_code: None,
                    error_message: None,
                    raw_result: Some(serde_json::json!({ "retcode": 10009 })),
                    evidence: ExecutionEvidence {
                        observed_at_utc_msc: 1_700_000_000_003,
                        order_tickets: vec!["1001".to_owned()],
                        position_tickets: Vec::new(),
                        deal_tickets: Vec::new(),
                        broker_retcode: Some(10009),
                    },
                })
            })
        }
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
                    worker_version: Some("3.0.0".to_owned()),
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
                    worker_version: Some("3.0.0".to_owned()),
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

    #[tokio::test]
    async fn configured_dispatcher_persists_and_deduplicates_a_routed_command() {
        let root = unique_test_directory("inbound-command");
        fs::create_dir_all(&root).expect("fixture directory");
        let path = root.join(BRIDGE_DATABASE_FILE_NAME);
        create_schema_fixture(&path);
        let store = Arc::new(OutboxStore::open_existing(&path).expect("store"));
        let admission = Arc::new(NativeCommandAdmission::default());
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
        admission
            .begin_session("session_01JROUTEDCMD", std::slice::from_ref(&terminal))
            .expect("session");
        for stream in ["account", "positions", "orders"] {
            admission
                .acknowledge_initial_snapshot(&terminal.terminal_instance_id, 7, stream)
                .expect("snapshot");
        }
        let worker = Arc::new(SuccessfulWorker {
            calls: AtomicUsize::new(0),
        });
        let dispatcher = Arc::new(
            CommandDispatcher::new(
                store.clone(),
                admission.clone(),
                worker.clone(),
                Arc::new(|| 1_700_000_000_002),
                Duration::from_secs(1),
            )
            .expect("dispatcher"),
        );
        let pump = Arc::new(OutboxPump::new(
            store.clone(),
            PriorityMessageQueue::new(2, 2).expect("queue"),
            None,
        ));
        let router = NativeInboundRouter::new(pump.clone(), Arc::new(CapturingEvents::default()))
            .with_command_admission(admission, Arc::new(|| 1_700_000_000_002))
            .with_command_dispatcher(dispatcher.clone());
        let command = serde_json::json!({
            "v": 3,
            "type": "command",
            "message_id": "message_01JROUTEDCMD1",
            "sent_at_utc_msc": 1_700_000_000_001_i64,
            "command_id": "command_01JROUTEDCMD",
            "terminal_instance_id": terminal.terminal_instance_id,
            "account_ref": terminal.account_ref,
            "connection_epoch": 7,
            "issued_at_utc_msc": 1_700_000_000_000_i64,
            "deadline_utc_msc": 1_700_000_010_000_i64,
            "action": "place_order",
            "params": { "symbol": "XAUUSD", "volume": 0.01 }
        })
        .to_string();
        router.route(&command).await.expect("first command");
        router.route(&command).await.expect("duplicate command");
        assert_eq!(worker.calls.load(Ordering::SeqCst), 1);
        let receipt = store
            .execution_receipt("command_01JROUTEDCMD")
            .expect("receipt")
            .expect("persisted receipt");
        assert_eq!(receipt.status, "succeeded");
        assert!(
            store
                .pending(&receipt.message_id)
                .expect("outbox")
                .is_some()
        );

        drop(router);
        drop(dispatcher);
        drop(pump);
        drop(store);
        fs::remove_dir_all(root).expect("remove fixture");
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
            "liangjian-bridge-inbound-{}-{}-{suffix}",
            std::process::id(),
            stamp
        ))
    }
}
