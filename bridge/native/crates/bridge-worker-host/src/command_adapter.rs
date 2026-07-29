use crate::{WorkerClient, WorkerRegistry, WorkerRequest, WorkerResponseBody, WorkerRoute};
use bridge_command::{CommandWorker, CommandWorkerError, ExecutionReconciliationWorker};
use bridge_contract::{CommandMessage, CommandResultMessage};
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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

pub struct RegistryReconciliationWorker<S> {
    command_worker: RegistryCommandWorker<S>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    request_timeout: Duration,
    settle_after: Duration,
    sequence: AtomicU64,
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

impl<S> RegistryReconciliationWorker<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub fn new(
        registry: Arc<WorkerRegistry<S>>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        request_timeout: Duration,
        settle_after: Duration,
    ) -> Result<Self, CommandWorkerError> {
        if request_timeout.is_zero()
            || settle_after < Duration::from_secs(1)
            || settle_after > Duration::from_secs(300)
        {
            return Err(CommandWorkerError::new(
                "worker_reconciliation_policy_invalid",
            ));
        }
        Ok(Self {
            command_worker: RegistryCommandWorker::new(
                registry,
                Arc::clone(&clock),
                request_timeout,
            )?,
            clock,
            request_timeout,
            settle_after,
            sequence: AtomicU64::new(0),
        })
    }

    fn query_command(
        &self,
        original: &CommandMessage,
        uncertain_receipt: Option<&CommandResultMessage>,
    ) -> Result<CommandMessage, CommandWorkerError> {
        let now = (self.clock)();
        if now <= 0 {
            return Err(CommandWorkerError::new("worker_clock_invalid"));
        }
        let timeout_msc = i64::try_from(self.request_timeout.as_millis())
            .map_err(|_| CommandWorkerError::new("worker_reconciliation_policy_invalid"))?;
        let deadline = now
            .checked_add(timeout_msc)
            .ok_or_else(|| CommandWorkerError::new("worker_clock_invalid"))?;
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        let query_id = format!("query_{now:x}_{sequence:x}");
        let params = reconciliation_query_params(original, uncertain_receipt, self.settle_after)?;
        let query = CommandMessage {
            v: original.v,
            message_type: "command".to_owned(),
            message_id: format!("message_{query_id}"),
            sent_at_utc_msc: now,
            command_id: query_id,
            terminal_instance_id: original.terminal_instance_id.clone(),
            account_ref: original.account_ref.clone(),
            connection_epoch: original.connection_epoch,
            issued_at_utc_msc: now,
            deadline_utc_msc: deadline,
            action: "query_execution".to_owned(),
            params: Value::Object(params),
        };
        query
            .validate(now.saturating_sub(1))
            .map_err(|_| CommandWorkerError::new("worker_reconciliation_query_invalid"))?;
        Ok(query)
    }
}

impl<S> ExecutionReconciliationWorker for RegistryReconciliationWorker<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn reconcile(
        &self,
        command: CommandMessage,
        uncertain_receipt: Option<CommandResultMessage>,
    ) -> BoxFuture<'_, Result<Option<CommandResultMessage>, CommandWorkerError>> {
        Box::pin(async move {
            let query = self.query_command(&command, uncertain_receipt.as_ref())?;
            let query_result = self.command_worker.execute(query).await?;
            map_reconciliation_result(&command, query_result, (self.clock)(), &self.sequence)
        })
    }
}

fn reconciliation_query_params(
    command: &CommandMessage,
    uncertain_receipt: Option<&CommandResultMessage>,
    settle_after: Duration,
) -> Result<Map<String, Value>, CommandWorkerError> {
    let original = command
        .params
        .as_object()
        .ok_or_else(|| CommandWorkerError::new("worker_reconciliation_query_invalid"))?;
    let mut params = Map::new();
    let expected_kind = match command.action.as_str() {
        "place_order" => {
            let kind = original
                .get("order_kind")
                .and_then(Value::as_str)
                .unwrap_or("market");
            params.insert(
                "symbol".to_owned(),
                original.get("symbol").cloned().ok_or_else(|| {
                    CommandWorkerError::new("worker_reconciliation_query_invalid")
                })?,
            );
            let reference = original
                .get("comment")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "AURUM:{}",
                        command
                            .command_id
                            .chars()
                            .rev()
                            .take(20)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect::<String>()
                    )
                });
            params.insert("bridge_command_ref".to_owned(), Value::String(reference));
            if let Some(ticket) = uncertain_receipt.and_then(reconciliation_ticket) {
                params.insert("ticket".to_owned(), Value::String(ticket));
            }
            params.insert(
                "magic".to_owned(),
                original
                    .get("magic")
                    .cloned()
                    .unwrap_or_else(|| json!(234000)),
            );
            if kind == "market" { "trade" } else { "pending" }
        }
        "cancel_order" | "modify_order" => {
            params.insert(
                "ticket".to_owned(),
                original.get("ticket").cloned().ok_or_else(|| {
                    CommandWorkerError::new("worker_reconciliation_query_invalid")
                })?,
            );
            "pending"
        }
        "modify_position" | "close_position" => {
            params.insert(
                "ticket".to_owned(),
                original.get("ticket").cloned().ok_or_else(|| {
                    CommandWorkerError::new("worker_reconciliation_query_invalid")
                })?,
            );
            if let Some(symbol) = original.get("symbol") {
                params.insert("symbol".to_owned(), symbol.clone());
            }
            "trade"
        }
        _ => {
            return Err(CommandWorkerError::new(
                "worker_reconciliation_action_unsupported",
            ));
        }
    };
    if let Some(expected) = original.get("expected_state").and_then(Value::as_object) {
        if !params.contains_key("symbol")
            && let Some(symbol) = expected.get("symbol")
        {
            params.insert("symbol".to_owned(), symbol.clone());
        }
        if let Some(magic) = expected.get("magic") {
            params.insert("magic".to_owned(), magic.clone());
        }
    }
    params.insert(
        "expected_kind".to_owned(),
        Value::String(expected_kind.to_owned()),
    );
    params.insert(
        "original_action".to_owned(),
        Value::String(command.action.clone()),
    );
    params.insert("original_params".to_owned(), command.params.clone());
    params.insert(
        "original_command_id".to_owned(),
        Value::String(command.command_id.clone()),
    );
    params.insert(
        "original_issued_at_utc_msc".to_owned(),
        json!(
            uncertain_receipt
                .map(|receipt| receipt.completed_at_utc_msc)
                .unwrap_or(command.issued_at_utc_msc)
        ),
    );
    params.insert(
        "settle_after_msc".to_owned(),
        json!(settle_after.as_millis()),
    );
    params.insert("lookback_seconds".to_owned(), json!(172_800));
    Ok(params)
}

fn reconciliation_ticket(receipt: &CommandResultMessage) -> Option<String> {
    receipt
        .evidence
        .order_tickets
        .first()
        .or_else(|| receipt.evidence.position_tickets.first())
        .or_else(|| receipt.evidence.deal_tickets.first())
        .cloned()
}

fn map_reconciliation_result(
    original: &CommandMessage,
    query_result: CommandResultMessage,
    now: i64,
    sequence: &AtomicU64,
) -> Result<Option<CommandResultMessage>, CommandWorkerError> {
    if now <= 0 || query_result.status != "succeeded" {
        return Err(CommandWorkerError::new(
            query_result
                .error_code
                .as_deref()
                .unwrap_or("worker_reconciliation_query_failed"),
        ));
    }
    let raw = query_result
        .raw_result
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| CommandWorkerError::new("worker_reconciliation_result_invalid"))?;
    let resolution = raw
        .get("resolution")
        .and_then(Value::as_object)
        .ok_or_else(|| CommandWorkerError::new("worker_reconciliation_result_invalid"))?;
    let status = resolution
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| CommandWorkerError::new("worker_reconciliation_result_invalid"))?;
    if status == "pending" {
        return Ok(None);
    }
    if !matches!(status, "succeeded" | "failed") {
        return Err(CommandWorkerError::new(
            "worker_reconciliation_result_invalid",
        ));
    }
    let error_code = resolution
        .get("error_code")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if status == "failed" && error_code.is_none() {
        return Err(CommandWorkerError::new(
            "worker_reconciliation_result_invalid",
        ));
    }
    let result = CommandResultMessage {
        v: original.v,
        message_type: "command_result".to_owned(),
        message_id: format!(
            "result_reconciled_{now:x}_{:x}",
            sequence.fetch_add(1, Ordering::Relaxed)
        ),
        sent_at_utc_msc: now,
        command_id: original.command_id.clone(),
        terminal_instance_id: original.terminal_instance_id.clone(),
        account_ref: original.account_ref.clone(),
        connection_epoch: original.connection_epoch,
        status: status.to_owned(),
        completed_at_utc_msc: now,
        error_code,
        error_message: None,
        raw_result: Some(json!({
            "reconciled": true,
            "query_result": raw,
        })),
        evidence: query_result.evidence,
    };
    result
        .validate()
        .map_err(|_| CommandWorkerError::new("worker_reconciliation_result_invalid"))?;
    Ok(Some(result))
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
        WorkerResponseBody::Snapshot { .. }
        | WorkerResponseBody::Quote { .. }
        | WorkerResponseBody::HistoryBatch { .. } => Err(CommandWorkerError::new(
            "worker_response_operation_mismatch",
        )),
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

    fn original_place_command() -> CommandMessage {
        let mut command = query_command();
        command.message_id = "message_01JORIGINAL1".to_owned();
        command.command_id = "command_01JORIGINAL1".to_owned();
        command.action = "place_order".to_owned();
        command.params = serde_json::json!({
            "symbol": "XAUUSD",
            "side": "buy",
            "order_kind": "market",
            "volume": 0.01,
            "magic": 777,
            "comment": "AI-RECONCILE"
        });
        command
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
            let result = query_result(request.operation.command().expect("command operation"));
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

    #[test]
    fn reconciliation_query_preserves_original_identity_but_uses_a_fresh_read_only_id() {
        let original = original_place_command();
        let params = reconciliation_query_params(&original, None, Duration::from_secs(15))
            .expect("query params");
        assert_eq!(params["expected_kind"], "trade");
        assert_eq!(params["bridge_command_ref"], "AI-RECONCILE");
        assert_eq!(params["magic"], 777);
        assert_eq!(params["original_action"], "place_order");
        assert_eq!(params["original_command_id"], original.command_id);
        assert_eq!(params["original_params"], original.params);
        assert_eq!(params["settle_after_msc"], 15_000);

        let mut uncertain = query_result(&query_command());
        uncertain.status = "uncertain".to_owned();
        uncertain.completed_at_utc_msc = NOW + 500;
        uncertain.evidence.order_tickets = vec!["9001".to_owned()];
        let receipt_params =
            reconciliation_query_params(&original, Some(&uncertain), Duration::from_secs(15))
                .expect("receipt query params");
        assert_eq!(receipt_params["ticket"], "9001");
        assert_eq!(receipt_params["original_issued_at_utc_msc"], NOW + 500);
    }

    #[test]
    fn reconciliation_result_only_finalizes_explicit_terminal_resolution() {
        let original = original_place_command();
        let sequence = AtomicU64::new(0);
        let mut pending = query_result(&query_command());
        pending.raw_result = Some(serde_json::json!({
            "found": false,
            "complete": true,
            "resolution": {
                "status": "pending",
                "error_code": "reconciliation_settlement_pending"
            }
        }));
        assert!(
            map_reconciliation_result(&original, pending, NOW + 2, &sequence)
                .expect("pending resolution")
                .is_none()
        );

        let mut succeeded = query_result(&query_command());
        succeeded.raw_result = Some(serde_json::json!({
            "found": true,
            "complete": true,
            "resolution": { "status": "succeeded" }
        }));
        let resolved = map_reconciliation_result(&original, succeeded, NOW + 3, &sequence)
            .expect("final resolution")
            .expect("terminal result");
        assert_eq!(resolved.command_id, original.command_id);
        assert_eq!(resolved.terminal_instance_id, original.terminal_instance_id);
        assert_eq!(resolved.status, "succeeded");
        assert_eq!(
            resolved
                .raw_result
                .as_ref()
                .and_then(|raw| raw["reconciled"].as_bool()),
            Some(true)
        );
    }
}
