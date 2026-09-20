import { describe, expect, it, vi } from 'vitest'
import { TradingAnalysisMarketSource } from '../src/modules/inference/infrastructure/trading-analysis-market-source.js'
import type { AnalysisTradingReader } from '../src/modules/inference/application/trading-read-capabilities.js'
import type { StrategyMarketSourceAccess } from '../src/modules/market/index.js'

describe('analysis consumes only the selected market source', () => {
  function fixture() {
    const selected = { pool: { kind: 'public' }, standardSymbol: 'XAUUSD', state: { generation: 3, resolvedSymbol: 'XAUUSD.s', source: { accountId: '20', ownerUserId: 1, connectionId: 'connection-public', connectionEpoch: 4 } } }
    const select = vi.fn().mockResolvedValue(selected), assertCurrent = vi.fn().mockResolvedValue(undefined)
    const trading = { findOwnedAccount: vi.fn().mockResolvedValue({ id: '20', bridgeState: 'online', platform: 'mt5', server: 'broker' }),
      listAccounts: vi.fn(), getQuote: vi.fn().mockResolvedValue({ bid: '2', ask: '3', observedAt: '2026-09-14T00:00:00.000Z', revision: 1 }),
      listCandles: vi.fn().mockResolvedValue([{ openTime: '2026-09-14T00:00:00.000Z', open: '2', high: '3', low: '1', close: '2', tickVolume: '1', closed: true, revision: 1 }]),
    }
    return { trading, select, assertCurrent, source: new TradingAnalysisMarketSource(trading as unknown as AnalysisTradingReader, { select, assertCurrent } as unknown as StrategyMarketSourceAccess) }
  }
  const input = { userId: 7, preferredAccountId: '99', symbol: 'XAUUSD', strategyId: '1', strategyVersionId: '2', plan: { timeframes: ['M5', 'H1'] as ['M5', 'H1'], candleLimit: 1 } }
  it('ignores the execution account and uses one actual symbol/source for all frames', async () => {
    const f = fixture(), result = await f.source.read(input)
    expect(f.trading.findOwnedAccount).toHaveBeenCalledWith(1, '20')
    expect(f.trading.listAccounts).not.toHaveBeenCalled()
    expect(f.trading.getQuote).toHaveBeenCalledWith('20', 'XAUUSD.s')
    expect(f.trading.listCandles.mock.calls.map(c => c.slice(0, 3))).toEqual([['20', 'XAUUSD.s', 'M5'], ['20', 'XAUUSD.s', 'H1']])
    expect(result.source_generation).toBe(3); expect(result.standard_symbol).toBe('XAUUSD')
    expect(f.assertCurrent).toHaveBeenCalledTimes(1)
  })
  it('does not publish an analysis input after a source switches mid-read', async () => {
    const f = fixture(); f.assertCurrent.mockRejectedValue(new Error('market_source_changed'))
    await expect(f.source.read(input)).rejects.toThrow('market_source_changed')
  })
  it('never searches another account when the selected source has no cached quote', async () => {
    const f = fixture(); f.trading.getQuote.mockResolvedValue(null)
    await expect(f.source.read(input)).rejects.toThrow('market_snapshot_unavailable')
    expect(f.trading.listAccounts).not.toHaveBeenCalled()
  })
  it('uses the administrator public calibration instead of the terminal heartbeat clock', async () => {
    const f = fixture(), publicClock = vi.fn().mockResolvedValue({ offset: 180, checkedAt: '2026-09-13T12:00:00.000Z' })
    const source = new TradingAnalysisMarketSource(f.trading as unknown as AnalysisTradingReader,
      { select: f.select, assertCurrent: f.assertCurrent } as unknown as StrategyMarketSourceAccess, publicClock)
    const result = await source.read({ ...input, referenceTime: '2026-09-14T00:05:00.000Z',
      plan: { ...input.plan, timeframes: ['M5'], chan: { version: 1, enabled: true } } })
    const archive = result.calculation_archive?.M5 as any
    expect(archive.input.context.clock).toEqual({ clockStatus: 'calibrated', timezoneOffsetMinutes: 180,
      observedAt: '2026-09-13T12:00:00.000Z', dailyCalibration: true })
    expect(publicClock).toHaveBeenCalledTimes(1)
    publicClock.mockResolvedValue(null)
    const missing = await source.read({ ...input, plan: { ...input.plan, timeframes: ['M5'], chan: { version: 1, enabled: true } } })
    expect((missing.calculation_archive?.M5 as any).input.context.clock).toBeNull()
  })

  it('waits for a terminal-confirmed close instead of changing a forming bar locally', async () => {
    const f = fixture()
    f.trading.listCandles.mockResolvedValue([{ openTime: '2026-09-14T00:00:00.000Z', open: '2', high: '3', low: '1', close: '2', tickVolume: '1', closed: false, revision: 1 }])
    await expect(f.source.read({ ...input, referenceTime: '2026-09-14T00:05:00.999Z' })).rejects.toThrow('market_candle_close_pending')
    expect(f.assertCurrent).not.toHaveBeenCalled()
    await expect(f.source.read({ ...input, referenceTime: '2026-09-14T00:04:59.000Z' })).resolves.toHaveProperty('source_account_id', '20')
  })

})
