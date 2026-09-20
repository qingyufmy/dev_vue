import { readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { historyRuntimeSchema } from '../src/modules/trade-history/infrastructure/history-runtime-schema.js'
import { assertMysqlTradeHistorySchemaReady, assertMysqlTradeHistoryCollectorSchemaReady } from '../src/modules/trade-history/infrastructure/mysql-schema-readiness.js'
import { historyCollectionSchema } from '../src/modules/trade-history/infrastructure/history-collection-schema.js'
import { historyDealSchema } from '../src/modules/trade-history/infrastructure/history-deal-schema.js'

const reference = JSON.parse(readFileSync(new URL('../../docs/architecture/history-runtime-reference-20260909.json', import.meta.url), 'utf8')) as {
  tables: Record<string, string>; canonicalDdl: string
}
function fixture() {
  const state = { history: historyRuntimeSchema.steps.map<{ id: string; checksum: string; status: string }>(step => ({ ...step, status: 'completed' })),
    tables: { ...reference.tables, terminal_history_order_provenance_v4: reference.canonicalDdl } as Record<string, string>,
    triggers: [] as { tableName: string }[], acquired: 1, released: 1, timezone: '+00:00' }
  const connection = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT DATABASE')) return [[{ db: 'dev_vue', timezone: state.timezone }]]
      if (sql.includes('FROM database_upgrade_steps_v4')) return [state.history]
      if (sql.startsWith('SHOW CREATE')) return [[{ 'Create Table': state.tables[sql.split('`')[1]!] }]]
      if (sql.includes('TRIGGERS')) return [state.triggers]
      throw Error('unexpected_query')
    }),
    execute: vi.fn(async (sql: string) => [[sql.includes('GET_LOCK') ? { acquired: state.acquired } : { released: state.released }]]),
    release: vi.fn(), destroy: vi.fn(),
  }
  return { state, connection, run: () => assertMysqlTradeHistorySchemaReady({ getConnection: async () => connection } as unknown as Pool),
    collector: () => assertMysqlTradeHistoryCollectorSchemaReady({ getConnection: async () => connection } as unknown as Pool) }
}

function collectorFixture() {
  const f = fixture()
  const receiptReference = JSON.parse(readFileSync(new URL('../../docs/architecture/strategy-write-reference-v54-20260910.json', import.meta.url), 'utf8'))
  f.state.history.push({ ...historyCollectionSchema.step, status: 'completed' })
  f.state.tables[historyCollectionSchema.table.table] = receiptReference.historyCollectionReceipts.canonicalDdl
  const dealReference = JSON.parse(readFileSync(new URL('../../docs/architecture/history-completion-transaction-reference-v3-20260910.json', import.meta.url), 'utf8'))
  f.state.history.push({ ...historyDealSchema.step, status: 'completed' })
  f.state.tables[historyDealSchema.table.table] = dealReference.dealProvenance.canonicalDdl
  return f
}

it('admits the collector only with the appended checkpoint and full receipt definition under the same upgrade lock', async () => {
  const f = collectorFixture(); await f.collector()
  expect(f.connection.query.mock.calls.filter(([sql]) => sql.startsWith('SHOW CREATE'))).toHaveLength(10)
  expect(f.connection.execute).toHaveBeenCalledTimes(2)
  expect(f.connection.release).toHaveBeenCalledOnce()
})

it('keeps read-only history admission independent while rejecting a collector missing 051', async () => {
  const f = fixture(); await f.run()
  await expect(f.collector()).rejects.toThrow('trade_history_schema_not_ready')
})

it.each(['checksum', 'ddl', 'trigger'])('rejects collector receipt evidence mismatch: %s', async kind => {
  const f = collectorFixture()
  if (kind === 'checksum') f.state.history.find(row => row.id === historyCollectionSchema.step.id)!.checksum = 'wrong'
  if (kind === 'ddl') f.state.tables[historyCollectionSchema.table.table] = 'CREATE TABLE invalid'
  if (kind === 'trigger') f.state.triggers.push({ tableName: historyCollectionSchema.table.table })
  await expect(f.collector()).rejects.toThrow('trade_history_schema_not_ready')
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it.each(['missing', 'checksum', 'ddl', 'trigger'])('rejects missing or invalid 052 evidence: %s', async kind => {
  const f = collectorFixture()
  if (kind === 'missing') f.state.history.pop()
  if (kind === 'checksum') f.state.history.at(-1)!.checksum = 'wrong'
  if (kind === 'ddl') delete f.state.tables[historyDealSchema.table.table]
  if (kind === 'trigger') f.state.triggers.push({ tableName: historyDealSchema.table.table })
  await f.run()
  await expect(f.collector()).rejects.toThrow('trade_history_schema_not_ready')
})
it('accepts all 188 checkpoints and eight real reference definitions using only reads', async () => {
  const f = fixture(); await f.run()
  expect(f.connection.query.mock.calls.filter(([sql]) => sql.startsWith('SHOW CREATE'))).toHaveLength(8)
  expect(f.connection.query.mock.calls.every(([sql]) => /^(SELECT|SHOW)/.test(sql))).toBe(true)
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it.each(['missing', 'started', 'checksum', 'duplicate'] as const)('rejects %s migration evidence', async kind => {
  const f = fixture()
  if (kind === 'missing') f.state.history.pop()
  if (kind === 'started') f.state.history.at(-1)!.status = 'started'
  if (kind === 'checksum') f.state.history.at(-1)!.checksum = 'wrong'
  if (kind === 'duplicate') f.state.history.push(f.state.history[0]!)
  await expect(f.run()).rejects.toThrow(/^trade_history_schema_not_ready$/)
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it.each(historyRuntimeSchema.tables.map(row => row.table))('rejects missing or changed table %s', async table => {
  const f = fixture(); delete f.state.tables[table]
  await expect(f.run()).rejects.toThrow('trade_history_schema_not_ready')
  f.state.tables[table] = 'CREATE TABLE `wrong` ()'
  await expect(f.run()).rejects.toThrow('trade_history_schema_not_ready')
})
it('rejects triggers and non-UTC sessions', async () => {
  const f = fixture(); f.state.triggers.push({ tableName: 'terminal_history_orders_v4' })
  await expect(f.run()).rejects.toThrow('trade_history_schema_not_ready')
  f.state.triggers = []; f.state.timezone = '+08:00'
  await expect(f.run()).rejects.toThrow('trade_history_schema_not_ready')
})
it('does not release another connection upgrade lock', async () => {
  const f = fixture(); f.state.acquired = 0
  await expect(f.run()).rejects.toThrow('trade_history_schema_not_ready')
  expect(f.connection.execute).toHaveBeenCalledTimes(1)
})
it('destroys a connection if lock release fails', async () => {
  const f = fixture(); f.state.released = 0
  await expect(f.run()).rejects.toThrow('trade_history_schema_not_ready')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.release).not.toHaveBeenCalled()
})
