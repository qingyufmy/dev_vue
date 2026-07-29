use bridge_contract::{
    BridgeEnvelope, CommandResultAcknowledgement, CommandResultMessage, DataAcknowledgement,
    HelloAcknowledgement, HelloMessage, SERVER_DATA_QUEUE_CAPACITY, SERVER_MAX_MESSAGE_BYTES,
    SERVER_TRADE_QUEUE_CAPACITY, same_terminal_route,
};
use bridge_store::{OutboxRecord, OutboxStore};
use futures_util::{SinkExt, StreamExt};
use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Notify, Semaphore};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};
use url::Url;

mod admission;
mod inbound;
mod runtime;
mod supervisor;

pub use admission::NativeCommandAdmission;
pub use inbound::{
    InboundDataHandler, InboundEventSink, NativeInboundRouter, NoopInboundEventSink,
    ReleaseAvailableNotification,
};
pub use runtime::{
    SessionCancellation, SessionChannel, SessionIntervals, SessionRuntime,
    TerminalFreshnessProvider,
};
pub use supervisor::{
    CredentialSource, HelloProvider, NoopSupervisorStateSink, SessionConnector, SessionSupervisor,
    SupervisorStateSink, V3SessionConnector,
};

pub const ENDPOINT_SETTINGS_FILE_NAME: &str = "endpoint-settings.json";
pub const PACKAGED_SERVER_ENDPOINTS_FILE_NAME: &str = "server-endpoints.json";
pub const BRIDGE_WEBSOCKET_PATH: &str = "/aurum-api/bridge/v3/ws";
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
pub const OUTBOX_POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAXIMUM_API_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransportError {
    code: String,
}

impl TransportError {
    pub fn from_static_code(code: &'static str) -> Self {
        Self::from_code(code)
    }

    pub fn from_code(code: impl Into<String>) -> Self {
        let code = code.into();
        if code.is_empty()
            || code.len() > 128
            || code
                .bytes()
                .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'_')
        {
            return Self::new("bridge_transport_error_invalid");
        }
        Self::new(code)
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub(crate) fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

impl Display for TransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for TransportError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerEndpoints {
    control_base: Url,
    realtime_base: Url,
}

impl ServerEndpoints {
    pub fn from_server_url(value: &str) -> Result<Self, TransportError> {
        let control_base = parse_control_url(value)?;
        let mut realtime_base = control_base.clone();
        realtime_base
            .set_scheme(if control_base.scheme() == "https" {
                "wss"
            } else {
                "ws"
            })
            .map_err(|_| TransportError::new("bridge_realtime_url_invalid"))?;
        Ok(Self {
            control_base,
            realtime_base,
        })
    }

    pub fn normalize(control: &str, realtime: &str) -> Result<Self, TransportError> {
        Ok(Self {
            control_base: parse_control_url(control)?,
            realtime_base: parse_realtime_url(realtime)?,
        })
    }

    pub fn control_base(&self) -> &Url {
        &self.control_base
    }

    pub fn realtime_base(&self) -> &Url {
        &self.realtime_base
    }

    pub fn api_url(&self, path: &str) -> Result<Url, TransportError> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(TransportError::new("bridge_api_path_invalid"));
        }
        self.control_base
            .join(path)
            .map_err(|_| TransportError::new("bridge_api_path_invalid"))
    }

    pub fn websocket_url(&self, ticket: &str) -> Result<Url, TransportError> {
        if ticket.trim().is_empty() || ticket.len() > 4096 {
            return Err(TransportError::new("bridge_ticket_response_invalid"));
        }
        let mut url = self.realtime_base.clone();
        url.set_path(BRIDGE_WEBSOCKET_PATH);
        url.set_query(None);
        url.query_pairs_mut().append_pair("ticket", ticket);
        Ok(url)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EndpointSettingsDocument {
    schema_version: u8,
    control_url: String,
    realtime_url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PackagedServerEndpointsDocument {
    schema_version: u8,
    server_url: String,
}

pub fn load_endpoint_settings(path: impl AsRef<Path>) -> Result<ServerEndpoints, TransportError> {
    let bytes = read_small_json(path.as_ref(), "bridge_endpoint_settings_invalid")?;
    let document: EndpointSettingsDocument = serde_json::from_slice(strip_utf8_bom(&bytes))
        .map_err(|_| TransportError::new("bridge_endpoint_settings_invalid"))?;
    if document.schema_version != 1 {
        return Err(TransportError::new("bridge_endpoint_settings_invalid"));
    }
    ServerEndpoints::normalize(&document.control_url, &document.realtime_url)
        .map_err(|_| TransportError::new("bridge_endpoint_settings_invalid"))
}

pub fn load_packaged_server_endpoints(
    path: impl AsRef<Path>,
) -> Result<ServerEndpoints, TransportError> {
    let bytes = read_small_json(path.as_ref(), "bridge_server_endpoints_invalid")?;
    let document: PackagedServerEndpointsDocument = serde_json::from_slice(strip_utf8_bom(&bytes))
        .map_err(|_| TransportError::new("bridge_server_endpoints_invalid"))?;
    if document.schema_version != 1 {
        return Err(TransportError::new("bridge_server_endpoints_invalid"));
    }
    ServerEndpoints::from_server_url(&document.server_url)
        .map_err(|_| TransportError::new("bridge_server_endpoints_invalid"))
}

pub fn resolve_server_endpoints(
    application_directory: impl AsRef<Path>,
    root_data_directory: impl AsRef<Path>,
) -> Result<ServerEndpoints, TransportError> {
    let application_directory = application_directory.as_ref();
    let root_data_directory = root_data_directory.as_ref();
    if !application_directory.is_absolute()
        || !application_directory.is_dir()
        || !root_data_directory.is_absolute()
    {
        return Err(TransportError::new("bridge_endpoint_directory_invalid"));
    }
    let override_path = root_data_directory.join(ENDPOINT_SETTINGS_FILE_NAME);
    if override_path.is_file()
        && let Ok(endpoints) = load_endpoint_settings(&override_path)
    {
        return Ok(endpoints);
    }
    let packaged_path = application_directory.join(PACKAGED_SERVER_ENDPOINTS_FILE_NAME);
    if !packaged_path.is_file() {
        return Err(TransportError::new("bridge_server_endpoints_missing"));
    }
    load_packaged_server_endpoints(packaged_path)
}

fn read_small_json(path: &Path, code: &'static str) -> Result<Vec<u8>, TransportError> {
    let metadata = fs::metadata(path).map_err(|_| TransportError::new(code))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 4096 {
        return Err(TransportError::new(code));
    }
    fs::read(path).map_err(|_| TransportError::new(code))
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

fn parse_control_url(value: &str) -> Result<Url, TransportError> {
    let url = parse_root_url(value, "bridge_server_url_invalid")?;
    if url.scheme() == "https" || url.scheme() == "http" && is_loopback(&url) {
        Ok(url)
    } else {
        Err(TransportError::new("bridge_server_url_invalid"))
    }
}

fn parse_realtime_url(value: &str) -> Result<Url, TransportError> {
    let url = parse_root_url(value, "bridge_realtime_url_invalid")?;
    if matches!(url.scheme(), "ws" | "wss") {
        Ok(url)
    } else {
        Err(TransportError::new("bridge_realtime_url_invalid"))
    }
}

fn parse_root_url(value: &str, code: &'static str) -> Result<Url, TransportError> {
    let trimmed = value.trim();
    let url = Url::parse(trimmed).map_err(|_| TransportError::new(code))?;
    if trimmed.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host().is_none()
    {
        return Err(TransportError::new(code));
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionBootstrap {
    pub refresh_expires_in_seconds: u64,
    pub bridge_role: String,
    pub ticket: String,
}

pub struct BridgeAuthClient {
    client: reqwest::Client,
    endpoints: ServerEndpoints,
}

impl BridgeAuthClient {
    pub fn new(endpoints: ServerEndpoints, user_agent: &str) -> Result<Self, TransportError> {
        if user_agent.trim().is_empty() || user_agent.len() > 256 {
            return Err(TransportError::new("bridge_user_agent_invalid"));
        }
        let client = reqwest::Client::builder()
            .tls_backend_rustls()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(30))
            .tcp_nodelay(true)
            .user_agent(user_agent)
            .build()
            .map_err(|_| TransportError::new("bridge_http_client_failed"))?;
        Ok(Self { client, endpoints })
    }

    pub async fn acquire(&self, refresh_token: &str) -> Result<SessionBootstrap, TransportError> {
        if refresh_token.trim().is_empty() || refresh_token.len() > 16_384 {
            return Err(TransportError::new("bridge_not_paired"));
        }
        let refresh: RefreshResponse = self
            .post_json(
                "/api/auth/bridge-refresh",
                &serde_json::json!({ "refreshToken": refresh_token }),
                None,
            )
            .await?;
        if refresh.token.trim().is_empty()
            || refresh.refresh_expires_in_seconds == 0
            || !matches!(refresh.bridge_role.as_str(), "user" | "admin")
        {
            return Err(TransportError::new("bridge_refresh_response_invalid"));
        }
        let ticket: TicketResponse = self
            .post_json(
                "/api/auth/bridge-ticket",
                &serde_json::json!({}),
                Some(&refresh.token),
            )
            .await?;
        if ticket.ticket.trim().is_empty() || ticket.ticket.len() > 4096 {
            return Err(TransportError::new("bridge_ticket_response_invalid"));
        }
        Ok(SessionBootstrap {
            refresh_expires_in_seconds: refresh.refresh_expires_in_seconds,
            bridge_role: refresh.bridge_role,
            ticket: ticket.ticket,
        })
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &serde_json::Value,
        bearer_token: Option<&str>,
    ) -> Result<T, TransportError> {
        let url = self.endpoints.api_url(path)?;
        let mut request = self.client.post(url).json(body);
        if let Some(token) = bearer_token {
            request = request.bearer_auth(token);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| TransportError::new("bridge_server_unavailable"))?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if response
            .content_length()
            .is_some_and(|length| length > MAXIMUM_API_RESPONSE_BYTES as u64)
        {
            return Err(TransportError::new("bridge_server_protocol_error"));
        }
        let mut payload = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| TransportError::new("bridge_server_unavailable"))?
        {
            if payload.len() + chunk.len() > MAXIMUM_API_RESPONSE_BYTES {
                return Err(TransportError::new("bridge_server_protocol_error"));
            }
            payload.extend_from_slice(&chunk);
        }
        if content_type.starts_with("text/html")
            || content_type.starts_with("application/xhtml+xml")
            || payload
                .iter()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace())
                == Some(b'<')
        {
            return Err(TransportError::new("bridge_server_endpoint_unavailable"));
        }
        let value: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| {
            TransportError::new(if status.is_success() {
                "bridge_server_protocol_error"
            } else {
                stable_http_error(status.as_u16())
            })
        })?;
        if !status.is_success() || value.get("ok") != Some(&serde_json::Value::Bool(true)) {
            let api_code = value
                .get("code")
                .and_then(serde_json::Value::as_str)
                .filter(|code| {
                    !code.is_empty()
                        && code.len() <= 128
                        && code
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                });
            let code = api_code.unwrap_or_else(|| {
                if status.as_u16() == 429 {
                    "bridge_api_rate_limited"
                } else {
                    stable_http_error(status.as_u16())
                }
            });
            return Err(TransportError::new(code));
        }
        serde_json::from_value(value)
            .map_err(|_| TransportError::new("bridge_server_protocol_error"))
    }
}

fn stable_http_error(status: u16) -> &'static str {
    match status {
        404 | 405 => "bridge_server_endpoint_unavailable",
        429 => "bridge_api_rate_limited",
        500..=599 => "bridge_server_unavailable",
        _ => "bridge_api_request_failed",
    }
}

#[derive(Deserialize)]
struct RefreshResponse {
    token: String,
    #[serde(rename = "refreshExpiresInSeconds")]
    refresh_expires_in_seconds: u64,
    #[serde(rename = "bridgeRole")]
    bridge_role: String,
}

#[derive(Deserialize)]
struct TicketResponse {
    ticket: String,
}

type BridgeSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct BridgeWebSocketSession {
    socket: BridgeSocket,
    hello: HelloMessage,
}

impl BridgeWebSocketSession {
    pub async fn connect(
        endpoints: &ServerEndpoints,
        ticket: &str,
        hello: HelloMessage,
    ) -> Result<Self, TransportError> {
        hello
            .validate()
            .map_err(|_| TransportError::new("bridge_hello_invalid"))?;
        let url = endpoints.websocket_url(ticket)?;
        let configuration = WebSocketConfig::default()
            .max_message_size(Some(SERVER_MAX_MESSAGE_BYTES))
            .max_frame_size(Some(SERVER_MAX_MESSAGE_BYTES))
            .max_write_buffer_size(SERVER_MAX_MESSAGE_BYTES + 64 * 1024);
        let (socket, _) = connect_async_with_config(url, Some(configuration), true)
            .await
            .map_err(|_| TransportError::new("bridge_websocket_connect_failed"))?;
        let mut session = Self { socket, hello };
        let hello_json = serde_json::to_string(&session.hello)
            .map_err(|_| TransportError::new("bridge_hello_invalid"))?;
        session.send_text_unchecked(hello_json).await?;
        let acknowledgement_json = timeout(HELLO_TIMEOUT, session.receive_text_unchecked())
            .await
            .map_err(|_| TransportError::new("bridge_hello_ack_timeout"))??;
        let acknowledgement: HelloAcknowledgement = serde_json::from_str(&acknowledgement_json)
            .map_err(|_| TransportError::new("bridge_hello_ack_invalid"))?;
        acknowledgement
            .validate_for(&session.hello)
            .map_err(TransportError::new)?;
        Ok(session)
    }

    pub fn hello(&self) -> &HelloMessage {
        &self.hello
    }

    pub async fn send_json(&mut self, payload_json: String) -> Result<(), TransportError> {
        if payload_json.len() > SERVER_MAX_MESSAGE_BYTES {
            return Err(TransportError::new("bridge_outbound_message_too_large"));
        }
        let envelope: BridgeEnvelope = serde_json::from_str(&payload_json)
            .map_err(|_| TransportError::new("bridge_outbound_message_invalid"))?;
        envelope
            .validate_header()
            .map_err(|_| TransportError::new("bridge_outbound_message_invalid"))?;
        self.send_text_unchecked(payload_json).await
    }

    pub async fn receive_json(&mut self) -> Result<String, TransportError> {
        let payload = self.receive_text_unchecked().await?;
        let envelope: BridgeEnvelope = serde_json::from_str(&payload)
            .map_err(|_| TransportError::new("bridge_inbound_message_invalid"))?;
        envelope
            .validate_header()
            .map_err(|_| TransportError::new("bridge_inbound_message_invalid"))?;
        Ok(payload)
    }

    pub async fn close(&mut self) -> Result<(), TransportError> {
        self.socket
            .close(None)
            .await
            .map_err(|_| TransportError::new("bridge_websocket_close_failed"))
    }

    async fn send_text_unchecked(&mut self, payload: String) -> Result<(), TransportError> {
        self.socket
            .send(Message::Text(payload.into()))
            .await
            .map_err(|_| TransportError::new("bridge_websocket_send_failed"))
    }

    async fn receive_text_unchecked(&mut self) -> Result<String, TransportError> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(payload))) => return Ok(payload.to_string()),
                Some(Ok(Message::Ping(payload))) => self
                    .socket
                    .send(Message::Pong(payload))
                    .await
                    .map_err(|_| TransportError::new("bridge_websocket_send_failed"))?,
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None => {
                    return Err(TransportError::new("bridge_websocket_disconnected"));
                }
                Some(Ok(Message::Binary(_))) => {
                    return Err(TransportError::new("bridge_websocket_binary_rejected"));
                }
                Some(Ok(Message::Frame(_))) => {
                    return Err(TransportError::new("bridge_websocket_frame_unexpected"));
                }
                Some(Err(_)) => {
                    return Err(TransportError::new("bridge_websocket_receive_failed"));
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessagePriority {
    Trade,
    Data,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundMessage {
    pub message_id: String,
    pub payload_json: String,
    pub priority: MessagePriority,
}

struct QueueState {
    trade: VecDeque<OutboundMessage>,
    data: VecDeque<OutboundMessage>,
}

struct QueueInner {
    state: Mutex<QueueState>,
    trade_slots: Semaphore,
    data_slots: Semaphore,
    changed: Notify,
}

#[derive(Clone)]
pub struct PriorityMessageQueue {
    inner: Arc<QueueInner>,
}

impl Default for PriorityMessageQueue {
    fn default() -> Self {
        Self::new(SERVER_TRADE_QUEUE_CAPACITY, SERVER_DATA_QUEUE_CAPACITY)
            .expect("V3 queue capacities are non-zero")
    }
}

impl PriorityMessageQueue {
    pub fn new(trade_capacity: usize, data_capacity: usize) -> Result<Self, TransportError> {
        if trade_capacity == 0 || data_capacity == 0 {
            return Err(TransportError::new("bridge_queue_capacity_invalid"));
        }
        Ok(Self {
            inner: Arc::new(QueueInner {
                state: Mutex::new(QueueState {
                    trade: VecDeque::new(),
                    data: VecDeque::new(),
                }),
                trade_slots: Semaphore::new(trade_capacity),
                data_slots: Semaphore::new(data_capacity),
                changed: Notify::new(),
            }),
        })
    }

    pub async fn enqueue(&self, message: OutboundMessage) -> Result<(), TransportError> {
        if message.message_id.trim().is_empty()
            || message.payload_json.is_empty()
            || message.payload_json.len() > SERVER_MAX_MESSAGE_BYTES
        {
            return Err(TransportError::new("bridge_outbound_message_invalid"));
        }
        let slots = match message.priority {
            MessagePriority::Trade => &self.inner.trade_slots,
            MessagePriority::Data => &self.inner.data_slots,
        };
        let permit = slots
            .acquire()
            .await
            .map_err(|_| TransportError::new("bridge_queue_closed"))?;
        let mut state = self.inner.state.lock().await;
        match message.priority {
            MessagePriority::Trade => state.trade.push_back(message),
            MessagePriority::Data => state.data.push_back(message),
        }
        permit.forget();
        drop(state);
        self.inner.changed.notify_one();
        Ok(())
    }

    pub async fn dequeue(&self) -> OutboundMessage {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut state = self.inner.state.lock().await;
            if let Some(message) = state.trade.pop_front() {
                self.inner.trade_slots.add_permits(1);
                return message;
            }
            if let Some(message) = state.data.pop_front() {
                self.inner.data_slots.add_permits(1);
                return message;
            }
            drop(state);
            notified.await;
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReconnectBackoff {
    failures: usize,
}

impl ReconnectBackoff {
    pub fn next_delay(&mut self) -> Duration {
        let seconds = match self.failures {
            0 => 1,
            1 => 2,
            2 => 4,
            3 => 8,
            _ => 10,
        };
        self.failures = self.failures.saturating_add(1);
        Duration::from_secs(seconds)
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct OutboxClaim {
    attempt_count: i64,
    retry_at_utc_msc: i64,
}

pub struct OutboxPump {
    store: Arc<dyn OutboxPersistence>,
    queue: PriorityMessageQueue,
    terminal_instance_ids: Option<Vec<String>>,
    claims: StdMutex<HashMap<String, OutboxClaim>>,
}

pub trait OutboxPersistence: Send + Sync {
    fn ready_for_terminals(
        &self,
        now_utc_msc: i64,
        terminal_instance_ids: Option<&[String]>,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, bridge_store::StoreError>;

    fn record_attempt(
        &self,
        message_id: &str,
        expected_attempt_count: i64,
        next_attempt_at_utc_msc: i64,
    ) -> Result<bool, bridge_store::StoreError>;

    fn pending(&self, message_id: &str) -> Result<Option<OutboxRecord>, bridge_store::StoreError>;

    fn acknowledge(
        &self,
        message_id: &str,
        acknowledgement_status: &str,
    ) -> Result<bool, bridge_store::StoreError>;

    fn acknowledge_command_result(
        &self,
        message_id: &str,
        _command_id: &str,
        acknowledgement_status: &str,
        _acknowledged_at_utc_msc: i64,
    ) -> Result<bool, bridge_store::StoreError> {
        self.acknowledge(message_id, acknowledgement_status)
    }

    fn execution_receipt(
        &self,
        _command_id: &str,
    ) -> Result<Option<CommandResultMessage>, bridge_store::StoreError> {
        Ok(None)
    }
}

impl OutboxPersistence for OutboxStore {
    fn ready_for_terminals(
        &self,
        now_utc_msc: i64,
        terminal_instance_ids: Option<&[String]>,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, bridge_store::StoreError> {
        OutboxStore::ready_for_terminals(self, now_utc_msc, terminal_instance_ids, limit)
    }

    fn record_attempt(
        &self,
        message_id: &str,
        expected_attempt_count: i64,
        next_attempt_at_utc_msc: i64,
    ) -> Result<bool, bridge_store::StoreError> {
        OutboxStore::record_attempt(
            self,
            message_id,
            expected_attempt_count,
            next_attempt_at_utc_msc,
        )
    }

    fn pending(&self, message_id: &str) -> Result<Option<OutboxRecord>, bridge_store::StoreError> {
        OutboxStore::pending(self, message_id)
    }

    fn acknowledge(
        &self,
        message_id: &str,
        acknowledgement_status: &str,
    ) -> Result<bool, bridge_store::StoreError> {
        OutboxStore::acknowledge(self, message_id, acknowledgement_status)
    }

    fn acknowledge_command_result(
        &self,
        message_id: &str,
        command_id: &str,
        acknowledgement_status: &str,
        acknowledged_at_utc_msc: i64,
    ) -> Result<bool, bridge_store::StoreError> {
        OutboxStore::acknowledge_command_result(
            self,
            message_id,
            command_id,
            acknowledgement_status,
            acknowledged_at_utc_msc,
        )
    }

    fn execution_receipt(
        &self,
        command_id: &str,
    ) -> Result<Option<CommandResultMessage>, bridge_store::StoreError> {
        OutboxStore::execution_receipt(self, command_id)
    }
}

impl OutboxPump {
    pub fn new(
        store: Arc<dyn OutboxPersistence>,
        queue: PriorityMessageQueue,
        terminal_instance_ids: Option<Vec<String>>,
    ) -> Self {
        Self {
            store,
            queue,
            terminal_instance_ids,
            claims: StdMutex::new(HashMap::new()),
        }
    }

    pub async fn pump_once(&self, now_utc_msc: i64) -> Result<usize, TransportError> {
        let store = Arc::clone(&self.store);
        let terminal_instance_ids = self.terminal_instance_ids.clone();
        let records = tokio::task::spawn_blocking(move || {
            store.ready_for_terminals(now_utc_msc, terminal_instance_ids.as_deref(), 200)
        })
        .await
        .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
        .map_err(|_| TransportError::new("bridge_outbox_read_failed"))?;
        let mut queued = 0;
        for record in records {
            if !self.try_claim(&record, now_utc_msc)? {
                continue;
            }
            let message = OutboundMessage {
                message_id: record.message_id.clone(),
                payload_json: record.payload_json,
                priority: if record.priority == "trade" {
                    MessagePriority::Trade
                } else {
                    MessagePriority::Data
                },
            };
            if let Err(error) = self.queue.enqueue(message).await {
                self.release(&record.message_id)?;
                return Err(error);
            }
            queued += 1;
        }
        Ok(queued)
    }

    pub async fn record_successful_send(
        &self,
        message_id: &str,
        now_utc_msc: i64,
    ) -> Result<bool, TransportError> {
        let claim = self
            .claims
            .lock()
            .map_err(|_| TransportError::new("bridge_outbox_claim_failed"))?
            .get(message_id)
            .copied();
        let Some(claim) = claim else {
            return Ok(false);
        };
        let retry_at = now_utc_msc
            .checked_add(outbox_retry_delay_msc(claim.attempt_count))
            .ok_or_else(|| TransportError::new("bridge_outbox_retry_invalid"))?;
        let store = Arc::clone(&self.store);
        let persisted_message_id = message_id.to_owned();
        let recorded = tokio::task::spawn_blocking(move || {
            store.record_attempt(&persisted_message_id, claim.attempt_count, retry_at)
        })
        .await
        .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
        .map_err(|_| TransportError::new("bridge_outbox_attempt_failed"))?;
        if !recorded {
            self.release(message_id)?;
            return Ok(false);
        }
        self.claims
            .lock()
            .map_err(|_| TransportError::new("bridge_outbox_claim_failed"))?
            .insert(
                message_id.to_owned(),
                OutboxClaim {
                    attempt_count: claim.attempt_count + 1,
                    retry_at_utc_msc: retry_at,
                },
            );
        Ok(true)
    }

    pub fn release_claim(&self, message_id: &str) -> Result<(), TransportError> {
        self.release(message_id)
    }

    pub async fn handle_data_acknowledgement(
        &self,
        payload_json: &str,
    ) -> Result<DataAckDisposition, TransportError> {
        let acknowledgement: DataAcknowledgement = serde_json::from_str(payload_json)
            .map_err(|_| TransportError::new("bridge_data_ack_invalid"))?;
        acknowledgement.validate().map_err(TransportError::new)?;
        let store = Arc::clone(&self.store);
        let acked_message_id = acknowledgement.acked_message_id.clone();
        let Some(record) = tokio::task::spawn_blocking(move || store.pending(&acked_message_id))
            .await
            .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
            .map_err(|_| TransportError::new("bridge_outbox_read_failed"))?
        else {
            return Ok(DataAckDisposition::Unknown);
        };
        if record.message_type != "data_delta" {
            return Err(TransportError::new("bridge_data_ack_type_mismatch"));
        }
        let delta: DataDeltaRoute = serde_json::from_str(&record.payload_json)
            .map_err(|_| TransportError::new("bridge_data_ack_source_invalid"))?;
        if delta.message_type != "data_delta"
            || delta.message_id != acknowledgement.acked_message_id
            || delta.terminal_instance_id != acknowledgement.terminal_instance_id
            || delta.connection_epoch != acknowledgement.connection_epoch
            || delta.stream != acknowledgement.stream
            || delta.revision != acknowledgement.revision
            || record.terminal_instance_id != acknowledgement.terminal_instance_id
            || record.connection_epoch != acknowledgement.connection_epoch
        {
            return Err(TransportError::new("bridge_data_ack_route_mismatch"));
        }
        if acknowledgement.status == "gap" {
            let expected_revision = acknowledgement
                .expected_revision
                .ok_or_else(|| TransportError::new("bridge_data_ack_expected_revision_missing"))?;
            self.handle_verified_acknowledgement(
                &acknowledgement.acked_message_id,
                &acknowledgement.status,
            )
            .await?;
            return Ok(DataAckDisposition::Gap {
                terminal_instance_id: acknowledgement.terminal_instance_id,
                connection_epoch: acknowledgement.connection_epoch,
                stream: acknowledgement.stream,
                expected_revision,
            });
        }
        let removed = self
            .handle_verified_acknowledgement(
                &acknowledgement.acked_message_id,
                &acknowledgement.status,
            )
            .await?;
        Ok(if removed && delta.full_snapshot {
            DataAckDisposition::AppliedSnapshot {
                terminal_instance_id: acknowledgement.terminal_instance_id,
                connection_epoch: acknowledgement.connection_epoch,
                stream: acknowledgement.stream,
            }
        } else if removed {
            DataAckDisposition::Applied
        } else {
            DataAckDisposition::Unknown
        })
    }

    pub async fn handle_command_result_acknowledgement(
        &self,
        payload_json: &str,
    ) -> Result<bool, TransportError> {
        let acknowledgement: CommandResultAcknowledgement = serde_json::from_str(payload_json)
            .map_err(|_| TransportError::new("bridge_command_result_ack_invalid"))?;
        acknowledgement.validate().map_err(TransportError::new)?;

        let store = Arc::clone(&self.store);
        let acked_message_id = acknowledgement.acked_message_id.clone();
        let pending = tokio::task::spawn_blocking(move || store.pending(&acked_message_id))
            .await
            .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
            .map_err(|_| TransportError::new("bridge_outbox_read_failed"))?;
        if pending
            .as_ref()
            .is_some_and(|record| record.message_type != "command_result")
        {
            return Err(TransportError::new(
                "bridge_command_result_ack_type_mismatch",
            ));
        }

        let result = if let Some(record) = &pending {
            serde_json::from_str::<CommandResultMessage>(&record.payload_json)
                .map_err(|_| TransportError::new("bridge_command_result_ack_unknown"))?
        } else {
            let store = Arc::clone(&self.store);
            let command_id = acknowledgement.command_id.clone();
            tokio::task::spawn_blocking(move || store.execution_receipt(&command_id))
                .await
                .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
                .map_err(|_| TransportError::new("bridge_execution_receipt_read_failed"))?
                .ok_or_else(|| TransportError::new("bridge_command_result_ack_unknown"))?
        };
        result
            .validate()
            .map_err(|_| TransportError::new("bridge_command_result_ack_unknown"))?;
        if result.message_id != acknowledgement.acked_message_id {
            return Err(TransportError::new("bridge_command_result_ack_unknown"));
        }
        if result.command_id != acknowledgement.command_id
            || !same_terminal_route(
                &result.terminal_instance_id,
                &result.account_ref,
                result.connection_epoch,
                &acknowledgement.terminal_instance_id,
                &acknowledgement.account_ref,
                acknowledgement.connection_epoch,
            )
        {
            return Err(TransportError::new(
                "bridge_command_result_ack_route_mismatch",
            ));
        }
        self.handle_verified_command_result_acknowledgement(
            &acknowledgement.acked_message_id,
            &acknowledgement.command_id,
            &acknowledgement.status,
            acknowledgement.sent_at_utc_msc,
        )
        .await
        .and_then(|acknowledged| {
            if acknowledged {
                Ok(true)
            } else {
                Err(TransportError::new("bridge_command_result_ack_unknown"))
            }
        })
    }

    async fn handle_verified_acknowledgement(
        &self,
        message_id: &str,
        status: &str,
    ) -> Result<bool, TransportError> {
        if status == "gap" {
            if let Some(claim) = self
                .claims
                .lock()
                .map_err(|_| TransportError::new("bridge_outbox_claim_failed"))?
                .get_mut(message_id)
            {
                claim.retry_at_utc_msc = i64::MAX;
            }
            return Ok(false);
        }
        if !matches!(status, "applied" | "duplicate") {
            return Ok(false);
        }
        let store = Arc::clone(&self.store);
        let persisted_message_id = message_id.to_owned();
        let persisted_status = status.to_owned();
        let removed = tokio::task::spawn_blocking(move || {
            store.acknowledge(&persisted_message_id, &persisted_status)
        })
        .await
        .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
        .map_err(|_| TransportError::new("bridge_outbox_ack_failed"))?;
        self.release(message_id)?;
        Ok(removed)
    }

    async fn handle_verified_command_result_acknowledgement(
        &self,
        message_id: &str,
        command_id: &str,
        status: &str,
        acknowledged_at_utc_msc: i64,
    ) -> Result<bool, TransportError> {
        if !matches!(status, "applied" | "duplicate") {
            return Ok(false);
        }
        let store = Arc::clone(&self.store);
        let persisted_message_id = message_id.to_owned();
        let persisted_command_id = command_id.to_owned();
        let persisted_status = status.to_owned();
        let acknowledged = tokio::task::spawn_blocking(move || {
            store.acknowledge_command_result(
                &persisted_message_id,
                &persisted_command_id,
                &persisted_status,
                acknowledged_at_utc_msc,
            )
        })
        .await
        .map_err(|_| TransportError::new("bridge_outbox_worker_failed"))?
        .map_err(|_| TransportError::new("bridge_outbox_ack_failed"))?;
        self.release(message_id)?;
        Ok(acknowledged)
    }

    fn try_claim(&self, record: &OutboxRecord, now_utc_msc: i64) -> Result<bool, TransportError> {
        let mut claims = self
            .claims
            .lock()
            .map_err(|_| TransportError::new("bridge_outbox_claim_failed"))?;
        if claims
            .get(&record.message_id)
            .is_some_and(|claim| claim.retry_at_utc_msc > now_utc_msc)
        {
            return Ok(false);
        }
        claims.insert(
            record.message_id.clone(),
            OutboxClaim {
                attempt_count: record.attempt_count,
                retry_at_utc_msc: i64::MAX,
            },
        );
        Ok(true)
    }

    fn release(&self, message_id: &str) -> Result<(), TransportError> {
        self.claims
            .lock()
            .map_err(|_| TransportError::new("bridge_outbox_claim_failed"))?
            .remove(message_id);
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataAckDisposition {
    Applied,
    AppliedSnapshot {
        terminal_instance_id: String,
        connection_epoch: i64,
        stream: String,
    },
    Gap {
        terminal_instance_id: String,
        connection_epoch: i64,
        stream: String,
        expected_revision: i64,
    },
    Unknown,
}

#[derive(Deserialize)]
struct DataDeltaRoute {
    #[serde(rename = "type")]
    message_type: String,
    message_id: String,
    terminal_instance_id: String,
    connection_epoch: i64,
    stream: String,
    revision: i64,
    #[serde(default)]
    full_snapshot: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionState {
    Stopped,
    PairingRequired,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionTransition {
    pub state: ConnectionState,
    pub retry_after: Option<Duration>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionStateMachine {
    state: ConnectionState,
    backoff: ReconnectBackoff,
}

impl Default for SessionStateMachine {
    fn default() -> Self {
        Self {
            state: ConnectionState::Stopped,
            backoff: ReconnectBackoff::default(),
        }
    }
}

impl SessionStateMachine {
    pub fn state(&self) -> ConnectionState {
        self.state
    }

    pub fn start(&mut self, has_credential: bool) -> SessionTransition {
        self.backoff.reset();
        self.state = if has_credential {
            ConnectionState::Connecting
        } else {
            ConnectionState::PairingRequired
        };
        self.transition(None)
    }

    pub fn connected(&mut self) -> SessionTransition {
        self.state = ConnectionState::Connected;
        self.transition(None)
    }

    pub fn stable(&mut self) {
        if self.state == ConnectionState::Connected {
            self.backoff.reset();
        }
    }

    pub fn failed(&mut self, error_code: &str) -> SessionTransition {
        if error_code == "bridge_not_paired" {
            self.backoff.reset();
            self.state = ConnectionState::PairingRequired;
            return self.transition(None);
        }
        self.state = ConnectionState::Reconnecting;
        let retry_after = self.backoff.next_delay();
        self.transition(Some(retry_after))
    }

    pub fn retry(&mut self) -> SessionTransition {
        self.state = ConnectionState::Connecting;
        self.transition(None)
    }

    pub fn stop(&mut self) -> SessionTransition {
        self.backoff.reset();
        self.state = ConnectionState::Stopped;
        self.transition(None)
    }

    fn transition(&self, retry_after: Option<Duration>) -> SessionTransition {
        SessionTransition {
            state: self.state,
            retry_after,
        }
    }
}

fn outbox_retry_delay_msc(attempt_count: i64) -> i64 {
    let exponent = attempt_count.clamp(0, 4) as u32;
    (2_000_i64 << exponent).min(30_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::{AccountRef, HeartbeatMessage, TerminalDescriptor};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct FakeOutbox {
        records: StdMutex<Vec<OutboxRecord>>,
        attempts: StdMutex<Vec<(String, i64, i64)>>,
        acknowledgements: StdMutex<Vec<(String, String)>>,
        receipts: StdMutex<HashMap<String, CommandResultMessage>>,
    }

    impl OutboxPersistence for FakeOutbox {
        fn ready_for_terminals(
            &self,
            now_utc_msc: i64,
            terminal_instance_ids: Option<&[String]>,
            limit: usize,
        ) -> Result<Vec<OutboxRecord>, bridge_store::StoreError> {
            assert!(now_utc_msc > 0);
            let mut records = self.records.lock().expect("records").clone();
            if let Some(identifiers) = terminal_instance_ids {
                records.retain(|record| identifiers.contains(&record.terminal_instance_id));
            }
            records.sort_by_key(|record| (record.priority != "trade", record.id));
            records.truncate(limit);
            Ok(records)
        }

        fn record_attempt(
            &self,
            message_id: &str,
            expected_attempt_count: i64,
            next_attempt_at_utc_msc: i64,
        ) -> Result<bool, bridge_store::StoreError> {
            self.attempts.lock().expect("attempts").push((
                message_id.to_owned(),
                expected_attempt_count,
                next_attempt_at_utc_msc,
            ));
            Ok(true)
        }

        fn pending(
            &self,
            message_id: &str,
        ) -> Result<Option<OutboxRecord>, bridge_store::StoreError> {
            Ok(self
                .records
                .lock()
                .expect("records")
                .iter()
                .find(|record| record.message_id == message_id)
                .cloned())
        }

        fn acknowledge(
            &self,
            message_id: &str,
            acknowledgement_status: &str,
        ) -> Result<bool, bridge_store::StoreError> {
            self.acknowledgements
                .lock()
                .expect("acknowledgements")
                .push((message_id.to_owned(), acknowledgement_status.to_owned()));
            Ok(true)
        }

        fn execution_receipt(
            &self,
            command_id: &str,
        ) -> Result<Option<CommandResultMessage>, bridge_store::StoreError> {
            Ok(self
                .receipts
                .lock()
                .expect("receipts")
                .get(command_id)
                .cloned())
        }
    }

    fn hello() -> HelloMessage {
        HelloMessage {
            v: 3,
            message_type: "hello".to_owned(),
            message_id: "hello_01JTRANSPORT".to_owned(),
            sent_at_utc_msc: 1_700_000_000_000,
            session_id: "session_01JTRANSPORT".to_owned(),
            bridge_version: "3.0.0-alpha.1".to_owned(),
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
                worker_version: Some("3.0.0-alpha.1".to_owned()),
            }],
        }
    }

    #[test]
    fn dynamic_transport_errors_preserve_only_safe_protocol_codes() {
        assert_eq!(
            TransportError::from_code("rates_unavailable".to_owned()).code(),
            "rates_unavailable"
        );
        assert_eq!(
            TransportError::from_code("unsafe-code".to_owned()).code(),
            "bridge_transport_error_invalid"
        );
    }

    #[test]
    fn endpoint_contract_matches_v3_and_never_silently_downgrades() {
        let endpoints = ServerEndpoints::from_server_url("https://www.cnfxtrade.com/")
            .expect("production endpoint");
        assert_eq!(
            endpoints.control_base().as_str(),
            "https://www.cnfxtrade.com/"
        );
        assert_eq!(endpoints.realtime_base().scheme(), "wss");
        assert_eq!(
            endpoints
                .websocket_url("opaque ticket")
                .expect("websocket")
                .as_str(),
            "wss://www.cnfxtrade.com/aurum-api/bridge/v3/ws?ticket=opaque+ticket"
        );
        assert!(ServerEndpoints::from_server_url("http://example.com/").is_err());
        assert!(ServerEndpoints::from_server_url("http://127.0.0.1:3000/").is_ok());
        assert!(
            ServerEndpoints::normalize("https://www.cnfxtrade.com/", "ws://www.cnfxtrade.com/")
                .is_ok()
        );
    }

    #[test]
    fn endpoint_authority_prefers_admin_override_and_recovers_from_damage_with_package() {
        let root = unique_endpoint_directory();
        let application = root.join("application");
        let data = root.join("data");
        fs::create_dir_all(&application).expect("application directory");
        fs::create_dir_all(&data).expect("data directory");
        let packaged = application.join(PACKAGED_SERVER_ENDPOINTS_FILE_NAME);
        fs::write(
            &packaged,
            b"\xEF\xBB\xBF{\"schema_version\":1,\"server_url\":\"https://package.example\"}",
        )
        .expect("packaged endpoints");
        assert_eq!(
            resolve_server_endpoints(&application, &data)
                .expect("packaged authority")
                .control_base()
                .as_str(),
            "https://package.example/"
        );

        let custom = data.join(ENDPOINT_SETTINGS_FILE_NAME);
        fs::write(
            &custom,
            br#"{"schema_version":1,"control_url":"https://admin.example","realtime_url":"wss://stream.admin.example"}"#,
        )
        .expect("custom endpoints");
        let resolved = resolve_server_endpoints(&application, &data).expect("custom authority");
        assert_eq!(resolved.control_base().as_str(), "https://admin.example/");
        assert_eq!(
            resolved.realtime_base().as_str(),
            "wss://stream.admin.example/"
        );

        fs::write(&custom, b"{damaged").expect("damage custom endpoints");
        assert_eq!(
            resolve_server_endpoints(&application, &data)
                .expect("damaged override fallback")
                .control_base()
                .as_str(),
            "https://package.example/"
        );
        fs::remove_file(&packaged).expect("remove packaged endpoints");
        assert_eq!(
            resolve_server_endpoints(&application, &data)
                .expect_err("missing signed package fallback")
                .code(),
            "bridge_server_endpoints_missing"
        );
        fs::remove_dir_all(root).expect("remove endpoint fixture");
    }

    #[test]
    fn packaged_endpoint_rejects_remote_plaintext_and_unknown_fields() {
        let root = unique_endpoint_directory();
        fs::create_dir_all(&root).expect("endpoint directory");
        let path = root.join(PACKAGED_SERVER_ENDPOINTS_FILE_NAME);
        fs::write(
            &path,
            br#"{"schema_version":1,"server_url":"http://example.com"}"#,
        )
        .expect("plaintext endpoints");
        assert_eq!(
            load_packaged_server_endpoints(&path)
                .expect_err("remote plaintext")
                .code(),
            "bridge_server_endpoints_invalid"
        );
        fs::write(
            &path,
            br#"{"schema_version":1,"server_url":"https://example.com","extra":true}"#,
        )
        .expect("unknown field endpoints");
        assert_eq!(
            load_packaged_server_endpoints(&path)
                .expect_err("unknown field")
                .code(),
            "bridge_server_endpoints_invalid"
        );
        fs::remove_dir_all(root).expect("remove endpoint fixture");
    }

    #[tokio::test]
    async fn queue_is_bounded_and_strictly_trade_first() {
        let queue = PriorityMessageQueue::new(1, 2).expect("queue");
        queue
            .enqueue(OutboundMessage {
                message_id: "data_01JQUEUE0001".to_owned(),
                payload_json: "{}".to_owned(),
                priority: MessagePriority::Data,
            })
            .await
            .expect("data");
        queue
            .enqueue(OutboundMessage {
                message_id: "trade_01JQUEUE01".to_owned(),
                payload_json: "{}".to_owned(),
                priority: MessagePriority::Trade,
            })
            .await
            .expect("trade");
        assert_eq!(queue.dequeue().await.message_id, "trade_01JQUEUE01");
        assert_eq!(queue.dequeue().await.message_id, "data_01JQUEUE0001");
    }

    #[test]
    fn reconnect_and_outbox_delays_match_v3() {
        let mut backoff = ReconnectBackoff::default();
        assert_eq!(
            (0..7)
                .map(|_| backoff.next_delay().as_secs())
                .collect::<Vec<_>>(),
            vec![1, 2, 4, 8, 10, 10, 10]
        );
        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_secs(1));
        assert_eq!(
            (0..7).map(outbox_retry_delay_msc).collect::<Vec<_>>(),
            vec![2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]
        );
    }

    #[test]
    fn session_state_machine_waits_for_pairing_and_uses_v3_reconnect_backoff() {
        let mut machine = SessionStateMachine::default();
        assert_eq!(machine.start(false).state, ConnectionState::PairingRequired);
        assert_eq!(machine.start(true).state, ConnectionState::Connecting);
        assert_eq!(machine.connected().state, ConnectionState::Connected);
        assert_eq!(
            machine.failed("bridge_websocket_disconnected"),
            SessionTransition {
                state: ConnectionState::Reconnecting,
                retry_after: Some(Duration::from_secs(1)),
            }
        );
        assert_eq!(machine.retry().state, ConnectionState::Connecting);
        assert_eq!(
            machine.failed("bridge_server_unavailable").retry_after,
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            machine.failed("bridge_not_paired").state,
            ConnectionState::PairingRequired
        );
        assert_eq!(machine.stop().state, ConnectionState::Stopped);
    }

    fn unique_endpoint_directory() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "liangjian-bridge-endpoints-{}-{stamp}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn outbox_pump_prioritizes_trade_persists_retry_and_suppresses_gap() {
        let store = Arc::new(FakeOutbox::default());
        store.records.lock().expect("records").extend([
            OutboxRecord {
                id: 1,
                message_id: "data_01JOUTBOX001".to_owned(),
                message_type: "data_delta".to_owned(),
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 1,
                priority: "data".to_owned(),
                payload_json: serde_json::json!({
                    "v": 3,
                    "type": "data_delta",
                    "message_id": "data_01JOUTBOX001",
                    "terminal_instance_id": "mt5_terminal_01",
                    "connection_epoch": 1,
                    "stream": "account",
                    "revision": 1
                })
                .to_string(),
                attempt_count: 0,
                created_at_utc_msc: 1_700_000_000_000,
            },
            OutboxRecord {
                id: 2,
                message_id: "trade_01JOUTBOX1".to_owned(),
                message_type: "command_result".to_owned(),
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 1,
                priority: "trade".to_owned(),
                payload_json: "{\"v\":3}".to_owned(),
                attempt_count: 0,
                created_at_utc_msc: 1_700_000_000_001,
            },
        ]);
        let queue = PriorityMessageQueue::new(2, 2).expect("queue");
        let pump = OutboxPump::new(store.clone(), queue.clone(), None);
        assert_eq!(pump.pump_once(1_700_000_000_100).await.expect("pump"), 2);
        assert_eq!(queue.dequeue().await.message_id, "trade_01JOUTBOX1");
        assert!(
            pump.record_successful_send("trade_01JOUTBOX1", 1_700_000_000_200)
                .await
                .expect("attempt")
        );
        assert_eq!(
            store.attempts.lock().expect("attempts")[0],
            ("trade_01JOUTBOX1".to_owned(), 0, 1_700_000_002_200)
        );
        let gap = serde_json::json!({
            "v": 3,
            "type": "data_ack",
            "message_id": "data_ack_01JTEST01",
            "sent_at_utc_msc": 1_700_000_000_300_i64,
            "acked_message_id": "data_01JOUTBOX001",
            "terminal_instance_id": "mt5_terminal_01",
            "connection_epoch": 1,
            "stream": "account",
            "revision": 1,
            "status": "gap",
            "expected_revision": 1
        });
        assert_eq!(
            pump.handle_data_acknowledgement(&gap.to_string())
                .await
                .expect("gap"),
            DataAckDisposition::Gap {
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 1,
                stream: "account".to_owned(),
                expected_revision: 1,
            }
        );
        let mut mismatched = gap;
        mismatched["connection_epoch"] = serde_json::json!(2);
        assert_eq!(
            pump.handle_data_acknowledgement(&mismatched.to_string())
                .await
                .expect_err("mismatched acknowledgement must fail")
                .code(),
            "bridge_data_ack_route_mismatch"
        );
        assert_eq!(pump.pump_once(1_800_000_000_000).await.expect("repump"), 1);
        assert!(
            pump.handle_verified_acknowledgement("trade_01JOUTBOX1", "duplicate")
                .await
                .expect("duplicate")
        );
        assert_eq!(
            store.acknowledgements.lock().expect("acknowledgements")[0],
            ("trade_01JOUTBOX1".to_owned(), "duplicate".to_owned())
        );
    }

    #[test]
    fn heartbeat_contract_accepts_only_server_freshness_streams() {
        let mut streams = BTreeMap::new();
        streams.insert("account".to_owned(), 1_700_000_000_000);
        let heartbeat = HeartbeatMessage {
            v: 3,
            message_type: "heartbeat".to_owned(),
            message_id: "heartbeat_01JTEST01".to_owned(),
            sent_at_utc_msc: 1_700_000_000_001,
            session_id: hello().session_id,
            terminals: vec![bridge_contract::TerminalStreamFreshness {
                terminal_instance_id: "mt5_terminal_01".to_owned(),
                connection_epoch: 1,
                streams,
            }],
        };
        heartbeat.validate().expect("heartbeat");
    }

    fn command_result() -> CommandResultMessage {
        CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: "result_01JACKTEST001".to_owned(),
            sent_at_utc_msc: 1_700_000_000_001,
            command_id: "command_01JACKTEST01".to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            status: "succeeded".to_owned(),
            completed_at_utc_msc: 1_700_000_000_001,
            error_code: None,
            error_message: None,
            raw_result: None,
            evidence: bridge_contract::ExecutionEvidence {
                observed_at_utc_msc: 1_700_000_000_001,
                order_tickets: vec!["1001".to_owned()],
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: Some(10009),
            },
        }
    }

    fn command_result_ack(result: &CommandResultMessage) -> String {
        serde_json::json!({
            "v": 3,
            "type": "command_result_ack",
            "message_id": "ack_01JACKTEST0001",
            "sent_at_utc_msc": 1_700_000_000_002_i64,
            "acked_message_id": result.message_id,
            "command_id": result.command_id,
            "terminal_instance_id": result.terminal_instance_id,
            "account_ref": result.account_ref,
            "connection_epoch": result.connection_epoch,
            "status": "applied"
        })
        .to_string()
    }

    #[tokio::test]
    async fn command_result_ack_is_route_checked_and_accepts_a_receipt_backed_replay() {
        let store = Arc::new(FakeOutbox::default());
        let result = command_result();
        store.records.lock().expect("records").push(OutboxRecord {
            id: 1,
            message_id: result.message_id.clone(),
            message_type: "command_result".to_owned(),
            terminal_instance_id: result.terminal_instance_id.clone(),
            connection_epoch: result.connection_epoch,
            priority: "trade".to_owned(),
            payload_json: serde_json::to_string(&result).expect("result json"),
            attempt_count: 0,
            created_at_utc_msc: result.sent_at_utc_msc,
        });
        let pump = OutboxPump::new(
            store.clone(),
            PriorityMessageQueue::new(2, 2).expect("queue"),
            None,
        );
        assert!(
            pump.handle_command_result_acknowledgement(&command_result_ack(&result))
                .await
                .expect("pending acknowledgement")
        );

        store.records.lock().expect("records").clear();
        store
            .receipts
            .lock()
            .expect("receipts")
            .insert(result.command_id.clone(), result.clone());
        assert!(
            pump.handle_command_result_acknowledgement(&command_result_ack(&result))
                .await
                .expect("receipt replay")
        );

        let mut mismatched: serde_json::Value =
            serde_json::from_str(&command_result_ack(&result)).expect("ack json");
        mismatched["account_ref"]["login"] = serde_json::json!("999999");
        assert_eq!(
            pump.handle_command_result_acknowledgement(&mismatched.to_string())
                .await
                .expect_err("route mismatch")
                .code(),
            "bridge_command_result_ack_route_mismatch"
        );
    }
}
