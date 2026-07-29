use crate::WorkerHostError;
use bridge_contract::{
    AccountRef, CommandMessage, CommandResultMessage, TerminalDescriptor, same_terminal_route,
    validate_id,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const WORKER_IPC_VERSION: u16 = 1;
const MAX_CAPABILITIES: usize = 16;
const MAX_SNAPSHOT_ITEMS: usize = 10_000;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerCapability {
    ExecuteCommand,
    QueryExecution,
    Quote,
    Data,
    Snapshot,
    HistorySync,
    Shutdown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRoute {
    pub terminal_instance_id: String,
    pub platform: String,
    pub account_ref: AccountRef,
    pub connection_epoch: i64,
}

impl WorkerRoute {
    pub fn from_terminal(terminal: &TerminalDescriptor) -> Result<Self, WorkerHostError> {
        terminal
            .validate()
            .map_err(|_| WorkerHostError::new("worker_route_invalid"))?;
        Ok(Self {
            terminal_instance_id: terminal.terminal_instance_id.clone(),
            platform: terminal.platform.clone(),
            account_ref: terminal.account_ref.clone(),
            connection_epoch: terminal.connection_epoch,
        })
    }

    pub fn validate(&self) -> Result<(), WorkerHostError> {
        validate_id(&self.terminal_instance_id)
            .map_err(|_| WorkerHostError::new("worker_route_invalid"))?;
        if !matches!(self.platform.as_str(), "mt4" | "mt5") || self.connection_epoch <= 0 {
            return Err(WorkerHostError::new("worker_route_invalid"));
        }
        self.account_ref
            .validate()
            .map_err(|_| WorkerHostError::new("worker_route_invalid"))
    }

    pub fn matches(&self, other: &Self) -> bool {
        self.platform == other.platform
            && same_terminal_route(
                &self.terminal_instance_id,
                &self.account_ref,
                self.connection_epoch,
                &other.terminal_instance_id,
                &other.account_ref,
                other.connection_epoch,
            )
    }

    fn matches_command(&self, command: &CommandMessage) -> bool {
        same_terminal_route(
            &self.terminal_instance_id,
            &self.account_ref,
            self.connection_epoch,
            &command.terminal_instance_id,
            &command.account_ref,
            command.connection_epoch,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerHello {
    pub ipc_v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub session_nonce: String,
    pub worker_version: String,
    pub route: WorkerRoute,
    pub capabilities: Vec<WorkerCapability>,
}

impl WorkerHello {
    pub fn validate(&self) -> Result<(), WorkerHostError> {
        if self.ipc_v != WORKER_IPC_VERSION || self.message_type != "worker_hello" {
            return Err(WorkerHostError::new("worker_hello_protocol_invalid"));
        }
        if self.session_nonce.len() < 32
            || self.session_nonce.len() > 128
            || !self
                .session_nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(WorkerHostError::new("worker_hello_nonce_invalid"));
        }
        if self.worker_version.is_empty()
            || self.worker_version.len() > 64
            || !self.worker_version.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+')
            })
        {
            return Err(WorkerHostError::new("worker_hello_version_invalid"));
        }
        self.route.validate()?;
        let unique = self.capabilities.iter().copied().collect::<BTreeSet<_>>();
        if unique.is_empty()
            || unique.len() != self.capabilities.len()
            || unique.len() > MAX_CAPABILITIES
        {
            return Err(WorkerHostError::new("worker_hello_capabilities_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", content = "payload", rename_all = "snake_case")]
pub enum WorkerOperation {
    ExecuteCommand { command: CommandMessage },
    QueryExecution { command: CommandMessage },
    CollectSnapshot { request: SnapshotRequest },
    Quote { request: QuoteRequest },
}

impl WorkerOperation {
    pub fn command(&self) -> Option<&CommandMessage> {
        match self {
            Self::ExecuteCommand { command } | Self::QueryExecution { command } => Some(command),
            Self::CollectSnapshot { .. } | Self::Quote { .. } => None,
        }
    }

    pub fn required_capability(&self) -> WorkerCapability {
        match self {
            Self::ExecuteCommand { .. } => WorkerCapability::ExecuteCommand,
            Self::QueryExecution { .. } => WorkerCapability::QueryExecution,
            Self::CollectSnapshot { .. } => WorkerCapability::Snapshot,
            Self::Quote { .. } => WorkerCapability::Quote,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotStream {
    Account,
    Positions,
    Orders,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotRequest {
    pub streams: Vec<SnapshotStream>,
}

impl SnapshotRequest {
    fn validate(&self) -> Result<(), WorkerHostError> {
        let unique = self.streams.iter().copied().collect::<BTreeSet<_>>();
        if unique.is_empty() || unique.len() != self.streams.len() || unique.len() > 3 {
            return Err(WorkerHostError::new("worker_snapshot_streams_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuoteRequest {
    pub symbol: String,
}

impl QuoteRequest {
    fn validate(&self) -> Result<(), WorkerHostError> {
        if self.symbol.trim() != self.symbol || self.symbol.is_empty() || self.symbol.len() > 64 {
            return Err(WorkerHostError::new("worker_quote_symbol_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotStreams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub positions: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orders: Option<Vec<serde_json::Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSnapshot {
    pub source_time_msc: i64,
    pub streams: SnapshotStreams,
}

impl TerminalSnapshot {
    pub fn validate_for(
        &self,
        request: &SnapshotRequest,
        route: &WorkerRoute,
    ) -> Result<(), WorkerHostError> {
        if self.source_time_msc <= 0 {
            return Err(WorkerHostError::new("worker_snapshot_time_invalid"));
        }
        let requested = request.streams.iter().copied().collect::<BTreeSet<_>>();
        if requested.contains(&SnapshotStream::Account) != self.streams.account.is_some()
            || requested.contains(&SnapshotStream::Positions) != self.streams.positions.is_some()
            || requested.contains(&SnapshotStream::Orders) != self.streams.orders.is_some()
        {
            return Err(WorkerHostError::new("worker_snapshot_streams_mismatch"));
        }
        if self
            .streams
            .account
            .as_ref()
            .is_some_and(|value| !value.is_object())
        {
            return Err(WorkerHostError::new("worker_snapshot_account_invalid"));
        }
        if let Some(account) = self
            .streams
            .account
            .as_ref()
            .and_then(serde_json::Value::as_object)
        {
            let login_matches = account.get("login").is_some_and(|value| {
                value.as_str() == Some(route.account_ref.login.as_str())
                    || value
                        .as_u64()
                        .is_some_and(|login| login.to_string() == route.account_ref.login)
            });
            let server_matches = account
                .get("server")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|server| server == route.account_ref.broker_server);
            if !login_matches || !server_matches {
                return Err(WorkerHostError::new(
                    "worker_snapshot_account_route_mismatch",
                ));
            }
        }
        for items in [&self.streams.positions, &self.streams.orders]
            .into_iter()
            .flatten()
        {
            if items.len() > MAX_SNAPSHOT_ITEMS || items.iter().any(|item| !valid_ticket_item(item))
            {
                return Err(WorkerHostError::new("worker_snapshot_items_invalid"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalQuote {
    pub requested_symbol: String,
    pub symbol: String,
    pub observed_at_utc_msc: i64,
    pub raw_observed_at_msc: i64,
    pub bid: f64,
    pub ask: f64,
    pub last: f64,
    pub symbol_trade_mode: i64,
    pub terminal_connected: bool,
    pub digits: u8,
    pub point: f64,
    pub timezone_offset_minutes: i16,
    pub clock_status: String,
}

impl TerminalQuote {
    fn validate_for(&self, request: &QuoteRequest) -> Result<(), WorkerHostError> {
        if self.requested_symbol != request.symbol
            || self.symbol.trim() != self.symbol
            || self.symbol.is_empty()
            || self.symbol.len() > 64
            || self.observed_at_utc_msc <= 0
            || self.raw_observed_at_msc <= 0
            || !self.bid.is_finite()
            || !self.ask.is_finite()
            || !self.last.is_finite()
            || self.bid <= 0.0
            || self.ask < self.bid
            || self.last < 0.0
            || !self.point.is_finite()
            || self.point <= 0.0
            || self.digits > 16
            || !(0..=4).contains(&self.symbol_trade_mode)
            || !self.terminal_connected
            || !(-720..=840).contains(&self.timezone_offset_minutes)
            || self.clock_status != "verified"
        {
            return Err(WorkerHostError::new("worker_quote_invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub ipc_v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub request_id: String,
    pub route: WorkerRoute,
    #[serde(flatten)]
    pub operation: WorkerOperation,
}

impl WorkerRequest {
    pub fn from_command(
        route: WorkerRoute,
        command: CommandMessage,
    ) -> Result<Self, WorkerHostError> {
        let operation = if command.action == "query_execution" {
            WorkerOperation::QueryExecution { command }
        } else {
            WorkerOperation::ExecuteCommand { command }
        };
        let request_id = operation
            .command()
            .expect("command operation")
            .command_id
            .clone();
        Ok(Self {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_request".to_owned(),
            request_id,
            route,
            operation,
        })
    }

    pub fn collect_snapshot(
        route: WorkerRoute,
        request_id: String,
        streams: Vec<SnapshotStream>,
    ) -> Self {
        Self {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_request".to_owned(),
            request_id,
            route,
            operation: WorkerOperation::CollectSnapshot {
                request: SnapshotRequest { streams },
            },
        }
    }

    pub fn quote(route: WorkerRoute, request_id: String, symbol: String) -> Self {
        Self {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_request".to_owned(),
            request_id,
            route,
            operation: WorkerOperation::Quote {
                request: QuoteRequest { symbol },
            },
        }
    }

    pub fn validate(&self, now_utc_msc: i64) -> Result<(), WorkerHostError> {
        if self.ipc_v != WORKER_IPC_VERSION || self.message_type != "worker_request" {
            return Err(WorkerHostError::new("worker_request_protocol_invalid"));
        }
        validate_id(&self.request_id)
            .map_err(|_| WorkerHostError::new("worker_request_id_invalid"))?;
        self.route.validate()?;
        match &self.operation {
            WorkerOperation::ExecuteCommand { command }
            | WorkerOperation::QueryExecution { command } => {
                command
                    .validate(now_utc_msc)
                    .map_err(|_| WorkerHostError::new("worker_request_command_invalid"))?;
                if !self.route.matches_command(command) || self.request_id != command.command_id {
                    return Err(WorkerHostError::new("worker_request_route_mismatch"));
                }
            }
            WorkerOperation::CollectSnapshot { request } => request.validate()?,
            WorkerOperation::Quote { request } => request.validate()?,
        }
        match &self.operation {
            WorkerOperation::ExecuteCommand { command } => {
                if command.action == "query_execution"
                    || !matches!(
                        command.action.as_str(),
                        "place_order"
                            | "cancel_order"
                            | "modify_order"
                            | "modify_position"
                            | "close_position"
                    )
                {
                    return Err(WorkerHostError::new("worker_execute_action_invalid"));
                }
            }
            WorkerOperation::QueryExecution { command } => {
                if command.action != "query_execution" {
                    return Err(WorkerHostError::new("worker_query_action_invalid"));
                }
            }
            WorkerOperation::CollectSnapshot { .. } | WorkerOperation::Quote { .. } => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", content = "payload", rename_all = "snake_case")]
pub enum WorkerResponseBody {
    CommandResult {
        result: Box<CommandResultMessage>,
    },
    Snapshot {
        snapshot: Box<TerminalSnapshot>,
    },
    Quote {
        quote: TerminalQuote,
    },
    Error {
        error_code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerResponse {
    pub ipc_v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub request_id: String,
    pub route: WorkerRoute,
    #[serde(flatten)]
    pub body: WorkerResponseBody,
}

impl WorkerResponse {
    pub fn command_result(request: &WorkerRequest, result: CommandResultMessage) -> Self {
        Self {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_response".to_owned(),
            request_id: request.request_id.clone(),
            route: request.route.clone(),
            body: WorkerResponseBody::CommandResult {
                result: Box::new(result),
            },
        }
    }

    pub fn validate_for(&self, request: &WorkerRequest) -> Result<(), WorkerHostError> {
        if self.ipc_v != WORKER_IPC_VERSION || self.message_type != "worker_response" {
            return Err(WorkerHostError::new("worker_response_protocol_invalid"));
        }
        if self.request_id != request.request_id || !self.route.matches(&request.route) {
            return Err(WorkerHostError::new("worker_response_route_mismatch"));
        }
        match &self.body {
            WorkerResponseBody::CommandResult { result } => {
                let Some(command) = request.operation.command() else {
                    return Err(WorkerHostError::new("worker_response_operation_mismatch"));
                };
                result
                    .validate()
                    .map_err(|_| WorkerHostError::new("worker_response_result_invalid"))?;
                if !result.matches_command(command) {
                    return Err(WorkerHostError::new(
                        "worker_response_result_route_mismatch",
                    ));
                }
            }
            WorkerResponseBody::Snapshot { snapshot } => {
                let WorkerOperation::CollectSnapshot {
                    request: snapshot_request,
                } = &request.operation
                else {
                    return Err(WorkerHostError::new("worker_response_operation_mismatch"));
                };
                snapshot.validate_for(snapshot_request, &request.route)?;
            }
            WorkerResponseBody::Quote { quote } => {
                let WorkerOperation::Quote { request } = &request.operation else {
                    return Err(WorkerHostError::new("worker_response_operation_mismatch"));
                };
                quote.validate_for(request)?;
            }
            WorkerResponseBody::Error {
                error_code,
                error_message,
            } => {
                if !valid_error_code(error_code)
                    || error_message
                        .as_ref()
                        .is_some_and(|message| message.len() > 1_024)
                {
                    return Err(WorkerHostError::new("worker_response_error_invalid"));
                }
            }
        }
        Ok(())
    }
}

fn valid_ticket_item(value: &serde_json::Value) -> bool {
    let Some(ticket) = value.as_object().and_then(|item| item.get("ticket")) else {
        return false;
    };
    ticket.as_u64().is_some_and(|value| value > 0)
        || ticket
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|value| value > 0)
}

fn valid_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(action: &str) -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JWORKER001".to_owned(),
            sent_at_utc_msc: 1_700_000_000_000,
            command_id: "command_01JWORKER001".to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: 1_700_000_000_000,
            deadline_utc_msc: 1_700_000_010_000,
            action: action.to_owned(),
            params: serde_json::json!({
                "expected_kind": "trade",
                "bridge_command_ref": "AURUM-1"
            }),
        }
    }

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

    #[test]
    fn query_execution_has_a_physically_distinct_operation() {
        let query = WorkerRequest::from_command(route(), command("query_execution"))
            .expect("query request");
        assert!(matches!(
            query.operation,
            WorkerOperation::QueryExecution { .. }
        ));
        query.validate(1_700_000_000_001).expect("valid query");

        let mut invalid = query.clone();
        invalid.operation = WorkerOperation::ExecuteCommand {
            command: command("query_execution"),
        };
        assert_eq!(
            invalid
                .validate(1_700_000_000_001)
                .expect_err("query cannot use execution path")
                .code(),
            "worker_execute_action_invalid"
        );
    }

    #[test]
    fn snapshot_contract_requires_exact_requested_streams_and_tickets() {
        let request = WorkerRequest::collect_snapshot(
            route(),
            "request_01JSNAPSHOT01".to_owned(),
            vec![SnapshotStream::Account, SnapshotStream::Positions],
        );
        request.validate(1_700_000_000_001).expect("valid request");
        let response = WorkerResponse {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_response".to_owned(),
            request_id: request.request_id.clone(),
            route: request.route.clone(),
            body: WorkerResponseBody::Snapshot {
                snapshot: Box::new(TerminalSnapshot {
                    source_time_msc: 1_700_000_000_001,
                    streams: SnapshotStreams {
                        account: Some(serde_json::json!({
                            "login": 123456,
                            "server": "Broker-Demo"
                        })),
                        positions: Some(vec![serde_json::json!({ "ticket": 101 })]),
                        orders: None,
                    },
                }),
            },
        };
        response.validate_for(&request).expect("valid snapshot");

        let mut unexpected = response;
        let WorkerResponseBody::Snapshot { snapshot } = &mut unexpected.body else {
            unreachable!();
        };
        snapshot.streams.orders = Some(Vec::new());
        assert_eq!(
            unexpected
                .validate_for(&request)
                .expect_err("unrequested stream")
                .code(),
            "worker_snapshot_streams_mismatch"
        );
    }

    #[test]
    fn quote_contract_rejects_an_unverified_clock() {
        let request = WorkerRequest::quote(
            route(),
            "request_01JQUOTE001".to_owned(),
            "XAUUSD".to_owned(),
        );
        request.validate(1_700_000_000_001).expect("valid request");
        let response = WorkerResponse {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_response".to_owned(),
            request_id: request.request_id.clone(),
            route: request.route.clone(),
            body: WorkerResponseBody::Quote {
                quote: TerminalQuote {
                    requested_symbol: "XAUUSD".to_owned(),
                    symbol: "XAUUSD.s".to_owned(),
                    observed_at_utc_msc: 1_700_000_000_001,
                    raw_observed_at_msc: 1_700_010_800_001,
                    bid: 2_300.0,
                    ask: 2_300.2,
                    last: 2_300.1,
                    symbol_trade_mode: 4,
                    terminal_connected: true,
                    digits: 2,
                    point: 0.01,
                    timezone_offset_minutes: 180,
                    clock_status: "calibrating".to_owned(),
                },
            },
        };
        assert_eq!(
            response
                .validate_for(&request)
                .expect_err("unverified clock")
                .code(),
            "worker_quote_invalid"
        );
    }
}
