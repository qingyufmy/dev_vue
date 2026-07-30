use crate::{MAX_STRING_BYTES, MessageType, Mt4ProtocolError, PayloadReader, PayloadWriter};
use serde_json::Value;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteFields {
    pub request_id: String,
    pub terminal_instance_id: String,
    pub broker_server: String,
    pub login: String,
    pub connection_epoch: i64,
}

impl RouteFields {
    fn validate(&self, code: &'static str) -> Result<(), Mt4ProtocolError> {
        if self.request_id.trim().is_empty()
            || self.request_id.len() > 128
            || self.terminal_instance_id.trim().is_empty()
            || self.terminal_instance_id.len() > 128
            || self.broker_server.trim().is_empty()
            || self.broker_server.len() > 128
            || self.login.trim().is_empty()
            || self.login.len() > 64
            || self.connection_epoch <= 0
        {
            return Err(Mt4ProtocolError::new(code));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QuoteRequest {
    pub route: RouteFields,
    pub symbol: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub request_id: String,
    pub symbol: String,
    pub observed_at_utc_msc: i64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub error_code: Option<String>,
    pub timezone_offset_minutes: Option<i32>,
    pub clock_status: Option<String>,
    pub digits: Option<i32>,
    pub point: Option<f64>,
    pub symbol_trade_mode: Option<i32>,
}

impl Quote {
    pub fn succeeded(&self) -> bool {
        self.error_code.is_none()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RatesRequest {
    pub route: RouteFields,
    pub symbol: String,
    pub timeframe: String,
    pub count: i32,
    pub start_utc_msc: i64,
    pub end_utc_msc: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SymbolSnapshotRequest {
    pub route: RouteFields,
    pub symbol: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RiskSnapshotRequest {
    pub route: RouteFields,
    pub symbol: String,
    pub last_deal_time_msc: i64,
    pub last_deal_ticket: i64,
    pub baseline_from_utc_msc: i64,
    pub proposed_symbol: String,
    pub proposed_order_type: String,
    pub proposed_volume: Option<f64>,
    pub proposed_entry_price: Option<f64>,
    pub proposed_stop_loss: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PerformanceDailyRequest {
    pub route: RouteFields,
    pub date_from: String,
    pub date_to: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtendedDataRequest {
    pub route: RouteFields,
    pub action: String,
    pub date_from: String,
    pub date_to: String,
    pub entry_from: String,
    pub entry_to: String,
    pub direction: String,
    pub profit_filter: String,
    pub page: i32,
    pub page_size: i32,
    pub include_deals: bool,
    pub compact: bool,
    pub ticket: i64,
    pub expected_broker_server: String,
    pub expected_login: String,
    pub expected_ticket: i64,
    pub expected_symbol: String,
    pub expected_direction: String,
    pub expected_volume: Option<f64>,
    pub expected_magic: i32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DealsRequest {
    pub terminal_instance_id: String,
    pub broker_server: String,
    pub login: String,
    pub connection_epoch: i64,
    pub cursor_time_msc: i64,
    pub cursor_ticket: i64,
    pub limit: i32,
    pub window_msc: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DealsBatch {
    pub source_time_msc: i64,
    pub items: Vec<Value>,
    pub next_time_msc: i64,
    pub next_ticket: i64,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataResult {
    pub request_id: String,
    pub observed_at_utc_msc: i64,
    pub payload: Option<Value>,
    pub error_code: Option<String>,
}

impl DataResult {
    pub fn succeeded(&self) -> bool {
        self.error_code.is_none()
    }
}

pub fn encode_quote_request(request: &QuoteRequest) -> Result<Vec<u8>, Mt4ProtocolError> {
    request.route.validate("mt4_quote_request_invalid")?;
    validate_symbol(&request.symbol, "mt4_quote_request_invalid")?;
    let mut writer = PayloadWriter::new(MessageType::QuoteRequest);
    write_route(&mut writer, &request.route)?;
    writer.string(&request.symbol)?;
    writer.finish()
}

pub fn decode_quote(payload: &[u8]) -> Result<Quote, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Quote)?;
    let request_id = reader.string(128)?;
    let symbol = reader.string(64)?;
    let observed_at_utc_msc = reader.i64()?;
    let succeeded = decode_status(&mut reader, "mt4_quote_status_invalid")?;
    let bid = read_optional_number(&mut reader)?;
    let ask = read_optional_number(&mut reader)?;
    let error_code = non_empty(reader.string(128)?);
    let mut timezone_offset_minutes = None;
    let mut clock_status = None;
    let mut digits = None;
    let mut point = None;
    let mut symbol_trade_mode = None;
    if reader.remaining() > 0 {
        timezone_offset_minutes = optional_i32(reader.i32()?);
        clock_status = non_empty(reader.string(64)?);
    }
    if reader.remaining() > 0 {
        digits = optional_i32(reader.i32()?);
        point = read_optional_number(&mut reader)?;
        symbol_trade_mode = optional_i32(reader.i32()?);
    }
    reader.finish()?;
    let result = Quote {
        request_id,
        symbol,
        observed_at_utc_msc,
        bid,
        ask,
        error_code,
        timezone_offset_minutes,
        clock_status,
        digits,
        point,
        symbol_trade_mode,
    };
    if result.request_id.trim().is_empty()
        || result.symbol.trim().is_empty()
        || result.observed_at_utc_msc <= 0
        || succeeded != result.succeeded()
        || succeeded
            && (result.bid.is_none()
                || result.ask.is_none()
                || result.bid.is_some_and(|value| value <= 0.0)
                || result.ask.is_some_and(|value| value <= 0.0)
                || result
                    .ask
                    .zip(result.bid)
                    .is_some_and(|(ask, bid)| ask < bid))
        || result
            .timezone_offset_minutes
            .is_some_and(|value| !(-840..=840).contains(&value))
        || result
            .digits
            .is_some_and(|value| !(0..=16).contains(&value))
        || result.point.is_some_and(|value| value <= 0.0)
        || result
            .symbol_trade_mode
            .is_some_and(|value| !(0..=4).contains(&value))
    {
        return Err(Mt4ProtocolError::new("mt4_quote_invalid"));
    }
    Ok(result)
}

pub fn encode_rates_request(request: &RatesRequest) -> Result<Vec<u8>, Mt4ProtocolError> {
    request.route.validate("mt4_rates_request_invalid")?;
    validate_symbol(&request.symbol, "mt4_rates_request_invalid")?;
    if !matches!(
        request.timeframe.as_str(),
        "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1"
    ) || !(2..=5_000).contains(&request.count)
        || request.start_utc_msc < 0
        || request.end_utc_msc < 0
        || (request.start_utc_msc > 0 || request.end_utc_msc > 0)
            && !(request.start_utc_msc > 0 && request.end_utc_msc > request.start_utc_msc)
    {
        return Err(Mt4ProtocolError::new("mt4_rates_request_invalid"));
    }
    let mut writer = PayloadWriter::new(MessageType::RatesRequest);
    write_route(&mut writer, &request.route)?;
    writer.string(&request.symbol)?;
    writer.string(&request.timeframe)?;
    writer.i32(request.count);
    writer.i64(request.start_utc_msc);
    writer.i64(request.end_utc_msc);
    writer.finish()
}

pub fn decode_rates(payload: &[u8]) -> Result<DataResult, Mt4ProtocolError> {
    decode_data_result(
        payload,
        MessageType::Rates,
        "mt4_rates_status_invalid",
        "mt4_rates_payload_invalid",
        "mt4_rates_invalid",
    )
}

pub fn encode_symbol_snapshot_request(
    request: &SymbolSnapshotRequest,
) -> Result<Vec<u8>, Mt4ProtocolError> {
    request
        .route
        .validate("mt4_symbol_snapshot_request_invalid")?;
    validate_symbol(&request.symbol, "mt4_symbol_snapshot_request_invalid")?;
    let mut writer = PayloadWriter::new(MessageType::SymbolSnapshotRequest);
    write_route(&mut writer, &request.route)?;
    writer.string(&request.symbol)?;
    writer.finish()
}

pub fn decode_symbol_snapshot(payload: &[u8]) -> Result<DataResult, Mt4ProtocolError> {
    decode_data_result(
        payload,
        MessageType::SymbolSnapshot,
        "mt4_symbol_snapshot_status_invalid",
        "mt4_symbol_snapshot_payload_invalid",
        "mt4_symbol_snapshot_invalid",
    )
}

pub fn encode_risk_snapshot_request(
    request: &RiskSnapshotRequest,
) -> Result<Vec<u8>, Mt4ProtocolError> {
    request
        .route
        .validate("mt4_risk_snapshot_request_invalid")?;
    validate_symbol(&request.symbol, "mt4_risk_snapshot_request_invalid")?;
    let has_proposed = !request.proposed_symbol.is_empty()
        || !request.proposed_order_type.is_empty()
        || request.proposed_volume.is_some()
        || request.proposed_entry_price.is_some()
        || request.proposed_stop_loss.is_some();
    if request.last_deal_time_msc < 0
        || request.last_deal_ticket < 0
        || request.baseline_from_utc_msc < 0
        || has_proposed
            && (validate_symbol(
                &request.proposed_symbol,
                "mt4_risk_snapshot_request_invalid",
            )
            .is_err()
                || !matches!(
                    request.proposed_order_type.as_str(),
                    "buy" | "sell" | "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop"
                )
                || !positive(request.proposed_volume)
                || !positive(request.proposed_entry_price)
                || !positive(request.proposed_stop_loss))
    {
        return Err(Mt4ProtocolError::new("mt4_risk_snapshot_request_invalid"));
    }
    let mut writer = PayloadWriter::new(MessageType::RiskSnapshotRequest);
    write_route(&mut writer, &request.route)?;
    writer.string(&request.symbol)?;
    writer.i64(request.last_deal_time_msc);
    writer.i64(request.last_deal_ticket);
    writer.i64(request.baseline_from_utc_msc);
    writer.string(&request.proposed_symbol)?;
    writer.string(&request.proposed_order_type)?;
    write_optional_number(&mut writer, request.proposed_volume)?;
    write_optional_number(&mut writer, request.proposed_entry_price)?;
    write_optional_number(&mut writer, request.proposed_stop_loss)?;
    writer.finish()
}

pub fn decode_risk_snapshot(payload: &[u8]) -> Result<DataResult, Mt4ProtocolError> {
    decode_data_result(
        payload,
        MessageType::RiskSnapshot,
        "mt4_risk_snapshot_status_invalid",
        "mt4_risk_snapshot_payload_invalid",
        "mt4_risk_snapshot_invalid",
    )
}

pub fn encode_performance_daily_request(
    request: &PerformanceDailyRequest,
) -> Result<Vec<u8>, Mt4ProtocolError> {
    request.route.validate("mt4_performance_request_invalid")?;
    let from = date_day_number(&request.date_from);
    let to = date_day_number(&request.date_to);
    if from.is_none()
        || to.is_none()
        || to < from
        || to.zip(from).is_some_and(|(to, from)| to - from > 30)
    {
        return Err(Mt4ProtocolError::new("mt4_performance_request_invalid"));
    }
    let mut writer = PayloadWriter::new(MessageType::PerformanceDailyRequest);
    write_route(&mut writer, &request.route)?;
    writer.string(&request.date_from)?;
    writer.string(&request.date_to)?;
    writer.finish()
}

pub fn decode_performance_daily(payload: &[u8]) -> Result<DataResult, Mt4ProtocolError> {
    decode_data_result(
        payload,
        MessageType::PerformanceDaily,
        "mt4_performance_status_invalid",
        "mt4_performance_payload_invalid",
        "mt4_performance_invalid",
    )
}

pub fn encode_extended_data_request(
    request: &ExtendedDataRequest,
) -> Result<Vec<u8>, Mt4ProtocolError> {
    request
        .route
        .validate("mt4_extended_data_request_invalid")?;
    let history = matches!(request.action.as_str(), "history" | "chart_data");
    if !matches!(
        request.action.as_str(),
        "symbols" | "history" | "chart_data" | "pending_order_state" | "diagnostics"
    ) || [
        &request.date_from,
        &request.date_to,
        &request.entry_from,
        &request.entry_to,
    ]
    .into_iter()
    .any(|value| !value.is_empty() && !valid_date(value))
        || history && (request.page < 1 || !(1..=10_000).contains(&request.page_size))
        || !matches!(request.direction.as_str(), "" | "buy" | "sell")
        || !matches!(request.profit_filter.as_str(), "" | "profit" | "loss")
        || request.action == "pending_order_state" && request.ticket <= 0
        || request.expected_ticket < 0
        || request.expected_symbol.len() > 64
        || !matches!(request.expected_direction.as_str(), "" | "buy" | "sell")
        || request.expected_volume.is_some_and(|value| value <= 0.0)
        || request.expected_magic < 0
    {
        return Err(Mt4ProtocolError::new("mt4_extended_data_request_invalid"));
    }
    let mut writer = PayloadWriter::new(MessageType::ExtendedDataRequest);
    write_route(&mut writer, &request.route)?;
    writer.string(&request.action)?;
    writer.string(&request.date_from)?;
    writer.string(&request.date_to)?;
    writer.string(&request.entry_from)?;
    writer.string(&request.entry_to)?;
    writer.string(&request.direction)?;
    writer.string(&request.profit_filter)?;
    writer.i32(request.page);
    writer.i32(request.page_size);
    writer.boolean(request.include_deals);
    writer.boolean(request.compact);
    writer.i64(request.ticket);
    writer.string(&request.expected_broker_server)?;
    writer.string(&request.expected_login)?;
    writer.i64(request.expected_ticket);
    writer.string(&request.expected_symbol)?;
    writer.string(&request.expected_direction)?;
    write_optional_number(&mut writer, request.expected_volume)?;
    writer.i32(request.expected_magic);
    writer.finish()
}

pub fn decode_extended_data(payload: &[u8]) -> Result<DataResult, Mt4ProtocolError> {
    decode_data_result(
        payload,
        MessageType::ExtendedData,
        "mt4_extended_data_status_invalid",
        "mt4_extended_data_payload_invalid",
        "mt4_extended_data_invalid",
    )
}

pub fn encode_deals_request(request: &DealsRequest) -> Result<Vec<u8>, Mt4ProtocolError> {
    if request.terminal_instance_id.trim().is_empty()
        || request.broker_server.trim().is_empty()
        || request.login.trim().is_empty()
        || request.connection_epoch <= 0
        || request.cursor_time_msc <= 0
        || request.cursor_ticket < 0
        || !(1..=250).contains(&request.limit)
        || !(86_400_000..=crate::MAX_HISTORY_WINDOW_MSC).contains(&request.window_msc)
    {
        return Err(Mt4ProtocolError::new("mt4_deals_request_invalid"));
    }
    let mut writer = PayloadWriter::new(MessageType::DealsRequest);
    writer.string(&request.terminal_instance_id)?;
    writer.string(&request.broker_server)?;
    writer.string(&request.login)?;
    writer.i64(request.connection_epoch);
    writer.i64(request.cursor_time_msc);
    writer.i64(request.cursor_ticket);
    writer.i32(request.limit);
    writer.i64(request.window_msc);
    writer.finish()
}

pub fn decode_deals(payload: &[u8]) -> Result<DealsBatch, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, MessageType::Deals)?;
    let source_time_msc = reader.i64()?;
    let items = parse_array(
        &reader.string(MAX_STRING_BYTES)?,
        "mt4_deals_payload_invalid",
    )?;
    let next_time_msc = reader.i64()?;
    let next_ticket = reader.i64()?;
    let has_more = reader.boolean()?;
    reader.finish()?;
    if source_time_msc <= 0
        || next_time_msc <= 0
        || next_ticket < 0
        || items.len() > 250
        || items.iter().any(|item| !valid_deal(item))
    {
        return Err(Mt4ProtocolError::new("mt4_deals_invalid"));
    }
    Ok(DealsBatch {
        source_time_msc,
        items,
        next_time_msc,
        next_ticket,
        has_more,
    })
}

pub fn encode_deals(batch: &DealsBatch) -> Result<Vec<u8>, Mt4ProtocolError> {
    if batch.source_time_msc <= 0
        || batch.next_time_msc <= 0
        || batch.next_ticket < 0
        || batch.items.len() > 250
        || batch.items.iter().any(|item| !valid_deal(item))
    {
        return Err(Mt4ProtocolError::new("mt4_deals_invalid"));
    }
    let mut writer = PayloadWriter::new(MessageType::Deals);
    writer.i64(batch.source_time_msc);
    let items = serde_json::to_string(&batch.items)
        .map_err(|_| Mt4ProtocolError::new("mt4_deals_payload_invalid"))?;
    writer.string(&items)?;
    writer.i64(batch.next_time_msc);
    writer.i64(batch.next_ticket);
    writer.boolean(batch.has_more);
    writer.finish()
}

fn decode_data_result(
    payload: &[u8],
    expected: MessageType,
    status_code: &'static str,
    payload_code: &'static str,
    result_code: &'static str,
) -> Result<DataResult, Mt4ProtocolError> {
    let mut reader = PayloadReader::new(payload, expected)?;
    let request_id = reader.string(128)?;
    let observed_at_utc_msc = reader.i64()?;
    let succeeded = decode_status(&mut reader, status_code)?;
    let payload_text = reader.string(MAX_STRING_BYTES)?;
    let payload = if payload_text.is_empty() {
        None
    } else {
        Some(parse_object(&payload_text, payload_code)?)
    };
    let error_code = non_empty(reader.string(128)?);
    reader.finish()?;
    if request_id.trim().is_empty()
        || observed_at_utc_msc <= 0
        || succeeded != error_code.is_none()
        || succeeded != payload.is_some()
    {
        return Err(Mt4ProtocolError::new(result_code));
    }
    Ok(DataResult {
        request_id,
        observed_at_utc_msc,
        payload,
        error_code,
    })
}

fn write_route(writer: &mut PayloadWriter, route: &RouteFields) -> Result<(), Mt4ProtocolError> {
    writer.string(&route.request_id)?;
    writer.string(&route.terminal_instance_id)?;
    writer.string(&route.broker_server)?;
    writer.string(&route.login)?;
    writer.i64(route.connection_epoch);
    Ok(())
}

fn decode_status(
    reader: &mut PayloadReader<'_>,
    code: &'static str,
) -> Result<bool, Mt4ProtocolError> {
    match reader.i32()? {
        1 => Ok(true),
        2 => Ok(false),
        _ => Err(Mt4ProtocolError::new(code)),
    }
}

fn validate_symbol(value: &str, code: &'static str) -> Result<(), Mt4ProtocolError> {
    if value.is_empty() || value.trim() != value || value.len() > 64 {
        Err(Mt4ProtocolError::new(code))
    } else {
        Ok(())
    }
}

fn write_optional_number(
    writer: &mut PayloadWriter,
    value: Option<f64>,
) -> Result<(), Mt4ProtocolError> {
    if value.is_some_and(|number| !number.is_finite()) {
        return Err(Mt4ProtocolError::new("mt4_pipe_number_invalid"));
    }
    writer.string(&value.map(|number| number.to_string()).unwrap_or_default())
}

fn read_optional_number(reader: &mut PayloadReader<'_>) -> Result<Option<f64>, Mt4ProtocolError> {
    let value = reader.string(64)?;
    if value.is_empty() {
        return Ok(None);
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(Some)
        .ok_or_else(|| Mt4ProtocolError::new("mt4_pipe_number_invalid"))
}

fn positive(value: Option<f64>) -> bool {
    value.is_some_and(|number| number.is_finite() && number > 0.0)
}

fn optional_i32(value: i32) -> Option<i32> {
    (value != i32::MIN).then_some(value)
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn valid_date(value: &str) -> bool {
    date_day_number(value).is_some()
}

fn date_day_number(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return None;
    }
    let year = i64::from(ascii_number(&bytes[0..4])?);
    let month = i64::from(ascii_number(&bytes[5..7])?);
    let day = i64::from(ascii_number(&bytes[8..10])?);
    if !(1..=9_999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=maximum_day).contains(&day) {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era)
}

fn ascii_number(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0_u32, |value, byte| {
        byte.is_ascii_digit()
            .then(|| value * 10 + u32::from(byte - b'0'))
    })
}

fn parse_object(value: &str, code: &'static str) -> Result<Value, Mt4ProtocolError> {
    serde_json::from_str(value)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| Mt4ProtocolError::new(code))
}

fn parse_array(value: &str, code: &'static str) -> Result<Vec<Value>, Mt4ProtocolError> {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .ok_or_else(|| Mt4ProtocolError::new(code))
}

fn valid_deal(item: &Value) -> bool {
    item.is_object()
        && item
            .get("ticket")
            .is_some_and(|value| value.is_string() || value.is_number())
        && item
            .get("time_msc")
            .and_then(Value::as_i64)
            .is_some_and(|value| value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> RouteFields {
        RouteFields {
            request_id: "data_01".to_owned(),
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: "12345678".to_owned(),
            connection_epoch: 7,
        }
    }

    fn append_string(bytes: &mut Vec<u8>, value: &str) {
        bytes.extend_from_slice(&(value.len() as i32).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }

    #[test]
    fn rates_request_matches_the_existing_dotnet_and_ea_binary_contract() {
        let request = RatesRequest {
            route: route(),
            symbol: "XAUUSD.s".to_owned(),
            timeframe: "M5".to_owned(),
            count: 300,
            start_utc_msc: 1_800_000_000_000,
            end_utc_msc: 1_800_090_000_000,
        };
        let mut expected = (MessageType::RatesRequest as i32).to_le_bytes().to_vec();
        append_string(&mut expected, "data_01");
        append_string(&mut expected, "mt4_0123456789abcdef01234567");
        append_string(&mut expected, "Broker-Demo");
        append_string(&mut expected, "12345678");
        expected.extend_from_slice(&7_i64.to_le_bytes());
        append_string(&mut expected, "XAUUSD.s");
        append_string(&mut expected, "M5");
        expected.extend_from_slice(&300_i32.to_le_bytes());
        expected.extend_from_slice(&1_800_000_000_000_i64.to_le_bytes());
        expected.extend_from_slice(&1_800_090_000_000_i64.to_le_bytes());
        assert_eq!(
            encode_rates_request(&request).expect("rates request"),
            expected
        );
    }

    #[test]
    fn common_data_response_requires_a_correlated_success_payload_or_rejection_code() {
        let mut success = PayloadWriter::new(MessageType::Rates);
        success.string("data_01").expect("request id");
        success.i64(1_800_000_000_000);
        success.i32(1);
        success
            .string(r#"{"source":"mt4","rates":[]}"#)
            .expect("payload");
        success.string("").expect("error");
        let decoded = decode_rates(&success.finish().expect("response")).expect("decode");
        assert_eq!(decoded.payload.expect("payload")["source"], "mt4");

        let mut invalid = PayloadWriter::new(MessageType::Rates);
        invalid.string("data_01").expect("request id");
        invalid.i64(1_800_000_000_000);
        invalid.i32(2);
        invalid.string("").expect("payload");
        invalid.string("").expect("error");
        assert_eq!(
            decode_rates(&invalid.finish().expect("response"))
                .expect_err("rejection must include code")
                .code(),
            "mt4_rates_invalid"
        );
    }

    #[test]
    fn deals_are_bounded_to_the_ea_cursor_page_contract() {
        let maximum_window = DealsRequest {
            terminal_instance_id: "mt4_0123456789abcdef01234567".to_owned(),
            broker_server: "Broker-Demo".to_owned(),
            login: "12345678".to_owned(),
            connection_epoch: 7,
            cursor_time_msc: 946_684_800_000,
            cursor_ticket: 0,
            limit: 250,
            window_msc: crate::MAX_HISTORY_WINDOW_MSC,
        };
        encode_deals_request(&maximum_window).expect("full archive window");
        assert_eq!(
            encode_deals_request(&DealsRequest {
                window_msc: crate::MAX_HISTORY_WINDOW_MSC + 1,
                ..maximum_window
            })
            .expect_err("history window must remain bounded")
            .code(),
            "mt4_deals_request_invalid"
        );

        let batch = DealsBatch {
            source_time_msc: 1_800_000_000_000,
            items: vec![serde_json::json!({ "ticket": "91", "time_msc": 1_700_000_000_000_i64 })],
            next_time_msc: 1_700_000_000_000,
            next_ticket: 91,
            has_more: true,
        };
        assert_eq!(
            decode_deals(&encode_deals(&batch).expect("encode deals")).expect("decode deals"),
            batch
        );
        let mut oversized = batch;
        oversized.items = (0..251)
            .map(|ticket| serde_json::json!({ "ticket": ticket, "time_msc": 1_700_000_000_000_i64 + ticket }))
            .collect();
        assert_eq!(
            encode_deals(&oversized).expect_err("oversized page").code(),
            "mt4_deals_invalid"
        );
    }

    #[test]
    fn calendar_dates_are_exact_and_performance_range_is_at_most_thirty_days() {
        assert!(valid_date("2024-02-29"));
        assert!(!valid_date("2023-02-29"));
        assert!(!valid_date("２０２４-01-01"));
        let valid = PerformanceDailyRequest {
            route: route(),
            date_from: "2026-07-01".to_owned(),
            date_to: "2026-07-31".to_owned(),
        };
        encode_performance_daily_request(&valid).expect("thirty-day range");
        let invalid = PerformanceDailyRequest {
            date_to: "2026-08-01".to_owned(),
            ..valid
        };
        assert_eq!(
            encode_performance_daily_request(&invalid)
                .expect_err("thirty-one-day range")
                .code(),
            "mt4_performance_request_invalid"
        );
    }
}
