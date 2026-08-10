use bridge_foundation::{DEFAULT_PROFILE_ID, validate_profile_id};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};
use url::Url;

#[cfg(windows)]
mod windows_pipe;

#[cfg(windows)]
pub use windows_pipe::{
    LocalControlEndpoint, LocalControlError, LocalControlPipeClient, LocalControlPipeServer,
};

pub const LOCAL_CONTROL_SCHEMA_VERSION: u32 = 1;
pub const MAX_LOCAL_CONTROL_BYTES: usize = 512 * 1024;
const MAX_TERMINALS: usize = 64;
const MAX_OBSERVER_PROFILES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalControlRequest {
    pub schema_version: u32,
    pub request_id: String,
    pub profile_id: String,
    pub action: LocalControlAction,
}

impl LocalControlRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != LOCAL_CONTROL_SCHEMA_VERSION
            || !valid_identifier(&self.request_id, 96)
            || validate_profile_id(Some(&self.profile_id)).as_deref()
                != Ok(self.profile_id.as_str())
        {
            return Err("bridge_local_control_request_invalid");
        }
        self.action.validate()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case", deny_unknown_fields)]
pub enum LocalControlAction {
    GetState,
    Pair,
    PairRestart,
    Logout,
    SelectPlatform {
        platform: String,
    },
    SelectTerminal {
        terminal_instance_id: String,
    },
    SwitchPrimaryAccount {
        platform: String,
        terminal_instance_id: String,
    },
    Redetect,
    InstallMt4Ea,
    ObserverCreate {
        observer: ObserverProfileMutation,
    },
    ObserverUpdate {
        observer: ObserverProfileMutation,
    },
    ObserverBind {
        observer_profile_id: String,
        bridge_user_id: i64,
    },
    ObserverStart {
        observer_profile_id: String,
    },
    ObserverPause {
        observer_profile_id: String,
    },
    ObserverRetry {
        observer_profile_id: String,
    },
    SettingsTest {
        settings: EndpointSettingsSelection,
    },
    SettingsSave {
        settings: EndpointSettingsSelection,
    },
    SettingsRestoreOfficial,
    AutostartSet {
        enabled: bool,
    },
    RealtimeCompatibilitySet {
        enabled: bool,
    },
    UpdateActivate,
    InternalUpdateDrain {
        timeout_msc: u64,
    },
    InternalUpdateResume,
    BridgeExit,
}

impl LocalControlAction {
    fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::SelectPlatform { platform } if !valid_platform(platform) => {
                Err("bridge_local_control_request_invalid")
            }
            Self::SelectTerminal {
                terminal_instance_id,
            } if !valid_identifier(terminal_instance_id, 128) => {
                Err("bridge_local_control_request_invalid")
            }
            Self::SwitchPrimaryAccount {
                platform,
                terminal_instance_id,
            } if !valid_platform(platform) || !valid_identifier(terminal_instance_id, 128) => {
                Err("bridge_local_control_request_invalid")
            }
            Self::ObserverCreate { observer } | Self::ObserverUpdate { observer } => {
                observer.validate()
            }
            Self::ObserverBind {
                observer_profile_id,
                bridge_user_id,
            } if validate_profile_id(Some(observer_profile_id)).as_deref()
                != Ok(observer_profile_id.as_str())
                || observer_profile_id == DEFAULT_PROFILE_ID
                || *bridge_user_id <= 0 =>
            {
                Err("bridge_local_control_request_invalid")
            }
            Self::ObserverStart {
                observer_profile_id,
            }
            | Self::ObserverPause {
                observer_profile_id,
            }
            | Self::ObserverRetry {
                observer_profile_id,
            } if validate_profile_id(Some(observer_profile_id)).as_deref()
                != Ok(observer_profile_id.as_str())
                || observer_profile_id == DEFAULT_PROFILE_ID =>
            {
                Err("bridge_local_control_request_invalid")
            }
            Self::SettingsTest { settings } | Self::SettingsSave { settings } => {
                settings.validate()
            }
            Self::InternalUpdateDrain { timeout_msc }
                if *timeout_msc == 0 || *timeout_msc > 30_000 =>
            {
                Err("bridge_local_control_request_invalid")
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObserverProfileMutation {
    pub observer_profile_id: String,
    pub bridge_user_id: i64,
    pub platform: String,
    pub terminal_directory: String,
}

impl ObserverProfileMutation {
    fn validate(&self) -> Result<(), &'static str> {
        if validate_profile_id(Some(&self.observer_profile_id)).as_deref()
            != Ok(self.observer_profile_id.as_str())
            || self.observer_profile_id == DEFAULT_PROFILE_ID
            || self.bridge_user_id <= 0
            || !valid_platform(&self.platform)
            || !valid_text(&self.terminal_directory, 1_024)
        {
            return Err("bridge_local_control_request_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EndpointSettingsSelection {
    pub follow_official: bool,
    pub server_url: String,
}

impl EndpointSettingsSelection {
    fn validate(&self) -> Result<(), &'static str> {
        if !valid_text(&self.server_url, 2_048) {
            return Err("bridge_local_control_request_invalid");
        }
        let url =
            Url::parse(&self.server_url).map_err(|_| "bridge_local_control_request_invalid")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("bridge_local_control_request_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalControlResponse {
    pub schema_version: u32,
    pub request_id: String,
    pub result: LocalControlResult,
}

impl LocalControlResponse {
    pub fn validate(&self, expected_profile_id: &str) -> Result<(), &'static str> {
        if self.schema_version != LOCAL_CONTROL_SCHEMA_VERSION
            || !valid_identifier(&self.request_id, 96)
        {
            return Err("bridge_local_control_response_invalid");
        }
        match &self.result {
            LocalControlResult::State { state } => state.validate(expected_profile_id),
            LocalControlResult::Accepted => Ok(()),
            LocalControlResult::Rejected { code } => {
                if valid_status_code(code) {
                    Ok(())
                } else {
                    Err("bridge_local_control_response_invalid")
                }
            }
            LocalControlResult::ConnectivityTest {
                success: _,
                description,
            } => {
                if valid_text(description, 512) {
                    Ok(())
                } else {
                    Err("bridge_local_control_response_invalid")
                }
            }
            LocalControlResult::Mt4EaDeployment { status } => {
                if matches!(status.as_str(), "installed" | "current") {
                    Ok(())
                } else {
                    Err("bridge_local_control_response_invalid")
                }
            }
            LocalControlResult::PairingUrl { url } => validate_pairing_url(url),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LocalControlResult {
    State { state: Box<UiStateSnapshot> },
    Accepted,
    Rejected { code: String },
    ConnectivityTest { success: bool, description: String },
    Mt4EaDeployment { status: String },
    PairingUrl { url: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiStateSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub profile_id: String,
    pub observed_at_utc_msc: i64,
    pub phase: String,
    pub detail_code: Option<String>,
    pub selected_platform: Option<String>,
    pub selected_terminal_instance_id: Option<String>,
    pub terminal_candidates: Vec<UiTerminalCandidate>,
    pub terminals: Vec<UiTerminalStatus>,
    pub server_connected: bool,
    pub last_data_sync_utc_msc: Option<i64>,
    pub bridge_version: String,
    pub can_manage_observer_sources: bool,
    pub is_administrator: bool,
    pub observer_sources: Vec<UiObserverSource>,
    pub observer_profiles: Vec<UiObserverProfile>,
    pub update_notice: Option<UiUpdateNotice>,
    pub autostart_enabled: bool,
    pub custom_endpoint_active: bool,
}

/// Authoritative in-memory state shared by Bridge Core and the desktop UI channel.
/// `runtime-status.json` remains a crash/fallback diagnostic and is not read by this store.
#[derive(Clone)]
pub struct UiStateStore {
    state: Arc<RwLock<UiStateSnapshot>>,
}

impl UiStateStore {
    pub fn new(state: UiStateSnapshot) -> Result<Self, &'static str> {
        state.validate(&state.profile_id)?;
        Ok(Self {
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub fn snapshot(&self) -> Result<UiStateSnapshot, &'static str> {
        self.state
            .read()
            .map(|state| state.clone())
            .map_err(|_| "bridge_local_control_state_unavailable")
    }

    pub fn publish(&self, mut next: UiStateSnapshot) -> Result<u64, &'static str> {
        let mut current = self
            .state
            .write()
            .map_err(|_| "bridge_local_control_state_unavailable")?;
        if next.profile_id != current.profile_id {
            return Err("bridge_local_control_state_invalid");
        }
        next.revision = current.revision.saturating_add(1);
        if next.revision == 0 {
            return Err("bridge_local_control_state_invalid");
        }
        next.validate(&current.profile_id)?;
        let revision = next.revision;
        *current = next;
        Ok(revision)
    }
}

impl UiStateSnapshot {
    pub fn validate(&self, expected_profile_id: &str) -> Result<(), &'static str> {
        let expected = validate_profile_id(Some(expected_profile_id))?;
        if self.schema_version != LOCAL_CONTROL_SCHEMA_VERSION
            || self.revision == 0
            || self.profile_id != expected
            || self.observed_at_utc_msc <= 0
            || !valid_application_phase(&self.phase)
            || self
                .detail_code
                .as_deref()
                .is_some_and(|code| !valid_status_code(code))
            || self
                .selected_platform
                .as_deref()
                .is_some_and(|platform| !valid_platform(platform))
            || self
                .selected_terminal_instance_id
                .as_deref()
                .is_some_and(|id| !valid_identifier(id, 128))
            || self.terminal_candidates.len() > MAX_TERMINALS
            || self.terminals.len() > MAX_TERMINALS
            || !valid_timestamp(self.last_data_sync_utc_msc, self.observed_at_utc_msc)
            || !valid_text(&self.bridge_version, 64)
            || self.observer_profiles.len() > MAX_OBSERVER_PROFILES
            || self.observer_sources.len() > MAX_OBSERVER_PROFILES
            || (self.can_manage_observer_sources
                && (!self.is_administrator || self.profile_id != DEFAULT_PROFILE_ID))
            || (!self.can_manage_observer_sources && !self.observer_profiles.is_empty())
            || (self.is_administrator && self.profile_id != DEFAULT_PROFILE_ID)
            || (!self.is_administrator && !self.observer_sources.is_empty())
        {
            return Err("bridge_local_control_state_invalid");
        }

        let mut candidate_ids = BTreeSet::new();
        if self.terminal_candidates.iter().any(|candidate| {
            !candidate.validate() || !candidate_ids.insert(&candidate.terminal_instance_id)
        }) {
            return Err("bridge_local_control_state_invalid");
        }
        let mut terminal_ids = BTreeSet::new();
        if self.terminals.iter().any(|terminal| {
            !terminal.validate() || !terminal_ids.insert(&terminal.terminal_instance_id)
        }) {
            return Err("bridge_local_control_state_invalid");
        }
        let mut observer_ids = BTreeSet::new();
        if self.observer_profiles.iter().any(|observer| {
            !observer.validate() || !observer_ids.insert(&observer.observer_profile_id)
        }) {
            return Err("bridge_local_control_state_invalid");
        }
        if self.terminals.iter().any(|terminal| {
            terminal
                .observer_profile_id
                .as_ref()
                .is_some_and(|profile| !observer_ids.contains(profile))
        }) {
            return Err("bridge_local_control_state_invalid");
        }
        let mut source_ids = BTreeSet::new();
        if self
            .observer_sources
            .iter()
            .any(|source| !source.validate() || !source_ids.insert(source.bridge_user_id))
        {
            return Err("bridge_local_control_state_invalid");
        }
        if self
            .update_notice
            .as_ref()
            .is_some_and(|notice| !notice.validate())
        {
            return Err("bridge_local_control_state_invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiObserverSource {
    pub bridge_user_id: i64,
    pub display_name: String,
    pub account_summary: String,
}

impl UiObserverSource {
    fn validate(&self) -> bool {
        self.bridge_user_id > 0
            && valid_text(&self.display_name, 256)
            && valid_text(&self.account_summary, 256)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTerminalCandidate {
    pub terminal_instance_id: String,
    pub platform: String,
    pub broker_server: String,
    pub login: String,
    pub display_name: Option<String>,
}

impl UiTerminalCandidate {
    fn validate(&self) -> bool {
        let account_identity_valid =
            valid_text(&self.broker_server, 128) && valid_text(&self.login, 64);
        let installation_only_valid = self.broker_server.is_empty()
            && self.login.is_empty()
            && self
                .display_name
                .as_deref()
                .is_some_and(|value| valid_text(value, 256));
        valid_identifier(&self.terminal_instance_id, 128)
            && valid_platform(&self.platform)
            && (account_identity_valid || installation_only_valid)
            && self
                .display_name
                .as_deref()
                .is_none_or(|value| valid_text(value, 256))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiTerminalStatus {
    pub terminal_instance_id: String,
    pub platform: String,
    pub broker_server: String,
    pub login: String,
    pub runtime_state: String,
    /// Optional live-account initialization projection. Empty is retained for old clients.
    #[serde(default)]
    pub initialization_state: String,
    #[serde(default)]
    pub local_operational_ready: bool,
    #[serde(default)]
    pub history_backfill_pending: bool,
    #[serde(default)]
    pub history_attention_required: bool,
    pub error_code: Option<String>,
    pub observer_profile_id: Option<String>,
    pub terminal_trading_allowed: Option<bool>,
    pub program_trading_allowed: Option<bool>,
    pub account_trading_allowed: Option<bool>,
    pub account_expert_trading_allowed: Option<bool>,
    pub mt4_expert_restart_required: bool,
}

impl UiTerminalStatus {
    fn validate(&self) -> bool {
        valid_identifier(&self.terminal_instance_id, 128)
            && valid_platform(&self.platform)
            && valid_text(&self.broker_server, 128)
            && valid_text(&self.login, 64)
            && matches!(
                self.runtime_state.as_str(),
                "starting" | "running" | "restarting" | "stopped"
            )
            && (self.initialization_state.is_empty()
                || matches!(
                    self.initialization_state.as_str(),
                    "detected"
                        | "verifying_identity"
                        | "warming_realtime_snapshot"
                        | "reconciling_local_commands"
                        | "ready"
                        | "retrying"
                        | "blocked"
                        | "superseded"
                ))
            && self.error_code.as_deref().is_none_or(valid_status_code)
            && self.observer_profile_id.as_deref().is_none_or(|profile| {
                validate_profile_id(Some(profile)).as_deref() == Ok(profile)
                    && profile != DEFAULT_PROFILE_ID
            })
            && (self.platform == "mt4" || self.program_trading_allowed.is_none())
            && (self.platform == "mt4" || !self.mt4_expert_restart_required)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiObserverProfile {
    pub observer_profile_id: String,
    pub platform: Option<String>,
    pub terminal_directory: Option<String>,
    pub configured: bool,
    pub enabled: bool,
    pub terminal_instance_id: Option<String>,
    pub bridge_user_id: Option<i64>,
    pub observer_account_label: Option<String>,
    pub trading_account_label: Option<String>,
    pub runtime_phase: Option<String>,
    pub runtime_detail_code: Option<String>,
}

impl UiObserverProfile {
    fn validate(&self) -> bool {
        validate_profile_id(Some(&self.observer_profile_id)).as_deref()
            == Ok(self.observer_profile_id.as_str())
            && self.observer_profile_id != DEFAULT_PROFILE_ID
            && self.platform.as_deref().is_none_or(valid_platform)
            && self
                .terminal_directory
                .as_deref()
                .is_none_or(|value| valid_text(value, 1_024))
            && self
                .terminal_instance_id
                .as_deref()
                .is_none_or(|id| valid_identifier(id, 128))
            && self.bridge_user_id.is_none_or(|id| id > 0)
            && self
                .observer_account_label
                .as_deref()
                .is_none_or(|value| valid_text(value, 256))
            && self
                .trading_account_label
                .as_deref()
                .is_none_or(|value| valid_text(value, 256))
            && self
                .runtime_phase
                .as_deref()
                .is_none_or(valid_application_phase)
            && self
                .runtime_detail_code
                .as_deref()
                .is_none_or(valid_status_code)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiUpdateNotice {
    pub version: String,
    pub urgent: bool,
    pub phase: String,
    pub manual_activation_requested: bool,
}

impl UiUpdateNotice {
    fn validate(&self) -> bool {
        (valid_text(&self.version, 64) || self.phase == "failed" && self.version.is_empty())
            && matches!(
                self.phase.as_str(),
                "downloading"
                    | "ready"
                    | "waiting"
                    | "activating"
                    | "failed"
                    | "rolled_back"
                    | "healthy"
            )
    }
}

pub fn decode_request(payload: &[u8]) -> Result<LocalControlRequest, &'static str> {
    if payload.is_empty() || payload.len() > MAX_LOCAL_CONTROL_BYTES {
        return Err("bridge_local_control_request_invalid");
    }
    let request: LocalControlRequest =
        serde_json::from_slice(payload).map_err(|_| "bridge_local_control_request_invalid")?;
    request.validate()?;
    Ok(request)
}

pub fn decode_response(
    payload: &[u8],
    expected_profile_id: &str,
) -> Result<LocalControlResponse, &'static str> {
    if payload.is_empty() || payload.len() > MAX_LOCAL_CONTROL_BYTES {
        return Err("bridge_local_control_response_invalid");
    }
    let response: LocalControlResponse =
        serde_json::from_slice(payload).map_err(|_| "bridge_local_control_response_invalid")?;
    response.validate(expected_profile_id)?;
    Ok(response)
}

fn validate_pairing_url(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "bridge_local_control_response_invalid")?;
    if matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
    {
        Ok(())
    } else {
        Err("bridge_local_control_response_invalid")
    }
}

fn valid_platform(value: &str) -> bool {
    matches!(value, "mt4" | "mt5")
}

fn valid_application_phase(value: &str) -> bool {
    matches!(
        value,
        "starting"
            | "platform_selection_required"
            | "terminal_selection_required"
            | "detecting_terminal"
            | "terminal_not_found"
            | "pairing_required"
            | "paused"
            | "connecting"
            | "online"
            | "degraded"
            | "stopped"
    )
}

fn valid_status_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_timestamp(value: Option<i64>, observed_at_utc_msc: i64) -> bool {
    value.is_none_or(|timestamp| {
        timestamp > 0 && timestamp <= observed_at_utc_msc.saturating_add(60_000)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> UiStateSnapshot {
        UiStateSnapshot {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            revision: 7,
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            observed_at_utc_msc: 1_800_000_000_000,
            phase: "online".to_owned(),
            detail_code: None,
            selected_platform: Some("mt5".to_owned()),
            selected_terminal_instance_id: Some("mt5_demo".to_owned()),
            terminal_candidates: vec![UiTerminalCandidate {
                terminal_instance_id: "mt5_demo".to_owned(),
                platform: "mt5".to_owned(),
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
                display_name: Some("123456 · Broker-Demo".to_owned()),
            }],
            terminals: vec![UiTerminalStatus {
                terminal_instance_id: "mt5_demo".to_owned(),
                platform: "mt5".to_owned(),
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
                runtime_state: "running".to_owned(),
                initialization_state: "ready".to_owned(),
                local_operational_ready: true,
                history_backfill_pending: true,
                history_attention_required: false,
                error_code: None,
                observer_profile_id: None,
                terminal_trading_allowed: Some(true),
                program_trading_allowed: None,
                account_trading_allowed: Some(true),
                account_expert_trading_allowed: Some(true),
                mt4_expert_restart_required: false,
            }],
            server_connected: true,
            last_data_sync_utc_msc: Some(1_800_000_000_000),
            bridge_version: "3.0.0-alpha.1".to_owned(),
            can_manage_observer_sources: false,
            is_administrator: false,
            observer_sources: Vec::new(),
            observer_profiles: Vec::new(),
            update_notice: None,
            autostart_enabled: true,
            custom_endpoint_active: false,
        }
    }

    #[test]
    fn request_round_trip_preserves_exact_platform_action() {
        let request = LocalControlRequest {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            request_id: "request-1".to_owned(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            action: LocalControlAction::SelectPlatform {
                platform: "mt4".to_owned(),
            },
        };
        let payload = serde_json::to_vec(&request).expect("serialize request");
        assert_eq!(decode_request(&payload), Ok(request.clone()));
    }

    #[test]
    fn switch_primary_account_round_trips_and_validates_the_atomic_tuple() {
        let request = LocalControlRequest {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            request_id: "switch-primary".to_owned(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            action: LocalControlAction::SwitchPrimaryAccount {
                platform: "mt4".to_owned(),
                terminal_instance_id: "mt4_demo".to_owned(),
            },
        };
        let payload = serde_json::to_vec(&request).expect("serialize switch request");
        assert!(String::from_utf8_lossy(&payload).contains("switch_primary_account"));
        assert_eq!(decode_request(&payload), Ok(request.clone()));

        let invalid_platform = LocalControlRequest {
            action: LocalControlAction::SwitchPrimaryAccount {
                platform: "mt6".to_owned(),
                terminal_instance_id: "mt4_demo".to_owned(),
            },
            ..request.clone()
        };
        assert_eq!(
            invalid_platform.validate(),
            Err("bridge_local_control_request_invalid")
        );
        let invalid_id = LocalControlRequest {
            action: LocalControlAction::SwitchPrimaryAccount {
                platform: "mt4".to_owned(),
                terminal_instance_id: "bad id".to_owned(),
            },
            ..request
        };
        assert_eq!(
            invalid_id.validate(),
            Err("bridge_local_control_request_invalid")
        );
    }

    #[test]
    fn explicit_pairing_restart_round_trips_without_changing_normal_pairing() {
        for (request_id, action, expected_name) in [
            ("pair-normal", LocalControlAction::Pair, "pair"),
            (
                "pair-restart",
                LocalControlAction::PairRestart,
                "pair_restart",
            ),
        ] {
            let request = LocalControlRequest {
                schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                request_id: request_id.to_owned(),
                profile_id: DEFAULT_PROFILE_ID.to_owned(),
                action,
            };
            let payload = serde_json::to_vec(&request).expect("serialize pairing request");
            assert!(String::from_utf8_lossy(&payload).contains(expected_name));
            assert_eq!(decode_request(&payload), Ok(request));
        }
    }

    #[test]
    fn internal_update_drain_is_bounded_and_round_trips_without_becoming_a_ui_action() {
        let request = LocalControlRequest {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            request_id: "update_drain_0000000000000001".to_owned(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            action: LocalControlAction::InternalUpdateDrain {
                timeout_msc: 30_000,
            },
        };
        let payload = serde_json::to_vec(&request).expect("serialize drain request");
        assert_eq!(decode_request(&payload), Ok(request));

        for timeout_msc in [0, 30_001] {
            let invalid = LocalControlRequest {
                schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
                request_id: "update_drain_invalid".to_owned(),
                profile_id: DEFAULT_PROFILE_ID.to_owned(),
                action: LocalControlAction::InternalUpdateDrain { timeout_msc },
            };
            assert_eq!(
                invalid.validate(),
                Err("bridge_local_control_request_invalid")
            );
        }
    }

    #[test]
    fn mt4_installation_candidate_is_valid_before_an_account_is_registered() {
        let mut installation = state();
        installation.selected_platform = Some("mt4".to_owned());
        installation.selected_terminal_instance_id = Some("mt4_installation".to_owned());
        installation.terminal_candidates = vec![UiTerminalCandidate {
            terminal_instance_id: "mt4_installation".to_owned(),
            platform: "mt4".to_owned(),
            broker_server: String::new(),
            login: String::new(),
            display_name: Some("MetaTrader 4".to_owned()),
        }];
        installation.terminals.clear();
        installation.server_connected = false;
        installation.last_data_sync_utc_msc = None;
        assert_eq!(installation.validate(DEFAULT_PROFILE_ID), Ok(()));
        installation.terminal_candidates[0].display_name = None;
        assert_eq!(
            installation.validate(DEFAULT_PROFILE_ID),
            Err("bridge_local_control_state_invalid")
        );
    }

    #[test]
    fn mt4_ea_deployment_result_accepts_only_the_fixed_status_contract() {
        let response = LocalControlResponse {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            request_id: "request-ea".to_owned(),
            result: LocalControlResult::Mt4EaDeployment {
                status: "installed".to_owned(),
            },
        };
        assert_eq!(response.validate(DEFAULT_PROFILE_ID), Ok(()));
        let payload = serde_json::to_vec(&response).expect("serialize deployment response");
        assert_eq!(decode_response(&payload, DEFAULT_PROFILE_ID), Ok(response));

        let invalid = LocalControlResponse {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            request_id: "request-ea-invalid".to_owned(),
            result: LocalControlResult::Mt4EaDeployment {
                status: "updated".to_owned(),
            },
        };
        assert_eq!(
            invalid.validate(DEFAULT_PROFILE_ID),
            Err("bridge_local_control_response_invalid")
        );
    }

    #[test]
    fn strict_decoder_rejects_unknown_fields_and_accepts_explicit_http_settings() {
        assert_eq!(
            decode_request(
                br#"{"schema_version":1,"request_id":"request-1","profile_id":"default","action":{"name":"get_state"},"secret":"leak"}"#,
            ),
            Err("bridge_local_control_request_invalid")
        );
        let request = LocalControlRequest {
            schema_version: LOCAL_CONTROL_SCHEMA_VERSION,
            request_id: "request-2".to_owned(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            action: LocalControlAction::SettingsSave {
                settings: EndpointSettingsSelection {
                    follow_official: false,
                    server_url: "http://example.com/".to_owned(),
                },
            },
        };
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn ordinary_user_state_cannot_leak_observer_profiles() {
        let mut leaked = state();
        leaked.observer_profiles.push(UiObserverProfile {
            observer_profile_id: "source-1".to_owned(),
            platform: Some("mt5".to_owned()),
            terminal_directory: Some(r"C:\Broker MT5".to_owned()),
            configured: true,
            enabled: true,
            terminal_instance_id: Some("mt5_source".to_owned()),
            bridge_user_id: Some(2),
            observer_account_label: Some("一号观摩源".to_owned()),
            trading_account_label: Some("123456 · Broker-Demo".to_owned()),
            runtime_phase: Some("online".to_owned()),
            runtime_detail_code: None,
        });
        assert_eq!(
            leaked.validate(DEFAULT_PROFILE_ID),
            Err("bridge_local_control_state_invalid")
        );
    }

    #[test]
    fn failed_update_notice_allows_the_empty_version_used_by_dotnet() {
        let mut failed = state();
        failed.update_notice = Some(UiUpdateNotice {
            version: String::new(),
            urgent: false,
            phase: "failed".to_owned(),
            manual_activation_requested: false,
        });
        assert_eq!(failed.validate(DEFAULT_PROFILE_ID), Ok(()));
        failed.update_notice.as_mut().expect("notice").phase = "ready".to_owned();
        assert_eq!(
            failed.validate(DEFAULT_PROFILE_ID),
            Err("bridge_local_control_state_invalid")
        );
    }

    #[test]
    fn terminal_history_projection_is_backward_compatible_and_can_be_attention_required() {
        let mut value = serde_json::to_value(state()).expect("state json");
        let terminal = value["terminals"][0]
            .as_object_mut()
            .expect("terminal object");
        terminal.remove("initialization_state");
        terminal.remove("local_operational_ready");
        terminal.remove("history_backfill_pending");
        terminal.remove("history_attention_required");
        let mut decoded: UiStateSnapshot =
            serde_json::from_value(value).expect("old state remains readable");
        assert_eq!(decoded.terminals[0].initialization_state, "");
        assert!(!decoded.terminals[0].local_operational_ready);
        decoded.terminals[0].initialization_state = "ready".to_owned();
        decoded.terminals[0].local_operational_ready = true;
        decoded.terminals[0].history_backfill_pending = true;
        decoded.terminals[0].history_attention_required = true;
        assert_eq!(decoded.validate(DEFAULT_PROFILE_ID), Ok(()));
    }

    #[test]
    fn administrator_state_keeps_observer_and_terminal_ownership_consistent() {
        let mut admin = state();
        admin.is_administrator = true;
        admin.can_manage_observer_sources = true;
        admin.observer_profiles.push(UiObserverProfile {
            observer_profile_id: "source-1".to_owned(),
            platform: Some("mt4".to_owned()),
            terminal_directory: Some(r"C:\Broker MT4".to_owned()),
            configured: true,
            enabled: true,
            terminal_instance_id: Some("mt4_source".to_owned()),
            bridge_user_id: Some(2),
            observer_account_label: Some("一号观摩源".to_owned()),
            trading_account_label: Some("654321 · Broker-Demo".to_owned()),
            runtime_phase: Some("online".to_owned()),
            runtime_detail_code: None,
        });
        admin.terminals.push(UiTerminalStatus {
            terminal_instance_id: "mt4_source".to_owned(),
            platform: "mt4".to_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: "654321".to_owned(),
            runtime_state: "running".to_owned(),
            initialization_state: "ready".to_owned(),
            local_operational_ready: true,
            history_backfill_pending: false,
            history_attention_required: false,
            error_code: None,
            observer_profile_id: Some("source-1".to_owned()),
            terminal_trading_allowed: Some(true),
            program_trading_allowed: Some(true),
            account_trading_allowed: Some(true),
            account_expert_trading_allowed: Some(true),
            mt4_expert_restart_required: false,
        });
        assert_eq!(admin.validate(DEFAULT_PROFILE_ID), Ok(()));

        admin.terminals[1].observer_profile_id = Some("source-missing".to_owned());
        assert_eq!(
            admin.validate(DEFAULT_PROFILE_ID),
            Err("bridge_local_control_state_invalid")
        );
    }

    #[test]
    fn pairing_url_allows_http_and_https() {
        assert_eq!(
            validate_pairing_url("https://server.example/bridge/pair"),
            Ok(())
        );
        assert_eq!(
            validate_pairing_url("http://127.0.0.1:3000/bridge/pair"),
            Ok(())
        );
        assert_eq!(
            validate_pairing_url("http://[::1]:3000/bridge/pair"),
            Ok(())
        );
        assert_eq!(
            validate_pairing_url("http://192.168.1.254/bridge/pair"),
            Ok(())
        );
        assert_eq!(
            validate_pairing_url("http://example.com/bridge/pair"),
            Ok(())
        );
    }

    #[test]
    fn state_store_owns_revision_and_rejects_cross_profile_publish() {
        let store = UiStateStore::new(state()).expect("state store");
        let mut next = store.snapshot().expect("snapshot");
        next.phase = "degraded".to_owned();
        next.detail_code = Some("terminal_runtime_failed".to_owned());
        assert_eq!(store.publish(next), Ok(8));
        assert_eq!(store.snapshot().expect("published").revision, 8);

        let mut wrong_profile = store.snapshot().expect("snapshot");
        wrong_profile.profile_id = "source-1".to_owned();
        assert_eq!(
            store.publish(wrong_profile),
            Err("bridge_local_control_state_invalid")
        );
    }
}
