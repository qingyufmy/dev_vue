use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const SERVER_PROTOCOL_VERSION: u16 = 3;
pub const MAX_LOCAL_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const TRADE_QUEUE_CAPACITY: usize = 128;
pub const QUOTE_QUEUE_CAPACITY: usize = 64;
pub const DATA_QUEUE_CAPACITY: usize = 32;
pub const SERVER_MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const SERVER_TRADE_QUEUE_CAPACITY: usize = 256;
pub const SERVER_DATA_QUEUE_CAPACITY: usize = 2_048;

pub const SUPPORTED_MESSAGE_TYPES: &[&str] = &[
    "hello",
    "hello_ack",
    "command",
    "command_result",
    "command_result_ack",
    "quote_request",
    "quote",
    "data_request",
    "data_response",
    "data_delta",
    "data_ack",
    "heartbeat",
    "release_available",
    "error",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AccountRef {
    pub broker_server: String,
    pub login: String,
}

impl AccountRef {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.broker_server.is_empty()
            || self.broker_server.len() > 128
            || self.broker_server.trim() != self.broker_server
            || self.login.is_empty()
            || self.login.len() > 64
            || self.login.trim() != self.login
        {
            return Err("bridge_account_ref_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalDescriptor {
    pub terminal_instance_id: String,
    pub platform: String,
    pub account_ref: AccountRef,
    pub connection_epoch: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_version: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BridgeClientUpdateReport {
    pub release_id: String,
    pub target_version: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_utc_msc: Option<i64>,
    pub updated_at_utc_msc: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl BridgeClientUpdateReport {
    fn validate(&self, hello_sent_at_utc_msc: i64) -> Result<(), &'static str> {
        validate_id(&self.release_id)?;
        let version_parts = self.target_version.split('.').collect::<Vec<_>>();
        if !(2..=4).contains(&version_parts.len())
            || version_parts
                .iter()
                .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
            || !matches!(self.state.as_str(), "healthy" | "rolled_back" | "failed")
            || self.updated_at_utc_msc <= 0
            || self.updated_at_utc_msc > hello_sent_at_utc_msc.saturating_add(10 * 60 * 1_000)
            || self
                .started_at_utc_msc
                .is_some_and(|started| started <= 0 || started > self.updated_at_utc_msc)
            || self.error_code.as_ref().is_some_and(|code| {
                code.is_empty()
                    || code.len() > 128
                    || !code
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
            || self.state == "failed" && self.error_code.is_none()
        {
            return Err("bridge_update_report_invalid");
        }
        Ok(())
    }
}

impl TerminalDescriptor {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_id(&self.terminal_instance_id)?;
        if !matches!(self.platform.as_str(), "mt4" | "mt5") {
            return Err("bridge_terminal_platform_unsupported");
        }
        self.account_ref.validate()?;
        if self.connection_epoch <= 0 {
            return Err("bridge_connection_epoch_invalid");
        }
        if self.worker_version.as_ref().is_some_and(|value| {
            value.trim().is_empty() || value.len() > 64 || value.trim() != value
        }) {
            return Err("bridge_worker_version_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HelloMessage {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub session_id: String,
    pub bridge_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_report: Option<BridgeClientUpdateReport>,
    pub terminals: Vec<TerminalDescriptor>,
}

impl HelloMessage {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "hello",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        validate_id(&self.session_id)?;
        if self.bridge_version.trim().is_empty()
            || self.bridge_version.len() > 64
            || self.bridge_version.trim() != self.bridge_version
        {
            return Err("bridge_version_invalid");
        }
        if self.terminals.is_empty() || self.terminals.len() > 32 {
            return Err("bridge_terminals_invalid");
        }
        if self.installation_id.as_ref().is_some_and(|value| {
            value.strip_prefix("install_").is_none_or(|suffix| {
                suffix.len() != 32
                    || !suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            })
        }) {
            return Err("bridge_installation_id_invalid");
        }
        if let Some(report) = &self.update_report {
            if self.installation_id.is_none() {
                return Err("bridge_update_report_installation_required");
            }
            report.validate(self.sent_at_utc_msc)?;
        }
        let mut identifiers = std::collections::HashSet::new();
        for terminal in &self.terminals {
            terminal.validate()?;
            if !identifiers.insert(terminal.terminal_instance_id.as_str()) {
                return Err("bridge_terminal_duplicate");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HelloAcknowledgement {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub acked_message_id: String,
    pub session_id: String,
    pub accepted_terminal_instance_ids: Vec<String>,
}

impl HelloAcknowledgement {
    pub fn validate_for(&self, hello: &HelloMessage) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "hello_ack",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        if self.acked_message_id != hello.message_id || self.session_id != hello.session_id {
            return Err("bridge_hello_ack_route_mismatch");
        }
        let accepted = self
            .accepted_terminal_instance_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        if self
            .accepted_terminal_instance_ids
            .iter()
            .any(|identifier| validate_id(identifier).is_err())
            || accepted.len() != self.accepted_terminal_instance_ids.len()
            || accepted.len() != hello.terminals.len()
            || hello
                .terminals
                .iter()
                .any(|terminal| !accepted.contains(&terminal.terminal_instance_id))
        {
            return Err("bridge_hello_ack_route_mismatch");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandMessage {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub command_id: String,
    pub terminal_instance_id: String,
    pub account_ref: AccountRef,
    pub connection_epoch: i64,
    pub issued_at_utc_msc: i64,
    pub deadline_utc_msc: i64,
    pub action: String,
    pub params: Value,
}

impl CommandMessage {
    pub fn validate(&self, now_utc_msc: i64) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "command",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        validate_id(&self.command_id)?;
        validate_id(&self.terminal_instance_id)?;
        self.account_ref.validate()?;
        if self.connection_epoch <= 0
            || self.issued_at_utc_msc <= 0
            || self.deadline_utc_msc <= 0
            || self.deadline_utc_msc < self.issued_at_utc_msc
            || self.deadline_utc_msc <= now_utc_msc
            || !matches!(
                self.action.as_str(),
                "place_order"
                    | "cancel_order"
                    | "modify_order"
                    | "modify_position"
                    | "close_position"
                    | "query_execution"
            )
            || !self.params.is_object()
        {
            return Err("bridge_command_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionEvidence {
    pub observed_at_utc_msc: i64,
    #[serde(default)]
    pub order_tickets: Vec<String>,
    #[serde(default)]
    pub position_tickets: Vec<String>,
    #[serde(default)]
    pub deal_tickets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broker_retcode: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandResultMessage {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub command_id: String,
    pub terminal_instance_id: String,
    pub account_ref: AccountRef,
    pub connection_epoch: i64,
    pub status: String,
    pub completed_at_utc_msc: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_result: Option<Value>,
    pub evidence: ExecutionEvidence,
}

impl CommandResultMessage {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "command_result",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        validate_id(&self.command_id)?;
        validate_id(&self.terminal_instance_id)?;
        self.account_ref.validate()?;
        if self.connection_epoch <= 0
            || !matches!(
                self.status.as_str(),
                "succeeded" | "rejected" | "failed" | "uncertain"
            )
            || self.completed_at_utc_msc <= 0
            || self.evidence.observed_at_utc_msc <= 0
            || self.error_code.as_ref().is_some_and(|value| {
                value.is_empty()
                    || value.len() > 128
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
        {
            return Err("bridge_command_result_invalid");
        }
        Ok(())
    }

    pub fn matches_command(&self, command: &CommandMessage) -> bool {
        self.command_id == command.command_id
            && same_terminal_route(
                &self.terminal_instance_id,
                &self.account_ref,
                self.connection_epoch,
                &command.terminal_instance_id,
                &command.account_ref,
                command.connection_epoch,
            )
    }
}

pub fn same_terminal_route(
    left_terminal_instance_id: &str,
    left_account_ref: &AccountRef,
    left_connection_epoch: i64,
    right_terminal_instance_id: &str,
    right_account_ref: &AccountRef,
    right_connection_epoch: i64,
) -> bool {
    left_terminal_instance_id == right_terminal_instance_id
        && left_connection_epoch == right_connection_epoch
        && left_account_ref.login == right_account_ref.login
        && left_account_ref
            .broker_server
            .eq_ignore_ascii_case(&right_account_ref.broker_server)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalStreamFreshness {
    pub terminal_instance_id: String,
    pub connection_epoch: i64,
    pub streams: BTreeMap<String, i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HeartbeatMessage {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub session_id: String,
    pub terminals: Vec<TerminalStreamFreshness>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DataAcknowledgement {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub acked_message_id: String,
    pub terminal_instance_id: String,
    pub connection_epoch: i64,
    pub stream: String,
    pub revision: i64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
}

impl DataAcknowledgement {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "data_ack",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        validate_id(&self.acked_message_id)?;
        validate_id(&self.terminal_instance_id)?;
        if self.connection_epoch <= 0
            || self.revision <= 0
            || !matches!(
                self.stream.as_str(),
                "account" | "positions" | "orders" | "deals" | "symbols" | "quotes" | "rates"
            )
            || !matches!(self.status.as_str(), "applied" | "duplicate" | "gap")
            || self.status == "gap" && self.expected_revision.is_none_or(|revision| revision <= 0)
        {
            return Err("bridge_data_ack_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CommandResultAcknowledgement {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    pub acked_message_id: String,
    pub command_id: String,
    pub terminal_instance_id: String,
    pub account_ref: AccountRef,
    pub connection_epoch: i64,
    pub status: String,
}

impl CommandResultAcknowledgement {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "command_result_ack",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        validate_id(&self.acked_message_id)?;
        validate_id(&self.command_id)?;
        validate_id(&self.terminal_instance_id)?;
        self.account_ref.validate()?;
        if self.connection_epoch <= 0 || !matches!(self.status.as_str(), "applied" | "duplicate") {
            return Err("bridge_command_result_ack_invalid");
        }
        Ok(())
    }
}

impl HeartbeatMessage {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_typed_envelope(
            self.v,
            &self.message_type,
            "heartbeat",
            &self.message_id,
            self.sent_at_utc_msc,
        )?;
        validate_id(&self.session_id)?;
        let mut identifiers = std::collections::HashSet::new();
        for terminal in &self.terminals {
            validate_id(&terminal.terminal_instance_id)?;
            if !identifiers.insert(terminal.terminal_instance_id.as_str())
                || terminal.connection_epoch <= 0
                || terminal.streams.iter().any(|(stream, observed)| {
                    !matches!(
                        stream.as_str(),
                        "account" | "positions" | "orders" | "deals"
                    ) || *observed <= 0
                })
            {
                return Err("bridge_heartbeat_terminal_invalid");
            }
        }
        Ok(())
    }
}

pub fn validate_id(value: &str) -> Result<(), &'static str> {
    if !(8..=128).contains(&value.len())
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
    {
        return Err("bridge_message_id_invalid");
    }
    Ok(())
}

fn validate_typed_envelope(
    version: u16,
    actual_type: &str,
    expected_type: &str,
    message_id: &str,
    sent_at_utc_msc: i64,
) -> Result<(), &'static str> {
    if version != SERVER_PROTOCOL_VERSION {
        return Err("bridge_protocol_version_unsupported");
    }
    if actual_type != expected_type {
        return Err("bridge_message_type_unsupported");
    }
    validate_id(message_id)?;
    if sent_at_utc_msc <= 0 {
        return Err("bridge_message_timestamp_invalid");
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeEnvelope {
    pub v: u16,
    #[serde(rename = "type")]
    pub message_type: String,
    pub message_id: String,
    pub sent_at_utc_msc: i64,
    #[serde(flatten)]
    pub payload: serde_json::Map<String, Value>,
}

impl BridgeEnvelope {
    pub fn validate_header(&self) -> Result<(), &'static str> {
        if self.v != SERVER_PROTOCOL_VERSION {
            return Err("bridge_protocol_version_unsupported");
        }
        if !SUPPORTED_MESSAGE_TYPES.contains(&self.message_type.as_str()) {
            return Err("bridge_message_type_unsupported");
        }
        if !(8..=128).contains(&self.message_id.len())
            || !self.message_id.bytes().enumerate().all(|(index, value)| {
                value.is_ascii_alphanumeric()
                    || (index > 0 && matches!(value, b'.' | b'_' | b':' | b'-'))
            })
        {
            return Err("bridge_message_id_invalid");
        }
        if self.sent_at_utc_msc <= 0 {
            return Err("bridge_message_timestamp_invalid");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v3_fixture_round_trips_without_field_loss() {
        let source = include_str!("../../../tests/fixtures/envelope.v3.json");
        let expected: Value = serde_json::from_str(source).expect("fixture json");
        let envelope: BridgeEnvelope = serde_json::from_str(source).expect("fixture envelope");

        envelope.validate_header().expect("valid v3 envelope");
        let actual = serde_json::to_value(envelope).expect("serialize envelope");
        assert_eq!(actual, expected);
    }

    #[test]
    fn unsupported_version_fails_closed() {
        let source = include_str!("../../../tests/fixtures/envelope.v3.json");
        let mut envelope: BridgeEnvelope = serde_json::from_str(source).expect("fixture envelope");
        envelope.v = 4;

        assert_eq!(
            envelope.validate_header(),
            Err("bridge_protocol_version_unsupported")
        );
    }

    #[test]
    fn invalid_message_id_fails_closed() {
        let source = include_str!("../../../tests/fixtures/envelope.v3.json");
        let mut envelope: BridgeEnvelope = serde_json::from_str(source).expect("fixture envelope");
        envelope.message_id = "bad id".to_owned();

        assert_eq!(envelope.validate_header(), Err("bridge_message_id_invalid"));
    }

    fn hello_fixture() -> HelloMessage {
        HelloMessage {
            v: 3,
            message_type: "hello".to_owned(),
            message_id: "hello_01JTEST0001".to_owned(),
            sent_at_utc_msc: 1_700_000_000_000,
            session_id: "session_01JTEST01".to_owned(),
            bridge_version: "4.0.0-alpha.1".to_owned(),
            installation_id: None,
            update_report: None,
            terminals: vec![TerminalDescriptor {
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                platform: "mt5".to_owned(),
                account_ref: AccountRef {
                    broker_server: "Broker-Demo".to_owned(),
                    login: "123456".to_owned(),
                },
                connection_epoch: 1,
                worker_version: Some("4.0.0-alpha.1".to_owned()),
            }],
        }
    }

    #[test]
    fn hello_ack_requires_the_exact_session_and_terminal_set() {
        let hello = hello_fixture();
        hello.validate().expect("hello");
        let mut acknowledgement = HelloAcknowledgement {
            v: 3,
            message_type: "hello_ack".to_owned(),
            message_id: "hello_ack_01JTEST".to_owned(),
            sent_at_utc_msc: 1_700_000_000_001,
            acked_message_id: hello.message_id.clone(),
            session_id: hello.session_id.clone(),
            accepted_terminal_instance_ids: vec!["mt5_terminal_01".to_owned()],
        };
        acknowledgement
            .validate_for(&hello)
            .expect("matching acknowledgement");

        acknowledgement.accepted_terminal_instance_ids = vec!["mt5_terminal_02".to_owned()];
        assert_eq!(
            acknowledgement.validate_for(&hello),
            Err("bridge_hello_ack_route_mismatch")
        );
    }

    #[test]
    fn typed_hello_uses_the_exact_v3_wire_names_and_omits_null_update_fields() {
        let mut hello = hello_fixture();
        hello.installation_id = Some("install_0123456789abcdef0123456789abcdef".to_owned());
        hello.update_report = Some(BridgeClientUpdateReport {
            release_id: "release_01JTEST001".to_owned(),
            target_version: "4.0.0".to_owned(),
            state: "healthy".to_owned(),
            started_at_utc_msc: None,
            updated_at_utc_msc: hello.sent_at_utc_msc,
            error_code: None,
        });
        hello.validate().expect("hello with update report");
        let value = serde_json::to_value(hello).expect("hello json");
        assert_eq!(value["type"], "hello");
        assert_eq!(value["terminals"][0]["account_ref"]["login"], "123456");
        assert!(value.get("message_type").is_none());
        let report = value["update_report"].as_object().expect("update report");
        assert!(!report.contains_key("started_at_utc_msc"));
        assert!(!report.contains_key("error_code"));
    }

    fn command_fixture() -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JCOMMAND01".to_owned(),
            sent_at_utc_msc: 1_700_000_000_000,
            command_id: "command_01JCOMMAND01".to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: 1_700_000_000_000,
            deadline_utc_msc: 1_700_000_010_000,
            action: "place_order".to_owned(),
            params: serde_json::json!({ "symbol": "XAUUSD", "volume": 0.01 }),
        }
    }

    #[test]
    fn command_contract_rejects_expiry_and_route_drift() {
        let command = command_fixture();
        command.validate(1_700_000_000_001).expect("valid command");
        assert_eq!(
            command.validate(command.deadline_utc_msc),
            Err("bridge_command_invalid")
        );

        let result = CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: "result_01JCOMMAND001".to_owned(),
            sent_at_utc_msc: 1_700_000_000_100,
            command_id: command.command_id.clone(),
            terminal_instance_id: command.terminal_instance_id.clone(),
            account_ref: AccountRef {
                broker_server: "broker-demo".to_owned(),
                login: command.account_ref.login.clone(),
            },
            connection_epoch: command.connection_epoch,
            status: "succeeded".to_owned(),
            completed_at_utc_msc: 1_700_000_000_100,
            error_code: None,
            error_message: None,
            raw_result: Some(serde_json::json!({ "retcode": 10009 })),
            evidence: ExecutionEvidence {
                observed_at_utc_msc: 1_700_000_000_100,
                order_tickets: vec!["1001".to_owned()],
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: Some(10009),
            },
        };
        result.validate().expect("result");
        assert!(result.matches_command(&command));
        let mut wrong_account = result;
        wrong_account.account_ref.login = "999999".to_owned();
        assert!(!wrong_account.matches_command(&command));
    }
}
