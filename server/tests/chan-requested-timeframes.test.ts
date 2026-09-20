import { describe, expect, it, vi } from 'vitest'
import { getChanWindowPolicy } from '../src/modules/market/domain/chan-v8/window-policy.js'
import { publicChanChart } from '../src/modules/market/application/public-chan-chart.js'
import { TradingAnalysisMarketSource } from '../src/modules/inference/infrastructure/trading-analysis-market-source.js'
import type { AnalysisTradingReader } from '../src/modules/inference/application/trading-read-capabilities.js'

const periods = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 } as const
const end = Date.UTC(2026, 8, 18, 12), now = new Date(end).toISOString()
function candles(timeframe: keyof typeof periods, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + Math.sin(i / 5) * 10
    return { accountId: '1', symbol: 'XAUUSD', timeframe, openTime: new Date(end - (count - i) * periods[timeframe] * 60_000).toISOString(),
      open: String(price), high: String(price + 1), low: String(price - 1), close: String(price), closed: true, tickVolume: '1', revision: 1 }
  })
}
describe('Chan follows requested periods', () => {
  it.each(Object.keys(periods) as Array<keyof typeof periods>)('calculates chart structure for %s', timeframe => {
    expect(getChanWindowPolicy(timeframe).supported).toBe(true)
    const result = publicChanChart({ accountId: '1', platform: 'mt5', timeframe, candles: candles(timeframe, 100),
      clock: { offset: 180, checkedAt: now }, referenceTime: now })
    expect(result).not.toBeNull()
    expect(result!.status).not.toBe('unsupported_policy')
    expect(result!.based_on_closed_bars).toBe(100)
  })
  it('has no second period allowlist inside the engine', () => {
    for (const tf of ['M2', 'H2', 'D2', 'W1', 'MN1']) expect(getChanWindowPolicy(tf).supported).toBe(true)
    for (const tf of ['', 'M0', 'bogus']) expect(getChanWindowPolicy(tf).supported).toBe(false)
    expect(getChanWindowPolicy('M1', 'unknown').supported).toBe(false)
  })
  it('requests and calculates only the strategy periods, not the default four or EMA-only periods', async () => {
    const listCandles = vi.fn(async (_id: string, _symbol: string, timeframe: keyof typeof periods, limit: number) => candles(timeframe, limit))
    const reader = { findOwnedAccount: async () => null, listAccounts: async () => [{ id: '1', platform: 'mt5', bridgeState: 'online', server: 'fixture' }],
      listCandles, getQuote: async () => ({ bid: '100', ask: '101', observedAt: now }),
      getAccountSnapshot: async () => ({ clockStatus: 'calibrated', timezoneOffsetMinutes: 180, observedAt: now }) } as unknown as AnalysisTradingReader
    const result = await new TradingAnalysisMarketSource(reader).read({ userId: 1, preferredAccountId: null, symbol: 'XAUUSD', referenceTime: now,
      plan: { timeframes: ['M30', 'D1'], candleLimit: 100, chan: { version: 1, enabled: true }, ema34: { version: 1, timeframe: 'M1' } } })
    expect(Object.keys(result.indicators!.chan as object).sort()).toEqual(['D1', 'M30'])
    expect(Object.keys(result.calculation_archive!).sort()).toEqual(['D1', 'M30'])
    expect(listCandles.mock.calls.map(c => [c[2], c[3]])).toEqual([['M30', 1800], ['D1', 1800], ['M1', 61]])
  })
})
