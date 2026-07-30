use crate::{MAX_STRING_BYTES, MessageType, Mt4ProtocolError, PayloadReader, PayloadWriter};
use bridge_contract::{CommandMessage, CommandResultMessage, ExecutionEvidence};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum TradeAction {
    PlaceOrder = 1,
    CancelOrder = 2,
    ModifyOrder = 3,
    ClosePosition = 4,
    QueryExecution = 5,
    ModifyPosition = 6,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum OrderSide {
    None = 0,
    Buy = 1,
    Sell = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum OrderKind {
    None = 0,
    Market = 1,
    Limit = 2,
    Stop = 3,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TradeCommand {
    pub command_id: String,
    pub terminal_instance_id: String,
    pub broker_server: String,
    pub login: String,
    pub connection_epoch: i64,
    pub deadline_utc_msc: i64,
    pub action: TradeAction,
    pub symbol: String,
    pub side: OrderSide,
    pub order_kind: OrderKind,
    pub ticket: i64,
    pub volume: f64,
    pub price: Option<f64>,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub deviation: i32,
    pub magic: i32,
    pub expiration: i64,
    pub expected_stop_loss: Option<f64>,
    pub expected_take_profit: Option<f64>,
    pub comment: String,
    pub expected_kind: String,
    pub bridge_command_ref: String,
    pub expected_volume: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TradeResult {
    pub command_id: String,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub broker_retcode: i32,
    pub ticket: i64,
    pub observed_at_utc_msc: i64,
    pub raw_result: Option<Value>,
}

pub fn command_from_bridge(command: &CommandMessage) -> Result<TradeCommand, Mt4ProtocolError> {
    if command.v != 3 || command.message_type != "command" {
        return Err(Mt4ProtocolError::new("mt4_command_envelope_invalid"));
    }
    let params = command
        .params
        .as_object()
        .ok_or_else(|| Mt4ProtocolError::new("mt4_command_params_invalid"))?;
    let expected_state = match params.get("expected_state") {
        None | Some(Value::Null) => None,
        Some(Value::Object(value)) => Some(value),
        Some(_) => return Err(Mt4ProtocolError::new("management_expected_state_invalid")),
    };
    let action = match command.action.as_str() {
        "place_order" => TradeAction::PlaceOrder,
        "cancel_order" => TradeAction::CancelOrder,
        "modify_order" => TradeAction::ModifyOrder,
        "close_position" => TradeAction::ClosePosition,
        "query_execution" => TradeAction::QueryExecution,
        "modify_position" => TradeAction::ModifyPosition,
        _ => return Err(Mt4ProtocolError::new("command_action_unsupported")),
    };
    let side = match optional_string(params, "side")?
        .or(expected_state
            .map(|value| optional_string(value, "direction"))
            .transpose()?
            .flatten())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "" => OrderSide::None,
        "buy" => OrderSide::Buy,
        "sell" => OrderSide::Sell,
        _ => return Err(Mt4ProtocolError::new("order_side_invalid")),
    };
    let order_kind = match optional_string(params, "order_kind")?
        .unwrap_or_else(|| "market".to_owned())
        .to_ascii_lowercase()
        .as_str()
    {
        "market" => OrderKind::Market,
        "limit" => OrderKind::Limit,
        "stop" => OrderKind::Stop,
        "stop_limit" => return Err(Mt4ProtocolError::new("mt4_stop_limit_unsupported")),
        _ => return Err(Mt4ProtocolError::new("order_kind_invalid")),
    };
    let command = TradeCommand {
        command_id: command.command_id.clone(),
        terminal_instance_id: command.terminal_instance_id.clone(),
        broker_server: command.account_ref.broker_server.clone(),
        login: command.account_ref.login.clone(),
        connection_epoch: command.connection_epoch,
        deadline_utc_msc: command.deadline_utc_msc,
        action,
        symbol: optional_string(params, "symbol")?
            .or(expected_state
                .map(|value| optional_string(value, "symbol"))
                .transpose()?
                .flatten())
            .unwrap_or_default(),
        side,
        order_kind,
        ticket: optional_i64(params, "ticket")?
            .or(optional_i64(params, "pending_ticket")?)
            .or(optional_i64(params, "trade_ticket")?)
            .or(expected_state
                .map(|value| optional_i64(value, "ticket"))
                .transpose()?
                .flatten())
            .unwrap_or(0),
        volume: optional_f64(params, "volume")?.unwrap_or(0.0),
        price: optional_f64(params, "price")?,
        stop_loss: optional_f64(params, "stop_loss")?,
        take_profit: optional_f64(params, "take_profit")?,
        deviation: optional_i32(params, "deviation")?.unwrap_or(20),
        magic: optional_i32(params, "magic")?
            .or(expected_state
                .map(|value| optional_i32(value, "magic"))
                .transpose()?
                .flatten())
            .unwrap_or(234000),
        expiration: optional_i64(params, "expiration")?.unwrap_or(0),
        expected_stop_loss: optional_f64(params, "expected_stop_loss")?.or(expected_state
            .map(|value| optional_f64(value, "stop_loss"))
            .transpose()?
            .flatten()),
        expected_take_profit: optional_f64(params, "expected_take_profit")?.or(expected_state
            .map(|value| optional_f64(value, "take_profit"))
            .transpose()?
            .flatten()),
        comment: optional_string(params, "comment")?.unwrap_or_default(),
        expected_kind: optional_string(params, "expected_kind")?
            .unwrap_or_default()
            .to_ascii_lowercase(),
        bridge_command_ref: optional_string(params, "bridge_command_ref")?.unwrap_or_default(),
        expected_volume: expected_state
            .map(|value| optional_f64(value, "volume"))
            .transpose()?
            .flatten(),
    };
    validate_command(&command)?;
    Ok(command)
}

pub fn result_to_bridge(
    command: &CommandMessage,
    mut result: TradeResult,
    message_id: String,
) -> Result<CommandResultMessage, Mt4ProtocolError> {
    if result.command_id != command.command_id {
        return Err(Mt4ProtocolError::new("mt4_command_result_id_mismatch"));
    }
    if command.action == "query_execution" && result.raw_result.is_none() {
        return Ok(rejected_bridge_result(
            command,
            result.observed_at_utc_msc,
            message_id,
            "mt4_query_result_invalid",
        ));
    }
    if command.action == "query_execution"
        && command
            .params
            .get("original_action")
            .and_then(Value::as_str)
            .is_some()
    {
        let raw = result
            .raw_result
            .as_mut()
            .and_then(Value::as_object_mut)
            .ok_or_else(|| Mt4ProtocolError::new("mt4_query_result_invalid"))?;
        let resolution = reconciliation_resolution(command, raw, result.observed_at_utc_msc)?;
        raw.insert("resolution".to_owned(), resolution);
    }
    let ticket = (result.ticket > 0).then(|| result.ticket.to_string());
    let query_order_tickets = result
        .raw_result
        .as_ref()
        .and_then(|raw| raw.get("order"))
        .and_then(scalar_text)
        .into_iter()
        .collect::<Vec<_>>();
    let query_position_tickets = result
        .raw_result
        .as_ref()
        .and_then(|raw| raw.get("position_id"))
        .and_then(scalar_text)
        .into_iter()
        .collect::<Vec<_>>();
    let raw_result = result.raw_result.or_else(|| {
        Some(serde_json::json!({
            "broker_retcode": result.broker_retcode
        }))
    });
    let bridge = CommandResultMessage {
        v: 3,
        message_type: "command_result".to_owned(),
        message_id,
        sent_at_utc_msc: result.observed_at_utc_msc,
        command_id: command.command_id.clone(),
        terminal_instance_id: command.terminal_instance_id.clone(),
        account_ref: command.account_ref.clone(),
        connection_epoch: command.connection_epoch,
        status: result.status,
        completed_at_utc_msc: result.observed_at_utc_msc,
        error_code: result.error_code,
        error_message: result.error_message,
        raw_result,
        evidence: ExecutionEvidence {
            observed_at_utc_msc: result.observed_at_utc_msc,
            order_tickets: if matches!(
                command.action.as_str(),
                "place_order" | "cancel_order" | "modify_order"
            ) {
                ticket.clone().into_iter().collect()
            } else if command.action == "query_execution" {
                query_order_tickets
            } else {
                Vec::new()
            },
            position_tickets: if matches!(
                command.action.as_str(),
                "close_position" | "modify_position"
            ) {
                ticket.into_iter().collect()
            } else if command.action == "query_execution" {
                query_position_tickets
            } else {
                Vec::new()
            },
            deal_tickets: Vec::new(),
            broker_retcode: Some(i64::from(result.broker_retcode)),
        },
    };
    bridge
        .validate()
        .map_err(|_| Mt4ProtocolError::new("mt4_command_result_invalid"))?;
    Ok(bridge)
}

fn reconciliation_resolution(
    command: &CommandMessage,
    observed: &serde_json::Map<String, Value>,
    observed_at_utc_msc: i64,
) -> Result<Value, Mt4ProtocolError> {
    let params = command
        .params
        .as_object()
        .ok_or_else(|| Mt4ProtocolError::new("mt4_reconciliation_params_invalid"))?;
    let action = params
        .get("original_action")
        .and_then(Value::as_str)
        .ok_or_else(|| Mt4ProtocolError::new("mt4_reconciliation_params_invalid"))?;
    let original = params
        .get("original_params")
        .and_then(Value::as_object)
        .ok_or_else(|| Mt4ProtocolError::new("mt4_reconciliation_params_invalid"))?;
    let issued_at = params
        .get("original_issued_at_utc_msc")
        .and_then(Value::as_i64)
        .ok_or_else(|| Mt4ProtocolError::new("mt4_reconciliation_params_invalid"))?;
    let settle_after = params
        .get("settle_after_msc")
        .and_then(Value::as_u64)
        .unwrap_or(15_000);
    let settled = observed_at_utc_msc.saturating_sub(issued_at)
        >= i64::try_from(settle_after).unwrap_or(i64::MAX);
    let complete = observed
        .get("complete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let found = observed
        .get("found")
        .and_then(Value::as_bool)
        .ok_or_else(|| Mt4ProtocolError::new("mt4_reconciliation_result_invalid"))?;
    let unresolved = |code: &'static str| {
        if settled && complete {
            serde_json::json!({ "status": "failed", "error_code": code })
        } else {
            serde_json::json!({
                "status": "pending",
                "error_code": "reconciliation_settlement_pending"
            })
        }
    };
    let source = observed
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let pending_state = observed
        .get("pending_state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resolution = match action {
        "place_order" => {
            if !found {
                unresolved("execution_not_found_after_settlement")
            } else if matches!(pending_state, "cancelled" | "rejected" | "expired") {
                serde_json::json!({
                    "status": "failed",
                    "error_code": format!("pending_order_{pending_state}")
                })
            } else {
                serde_json::json!({ "status": "succeeded" })
            }
        }
        "cancel_order" => {
            if !found {
                unresolved("pending_order_history_unverified")
            } else if source == "active_order" || pending_state == "pending" {
                unresolved("pending_order_still_active")
            } else if matches!(pending_state, "filled" | "partially_filled") {
                serde_json::json!({
                    "status": "failed",
                    "error_code": "pending_order_already_filled"
                })
            } else if source == "history_order" {
                serde_json::json!({ "status": "succeeded" })
            } else {
                unresolved("pending_order_evidence_incomplete")
            }
        }
        "close_position" => {
            if !found {
                unresolved("position_history_unverified")
            } else if source != "active_position" {
                serde_json::json!({ "status": "succeeded" })
            } else {
                let expected = original.get("expected_state").and_then(Value::as_object);
                let before = expected
                    .and_then(|value| value.get("volume"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let requested = original
                    .get("volume")
                    .and_then(Value::as_f64)
                    .unwrap_or(before);
                let current = observed
                    .get("volume")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::INFINITY);
                if before > 0.0 && current <= (before - requested).max(0.0) + 1e-8 {
                    serde_json::json!({ "status": "succeeded" })
                } else {
                    unresolved("position_still_open")
                }
            }
        }
        "modify_order" => {
            if source != "active_order" {
                unresolved("pending_order_not_active")
            } else if changes_match(
                original,
                observed,
                &["price", "stop_loss", "take_profit", "expiration"],
            ) {
                serde_json::json!({ "status": "succeeded" })
            } else {
                unresolved("pending_order_change_not_applied")
            }
        }
        "modify_position" => {
            if source != "active_position" {
                unresolved("position_not_active")
            } else if changes_match(original, observed, &["stop_loss", "take_profit"]) {
                serde_json::json!({ "status": "succeeded" })
            } else {
                unresolved("position_protection_not_applied")
            }
        }
        _ => serde_json::json!({
            "status": "pending",
            "error_code": "reconciliation_action_unsupported"
        }),
    };
    Ok(resolution)
}

fn changes_match(
    expected: &serde_json::Map<String, Value>,
    observed: &serde_json::Map<String, Value>,
    fields: &[&str],
) -> bool {
    let tolerance = observed
        .get("point")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value / 2.0)
        .unwrap_or(1e-8)
        .max(1e-8);
    fields.iter().all(|field| {
        let Some(expected_value) = expected.get(*field) else {
            return true;
        };
        if *field == "expiration" {
            return scalar_i64(expected_value).is_some_and(|expected| {
                observed
                    .get(*field)
                    .and_then(scalar_i64)
                    .is_some_and(|actual| actual == expected)
            });
        }
        expected_value.as_f64().is_some_and(|expected| {
            observed
                .get(*field)
                .and_then(Value::as_f64)
                .is_some_and(|actual| (actual - expected).abs() <= tolerance)
        })
    })
}

fn scalar_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

pub fn rejected_bridge_result(
    command: &CommandMessage,
    observed_at_utc_msc: i64,
    message_id: String,
    error_code: &'static str,
) -> CommandResultMessage {
    CommandResultMessage {
        v: 3,
        message_type: "command_result".to_owned(),
        message_id,
        sent_at_utc_msc: observed_at_utc_msc,
        command_id: command.command_id.clone(),
        terminal_instance_id: command.terminal_instance_id.clone(),
        account_ref: command.account_ref.clone(),
        connection_epoch: command.connection_epoch,
        status: "rejected".to_owned(),
        completed_at_utc_msc: observed_at_utc_msc,
        error_code: Some(error_code.to_owned()),
        error_message: None,
        raw_result: Some(serde_json::json!({})),
        evidence: ExecutionEvidence {
            observed_at_utc_msc,
            order_tickets: Vec::new(),
            position_tickets: Vec::new(),
            deal_tickets: Vec::new(),
            broker_retcode: None,
        },
    }
}

pub fn encode_command(command: &TradeCommand) -> Result<Vec<u8>, Mt4ProtocolError> {
    validate_command(command)?;
    let mut writer = PayloadWriter::new(MessageType::Command);
    writer.string(&command.command_id)?;
    writer.string(&command.terminal_instance_id)?;
    writer.string(&command.broker_server)?;
    writer.string(&command.login)?;
    writer.i64(command.connection_epoch);
    writer.i64(command.deadline_utc_msc);
    writer.i32(command.action as i32);
    writer.string(&command.symbol)?;
    writer.i32(command.side as i32);
    writer.i32(command.order_kind as i32);
    writer.i64(command.ticket);
    write_number(&mut writer, Some(command.volume))?;
    write_number(&mut writer, command.price)?;
    write_number(&mut writer, command.stop_loss)?;
    write_number(&mut writer, command.take_profit)?;
    writer.i32(command.deviation);
    writer.i32(command.magic);
    writer.i64(command.expiration);
    write_number(&mut writer, command.expected_stop_loss)?;
    write_number(&mut writer, command.expected_take_profit)?;
    writer.string(&command.comment)?;
    writer.string(&command.expected_kind)?;
    writer.string(&command.bridge_command_ref)?;
    write_number(&mut writer, command.expected_volume)?;
    writer.finish()
}

pub fn decode_command(payload: &[u8]) -> Result<TradeCommand, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Command)?;
    let command_id = reader.string(128)?;
    let terminal_instance_id = reader.string(128)?;
    let broker_server = reader.string(128)?;
    let login = reader.string(64)?;
    let connection_epoch = reader.i64()?;
    let deadline_utc_msc = reader.i64()?;
    let action = decode_action(reader.i32()?)?;
    let symbol = reader.string(64)?;
    let side = decode_side(reader.i32()?)?;
    let order_kind = decode_kind(reader.i32()?)?;
    let ticket = reader.i64()?;
    let volume = read_number(&mut reader, true)?
        .ok_or_else(|| Mt4ProtocolError::new("mt4_pipe_number_invalid"))?;
    let price = read_number(&mut reader, false)?;
    let stop_loss = read_number(&mut reader, false)?;
    let take_profit = read_number(&mut reader, false)?;
    let deviation = reader.i32()?;
    let magic = reader.i32()?;
    let expiration = reader.i64()?;
    let expected_stop_loss = read_number(&mut reader, false)?;
    let expected_take_profit = read_number(&mut reader, false)?;
    let comment = reader.string(64)?;
    let expected_kind = reader.string(16)?;
    let bridge_command_ref = reader.string(64)?;
    let expected_volume = if reader.remaining() > 0 {
        read_number(&mut reader, false)?
    } else {
        None
    };
    let command = TradeCommand {
        command_id,
        terminal_instance_id,
        broker_server,
        login,
        connection_epoch,
        deadline_utc_msc,
        action,
        symbol,
        side,
        order_kind,
        ticket,
        volume,
        price,
        stop_loss,
        take_profit,
        deviation,
        magic,
        expiration,
        expected_stop_loss,
        expected_take_profit,
        comment,
        expected_kind,
        bridge_command_ref,
        expected_volume,
    };
    reader.finish()?;
    validate_command(&command)?;
    Ok(command)
}

pub fn encode_command_result(result: &TradeResult) -> Result<Vec<u8>, Mt4ProtocolError> {
    validate_result(result)?;
    let mut writer = PayloadWriter::new(MessageType::CommandResult);
    writer.string(&result.command_id)?;
    writer.i32(status_code(&result.status)?);
    writer.string(result.error_code.as_deref().unwrap_or_default())?;
    writer.string(result.error_message.as_deref().unwrap_or_default())?;
    writer.i32(result.broker_retcode);
    writer.i64(result.ticket);
    writer.i64(result.observed_at_utc_msc);
    let raw = result
        .raw_result
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| Mt4ProtocolError::new("mt4_command_raw_result_invalid"))?
        .unwrap_or_default();
    writer.string(&raw)?;
    writer.finish()
}

pub fn decode_command_result(payload: &[u8]) -> Result<TradeResult, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::CommandResult)?;
    let command_id = reader.string(128)?;
    let status = match reader.i32()? {
        1 => "succeeded",
        2 => "rejected",
        3 => "uncertain",
        _ => return Err(Mt4ProtocolError::new("mt4_command_result_status_invalid")),
    }
    .to_owned();
    let error_code = non_empty(reader.string(128)?);
    let error_message = non_empty(reader.string(1_024)?);
    let broker_retcode = reader.i32()?;
    let ticket = reader.i64()?;
    let observed_at_utc_msc = reader.i64()?;
    let raw = reader.string(MAX_STRING_BYTES)?;
    let raw_result = if raw.is_empty() {
        None
    } else {
        Some(
            serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(Value::is_object)
                .ok_or_else(|| Mt4ProtocolError::new("mt4_command_raw_result_invalid"))?,
        )
    };
    reader.finish()?;
    let result = TradeResult {
        command_id,
        status,
        error_code,
        error_message,
        broker_retcode,
        ticket,
        observed_at_utc_msc,
        raw_result,
    };
    validate_result(&result)?;
    Ok(result)
}

fn validate_command(command: &TradeCommand) -> Result<(), Mt4ProtocolError> {
    if !bounded_non_empty(&command.command_id, 128)
        || !bounded_non_empty(&command.terminal_instance_id, 128)
        || !bounded_non_empty(&command.broker_server, 128)
        || !bounded_non_empty(&command.login, 64)
        || command.connection_epoch <= 0
        || command.deadline_utc_msc <= 0
        || command.deviation < 0
        || command.expiration < 0
        || command.ticket > i64::from(i32::MAX)
        || !finite(command.volume)
        || !optional_finite(command.price)
        || !optional_finite(command.stop_loss)
        || !optional_finite(command.take_profit)
        || !optional_finite(command.expected_stop_loss)
        || !optional_finite(command.expected_take_profit)
        || !optional_finite(command.expected_volume)
    {
        return Err(Mt4ProtocolError::new("mt4_command_route_invalid"));
    }
    if command.action == TradeAction::PlaceOrder
        && (command.symbol.is_empty()
            || command.symbol.len() > 64
            || command.side == OrderSide::None
            || command.order_kind == OrderKind::None
            || command.volume <= 0.0)
    {
        return Err(Mt4ProtocolError::new("mt4_place_order_params_invalid"));
    }
    if matches!(
        command.action,
        TradeAction::CancelOrder
            | TradeAction::ModifyOrder
            | TradeAction::ModifyPosition
            | TradeAction::ClosePosition
    ) && command.ticket <= 0
    {
        return Err(Mt4ProtocolError::new("ticket_required"));
    }
    if command.action == TradeAction::QueryExecution
        && command.ticket <= 0
        && command.bridge_command_ref.trim().is_empty()
    {
        return Err(Mt4ProtocolError::new("bridge_reference_required"));
    }
    if command.comment.len() > 64
        || command.bridge_command_ref.len() > 64
        || !matches!(command.expected_kind.as_str(), "" | "trade" | "pending")
    {
        return Err(Mt4ProtocolError::new("mt4_command_query_params_invalid"));
    }
    if command.action == TradeAction::ClosePosition && command.volume < 0.0 {
        return Err(Mt4ProtocolError::new("close_volume_invalid"));
    }
    if command.expected_volume.is_some_and(|value| value <= 0.0) {
        return Err(Mt4ProtocolError::new("management_expected_state_invalid"));
    }
    if command.action == TradeAction::ClosePosition
        && command
            .expected_volume
            .is_some_and(|expected| command.volume > expected + 1e-8)
    {
        return Err(Mt4ProtocolError::new("close_volume_invalid"));
    }
    if command.action == TradeAction::ModifyPosition
        && (command.symbol.is_empty()
            || command.side == OrderSide::None
            || command.volume <= 0.0
            || command.stop_loss.is_none() && command.take_profit.is_none())
    {
        return Err(Mt4ProtocolError::new("mt4_modify_position_params_invalid"));
    }
    Ok(())
}

fn validate_result(result: &TradeResult) -> Result<(), Mt4ProtocolError> {
    if !bounded_non_empty(&result.command_id, 128)
        || result.observed_at_utc_msc <= 0
        || !matches!(
            result.status.as_str(),
            "succeeded" | "rejected" | "uncertain"
        )
        || result.error_code.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 128
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
        || result
            .error_message
            .as_ref()
            .is_some_and(|value| value.len() > 1_024)
        || result
            .raw_result
            .as_ref()
            .is_some_and(|value| !value.is_object())
    {
        return Err(Mt4ProtocolError::new("mt4_command_result_invalid"));
    }
    Ok(())
}

fn status_code(status: &str) -> Result<i32, Mt4ProtocolError> {
    match status {
        "succeeded" => Ok(1),
        "rejected" => Ok(2),
        "uncertain" => Ok(3),
        _ => Err(Mt4ProtocolError::new("mt4_command_result_status_invalid")),
    }
}

fn decode_action(value: i32) -> Result<TradeAction, Mt4ProtocolError> {
    match value {
        1 => Ok(TradeAction::PlaceOrder),
        2 => Ok(TradeAction::CancelOrder),
        3 => Ok(TradeAction::ModifyOrder),
        4 => Ok(TradeAction::ClosePosition),
        5 => Ok(TradeAction::QueryExecution),
        6 => Ok(TradeAction::ModifyPosition),
        _ => Err(Mt4ProtocolError::new("mt4_command_route_invalid")),
    }
}

fn decode_side(value: i32) -> Result<OrderSide, Mt4ProtocolError> {
    match value {
        0 => Ok(OrderSide::None),
        1 => Ok(OrderSide::Buy),
        2 => Ok(OrderSide::Sell),
        _ => Err(Mt4ProtocolError::new("mt4_command_route_invalid")),
    }
}

fn decode_kind(value: i32) -> Result<OrderKind, Mt4ProtocolError> {
    match value {
        0 => Ok(OrderKind::None),
        1 => Ok(OrderKind::Market),
        2 => Ok(OrderKind::Limit),
        3 => Ok(OrderKind::Stop),
        _ => Err(Mt4ProtocolError::new("mt4_command_route_invalid")),
    }
}

fn write_number(writer: &mut PayloadWriter, value: Option<f64>) -> Result<(), Mt4ProtocolError> {
    if !optional_finite(value) {
        return Err(Mt4ProtocolError::new("mt4_pipe_number_invalid"));
    }
    writer.string(&value.map(|number| number.to_string()).unwrap_or_default())
}

fn read_number(
    reader: &mut PayloadReader<'_>,
    required: bool,
) -> Result<Option<f64>, Mt4ProtocolError> {
    let value = reader.string(64)?;
    if value.is_empty() && !required {
        return Ok(None);
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(Some)
        .ok_or_else(|| Mt4ProtocolError::new("mt4_pipe_number_invalid"))
}

fn bounded_non_empty(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.trim() == value && value.len() <= maximum
}

fn finite(value: f64) -> bool {
    value.is_finite()
}

fn optional_finite(value: Option<f64>) -> bool {
    value.is_none_or(f64::is_finite)
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn optional_string(
    params: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<String>, Mt4ProtocolError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= 128 && value.trim() == value => {
            Ok(Some(value.clone()))
        }
        _ => Err(Mt4ProtocolError::new("mt4_command_params_invalid")),
    }
}

fn optional_i64(
    params: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<i64>, Mt4ProtocolError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| Mt4ProtocolError::new("mt4_command_params_invalid")),
        Some(Value::String(value)) if !value.is_empty() => value
            .parse::<i64>()
            .ok()
            .map(Some)
            .ok_or_else(|| Mt4ProtocolError::new("mt4_command_params_invalid")),
        _ => Err(Mt4ProtocolError::new("mt4_command_params_invalid")),
    }
}

fn optional_i32(
    params: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<i32>, Mt4ProtocolError> {
    optional_i64(params, name)?
        .map(|value| {
            i32::try_from(value).map_err(|_| Mt4ProtocolError::new("mt4_command_params_invalid"))
        })
        .transpose()
}

fn optional_f64(
    params: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<f64>, Mt4ProtocolError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or_else(|| Mt4ProtocolError::new("mt4_command_params_invalid")),
        _ => Err(Mt4ProtocolError::new("mt4_command_params_invalid")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> TradeCommand {
        TradeCommand {
            command_id: "command_01JMT4TRADE01".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: "12345678".to_owned(),
            connection_epoch: 7,
            deadline_utc_msc: 1_800_000_010_000,
            action: TradeAction::PlaceOrder,
            symbol: "XAUUSD.s".to_owned(),
            side: OrderSide::Buy,
            order_kind: OrderKind::Market,
            ticket: 0,
            volume: 0.01,
            price: None,
            stop_loss: Some(2000.0),
            take_profit: Some(2100.0),
            deviation: 20,
            magic: 234000,
            expiration: 0,
            expected_stop_loss: None,
            expected_take_profit: None,
            comment: "AI-MT4-01".to_owned(),
            expected_kind: String::new(),
            bridge_command_ref: String::new(),
            expected_volume: None,
        }
    }

    #[test]
    fn command_round_trip_matches_the_existing_dotnet_and_ea_field_order() {
        let mut expected = command();
        expected.expected_volume = Some(0.02);
        let encoded = encode_command(&expected).expect("encode command");
        assert_eq!(i32::from_le_bytes(encoded[..4].try_into().unwrap()), 20);
        assert_eq!(decode_command(&encoded).expect("decode command"), expected);
    }

    #[test]
    fn decoder_accepts_the_legacy_command_without_expected_volume() {
        let expected = command();
        let mut encoded = encode_command(&expected).expect("encode command");
        encoded.truncate(encoded.len() - 4);

        assert_eq!(
            decode_command(&encoded).expect("decode legacy command"),
            expected
        );
    }

    #[test]
    fn invalid_trade_params_fail_before_the_ea_pipe() {
        let mut invalid = command();
        invalid.volume = 0.0;
        assert_eq!(
            encode_command(&invalid).expect_err("invalid volume").code(),
            "mt4_place_order_params_invalid"
        );
        invalid = command();
        invalid.action = TradeAction::QueryExecution;
        invalid.symbol.clear();
        invalid.side = OrderSide::None;
        invalid.order_kind = OrderKind::Market;
        invalid.volume = 0.0;
        assert_eq!(
            encode_command(&invalid)
                .expect_err("missing reconciliation identity")
                .code(),
            "bridge_reference_required"
        );
    }

    #[test]
    fn command_result_round_trip_preserves_uncertain_evidence() {
        let result = TradeResult {
            command_id: "command_01JMT4TRADE01".to_owned(),
            status: "uncertain".to_owned(),
            error_code: Some("mt4_order_send_uncertain".to_owned()),
            error_message: None,
            broker_retcode: 128,
            ticket: 900719925,
            observed_at_utc_msc: 1_800_000_000_100,
            raw_result: Some(serde_json::json!({ "found": true })),
        };
        assert_eq!(
            decode_command_result(&encode_command_result(&result).expect("encode result"))
                .expect("decode result"),
            result
        );
    }

    #[test]
    fn bridge_command_conversion_preserves_string_tickets_and_management_evidence() {
        let bridge = CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JMT4CLOSE01".to_owned(),
            sent_at_utc_msc: 1_800_000_000_000,
            command_id: "command_01JMT4CLOSE01".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: 1_800_000_000_000,
            deadline_utc_msc: 1_800_000_010_000,
            action: "close_position".to_owned(),
            params: serde_json::json!({
                "ticket": "2147483647",
                "symbol": "XAUUSD.s",
                "side": "buy",
                "volume": 0.01,
                "magic": 234000
            }),
        };
        let local = command_from_bridge(&bridge).expect("local command");
        assert_eq!(local.ticket, 2147483647);
        let result = result_to_bridge(
            &bridge,
            TradeResult {
                command_id: bridge.command_id.clone(),
                status: "succeeded".to_owned(),
                error_code: None,
                error_message: None,
                broker_retcode: 0,
                ticket: local.ticket,
                observed_at_utc_msc: 1_800_000_000_100,
                raw_result: None,
            },
            "result_01JMT4CLOSE01".to_owned(),
        )
        .expect("bridge result");
        assert_eq!(result.evidence.position_tickets, ["2147483647"]);
        assert!(result.evidence.order_tickets.is_empty());
    }

    #[test]
    fn partial_close_keeps_requested_volume_separate_from_expected_position_state() {
        let bridge = CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JMT4PARTIAL01".to_owned(),
            sent_at_utc_msc: 1_800_000_000_000,
            command_id: "command_01JMT4PARTIAL01".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: 1_800_000_000_000,
            deadline_utc_msc: 1_800_000_010_000,
            action: "close_position".to_owned(),
            params: serde_json::json!({
                "volume": 0.01,
                "expected_state": {
                    "ticket": "501",
                    "symbol": "XAUUSD.s",
                    "direction": "buy",
                    "volume": 0.02,
                    "magic": 234000
                }
            }),
        };

        let local = command_from_bridge(&bridge).expect("partial close command");
        assert_eq!(local.ticket, 501);
        assert_eq!(local.symbol, "XAUUSD.s");
        assert_eq!(local.side, OrderSide::Buy);
        assert_eq!(local.volume, 0.01);
        assert_eq!(local.expected_volume, Some(0.02));
        assert_eq!(local.magic, 234000);
    }

    #[test]
    fn partial_close_rejects_amount_larger_than_expected_position() {
        let mut invalid = command();
        invalid.action = TradeAction::ClosePosition;
        invalid.ticket = 501;
        invalid.volume = 0.02;
        invalid.expected_volume = Some(0.01);

        assert_eq!(
            encode_command(&invalid)
                .expect_err("close exceeds expected volume")
                .code(),
            "close_volume_invalid"
        );
    }

    #[test]
    fn bridge_command_rejects_non_object_expected_state() {
        let bridge = CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JMT4EXPECTED01".to_owned(),
            sent_at_utc_msc: 1_800_000_000_000,
            command_id: "command_01JMT4EXPECTED01".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: 1_800_000_000_000,
            deadline_utc_msc: 1_800_000_010_000,
            action: "close_position".to_owned(),
            params: serde_json::json!({
                "ticket": "501",
                "volume": 0.01,
                "expected_state": "invalid"
            }),
        };

        assert_eq!(
            command_from_bridge(&bridge)
                .expect_err("expected state type")
                .code(),
            "management_expected_state_invalid"
        );
    }

    #[test]
    fn reconciliation_never_claims_success_without_required_mt4_evidence() {
        let original_issued_at = 1_800_000_000_000_i64;
        let query = CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JMT4QUERY01".to_owned(),
            sent_at_utc_msc: original_issued_at + 31_000,
            command_id: "query_01JMT4QUERY01".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: original_issued_at + 31_000,
            deadline_utc_msc: original_issued_at + 41_000,
            action: "query_execution".to_owned(),
            params: serde_json::json!({
                "ticket": "501",
                "expected_kind": "trade",
                "original_action": "close_position",
                "original_params": {
                    "ticket": "501",
                    "volume": 0.01,
                    "expected_state": { "volume": 0.01 }
                },
                "original_command_id": "command_01JMT4CLOSE01",
                "original_issued_at_utc_msc": original_issued_at,
                "settle_after_msc": 30_000
            }),
        };
        let incomplete = result_to_bridge(
            &query,
            TradeResult {
                command_id: query.command_id.clone(),
                status: "succeeded".to_owned(),
                error_code: None,
                error_message: None,
                broker_retcode: 0,
                ticket: 0,
                observed_at_utc_msc: original_issued_at + 31_000,
                raw_result: Some(serde_json::json!({
                    "found": false,
                    "complete": false,
                    "reason": "mt4_history_range_unverified"
                })),
            },
            "result_01JMT4QUERY01".to_owned(),
        )
        .expect("incomplete result");
        assert_eq!(
            incomplete.raw_result.expect("raw")["resolution"]["status"],
            "pending"
        );
    }

    #[test]
    fn reconciliation_resolves_verified_close_and_position_modification() {
        let issued = 1_800_000_000_000_i64;
        let base = CommandMessage {
            v: 3,
            message_type: "command".to_owned(),
            message_id: "message_01JMT4QUERY02".to_owned(),
            sent_at_utc_msc: issued + 1_000,
            command_id: "query_01JMT4QUERY02".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            account_ref: bridge_contract::AccountRef {
                broker_server: "Broker-Demo".to_owned(),
                login: "12345678".to_owned(),
            },
            connection_epoch: 7,
            issued_at_utc_msc: issued + 1_000,
            deadline_utc_msc: issued + 11_000,
            action: "query_execution".to_owned(),
            params: serde_json::json!({
                "ticket": "501",
                "expected_kind": "trade",
                "original_action": "close_position",
                "original_params": {
                    "ticket": "501",
                    "volume": 0.01,
                    "expected_state": { "volume": 0.01 }
                },
                "original_command_id": "command_01JMT4CLOSE02",
                "original_issued_at_utc_msc": issued,
                "settle_after_msc": 30_000
            }),
        };
        let closed = result_to_bridge(
            &base,
            TradeResult {
                command_id: base.command_id.clone(),
                status: "succeeded".to_owned(),
                error_code: None,
                error_message: None,
                broker_retcode: 0,
                ticket: 501,
                observed_at_utc_msc: issued + 1_000,
                raw_result: Some(serde_json::json!({
                    "found": true,
                    "complete": true,
                    "source": "history_deal",
                    "order": "501",
                    "position_id": "501"
                })),
            },
            "result_01JMT4QUERY02".to_owned(),
        )
        .expect("closed result");
        assert_eq!(
            closed.raw_result.expect("raw")["resolution"]["status"],
            "succeeded"
        );

        let mut modified_query = base;
        modified_query.command_id = "query_01JMT4QUERY03".to_owned();
        modified_query.params = serde_json::json!({
            "ticket": "501",
            "expected_kind": "trade",
            "original_action": "modify_position",
            "original_params": {
                "ticket": "501",
                "stop_loss": 2000.0,
                "take_profit": 2100.0
            },
            "original_command_id": "command_01JMT4MODIFY03",
            "original_issued_at_utc_msc": issued,
            "settle_after_msc": 30_000
        });
        let modified = result_to_bridge(
            &modified_query,
            TradeResult {
                command_id: modified_query.command_id.clone(),
                status: "succeeded".to_owned(),
                error_code: None,
                error_message: None,
                broker_retcode: 0,
                ticket: 501,
                observed_at_utc_msc: issued + 1_000,
                raw_result: Some(serde_json::json!({
                    "found": true,
                    "complete": true,
                    "source": "active_position",
                    "position_id": "501",
                    "stop_loss": 2000.00001,
                    "take_profit": 2100.0,
                    "point": 0.0001
                })),
            },
            "result_01JMT4QUERY03".to_owned(),
        )
        .expect("modified result");
        assert_eq!(
            modified.raw_result.expect("raw")["resolution"]["status"],
            "succeeded"
        );
    }
}
