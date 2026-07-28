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
    expect(source).toContain('#property version   "3.24"')
    expect(block).toContain('ServerTimeToUtcMsc(source_time, CurrentServerOffsetMsc())')
    expect(block).toContain('AppendInt32(response, CurrentServerOffsetMinutes())')
    expect(block).toContain('AppendUtf8(response, "broker_time_derived")')
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
    expect(block).toContain('mt4_current_offset')
  })

  it('normalizes symbol-snapshot observation time as well', () => {
    const block = functionBlock('void SendSymbolSnapshot', 'void SendSymbolSnapshotResult')
    expect(block).toContain('ServerTimeToUtcMsc(')
    expect(block).toContain('timezone_offset_minutes')
  })
})

describe('MT4 EA extended data contract', () => {
  it('advertises version 3.2 and handles every server data action', () => {
    expect(source).toContain('#define BRIDGE_PROTOCOL_VERSION 3')
    expect(source).toContain('#define ADAPTER_VERSION "3.2.4"')
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

describe('MT4 EA uncertain execution contract', () => {
  it('does not claim an absent order when the MT4 history range cannot be proven complete', () => {
    const block = functionBlock('void ExecuteQuery', 'void SendTradeFailure')
    expect(block).toContain('\\"found\\":false,\\"complete\\":false')
    expect(block).toContain('mt4_history_range_unverified')
    expect(block).not.toContain('\\"found\\":false,\\"complete\\":true')
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
