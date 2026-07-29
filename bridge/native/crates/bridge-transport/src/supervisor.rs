use crate::{
    BridgeAuthClient, BridgeWebSocketSession, ConnectionState, ServerEndpoints,
    SessionCancellation, SessionChannel, SessionRuntime, SessionStateMachine, SessionTransition,
    TransportError,
};
use bridge_contract::HelloMessage;
use futures_util::future::BoxFuture;
use std::sync::Arc;
use tokio::time::sleep;

pub trait CredentialSource: Send + Sync {
    fn current(&self) -> Result<Option<String>, TransportError>;
    fn changed(&self) -> BoxFuture<'_, Result<(), TransportError>>;
}

pub trait SessionConnector: Send + Sync {
    fn connect(
        &self,
        refresh_token: &str,
    ) -> BoxFuture<'_, Result<Box<dyn SessionChannel>, TransportError>>;
}

pub trait HelloProvider: Send + Sync {
    fn hello(&self) -> Result<HelloMessage, TransportError>;
}

impl<F> HelloProvider for F
where
    F: Fn() -> Result<HelloMessage, TransportError> + Send + Sync,
{
    fn hello(&self) -> Result<HelloMessage, TransportError> {
        self()
    }
}

pub struct V3SessionConnector {
    auth: BridgeAuthClient,
    endpoints: ServerEndpoints,
    hello: Arc<dyn HelloProvider>,
}

impl V3SessionConnector {
    pub fn new(
        endpoints: ServerEndpoints,
        user_agent: &str,
        hello: Arc<dyn HelloProvider>,
    ) -> Result<Self, TransportError> {
        Ok(Self {
            auth: BridgeAuthClient::new(endpoints.clone(), user_agent)?,
            endpoints,
            hello,
        })
    }
}

impl SessionConnector for V3SessionConnector {
    fn connect(
        &self,
        refresh_token: &str,
    ) -> BoxFuture<'_, Result<Box<dyn SessionChannel>, TransportError>> {
        let refresh_token = refresh_token.to_owned();
        Box::pin(async move {
            let bootstrap = self.auth.acquire(&refresh_token).await?;
            let hello = self.hello.hello()?;
            let session =
                BridgeWebSocketSession::connect(&self.endpoints, &bootstrap.ticket, hello).await?;
            Ok(Box::new(session) as Box<dyn SessionChannel>)
        })
    }
}

pub trait SupervisorStateSink: Send + Sync {
    fn transition(&self, transition: SessionTransition);
}

#[derive(Default)]
pub struct NoopSupervisorStateSink;

impl SupervisorStateSink for NoopSupervisorStateSink {
    fn transition(&self, _transition: SessionTransition) {}
}

pub struct SessionSupervisor {
    credentials: Arc<dyn CredentialSource>,
    connector: Arc<dyn SessionConnector>,
    runtime: Arc<SessionRuntime>,
    states: Arc<dyn SupervisorStateSink>,
}

impl SessionSupervisor {
    pub fn new(
        credentials: Arc<dyn CredentialSource>,
        connector: Arc<dyn SessionConnector>,
        runtime: Arc<SessionRuntime>,
        states: Arc<dyn SupervisorStateSink>,
    ) -> Self {
        Self {
            credentials,
            connector,
            runtime,
            states,
        }
    }

    pub async fn run(&self, stop: SessionCancellation) -> Result<(), TransportError> {
        let mut machine = SessionStateMachine::default();
        let mut credential = self.read_credential()?;
        self.publish(machine.start(credential.is_some()));

        loop {
            if stop.is_cancelled() {
                self.publish(machine.stop());
                return Ok(());
            }

            let Some(refresh_token) = credential.as_deref() else {
                tokio::select! {
                    _ = stop.cancelled() => {
                        self.publish(machine.stop());
                        return Ok(());
                    }
                    changed = self.credentials.changed() => changed?,
                }
                credential = self.read_credential()?;
                if credential.is_some() {
                    self.publish(machine.start(true));
                }
                continue;
            };

            let session = self.connector.connect(refresh_token).await;
            if stop.is_cancelled() {
                self.publish(machine.stop());
                return Ok(());
            }
            let session = match session {
                Ok(session) => session,
                Err(error) => {
                    credential = self
                        .handle_failure(&mut machine, error.code(), &stop)
                        .await?;
                    continue;
                }
            };

            self.publish(machine.connected());
            machine.stable();
            let outcome = self.runtime.run(session, stop.clone()).await;
            if stop.is_cancelled() {
                self.publish(machine.stop());
                return Ok(());
            }
            let error = outcome
                .err()
                .unwrap_or_else(|| TransportError::new("bridge_session_loop_stopped"));
            credential = self
                .handle_failure(&mut machine, error.code(), &stop)
                .await?;
        }
    }

    async fn handle_failure(
        &self,
        machine: &mut SessionStateMachine,
        error_code: &str,
        stop: &SessionCancellation,
    ) -> Result<Option<String>, TransportError> {
        let transition = machine.failed(error_code);
        self.publish(transition);
        if transition.state == ConnectionState::PairingRequired {
            tokio::select! {
                _ = stop.cancelled() => return Ok(None),
                changed = self.credentials.changed() => changed?,
            }
            let credential = self.read_credential()?;
            if credential.is_some() {
                self.publish(machine.start(true));
            }
            return Ok(credential);
        }

        let retry_after = transition
            .retry_after
            .ok_or_else(|| TransportError::new("bridge_reconnect_delay_missing"))?;
        tokio::select! {
            _ = stop.cancelled() => return self.read_credential(),
            _ = sleep(retry_after) => {}
            changed = self.credentials.changed() => changed?,
        }
        let credential = self.read_credential()?;
        if credential.is_some() {
            self.publish(machine.retry());
        } else {
            self.publish(machine.failed("bridge_not_paired"));
        }
        Ok(credential)
    }

    fn read_credential(&self) -> Result<Option<String>, TransportError> {
        self.credentials.current().and_then(|value| match value {
            Some(value) if value.trim().is_empty() => Ok(None),
            Some(value) if value.len() > 16_384 => {
                Err(TransportError::new("bridge_credential_invalid"))
            }
            other => Ok(other),
        })
    }

    fn publish(&self, transition: SessionTransition) {
        self.states.transition(transition);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        InboundEventSink, NativeInboundRouter, OutboxPersistence, OutboxPump, PriorityMessageQueue,
        ReleaseAvailableNotification, SessionIntervals,
    };
    use bridge_store::{OutboxRecord, StoreError};
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::watch;

    struct CredentialSlot {
        value: Mutex<Option<String>>,
        revision: watch::Sender<u64>,
    }

    impl CredentialSlot {
        fn new(value: Option<String>) -> Self {
            let (revision, _) = watch::channel(0);
            Self {
                value: Mutex::new(value),
                revision,
            }
        }

        fn set(&self, value: Option<String>) {
            *self.value.lock().expect("credential") = value;
            self.revision.send_modify(|revision| *revision += 1);
        }
    }

    impl CredentialSource for CredentialSlot {
        fn current(&self) -> Result<Option<String>, TransportError> {
            Ok(self.value.lock().expect("credential").clone())
        }

        fn changed(&self) -> BoxFuture<'_, Result<(), TransportError>> {
            let mut receiver = self.revision.subscribe();
            Box::pin(async move {
                receiver
                    .changed()
                    .await
                    .map_err(|_| TransportError::new("bridge_credential_watch_closed"))
            })
        }
    }

    struct CancellingConnector {
        stop: SessionCancellation,
        calls: Mutex<Vec<String>>,
    }

    impl SessionConnector for CancellingConnector {
        fn connect(
            &self,
            refresh_token: &str,
        ) -> BoxFuture<'_, Result<Box<dyn SessionChannel>, TransportError>> {
            self.calls
                .lock()
                .expect("calls")
                .push(refresh_token.to_owned());
            self.stop.cancel();
            Box::pin(async { Err(TransportError::new("bridge_server_unavailable")) })
        }
    }

    #[derive(Default)]
    struct CapturingStates(Mutex<Vec<ConnectionState>>);

    impl SupervisorStateSink for CapturingStates {
        fn transition(&self, transition: SessionTransition) {
            self.0.lock().expect("states").push(transition.state);
        }
    }

    #[derive(Default)]
    struct EmptyOutbox;
    impl OutboxPersistence for EmptyOutbox {
        fn ready_for_terminals(
            &self,
            _: i64,
            _: Option<&[String]>,
            _: usize,
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
        fn release_available(&self, _: ReleaseAvailableNotification) -> Result<(), TransportError> {
            Ok(())
        }
    }

    fn unused_runtime() -> Arc<SessionRuntime> {
        let queue = PriorityMessageQueue::new(1, 1).expect("queue");
        let outbox = Arc::new(OutboxPump::new(Arc::new(EmptyOutbox), queue.clone(), None));
        let inbound = Arc::new(NativeInboundRouter::new(
            Arc::clone(&outbox),
            Arc::new(EmptyEvents),
        ));
        Arc::new(
            SessionRuntime::new(
                queue,
                outbox,
                inbound,
                Arc::new(|| Ok(Vec::new())),
                Arc::new(|| 1_700_000_000_000),
                SessionIntervals {
                    heartbeat: Duration::from_secs(1),
                    outbox_poll: Duration::from_secs(1),
                },
            )
            .expect("runtime"),
        )
    }

    #[tokio::test]
    async fn pairing_waits_for_an_explicit_credential_change_without_opening_any_browser() {
        let stop = SessionCancellation::default();
        let credentials = Arc::new(CredentialSlot::new(None));
        let connector = Arc::new(CancellingConnector {
            stop: stop.clone(),
            calls: Mutex::new(Vec::new()),
        });
        let states = Arc::new(CapturingStates::default());
        let supervisor = SessionSupervisor::new(
            credentials.clone(),
            connector.clone(),
            unused_runtime(),
            states.clone(),
        );
        let task = tokio::spawn(async move { supervisor.run(stop).await });
        tokio::task::yield_now().await;
        assert_eq!(
            states.0.lock().expect("states").as_slice(),
            &[ConnectionState::PairingRequired]
        );
        credentials.set(Some("refresh_fixture".to_owned()));
        task.await.expect("join").expect("stop");
        assert_eq!(
            connector.calls.lock().expect("calls").as_slice(),
            &["refresh_fixture"]
        );
        assert_eq!(
            states.0.lock().expect("states").as_slice(),
            &[
                ConnectionState::PairingRequired,
                ConnectionState::Connecting,
                ConnectionState::Stopped
            ]
        );
    }

    #[test]
    fn v3_backoff_resets_only_after_a_ready_session() {
        let mut machine = SessionStateMachine::default();
        machine.start(true);
        assert_eq!(
            machine.failed("bridge_server_unavailable").retry_after,
            Some(Duration::from_secs(1))
        );
        machine.retry();
        assert_eq!(
            machine.failed("bridge_server_unavailable").retry_after,
            Some(Duration::from_secs(2))
        );
        machine.retry();
        machine.connected();
        machine.stable();
        assert_eq!(
            machine.failed("bridge_websocket_disconnected").retry_after,
            Some(Duration::from_secs(1))
        );
    }
}
