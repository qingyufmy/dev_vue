use crate::{
    CollectionStreams, EaConnection, EaIdentity, EaPipeListener, Mt4ProtocolError,
    REGISTRATION_PIPE_NAME, Welcome, reconnect_pipe_name,
};
use bridge_terminal_data::SnapshotSource;
use bridge_worker_host::{
    SnapshotStream, SnapshotStreams, TerminalSnapshot, WorkerHostError, WorkerRoute,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{Mutex, mpsc, watch};

struct RegistrationRoute {
    identity: EaIdentity,
    sender: mpsc::Sender<EaConnection>,
}

pub struct EaRegistrationHub {
    pipe_name: String,
    listener: EaPipeListener,
    routes: Arc<StdMutex<Vec<RegistrationRoute>>>,
    stop_rx: watch::Receiver<bool>,
    request_timeout: Duration,
}

#[derive(Clone)]
pub struct EaRegistrationHubHandle {
    routes: Arc<StdMutex<Vec<RegistrationRoute>>>,
    stop_tx: watch::Sender<bool>,
}

impl EaRegistrationHub {
    pub fn bind(
        request_timeout: Duration,
    ) -> Result<(Self, EaRegistrationHubHandle), Mt4ProtocolError> {
        Self::bind_named(REGISTRATION_PIPE_NAME, request_timeout)
    }

    fn bind_named(
        pipe_name: &str,
        request_timeout: Duration,
    ) -> Result<(Self, EaRegistrationHubHandle), Mt4ProtocolError> {
        if request_timeout.is_zero() {
            return Err(Mt4ProtocolError::new("mt4_ea_timeout_invalid"));
        }
        let listener = EaPipeListener::bind_first(pipe_name)?;
        let routes = Arc::new(StdMutex::new(Vec::new()));
        let (stop_tx, stop_rx) = watch::channel(false);
        Ok((
            Self {
                pipe_name: pipe_name.to_owned(),
                listener,
                routes: Arc::clone(&routes),
                stop_rx,
                request_timeout,
            },
            EaRegistrationHubHandle { routes, stop_tx },
        ))
    }

    pub async fn run(self) {
        let EaRegistrationHub {
            pipe_name,
            mut listener,
            routes,
            mut stop_rx,
            request_timeout,
        } = self;
        loop {
            let accepted = tokio::select! {
                changed = stop_rx.changed() => {
                    let _ = changed;
                    break;
                }
                accepted = listener.accept_unverified(
                    Duration::from_secs(24 * 60 * 60),
                    request_timeout,
                ) => accepted,
            };
            let next_listener = EaPipeListener::bind_additional(&pipe_name);
            if let Ok(connection) = accepted {
                let destination = routes.lock().ok().and_then(|routes| {
                    routes
                        .iter()
                        .find(|route| route.identity.validate(connection.hello()).is_ok())
                        .map(|route| route.sender.clone())
                });
                if let Some(destination) = destination {
                    let _ = destination.try_send(connection);
                }
            }
            match next_listener {
                Ok(next) => listener = next,
                Err(_) => break,
            }
        }
    }
}

impl EaRegistrationHubHandle {
    pub fn subscribe(
        &self,
        identity: EaIdentity,
    ) -> Result<mpsc::Receiver<EaConnection>, Mt4ProtocolError> {
        let (sender, receiver) = mpsc::channel(1);
        let mut routes = self
            .routes
            .lock()
            .map_err(|_| Mt4ProtocolError::new("mt4_registration_state_failed"))?;
        if routes
            .iter()
            .any(|route| route.identity.equivalent(&identity))
        {
            return Err(Mt4ProtocolError::new("mt4_registration_identity_duplicate"));
        }
        routes.push(RegistrationRoute { identity, sender });
        Ok(receiver)
    }

    pub fn stop(&self) {
        self.stop_tx.send_replace(true);
    }
}

pub struct Mt4SnapshotSourceSpec {
    pub route: WorkerRoute,
    pub terminal_data_path: std::path::PathBuf,
    pub accept_timeout: Duration,
    pub request_timeout: Duration,
}

impl Mt4SnapshotSourceSpec {
    fn validate(&self) -> Result<EaIdentity, Mt4ProtocolError> {
        self.route
            .validate()
            .map_err(|_| Mt4ProtocolError::new("mt4_session_spec_invalid"))?;
        if self.route.platform != "mt4"
            || self.accept_timeout.is_zero()
            || self.request_timeout.is_zero()
        {
            return Err(Mt4ProtocolError::new("mt4_session_spec_invalid"));
        }
        EaIdentity::new(
            &self.terminal_data_path,
            self.route.account_ref.broker_server.clone(),
            self.route.account_ref.login.clone(),
        )
    }
}

pub struct Mt4EaSnapshotSource {
    route: WorkerRoute,
    identity: EaIdentity,
    welcome: Welcome,
    registration_rx: Mutex<mpsc::Receiver<EaConnection>>,
    connection: Mutex<Option<EaConnection>>,
    accept_timeout: Duration,
    request_timeout: Duration,
    stop_tx: watch::Sender<bool>,
}

impl Mt4EaSnapshotSource {
    pub fn new(
        spec: Mt4SnapshotSourceSpec,
        registration_rx: mpsc::Receiver<EaConnection>,
    ) -> Result<Self, Mt4ProtocolError> {
        let identity = spec.validate()?;
        let reconnect_pipe_name = reconnect_pipe_name(&spec.route.terminal_instance_id)?;
        let welcome = Welcome {
            terminal_instance_id: spec.route.terminal_instance_id.clone(),
            connection_epoch: spec.route.connection_epoch,
            reconnect_pipe_name,
        };
        let (stop_tx, _) = watch::channel(false);
        Ok(Self {
            route: spec.route,
            identity,
            welcome,
            registration_rx: Mutex::new(registration_rx),
            connection: Mutex::new(None),
            accept_timeout: spec.accept_timeout,
            request_timeout: spec.request_timeout,
            stop_tx,
        })
    }

    pub fn route(&self) -> &WorkerRoute {
        &self.route
    }

    pub fn request_stop(&self) {
        self.stop_tx.send_replace(true);
    }

    pub async fn close(&self) {
        self.request_stop();
        if let Some(connection) = self.connection.lock().await.take() {
            let _ = connection.close().await;
        }
    }

    async fn collect(
        &self,
        streams: Vec<SnapshotStream>,
    ) -> Result<TerminalSnapshot, Mt4ProtocolError> {
        let requested = collection_streams(&streams)?;
        let mut active = self.connection.lock().await;
        if active.is_none() {
            *active = Some(self.connect().await?);
        }
        let result = active
            .as_mut()
            .ok_or_else(|| Mt4ProtocolError::new("mt4_ea_not_ready"))?
            .collect(requested)
            .await;
        match result {
            Ok(snapshot) => Ok(TerminalSnapshot {
                source_time_msc: snapshot.source_time_msc,
                streams: SnapshotStreams {
                    account: streams
                        .contains(&SnapshotStream::Account)
                        .then_some(snapshot.account),
                    positions: streams
                        .contains(&SnapshotStream::Positions)
                        .then_some(snapshot.positions),
                    orders: streams
                        .contains(&SnapshotStream::Orders)
                        .then_some(snapshot.orders),
                },
            }),
            Err(error) => {
                active.take();
                Err(error)
            }
        }
    }

    async fn connect(&self) -> Result<EaConnection, Mt4ProtocolError> {
        if *self.stop_tx.borrow() {
            return Err(Mt4ProtocolError::new("mt4_session_stopped"));
        }
        let listener = EaPipeListener::bind_first(&self.welcome.reconnect_pipe_name)?;
        let mut registration_rx = self.registration_rx.lock().await;
        let mut stop_rx = self.stop_tx.subscribe();
        if registration_rx.is_closed() {
            let mut connection = listener
                .accept(&self.identity, self.accept_timeout, self.request_timeout)
                .await?;
            connection.send_welcome(&self.welcome).await?;
            return Ok(connection);
        }
        let connection = tokio::select! {
            biased;
            _ = stop_rx.changed() => return Err(Mt4ProtocolError::new("mt4_session_stopped")),
            initial = registration_rx.recv() => initial
                .ok_or_else(|| Mt4ProtocolError::new("mt4_registration_stopped"))?,
            dedicated = listener.accept(
                &self.identity,
                self.accept_timeout,
                self.request_timeout,
            ) => dedicated?,
        };
        connection.verify_identity(&self.identity)?;
        let mut connection = connection;
        connection.send_welcome(&self.welcome).await?;
        Ok(connection)
    }
}

impl SnapshotSource for Mt4EaSnapshotSource {
    fn collect_snapshot<'a>(
        &'a self,
        route: WorkerRoute,
        _request_id: String,
        streams: Vec<SnapshotStream>,
    ) -> Pin<Box<dyn Future<Output = Result<TerminalSnapshot, WorkerHostError>> + Send + 'a>> {
        Box::pin(async move {
            if !self.route.matches(&route) {
                return Err(WorkerHostError::new("bridge_message_route_mismatch"));
            }
            self.collect(streams)
                .await
                .map_err(|error| WorkerHostError::new(error.code()))
        })
    }
}

fn collection_streams(streams: &[SnapshotStream]) -> Result<CollectionStreams, Mt4ProtocolError> {
    let mut bits = 0;
    for stream in streams {
        bits |= match stream {
            SnapshotStream::Account => CollectionStreams::ACCOUNT.bits(),
            SnapshotStream::Positions => CollectionStreams::POSITIONS.bits(),
            SnapshotStream::Orders => CollectionStreams::ORDERS.bits(),
        };
    }
    CollectionStreams::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CURRENT_PROTOCOL_VERSION, Hello, Snapshot, decode_collect, decode_welcome, encode_hello,
        encode_snapshot, read_frame, write_frame,
    };
    use bridge_terminal_data::SnapshotSource;
    use bridge_worker_host::WorkerRoute;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    fn unique_value(label: &str) -> String {
        format!(
            "{label}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        )
    }

    async fn open_when_ready(path: &str) -> NamedPipeClient {
        for _ in 0..100 {
            match ClientOptions::new().open(path) {
                Ok(client) => return client,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        panic!("pipe did not become ready: {path}");
    }

    fn hello(path: &std::path::Path) -> Hello {
        Hello {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            adapter_version: "3.2.4-test".to_owned(),
            terminal_data_path: path.to_string_lossy().into_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: "12345678".to_owned(),
            connected: true,
            trade_allowed: true,
        }
    }

    fn route(terminal_instance_id: String) -> WorkerRoute {
        WorkerRoute {
            terminal_instance_id,
            platform: "mt4".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 7,
        }
    }

    fn snapshot(balance: i64) -> Snapshot {
        Snapshot {
            source_time_msc: 1_800_000_000_000 + balance,
            account: serde_json::json!({
                "login": 12345678,
                "server": "Broker-Demo",
                "balance": balance
            }),
            positions: vec![serde_json::json!({ "ticket": "91", "symbol": "XAUUSD" })],
            orders: Vec::new(),
        }
    }

    async fn serve_one_snapshot(
        pipe_path: String,
        hello: Hello,
        expected_terminal_id: String,
        snapshot: Snapshot,
    ) {
        let mut pipe = open_when_ready(&pipe_path).await;
        write_frame(&mut pipe, &encode_hello(&hello).expect("hello"))
            .await
            .expect("write hello");
        let welcome =
            decode_welcome(&read_frame(&mut pipe).await.expect("welcome frame")).expect("welcome");
        assert_eq!(welcome.terminal_instance_id, expected_terminal_id);
        assert_eq!(welcome.connection_epoch, 7);
        assert_eq!(
            decode_collect(&read_frame(&mut pipe).await.expect("collect frame")).expect("collect"),
            CollectionStreams::ALL
        );
        write_frame(&mut pipe, &encode_snapshot(&snapshot).expect("snapshot"))
            .await
            .expect("write snapshot");
    }

    #[tokio::test]
    async fn registration_connection_falls_forward_to_the_dedicated_reconnect_pipe() {
        let registration_name = unique_value("liangjian_mt4_registration");
        let (hub, hub_handle) =
            EaRegistrationHub::bind_named(&registration_name, Duration::from_secs(1)).expect("hub");
        let data_path = std::env::temp_dir().join(unique_value("LiangjianMt4Session"));
        let identity = EaIdentity::new(&data_path, "Broker-Demo", "12345678").expect("identity");
        let registration_rx = hub_handle.subscribe(identity).expect("subscribe");
        let duplicate =
            EaIdentity::new(&data_path, "broker-demo", "12345678").expect("equivalent identity");
        assert_eq!(
            hub_handle
                .subscribe(duplicate)
                .expect_err("equivalent route must be unique")
                .code(),
            "mt4_registration_identity_duplicate"
        );
        let terminal_id = format!("mt4_{:024x}", std::process::id());
        let route = route(terminal_id.clone());
        let source = Arc::new(
            Mt4EaSnapshotSource::new(
                Mt4SnapshotSourceSpec {
                    route: route.clone(),
                    terminal_data_path: data_path.clone(),
                    accept_timeout: Duration::from_secs(2),
                    request_timeout: Duration::from_secs(1),
                },
                registration_rx,
            )
            .expect("source"),
        );
        let hub_task = tokio::spawn(hub.run());

        let first_client = tokio::spawn(serve_one_snapshot(
            format!(r"\\.\pipe\{registration_name}"),
            hello(&data_path),
            terminal_id.clone(),
            snapshot(10_000),
        ));
        let streams = vec![
            SnapshotStream::Account,
            SnapshotStream::Positions,
            SnapshotStream::Orders,
        ];
        let first = source
            .collect_snapshot(route.clone(), "snapshot_first".to_owned(), streams.clone())
            .await
            .expect("first snapshot");
        assert_eq!(first.streams.account.expect("account")["balance"], 10_000);
        first_client.await.expect("first client");

        assert!(
            source
                .collect_snapshot(
                    route.clone(),
                    "snapshot_disconnect".to_owned(),
                    streams.clone(),
                )
                .await
                .is_err()
        );

        let reconnect_name = reconnect_pipe_name(&terminal_id).expect("reconnect pipe");
        let reconnect_client = tokio::spawn(serve_one_snapshot(
            format!(r"\\.\pipe\{reconnect_name}"),
            hello(&data_path),
            terminal_id,
            snapshot(10_100),
        ));
        let second = source
            .collect_snapshot(route, "snapshot_second".to_owned(), streams)
            .await
            .expect("reconnected snapshot");
        assert_eq!(second.streams.account.expect("account")["balance"], 10_100);
        reconnect_client.await.expect("reconnect client");

        source.close().await;
        hub_handle.stop();
        hub_task.await.expect("hub task");
    }
}
