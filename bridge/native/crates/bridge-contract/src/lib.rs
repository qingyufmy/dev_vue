use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SERVER_PROTOCOL_VERSION: u16 = 3;
pub const MAX_LOCAL_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const TRADE_QUEUE_CAPACITY: usize = 128;
pub const QUOTE_QUEUE_CAPACITY: usize = 64;
pub const DATA_QUEUE_CAPACITY: usize = 32;

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
}
