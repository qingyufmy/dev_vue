mod client;
mod command_adapter;
mod contract;
mod frame;

pub use client::{ExpectedWorker, WorkerClient};
pub use command_adapter::IpcCommandWorker;
pub use contract::{
    WORKER_IPC_VERSION, WorkerCapability, WorkerHello, WorkerOperation, WorkerRequest,
    WorkerResponse, WorkerResponseBody, WorkerRoute,
};
pub use frame::{MAX_WORKER_FRAME_BYTES, read_frame, write_frame};

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
