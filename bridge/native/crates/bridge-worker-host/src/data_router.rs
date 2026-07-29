use crate::{
    SnapshotStream, TerminalQuote, TerminalSnapshot, WorkerHostError, WorkerRegistry,
    WorkerRequest, WorkerResponseBody, WorkerRoute,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

pub struct WorkerDataRouter<S> {
    registry: Arc<WorkerRegistry<S>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    request_timeout: Duration,
}

impl<S> WorkerDataRouter<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub fn new(
        registry: Arc<WorkerRegistry<S>>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        request_timeout: Duration,
    ) -> Result<Self, WorkerHostError> {
        if request_timeout.is_zero() {
            return Err(WorkerHostError::new("worker_request_timeout_invalid"));
        }
        Ok(Self {
            registry,
            clock,
            request_timeout,
        })
    }

    pub async fn collect_snapshot(
        &self,
        route: WorkerRoute,
        request_id: String,
        streams: Vec<SnapshotStream>,
    ) -> Result<TerminalSnapshot, WorkerHostError> {
        let request = WorkerRequest::collect_snapshot(route.clone(), request_id, streams);
        match self.request(route, request).await?.body {
            WorkerResponseBody::Snapshot { snapshot } => Ok(*snapshot),
            WorkerResponseBody::Error { error_code, .. } => Err(WorkerHostError::new(error_code)),
            _ => Err(WorkerHostError::new("worker_response_operation_mismatch")),
        }
    }

    pub async fn quote(
        &self,
        route: WorkerRoute,
        request_id: String,
        symbol: String,
    ) -> Result<TerminalQuote, WorkerHostError> {
        let request = WorkerRequest::quote(route.clone(), request_id, symbol);
        match self.request(route, request).await?.body {
            WorkerResponseBody::Quote { quote } => Ok(quote),
            WorkerResponseBody::Error { error_code, .. } => Err(WorkerHostError::new(error_code)),
            _ => Err(WorkerHostError::new("worker_response_operation_mismatch")),
        }
    }

    async fn request(
        &self,
        route: WorkerRoute,
        request: WorkerRequest,
    ) -> Result<crate::WorkerResponse, WorkerHostError> {
        let now_utc_msc = (self.clock)();
        if now_utc_msc <= 0 {
            return Err(WorkerHostError::new("worker_clock_invalid"));
        }
        let lease = self.registry.resolve(&route).await?;
        lease
            .request(&self.registry, &request, now_utc_msc, self.request_timeout)
            .await
    }
}
