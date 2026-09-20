import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlUserExecutionCommandRepository } from '../src/modules/execution/infrastructure/mysql-user-execution-command-repository.js'

it('delegates instrument facts to the trading port and never falls back to table payloads after a read failure', async () => {
  const execute = vi.fn(async (sql: string) => sql.includes('SELECT CAST(a.id AS CHAR) account_id,a.currency')
    ? [[{ account_id: '11', currency: 'USD' }]] : [[]])
  const read = vi.fn().mockRejectedValue(new Error('instrument_snapshot_source_ambiguous'))
  const repository = new MysqlUserExecutionCommandRepository({ execute } as unknown as Pool,
    () => { throw new Error('transaction_not_expected') }, { read })
  await expect(repository.loadContext({ userId: 7, accountId: '11', symbol: 'XAUUSD.a', ticket: null }))
    .rejects.toThrow('instrument_snapshot_source_ambiguous')
  expect(read).toHaveBeenCalledWith('11', 'XAUUSD.a')
  expect(execute.mock.calls.some(([sql]) => sql.includes('market_instrument_snapshots'))).toBe(false)
})
