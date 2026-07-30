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
    let open_volume = if arguments.partial_close {
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

    let readiness = json!({
        "account": arguments.login,
        "server": arguments.broker_server,
        "demo": true,
        "symbol": resolved_symbol,
        "volume": arguments.volume,
        "open_volume": open_volume,
        "partial_close": arguments.partial_close,
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
        || arguments.partial_close && !arguments.execute
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
