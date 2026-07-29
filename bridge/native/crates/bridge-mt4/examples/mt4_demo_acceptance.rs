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
    if arguments.volume + 1e-8 < volume_min {
        return Err("mt4_demo_volume_below_minimum".to_owned());
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
        "volume_min": volume_min,
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
            arguments.volume,
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
                arguments.volume,
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

    let close = match source
        .execute_trade(trade_command(
            &route,
            format!("command_mt4_demo_close_{suffix}"),
            TradeAction::ClosePosition,
            &resolved_symbol,
            open.ticket,
            position_volume,
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
                open.ticket,
                position_volume,
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
                open.ticket,
                position_volume,
                &comment,
                suffix,
            )
            .await;
            return Err(format!(
                "mt4_demo_close_snapshot_failed:{error}:cleanup={cleanup}"
            ));
        }
    };
    let cleaned = matching_position(&after_close, &resolved_symbol, Some(open.ticket)).is_none();
    let report = json!({
        "mode": "execute",
        "readiness": readiness,
        "open": safe_result(&open),
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
            open.ticket,
            position_volume,
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

fn trade_command(
    route: &WorkerRoute,
    command_id: String,
    action: TradeAction,
    symbol: &str,
    ticket: i64,
    volume: f64,
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
        volume,
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
            volume,
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
