mod client;
mod command_adapter;
mod contract;
mod frame;
mod process_session;
mod windows_pipe;

pub use client::{ExpectedWorker, WorkerClient};
pub use command_adapter::IpcCommandWorker;
pub use contract::{
    WORKER_IPC_VERSION, WorkerCapability, WorkerHello, WorkerOperation, WorkerRequest,
    WorkerResponse, WorkerResponseBody, WorkerRoute,
};
pub use frame::{MAX_WORKER_FRAME_BYTES, read_frame, write_frame};
pub use process_session::{
    WORKER_BROKER_SERVER_ENV, WORKER_CONNECTION_EPOCH_ENV, WORKER_IPC_VERSION_ENV,
    WORKER_LOGIN_ENV, WORKER_NONCE_ENV, WORKER_PIPE_ENV, WORKER_PLATFORM_ENV,
    WORKER_TERMINAL_ID_ENV, WorkerProcessSession, WorkerProgram,
};
pub use windows_pipe::{WorkerEndpoint, WorkerPipeListener};

use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerHostError {
    code: String,
}

impl WorkerHostError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl Display for WorkerHostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl Error for WorkerHostError {}
