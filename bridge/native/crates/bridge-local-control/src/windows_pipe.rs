use crate::{
    LocalControlRequest, LocalControlResponse, MAX_LOCAL_CONTROL_BYTES, decode_request,
    decode_response,
};
use bridge_foundation::validate_profile_id;
use bridge_runtime_win::CurrentUserPipeSecurity;
use serde::Serialize;
#[cfg(test)]
use serde::de::DeserializeOwned;
use std::fmt::{Display, Formatter};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use tokio::time::{Instant, sleep};

const PIPE_PREFIX: &str = "liangjian.bridge.v3.ui";
const CLIENT_RETRY_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalControlError {
    code: &'static str,
}

impl LocalControlError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl Display for LocalControlError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for LocalControlError {}

#[derive(Clone, Eq, PartialEq)]
pub struct LocalControlEndpoint {
    profile_id: String,
    pipe_name: String,
    pipe_path: String,
}

impl LocalControlEndpoint {
    pub fn for_profile(profile_id: &str) -> Result<Self, LocalControlError> {
        let profile_id = validate_profile_id(Some(profile_id))
            .map_err(|_| LocalControlError::new("bridge_local_control_profile_invalid"))?;
        let pipe_name = format!("{PIPE_PREFIX}.{profile_id}");
        if pipe_name.len() > 128 {
            return Err(LocalControlError::new(
                "bridge_local_control_profile_invalid",
            ));
        }
        let pipe_path = format!(r"\\.\pipe\{pipe_name}");
        Ok(Self {
            profile_id,
            pipe_name,
            pipe_path,
        })
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn pipe_path(&self) -> &str {
        &self.pipe_path
    }
}

impl std::fmt::Debug for LocalControlEndpoint {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalControlEndpoint")
            .field("profile_id", &self.profile_id)
            .field("pipe_name", &self.pipe_name)
            .finish_non_exhaustive()
    }
}

pub struct LocalControlPipeServer {
    endpoint: LocalControlEndpoint,
    server: NamedPipeServer,
}

impl LocalControlPipeServer {
    pub fn bind(profile_id: &str) -> Result<Self, LocalControlError> {
        let endpoint = LocalControlEndpoint::for_profile(profile_id)?;
        let security = CurrentUserPipeSecurity::new().map_err(|_| {
            LocalControlError::new("bridge_local_control_security_descriptor_failed")
        })?;
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1);
        // SAFETY: the descriptor owner lives until CreateNamedPipeW returns. Tokio does not retain
        // this SECURITY_ATTRIBUTES pointer after creating the pipe handle.
        let server = unsafe {
            options.create_with_security_attributes_raw(
                endpoint.pipe_path(),
                security.attributes_ptr(),
            )
        }
        .map_err(|_| LocalControlError::new("bridge_local_control_bind_failed"))?;
        Ok(Self { endpoint, server })
    }

    pub fn endpoint(&self) -> &LocalControlEndpoint {
        &self.endpoint
    }

    pub async fn accept(&self) -> Result<(), LocalControlError> {
        self.server
            .connect()
            .await
            .map_err(|_| LocalControlError::new("bridge_local_control_accept_failed"))
    }

    pub async fn receive(&mut self) -> Result<LocalControlRequest, LocalControlError> {
        let payload = read_payload(&mut self.server).await?;
        let request = decode_request(&payload)
            .map_err(|_| LocalControlError::new("bridge_local_control_request_invalid"))?;
        if request.profile_id != self.endpoint.profile_id {
            return Err(LocalControlError::new(
                "bridge_local_control_profile_mismatch",
            ));
        }
        Ok(request)
    }

    pub async fn send(&mut self, response: &LocalControlResponse) -> Result<(), LocalControlError> {
        response
            .validate(self.endpoint.profile_id())
            .map_err(|_| LocalControlError::new("bridge_local_control_response_invalid"))?;
        write_message(&mut self.server, response).await
    }

    pub fn disconnect(&self) -> Result<(), LocalControlError> {
        self.server
            .disconnect()
            .map_err(|_| LocalControlError::new("bridge_local_control_disconnect_failed"))
    }
}

pub struct LocalControlPipeClient {
    endpoint: LocalControlEndpoint,
    client: NamedPipeClient,
}

impl LocalControlPipeClient {
    pub async fn connect(
        profile_id: &str,
        connect_timeout: Duration,
    ) -> Result<Self, LocalControlError> {
        if connect_timeout.is_zero() {
            return Err(LocalControlError::new(
                "bridge_local_control_connect_timeout_invalid",
            ));
        }
        let endpoint = LocalControlEndpoint::for_profile(profile_id)?;
        let deadline = Instant::now() + connect_timeout;
        loop {
            match ClientOptions::new().open(endpoint.pipe_path()) {
                Ok(client) => return Ok(Self { endpoint, client }),
                Err(_) if Instant::now() < deadline => sleep(CLIENT_RETRY_INTERVAL).await,
                Err(_) => {
                    return Err(LocalControlError::new(
                        "bridge_local_control_connect_timeout",
                    ));
                }
            }
        }
    }

    pub async fn request(
        &mut self,
        request: &LocalControlRequest,
    ) -> Result<LocalControlResponse, LocalControlError> {
        request
            .validate()
            .map_err(|_| LocalControlError::new("bridge_local_control_request_invalid"))?;
        if request.profile_id != self.endpoint.profile_id {
            return Err(LocalControlError::new(
                "bridge_local_control_profile_mismatch",
            ));
        }
        write_message(&mut self.client, request).await?;
        let payload = read_payload(&mut self.client).await?;
        let response = decode_response(&payload, self.endpoint.profile_id())
            .map_err(|_| LocalControlError::new("bridge_local_control_response_invalid"))?;
        if response.request_id != request.request_id {
            return Err(LocalControlError::new(
                "bridge_local_control_request_mismatch",
            ));
        }
        Ok(response)
    }
}

async fn write_message<W, T>(writer: &mut W, message: &T) -> Result<(), LocalControlError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(message)
        .map_err(|_| LocalControlError::new("bridge_local_control_frame_json_invalid"))?;
    if payload.is_empty() || payload.len() > MAX_LOCAL_CONTROL_BYTES {
        return Err(LocalControlError::new(
            "bridge_local_control_frame_size_invalid",
        ));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| LocalControlError::new("bridge_local_control_frame_size_invalid"))?;
    writer
        .write_all(&length.to_le_bytes())
        .await
        .map_err(|_| LocalControlError::new("bridge_local_control_write_failed"))?;
    writer
        .write_all(&payload)
        .await
        .map_err(|_| LocalControlError::new("bridge_local_control_write_failed"))?;
    writer
        .flush()
        .await
        .map_err(|_| LocalControlError::new("bridge_local_control_write_failed"))
}

#[cfg(test)]
async fn read_message<R, T>(reader: &mut R) -> Result<T, LocalControlError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let payload = read_payload(reader).await?;
    serde_json::from_slice(&payload)
        .map_err(|_| LocalControlError::new("bridge_local_control_frame_json_invalid"))
}

async fn read_payload<R>(reader: &mut R) -> Result<Vec<u8>, LocalControlError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|_| LocalControlError::new("bridge_local_control_pipe_closed"))?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_LOCAL_CONTROL_BYTES {
        return Err(LocalControlError::new(
            "bridge_local_control_frame_size_invalid",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|_| LocalControlError::new("bridge_local_control_pipe_closed"))?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        LOCAL_CONTROL_SCHEMA_VERSION, LocalControlAction, LocalControlResult, UiStateSnapshot,
    };
    use tokio::io::{AsyncWriteExt, duplex};

    fn state() -> UiStateSnapshot {
        UiStateSnapshot {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            revision: 1,
            profile_id: "default".to_owned(),
            observed_at_utc_msc: 1_800_000_000_000,
            phase: "starting".to_owned(),
            detail_code: None,
            selected_platform: None,
            selected_terminal_instance_id: None,
            terminal_candidates: Vec::new(),
            terminals: Vec::new(),
            server_connected: false,
            last_data_sync_utc_msc: None,
            bridge_version: "3.0.0-alpha.1".to_owned(),
            can_manage_observer_sources: false,
            is_administrator: false,
            observer_sources: Vec::new(),
            observer_profiles: Vec::new(),
            update_notice: None,
            autostart_enabled: false,
            custom_endpoint_active: false,
        }
    }

    #[test]
    fn endpoint_is_stable_per_profile_and_invalid_profiles_are_rejected() {
        let first = LocalControlEndpoint::for_profile("default").expect("endpoint");
        let second = LocalControlEndpoint::for_profile("default").expect("endpoint");
        assert_eq!(first, second);
        assert!(
            first
                .pipe_path()
                .ends_with("liangjian.bridge.v3.ui.default")
        );
        assert_eq!(
            LocalControlEndpoint::for_profile("../other")
                .expect_err("invalid profile")
                .code(),
            "bridge_local_control_profile_invalid"
        );
    }

    #[tokio::test]
    async fn current_user_pipe_round_trips_validated_state_and_request_id() {
        let mut server = LocalControlPipeServer::bind("default").expect("bind server");
        let server_task = tokio::spawn(async move {
            server.accept().await.expect("accept client");
            let request = server.receive().await.expect("request");
            assert!(matches!(request.action, LocalControlAction::GetState));
            server
                .send(&LocalControlResponse {
                    schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                    request_id: request.request_id,
                    result: LocalControlResult::State {
                        state: Box::new(state()),
                    },
                })
                .await
                .expect("response");
        });
        let mut client = LocalControlPipeClient::connect("default", Duration::from_secs(2))
            .await
            .expect("connect client");
        let response = client
            .request(&LocalControlRequest {
                schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                request_id: "request-1".to_owned(),
                profile_id: "default".to_owned(),
                action: LocalControlAction::GetState,
            })
            .await
            .expect("round trip");
        assert_eq!(response.request_id, "request-1");
        assert!(matches!(response.result, LocalControlResult::State { .. }));
        server_task.await.expect("server task");
    }

    #[tokio::test]
    async fn oversized_length_is_rejected_before_payload_allocation() {
        let (mut writer, mut reader) = duplex(8);
        writer
            .write_all(&((MAX_LOCAL_CONTROL_BYTES as u32) + 1).to_le_bytes())
            .await
            .expect("header");
        assert_eq!(
            read_message::<_, serde_json::Value>(&mut reader)
                .await
                .expect_err("oversized frame")
                .code(),
            "bridge_local_control_frame_size_invalid"
        );
    }

    #[tokio::test]
    async fn first_instance_prevents_another_core_from_owning_the_same_ui_channel() {
        let profile_id = "test-first-instance";
        let _first = LocalControlPipeServer::bind(profile_id).expect("first server");
        let second_error = match LocalControlPipeServer::bind(profile_id) {
            Ok(_) => panic!("second server must fail"),
            Err(error) => error,
        };
        assert_eq!(second_error.code(), "bridge_local_control_bind_failed");
    }
}
