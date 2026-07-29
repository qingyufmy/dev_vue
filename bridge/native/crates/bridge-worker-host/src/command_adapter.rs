use crate::{WorkerClient, WorkerRegistry, WorkerRequest, WorkerResponseBody, WorkerRoute};
use bridge_command::{CommandWorker, CommandWorkerError};
use bridge_contract::{CommandMessage, CommandResultMessage};
use futures_util::future::BoxFuture;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

pub struct IpcCommandWorker<S> {
    client: Arc<WorkerClient<S>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    request_timeout: Duration,
}

pub struct RegistryCommandWorker<S> {
    registry: Arc<WorkerRegistry<S>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    request_timeout: Duration,
}

impl<S> IpcCommandWorker<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub fn new(
        client: Arc<WorkerClient<S>>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        request_timeout: Duration,
    ) -> Result<Self, CommandWorkerError> {
        if request_timeout.is_zero() {
            return Err(CommandWorkerError::new("worker_request_timeout_invalid"));
        }
        Ok(Self {
            client,
            clock,
            request_timeout,
        })
    }
}

impl<S> CommandWorker for IpcCommandWorker<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn execute(
        &self,
        command: CommandMessage,
    ) -> BoxFuture<'_, Result<CommandResultMessage, CommandWorkerError>> {
        Box::pin(async move {
            let now_utc_msc = (self.clock)();
            if now_utc_msc <= 0 {
                return Err(CommandWorkerError::new("worker_clock_invalid"));
            }
            let request_timeout =
                effective_timeout(command.deadline_utc_msc, now_utc_msc, self.request_timeout)?;
            let route = WorkerRoute {
                terminal_instance_id: command.terminal_instance_id.clone(),
                platform: self.client.route().platform.clone(),
                account_ref: command.account_ref.clone(),
                connection_epoch: command.connection_epoch,
            };
            let request = WorkerRequest::from_command(route, command)
                .map_err(|error| CommandWorkerError::new(error.code()))?;
            let response = self
                .client
                .request(&request, now_utc_msc, request_timeout)
                .await
                .map_err(|error| CommandWorkerError::new(error.code()))?;
            map_response(response.body)
        })
    }
}

impl<S> RegistryCommandWorker<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub fn new(
        registry: Arc<WorkerRegistry<S>>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        request_timeout: Duration,
    ) -> Result<Self, CommandWorkerError> {
        if request_timeout.is_zero() {
            return Err(CommandWorkerError::new("worker_request_timeout_invalid"));
        }
        Ok(Self {
            registry,
            clock,
            request_timeout,
        })
    }
}

impl<S> CommandWorker for RegistryCommandWorker<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn execute(
        &self,
        command: CommandMessage,
    ) -> BoxFuture<'_, Result<CommandResultMessage, CommandWorkerError>> {
        Box::pin(async move {
            let now_utc_msc = (self.clock)();
            if now_utc_msc <= 0 {
                return Err(CommandWorkerError::new("worker_clock_invalid"));
            }
            let request_timeout =
                effective_timeout(command.deadline_utc_msc, now_utc_msc, self.request_timeout)?;
            let lease = self
                .registry
                .resolve_command(&command)
                .await
                .map_err(|error| CommandWorkerError::new(error.code()))?;
            let request = WorkerRequest::from_command(lease.route().clone(), command)
                .map_err(|error| CommandWorkerError::new(error.code()))?;
            let response = lease
                .request(&self.registry, &request, now_utc_msc, request_timeout)
                .await
                .map_err(|error| CommandWorkerError::new(error.code()))?;
            map_response(response.body)
        })
    }
}

fn effective_timeout(
    deadline_utc_msc: i64,
    now_utc_msc: i64,
    configured: Duration,
) -> Result<Duration, CommandWorkerError> {
    let remaining_msc = deadline_utc_msc
        .checked_sub(now_utc_msc)
        .and_then(|value| u64::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| CommandWorkerError::new("worker_command_expired"))?;
    Ok(configured.min(Duration::from_millis(remaining_msc)))
}

fn map_response(body: WorkerResponseBody) -> Result<CommandResultMessage, CommandWorkerError> {
    match body {
        WorkerResponseBody::CommandResult { result } => Ok(*result),
        WorkerResponseBody::Error { error_code, .. } => Err(CommandWorkerError::new(error_code)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ExpectedWorker, WORKER_IPC_VERSION, WorkerCapability, WorkerHello, WorkerOperation,
        WorkerResponse, read_frame, write_frame,
    };
    use bridge_contract::{AccountRef, ExecutionEvidence};
    use std::collections::BTreeSet;
    use tokio::io::duplex;

    const NOW: i64 = 1_700_000_000_001;
    const NONCE: &str = "0123456789abcdef0123456789abcdef";

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

    fn query_command() -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JQUERYIPC1".to_owned(),
            sent_at_utc_msc: NOW,
            command_id: "command_01JQUERYIPC1".to_owned(),
            terminal_instance_id: route().terminal_instance_id,
            account_ref: route().account_ref,
            connection_epoch: 7,
            issued_at_utc_msc: NOW,
            deadline_utc_msc: NOW + 10_000,
            action: "query_execution".to_owned(),
            params: serde_json::json!({
                "expected_kind": "trade",
                "bridge_command_ref": "AURUM-1",
                "lookback_seconds": 172800
            }),
        }
    }

    fn query_result(command: &CommandMessage) -> CommandResultMessage {
        CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: "result_01JQUERYIPC01".to_owned(),
            sent_at_utc_msc: NOW + 1,
            command_id: command.command_id.clone(),
            terminal_instance_id: command.terminal_instance_id.clone(),
            account_ref: command.account_ref.clone(),
            connection_epoch: command.connection_epoch,
            status: "succeeded".to_owned(),
            completed_at_utc_msc: NOW + 1,
            error_code: None,
            error_message: None,
            raw_result: Some(serde_json::json!({
                "found": false,
                "complete": true,
                "lookback_seconds": 172800
            })),
            evidence: ExecutionEvidence {
                observed_at_utc_msc: NOW + 1,
                order_tickets: Vec::new(),
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: None,
            },
        }
    }

    #[tokio::test]
    async fn query_execution_uses_the_read_only_worker_operation() {
        let (core, mut worker_stream) = duplex(64 * 1024);
        let worker_task = tokio::spawn(async move {
            write_frame(
                &mut worker_stream,
                &WorkerHello {
                    ipc_v: WORKER_IPC_VERSION,
                    message_type: "worker_hello".to_owned(),
                    session_nonce: NONCE.to_owned(),
                    worker_version: "3.0.0-alpha.1".to_owned(),
                    route: route(),
                    capabilities: vec![WorkerCapability::QueryExecution],
                },
            )
            .await
            .expect("worker hello");
            let request: WorkerRequest = read_frame(&mut worker_stream).await.expect("request");
            assert!(matches!(
                request.operation,
                WorkerOperation::QueryExecution { .. }
            ));
            let result = query_result(request.operation.command());
            write_frame(
                &mut worker_stream,
                &WorkerResponse::command_result(&request, result),
            )
            .await
            .expect("response");
        });
        let client = Arc::new(
            WorkerClient::handshake(
                core,
                ExpectedWorker {
                    session_nonce: NONCE.to_owned(),
                    route: route(),
                    required_capabilities: BTreeSet::from([WorkerCapability::QueryExecution]),
                },
                Duration::from_secs(1),
            )
            .await
            .expect("handshake"),
        );
        let worker = IpcCommandWorker::new(client, Arc::new(|| NOW), Duration::from_secs(1))
            .expect("command worker");
        let result = worker.execute(query_command()).await.expect("query result");
        assert_eq!(result.status, "succeeded");
        assert_eq!(
            result
                .raw_result
                .as_ref()
                .and_then(|raw| raw["found"].as_bool()),
            Some(false)
        );
        worker_task.await.expect("worker task");
    }

    #[tokio::test]
    async fn expired_command_is_rejected_before_registry_lookup_or_worker_io() {
        let registry = Arc::new(WorkerRegistry::<tokio::io::DuplexStream>::new());
        let worker =
            RegistryCommandWorker::new(registry, Arc::new(|| NOW), Duration::from_secs(30))
                .expect("registry worker");
        let mut command = query_command();
        command.deadline_utc_msc = NOW;
        assert_eq!(
            worker
                .execute(command)
                .await
                .expect_err("expired command")
                .code(),
            "worker_command_expired"
        );
    }
}
