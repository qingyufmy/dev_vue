use crate::{
    WorkerCapability, WorkerHello, WorkerHostError, WorkerRequest, WorkerResponse, WorkerRoute,
    read_frame, write_frame,
};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;
use tokio::time::timeout;

#[derive(Clone, Debug)]
pub struct ExpectedWorker {
    pub session_nonce: String,
    pub route: WorkerRoute,
    pub required_capabilities: BTreeSet<WorkerCapability>,
}

impl ExpectedWorker {
    fn validate(&self) -> Result<(), WorkerHostError> {
        self.route.validate()?;
        if self.session_nonce.len() < 32
            || self.session_nonce.len() > 128
            || !self
                .session_nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(WorkerHostError::new("worker_expected_nonce_invalid"));
        }
        if self.required_capabilities.is_empty() {
            return Err(WorkerHostError::new("worker_expected_capabilities_invalid"));
        }
        Ok(())
    }
}

pub struct WorkerClient<S> {
    stream: Mutex<S>,
    hello: WorkerHello,
    capabilities: BTreeSet<WorkerCapability>,
    healthy: AtomicBool,
}

impl<S> WorkerClient<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub async fn handshake(
        mut stream: S,
        expected: ExpectedWorker,
        handshake_timeout: Duration,
    ) -> Result<Self, WorkerHostError> {
        if handshake_timeout.is_zero() {
            return Err(WorkerHostError::new("worker_handshake_timeout_invalid"));
        }
        expected.validate()?;
        let hello: WorkerHello = timeout(handshake_timeout, read_frame(&mut stream))
            .await
            .map_err(|_| WorkerHostError::new("worker_handshake_timeout"))??;
        hello.validate()?;
        if hello.session_nonce != expected.session_nonce {
            return Err(WorkerHostError::new("worker_hello_nonce_mismatch"));
        }
        if !hello.route.matches(&expected.route) {
            return Err(WorkerHostError::new("worker_hello_route_mismatch"));
        }
        let capabilities = hello.capabilities.iter().copied().collect::<BTreeSet<_>>();
        if !expected.required_capabilities.is_subset(&capabilities) {
            return Err(WorkerHostError::new("worker_hello_capability_mismatch"));
        }
        Ok(Self {
            stream: Mutex::new(stream),
            hello,
            capabilities,
            healthy: AtomicBool::new(true),
        })
    }

    pub fn hello(&self) -> &WorkerHello {
        &self.hello
    }

    pub fn route(&self) -> &WorkerRoute {
        &self.hello.route
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    pub async fn request(
        &self,
        request: &WorkerRequest,
        now_utc_msc: i64,
        request_timeout: Duration,
    ) -> Result<WorkerResponse, WorkerHostError> {
        if request_timeout.is_zero() {
            return Err(WorkerHostError::new("worker_request_timeout_invalid"));
        }
        if !self.is_healthy() {
            return Err(WorkerHostError::new("worker_channel_unavailable"));
        }
        request.validate(now_utc_msc)?;
        if !request.route.matches(self.route()) {
            return Err(WorkerHostError::new("worker_request_route_mismatch"));
        }
        if !self
            .capabilities
            .contains(&request.operation.required_capability())
        {
            return Err(WorkerHostError::new("worker_capability_unavailable"));
        }
        let mut stream = timeout(request_timeout, self.stream.lock())
            .await
            .map_err(|_| WorkerHostError::new("worker_request_queue_timeout"))?;
        if !self.is_healthy() {
            return Err(WorkerHostError::new("worker_channel_unavailable"));
        }
        let exchange = async {
            write_frame(&mut *stream, request).await?;
            read_frame::<_, WorkerResponse>(&mut *stream).await
        };
        let response = match timeout(request_timeout, exchange).await {
            Err(_) => {
                self.fail();
                return Err(WorkerHostError::new("worker_request_timeout"));
            }
            Ok(Err(error)) => {
                self.fail();
                return Err(error);
            }
            Ok(Ok(response)) => response,
        };
        if let Err(error) = response.validate_for(request) {
            self.fail();
            return Err(error);
        }
        Ok(response)
    }

    fn fail(&self) {
        self.healthy.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::{AccountRef, CommandMessage, CommandResultMessage, ExecutionEvidence};
    use tokio::io::duplex;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const NOW: i64 = 1_700_000_000_001;

    fn route() -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
        }
    }

    fn hello(route: WorkerRoute) -> WorkerHello {
        WorkerHello {
            ipc_v: crate::WORKER_IPC_VERSION,
            message_type: "worker_hello".to_owned(),
            session_nonce: NONCE.to_owned(),
            worker_version: "3.0.0-alpha.1".to_owned(),
            route,
            capabilities: vec![
                WorkerCapability::ExecuteCommand,
                WorkerCapability::QueryExecution,
            ],
        }
    }

    fn expected() -> ExpectedWorker {
        ExpectedWorker {
            session_nonce: NONCE.to_owned(),
            route: route(),
            required_capabilities: [
                WorkerCapability::ExecuteCommand,
                WorkerCapability::QueryExecution,
            ]
            .into_iter()
            .collect(),
        }
    }

    fn command() -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JCLIENT001".to_owned(),
            sent_at_utc_msc: NOW,
            command_id: "command_01JCLIENT001".to_owned(),
            terminal_instance_id: route().terminal_instance_id,
            account_ref: route().account_ref,
            connection_epoch: 7,
            issued_at_utc_msc: NOW,
            deadline_utc_msc: NOW + 10_000,
            action: "place_order".to_owned(),
            params: serde_json::json!({ "symbol": "XAUUSD", "volume": 0.01 }),
        }
    }

    fn result(command: &CommandMessage) -> CommandResultMessage {
        CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: "result_01JCLIENT001".to_owned(),
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

    #[tokio::test]
    async fn handshake_rejects_a_route_mismatch() {
        let (core, mut worker) = duplex(16 * 1024);
        let mut wrong_route = route();
        wrong_route.connection_epoch += 1;
        let task = tokio::spawn(async move {
            write_frame(&mut worker, &hello(wrong_route))
                .await
                .expect("hello");
        });
        assert_eq!(
            WorkerClient::handshake(core, expected(), Duration::from_secs(1))
                .await
                .err()
                .expect("route mismatch")
                .code(),
            "worker_hello_route_mismatch"
        );
        task.await.expect("worker");
    }

    #[tokio::test]
    async fn response_mismatch_poisoning_requires_a_worker_restart() {
        let (core, mut worker) = duplex(64 * 1024);
        let task = tokio::spawn(async move {
            write_frame(&mut worker, &hello(route()))
                .await
                .expect("hello");
            let request: WorkerRequest = read_frame(&mut worker).await.expect("request");
            let mut response =
                WorkerResponse::command_result(&request, result(request.operation.command()));
            response.request_id = "command_01JWRONG001".to_owned();
            write_frame(&mut worker, &response).await.expect("response");
        });
        let client = WorkerClient::handshake(core, expected(), Duration::from_secs(1))
            .await
            .expect("handshake");
        let request = WorkerRequest::from_command(route(), command()).expect("request");
        assert_eq!(
            client
                .request(&request, NOW, Duration::from_secs(1))
                .await
                .expect_err("response mismatch")
                .code(),
            "worker_response_route_mismatch"
        );
        assert!(!client.is_healthy());
        assert_eq!(
            client
                .request(&request, NOW, Duration::from_secs(1))
                .await
                .expect_err("poisoned channel")
                .code(),
            "worker_channel_unavailable"
        );
        task.await.expect("worker");
    }

    #[tokio::test]
    async fn unavailable_query_capability_is_rejected_without_writing_or_poisoning() {
        let (core, mut worker) = duplex(64 * 1024);
        let task = tokio::spawn(async move {
            let mut worker_hello = hello(route());
            worker_hello.capabilities = vec![WorkerCapability::ExecuteCommand];
            write_frame(&mut worker, &worker_hello)
                .await
                .expect("hello");
            assert!(
                timeout(
                    Duration::from_millis(50),
                    read_frame::<_, WorkerRequest>(&mut worker)
                )
                .await
                .is_err(),
                "unsupported query must not be written to the worker"
            );
        });
        let client = WorkerClient::handshake(
            core,
            ExpectedWorker {
                session_nonce: NONCE.to_owned(),
                route: route(),
                required_capabilities: BTreeSet::from([WorkerCapability::ExecuteCommand]),
            },
            Duration::from_secs(1),
        )
        .await
        .expect("handshake");
        let mut query = command();
        query.action = "query_execution".to_owned();
        query.params = serde_json::json!({
            "expected_kind": "trade",
            "bridge_command_ref": "AURUM-1"
        });
        let request = WorkerRequest::from_command(route(), query).expect("query request");
        assert_eq!(
            client
                .request(&request, NOW, Duration::from_secs(1))
                .await
                .expect_err("missing query capability")
                .code(),
            "worker_capability_unavailable"
        );
        assert!(client.is_healthy());
        task.await.expect("worker");
    }
}
