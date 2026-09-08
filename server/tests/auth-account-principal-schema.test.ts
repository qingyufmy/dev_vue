import type { PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { assertAccountPrincipalReadSchema } from '../src/modules/auth/composition.js'

function fixture() {
  const state = {
    tables: [{ kind: 'BASE TABLE', engine: 'InnoDB' }],
    columns: [
      { name: 'id', type: 'int', nullable: 'NO', collationName: null as string | null },
      { name: 'role', type: 'varchar(20)', nullable: 'NO', collationName: 'utf8mb4_0900_ai_ci' },
      { name: 'plan', type: 'varchar(20)', nullable: 'NO', collationName: 'utf8mb4_0900_ai_ci' },
      { name: 'plan_expires_at', type: 'datetime(3)', nullable: 'YES', collationName: null },
      { name: 'deleted_at', type: 'datetime(3)', nullable: 'YES', collationName: null },
      { name: 'deletion_status', type: 'varchar(24)', nullable: 'NO', collationName: 'utf8mb4_0900_ai_ci' },
    ],
    keys: [{ columnName: 'id', sequence: 1, nonUnique: '0' }],
  }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('information_schema.TABLES')) return [state.tables]
    if (sql.includes('information_schema.COLUMNS')) return [state.columns]
    if (sql.includes('information_schema.STATISTICS')) return [state.keys]
    throw Error('unexpected_sql')
  })
  return { state, query, run: () => assertAccountPrincipalReadSchema({ query } as unknown as PoolConnection) }
}

it('checks the account principal read capability using metadata only', async () => {
  const f = fixture()
  f.state.columns.reverse()
  await f.run()
  expect(f.query).toHaveBeenCalledTimes(3)
  expect(f.query.mock.calls.every(([sql]) => sql.startsWith('SELECT ') && sql.includes('TABLE_SCHEMA=DATABASE()'))).toBe(true)
})

it.each(['missing', 'type', 'nullable', 'collation', 'duplicate', 'key', 'composite', 'engine', 'view', 'driver'])('rejects incompatible principal metadata: %s', async issue => {
  const f = fixture()
  if (issue === 'missing') f.state.columns.pop()
  if (issue === 'type') f.state.columns[3]!.type = 'datetime'
  if (issue === 'nullable') f.state.columns[0]!.nullable = 'YES'
  if (issue === 'collation') f.state.columns[1]!.collationName = 'utf8mb4_bin'
  if (issue === 'duplicate') f.state.columns[1] = { ...f.state.columns[0]! }
  if (issue === 'key') f.state.keys = []
  if (issue === 'composite') f.state.keys.push({ columnName: 'role', sequence: 2, nonUnique: '0' })
  if (issue === 'engine') f.state.tables[0]!.engine = 'MyISAM'
  if (issue === 'view') f.state.tables[0]!.kind = 'VIEW'
  if (issue === 'driver') f.query.mockRejectedValueOnce(Error('private SQL detail'))
  await expect(f.run()).rejects.toThrow(/^auth_account_principal_schema_not_ready$/)
})
