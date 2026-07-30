use serde_json::Value;
use std::fmt::{Display, Formatter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

mod connection;
mod read_api;
mod session;
mod trade_api;
pub use connection::{
    EaConnection, EaIdentity, EaPipeListener, REGISTRATION_PIPE_NAME, reconnect_pipe_name,
};
pub use read_api::{
    DataResult, DealsBatch, DealsRequest, ExtendedDataRequest, PerformanceDailyRequest, Quote,
    QuoteRequest, RatesRequest, RiskSnapshotRequest, RouteFields, SymbolSnapshotRequest,
    decode_deals, decode_extended_data, decode_performance_daily, decode_quote, decode_rates,
    decode_risk_snapshot, decode_symbol_snapshot, encode_deals, encode_deals_request,
    encode_extended_data_request, encode_performance_daily_request, encode_quote_request,
    encode_rates_request, encode_risk_snapshot_request, encode_symbol_snapshot_request,
};
pub use session::{
    EaRegistrationHub, EaRegistrationHubHandle, Mt4EaSnapshotSource, Mt4SnapshotSourceSpec,
};
pub use trade_api::{
    OrderKind, OrderSide, TradeAction, TradeCommand, TradeResult, command_from_bridge,
    decode_command, decode_command_result, encode_command, encode_command_result,
    rejected_bridge_result, result_to_bridge,
};

pub const CURRENT_PROTOCOL_VERSION: i32 = 3;
pub const CURRENT_ADAPTER_VERSION: &str = "3.2.8";
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_STRING_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[repr(i32)]
pub enum MessageType {
    Hello = 1,
    Welcome = 2,
    Collect = 10,
    Snapshot = 11,
    QuoteRequest = 12,
    Quote = 13,
    RatesRequest = 14,
    Rates = 15,
    SymbolSnapshotRequest = 16,
    SymbolSnapshot = 17,
    RiskSnapshotRequest = 18,
    RiskSnapshot = 19,
    Command = 20,
    CommandResult = 21,
    PerformanceDailyRequest = 22,
    PerformanceDaily = 23,
    DealsRequest = 24,
    Deals = 25,
    ExtendedDataRequest = 26,
    ExtendedData = 27,
    Shutdown = 90,
    ShutdownAck = 91,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct CollectionStreams(i32);

impl CollectionStreams {
    pub const NONE: Self = Self(0);
    pub const ACCOUNT: Self = Self(1);
    pub const POSITIONS: Self = Self(2);
    pub const ORDERS: Self = Self(4);
    pub const ALL: Self = Self(7);

    pub fn from_bits(bits: i32) -> Result<Self, Mt4ProtocolError> {
        if bits < 0 || bits & !Self::ALL.0 != 0 {
            return Err(Mt4ProtocolError::new("mt4_collect_streams_invalid"));
        }
        Ok(Self(bits))
    }

    pub const fn bits(self) -> i32 {
        self.0
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Hello {
    pub protocol_version: i32,
    pub adapter_version: String,
    pub terminal_data_path: String,
    pub broker_server: String,
    pub login: String,
    pub connected: bool,
    pub trade_allowed: bool,
}

impl Hello {
    pub fn validate(&self) -> Result<(), Mt4ProtocolError> {
        if self.adapter_version.trim().is_empty()
            || self.terminal_data_path.trim().is_empty()
            || self.broker_server.trim().is_empty()
            || self.login.trim().is_empty()
        {
            return Err(Mt4ProtocolError::new("mt4_hello_invalid"));
        }
        Ok(())
    }

    pub fn protocol_is_current(&self) -> bool {
        self.protocol_version == CURRENT_PROTOCOL_VERSION
    }

    pub fn adapter_is_current(&self) -> bool {
        stable_adapter_version(&self.adapter_version) == Some(CURRENT_ADAPTER_VERSION)
    }

    pub fn adapter_requires_restart(&self) -> bool {
        parse_adapter_version(&self.adapter_version).is_some_and(|version| version < (3, 2, 8))
    }

    pub fn supports_deals(&self) -> bool {
        parse_adapter_version(&self.adapter_version).is_some_and(|version| version >= (3, 1, 0))
    }

    pub fn supports_extended_data(&self) -> bool {
        parse_adapter_version(&self.adapter_version).is_some_and(|version| version >= (3, 2, 0))
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Welcome {
    pub terminal_instance_id: String,
    pub connection_epoch: i64,
    pub reconnect_pipe_name: String,
}

impl Welcome {
    pub fn validate(&self) -> Result<(), Mt4ProtocolError> {
        if self.terminal_instance_id.trim().is_empty()
            || self.connection_epoch <= 0
            || self.reconnect_pipe_name.trim().is_empty()
        {
            return Err(Mt4ProtocolError::new("mt4_welcome_invalid"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub source_time_msc: i64,
    pub account: Value,
    pub positions: Vec<Value>,
    pub orders: Vec<Value>,
}

impl Snapshot {
    pub fn validate(&self) -> Result<(), Mt4ProtocolError> {
        if self.source_time_msc <= 0 || !self.account.is_object() {
            return Err(Mt4ProtocolError::new("mt4_snapshot_invalid"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Mt4ProtocolError {
    code: &'static str,
}

impl Mt4ProtocolError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl Display for Mt4ProtocolError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for Mt4ProtocolError {}

pub fn encode_hello(hello: &Hello) -> Result<Vec<u8>, Mt4ProtocolError> {
    hello.validate()?;
    let mut writer = PayloadWriter::new(MessageType::Hello);
    writer.i32(hello.protocol_version);
    writer.string(&hello.adapter_version)?;
    writer.string(&hello.terminal_data_path)?;
    writer.string(&hello.broker_server)?;
    writer.string(&hello.login)?;
    writer.boolean(hello.connected);
    writer.boolean(hello.trade_allowed);
    writer.finish()
}

pub fn decode_hello(payload: &[u8]) -> Result<Hello, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Hello)?;
    let result = Hello {
        protocol_version: reader.i32()?,
        adapter_version: reader.string(64)?,
        terminal_data_path: reader.string(32_768)?,
        broker_server: reader.string(128)?,
        login: reader.string(64)?,
        connected: reader.boolean()?,
        trade_allowed: reader.boolean()?,
    };
    reader.finish()?;
    result.validate()?;
    Ok(result)
}

pub fn encode_welcome(welcome: &Welcome) -> Result<Vec<u8>, Mt4ProtocolError> {
    welcome.validate()?;
    let mut writer = PayloadWriter::new(MessageType::Welcome);
    writer.string(&welcome.terminal_instance_id)?;
    writer.i64(welcome.connection_epoch);
    writer.string(&welcome.reconnect_pipe_name)?;
    writer.finish()
}

pub fn decode_welcome(payload: &[u8]) -> Result<Welcome, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Welcome)?;
    let result = Welcome {
        terminal_instance_id: reader.string(128)?,
        connection_epoch: reader.i64()?,
        reconnect_pipe_name: reader.string(128)?,
    };
    reader.finish()?;
    result.validate()?;
    Ok(result)
}

pub fn encode_collect(streams: CollectionStreams) -> Result<Vec<u8>, Mt4ProtocolError> {
    CollectionStreams::from_bits(streams.bits())?;
    let mut writer = PayloadWriter::new(MessageType::Collect);
    writer.i32(streams.bits());
    writer.finish()
}

pub fn decode_collect(payload: &[u8]) -> Result<CollectionStreams, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Collect)?;
    let streams = CollectionStreams::from_bits(reader.i32()?)?;
    reader.finish()?;
    Ok(streams)
}

pub fn encode_snapshot(snapshot: &Snapshot) -> Result<Vec<u8>, Mt4ProtocolError> {
    snapshot.validate()?;
    let mut writer = PayloadWriter::new(MessageType::Snapshot);
    writer.i64(snapshot.source_time_msc);
    writer.json(&snapshot.account)?;
    writer.json(&Value::Array(snapshot.positions.clone()))?;
    writer.json(&Value::Array(snapshot.orders.clone()))?;
    writer.finish()
}

pub fn decode_snapshot(payload: &[u8]) -> Result<Snapshot, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Snapshot)?;
    let source_time_msc = reader.i64()?;
    let account = reader.json("mt4_account_snapshot_invalid")?;
    if !account.is_object() {
        return Err(Mt4ProtocolError::new("mt4_account_snapshot_invalid"));
    }
    let positions = reader.json("mt4_positions_snapshot_invalid")?;
    let positions = positions
        .as_array()
        .cloned()
        .ok_or_else(|| Mt4ProtocolError::new("mt4_positions_snapshot_invalid"))?;
    let orders = reader.json("mt4_orders_snapshot_invalid")?;
    let orders = orders
        .as_array()
        .cloned()
        .ok_or_else(|| Mt4ProtocolError::new("mt4_orders_snapshot_invalid"))?;
    reader.finish()?;
    if source_time_msc <= 0 {
        return Err(Mt4ProtocolError::new("mt4_snapshot_time_invalid"));
    }
    let result = Snapshot {
        source_time_msc,
        account,
        positions,
        orders,
    };
    result.validate()?;
    Ok(result)
}

pub fn encode_message_type(message_type: MessageType) -> Vec<u8> {
    (message_type as i32).to_le_bytes().to_vec()
}

pub fn decode_message_type(payload: &[u8], expected: MessageType) -> Result<(), Mt4ProtocolError> {
    if payload == (expected as i32).to_le_bytes() {
        Ok(())
    } else {
        Err(Mt4ProtocolError::new("mt4_pipe_message_type_invalid"))
    }
}

pub async fn write_frame<W>(writer: &mut W, payload: &[u8]) -> Result<(), Mt4ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    validate_frame_size(payload.len())?;
    writer
        .write_all(&(payload.len() as i32).to_le_bytes())
        .await
        .map_err(|_| Mt4ProtocolError::new("mt4_pipe_write_failed"))?;
    writer
        .write_all(payload)
        .await
        .map_err(|_| Mt4ProtocolError::new("mt4_pipe_write_failed"))?;
    writer
        .flush()
        .await
        .map_err(|_| Mt4ProtocolError::new("mt4_pipe_write_failed"))
}

pub async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, Mt4ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|_| Mt4ProtocolError::new("mt4_pipe_read_failed"))?;
    let size = i32::from_le_bytes(header);
    if size <= 0 {
        return Err(Mt4ProtocolError::new("mt4_pipe_frame_size_invalid"));
    }
    let size = size as usize;
    validate_frame_size(size)?;
    let mut payload = vec![0_u8; size];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|_| Mt4ProtocolError::new("mt4_pipe_read_failed"))?;
    Ok(payload)
}

fn stable_adapter_version(value: &str) -> Option<&str> {
    let stable = value.split_once('-').map_or(value, |(stable, _)| stable);
    parse_adapter_version(stable).map(|_| stable)
}

fn parse_adapter_version(value: &str) -> Option<(u32, u32, u32)> {
    let stable = value.split_once('-').map_or(value, |(stable, _)| stable);
    let mut pieces = stable.split('.');
    let major = pieces.next()?.parse().ok()?;
    let minor = pieces.next()?.parse().ok()?;
    let patch = pieces.next()?.parse().ok()?;
    if pieces.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn validate_frame_size(size: usize) -> Result<(), Mt4ProtocolError> {
    if size == 0 || size > MAX_FRAME_BYTES {
        Err(Mt4ProtocolError::new("mt4_pipe_frame_size_invalid"))
    } else {
        Ok(())
    }
}

pub(crate) struct PayloadWriter {
    bytes: Vec<u8>,
}

impl PayloadWriter {
    pub(crate) fn new(message_type: MessageType) -> Self {
        Self {
            bytes: (message_type as i32).to_le_bytes().to_vec(),
        }
    }

    pub(crate) fn i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn i64(&mut self, value: i64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn boolean(&mut self, value: bool) {
        self.i32(i32::from(value));
    }

    pub(crate) fn string(&mut self, value: &str) -> Result<(), Mt4ProtocolError> {
        let bytes = value.as_bytes();
        if bytes.len() > MAX_STRING_BYTES || bytes.len() > i32::MAX as usize {
            return Err(Mt4ProtocolError::new("mt4_pipe_string_too_large"));
        }
        self.i32(bytes.len() as i32);
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    fn json(&mut self, value: &Value) -> Result<(), Mt4ProtocolError> {
        let text = serde_json::to_string(value)
            .map_err(|_| Mt4ProtocolError::new("mt4_pipe_json_encode_failed"))?;
        self.string(&text)
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>, Mt4ProtocolError> {
        validate_frame_size(self.bytes.len())?;
        Ok(self.bytes)
    }
}

pub(crate) struct PayloadReader<'a> {
    payload: &'a [u8],
    offset: usize,
}

impl<'a> PayloadReader<'a> {
    pub(crate) fn new(payload: &'a [u8], expected: MessageType) -> Result<Self, Mt4ProtocolError> {
        validate_frame_size(payload.len())?;
        let mut result = Self { payload, offset: 0 };
        if result.i32()? != expected as i32 {
            return Err(Mt4ProtocolError::new("mt4_pipe_message_type_invalid"));
        }
        Ok(result)
    }

    fn take(&mut self, size: usize) -> Result<&'a [u8], Mt4ProtocolError> {
        let end = self
            .offset
            .checked_add(size)
            .ok_or_else(|| Mt4ProtocolError::new("mt4_pipe_payload_truncated"))?;
        let value = self
            .payload
            .get(self.offset..end)
            .ok_or_else(|| Mt4ProtocolError::new("mt4_pipe_payload_truncated"))?;
        self.offset = end;
        Ok(value)
    }

    pub(crate) fn i32(&mut self) -> Result<i32, Mt4ProtocolError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| Mt4ProtocolError::new("mt4_pipe_payload_truncated"))?;
        Ok(i32::from_le_bytes(bytes))
    }

    pub(crate) fn i64(&mut self) -> Result<i64, Mt4ProtocolError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| Mt4ProtocolError::new("mt4_pipe_payload_truncated"))?;
        Ok(i64::from_le_bytes(bytes))
    }

    pub(crate) fn boolean(&mut self) -> Result<bool, Mt4ProtocolError> {
        match self.i32()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Mt4ProtocolError::new("mt4_pipe_boolean_invalid")),
        }
    }

    pub(crate) fn string(&mut self, limit: usize) -> Result<String, Mt4ProtocolError> {
        let size = self.i32()?;
        if size < 0 {
            return Err(Mt4ProtocolError::new("mt4_pipe_string_size_invalid"));
        }
        let size = size as usize;
        if size > limit || size > MAX_STRING_BYTES {
            return Err(Mt4ProtocolError::new("mt4_pipe_string_size_invalid"));
        }
        let bytes = self.take(size)?;
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Mt4ProtocolError::new("mt4_pipe_utf8_invalid"))
    }

    fn json(&mut self, error_code: &'static str) -> Result<Value, Mt4ProtocolError> {
        let text = self.string(MAX_STRING_BYTES)?;
        serde_json::from_str(&text).map_err(|_| Mt4ProtocolError::new(error_code))
    }

    pub(crate) fn remaining(&self) -> usize {
        self.payload.len().saturating_sub(self.offset)
    }

    pub(crate) fn finish(self) -> Result<(), Mt4ProtocolError> {
        if self.offset == self.payload.len() {
            Ok(())
        } else {
            Err(Mt4ProtocolError::new("mt4_pipe_trailing_data"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> Hello {
        Hello {
            protocol_version: 3,
            adapter_version: "3.2.8-test".to_owned(),
            terminal_data_path: r"C:\MT4\Data".to_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: "12345678".to_owned(),
            connected: true,
            trade_allowed: false,
        }
    }

    fn append_string(bytes: &mut Vec<u8>, value: &str) {
        bytes.extend_from_slice(&(value.len() as i32).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }

    #[test]
    fn hello_matches_the_existing_dotnet_and_ea_binary_contract() {
        let mut expected = 1_i32.to_le_bytes().to_vec();
        expected.extend_from_slice(&3_i32.to_le_bytes());
        append_string(&mut expected, "3.2.8-test");
        append_string(&mut expected, r"C:\MT4\Data");
        append_string(&mut expected, "Broker-Demo");
        append_string(&mut expected, "12345678");
        expected.extend_from_slice(&1_i32.to_le_bytes());
        expected.extend_from_slice(&0_i32.to_le_bytes());

        assert_eq!(encode_hello(&hello()).expect("encode hello"), expected);
        assert_eq!(decode_hello(&expected).expect("decode hello"), hello());
    }

    #[test]
    fn welcome_collect_and_shutdown_contracts_are_exact() {
        let welcome = Welcome {
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            connection_epoch: 7,
            reconnect_pipe_name: "aurum_mt4_0123456789abcdef01234567".to_owned(),
        };
        assert_eq!(
            decode_welcome(&encode_welcome(&welcome).expect("encode welcome"))
                .expect("decode welcome"),
            welcome
        );
        assert_eq!(
            encode_collect(CollectionStreams::ALL).expect("collect"),
            [10_i32.to_le_bytes(), 7_i32.to_le_bytes()].concat()
        );
        assert_eq!(
            decode_collect(&[10_i32.to_le_bytes(), 5_i32.to_le_bytes()].concat())
                .expect("decode selected streams")
                .bits(),
            5
        );
        assert!(decode_collect(&[10_i32.to_le_bytes(), 8_i32.to_le_bytes()].concat()).is_err());
        assert_eq!(
            encode_message_type(MessageType::Shutdown),
            90_i32.to_le_bytes()
        );
        decode_message_type(&91_i32.to_le_bytes(), MessageType::ShutdownAck).expect("shutdown ack");
    }

    #[test]
    fn snapshot_round_trip_preserves_mt4_source_time_and_ticket_strings() {
        let snapshot = Snapshot {
            source_time_msc: 1_800_000_000_000,
            account: serde_json::json!({ "balance": 1000.5, "trade_allowed": true }),
            positions: vec![serde_json::json!({ "ticket": "9007199254740993" })],
            orders: vec![serde_json::json!({ "ticket": "42" })],
        };
        let decoded = decode_snapshot(&encode_snapshot(&snapshot).expect("encode snapshot"))
            .expect("decode snapshot");
        assert_eq!(decoded, snapshot);
        assert_eq!(decoded.positions[0]["ticket"], "9007199254740993");
    }

    #[test]
    fn decoder_fails_closed_on_malformed_payloads() {
        let mut invalid_boolean = encode_hello(&hello()).expect("hello");
        let end = invalid_boolean.len();
        invalid_boolean[end - 4..].copy_from_slice(&2_i32.to_le_bytes());
        assert_eq!(
            decode_hello(&invalid_boolean)
                .expect_err("boolean must fail")
                .code(),
            "mt4_pipe_boolean_invalid"
        );

        let mut trailing = encode_hello(&hello()).expect("hello");
        trailing.push(0);
        assert_eq!(
            decode_hello(&trailing)
                .expect_err("trailing data must fail")
                .code(),
            "mt4_pipe_trailing_data"
        );

        let invalid_snapshot = Snapshot {
            source_time_msc: 1,
            account: Value::Array(Vec::new()),
            positions: Vec::new(),
            orders: Vec::new(),
        };
        assert_eq!(
            encode_snapshot(&invalid_snapshot)
                .expect_err("account shape must fail")
                .code(),
            "mt4_snapshot_invalid"
        );
    }

    #[test]
    fn adapter_capabilities_follow_the_shipped_ea_versions() {
        let mut candidate = hello();
        assert!(candidate.protocol_is_current());
        assert!(candidate.adapter_is_current());
        assert!(!candidate.adapter_requires_restart());
        assert!(candidate.supports_deals());
        assert!(candidate.supports_extended_data());

        candidate.adapter_version = "3.2.7".to_owned();
        assert!(candidate.adapter_requires_restart());
        assert!(!candidate.adapter_is_current());
        assert!(candidate.supports_deals());
        assert!(candidate.supports_extended_data());

        candidate.adapter_version = "3.0.4".to_owned();
        assert!(candidate.adapter_requires_restart());
        assert!(!candidate.supports_deals());
        assert!(!candidate.supports_extended_data());

        candidate.adapter_version = "invalid".to_owned();
        assert!(!candidate.adapter_is_current());
        assert!(!candidate.adapter_requires_restart());
    }

    #[tokio::test]
    async fn frame_reader_handles_fragmented_writes_and_back_to_back_frames() {
        let (mut sender, mut receiver) = tokio::io::duplex(256);
        let first = encode_hello(&hello()).expect("first frame");
        let second = encode_collect(CollectionStreams::ALL).expect("second frame");
        let expected_first = first.clone();
        let expected_second = second.clone();
        let writer = tokio::spawn(async move {
            let mut wire = Vec::new();
            wire.extend_from_slice(&(first.len() as i32).to_le_bytes());
            wire.extend_from_slice(&first);
            wire.extend_from_slice(&(second.len() as i32).to_le_bytes());
            wire.extend_from_slice(&second);
            for chunk in wire.chunks(3) {
                sender.write_all(chunk).await.expect("fragment write");
            }
        });

        assert_eq!(
            read_frame(&mut receiver).await.expect("first"),
            expected_first
        );
        assert_eq!(
            read_frame(&mut receiver).await.expect("second"),
            expected_second
        );
        writer.await.expect("writer task");
    }

    #[tokio::test]
    async fn frame_io_rejects_empty_oversized_and_truncated_content() {
        let (mut sender, mut receiver) = tokio::io::duplex(16);
        sender
            .write_all(&0_i32.to_le_bytes())
            .await
            .expect("zero header");
        assert_eq!(
            read_frame(&mut receiver)
                .await
                .expect_err("zero frame")
                .code(),
            "mt4_pipe_frame_size_invalid"
        );

        let (mut sender, mut receiver) = tokio::io::duplex(16);
        sender
            .write_all(&((MAX_FRAME_BYTES + 1) as i32).to_le_bytes())
            .await
            .expect("large header");
        assert_eq!(
            read_frame(&mut receiver)
                .await
                .expect_err("large frame")
                .code(),
            "mt4_pipe_frame_size_invalid"
        );

        let (mut sender, mut receiver) = tokio::io::duplex(16);
        sender
            .write_all(&8_i32.to_le_bytes())
            .await
            .expect("truncated header");
        sender.write_all(&[1, 2]).await.expect("truncated body");
        drop(sender);
        assert_eq!(
            read_frame(&mut receiver)
                .await
                .expect_err("truncated frame")
                .code(),
            "mt4_pipe_read_failed"
        );

        let (mut sender, _receiver) = tokio::io::duplex(16);
        assert_eq!(
            write_frame(&mut sender, &[])
                .await
                .expect_err("empty write")
                .code(),
            "mt4_pipe_frame_size_invalid"
        );
    }
}
