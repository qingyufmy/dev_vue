use crate::{ExpectedWorker, WorkerClient, WorkerHostError};
use bridge_runtime_win::CurrentUserPipeSecurity;
use std::ptr::null_mut;
use std::time::Duration;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::time::{Instant, timeout};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

const PIPE_PREFIX: &str = "liangjian.bridge.v3";
const NONCE_BYTES: usize = 32;

#[derive(Clone, Eq, PartialEq)]
pub struct WorkerEndpoint {
    pipe_name: String,
    pipe_path: String,
    session_nonce: String,
}

impl WorkerEndpoint {
    pub fn generate() -> Result<Self, WorkerHostError> {
        let session_nonce = random_hex(NONCE_BYTES)?;
        // The random suffix prevents accidental cross-session attachment; the nonce still has to
        // match the authenticated hello before this connection is accepted.
        let pipe_name = format!(
            "{PIPE_PREFIX}.{}.{}",
            unsafe { GetCurrentProcessId() },
            &session_nonce[..32]
        );
        Self::from_parts(pipe_name, session_nonce)
    }

    fn from_parts(pipe_name: String, session_nonce: String) -> Result<Self, WorkerHostError> {
        validate_pipe_name(&pipe_name)?;
        validate_nonce(&session_nonce)?;
        let pipe_path = format!(r"\\.\pipe\{pipe_name}");
        Ok(Self {
            pipe_name,
            pipe_path,
            session_nonce,
        })
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    pub fn pipe_path(&self) -> &str {
        &self.pipe_path
    }

    pub fn session_nonce(&self) -> &str {
        &self.session_nonce
    }
}

impl std::fmt::Debug for WorkerEndpoint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkerEndpoint")
            .field("pipe_name", &"[redacted]")
            .field("pipe_path", &"[redacted]")
            .field("session_nonce", &"[redacted]")
            .finish()
    }
}

pub struct WorkerPipeListener {
    endpoint: WorkerEndpoint,
    server: NamedPipeServer,
}

impl WorkerPipeListener {
    pub fn bind_new() -> Result<Self, WorkerHostError> {
        Self::bind(WorkerEndpoint::generate()?)
    }

    pub fn endpoint(&self) -> &WorkerEndpoint {
        &self.endpoint
    }

    pub async fn accept(
        self,
        expected: ExpectedWorker,
        accept_timeout: Duration,
    ) -> Result<WorkerClient<NamedPipeServer>, WorkerHostError> {
        if accept_timeout.is_zero() {
            return Err(WorkerHostError::new("worker_pipe_accept_timeout_invalid"));
        }
        if expected.session_nonce != self.endpoint.session_nonce {
            return Err(WorkerHostError::new("worker_pipe_expected_nonce_mismatch"));
        }
        let deadline = Instant::now() + accept_timeout;
        timeout(accept_timeout, self.server.connect())
            .await
            .map_err(|_| WorkerHostError::new("worker_pipe_accept_timeout"))?
            .map_err(|_| WorkerHostError::new("worker_pipe_accept_failed"))?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WorkerHostError::new("worker_pipe_handshake_timeout"));
        }
        WorkerClient::handshake(self.server, expected, remaining).await
    }

    fn bind(endpoint: WorkerEndpoint) -> Result<Self, WorkerHostError> {
        let security = CurrentUserPipeSecurity::new()
            .map_err(|_| WorkerHostError::new("worker_pipe_security_descriptor_failed"))?;
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1);
        // SAFETY: security owns both SECURITY_ATTRIBUTES and its descriptor until CreateNamedPipeW
        // returns. Tokio does not retain this pointer after server creation.
        let server = unsafe {
            options.create_with_security_attributes_raw(
                endpoint.pipe_path(),
                security.attributes_ptr(),
            )
        }
        .map_err(|_| WorkerHostError::new("worker_pipe_create_failed"))?;
        Ok(Self { endpoint, server })
    }
}

fn random_hex(byte_count: usize) -> Result<String, WorkerHostError> {
    let mut bytes = vec![0_u8; byte_count];
    // SAFETY: BCryptGenRandom writes exactly the supplied mutable buffer length.
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(WorkerHostError::new("worker_pipe_random_failed"));
    }
    let mut encoded = String::with_capacity(byte_count * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}")
            .map_err(|_| WorkerHostError::new("worker_pipe_random_failed"))?;
    }
    Ok(encoded)
}

fn validate_pipe_name(value: &str) -> Result<(), WorkerHostError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(WorkerHostError::new("worker_pipe_name_invalid"));
    }
    Ok(())
}

fn validate_nonce(value: &str) -> Result<(), WorkerHostError> {
    if value.len() != NONCE_BYTES * 2 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkerHostError::new("worker_pipe_nonce_invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        WORKER_IPC_VERSION, WorkerCapability, WorkerHello, WorkerRole, WorkerRoute, write_frame,
    };
    use bridge_contract::AccountRef;
    use std::collections::BTreeSet;
    use tokio::net::windows::named_pipe::ClientOptions;

    fn route() -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_pipe_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 3,
        }
    }

    #[tokio::test]
    async fn generated_endpoint_is_redacted_and_current_user_pipe_completes_handshake() {
        let listener = WorkerPipeListener::bind_new().expect("listener");
        let endpoint = listener.endpoint().clone();
        let debug = format!("{endpoint:?}");
        assert!(!debug.contains(endpoint.pipe_name()));
        assert!(!debug.contains(endpoint.session_nonce()));

        let worker_endpoint = endpoint.clone();
        let worker = tokio::spawn(async move {
            let mut stream = ClientOptions::new()
                .open(worker_endpoint.pipe_path())
                .expect("same-user client");
            write_frame(
                &mut stream,
                &WorkerHello {
                    ipc_v: WORKER_IPC_VERSION,
                    message_type: "worker_hello".to_owned(),
                    session_nonce: worker_endpoint.session_nonce().to_owned(),
                    worker_version: "3.0.0-alpha.1".to_owned(),
                    route: route(),
                    role: WorkerRole::Live,
                    capabilities: vec![WorkerCapability::QueryExecution],
                },
            )
            .await
            .expect("hello");
        });
        let client = listener
            .accept(
                ExpectedWorker {
                    session_nonce: endpoint.session_nonce().to_owned(),
                    route: route(),
                    role: WorkerRole::Live,
                    required_capabilities: BTreeSet::from([WorkerCapability::QueryExecution]),
                },
                Duration::from_secs(2),
            )
            .await
            .expect("accept");
        assert!(client.is_healthy());
        worker.await.expect("worker");
    }

    #[tokio::test]
    async fn endpoint_has_cryptographic_nonce_and_first_instance_cannot_be_hijacked() {
        let first = WorkerPipeListener::bind_new().expect("first listener");
        let endpoint = first.endpoint().clone();
        assert_eq!(endpoint.session_nonce().len(), NONCE_BYTES * 2);
        assert!(WorkerPipeListener::bind(endpoint).is_err());
    }
}
