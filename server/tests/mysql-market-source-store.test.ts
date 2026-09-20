import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlMarketSourceStore } from '../src/modules/market/infrastructure/mysql-market-source-store.js'
import type { MarketSourceScope, MarketSourceState } from '../src/modules/market/domain/market-source.js'
const scope: MarketSourceScope = { pool: { kind: 'private', userId: 7 }, symbol: 'XAUUSD' }
const state: MarketSourceState = { revision: 2, generation: 1, source: null, resolvedSymbol: null, failures: 0, firstFailureAt: null, lastCheckedAt: 1000 }
describe('persisted market source CAS', () => {
  it('binds private pool and expected revision in the atomic update', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    expect(await new MysqlMarketSourceStore({ execute } as unknown as Pool).compareAndSet(scope, 1, state)).toBe(true)
    expect(execute.mock.calls[0]?.[1]).toEqual([2, 1, JSON.stringify(state), 'private:7', 'XAUUSD', 1])
    expect(execute.mock.calls[0]?.[0]).toContain('AND revision=?')
  })
  it('treats only duplicate primary-key creation as an election race', async () => {
    const execute = vi.fn().mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' }).mockRejectedValueOnce(new Error('connection_lost'))
    const store = new MysqlMarketSourceStore({ execute } as unknown as Pool)
    expect(await store.compareAndSet(scope, null, { ...state, revision: 1 })).toBe(false)
    await expect(store.compareAndSet(scope, null, { ...state, revision: 1 })).rejects.toThrow('connection_lost')
  })
  it('rejects mismatched persisted generations', async () => {
    const execute = vi.fn().mockResolvedValue([[{ revision: '2', source_generation: '3', state_json: state }]])
    await expect(new MysqlMarketSourceStore({ execute } as unknown as Pool).read(scope)).rejects.toThrow('market_source_state_invalid')
  })
})
