use crate::{
    BridgeWebSocketSession, MessagePriority, NativeInboundRouter, OutboundMessage, OutboxPump,
    PriorityMessageQueue, TransportError,
};
use bridge_contract::{HeartbeatMessage, TerminalDescriptor, TerminalStreamFreshness};
use futures_util::future::BoxFuture;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::{MissedTickBehavior, interval, timeout};

pub trait SessionChannel: Send + 'static {
    fn session_id(&self) -> &str;
    fn terminals(&self) -> Vec<TerminalDescriptor>;
    fn send_json(&mut self, payload_json: String) -> BoxFuture<'_, Result<(), TransportError>>;
    fn receive_json(&mut self) -> BoxFuture<'_, Result<String, TransportError>>;
    fn close(&mut self) -> BoxFuture<'_, Result<(), TransportError>>;
}

impl SessionChannel for BridgeWebSocketSession {
    fn session_id(&self) -> &str {
        &self.hello().session_id
    }

    fn terminals(&self) -> Vec<TerminalDescriptor> {
        self.hello().terminals.clone()
    }

    fn send_json(&mut self, payload_json: String) -> BoxFuture<'_, Result<(), TransportError>> {
        Box::pin(BridgeWebSocketSession::send_json(self, payload_json))
    }

    fn receive_json(&mut self) -> BoxFuture<'_, Result<String, TransportError>> {
        Box::pin(BridgeWebSocketSession::receive_json(self))
    }

    fn close(&mut self) -> BoxFuture<'_, Result<(), TransportError>> {
        Box::pin(BridgeWebSocketSession::close(self))
    }
}

impl<T> SessionChannel for Box<T>
where
    T: SessionChannel + ?Sized,
{
    fn session_id(&self) -> &str {
        (**self).session_id()
    }

    fn terminals(&self) -> Vec<TerminalDescriptor> {
        (**self).terminals()
    }

    fn send_json(&mut self, payload_json: String) -> BoxFuture<'_, Result<(), TransportError>> {
        (**self).send_json(payload_json)
    }

    fn receive_json(&mut self) -> BoxFuture<'_, Result<String, TransportError>> {
        (**self).receive_json()
    }

    fn close(&mut self) -> BoxFuture<'_, Result<(), TransportError>> {
        (**self).close()
    }
}

pub trait TerminalFreshnessProvider: Send + Sync {
    fn snapshot(&self) -> Result<Vec<TerminalStreamFreshness>, TransportError>;
}

impl<F> TerminalFreshnessProvider for F
where
    F: Fn() -> Result<Vec<TerminalStreamFreshness>, TransportError> + Send + Sync,
{
    fn snapshot(&self) -> Result<Vec<TerminalStreamFreshness>, TransportError> {
        self()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionIntervals {
    pub heartbeat: Duration,
    pub outbox_poll: Duration,
}

impl Default for SessionIntervals {
    fn default() -> Self {
        Self {
            heartbeat: crate::HEARTBEAT_INTERVAL,
            outbox_poll: crate::OUTBOX_POLL_INTERVAL,
        }
    }
}

impl SessionIntervals {
    fn validate(self) -> Result<Self, TransportError> {
        if self.heartbeat.is_zero() || self.outbox_poll.is_zero() {
            return Err(TransportError::new("bridge_session_interval_invalid"));
        }
        Ok(self)
    }
}

#[derive(Clone)]
pub struct SessionCancellation {
    sender: watch::Sender<bool>,
}

impl Default for SessionCancellation {
    fn default() -> Self {
        let (sender, _) = watch::channel(false);
        Self { sender }
    }
}

impl SessionCancellation {
    pub fn cancel(&self) {
        self.sender.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.sender.borrow()
    }

    pub(crate) async fn cancelled(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}

pub struct SessionRuntime {
    queue: PriorityMessageQueue,
    outbox: Arc<OutboxPump>,
    inbound: Arc<NativeInboundRouter>,
    freshness: Arc<dyn TerminalFreshnessProvider>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    intervals: SessionIntervals,
    heartbeat_sequence: Arc<AtomicU64>,
}

struct SessionAdmissionGuard {
    inbound: Arc<NativeInboundRouter>,
    session_id: String,
}

impl Drop for SessionAdmissionGuard {
    fn drop(&mut self) {
        let _ = self.inbound.end_session(&self.session_id);
    }
}

impl SessionRuntime {
    pub fn new(
        queue: PriorityMessageQueue,
        outbox: Arc<OutboxPump>,
        inbound: Arc<NativeInboundRouter>,
        freshness: Arc<dyn TerminalFreshnessProvider>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        intervals: SessionIntervals,
    ) -> Result<Self, TransportError> {
        Ok(Self {
            queue,
            outbox,
            inbound,
            freshness,
            clock,
            intervals: intervals.validate()?,
            heartbeat_sequence: Arc::new(AtomicU64::new(0)),
        })
    }

    pub async fn run<C: SessionChannel>(
        &self,
        channel: C,
        stop: SessionCancellation,
    ) -> Result<(), TransportError> {
        let session_id = channel.session_id().to_owned();
        if session_id.trim().is_empty() {
            return Err(TransportError::new("bridge_session_id_invalid"));
        }
        self.inbound
            .begin_session(&session_id, &channel.terminals())?;
        let _admission = SessionAdmissionGuard {
            inbound: Arc::clone(&self.inbound),
            session_id: session_id.clone(),
        };

        let cancellation = SessionCancellation::default();
        let mut tasks = JoinSet::new();
        tasks.spawn(io_loop(
            channel,
            self.queue.clone(),
            Arc::clone(&self.outbox),
            Arc::clone(&self.inbound),
            Arc::clone(&self.clock),
            cancellation.clone(),
        ));
        tasks.spawn(outbox_loop(
            Arc::clone(&self.outbox),
            Arc::clone(&self.clock),
            self.intervals.outbox_poll,
            cancellation.clone(),
        ));
        tasks.spawn(heartbeat_loop(
            session_id,
            self.queue.clone(),
            Arc::clone(&self.freshness),
            Arc::clone(&self.clock),
            Arc::clone(&self.heartbeat_sequence),
            self.intervals.heartbeat,
            cancellation.clone(),
        ));

        let (first, externally_cancelled) = tokio::select! {
            result = tasks.join_next() => (result, false),
            _ = stop.cancelled() => {
                cancellation.cancel();
                (tasks.join_next().await, true)
            }
        };
        let first = match first {
            Some(Ok(outcome)) => outcome,
            Some(Err(_)) => {
                cancellation.cancel();
                while tasks.join_next().await.is_some() {}
                return Err(TransportError::new("bridge_session_worker_failed"));
            }
            None => return Err(TransportError::new("bridge_session_loop_stopped")),
        };
        cancellation.cancel();
        while let Some(result) = tasks.join_next().await {
            if result.is_err() && first.is_ok() && !externally_cancelled {
                return Err(TransportError::new("bridge_session_worker_failed"));
            }
        }
        match first {
            Err(error) => Err(error),
            Ok(()) if externally_cancelled => Ok(()),
            Ok(()) => Err(TransportError::new("bridge_session_loop_stopped")),
        }
    }
}

async fn io_loop<C: SessionChannel>(
    mut channel: C,
    queue: PriorityMessageQueue,
    outbox: Arc<OutboxPump>,
    inbound: Arc<NativeInboundRouter>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    cancellation: SessionCancellation,
) -> Result<(), TransportError> {
    let outcome = loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => break Ok(()),
            message = queue.dequeue() => {
                if let Err(error) = channel.send_json(message.payload_json).await {
                    let _ = outbox.release_claim(&message.message_id);
                    break Err(error);
                }
                if let Err(error) = outbox.record_successful_send(&message.message_id, clock()).await {
                    let _ = outbox.release_claim(&message.message_id);
                    break Err(error);
                }
            }
            received = channel.receive_json() => {
                let payload = match received {
                    Ok(payload) => payload,
                    Err(error) => break Err(error),
                };
                if let Err(error) = inbound.route(&payload).await {
                    break Err(error);
                }
            }
        }
    };
    let _ = timeout(Duration::from_secs(2), channel.close()).await;
    outcome
}

async fn outbox_loop(
    outbox: Arc<OutboxPump>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    poll_interval: Duration,
    cancellation: SessionCancellation,
) -> Result<(), TransportError> {
    let mut timer = interval(poll_interval);
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            _ = timer.tick() => {
                outbox.pump_once(clock()).await?;
            }
        }
    }
}

async fn heartbeat_loop(
    session_id: String,
    queue: PriorityMessageQueue,
    freshness: Arc<dyn TerminalFreshnessProvider>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    sequence: Arc<AtomicU64>,
    heartbeat_interval: Duration,
    cancellation: SessionCancellation,
) -> Result<(), TransportError> {
    let mut timer = interval(heartbeat_interval);
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Ok(()),
            _ = timer.tick() => {
                let now = clock();
                if now <= 0 {
                    return Err(TransportError::new("bridge_message_timestamp_invalid"));
                }
                let next = sequence.fetch_add(1, Ordering::Relaxed);
                let heartbeat = HeartbeatMessage {
                    v: 3,
                    message_type: "heartbeat".to_owned(),
                    message_id: format!("heartbeat_{now:x}_{next:x}"),
                    sent_at_utc_msc: now,
                    session_id: session_id.clone(),
                    terminals: freshness.snapshot()?,
                };
                heartbeat.validate().map_err(TransportError::new)?;
                queue.enqueue(OutboundMessage {
                    message_id: heartbeat.message_id.clone(),
                    payload_json: serde_json::to_string(&heartbeat)
                        .map_err(|_| TransportError::new("bridge_heartbeat_invalid"))?,
                    priority: MessagePriority::Trade,
                }).await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{InboundEventSink, OutboxPersistence};
    use bridge_store::{OutboxRecord, StoreError};
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use tokio::sync::mpsc;
    use tokio::time::{sleep, timeout};

    #[derive(Default)]
    struct EmptyOutbox;

    impl OutboxPersistence for EmptyOutbox {
        fn ready_for_terminals(
            &self,
            _now_utc_msc: i64,
            _terminal_instance_ids: Option<&[String]>,
            _limit: usize,
        ) -> Result<Vec<OutboxRecord>, StoreError> {
            Ok(Vec::new())
        }
        fn record_attempt(&self, _: &str, _: i64, _: i64) -> Result<bool, StoreError> {
            Ok(false)
        }
        fn pending(&self, _: &str) -> Result<Option<OutboxRecord>, StoreError> {
            Ok(None)
        }
        fn acknowledge(&self, _: &str, _: &str) -> Result<bool, StoreError> {
            Ok(false)
        }
    }

    struct OneRecordOutbox(OutboxRecord);

    impl OutboxPersistence for OneRecordOutbox {
        fn ready_for_terminals(
            &self,
            _: i64,
            _: Option<&[String]>,
            _: usize,
        ) -> Result<Vec<OutboxRecord>, StoreError> {
            Ok(vec![self.0.clone()])
        }
        fn record_attempt(&self, _: &str, _: i64, _: i64) -> Result<bool, StoreError> {
            Ok(true)
        }
        fn pending(&self, _: &str) -> Result<Option<OutboxRecord>, StoreError> {
            Ok(Some(self.0.clone()))
        }
        fn acknowledge(&self, _: &str, _: &str) -> Result<bool, StoreError> {
            Ok(true)
        }
    }

    struct EmptyEvents;
    impl InboundEventSink for EmptyEvents {
        fn full_snapshot_required(
            &self,
            _: &str,
            _: i64,
            _: &str,
            _: i64,
        ) -> Result<(), TransportError> {
            Ok(())
        }
        fn release_available(
            &self,
            _: crate::ReleaseAvailableNotification,
        ) -> Result<(), TransportError> {
            Ok(())
        }
    }

    struct FakeChannel {
        session_id: String,
        inbound: mpsc::Receiver<Result<String, TransportError>>,
        sent: Arc<Mutex<Vec<String>>>,
        closed: Arc<Mutex<bool>>,
        send_error: Option<&'static str>,
    }

    impl SessionChannel for FakeChannel {
        fn session_id(&self) -> &str {
            &self.session_id
        }
        fn terminals(&self) -> Vec<TerminalDescriptor> {
            vec![TerminalDescriptor {
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                platform: "mt5".to_owned(),
                account_ref: bridge_contract::AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "123456".to_owned(),
                },
                connection_epoch: 1,
                worker_version: Some("3.0.0".to_owned()),
            }]
        }
        fn send_json(&mut self, payload_json: String) -> BoxFuture<'_, Result<(), TransportError>> {
            let send_error = self.send_error;
            let sent = Arc::clone(&self.sent);
            Box::pin(async move {
                if let Some(code) = send_error {
                    return Err(TransportError::new(code));
                }
                sent.lock().expect("sent").push(payload_json);
                Ok(())
            })
        }
        fn receive_json(&mut self) -> BoxFuture<'_, Result<String, TransportError>> {
            Box::pin(async move {
                self.inbound
                    .recv()
                    .await
                    .unwrap_or_else(|| Err(TransportError::new("bridge_websocket_disconnected")))
            })
        }
        fn close(&mut self) -> BoxFuture<'_, Result<(), TransportError>> {
            let closed = Arc::clone(&self.closed);
            Box::pin(async move {
                *closed.lock().expect("closed") = true;
                Ok(())
            })
        }
    }

    fn runtime() -> SessionRuntime {
        let queue = PriorityMessageQueue::new(8, 8).expect("queue");
        let outbox = Arc::new(OutboxPump::new(Arc::new(EmptyOutbox), queue.clone(), None));
        let inbound = Arc::new(NativeInboundRouter::new(
            Arc::clone(&outbox),
            Arc::new(EmptyEvents),
        ));
        let freshness = Arc::new(|| {
            let mut streams = BTreeMap::new();
            streams.insert("account".to_owned(), 1_700_000_000_000);
            Ok(vec![TerminalStreamFreshness {
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 1,
                streams,
            }])
        });
        SessionRuntime::new(
            queue,
            outbox,
            inbound,
            freshness,
            Arc::new(|| 1_700_000_000_001),
            SessionIntervals {
                heartbeat: Duration::from_millis(5),
                outbox_poll: Duration::from_millis(5),
            },
        )
        .expect("runtime")
    }

    #[tokio::test]
    async fn heartbeat_is_trade_priority_and_external_cancellation_closes_the_session() {
        let (_sender, receiver) = mpsc::channel(1);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(Mutex::new(false));
        let channel = FakeChannel {
            session_id: "session_01JRUNTIME".to_owned(),
            inbound: receiver,
            sent: Arc::clone(&sent),
            closed: Arc::clone(&closed),
            send_error: None,
        };
        let cancellation = SessionCancellation::default();
        let run_cancellation = cancellation.clone();
        let runtime = runtime();
        let run = tokio::spawn(async move { runtime.run(channel, run_cancellation).await });
        timeout(Duration::from_secs(1), async {
            while sent.lock().expect("sent").is_empty() {
                sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("heartbeat");
        cancellation.cancel();
        run.await.expect("join").expect("clean cancellation");
        let heartbeat: HeartbeatMessage =
            serde_json::from_str(sent.lock().expect("sent").first().expect("sent heartbeat"))
                .expect("heartbeat json");
        heartbeat.validate().expect("heartbeat contract");
        assert!(*closed.lock().expect("closed"));
    }

    #[tokio::test]
    async fn receive_failure_cancels_the_other_loops_and_preserves_the_error() {
        let (sender, receiver) = mpsc::channel(1);
        sender
            .send(Err(TransportError::new("bridge_websocket_disconnected")))
            .await
            .expect("failure");
        let closed = Arc::new(Mutex::new(false));
        let channel = FakeChannel {
            session_id: "session_01JRUNTIME".to_owned(),
            inbound: receiver,
            sent: Arc::new(Mutex::new(Vec::new())),
            closed: Arc::clone(&closed),
            send_error: None,
        };
        let error = runtime()
            .run(channel, SessionCancellation::default())
            .await
            .expect_err("disconnect");
        assert_eq!(error.code(), "bridge_websocket_disconnected");
        assert!(*closed.lock().expect("closed"));
    }

    #[tokio::test]
    async fn send_failure_cancels_receive_and_preserves_the_error() {
        let (_sender, receiver) = mpsc::channel(1);
        let closed = Arc::new(Mutex::new(false));
        let channel = FakeChannel {
            session_id: "session_01JRUNTIME".to_owned(),
            inbound: receiver,
            sent: Arc::new(Mutex::new(Vec::new())),
            closed: Arc::clone(&closed),
            send_error: Some("bridge_websocket_send_failed"),
        };
        let error = timeout(
            Duration::from_secs(1),
            runtime().run(channel, SessionCancellation::default()),
        )
        .await
        .expect("runtime timeout")
        .expect_err("send failure");
        assert_eq!(error.code(), "bridge_websocket_send_failed");
        assert!(*closed.lock().expect("closed"));
    }

    #[tokio::test]
    async fn send_failure_releases_the_outbox_claim_for_the_next_session() {
        let queue = PriorityMessageQueue::new(4, 4).expect("queue");
        let outbox = Arc::new(OutboxPump::new(
            Arc::new(OneRecordOutbox(OutboxRecord {
                id: 1,
                message_id: "trade_01JRUNTIME01".to_owned(),
                message_type: "command_result".to_owned(),
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 1,
                priority: "trade".to_owned(),
                payload_json: serde_json::json!({
                    "v": 3,
                    "type": "command_result",
                    "message_id": "trade_01JRUNTIME01",
                    "sent_at_utc_msc": 1_700_000_000_000_i64
                })
                .to_string(),
                attempt_count: 0,
                created_at_utc_msc: 1_700_000_000_000,
            })),
            queue.clone(),
            None,
        ));
        assert_eq!(outbox.pump_once(1_700_000_000_000).await.expect("prime"), 1);
        let inbound = Arc::new(NativeInboundRouter::new(
            Arc::clone(&outbox),
            Arc::new(EmptyEvents),
        ));
        let runtime = SessionRuntime::new(
            queue,
            Arc::clone(&outbox),
            inbound,
            Arc::new(|| Ok(Vec::new())),
            Arc::new(|| 1_700_000_000_001),
            SessionIntervals {
                heartbeat: Duration::from_secs(60),
                outbox_poll: Duration::from_secs(60),
            },
        )
        .expect("runtime");
        let (_sender, receiver) = mpsc::channel(1);
        let channel = FakeChannel {
            session_id: "session_01JRUNTIME".to_owned(),
            inbound: receiver,
            sent: Arc::new(Mutex::new(Vec::new())),
            closed: Arc::new(Mutex::new(false)),
            send_error: Some("bridge_websocket_send_failed"),
        };
        assert_eq!(
            runtime
                .run(channel, SessionCancellation::default())
                .await
                .expect_err("send failure")
                .code(),
            "bridge_websocket_send_failed"
        );
        assert_eq!(
            outbox
                .pump_once(1_700_000_000_010)
                .await
                .expect("next session retry"),
            1
        );
    }
}
