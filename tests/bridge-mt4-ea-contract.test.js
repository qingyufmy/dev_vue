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
    expect(source).toContain('#property version   "3.20"')
    expect(block).toContain('ServerTimeToUtcMsc(source_time, CurrentServerOffsetMsc())')
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
    expect(source).toContain('AppendUtf8(hello, "3.2.0")')
    const block = functionBlock('void SendExtendedData', 'void SendExtendedDataResult')
    for (const action of ['symbols', 'history', 'chart_data', 'pending_order_state', 'diagnostics']) {
      expect(block).toContain(`action == "${action}"`)
    }
  })

  it('reports the MT4 account-history range limitation explicitly', () => {
    expect(source).toContain('\\"history_source_complete\\":false')
    expect(source).toContain('mt4_account_history_tab_range')
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
  it('scans active orders once when publishing positions and pending orders', () => {
    const sendBlock = functionBlock('void SendSnapshot', 'void SendQuote')
    const buildBlock = functionBlock('void BuildOrderSnapshots', 'string BuildSelectedOrderJson')

    expect(sendBlock).toContain('BuildOrderSnapshots(streams, positions_json, orders_json)')
    expect(buildBlock.match(/OrdersTotal\(\)/g)).toHaveLength(1)
    expect(buildBlock).toContain('include_positions')
    expect(buildBlock).toContain('include_orders')
  })
})
