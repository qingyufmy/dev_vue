use crate::WorkerHostError;
use bridge_contract::{
    AccountRef, CommandMessage, CommandResultMessage, TerminalDescriptor, same_terminal_route,
    validate_id,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const WORKER_IPC_VERSION: u16 = 1;
const MAX_CAPABILITIES: usize = 16;

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
}

impl WorkerOperation {
    pub fn command(&self) -> &CommandMessage {
        match self {
            Self::ExecuteCommand { command } | Self::QueryExecution { command } => command,
        }
    }

    pub fn required_capability(&self) -> WorkerCapability {
        match self {
            Self::ExecuteCommand { .. } => WorkerCapability::ExecuteCommand,
            Self::QueryExecution { .. } => WorkerCapability::QueryExecution,
        }
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
        let request_id = operation.command().command_id.clone();
        Ok(Self {
            ipc_v: WORKER_IPC_VERSION,
            message_type: "worker_request".to_owned(),
            request_id,
            route,
            operation,
        })
    }

    pub fn validate(&self, now_utc_msc: i64) -> Result<(), WorkerHostError> {
        if self.ipc_v != WORKER_IPC_VERSION || self.message_type != "worker_request" {
            return Err(WorkerHostError::new("worker_request_protocol_invalid"));
        }
        validate_id(&self.request_id)
            .map_err(|_| WorkerHostError::new("worker_request_id_invalid"))?;
        self.route.validate()?;
        let command = self.operation.command();
        command
            .validate(now_utc_msc)
            .map_err(|_| WorkerHostError::new("worker_request_command_invalid"))?;
        if !self.route.matches_command(command) || self.request_id != command.command_id {
            return Err(WorkerHostError::new("worker_request_route_mismatch"));
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
                result
                    .validate()
                    .map_err(|_| WorkerHostError::new("worker_response_result_invalid"))?;
                if !result.matches_command(request.operation.command()) {
                    return Err(WorkerHostError::new(
                        "worker_response_result_route_mismatch",
                    ));
                }
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
}
