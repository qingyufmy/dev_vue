import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../bridge/adapters/mt4-ea/AURUMBridgeEA.mq4', import.meta.url), 'utf8')

function functionBlock(name, nextName) {
  const start = source.indexOf(`${name}(`)
  const end = nextName ? source.indexOf(`${nextName}(`, start + name.length) : source.length
  return source.slice(start, end)
}

describe('MT4 EA time contract', () => {
  it('normalizes broker quote time to UTC before publishing it', () => {
    const block = functionBlock('void SendQuoteResult', 'int ResolveTimeframe')
    expect(source).toContain('#property version   "3.04"')
    expect(block).toContain('ServerTimeToUtcMsc(source_time, CurrentServerOffsetMsc())')
    expect(block).toContain('AppendInt32(response, CurrentServerOffsetMinutes())')
    expect(block).toContain('AppendUtf8(response, CurrentServerClockStatus())')
    expect(block).toContain('MarketInfo(symbol, MODE_DIGITS)')
    expect(block).toContain('MarketInfo(symbol, MODE_POINT)')
    expect(block).toContain('MarketInfo(symbol, MODE_TRADEALLOWED)')
    expect(block).not.toContain('(source_time > 0 ? source_time : (long)TimeGMT()) * 1000')
  })

  it('converts UTC range bounds to broker time and publishes normalized candle times', () => {
    const block = functionBlock('void SendRates', 'void SendRatesResult')
    expect(block).toContain('(end_utc_msc + server_offset_msc) / 1000')
    expect(block).toContain('(start_utc_msc + server_offset_msc) / 1000')
    expect(block).toContain('long bar_utc_msc = bar_server_msc - server_offset_msc')
    expect(block).toContain('time_server_msc')
    expect(block).toContain('clock_status')
    expect(block).toContain('CurrentServerClockStatus()')
    expect(block).toContain('clock_sample_age_ms')
    expect(block).toContain('rates_clock_unavailable')
  })

  it('normalizes symbol-snapshot observation time as well', () => {
    const block = functionBlock('void SendSymbolSnapshot', 'void SendSymbolSnapshotResult')
    expect(block).toContain('ServerTimeToUtcMsc(')
    expect(block).toContain('timezone_offset_minutes')
    expect(block).toContain('CurrentServerClockStatus()')
    expect(block).toContain('clock_sample_age_ms')
  })

  it('freezes the last valid broker offset while ticks are not advancing', () => {
    const refresh = functionBlock('void RefreshServerOffsetFromFreshTick', 'long ServerOffsetSampleAgeMsc')
    expect(refresh).toContain('server_now <= g_last_server_clock')
    expect(refresh).toContain('GlobalVariableSet(OffsetGlobalKey("Minutes")')
    expect(refresh).toContain('GlobalVariableSet(OffsetGlobalKey("SampleUtc")')
    expect(source).toContain('mt4_cached_offset')
    expect(source).not.toContain('((long)TimeCurrent() - (long)TimeGMT()) * 1000')
  })

  it('isolates the persisted offset by both account login and broker server', () => {
    const key = functionBlock('string OffsetGlobalKey', 'bool ValidServerOffsetMinutes')
    expect(source).toContain('long StableServerIdentityHash(const string value)')
    expect(key).toContain('IntegerToString(AccountNumber())')
    expect(key).toContain('StableServerIdentityHash(AccountServer())')
  })
})

describe('MT4 EA binary string contract', () => {
  it('returns an actual empty string instead of decoding the remaining payload', () => {
    const block = functionBlock('string ReadUtf8', null)
    expect(block).toContain('if(length == 0)')
    expect(block).toContain('return("")')
    expect(block.indexOf('if(length == 0)')).toBeLessThan(block.indexOf('CharArrayToString('))
  })
})

describe('MT4 EA reconnect contract', () => {
  it('returns to the public registration pipe after every disconnect', () => {
    const block = functionBlock('void DisconnectPipe', 'void SendSnapshot')
    expect(block).toContain('g_pipe_name = InpPipeName')
    expect(block.indexOf('FileClose(g_pipe)')).toBeLessThan(block.indexOf('g_pipe_name = InpPipeName'))
  })
})

describe('MT4 EA extended data contract', () => {
  it('advertises the compatible 3.0.4 adapter and handles every server data action', () => {
    expect(source).toContain('#define BRIDGE_PROTOCOL_VERSION 3')
    expect(source).toContain('#define ADAPTER_VERSION "3.0.4"')
    expect(source).toContain('#property version   "3.04"')
    expect(source).toContain('AppendInt32(hello, BRIDGE_PROTOCOL_VERSION)')
    expect(source).toContain('AppendUtf8(hello, ADAPTER_VERSION)')
    const block = functionBlock('void SendExtendedData', 'void SendExtendedDataResult')
    for (const action of ['symbols', 'history', 'chart_data', 'pending_order_state', 'diagnostics']) {
      expect(block).toContain(`action == "${action}"`)
    }
  })

  it('reports the MT4 account-history range limitation explicitly', () => {
    expect(source).toContain('\\"history_source_complete\\":false')
    expect(source).toContain('mt4_account_history_tab_range')
  })

  it('reports every independent trading-permission layer', () => {
    const diagnostics = functionBlock('string BuildDiagnosticsPayload', 'void SendExtendedData')
    const account = functionBlock('string BuildAccountJson', 'void BuildOrderSnapshots')
    const command = functionBlock('void ExecuteCommand', 'void ExecutePlace')

    expect(diagnostics).toContain('AccountTradeAllowed()')
    expect(diagnostics).toContain('AccountExpertTradeAllowed()')
    expect(diagnostics).toContain('TerminalTradeAllowed()')
    expect(diagnostics).toContain('ProgramTradeAllowed()')
    expect(account).toContain('\\"trade_expert\\"')
    expect(account).toContain('\\"terminal_trade_allowed\\"')
    expect(account).toContain('\\"program_trade_allowed\\"')
    expect(command).toContain('SendTradePermissionFailure(command_id)')
  })
})

describe('MT4 EA broker-symbol contract', () => {
  it('resolves standard symbols to the broker suffix before terminal access', () => {
    const resolver = functionBlock('string StandardSymbolName', 'void SendQuote')
    expect(resolver).toContain('string ResolveBrokerSymbol')
    expect(resolver).toContain('SymbolsTotal(false)')
    expect(resolver).toContain('StandardSymbolName(candidate)')
    expect(resolver).toContain('SymbolSelect(candidate, true)')

    for (const [name, next] of [
      ['void SendQuote', 'void SendQuoteResult'],
      ['void SendRates', 'void SendRatesResult'],
      ['void SendSymbolSnapshot', 'void SendSymbolSnapshotResult'],
      ['void SendRiskSnapshot', 'void SendRiskSnapshotResult'],
      ['void ExecutePlace', 'void ExecuteCancel'],
    ]) {
      expect(functionBlock(name, next)).toContain('ResolveBrokerSymbol(')
    }
  })
})

describe('MT4 EA instrument risk metadata contract', () => {
  it('normalizes every symbol-data outlet through one tick-size reader', () => {
    const reader = functionBlock('void ReadInstrumentRiskSpec', 'string InstrumentRiskSpecJsonFields')
    expect(reader).toContain('MarketInfo(symbol, MODE_TICKSIZE)')
    expect(reader).toContain('SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE)')
    expect(reader).toContain('spec.tick_size_raw_marketinfo * spec.point')
    expect(reader).toContain('symbol_info_trade_tick_size')
    expect(reader).toContain('market_info_tick_size_points')
    expect(reader).toContain('marketinfo_semantic_mismatch')

    for (const [name, next] of [
      ['void SendSymbolSnapshot', 'void SendSymbolSnapshotResult'],
      ['string RiskInstrumentJson', 'void AddRiskInstrument'],
      ['string BuildSymbolsPayload', 'string BuildHistoryPayload'],
    ]) {
      const block = functionBlock(name, next)
      expect(block).toContain('ReadInstrumentRiskSpec(symbol, instrument_spec)')
      expect(block).toContain('InstrumentRiskSpecJsonFields(instrument_spec)')
      expect(block).not.toContain('MarketInfo(symbol, MODE_TICKSIZE)')
    }
  })

  it('publishes raw candidates, the selected source, and validation evidence', () => {
    const fields = functionBlock('string InstrumentRiskSpecJsonFields', 'void SendSymbolSnapshot')
    for (const key of [
      'platform',
      'ea_version',
      'tick_size_raw_marketinfo',
      'tick_size_marketinfo_price_candidate',
      'tick_size_symbolinfo_candidate',
      'tick_size_source',
      'instrument_validation_status',
      'instrument_validation_reasons',
    ]) expect(fields).toContain(key)
  })
})

describe('MT4 EA snapshot performance contract', () => {
  it('uses a bounded millisecond timer instead of a one-second request ceiling', () => {
    const initBlock = functionBlock('int OnInit', 'void OnDeinit')
    expect(source).toContain('#define REQUEST_TIMER_MSC 200')
    expect(initBlock).toContain('EventSetMillisecondTimer(REQUEST_TIMER_MSC)')
    expect(initBlock).not.toContain('EventSetTimer(1)')
  })

  it('scans active orders once when publishing positions and pending orders', () => {
    const sendBlock = functionBlock('void SendSnapshot', 'void SendQuote')
    const buildBlock = functionBlock('void BuildOrderSnapshots', 'string BuildSelectedOrderJson')

    expect(sendBlock).toContain('BuildOrderSnapshots(streams, positions_json, orders_json)')
    expect(buildBlock.match(/OrdersTotal\(\)/g)).toHaveLength(1)
    expect(buildBlock).toContain('include_positions')
    expect(buildBlock).toContain('include_orders')
    expect(functionBlock('string BuildSelectedOrderJson', 'string JsonNumber')).toContain('\\"price_current\\"')
  })
})

describe('MT4 EA history paging performance contract', () => {
  it('builds the terminal history index once and reuses it across cursor pages', () => {
    const index = functionBlock('bool EnsureHistoryCursorIndex', 'void SendDeals')
    const send = functionBlock('void SendDeals', 'string ServerDateTimeText')

    expect(index.match(/OrdersHistoryTotal\(\)/g)).toHaveLength(1)
    expect(index).toContain('g_history_index_total == history_total')
    expect(index).toContain('g_history_index_login == AccountNumber()')
    expect(index).toContain('g_history_index_server == AccountServer()')
    expect(send).toContain('EnsureHistoryCursorIndex(server_offset_msc)')
    expect(send).toContain('ArraySize(g_history_event_times)')
    expect(send).not.toContain('OrdersHistoryTotal()')
    expect(send).not.toContain('OrderSelect(history_index, SELECT_BY_POS, MODE_HISTORY)')
  })

  it('emits explicit MT4 trade close-time evidence from the selected order', () => {
    const block = functionBlock('string BuildSelectedHistoryDealJson', 'bool EnsureHistoryCursorIndex')
    expect(block).toContain('bool is_trade = order_type == OP_BUY || order_type == OP_SELL')
    expect(block).toContain('((long)OrderOpenTime()) * 1000')
    expect(block).toContain('((long)OrderCloseTime()) * 1000')
    expect(block).toContain('entry_time_utc_msc')
    expect(block).toContain('close_time_utc_msc')
    expect(block).toContain('close_time_server_msc')
    expect(block).toContain('close_timezone_offset_minutes')
    expect(block).toContain('close_business_date')
    expect(block).toContain('close_deal_ticket')
    expect(block).toContain('ServerDateText(OrderCloseTime())')
    expect(block).toContain('server_offset_msc')
  })
})

describe('MT4 EA uncertain execution contract', () => {
  it('does not claim an absent order when the MT4 history range cannot be proven complete', () => {
    const block = functionBlock('void ExecuteQuery', 'void SendTradeFailure')
    expect(block).toContain('\\"found\\":false,\\"complete\\":false')
    expect(block).toContain('mt4_history_range_unverified')
    expect(block).not.toContain('\\"found\\":false,\\"complete\\":true')
  })

  it('uses the ticket as an exact lookup key and bounds comment fallback scans', () => {
    const select = functionBlock('bool SelectQueryOrder', 'void ExecuteQuery')
    expect(source).toContain('#define QUERY_COMMENT_MAX_ROWS 500')
    expect(source).toContain('#define QUERY_COMMENT_LOOKBACK_MSC 2592000000')
    expect(select).toContain('if(ticket > 0)')
    expect(select).toContain('SELECT_BY_TICKET')
    expect(select).toContain('QUERY_COMMENT_MAX_ROWS')
    expect(select).toContain('min_history_utc_msc')
    expect(select).toContain('OrdersHistoryTotal()')
  })

  it('publishes enough source state to reconcile every management command', () => {
    const block = functionBlock('void ExecuteQuery', 'void SendTradeFailure')
    for (const evidence of [
      '\\"source\\"',
      'active_position',
      'active_order',
      'history_deal',
      'history_order',
      '\\"volume\\"',
      '\\"price\\"',
      '\\"stop_loss\\"',
      '\\"take_profit\\"',
      '\\"expiration\\"',
      '\\"magic\\"',
      '\\"point\\"',
    ]) {
      expect(block).toContain(evidence)
    }
  })
})

describe('MT4 EA trade error contract', () => {
  it('clears and captures the terminal error immediately around OrderSend', () => {
    const block = functionBlock('void ExecutePlace', 'void ExecuteCancel')
    expect(block).toContain('ResetLastError();')
    expect(block).toContain('int ticket = OrderSend(')
    expect(block).toContain('int trade_error = ticket > 0 ? 0 : GetLastError();')
    expect(block).toContain('SendTradeFailure(command_id, "mt4_order_send_failed", trade_error)')
  })

  it('maps the server-side EA permission to native MT4 error 4112 before sending', () => {
    const block = functionBlock('bool SendTradePermissionFailure', 'int OnInit')
    expect(source).toContain('AccountInfoInteger(ACCOUNT_TRADE_EXPERT)')
    expect(block).toContain('"mt4_error_4112"')
    expect(block).toContain('"mt4_account_expert_trade_disabled"')
  })
})

describe('MT4 EA partial-close contract', () => {
  it('validates the current position volume separately from the requested close amount', () => {
    const command = functionBlock('void ExecuteCommand', 'void ExecutePlace')
    const close = functionBlock('void ExecuteClose', 'void ExecuteModifyPosition')

    expect(command).toContain('offset < ArraySize(payload) ? ReadUtf8(payload, offset) : ""')
    expect(close).toContain('double expected_volume = expected_volume_value == ""')
    expect(close).toContain('MathAbs(OrderLots() - expected_volume)')
    expect(close).toContain('double volume = (requested_volume <= 0) ? OrderLots() : requested_volume')
    expect(close).toContain('OrderClose(ticket, volume, price, deviation, clrNONE)')
    expect(close).not.toContain('MathAbs(OrderLots() - requested_volume)')
  })
})

describe('MT4 EA pending-order modification contract', () => {
  it('guards and verifies the pending target before reporting success', () => {
    const command = functionBlock('void ExecuteCommand', 'void ExecutePlace')
    const modify = functionBlock('void ExecuteModify', 'void ExecuteClose')

    expect(command).toContain('expected_volume_value, magic, price_value, stop_loss_value')
    expect(modify).toContain('management_expected_state_required')
    expect(modify).toContain('management_symbol_mismatch')
    expect(modify).toContain('management_direction_mismatch')
    expect(modify).toContain('management_magic_mismatch')
    expect(modify).toContain('management_volume_mismatch')
    expect(modify).toContain('pending_stop_loss_changed')
    expect(modify).toContain('pending_take_profit_changed')
    expect(modify).toContain('pending_order_modify_verify_failed')
    expect(modify).toContain('OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES)')
    expect(modify).toContain('OrderModify(ticket, price, stop_loss, take_profit, expiry, clrNONE)')
  })
})
