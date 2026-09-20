import { readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { historyRuntimeSchema } from '../src/modules/trade-history/infrastructure/history-runtime-schema.js'
import { assertMysqlHistoryTaskSchemaReady } from '../src/modules/trade-history/infrastructure/mysql-history-task-schema-readiness.js'
import { historyTaskSchema } from '../src/modules/trade-history/infrastructure/history-task-schema.js'
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
  return { state, connection, run: () => assertMysqlHistoryTaskSchemaReady({ getConnection: async () => connection } as unknown as Pool),
    collector: () => assertMysqlHistoryTaskSchemaReady({ getConnection: async () => connection } as unknown as Pool) }
}

function collectorFixture() {
  const f = fixture()
  const receiptReference = JSON.parse(readFileSync(new URL('../../docs/architecture/strategy-write-reference-v54-20260910.json', import.meta.url), 'utf8'))
  f.state.history.push({ ...historyCollectionSchema.step, status: 'completed' })
  f.state.tables[historyCollectionSchema.table.table] = receiptReference.historyCollectionReceipts.canonicalDdl
  const dealReference = JSON.parse(readFileSync(new URL('../../docs/architecture/history-completion-transaction-reference-v3-20260910.json', import.meta.url), 'utf8'))
  f.state.history.push({ ...historyDealSchema.step, status: 'completed' })
  f.state.tables[historyDealSchema.table.table] = dealReference.dealProvenance.canonicalDdl
  const taskReference = JSON.parse(readFileSync(new URL('../../docs/architecture/history-completion-transaction-reference-v13-20260910.json', import.meta.url), 'utf8'))
  f.state.history.push({ ...historyTaskSchema.step, status: 'completed' })
  f.state.tables[historyTaskSchema.table.table] = taskReference.collectionTasks.canonicalDdl
  return f
}

it('requires all 191 steps and eleven full definitions within one upgrade lock', async () => {
  const f = collectorFixture(); await f.run()
  expect(f.state.history).toHaveLength(191)
  expect(f.connection.query.mock.calls.filter(([sql]) => sql.startsWith('SHOW CREATE'))).toHaveLength(11)
  expect(f.connection.execute).toHaveBeenCalledTimes(2)
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it.each(['missing', 'checksum', 'started', 'ddl', 'trigger', 'timezone', 'prior'] as const)('rejects task schema admission: %s', async kind => {
  const f = collectorFixture()
  if (kind === 'missing') f.state.history.pop()
  if (kind === 'checksum') f.state.history.at(-1)!.checksum = 'wrong'
  if (kind === 'started') f.state.history.at(-1)!.status = 'started'
  if (kind === 'ddl') f.state.tables[historyTaskSchema.table.table] = 'CREATE TABLE wrong'
  if (kind === 'trigger') f.state.triggers.push({ tableName: historyTaskSchema.table.table })
  if (kind === 'timezone') f.state.timezone = '+08:00'
  if (kind === 'prior') f.state.history.shift()
  await expect(f.run()).rejects.toThrow('history_task_schema_not_ready')
  expect(f.connection.release).toHaveBeenCalledOnce()
})
it('does not release an upgrade lock owned elsewhere', async () => {
  const f = collectorFixture(); f.state.acquired = 0
  await expect(f.run()).rejects.toThrow('history_task_schema_not_ready')
  expect(f.connection.execute).toHaveBeenCalledTimes(1)
})
it('destroys a connection when lock release cannot be confirmed', async () => {
  const f = collectorFixture(); f.state.released = 0
  await expect(f.run()).rejects.toThrow('history_task_schema_not_ready')
  expect(f.connection.destroy).toHaveBeenCalledOnce(); expect(f.connection.release).not.toHaveBeenCalled()
})
