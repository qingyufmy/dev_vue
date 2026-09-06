import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { assertTraderPreferencesCurrent, MysqlTraderPreferencesReader } from '../src/modules/inference/infrastructure/mysql-trader-preferences.js'
import type { TraderRun } from '../src/modules/inference/domain/inference.js'

const run = { subscriptionId: '9', userId: 7, tradingAccountId: '5' } as TraderRun
const frozen = { contractVersion: 1, takeProfitMode: 'ai_recommended', revision: '9007199254740993' }
const row = { contract_version: 1, take_profit_mode: 'ai_recommended', revision: '9007199254740993' }

describe('trader preferences transaction checks', () => {
  it('checks the supplied transaction and exact owner/account scope', async () => {
    const db = { execute: vi.fn().mockResolvedValue([[row]]) }
    await expect(assertTraderPreferencesCurrent(db as unknown as PoolConnection, run, frozen)).resolves.toBeUndefined()
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE'), ['9', 7, '5'])
  })
  it.each([undefined, { ...frozen, revision: '9007199254740992' }, { ...frozen, takeProfitMode: 'trend' }, { ...frozen, untracked: true }])('rejects absent or different frozen configuration %j', async value => {
    const db = { execute: vi.fn().mockResolvedValue([[row]]) }
    await expect(assertTraderPreferencesCurrent(db as unknown as PoolConnection, run, value)).rejects.toThrow('trader_preferences_changed')
  })
  it('refuses a missing current row, and propagates connection failure without fabricating configuration', async () => {
    await expect(assertTraderPreferencesCurrent({ execute: vi.fn().mockResolvedValue([[{ ...row, contract_version: 2 }]]) } as unknown as PoolConnection, run, frozen)).rejects.toThrow('trader_preferences_changed')
    await expect(assertTraderPreferencesCurrent({ execute: vi.fn().mockResolvedValue([[]]) } as unknown as PoolConnection, run, frozen)).rejects.toThrow('trader_preferences_changed')
    const error = new Error('connection_lost')
    await expect(assertTraderPreferencesCurrent({ execute: vi.fn().mockRejectedValue(error) } as unknown as PoolConnection, run, frozen)).rejects.toBe(error)
  })
  it.each([true, false])('snapshot reader commits only present explicit preferences (present=%s)', async present => {
    const db = { execute: vi.fn().mockResolvedValue([present ? [row] : []]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
    const reader = new MysqlTraderPreferencesReader({ getConnection: async () => db } as unknown as Pool)
    if (present) {
      expect(await reader.read(run)).toEqual(frozen)
      expect(db.commit).toHaveBeenCalledOnce()
      expect(db.rollback).not.toHaveBeenCalled()
    } else {
      await expect(reader.read(run)).rejects.toThrow('trader_preferences_unavailable')
      expect(db.rollback).toHaveBeenCalledOnce()
      expect(db.commit).not.toHaveBeenCalled()
    }
    expect(db.release).toHaveBeenCalledOnce()
  })
})
