use crate::{WorkerClient, WorkerHostError, WorkerRequest, WorkerResponse, WorkerRoute};
use bridge_contract::{CommandMessage, same_terminal_route};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::RwLock;

pub struct WorkerRegistry<S> {
    state: RwLock<RegistryState<S>>,
    next_generation: AtomicU64,
}

struct RegistryState<S> {
    entries: HashMap<String, WorkerSlot<S>>,
    claims: HashMap<String, SupervisorClaim>,
}

struct SupervisorClaim {
    token: u64,
    route: WorkerRoute,
}

struct WorkerSlot<S> {
    generation: u64,
    route: WorkerRoute,
    client: Arc<WorkerClient<S>>,
}

pub struct WorkerLease<S> {
    generation: u64,
    route: WorkerRoute,
    client: Arc<WorkerClient<S>>,
}

#[derive(Clone)]
pub struct WorkerClaim {
    token: u64,
    route: WorkerRoute,
}

impl<S> WorkerRegistry<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub fn new() -> Self {
        Self {
            state: RwLock::new(RegistryState {
                entries: HashMap::new(),
                claims: HashMap::new(),
            }),
            next_generation: AtomicU64::new(0),
        }
    }

    pub async fn install(
        &self,
        route: WorkerRoute,
        client: Arc<WorkerClient<S>>,
    ) -> Result<WorkerLease<S>, WorkerHostError> {
        route.validate()?;
        if !client.route().matches(&route) || !client.is_healthy() {
            return Err(WorkerHostError::new("worker_registry_client_invalid"));
        }
        let generation = self.allocate_generation()?;
        let slot = WorkerSlot {
            generation,
            route: route.clone(),
            client: Arc::clone(&client),
        };
        let mut state = self.state.write().await;
        if state.claims.contains_key(&route.terminal_instance_id) {
            return Err(WorkerHostError::new("worker_registry_claim_required"));
        }
        if let Some(previous) = state
            .entries
            .insert(route.terminal_instance_id.clone(), slot)
        {
            previous.client.invalidate();
        }
        Ok(WorkerLease {
            generation,
            route,
            client,
        })
    }

    pub async fn claim(&self, route: WorkerRoute) -> Result<WorkerClaim, WorkerHostError> {
        route.validate()?;
        let token = self.allocate_generation()?;
        let terminal_instance_id = route.terminal_instance_id.clone();
        let mut state = self.state.write().await;
        state.claims.insert(
            terminal_instance_id.clone(),
            SupervisorClaim {
                token,
                route: route.clone(),
            },
        );
        if let Some(previous) = state.entries.remove(&terminal_instance_id) {
            previous.client.invalidate();
        }
        Ok(WorkerClaim { token, route })
    }

    pub async fn install_claimed(
        &self,
        claim: &WorkerClaim,
        client: Arc<WorkerClient<S>>,
    ) -> Result<WorkerLease<S>, WorkerHostError> {
        if !client.route().matches(&claim.route) || !client.is_healthy() {
            return Err(WorkerHostError::new("worker_registry_client_invalid"));
        }
        let generation = self.allocate_generation()?;
        let mut state = self.state.write().await;
        if !claim_matches(&state.claims, claim) {
            return Err(WorkerHostError::new("worker_supervisor_superseded"));
        }
        let slot = WorkerSlot {
            generation,
            route: claim.route.clone(),
            client: Arc::clone(&client),
        };
        if let Some(previous) = state
            .entries
            .insert(claim.route.terminal_instance_id.clone(), slot)
        {
            previous.client.invalidate();
        }
        Ok(WorkerLease {
            generation,
            route: claim.route.clone(),
            client,
        })
    }

    pub async fn is_claim_current(&self, claim: &WorkerClaim) -> bool {
        claim_matches(&self.state.read().await.claims, claim)
    }

    pub async fn release_claim(&self, claim: &WorkerClaim) -> bool {
        let mut state = self.state.write().await;
        if !claim_matches(&state.claims, claim) {
            return false;
        }
        state.claims.remove(&claim.route.terminal_instance_id);
        if let Some(removed) = state.entries.remove(&claim.route.terminal_instance_id) {
            removed.client.invalidate();
        }
        true
    }

    pub async fn resolve(&self, route: &WorkerRoute) -> Result<WorkerLease<S>, WorkerHostError> {
        route.validate()?;
        let state = self.state.read().await;
        let Some(slot) = state.entries.get(&route.terminal_instance_id) else {
            return Err(WorkerHostError::new("worker_registry_not_ready"));
        };
        if !slot.route.matches(route) {
            return Err(WorkerHostError::new("worker_registry_route_mismatch"));
        }
        if !slot.client.is_healthy() {
            return Err(WorkerHostError::new("worker_registry_client_unhealthy"));
        }
        Ok(slot.lease())
    }

    pub async fn resolve_command(
        &self,
        command: &CommandMessage,
    ) -> Result<WorkerLease<S>, WorkerHostError> {
        let state = self.state.read().await;
        let Some(slot) = state.entries.get(&command.terminal_instance_id) else {
            return Err(WorkerHostError::new("worker_registry_not_ready"));
        };
        if !same_terminal_route(
            &slot.route.terminal_instance_id,
            &slot.route.account_ref,
            slot.route.connection_epoch,
            &command.terminal_instance_id,
            &command.account_ref,
            command.connection_epoch,
        ) {
            return Err(WorkerHostError::new("worker_registry_route_mismatch"));
        }
        if !slot.client.is_healthy() {
            return Err(WorkerHostError::new("worker_registry_client_unhealthy"));
        }
        Ok(slot.lease())
    }

    pub async fn remove_if_generation(&self, terminal_instance_id: &str, generation: u64) -> bool {
        let mut state = self.state.write().await;
        let should_remove = state
            .entries
            .get(terminal_instance_id)
            .is_some_and(|slot| slot.generation == generation);
        if should_remove && let Some(removed) = state.entries.remove(terminal_instance_id) {
            removed.client.invalidate();
        }
        should_remove
    }

    pub async fn remove_route(&self, route: &WorkerRoute) -> bool {
        let mut state = self.state.write().await;
        let should_remove = state
            .entries
            .get(&route.terminal_instance_id)
            .is_some_and(|slot| slot.route.matches(route));
        if should_remove && let Some(removed) = state.entries.remove(&route.terminal_instance_id) {
            removed.client.invalidate();
        }
        should_remove
    }

    pub async fn is_current(&self, route: &WorkerRoute, generation: u64) -> bool {
        self.state
            .read()
            .await
            .entries
            .get(&route.terminal_instance_id)
            .is_some_and(|slot| {
                slot.generation == generation
                    && slot.route.matches(route)
                    && slot.client.is_healthy()
            })
    }

    pub async fn len(&self) -> usize {
        self.state.read().await.entries.len()
    }

    pub async fn is_empty(&self) -> bool {
        self.state.read().await.entries.is_empty()
    }

    fn allocate_generation(&self) -> Result<u64, WorkerHostError> {
        self.next_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| WorkerHostError::new("worker_registry_generation_exhausted"))
    }
}

fn claim_matches(claims: &HashMap<String, SupervisorClaim>, claim: &WorkerClaim) -> bool {
    claims
        .get(&claim.route.terminal_instance_id)
        .is_some_and(|current| current.token == claim.token && current.route.matches(&claim.route))
}

impl<S> Default for WorkerRegistry<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn default() -> Self {
        Self::new()
    }
}

impl<S> WorkerSlot<S> {
    fn lease(&self) -> WorkerLease<S> {
        WorkerLease {
            generation: self.generation,
            route: self.route.clone(),
            client: Arc::clone(&self.client),
        }
    }
}

impl<S> WorkerLease<S> {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn route(&self) -> &WorkerRoute {
        &self.route
    }

    pub fn client(&self) -> Arc<WorkerClient<S>> {
        Arc::clone(&self.client)
    }
}

impl WorkerClaim {
    pub fn token(&self) -> u64 {
        self.token
    }

    pub fn route(&self) -> &WorkerRoute {
        &self.route
    }
}

impl<S> WorkerLease<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    pub async fn request(
        &self,
        registry: &WorkerRegistry<S>,
        request: &WorkerRequest,
        now_utc_msc: i64,
        request_timeout: Duration,
    ) -> Result<WorkerResponse, WorkerHostError> {
        if !request.route.matches(&self.route) {
            return Err(WorkerHostError::new("worker_lease_route_mismatch"));
        }
        if !registry.is_current(&self.route, self.generation).await {
            return Err(WorkerHostError::new("worker_generation_changed"));
        }
        match self
            .client
            .request(request, now_utc_msc, request_timeout)
            .await
        {
            Ok(response) => {
                if !registry.is_current(&self.route, self.generation).await {
                    return Err(WorkerHostError::new("worker_generation_changed"));
                }
                Ok(response)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ExpectedWorker, WORKER_IPC_VERSION, WorkerCapability, WorkerHello, WorkerRequest,
        WorkerResponse, WorkerRole, read_frame, write_frame,
    };
    use bridge_contract::{AccountRef, CommandMessage, CommandResultMessage, ExecutionEvidence};
    use std::collections::BTreeSet;
    use tokio::io::{DuplexStream, duplex};
    use tokio::sync::oneshot;

    const NOW: i64 = 1_700_000_000_001;

    fn route(epoch: i64) -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id: "mt5_terminal_registry_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: if epoch == 1 { "111111" } else { "222222" }.to_owned(),
            },
            connection_epoch: epoch,
        }
    }

    fn command(route: &WorkerRoute) -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JREGISTRY1".to_owned(),
            sent_at_utc_msc: NOW,
            command_id: "command_01JREGISTRY1".to_owned(),
            terminal_instance_id: route.terminal_instance_id.clone(),
            account_ref: route.account_ref.clone(),
            connection_epoch: route.connection_epoch,
            issued_at_utc_msc: NOW,
            deadline_utc_msc: NOW + 10_000,
            action: "place_order".to_owned(),
            params: serde_json::json!({
                "symbol": "XAUUSD",
                "side": "buy",
                "volume": 0.01
            }),
        }
    }

    fn result(command: &CommandMessage) -> CommandResultMessage {
        CommandResultMessage {
            v: 3,
            message_type: "command_result".to_owned(),
            message_id: "result_01JREGISTRY01".to_owned(),
            sent_at_utc_msc: NOW + 1,
            command_id: command.command_id.clone(),
            terminal_instance_id: command.terminal_instance_id.clone(),
            account_ref: command.account_ref.clone(),
            connection_epoch: command.connection_epoch,
            status: "succeeded".to_owned(),
            completed_at_utc_msc: NOW + 1,
            error_code: None,
            error_message: None,
            raw_result: Some(serde_json::json!({ "retcode": 10009 })),
            evidence: ExecutionEvidence {
                observed_at_utc_msc: NOW + 1,
                order_tickets: vec!["1001".to_owned()],
                position_tickets: Vec::new(),
                deal_tickets: Vec::new(),
                broker_retcode: Some(10009),
            },
        }
    }

    async fn client(route: WorkerRoute, nonce: &str) -> Arc<WorkerClient<DuplexStream>> {
        let (core, mut worker) = duplex(64 * 1024);
        let hello_route = route.clone();
        let nonce = nonce.to_owned();
        tokio::spawn(async move {
            write_frame(
                &mut worker,
                &WorkerHello {
                    ipc_v: WORKER_IPC_VERSION,
                    message_type: "worker_hello".to_owned(),
                    session_nonce: nonce,
                    worker_version: "3.0.0-alpha.1".to_owned(),
                    route: hello_route,
                    role: WorkerRole::Live,
                    capabilities: vec![WorkerCapability::ExecuteCommand],
                },
            )
            .await
            .expect("hello");
        });
        Arc::new(
            WorkerClient::handshake(
                core,
                ExpectedWorker {
                    session_nonce: nonce_for(route.connection_epoch),
                    route,
                    role: WorkerRole::Live,
                    required_capabilities: BTreeSet::from([WorkerCapability::ExecuteCommand]),
                },
                Duration::from_secs(1),
            )
            .await
            .expect("handshake"),
        )
    }

    fn nonce_for(epoch: i64) -> String {
        format!("{epoch:032}")
    }

    #[tokio::test]
    async fn account_switch_replaces_atomically_and_old_generation_cannot_remove_new() {
        let registry = WorkerRegistry::new();
        let old_route = route(1);
        let old_client = client(old_route.clone(), &nonce_for(1)).await;
        let old = registry
            .install(old_route.clone(), Arc::clone(&old_client))
            .await
            .expect("old install");

        let new_route = route(2);
        let new = registry
            .install(
                new_route.clone(),
                client(new_route.clone(), &nonce_for(2)).await,
            )
            .await
            .expect("new install");
        assert!(!old_client.is_healthy());
        assert_eq!(
            registry
                .resolve(&old_route)
                .await
                .err()
                .expect("old route")
                .code(),
            "worker_registry_route_mismatch"
        );
        assert_eq!(
            registry
                .resolve(&new_route)
                .await
                .expect("new")
                .generation(),
            new.generation()
        );
        assert!(
            !registry
                .remove_if_generation(&old_route.terminal_instance_id, old.generation())
                .await
        );
        assert!(registry.is_current(&new_route, new.generation()).await);
        assert!(
            registry
                .remove_if_generation(&new_route.terminal_instance_id, new.generation())
                .await
        );
        assert!(registry.is_empty().await);
    }

    #[tokio::test]
    async fn replacement_during_an_inflight_request_is_never_reported_as_success() {
        let registry = Arc::new(WorkerRegistry::new());
        let active_route = route(1);
        let nonce = nonce_for(1);
        let (core, mut worker) = duplex(64 * 1024);
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let hello_route = active_route.clone();
        let worker_task = tokio::spawn(async move {
            write_frame(
                &mut worker,
                &WorkerHello {
                    ipc_v: WORKER_IPC_VERSION,
                    message_type: "worker_hello".to_owned(),
                    session_nonce: nonce,
                    worker_version: "3.0.0-alpha.1".to_owned(),
                    route: hello_route,
                    role: WorkerRole::Live,
                    capabilities: vec![WorkerCapability::ExecuteCommand],
                },
            )
            .await
            .expect("hello");
            let request: WorkerRequest = read_frame(&mut worker).await.expect("request");
            request_seen_tx.send(()).expect("request seen");
            release_rx.await.expect("release response");
            let command = request
                .operation
                .command()
                .expect("command operation")
                .clone();
            write_frame(
                &mut worker,
                &WorkerResponse::command_result(&request, result(&command)),
            )
            .await
            .expect("response");
        });
        let first_client = Arc::new(
            WorkerClient::handshake(
                core,
                ExpectedWorker {
                    session_nonce: nonce_for(1),
                    route: active_route.clone(),
                    role: WorkerRole::Live,
                    required_capabilities: BTreeSet::from([WorkerCapability::ExecuteCommand]),
                },
                Duration::from_secs(1),
            )
            .await
            .expect("handshake"),
        );
        let lease = registry
            .install(active_route.clone(), first_client)
            .await
            .expect("install");
        let request = WorkerRequest::from_command(active_route.clone(), command(&active_route))
            .expect("request");
        let request_registry = Arc::clone(&registry);
        let request_task = tokio::spawn(async move {
            lease
                .request(&request_registry, &request, NOW, Duration::from_secs(2))
                .await
        });
        request_seen_rx.await.expect("request observed");
        registry
            .install(
                active_route.clone(),
                client(active_route.clone(), &nonce_for(1)).await,
            )
            .await
            .expect("replacement");
        release_tx.send(()).expect("release");
        assert_eq!(
            request_task
                .await
                .expect("request task")
                .expect_err("generation changed")
                .code(),
            "worker_generation_changed"
        );
        worker_task.await.expect("worker");
    }

    #[tokio::test]
    async fn replacement_after_an_inflight_client_error_preserves_the_original_error() {
        let registry = Arc::new(WorkerRegistry::new());
        let active_route = route(1);
        let nonce = nonce_for(1);
        let (core, mut worker) = duplex(64 * 1024);
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let hello_route = active_route.clone();
        let worker_task = tokio::spawn(async move {
            write_frame(
                &mut worker,
                &WorkerHello {
                    ipc_v: WORKER_IPC_VERSION,
                    message_type: "worker_hello".to_owned(),
                    session_nonce: nonce,
                    worker_version: "3.0.0-alpha.1".to_owned(),
                    route: hello_route,
                    role: WorkerRole::Live,
                    capabilities: vec![WorkerCapability::ExecuteCommand],
                },
            )
            .await
            .expect("hello");
            let _request: WorkerRequest = read_frame(&mut worker).await.expect("request");
            request_seen_tx.send(()).expect("request seen");
            release_rx.await.expect("release request error");
            // Dropping the worker side makes the in-flight client exchange fail
            // with worker_pipe_closed without relying on a timer.
        });
        let first_client = Arc::new(
            WorkerClient::handshake(
                core,
                ExpectedWorker {
                    session_nonce: nonce_for(1),
                    route: active_route.clone(),
                    role: WorkerRole::Live,
                    required_capabilities: BTreeSet::from([WorkerCapability::ExecuteCommand]),
                },
                Duration::from_secs(1),
            )
            .await
            .expect("handshake"),
        );
        let lease = registry
            .install(active_route.clone(), first_client)
            .await
            .expect("install");
        let request = WorkerRequest::from_command(active_route.clone(), command(&active_route))
            .expect("request");
        let request_registry = Arc::clone(&registry);
        let request_task = tokio::spawn(async move {
            lease
                .request(&request_registry, &request, NOW, Duration::from_secs(2))
                .await
        });
        request_seen_rx.await.expect("request observed");
        registry
            .install(
                active_route.clone(),
                client(active_route.clone(), &nonce_for(1)).await,
            )
            .await
            .expect("replacement");
        release_tx.send(()).expect("release");
        assert_eq!(
            request_task
                .await
                .expect("request task")
                .expect_err("client error")
                .code(),
            "worker_pipe_closed"
        );
        worker_task.await.expect("worker");
    }
}
