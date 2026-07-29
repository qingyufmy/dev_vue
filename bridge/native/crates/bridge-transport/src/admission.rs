use crate::TransportError;
use bridge_command::{CommandAdmissionPolicy, CommandDispatchError};
use bridge_contract::{CommandMessage, TerminalDescriptor, same_terminal_route, validate_id};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub(crate) const REQUIRED_INITIAL_STREAMS: [&str; 3] = ["account", "positions", "orders"];

#[derive(Default)]
struct AdmissionState {
    accepting_commands: bool,
    session_id: Option<String>,
    terminals: HashMap<String, TerminalDescriptor>,
    synchronized_streams: HashMap<String, HashSet<String>>,
}

pub struct NativeCommandAdmission {
    state: Mutex<AdmissionState>,
}

impl Default for NativeCommandAdmission {
    fn default() -> Self {
        Self {
            state: Mutex::new(AdmissionState {
                accepting_commands: true,
                ..AdmissionState::default()
            }),
        }
    }
}

impl NativeCommandAdmission {
    pub fn begin_session(
        &self,
        session_id: &str,
        terminals: &[TerminalDescriptor],
    ) -> Result<(), TransportError> {
        validate_id(session_id).map_err(|_| TransportError::new("bridge_session_id_invalid"))?;
        if terminals.is_empty() || terminals.len() > 32 {
            return Err(TransportError::new("bridge_terminals_invalid"));
        }
        let mut routes = HashMap::new();
        for terminal in terminals {
            terminal.validate().map_err(TransportError::new)?;
            if routes
                .insert(terminal.terminal_instance_id.clone(), terminal.clone())
                .is_some()
            {
                return Err(TransportError::new("bridge_terminal_duplicate"));
            }
        }
        let synchronized_streams = routes
            .keys()
            .cloned()
            .map(|terminal_id| (terminal_id, HashSet::new()))
            .collect();
        let mut state = self
            .state
            .lock()
            .map_err(|_| TransportError::new("bridge_command_admission_failed"))?;
        state.session_id = Some(session_id.to_owned());
        state.terminals = routes;
        state.synchronized_streams = synchronized_streams;
        Ok(())
    }

    pub fn end_session(&self, session_id: &str) -> Result<(), TransportError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| TransportError::new("bridge_command_admission_failed"))?;
        if state.session_id.as_deref() == Some(session_id) {
            state.session_id = None;
            state.terminals.clear();
            state.synchronized_streams.clear();
        }
        Ok(())
    }

    pub fn acknowledge_initial_snapshot(
        &self,
        terminal_instance_id: &str,
        connection_epoch: i64,
        stream: &str,
    ) -> Result<bool, TransportError> {
        if !REQUIRED_INITIAL_STREAMS.contains(&stream) {
            return Ok(false);
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| TransportError::new("bridge_command_admission_failed"))?;
        let Some(terminal) = state.terminals.get(terminal_instance_id) else {
            return Ok(false);
        };
        if state.session_id.is_none() || terminal.connection_epoch != connection_epoch {
            return Ok(false);
        }
        let streams = state
            .synchronized_streams
            .get_mut(terminal_instance_id)
            .ok_or_else(|| TransportError::new("bridge_command_admission_failed"))?;
        let was_ready = REQUIRED_INITIAL_STREAMS
            .iter()
            .all(|required| streams.contains(*required));
        streams.insert(stream.to_owned());
        Ok(!was_ready
            && REQUIRED_INITIAL_STREAMS
                .iter()
                .all(|required| streams.contains(*required)))
    }

    pub fn validate(
        &self,
        command: &CommandMessage,
        now_utc_msc: i64,
    ) -> Result<(), TransportError> {
        if now_utc_msc <= 0 {
            return Err(TransportError::new("bridge_message_timestamp_invalid"));
        }
        if command.v != 3 || command.message_type != "command" {
            return Err(TransportError::new("command_protocol_invalid"));
        }
        validate_id(&command.command_id).map_err(|_| TransportError::new("command_id_invalid"))?;
        if command.deadline_utc_msc <= now_utc_msc {
            return Err(TransportError::new("command_expired"));
        }
        if !matches!(
            command.action.as_str(),
            "place_order"
                | "cancel_order"
                | "modify_order"
                | "modify_position"
                | "close_position"
                | "query_execution"
        ) {
            return Err(TransportError::new("command_action_unsupported"));
        }
        command
            .validate(now_utc_msc)
            .map_err(|_| TransportError::new("command_protocol_invalid"))?;
        let state = self
            .state
            .lock()
            .map_err(|_| TransportError::new("bridge_command_admission_failed"))?;
        if !state.accepting_commands {
            return Err(TransportError::new("bridge_command_admission_paused"));
        }
        let terminal = state
            .terminals
            .get(&command.terminal_instance_id)
            .ok_or_else(|| TransportError::new("terminal_not_found"))?;
        if !same_terminal_route(
            &terminal.terminal_instance_id,
            &terminal.account_ref,
            terminal.connection_epoch,
            &command.terminal_instance_id,
            &command.account_ref,
            command.connection_epoch,
        ) {
            return Err(TransportError::new("command_route_mismatch"));
        }
        if terminal.platform == "mt4" {
            return Err(TransportError::new("terminal_trade_unavailable"));
        }
        if command.action != "query_execution"
            && !state
                .synchronized_streams
                .get(&command.terminal_instance_id)
                .is_some_and(|streams| {
                    REQUIRED_INITIAL_STREAMS
                        .iter()
                        .all(|required| streams.contains(*required))
                })
        {
            return Err(TransportError::new("terminal_initial_sync_pending"));
        }
        Ok(())
    }

    pub fn pause(&self) -> Result<(), TransportError> {
        self.state
            .lock()
            .map_err(|_| TransportError::new("bridge_command_admission_failed"))?
            .accepting_commands = false;
        Ok(())
    }

    pub fn resume(&self) -> Result<(), TransportError> {
        self.state
            .lock()
            .map_err(|_| TransportError::new("bridge_command_admission_failed"))?
            .accepting_commands = true;
        Ok(())
    }
}

impl CommandAdmissionPolicy for NativeCommandAdmission {
    fn validate(
        &self,
        command: &CommandMessage,
        now_utc_msc: i64,
    ) -> Result<(), CommandDispatchError> {
        NativeCommandAdmission::validate(self, command, now_utc_msc)
            .map_err(|error| CommandDispatchError::new(error.code()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge_contract::AccountRef;

    fn terminal() -> TerminalDescriptor {
        TerminalDescriptor {
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            platform: "mt5".to_owned(),
            account_ref: AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "123456".to_owned(),
            },
            connection_epoch: 7,
            worker_version: Some("3.0.0".to_owned()),
        }
    }

    fn command(action: &str) -> CommandMessage {
        CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JADMIT001".to_owned(),
            sent_at_utc_msc: 1_700_000_000_000,
            command_id: "command_01JADMIT001".to_owned(),
            terminal_instance_id: "mt5_terminal_01".to_owned(),
            account_ref: terminal().account_ref,
            connection_epoch: 7,
            issued_at_utc_msc: 1_700_000_000_000,
            deadline_utc_msc: 1_700_000_010_000,
            action: action.to_owned(),
            params: serde_json::json!({}),
        }
    }

    #[test]
    fn mt4_commands_remain_closed_until_the_native_execution_adapter_is_enabled() {
        let admission = NativeCommandAdmission::default();
        let mut mt4_terminal = terminal();
        mt4_terminal.platform = "mt4".to_owned();
        admission
            .begin_session("session_01JADMITMT4", &[mt4_terminal])
            .expect("session");
        assert_eq!(
            admission
                .validate(&command("query_execution"), 1_700_000_000_001)
                .expect_err("MT4 execution must remain unavailable")
                .code(),
            "terminal_trade_unavailable"
        );
    }

    #[test]
    fn trade_commands_wait_for_all_initial_snapshots_but_queries_do_not() {
        let admission = NativeCommandAdmission::default();
        admission
            .begin_session("session_01JADMIT01", &[terminal()])
            .expect("session");
        assert_eq!(
            admission
                .validate(&command("place_order"), 1_700_000_000_001)
                .expect_err("initial sync")
                .code(),
            "terminal_initial_sync_pending"
        );
        admission
            .validate(&command("query_execution"), 1_700_000_000_001)
            .expect("reconciliation query");
        for stream in REQUIRED_INITIAL_STREAMS {
            admission
                .acknowledge_initial_snapshot("mt5_terminal_01", 7, stream)
                .expect("snapshot");
        }
        admission
            .validate(&command("place_order"), 1_700_000_000_001)
            .expect("ready trade");
    }

    #[test]
    fn account_epoch_pause_and_expiry_all_fail_closed() {
        let admission = NativeCommandAdmission::default();
        admission
            .begin_session("session_01JADMIT01", &[terminal()])
            .expect("session");
        let mut wrong = command("query_execution");
        wrong.account_ref.login = "999999".to_owned();
        assert_eq!(
            admission
                .validate(&wrong, 1_700_000_000_001)
                .expect_err("route")
                .code(),
            "command_route_mismatch"
        );
        assert_eq!(
            admission
                .validate(&command("query_execution"), 1_700_000_010_000)
                .expect_err("expired")
                .code(),
            "command_expired"
        );
        admission.pause().expect("pause");
        assert_eq!(
            admission
                .validate(&command("query_execution"), 1_700_000_000_001)
                .expect_err("paused")
                .code(),
            "bridge_command_admission_paused"
        );
    }
}
