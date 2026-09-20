import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { StrategyService } from '../src/modules/strategies/application/strategy-service.js'
import { MysqlStrategyCatalog } from '../src/modules/strategies/infrastructure/mysql-strategy-catalog.js'
import { initializeSubscriptionExecutionPreferences, readSubscriptionExecutionPreferences } from '../src/modules/strategies/infrastructure/mysql-subscription-execution-preferences.js'

const scope = { subscriptionId: '9007199254740993', userId: 7, accountId: '5' }
const row = { contract_version: 1, take_profit_mode: 'ai_recommended', revision: '9007199254740993' }
const connection = (rows: unknown[]) => ({ execute: vi.fn().mockResolvedValue([rows]) })

describe('subscription execution preferences storage', () => {
  it('rolls back the subscription and schedule when preferences initialization fails', async () => {
    const failure = new Error('preferences_write_failed')
    const db = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
      execute: vi.fn().mockResolvedValueOnce([[{ id: 7 }]]).mockResolvedValueOnce([[{ id: '5' }]]).mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: '2', kind: 'analysis', active_version_id: '3' }]])
        .mockResolvedValueOnce([[]]).mockResolvedValueOnce([{ insertId: 9 }]).mockResolvedValueOnce([{}])
        .mockRejectedValueOnce(failure) }
    const catalog = new MysqlStrategyCatalog({ getConnection: async () => db } as unknown as Pool)
    await expect(new StrategyService(catalog).createSubscription(7, { idempotencyKey: 'subscription-create-001', tradingAccountId: '5', standardSymbol: 'XAUUSD',
      analysisStrategyId: '2', traderStrategyId: null, analysisEnabled: true, traderEnabled: false,
      tradeSendEnabled: false, status: 'active' })).rejects.toBe(failure)
    expect(db.execute.mock.calls[7]![0]).toContain('INSERT INTO subscription_execution_preferences')
    expect(db.rollback).toHaveBeenCalledOnce()
    expect(db.commit).not.toHaveBeenCalled()
    expect(db.release).toHaveBeenCalledOnce()
  })
  it('keeps missing historical settings absent', async () => {
    const db = connection([])
    expect(await readSubscriptionExecutionPreferences(db as unknown as PoolConnection, scope)).toBeNull()
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('s.user_id=? AND s.trading_account_id=?'), [scope.subscriptionId, 7, '5'])
  })
  it.each(['ai_recommended', 'conservative', 'standard', 'trend'])('preserves %s and exact revision', async mode => {
    const db = connection([{ ...row, take_profit_mode: mode }])
    expect(await readSubscriptionExecutionPreferences(db as unknown as PoolConnection, scope))
      .toEqual({ contractVersion: 1, takeProfitMode: mode, revision: '9007199254740993' })
  })
  it.each([{ contract_version: 2 }, { take_profit_mode: 'unknown' }, { revision: '0' }, { revision: 42 }])('rejects malformed stored evidence %j', async change => {
    await expect(readSubscriptionExecutionPreferences(connection([{ ...row, ...change }]) as unknown as PoolConnection, scope))
      .rejects.toThrow('subscription_execution_preferences_invalid')
  })
  it('does not pick an arbitrary duplicate', async () => {
    await expect(readSubscriptionExecutionPreferences(connection([row, row]) as unknown as PoolConnection, scope)).rejects.toThrow('subscription_execution_preferences_invalid')
  })
  it('propagates failed initialization to the caller transaction without overwriting', async () => {
    const error = new Error('duplicate'), db = { execute: vi.fn().mockRejectedValue(error) }
    await expect(initializeSubscriptionExecutionPreferences(db as unknown as PoolConnection, scope.subscriptionId)).rejects.toBe(error)
    const [sql, params] = db.execute.mock.calls[0]!
    expect(sql).not.toMatch(/IGNORE|ON DUPLICATE/i)
    expect(params).toEqual([scope.subscriptionId])
  })
})
