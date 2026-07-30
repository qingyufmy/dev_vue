use bridge_mt4::{
    EaIdentity, EaRegistrationHub, Mt4EaSnapshotSource, Mt4SnapshotSourceSpec, OrderKind,
    OrderSide, TradeAction, TradeCommand,
};
use bridge_terminal_data::SnapshotSource;
use bridge_worker_host::{SnapshotStream, WorkerRoute};
use serde_json::{Value, json};
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SYSTEM_MAGIC: i32 = 234000;

struct Arguments {
    terminal_data_path: PathBuf,
    broker_server: String,
    login: String,
    symbol: String,
    volume: f64,
    execute: bool,
    partial_close: bool,
    matrix: bool,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let result = match parse_arguments().and_then(validate_arguments) {
        Ok(arguments) => run(arguments).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(report) => {
            println!("{report}");
        }
        Err(error) => {
            println!("{}", json!({ "passed": false, "error": error }));
            std::process::exit(1);
        }
    }
}

async fn run(arguments: Arguments) -> Result<Value, String> {
    let now = now_msc()?;
    let terminal_instance_id = format!("mt4_demo_acceptance_{now}");
    let route = WorkerRoute {
        terminal_instance_id,
        platform: "mt4".to_owned(),
        account_ref: bridge_contract::AccountRef {
            broker_server: arguments.broker_server.clone(),
            login: arguments.login.clone(),
        },
        connection_epoch: 1,
    };
    let identity = EaIdentity::new(
        &arguments.terminal_data_path,
        arguments.broker_server.clone(),
        arguments.login.clone(),
    )
    .map_err(protocol_error)?;
    let (hub, hub_handle) =
        EaRegistrationHub::bind(Duration::from_secs(10)).map_err(protocol_error)?;
    let registration = hub_handle.subscribe(identity).map_err(protocol_error)?;
    let hub_task = tokio::spawn(hub.run());
    let source = Arc::new(
        Mt4EaSnapshotSource::new(
            Mt4SnapshotSourceSpec {
                route: route.clone(),
                terminal_data_path: arguments.terminal_data_path.clone(),
                accept_timeout: Duration::from_secs(45),
                request_timeout: Duration::from_secs(15),
            },
            registration,
        )
        .map_err(protocol_error)?,
    );

    let outcome = exercise(source.clone(), route, arguments).await;
    source.close().await;
    hub_handle.stop();
    let _ = tokio::time::timeout(Duration::from_secs(2), hub_task).await;
    outcome
}

async fn exercise(
    source: Arc<Mt4EaSnapshotSource>,
    route: WorkerRoute,
    arguments: Arguments,
) -> Result<Value, String> {
    let before = collect(&source, &route, "before").await?;
    let diagnostics = source
        .request_data(
            "demo_diagnostics".to_owned(),
            "diagnostics".to_owned(),
            json!({}),
        )
        .await
        .map_err(|error| error.code().to_owned())?;
    let symbol_snapshot = source
        .request_data(
            "demo_symbol".to_owned(),
            "symbol_snapshot".to_owned(),
            json!({ "symbol": arguments.symbol }),
        )
        .await
        .map_err(|error| error.code().to_owned())?;
    let resolved_symbol = symbol_snapshot
        .payload
        .get("symbol")
        .and_then(Value::as_str)
        .ok_or_else(|| "mt4_demo_symbol_invalid".to_owned())?
        .to_owned();
    let volume_min = symbol_snapshot
        .payload
        .pointer("/instrument/volume_min")
        .and_then(Value::as_f64)
        .ok_or_else(|| "mt4_demo_volume_contract_invalid".to_owned())?;
    let volume_max = symbol_snapshot
        .payload
        .pointer("/instrument/volume_max")
        .and_then(Value::as_f64)
        .ok_or_else(|| "mt4_demo_volume_contract_invalid".to_owned())?;
    let volume_step = symbol_snapshot
        .payload
        .pointer("/instrument/volume_step")
        .and_then(Value::as_f64)
        .ok_or_else(|| "mt4_demo_volume_contract_invalid".to_owned())?;
    let open_volume = if arguments.partial_close || arguments.matrix {
        arguments.volume * 2.0
    } else {
        arguments.volume
    };
    if arguments.volume + 1e-8 < volume_min {
        return Err("mt4_demo_volume_below_minimum".to_owned());
    }
    if open_volume > volume_max + 1e-8
        || !volume_aligned(arguments.volume, volume_step)
        || !volume_aligned(open_volume, volume_step)
    {
        return Err("mt4_demo_volume_contract_invalid".to_owned());
    }
    if matching_position(&before, &resolved_symbol, None).is_some() {
        return Err("mt4_demo_symbol_must_have_no_existing_position".to_owned());
    }
    if matching_order(&before, &resolved_symbol, None).is_some() {
        return Err("mt4_demo_symbol_must_have_no_existing_order".to_owned());
    }

    let readiness = json!({
        "account": arguments.login,
        "server": arguments.broker_server,
        "demo": true,
        "symbol": resolved_symbol,
        "volume": arguments.volume,
        "open_volume": open_volume,
        "partial_close": arguments.partial_close,
        "matrix": arguments.matrix,
        "volume_min": volume_min,
        "volume_max": volume_max,
        "volume_step": volume_step,
        "diagnostics": diagnostics.payload,
    });
    if !arguments.execute {
        return Ok(json!({ "mode": "read_only", "passed": true, "readiness": readiness }));
    }

    let suffix = now_msc()?;
    let comment = format!("LJ3M4-{}", suffix % 10_000_000);
    if arguments.matrix {
        let matrix = run_management_matrix(
            &source,
            &route,
            &resolved_symbol,
            arguments.volume,
            &symbol_snapshot.payload,
            &comment,
            suffix,
        )
        .await;
        return match matrix {
            Ok(report) => Ok(json!({
                "mode": "matrix",
                "readiness": readiness,
                "matrix": report,
                "passed": true,
            })),
            Err(error) => {
                let cleanup =
                    cleanup_symbol(&source, &route, &resolved_symbol, &comment, suffix).await;
                Err(format!("{error}:cleanup={cleanup}"))
            }
        };
    }
    let open = source
        .execute_trade(trade_command(
            &route,
            format!("command_mt4_demo_open_{suffix}"),
            TradeAction::PlaceOrder,
            &resolved_symbol,
            0,
            (open_volume, None),
            &comment,
        ))
        .await
        .map_err(protocol_error)?;
    if open.status != "succeeded" || open.ticket <= 0 {
        return Err(format!(
            "mt4_demo_open_failed:{}",
            open.error_code.unwrap_or_else(|| open.status.clone())
        ));
    }
    let after_open = match collect(&source, &route, "after_open").await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let cleanup = cleanup_position(
                &source,
                &route,
                &resolved_symbol,
                open.ticket,
                open_volume,
                &comment,
                suffix,
            )
            .await;
            return Err(format!(
                "mt4_demo_open_snapshot_failed:{error}:cleanup={cleanup}"
            ));
        }
    };
    let position = matching_position(&after_open, &resolved_symbol, Some(open.ticket))
        .ok_or_else(|| "mt4_demo_open_position_missing".to_owned())?;
    let position_volume = position
        .get("volume")
        .and_then(Value::as_f64)
        .ok_or_else(|| "mt4_demo_open_position_invalid".to_owned())?;

    let mut active_ticket = open.ticket;
    let mut active_volume = position_volume;
    let mut partial_result = None;
    if arguments.partial_close {
        let partial = match source
            .execute_trade(trade_command(
                &route,
                format!("command_mt4_demo_partial_{suffix}"),
                TradeAction::ClosePosition,
                &resolved_symbol,
                active_ticket,
                (arguments.volume, Some(active_volume)),
                &comment,
            ))
            .await
        {
            Ok(result) => result,
            Err(error) => {
                let error = protocol_error(error);
                let cleanup = cleanup_position(
                    &source,
                    &route,
                    &resolved_symbol,
                    active_ticket,
                    active_volume,
                    &comment,
                    suffix,
                )
                .await;
                return Err(format!(
                    "mt4_demo_partial_close_failed:{error}:cleanup={cleanup}"
                ));
            }
        };
        if partial.status != "succeeded" {
            let cleanup = cleanup_position(
                &source,
                &route,
                &resolved_symbol,
                active_ticket,
                active_volume,
                &comment,
                suffix,
            )
            .await;
            return Err(format!(
                "mt4_demo_partial_close_rejected:{}:cleanup={cleanup}",
                partial
                    .error_code
                    .as_deref()
                    .unwrap_or(partial.status.as_str())
            ));
        }
        let after_partial = match collect(&source, &route, "after_partial").await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                let cleanup =
                    cleanup_symbol_position(&source, &route, &resolved_symbol, &comment, suffix)
                        .await;
                return Err(format!(
                    "mt4_demo_partial_snapshot_failed:{error}:cleanup={cleanup}"
                ));
            }
        };
        let remaining = matching_position(&after_partial, &resolved_symbol, None)
            .ok_or_else(|| "mt4_demo_partial_remaining_missing".to_owned())?;
        active_ticket = position_ticket(remaining)
            .ok_or_else(|| "mt4_demo_partial_remaining_invalid".to_owned())?;
        active_volume = remaining
            .get("volume")
            .and_then(Value::as_f64)
            .ok_or_else(|| "mt4_demo_partial_remaining_invalid".to_owned())?;
        let expected_remaining = position_volume - arguments.volume;
        if (active_volume - expected_remaining).abs() > volume_step / 10.0 {
            let cleanup = cleanup_position(
                &source,
                &route,
                &resolved_symbol,
                active_ticket,
                active_volume,
                &comment,
                suffix,
            )
            .await;
            return Err(format!(
                "mt4_demo_partial_remaining_mismatch:{active_volume}:cleanup={cleanup}"
            ));
        }
        partial_result = Some(partial);
    }

    let close = match source
        .execute_trade(trade_command(
            &route,
            format!("command_mt4_demo_close_{suffix}"),
            TradeAction::ClosePosition,
            &resolved_symbol,
            active_ticket,
            (active_volume, Some(active_volume)),
            &comment,
        ))
        .await
    {
        Ok(result) => result,
        Err(error) => {
            let error = protocol_error(error);
            let cleanup = cleanup_position(
                &source,
                &route,
                &resolved_symbol,
                active_ticket,
                active_volume,
                &comment,
                suffix,
            )
            .await;
            return Err(format!("mt4_demo_close_failed:{error}:cleanup={cleanup}"));
        }
    };
    let after_close = match collect(&source, &route, "after_close").await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let cleanup = cleanup_position(
                &source,
                &route,
                &resolved_symbol,
                active_ticket,
                active_volume,
                &comment,
                suffix,
            )
            .await;
            return Err(format!(
                "mt4_demo_close_snapshot_failed:{error}:cleanup={cleanup}"
            ));
        }
    };
    let cleaned = matching_position(&after_close, &resolved_symbol, None).is_none();
    let report = json!({
        "mode": "execute",
        "readiness": readiness,
        "open": safe_result(&open),
        "partial_close": partial_result.as_ref().map(safe_result),
        "close": safe_result(&close),
        "position_ticket": open.ticket.to_string(),
        "cleaned": cleaned,
        "passed": open.status == "succeeded" && close.status == "succeeded" && cleaned,
    });
    if report["passed"] != Value::Bool(true) {
        let cleanup = cleanup_position(
            &source,
            &route,
            &resolved_symbol,
            active_ticket,
            active_volume,
            &comment,
            suffix,
        )
        .await;
        return Err(format!(
            "mt4_demo_cleanup_failed:{report}:cleanup={cleanup}"
        ));
    }
    Ok(report)
}

async fn collect(
    source: &Arc<Mt4EaSnapshotSource>,
    route: &WorkerRoute,
    label: &str,
) -> Result<bridge_worker_host::TerminalSnapshot, String> {
    source
        .collect_snapshot(
            route.clone(),
            format!("snapshot_{label}"),
            vec![
                SnapshotStream::Account,
                SnapshotStream::Positions,
                SnapshotStream::Orders,
            ],
        )
        .await
        .map_err(|error| error.code().to_owned())
}

fn matching_position<'a>(
    snapshot: &'a bridge_worker_host::TerminalSnapshot,
    symbol: &str,
    ticket: Option<i64>,
) -> Option<&'a Value> {
    snapshot
        .streams
        .positions
        .as_ref()?
        .iter()
        .find(|position| {
            position.get("symbol").and_then(Value::as_str) == Some(symbol)
                && ticket.is_none_or(|ticket| {
                    position
                        .get("ticket")
                        .and_then(Value::as_str)
                        .and_then(|value| value.parse::<i64>().ok())
                        == Some(ticket)
                })
        })
}

fn matching_order<'a>(
    snapshot: &'a bridge_worker_host::TerminalSnapshot,
    symbol: &str,
    ticket: Option<i64>,
) -> Option<&'a Value> {
    snapshot.streams.orders.as_ref()?.iter().find(|order| {
        order.get("symbol").and_then(Value::as_str) == Some(symbol)
            && ticket.is_none_or(|ticket| position_ticket(order) == Some(ticket))
    })
}

fn position_ticket(position: &Value) -> Option<i64> {
    position
        .get("ticket")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<i64>().ok())
}

fn volume_aligned(volume: f64, step: f64) -> bool {
    step > 0.0 && (volume / step - (volume / step).round()).abs() <= 1e-8
}

fn trade_command(
    route: &WorkerRoute,
    command_id: String,
    action: TradeAction,
    symbol: &str,
    ticket: i64,
    volumes: (f64, Option<f64>),
    comment: &str,
) -> TradeCommand {
    let now = now_msc().unwrap_or(1);
    TradeCommand {
        command_id,
        terminal_instance_id: route.terminal_instance_id.clone(),
        broker_server: route.account_ref.broker_server.clone(),
        login: route.account_ref.login.clone(),
        connection_epoch: route.connection_epoch,
        deadline_utc_msc: now.saturating_add(30_000),
        action,
        symbol: symbol.to_owned(),
        side: OrderSide::Buy,
        order_kind: OrderKind::Market,
        ticket,
        volume: volumes.0,
        price: None,
        stop_loss: None,
        take_profit: None,
        deviation: 30,
        magic: SYSTEM_MAGIC,
        expiration: 0,
        expected_stop_loss: None,
        expected_take_profit: None,
        comment: comment.to_owned(),
        expected_kind: String::new(),
        bridge_command_ref: String::new(),
        expected_volume: volumes.1,
    }
}

async fn run_management_matrix(
    source: &Arc<Mt4EaSnapshotSource>,
    route: &WorkerRoute,
    symbol: &str,
    volume: f64,
    symbol_snapshot: &Value,
    comment: &str,
    suffix: i64,
) -> Result<Value, String> {
    let instrument = symbol_snapshot
        .get("instrument")
        .and_then(Value::as_object)
        .ok_or_else(|| "mt4_demo_instrument_invalid".to_owned())?;
    let point = instrument
        .get("point")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "mt4_demo_point_invalid".to_owned())?;
    let volume_min = instrument
        .get("volume_min")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "mt4_demo_volume_contract_invalid".to_owned())?;
    let digits = instrument
        .get("digits")
        .and_then(Value::as_i64)
        .filter(|value| (0..=10).contains(value))
        .ok_or_else(|| "mt4_demo_digits_invalid".to_owned())? as i32;
    let stops_level = instrument
        .get("trade_stops_level")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let freeze_level = instrument
        .get("trade_freeze_level")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let safety_points = (stops_level.max(freeze_level) + 200).max(1_000) as f64;
    let distance = safety_points * point;
    let price_tolerance = (point / 2.0).max(1e-8);

    let invalid_volume = volume_min / 2.0;
    let invalid_volume_result = source
        .execute_trade({
            let mut command = trade_command(
                route,
                format!("command_mt4_matrix_bad_volume_{suffix}"),
                TradeAction::PlaceOrder,
                symbol,
                0,
                (invalid_volume, None),
                comment,
            );
            command.order_kind = OrderKind::Market;
            command
        })
        .await
        .map_err(protocol_error)?;
    let expected_invalid_volume_code =
        format!("mt4_error_{}", invalid_volume_result.broker_retcode);
    if invalid_volume_result.status != "rejected"
        || invalid_volume_result.broker_retcode <= 0
        || invalid_volume_result.error_code.as_deref()
            != Some(expected_invalid_volume_code.as_str())
    {
        return Err(format!(
            "mt4_demo_invalid_volume_not_rejected:{}",
            safe_result(&invalid_volume_result)
        ));
    }

    let quote = request_quote(source, symbol, "matrix_pending").await?;
    let pending_price = normalize_price(quote.0 - distance, digits);
    let modified_price = normalize_price(quote.0 - distance * 2.0, digits);
    if pending_price <= 0.0 || modified_price <= 0.0 || modified_price >= pending_price {
        return Err("mt4_demo_pending_price_invalid".to_owned());
    }
    let pending = source
        .execute_trade({
            let mut command = trade_command(
                route,
                format!("command_mt4_matrix_pending_{suffix}"),
                TradeAction::PlaceOrder,
                symbol,
                0,
                (volume, None),
                comment,
            );
            command.order_kind = OrderKind::Limit;
            command.price = Some(pending_price);
            command
        })
        .await
        .map_err(protocol_error)?;
    require_succeeded(&pending, "mt4_demo_pending_place_failed")?;
    let pending_snapshot = collect(source, route, "matrix_pending_created").await?;
    let pending_target = matching_order(&pending_snapshot, symbol, Some(pending.ticket))
        .cloned()
        .ok_or_else(|| "mt4_demo_pending_order_missing".to_owned())?;
    require_price(
        &pending_target,
        "price_open",
        pending_price,
        price_tolerance,
        "mt4_demo_pending_price_mismatch",
    )?;

    let rejected_guard = source
        .execute_trade({
            let mut command = management_command(
                route,
                format!("command_mt4_matrix_guard_{suffix}"),
                TradeAction::ModifyOrder,
                &pending_target,
                comment,
            )?;
            command.price = Some(modified_price);
            command.magic = command.magic.saturating_add(1);
            command
        })
        .await
        .map_err(protocol_error)?;
    require_rejected(
        &rejected_guard,
        "management_magic_mismatch",
        "mt4_demo_modify_guard_not_rejected",
    )?;
    let guard_snapshot = collect(source, route, "matrix_guard_rejected").await?;
    let guarded_target = matching_order(&guard_snapshot, symbol, Some(pending.ticket))
        .cloned()
        .ok_or_else(|| "mt4_demo_guarded_pending_missing".to_owned())?;
    require_price(
        &guarded_target,
        "price_open",
        pending_price,
        price_tolerance,
        "mt4_demo_guard_changed_pending",
    )?;

    let modify = source
        .execute_trade({
            let mut command = management_command(
                route,
                format!("command_mt4_matrix_modify_{suffix}"),
                TradeAction::ModifyOrder,
                &guarded_target,
                comment,
            )?;
            command.price = Some(modified_price);
            command
        })
        .await
        .map_err(protocol_error)?;
    require_succeeded(&modify, "mt4_demo_pending_modify_failed")?;
    let modified_snapshot = collect(source, route, "matrix_pending_modified").await?;
    let modified_target = matching_order(&modified_snapshot, symbol, Some(pending.ticket))
        .cloned()
        .ok_or_else(|| "mt4_demo_modified_pending_missing".to_owned())?;
    require_price(
        &modified_target,
        "price_open",
        modified_price,
        price_tolerance,
        "mt4_demo_pending_modify_not_applied",
    )?;

    let cancel = source
        .execute_trade(management_command(
            route,
            format!("command_mt4_matrix_cancel_{suffix}"),
            TradeAction::CancelOrder,
            &modified_target,
            comment,
        )?)
        .await
        .map_err(protocol_error)?;
    require_succeeded(&cancel, "mt4_demo_pending_cancel_failed")?;
    let cancelled_snapshot = collect(source, route, "matrix_pending_cancelled").await?;
    if matching_order(&cancelled_snapshot, symbol, Some(pending.ticket)).is_some() {
        return Err("mt4_demo_pending_still_active".to_owned());
    }

    let open_volume = volume * 2.0;
    let open = source
        .execute_trade(trade_command(
            route,
            format!("command_mt4_matrix_open_{suffix}"),
            TradeAction::PlaceOrder,
            symbol,
            0,
            (open_volume, None),
            comment,
        ))
        .await
        .map_err(protocol_error)?;
    require_succeeded(&open, "mt4_demo_matrix_open_failed")?;
    let open_snapshot = collect(source, route, "matrix_position_opened").await?;
    let open_target = matching_position(&open_snapshot, symbol, Some(open.ticket))
        .cloned()
        .ok_or_else(|| "mt4_demo_matrix_position_missing".to_owned())?;

    let invalid_quote = request_quote(source, symbol, "matrix_invalid_protection").await?;
    let invalid_stop_loss = normalize_price(invalid_quote.1 + distance, digits);
    let invalid_protection = source
        .execute_trade({
            let mut command = management_command(
                route,
                format!("command_mt4_matrix_bad_protection_{suffix}"),
                TradeAction::ModifyPosition,
                &open_target,
                comment,
            )?;
            command.stop_loss = Some(invalid_stop_loss);
            command
        })
        .await
        .map_err(protocol_error)?;
    if invalid_protection.status != "rejected"
        || invalid_protection.error_code.as_deref()
            != Some("stop_loss_direction_or_distance_invalid")
    {
        return Err(format!(
            "mt4_demo_invalid_protection_not_rejected:input={invalid_stop_loss}:bid={}:ask={}:{}",
            invalid_quote.0,
            invalid_quote.1,
            safe_result(&invalid_protection)
        ));
    }
    let invalid_snapshot = collect(source, route, "matrix_invalid_protection_rejected").await?;
    let unprotected_target = matching_position(&invalid_snapshot, symbol, Some(open.ticket))
        .cloned()
        .ok_or_else(|| "mt4_demo_position_missing_after_rejection".to_owned())?;
    require_price(
        &unprotected_target,
        "stop_loss",
        0.0,
        price_tolerance,
        "mt4_demo_invalid_protection_changed_position",
    )?;

    let protection_quote = request_quote(source, symbol, "matrix_protection").await?;
    let stop_loss = normalize_price(protection_quote.0 - distance * 2.0, digits);
    let take_profit = normalize_price(protection_quote.1 + distance * 2.0, digits);
    let protect = source
        .execute_trade({
            let mut command = management_command(
                route,
                format!("command_mt4_matrix_protect_{suffix}"),
                TradeAction::ModifyPosition,
                &unprotected_target,
                comment,
            )?;
            command.stop_loss = Some(stop_loss);
            command.take_profit = Some(take_profit);
            command
        })
        .await
        .map_err(protocol_error)?;
    require_succeeded(&protect, "mt4_demo_position_protect_failed")?;
    let protected_snapshot = collect(source, route, "matrix_position_protected").await?;
    let protected_target = matching_position(&protected_snapshot, symbol, Some(open.ticket))
        .cloned()
        .ok_or_else(|| "mt4_demo_protected_position_missing".to_owned())?;
    require_price(
        &protected_target,
        "stop_loss",
        stop_loss,
        price_tolerance,
        "mt4_demo_stop_loss_not_applied",
    )?;
    require_price(
        &protected_target,
        "take_profit",
        take_profit,
        price_tolerance,
        "mt4_demo_take_profit_not_applied",
    )?;

    let partial = source
        .execute_trade({
            let mut command = management_command(
                route,
                format!("command_mt4_matrix_partial_{suffix}"),
                TradeAction::ClosePosition,
                &protected_target,
                comment,
            )?;
            command.volume = volume;
            command
        })
        .await
        .map_err(protocol_error)?;
    require_succeeded(&partial, "mt4_demo_matrix_partial_failed")?;
    let partial_snapshot = collect(source, route, "matrix_position_partial").await?;
    let remaining_target = matching_position(&partial_snapshot, symbol, None)
        .cloned()
        .ok_or_else(|| "mt4_demo_matrix_remaining_missing".to_owned())?;
    let remaining_volume = target_volume(&remaining_target)?;
    if (remaining_volume - volume).abs() > 1e-8 {
        return Err(format!(
            "mt4_demo_matrix_remaining_volume_mismatch:{remaining_volume}"
        ));
    }
    let remaining_ticket = position_ticket(&remaining_target)
        .ok_or_else(|| "mt4_demo_matrix_remaining_ticket_invalid".to_owned())?;

    let close = source
        .execute_trade({
            let mut command = management_command(
                route,
                format!("command_mt4_matrix_close_{suffix}"),
                TradeAction::ClosePosition,
                &remaining_target,
                comment,
            )?;
            command.volume = remaining_volume;
            command
        })
        .await
        .map_err(protocol_error)?;
    require_succeeded(&close, "mt4_demo_matrix_close_failed")?;
    let final_snapshot = collect(source, route, "matrix_final").await?;
    if matching_position(&final_snapshot, symbol, None).is_some()
        || matching_order(&final_snapshot, symbol, None).is_some()
    {
        return Err("mt4_demo_matrix_cleanup_incomplete".to_owned());
    }

    Ok(json!({
        "invalid_volume": safe_result(&invalid_volume_result),
        "pending_place": safe_result(&pending),
        "stale_guard_rejection": safe_result(&rejected_guard),
        "pending_modify": safe_result(&modify),
        "pending_cancel": safe_result(&cancel),
        "position_open": safe_result(&open),
        "invalid_protection": safe_result(&invalid_protection),
        "position_protect": safe_result(&protect),
        "partial_close": safe_result(&partial),
        "final_close": safe_result(&close),
        "pending_ticket": pending.ticket.to_string(),
        "position_ticket": open.ticket.to_string(),
        "remaining_ticket": remaining_ticket.to_string(),
        "cleaned": true,
    }))
}

async fn request_quote(
    source: &Arc<Mt4EaSnapshotSource>,
    symbol: &str,
    label: &str,
) -> Result<(f64, f64), String> {
    let quote = source
        .request_quote(format!("quote_{label}"), symbol.to_owned())
        .await
        .map_err(protocol_error)?;
    let bid = quote
        .bid
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "mt4_demo_quote_invalid".to_owned())?;
    let ask = quote
        .ask
        .filter(|value| value.is_finite() && *value >= bid)
        .ok_or_else(|| "mt4_demo_quote_invalid".to_owned())?;
    Ok((bid, ask))
}

fn normalize_price(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn management_command(
    route: &WorkerRoute,
    command_id: String,
    action: TradeAction,
    target: &Value,
    comment: &str,
) -> Result<TradeCommand, String> {
    let ticket =
        position_ticket(target).ok_or_else(|| "mt4_demo_management_ticket_invalid".to_owned())?;
    let symbol = target
        .get("symbol")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "mt4_demo_management_symbol_invalid".to_owned())?;
    let side = match target.get("side").and_then(Value::as_str) {
        Some("buy") => OrderSide::Buy,
        Some("sell") => OrderSide::Sell,
        _ => return Err("mt4_demo_management_side_invalid".to_owned()),
    };
    let volume = target_volume(target)?;
    let magic = target
        .get("magic")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| "mt4_demo_management_magic_invalid".to_owned())?;
    let mut command = trade_command(
        route,
        command_id,
        action,
        symbol,
        ticket,
        (0.0, Some(volume)),
        comment,
    );
    command.side = side;
    command.magic = magic;
    command.expected_stop_loss = target.get("stop_loss").and_then(Value::as_f64);
    command.expected_take_profit = target.get("take_profit").and_then(Value::as_f64);
    if action == TradeAction::ModifyPosition {
        command.volume = volume;
    }
    Ok(command)
}

fn target_volume(target: &Value) -> Result<f64, String> {
    target
        .get("volume")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "mt4_demo_management_volume_invalid".to_owned())
}

fn require_price(
    target: &Value,
    field: &str,
    expected: f64,
    tolerance: f64,
    code: &str,
) -> Result<(), String> {
    let actual = target
        .get(field)
        .and_then(Value::as_f64)
        .ok_or_else(|| code.to_owned())?;
    if (actual - expected).abs() > tolerance {
        return Err(format!("{code}:{actual}:{expected}"));
    }
    Ok(())
}

fn require_succeeded(result: &bridge_mt4::TradeResult, code: &str) -> Result<(), String> {
    if result.status == "succeeded" && result.ticket > 0 {
        return Ok(());
    }
    Err(format!("{code}:{}", safe_result(result)))
}

fn require_rejected(
    result: &bridge_mt4::TradeResult,
    expected_code: &str,
    code: &str,
) -> Result<(), String> {
    if result.status == "rejected" && result.error_code.as_deref() == Some(expected_code) {
        return Ok(());
    }
    Err(format!("{code}:{}", safe_result(result)))
}

async fn cleanup_symbol(
    source: &Arc<Mt4EaSnapshotSource>,
    route: &WorkerRoute,
    symbol: &str,
    comment: &str,
    suffix: i64,
) -> Value {
    let mut results = Vec::new();
    for attempt in 0..4 {
        let snapshot = match collect(source, route, &format!("matrix_cleanup_{attempt}")).await {
            Ok(snapshot) => snapshot,
            Err(error) => return json!({ "error": error, "results": results, "cleaned": false }),
        };
        let orders = snapshot
            .streams
            .orders
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("symbol").and_then(Value::as_str) == Some(symbol))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let positions = snapshot
            .streams
            .positions
            .as_ref()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item.get("symbol").and_then(Value::as_str) == Some(symbol))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if orders.is_empty() && positions.is_empty() {
            return json!({ "results": results, "cleaned": true });
        }
        for (index, order) in orders.iter().enumerate() {
            let command = match management_command(
                route,
                format!("command_mt4_matrix_cleanup_order_{suffix}_{attempt}_{index}"),
                TradeAction::CancelOrder,
                order,
                comment,
            ) {
                Ok(command) => command,
                Err(error) => {
                    results.push(json!({ "error": error }));
                    continue;
                }
            };
            match source.execute_trade(command).await {
                Ok(result) => results.push(safe_result(&result)),
                Err(error) => results.push(json!({ "error": error.code() })),
            }
        }
        for (index, position) in positions.iter().enumerate() {
            let mut command = match management_command(
                route,
                format!("command_mt4_matrix_cleanup_position_{suffix}_{attempt}_{index}"),
                TradeAction::ClosePosition,
                position,
                comment,
            ) {
                Ok(command) => command,
                Err(error) => {
                    results.push(json!({ "error": error }));
                    continue;
                }
            };
            command.volume = command.expected_volume.unwrap_or(0.0);
            match source.execute_trade(command).await {
                Ok(result) => results.push(safe_result(&result)),
                Err(error) => results.push(json!({ "error": error.code() })),
            }
        }
    }
    json!({ "results": results, "cleaned": false })
}

async fn cleanup_position(
    source: &Arc<Mt4EaSnapshotSource>,
    route: &WorkerRoute,
    symbol: &str,
    ticket: i64,
    volume: f64,
    comment: &str,
    suffix: i64,
) -> Value {
    let result = source
        .execute_trade(trade_command(
            route,
            format!("command_mt4_demo_cleanup_{suffix}"),
            TradeAction::ClosePosition,
            symbol,
            ticket,
            (volume, Some(volume)),
            comment,
        ))
        .await;
    let remaining = collect(source, route, "cleanup").await.ok();
    let cleaned = remaining
        .as_ref()
        .is_some_and(|snapshot| matching_position(snapshot, symbol, Some(ticket)).is_none());
    match result {
        Ok(result) => json!({ "result": safe_result(&result), "cleaned": cleaned }),
        Err(error) => json!({ "error": error.code(), "cleaned": cleaned }),
    }
}

async fn cleanup_symbol_position(
    source: &Arc<Mt4EaSnapshotSource>,
    route: &WorkerRoute,
    symbol: &str,
    comment: &str,
    suffix: i64,
) -> Value {
    let snapshot = match collect(source, route, "cleanup_symbol_lookup").await {
        Ok(snapshot) => snapshot,
        Err(error) => return json!({ "error": error, "cleaned": false }),
    };
    let Some(position) = matching_position(&snapshot, symbol, None) else {
        return json!({ "cleaned": true });
    };
    let Some(ticket) = position_ticket(position) else {
        return json!({ "error": "mt4_demo_cleanup_ticket_invalid", "cleaned": false });
    };
    let Some(volume) = position.get("volume").and_then(Value::as_f64) else {
        return json!({ "error": "mt4_demo_cleanup_volume_invalid", "cleaned": false });
    };
    cleanup_position(source, route, symbol, ticket, volume, comment, suffix).await
}

fn safe_result(result: &bridge_mt4::TradeResult) -> Value {
    json!({
        "status": result.status,
        "error_code": result.error_code,
        "error_message": result.error_message,
        "broker_retcode": result.broker_retcode,
        "ticket": result.ticket.to_string(),
        "observed_at_utc_msc": result.observed_at_utc_msc,
    })
}

fn parse_arguments() -> Result<Arguments, String> {
    let mut terminal_data_path = None;
    let mut broker_server = None;
    let mut login = None;
    let mut symbol = None;
    let mut volume = 0.01_f64;
    let mut execute = false;
    let mut partial_close = false;
    let mut matrix = false;
    let values = env::args().skip(1).collect::<Vec<_>>();
    let mut index = 0;
    while index < values.len() {
        match values[index].as_str() {
            "--terminal-data" | "--server" | "--login" | "--symbol" | "--volume" => {
                let name = values[index].clone();
                index += 1;
                let value = values
                    .get(index)
                    .cloned()
                    .ok_or_else(|| format!("missing_value:{name}"))?;
                match name.as_str() {
                    "--terminal-data" => terminal_data_path = Some(PathBuf::from(value)),
                    "--server" => broker_server = Some(value),
                    "--login" => login = Some(value),
                    "--symbol" => symbol = Some(value),
                    "--volume" => {
                        volume = value
                            .parse()
                            .map_err(|_| "mt4_demo_volume_invalid".to_owned())?
                    }
                    _ => unreachable!(),
                }
            }
            "--execute" => execute = true,
            "--partial-close" => partial_close = true,
            "--matrix" => matrix = true,
            _ => return Err(format!("unknown_argument:{}", values[index])),
        }
        index += 1;
    }
    Ok(Arguments {
        terminal_data_path: terminal_data_path
            .ok_or_else(|| "terminal_data_required".to_owned())?,
        broker_server: broker_server.ok_or_else(|| "broker_server_required".to_owned())?,
        login: login.ok_or_else(|| "login_required".to_owned())?,
        symbol: symbol.ok_or_else(|| "symbol_required".to_owned())?,
        volume,
        execute,
        partial_close,
        matrix,
    })
}

fn validate_arguments(arguments: Arguments) -> Result<Arguments, String> {
    if !arguments.terminal_data_path.is_absolute()
        || !arguments.terminal_data_path.is_dir()
        || !arguments
            .broker_server
            .to_ascii_lowercase()
            .contains("demo")
        || arguments.login.trim().is_empty()
        || arguments.symbol.trim().is_empty()
        || !arguments.volume.is_finite()
        || arguments.volume <= 0.0
        || (arguments.partial_close || arguments.matrix) && !arguments.execute
        || arguments.partial_close && arguments.matrix
    {
        return Err("mt4_demo_arguments_invalid".to_owned());
    }
    Ok(arguments)
}

fn now_msc() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "clock_invalid".to_owned())?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "clock_invalid".to_owned())
}

fn protocol_error(error: bridge_mt4::Mt4ProtocolError) -> String {
    error.code().to_owned()
}
