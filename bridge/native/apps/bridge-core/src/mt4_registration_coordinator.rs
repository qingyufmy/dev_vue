use std::path::{Path, PathBuf};
use std::time::Duration;

use bridge_contract::AccountRef;
use bridge_foundation::{DEFAULT_PROFILE_ID, list_observer_profiles, resolve_profile_paths};
use bridge_mt4::{
    CURRENT_PROTOCOL_VERSION, EaConnection, EaPipeListener, REGISTRATION_PIPE_NAME, Welcome,
    reconnect_pipe_name,
};
use bridge_observability::BridgeLogger;
use bridge_preferences::BridgePreferencesStore;
use bridge_store::OutboxStore;
use bridge_transport::SessionCancellation;
use tokio::sync::mpsc;

use crate::mt4_terminal_discovery::{
    account_terminal_instance_id, installation_terminal_instance_id, paths_equal,
};

const REGISTRATION_ACCEPT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const REGISTRATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const REGISTRATION_RETRY_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Mt4RegistrationEvent {
    pub profile_id: String,
    pub terminal_instance_id: String,
}

pub(crate) async fn run(
    root_data_directory: PathBuf,
    event_sender: mpsc::Sender<Mt4RegistrationEvent>,
    stop: SessionCancellation,
    logger: BridgeLogger,
) {
    run_named(
        REGISTRATION_PIPE_NAME,
        root_data_directory,
        event_sender,
        stop,
        logger,
    )
    .await;
}

async fn run_named(
    pipe_name: &str,
    root_data_directory: PathBuf,
    event_sender: mpsc::Sender<Mt4RegistrationEvent>,
    stop: SessionCancellation,
    logger: BridgeLogger,
) {
    let mut bind_failure_reported = false;
    loop {
        if stop.is_cancelled() {
            return;
        }
        let mut listener = match EaPipeListener::bind_first(pipe_name) {
            Ok(listener) => {
                bind_failure_reported = false;
                logger.info("native_mt4_registration_listener_ready", None);
                listener
            }
            Err(error) => {
                if !bind_failure_reported {
                    logger.warning(
                        "native_mt4_registration_listener_retrying",
                        Some(error.code()),
                    );
                    bind_failure_reported = true;
                }
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = tokio::time::sleep(REGISTRATION_RETRY_DELAY) => continue,
                }
            }
        };
        loop {
            let accepted = tokio::select! {
                _ = stop.cancelled() => return,
                accepted = listener.accept_unverified(
                    REGISTRATION_ACCEPT_TIMEOUT,
                    REGISTRATION_REQUEST_TIMEOUT,
                ) => accepted,
            };
            let next = EaPipeListener::bind_additional(pipe_name);
            match accepted {
                Ok(connection) => {
                    if let Err(code) = handle_registration(
                        &root_data_directory,
                        connection,
                        &event_sender,
                        &logger,
                    )
                    .await
                    {
                        logger.warning("native_mt4_registration_rejected", Some(code));
                    }
                }
                Err(error) if error.code() != "mt4_ea_accept_timeout" => {
                    logger.warning("native_mt4_registration_accept_failed", Some(error.code()))
                }
                Err(_) => {}
            }
            match next {
                Ok(next) => listener = next,
                Err(error) => {
                    logger.warning(
                        "native_mt4_registration_listener_recovering",
                        Some(error.code()),
                    );
                    break;
                }
            }
        }
    }
}

async fn handle_registration(
    root_data_directory: &Path,
    mut connection: EaConnection,
    event_sender: &mpsc::Sender<Mt4RegistrationEvent>,
    logger: &BridgeLogger,
) -> Result<(), &'static str> {
    let hello = connection.hello();
    hello.validate().map_err(|error| error.code())?;
    if hello.protocol_version != CURRENT_PROTOCOL_VERSION {
        return Err("mt4_ea_protocol_incompatible");
    }
    if !hello.connected {
        return Err("mt4_registration_invalid");
    }
    let terminal_data_path = std::path::absolute(Path::new(&hello.terminal_data_path))
        .map_err(|_| "mt4_registration_invalid")?;
    if !terminal_data_path.join("MQL4").is_dir() {
        return Err("mt4_terminal_data_path_not_found");
    }
    let account_ref = AccountRef {
        broker_server: hello.broker_server.trim().to_owned(),
        login: hello.login.trim().to_owned(),
    };
    account_ref
        .validate()
        .map_err(|_| "mt4_registration_invalid")?;
    let profile_id = select_target_profile(root_data_directory, &terminal_data_path)?;
    let terminal_instance_id = account_terminal_instance_id(
        &terminal_data_path,
        &account_ref.broker_server,
        &account_ref.login,
    )?;
    let paths = resolve_profile_paths(root_data_directory, &profile_id)?;
    let store = OutboxStore::open_or_create(&paths.database_path).map_err(|error| error.code())?;
    let binding = store
        .activate_terminal_binding_for_path(
            &terminal_instance_id,
            "mt4",
            &terminal_data_path,
            &account_ref,
            now_utc_msc(),
        )
        .map_err(|error| error.code())?;
    event_sender
        .send(Mt4RegistrationEvent {
            profile_id: profile_id.clone(),
            terminal_instance_id: terminal_instance_id.clone(),
        })
        .await
        .map_err(|_| "mt4_registration_event_closed")?;
    connection
        .send_welcome(&Welcome {
            terminal_instance_id: terminal_instance_id.clone(),
            connection_epoch: binding.connection_epoch,
            reconnect_pipe_name: reconnect_pipe_name(&terminal_instance_id)
                .map_err(|error| error.code())?,
        })
        .await
        .map_err(|error| error.code())?;
    logger.info(
        "native_mt4_registration_provisioned",
        Some(&format!(
            "profile={profile_id};terminal_id={terminal_instance_id}"
        )),
    );
    Ok(())
}

fn select_target_profile(
    root_data_directory: &Path,
    terminal_data_path: &Path,
) -> Result<String, &'static str> {
    let mut observer_match = None;
    for profile_id in list_observer_profiles(root_data_directory)? {
        let paths = resolve_profile_paths(root_data_directory, &profile_id)?;
        let preferences =
            BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
                .map_err(|error| error.code())?
                .load();
        if preferences.platform.as_deref() != Some("mt4")
            || !preferences
                .mt4_terminal_path
                .as_deref()
                .is_some_and(|path| paths_equal(Path::new(path), terminal_data_path))
        {
            continue;
        }
        if !preferences.observer_enabled {
            return Err("mt4_registration_profile_paused");
        }
        if observer_match.replace(profile_id).is_some() {
            return Err("mt4_registration_route_ambiguous");
        }
    }
    if let Some(profile_id) = observer_match {
        return Ok(profile_id);
    }

    let paths = resolve_profile_paths(root_data_directory, DEFAULT_PROFILE_ID)?;
    let preferences = BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
        .map_err(|error| error.code())?
        .load();
    if preferences.platform.as_deref() != Some("mt4") {
        return Err("mt4_registration_route_unavailable");
    }
    let store = OutboxStore::open_or_create(&paths.database_path).map_err(|error| error.code())?;
    let bindings = store.terminal_bindings().map_err(|error| error.code())?;
    if bindings.iter().any(|binding| {
        binding.platform == "mt4" && paths_equal(&binding.terminal_path, terminal_data_path)
    }) {
        return Ok(DEFAULT_PROFILE_ID.to_owned());
    }
    if bindings.iter().any(|binding| binding.platform == "mt4") {
        return Err("mt4_registration_route_unavailable");
    }
    if let Some(path) = preferences.mt4_terminal_path.as_deref() {
        return paths_equal(Path::new(path), terminal_data_path)
            .then(|| DEFAULT_PROFILE_ID.to_owned())
            .ok_or("mt4_registration_route_unavailable");
    }
    if let Some(selected) = preferences.mt4_terminal_instance_id.as_deref() {
        return (installation_terminal_instance_id(terminal_data_path)? == selected)
            .then(|| DEFAULT_PROFILE_ID.to_owned())
            .ok_or("mt4_registration_route_unavailable");
    }
    Ok(DEFAULT_PROFILE_ID.to_owned())
}

fn now_utc_msc() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_foundation::resolve_profile_paths;
    use bridge_mt4::{
        CURRENT_ADAPTER_VERSION, Hello, decode_welcome, encode_hello, read_frame, write_frame,
    };
    use bridge_preferences::ObserverProfilePreferences;
    use tokio::net::windows::named_pipe::ClientOptions;

    fn fixture_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "liangjian-mt4-registration-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn configure_default(root: &Path) {
        let paths = resolve_profile_paths(root, DEFAULT_PROFILE_ID).expect("default paths");
        BridgePreferencesStore::new(paths.data_directory.join("preferences.json"))
            .expect("default preferences")
            .save_platform("mt4")
            .expect("default platform");
    }

    #[test]
    fn observer_path_is_reserved_before_the_unconfigured_default_profile() {
        let root = fixture_directory("observer-route");
        let terminal = root.join("Observer MT4");
        std::fs::create_dir_all(terminal.join("MQL4")).expect("observer MQL4");
        configure_default(&root);
        let observer_paths = resolve_profile_paths(&root, "source-a").expect("observer paths");
        let observer_store =
            BridgePreferencesStore::new(observer_paths.data_directory.join("preferences.json"))
                .expect("observer preferences");
        observer_store
            .save_observer_profile(&ObserverProfilePreferences {
                platform: "mt4".to_owned(),
                terminal_instance_id: crate::mt4_terminal_discovery::terminal_instance_id(
                    &terminal, "device-a", None,
                )
                .expect("fixture terminal ID"),
                terminal_path: std::path::absolute(&terminal)
                    .unwrap()
                    .display()
                    .to_string(),
                bridge_user_id: 7,
                observer_account_label: Some("一号观摩源".to_owned()),
                trading_account_id: None,
                trading_account_label: None,
            })
            .expect("save observer profile");
        assert_eq!(
            select_target_profile(&root, &terminal).expect("observer route"),
            "source-a"
        );
        observer_store
            .save_observer_enabled(false)
            .expect("pause observer");
        assert_eq!(
            select_target_profile(&root, &terminal),
            Err("mt4_registration_profile_paused")
        );
        std::fs::remove_dir_all(root).expect("remove observer route fixture");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fresh_registration_persists_binding_and_returns_dedicated_route() {
        let root = fixture_directory("fresh-profile");
        let terminal = root.join("Primary MT4");
        std::fs::create_dir_all(terminal.join("MQL4")).expect("primary MQL4");
        configure_default(&root);
        let logger = BridgeLogger::new(
            bridge_observability::LoggerConfig::new(root.join("logs")).expect("logger config"),
        );
        let pipe_name = format!(
            "liangjian_mt4_registration_{}_{}",
            std::process::id(),
            now_utc_msc()
        );
        let (event_sender, mut event_receiver) = mpsc::channel(4);
        let stop = SessionCancellation::default();
        let runner_pipe_name = pipe_name.clone();
        let runner_root = root.clone();
        let runner_stop = stop.clone();
        let runner = tokio::spawn(async move {
            run_named(
                &runner_pipe_name,
                runner_root,
                event_sender,
                runner_stop,
                logger,
            )
            .await;
        });
        let pipe_path = format!(r"\\.\pipe\{pipe_name}");
        let mut client = loop {
            match ClientOptions::new().open(&pipe_path) {
                Ok(client) => break client,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        let hello = Hello {
            protocol_version: CURRENT_PROTOCOL_VERSION,
            adapter_version: CURRENT_ADAPTER_VERSION.to_owned(),
            terminal_data_path: std::path::absolute(&terminal)
                .unwrap()
                .display()
                .to_string(),
            broker_server: "Broker-Demo".to_owned(),
            login: "12345678".to_owned(),
            connected: true,
            trade_allowed: true,
        };
        write_frame(&mut client, &encode_hello(&hello).expect("encode hello"))
            .await
            .expect("send hello");
        let welcome = decode_welcome(&read_frame(&mut client).await.expect("welcome frame"))
            .expect("decode welcome");
        let event = tokio::time::timeout(Duration::from_secs(2), event_receiver.recv())
            .await
            .expect("registration event timeout")
            .expect("registration event");
        assert_eq!(event.profile_id, DEFAULT_PROFILE_ID);
        assert_eq!(event.terminal_instance_id, welcome.terminal_instance_id);
        assert_eq!(welcome.connection_epoch, 1);
        assert_eq!(
            welcome.reconnect_pipe_name,
            reconnect_pipe_name(&welcome.terminal_instance_id).expect("reconnect pipe")
        );
        let paths = resolve_profile_paths(&root, DEFAULT_PROFILE_ID).expect("default paths");
        let bindings = OutboxStore::open_or_create(paths.database_path)
            .expect("default store")
            .terminal_bindings()
            .expect("default bindings");
        assert_eq!(bindings.len(), 1);
        assert_eq!(
            bindings[0].terminal_instance_id,
            welcome.terminal_instance_id
        );
        assert_eq!(bindings[0].account_ref.login, "12345678");

        drop(client);
        let mut switched_client = loop {
            match ClientOptions::new().open(&pipe_path) {
                Ok(client) => break client,
                Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        };
        let switched_hello = Hello {
            login: "87654321".to_owned(),
            ..hello
        };
        write_frame(
            &mut switched_client,
            &encode_hello(&switched_hello).expect("encode switched hello"),
        )
        .await
        .expect("send switched hello");
        let switched_welcome = decode_welcome(
            &read_frame(&mut switched_client)
                .await
                .expect("switched welcome frame"),
        )
        .expect("decode switched welcome");
        let switched_event = tokio::time::timeout(Duration::from_secs(2), event_receiver.recv())
            .await
            .expect("switched registration event timeout")
            .expect("switched registration event");
        assert_eq!(switched_event.profile_id, DEFAULT_PROFILE_ID);
        assert_eq!(
            switched_event.terminal_instance_id,
            switched_welcome.terminal_instance_id
        );
        assert_ne!(
            switched_welcome.terminal_instance_id,
            welcome.terminal_instance_id
        );
        let switched_bindings = OutboxStore::open_or_create(
            resolve_profile_paths(&root, DEFAULT_PROFILE_ID)
                .expect("switched default paths")
                .database_path,
        )
        .expect("switched default store")
        .terminal_bindings()
        .expect("switched default bindings");
        assert_eq!(switched_bindings.len(), 1);
        assert_eq!(switched_bindings[0].account_ref.login, "87654321");
        stop.cancel();
        runner.await.expect("registration runner");
        std::fs::remove_dir_all(root).expect("remove fresh registration fixture");
    }
}
