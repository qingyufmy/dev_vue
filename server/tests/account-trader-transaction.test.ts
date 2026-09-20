import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { setAccountTrader } from '../src/modules/strategies/infrastructure/mysql-trader-control.js'

function fixture(owned = true, failSecond = false) {
  let writes = 0
  const connection = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string) => {
      if (sql.includes('FROM users')) return [[{ id: 1 }]]
      if (sql.includes('FROM trading_accounts')) return [owned ? [{ id: 1 }] : []]
      if (sql.includes('SELECT action')) return [[]]
      if (sql.includes('FROM strategy_subscriptions')) return [[1, 2].map(id => ({ id: String(id), revision: 2, status: 'active', analysis_enabled: 1, trader_strategy_id: '3' }))]
      if (sql.includes('FROM strategies')) return [[{ id: 3 }]]
      if (sql.startsWith('UPDATE strategy_subscriptions')) {
        if (++writes === 2 && failSecond) throw new Error('write failed')
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('INSERT INTO strategy_write_receipts')) return [{ affectedRows: 1 }]
      throw new Error(`Unexpected query: ${sql}`)
    }),
  }
  return { connection, pool: { getConnection: async () => connection } as unknown as Pool }
}
const input = { userId: 1, accountId: '1', enabled: false, idempotencyKey: 'account-trader-transaction', expected: [{ id: '1', revision: 2 }, { id: '2', revision: 2 }] }
it('commits the account toggle and receipt together without changing analysis schedules or risk policy', async () => {
  const { pool, connection } = fixture()
  expect(await setAccountTrader(pool, input)).toEqual({ enabled: false })
  expect(connection.commit).toHaveBeenCalledOnce()
  expect(connection.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE'))).toHaveLength(2)
  expect(connection.rollback).not.toHaveBeenCalled()
})
it('rolls back every subscription when a later write fails', async () => {
  const { pool, connection } = fixture(true, true)
  await expect(setAccountTrader(pool, input)).rejects.toThrow('write failed')
  expect(connection.rollback).toHaveBeenCalledOnce()
  expect(connection.commit).not.toHaveBeenCalled()
})
it('rejects another account before subscription mutation', async () => {
  const { pool, connection } = fixture(false)
  await expect(setAccountTrader(pool, input)).rejects.toThrow('strategy_account_forbidden')
  expect(connection.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
})
