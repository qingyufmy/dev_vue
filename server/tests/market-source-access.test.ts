import { describe, expect, it, vi } from 'vitest'
import { StrategyMarketSourceAccess } from '../src/modules/market/application/market-source-access.js'
import type { MarketSourceSelector } from '../src/modules/market/application/market-source-selector.js'
import type { MarketSourceState } from '../src/modules/market/domain/market-source.js'
const state: MarketSourceState = { revision: 1, generation: 2, source: { accountId: '3', ownerUserId: 7, connectionId: 'connection-3', connectionEpoch: 1 }, resolvedSymbol: 'XAUUSD.s', failures: 0, firstFailureAt: null, lastCheckedAt: 1000 }
const input = { userId: 7, strategyId: '1', versionId: '2', symbol: 'XAUUSD' }
describe('strategy market authorization', () => {
  it('derives pool from authorized strategy metadata, not execution account', async () => {
    const read = vi.fn().mockResolvedValueOnce({ scope: 'platform', ownerUserId: null }).mockResolvedValueOnce({ scope: 'user', ownerUserId: 7 })
    const select = vi.fn().mockResolvedValue(state)
    const access = new StrategyMarketSourceAccess({ read }, { select } as unknown as MarketSourceSelector)
    expect((await access.select(input)).pool).toEqual({ kind: 'public' })
    expect((await access.select(input)).pool).toEqual({ kind: 'private', userId: 7 })
    expect(select.mock.calls.map(c => c[0])).toEqual([
      { pool: { kind: 'public' }, symbol: 'XAUUSD' }, { pool: { kind: 'private', userId: 7 }, symbol: 'XAUUSD' },
    ])
  })
  it('rejects unauthorized private strategy before probing any account', async () => {
    const select = vi.fn()
    const access = new StrategyMarketSourceAccess({ read: async () => ({ scope: 'user', ownerUserId: 8 }) }, { select } as unknown as MarketSourceSelector)
    await expect(access.select(input)).rejects.toThrow('market_source_access_denied'); expect(select).not.toHaveBeenCalled()
  })
  it('does not fall back to public on private source failure', async () => {
    const select = vi.fn().mockResolvedValue({ ...state, source: null, resolvedSymbol: null })
    const access = new StrategyMarketSourceAccess({ read: async () => ({ scope: 'user', ownerUserId: 7 }) }, { select } as unknown as MarketSourceSelector)
    await expect(access.select(input)).rejects.toThrow('market_source_unavailable'); expect(select).toHaveBeenCalledTimes(1)
  })
  it('rechecks strategy permission and source generation before accepting data', async () => {
    const read = vi.fn().mockResolvedValueOnce({ scope: 'user', ownerUserId: 7 }).mockResolvedValue(null)
    const access = new StrategyMarketSourceAccess({ read }, { select: async () => state, isCurrent: async () => true } as unknown as MarketSourceSelector)
    const captured = await access.select(input)
    await expect(access.assertCurrent(input, captured)).rejects.toThrow('market_source_changed')
  })
})
