use crate::{
    CURRENT_PROTOCOL_VERSION, CollectionStreams, DataResult, DealsBatch, DealsRequest,
    ExtendedDataRequest, Hello, MessageType, Mt4ProtocolError, PerformanceDailyRequest, Quote,
    QuoteRequest, RatesRequest, RiskSnapshotRequest, Snapshot, SymbolSnapshotRequest, Welcome,
    decode_deals, decode_extended_data, decode_hello, decode_message_type,
    decode_performance_daily, decode_quote, decode_rates, decode_risk_snapshot, decode_snapshot,
    decode_symbol_snapshot, encode_collect, encode_deals_request, encode_extended_data_request,
    encode_message_type, encode_performance_daily_request, encode_quote_request,
    encode_rates_request, encode_risk_snapshot_request, encode_symbol_snapshot_request,
    encode_welcome, read_frame, write_frame,
};
use bridge_runtime_win::CurrentUserPipeSecurity;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::time::{Instant, timeout};

pub const REGISTRATION_PIPE_NAME: &str = "AURUMBridgeV3";
const DEFAULT_PIPE_INSTANCES: usize = 32;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct EaIdentity {
    terminal_data_path: PathBuf,
    broker_server: String,
    login: String,
}

impl EaIdentity {
    pub fn new(
        terminal_data_path: impl AsRef<Path>,
        broker_server: impl Into<String>,
        login: impl Into<String>,
    ) -> Result<Self, Mt4ProtocolError> {
        let terminal_data_path = absolute_path(terminal_data_path.as_ref())?;
        let broker_server = broker_server.into();
        let login = login.into();
        if broker_server.trim().is_empty() || login.trim().is_empty() {
            return Err(Mt4ProtocolError::new("mt4_ea_identity_invalid"));
        }
        Ok(Self {
            terminal_data_path,
            broker_server: broker_server.trim().to_owned(),
            login: login.trim().to_owned(),
        })
    }

    pub fn validate(&self, hello: &Hello) -> Result<(), Mt4ProtocolError> {
        if hello.protocol_version != CURRENT_PROTOCOL_VERSION {
            return Err(Mt4ProtocolError::new("mt4_ea_protocol_incompatible"));
        }
        let hello_path = absolute_path(Path::new(&hello.terminal_data_path))?;
        if !hello.connected
            || !paths_equal_ordinal_ignore_case(&hello_path, &self.terminal_data_path)
            || !hello
                .broker_server
                .eq_ignore_ascii_case(&self.broker_server)
            || hello.login != self.login
        {
            return Err(Mt4ProtocolError::new("mt4_ea_identity_mismatch"));
        }
        Ok(())
    }

    pub fn equivalent(&self, other: &Self) -> bool {
        paths_equal_ordinal_ignore_case(&self.terminal_data_path, &other.terminal_data_path)
            && self
                .broker_server
                .eq_ignore_ascii_case(&other.broker_server)
            && self.login == other.login
    }
}

pub fn reconnect_pipe_name(terminal_instance_id: &str) -> Result<String, Mt4ProtocolError> {
    let suffix = terminal_instance_id.strip_prefix("mt4_");
    if terminal_instance_id.len() > 64
        || suffix.is_none_or(|value| {
            value.is_empty()
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
    {
        return Err(Mt4ProtocolError::new("mt4_terminal_instance_id_invalid"));
    }
    Ok(format!("aurum_{terminal_instance_id}"))
}

pub struct EaPipeListener {
    pipe_name: String,
    pipe_path: String,
    server: NamedPipeServer,
}

impl EaPipeListener {
    pub fn bind_first(pipe_name: impl Into<String>) -> Result<Self, Mt4ProtocolError> {
        Self::bind(pipe_name.into(), true)
    }

    pub fn bind_additional(pipe_name: impl Into<String>) -> Result<Self, Mt4ProtocolError> {
        Self::bind(pipe_name.into(), false)
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    pub fn pipe_path(&self) -> &str {
        &self.pipe_path
    }

    pub async fn accept(
        self,
        expected: &EaIdentity,
        accept_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<EaConnection, Mt4ProtocolError> {
        let connection = self
            .accept_unverified(accept_timeout, request_timeout)
            .await?;
        connection.verify_identity(expected)?;
        Ok(connection)
    }

    pub async fn accept_unverified(
        self,
        accept_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<EaConnection, Mt4ProtocolError> {
        if accept_timeout.is_zero() || request_timeout.is_zero() {
            return Err(Mt4ProtocolError::new("mt4_ea_timeout_invalid"));
        }
        let deadline = Instant::now() + accept_timeout;
        timeout(accept_timeout, self.server.connect())
            .await
            .map_err(|_| Mt4ProtocolError::new("mt4_ea_accept_timeout"))?
            .map_err(|_| Mt4ProtocolError::new("mt4_ea_accept_failed"))?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Mt4ProtocolError::new("mt4_ea_accept_timeout"));
        }
        let mut server = self.server;
        let payload = timeout(remaining, read_frame(&mut server))
            .await
            .map_err(|_| Mt4ProtocolError::new("mt4_ea_accept_timeout"))??;
        let hello = decode_hello(&payload)?;
        Ok(EaConnection {
            pipe: server,
            hello,
            request_timeout,
            welcomed: false,
            faulted: false,
        })
    }

    fn bind(pipe_name: String, first_instance: bool) -> Result<Self, Mt4ProtocolError> {
        validate_pipe_name(&pipe_name)?;
        let pipe_path = format!(r"\\.\pipe\{pipe_name}");
        let security = CurrentUserPipeSecurity::new()
            .map_err(|_| Mt4ProtocolError::new("mt4_ea_pipe_security_failed"))?;
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first_instance)
            .reject_remote_clients(true)
            .max_instances(DEFAULT_PIPE_INSTANCES);
        // SAFETY: the security owner remains alive for this synchronous handle creation call;
        // Tokio does not retain the SECURITY_ATTRIBUTES pointer after returning the pipe handle.
        let server = unsafe {
            options.create_with_security_attributes_raw(&pipe_path, security.attributes_ptr())
        }
        .map_err(|_| Mt4ProtocolError::new("mt4_ea_pipe_create_failed"))?;
        Ok(Self {
            pipe_name,
            pipe_path,
            server,
        })
    }
}

pub struct EaConnection {
    pipe: NamedPipeServer,
    hello: Hello,
    request_timeout: Duration,
    welcomed: bool,
    faulted: bool,
}

impl EaConnection {
    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    pub fn is_ready(&self) -> bool {
        self.welcomed && !self.faulted
    }

    pub fn verify_identity(&self, expected: &EaIdentity) -> Result<(), Mt4ProtocolError> {
        expected.validate(&self.hello)
    }

    pub async fn send_welcome(&mut self, welcome: &Welcome) -> Result<(), Mt4ProtocolError> {
        if self.faulted {
            return Err(Mt4ProtocolError::new("mt4_ea_not_ready"));
        }
        if self.welcomed {
            return Err(Mt4ProtocolError::new("mt4_ea_already_welcomed"));
        }
        let payload = encode_welcome(welcome)?;
        match timeout(self.request_timeout, write_frame(&mut self.pipe, &payload)).await {
            Ok(result) => result?,
            Err(_) => return self.poison("mt4_ea_request_timeout"),
        }
        self.welcomed = true;
        Ok(())
    }

    pub async fn collect(
        &mut self,
        streams: CollectionStreams,
    ) -> Result<Snapshot, Mt4ProtocolError> {
        let payload = encode_collect(streams)?;
        let response = self.request(payload).await?;
        decode_snapshot(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn get_quote(&mut self, request: &QuoteRequest) -> Result<Quote, Mt4ProtocolError> {
        let response = self.request(encode_quote_request(request)?).await?;
        decode_quote(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn get_rates(
        &mut self,
        request: &RatesRequest,
    ) -> Result<DataResult, Mt4ProtocolError> {
        let response = self.request(encode_rates_request(request)?).await?;
        decode_rates(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn get_symbol_snapshot(
        &mut self,
        request: &SymbolSnapshotRequest,
    ) -> Result<DataResult, Mt4ProtocolError> {
        let response = self
            .request(encode_symbol_snapshot_request(request)?)
            .await?;
        decode_symbol_snapshot(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn get_risk_snapshot(
        &mut self,
        request: &RiskSnapshotRequest,
    ) -> Result<DataResult, Mt4ProtocolError> {
        let response = self.request(encode_risk_snapshot_request(request)?).await?;
        decode_risk_snapshot(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn get_performance_daily(
        &mut self,
        request: &PerformanceDailyRequest,
    ) -> Result<DataResult, Mt4ProtocolError> {
        let response = self
            .request(encode_performance_daily_request(request)?)
            .await?;
        decode_performance_daily(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn get_extended_data(
        &mut self,
        request: &ExtendedDataRequest,
    ) -> Result<DataResult, Mt4ProtocolError> {
        let response = self.request(encode_extended_data_request(request)?).await?;
        decode_extended_data(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn collect_deals(
        &mut self,
        request: &DealsRequest,
    ) -> Result<DealsBatch, Mt4ProtocolError> {
        let response = self.request(encode_deals_request(request)?).await?;
        decode_deals(&response).inspect_err(|_| self.disconnect())
    }

    pub async fn close(mut self) -> Result<(), Mt4ProtocolError> {
        if !self.faulted && self.welcomed {
            let operation = async {
                write_frame(&mut self.pipe, &encode_message_type(MessageType::Shutdown)).await?;
                let response = read_frame(&mut self.pipe).await?;
                decode_message_type(&response, MessageType::ShutdownAck)
            };
            if let Ok(result) = timeout(Duration::from_secs(2), operation).await {
                result?;
            }
        }
        let _ = self.pipe.shutdown().await;
        let _ = self.pipe.disconnect();
        Ok(())
    }

    fn poison<T>(&mut self, code: &'static str) -> Result<T, Mt4ProtocolError> {
        self.disconnect();
        Err(Mt4ProtocolError::new(code))
    }

    fn disconnect(&mut self) {
        self.faulted = true;
        let _ = self.pipe.disconnect();
    }

    async fn request(&mut self, payload: Vec<u8>) -> Result<Vec<u8>, Mt4ProtocolError> {
        if !self.is_ready() {
            return Err(Mt4ProtocolError::new("mt4_ea_not_ready"));
        }
        let operation = async {
            write_frame(&mut self.pipe, &payload).await?;
            read_frame(&mut self.pipe).await
        };
        match timeout(self.request_timeout, operation).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => {
                self.disconnect();
                Err(error)
            }
            Err(_) => self.poison("mt4_ea_request_timeout"),
        }
    }
}

fn validate_pipe_name(value: &str) -> Result<(), Mt4ProtocolError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(Mt4ProtocolError::new("mt4_ea_pipe_name_invalid"));
    }
    Ok(())
}

fn absolute_path(value: &Path) -> Result<PathBuf, Mt4ProtocolError> {
    if value.as_os_str().is_empty() {
        return Err(Mt4ProtocolError::new("mt4_ea_identity_invalid"));
    }
    std::path::absolute(value).map_err(|_| Mt4ProtocolError::new("mt4_ea_identity_invalid"))
}

fn paths_equal_ordinal_ignore_case(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PayloadWriter, RouteFields, decode_collect, decode_welcome, encode_hello, encode_snapshot,
    };
    use tokio::net::windows::named_pipe::ClientOptions;

    fn unique_pipe(label: &str) -> String {
        format!(
            "liangjian_mt4_{label}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        )
    }

    fn hello(path: &Path, login: &str) -> Hello {
        Hello {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            adapter_version: "3.2.4-test".to_owned(),
            terminal_data_path: path.to_string_lossy().into_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: login.to_owned(),
            connected: true,
            trade_allowed: true,
        }
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            source_time_msc: 1_800_000_000_000,
            account: serde_json::json!({ "login": 12345678, "balance": 10_000.0 }),
            positions: vec![serde_json::json!({ "ticket": "91", "symbol": "XAUUSD" })],
            orders: Vec::new(),
        }
    }

    #[tokio::test]
    async fn current_user_pipe_completes_hello_welcome_snapshot_and_shutdown() {
        let pipe_name = unique_pipe("happy");
        let listener = EaPipeListener::bind_first(&pipe_name).expect("listener");
        let data_path = std::env::temp_dir().join("Liangjian MT4 Data");
        let expected = EaIdentity::new(&data_path, "broker-demo", "12345678").expect("identity");
        let client_path = listener.pipe_path().to_owned();
        let client_hello = hello(&data_path, "12345678");
        let expected_snapshot = snapshot();
        let client_snapshot = expected_snapshot.clone();
        let client = tokio::spawn(async move {
            let mut pipe = ClientOptions::new().open(client_path).expect("client open");
            write_frame(&mut pipe, &encode_hello(&client_hello).expect("hello"))
                .await
                .expect("write hello");
            let welcome = decode_welcome(&read_frame(&mut pipe).await.expect("welcome frame"))
                .expect("welcome");
            assert_eq!(welcome.connection_epoch, 9);
            let streams = decode_collect(&read_frame(&mut pipe).await.expect("collect frame"))
                .expect("collect");
            assert_eq!(streams, CollectionStreams::ALL);
            write_frame(
                &mut pipe,
                &encode_snapshot(&client_snapshot).expect("snapshot"),
            )
            .await
            .expect("write snapshot");
            let rates = read_frame(&mut pipe).await.expect("rates frame");
            assert_eq!(
                i32::from_le_bytes(rates[..4].try_into().expect("message type")),
                MessageType::RatesRequest as i32
            );
            let mut response = PayloadWriter::new(MessageType::Rates);
            response.string("rates_01").expect("request id");
            response.i64(1_800_000_000_001);
            response.i32(1);
            response
                .string(r#"{"source":"mt4","rates":[]}"#)
                .expect("payload");
            response.string("").expect("error");
            write_frame(&mut pipe, &response.finish().expect("rates response"))
                .await
                .expect("write rates");
            let shutdown = read_frame(&mut pipe).await.expect("shutdown frame");
            decode_message_type(&shutdown, MessageType::Shutdown).expect("shutdown");
            write_frame(&mut pipe, &encode_message_type(MessageType::ShutdownAck))
                .await
                .expect("shutdown ack");
        });

        let mut connection = listener
            .accept(&expected, Duration::from_secs(2), Duration::from_secs(1))
            .await
            .expect("accept");
        assert!(connection.hello().trade_allowed);
        connection
            .send_welcome(&Welcome {
                terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
                connection_epoch: 9,
                reconnect_pipe_name: "aurum_mt4_0123456789abcdef01234567".to_owned(),
            })
            .await
            .expect("send welcome");
        assert_eq!(
            connection
                .collect(CollectionStreams::ALL)
                .await
                .expect("collect snapshot"),
            expected_snapshot
        );
        let rates = connection
            .get_rates(&RatesRequest {
                route: RouteFields {
                    request_id: "rates_01".to_owned(),
                    terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
                    broker_server: "Broker-Demo".to_owned(),
                    login: "12345678".to_owned(),
                    connection_epoch: 9,
                },
                symbol: "XAUUSD".to_owned(),
                timeframe: "M5".to_owned(),
                count: 100,
                start_utc_msc: 0,
                end_utc_msc: 0,
            })
            .await
            .expect("rates");
        assert_eq!(rates.payload.expect("rates payload")["source"], "mt4");
        connection.close().await.expect("close");
        client.await.expect("client task");
    }

    #[tokio::test]
    async fn handshake_rejects_the_wrong_account_before_welcome() {
        let pipe_name = unique_pipe("identity");
        let listener = EaPipeListener::bind_first(&pipe_name).expect("listener");
        let data_path = std::env::temp_dir().join("Liangjian MT4 Identity");
        let expected = EaIdentity::new(&data_path, "Broker-Demo", "12345678").expect("identity");
        let client_path = listener.pipe_path().to_owned();
        let client = tokio::spawn(async move {
            let mut pipe = ClientOptions::new().open(client_path).expect("client open");
            write_frame(
                &mut pipe,
                &encode_hello(&hello(&data_path, "87654321")).expect("hello"),
            )
            .await
            .expect("write hello");
        });
        let error = match listener
            .accept(&expected, Duration::from_secs(2), Duration::from_secs(1))
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("identity mismatch must fail"),
        };
        assert_eq!(error.code(), "mt4_ea_identity_mismatch");
        client.await.expect("client task");
    }

    #[tokio::test]
    async fn request_timeout_disconnects_the_pipe_and_prevents_late_response_reuse() {
        let pipe_name = unique_pipe("timeout");
        let listener = EaPipeListener::bind_first(&pipe_name).expect("listener");
        let data_path = std::env::temp_dir().join("Liangjian MT4 Timeout");
        let expected = EaIdentity::new(&data_path, "Broker-Demo", "12345678").expect("identity");
        let client_path = listener.pipe_path().to_owned();
        let client = tokio::spawn(async move {
            let mut pipe = ClientOptions::new().open(client_path).expect("client open");
            write_frame(
                &mut pipe,
                &encode_hello(&hello(&data_path, "12345678")).expect("hello"),
            )
            .await
            .expect("write hello");
            let _ = read_frame(&mut pipe).await.expect("welcome");
            let _ = read_frame(&mut pipe).await.expect("collect");
            tokio::time::sleep(Duration::from_millis(150)).await;
        });
        let mut connection = listener
            .accept(&expected, Duration::from_secs(2), Duration::from_millis(50))
            .await
            .expect("accept");
        connection
            .send_welcome(&Welcome {
                terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
                connection_epoch: 1,
                reconnect_pipe_name: "aurum_mt4_0123456789abcdef01234567".to_owned(),
            })
            .await
            .expect("welcome");
        assert_eq!(
            connection
                .collect(CollectionStreams::ALL)
                .await
                .expect_err("timeout")
                .code(),
            "mt4_ea_request_timeout"
        );
        assert_eq!(
            connection
                .collect(CollectionStreams::ALL)
                .await
                .expect_err("poisoned connection")
                .code(),
            "mt4_ea_not_ready"
        );
        client.await.expect("client task");
    }

    #[tokio::test]
    async fn first_instance_prevents_local_pipe_hijacking() {
        let pipe_name = unique_pipe("exclusive");
        let _listener = EaPipeListener::bind_first(&pipe_name).expect("first listener");
        let error = match EaPipeListener::bind_first(&pipe_name) {
            Err(error) => error,
            Ok(_) => panic!("second first instance must fail"),
        };
        assert_eq!(error.code(), "mt4_ea_pipe_create_failed");
    }
}
