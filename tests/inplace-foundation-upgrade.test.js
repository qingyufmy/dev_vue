import { expect, it } from 'vitest'
import { loadFoundationSteps, executeFoundationSteps, tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'
import { inplaceColumnSteps } from '../scripts/lib/dev-vue-column-upgrade.mjs'

const steps = await loadFoundationSteps(new URL('../', import.meta.url))
const time = '2026-09-06T00:00:00.000Z'
const receipt = (step, status = 'completed') => ({ id: step.id, checksum: step.checksum, status, startedAt: time, completedAt: status === 'completed' ? time : null })
function fixture() {
  const rows = inplaceColumnSteps.map(step => receipt(step)), tables = new Map(), executed = []
  const store = {
    history: async () => rows,
    column: async (table, column) => inplaceColumnSteps.find(step => step.table === table && step.column === column)?.expected ?? null,
    tableHash: async name => tables.get(name) ?? null,
    begin: async step => rows.push(receipt(step, 'started')),
    execute: async sql => { const step = steps.find(step => step.sql === sql); executed.push(step.id); tables.set(step.table, step.expectedHash) },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), receipt(step)),
  }
  return { rows, tables, executed, store }
}
it('reconciles committed CREATE after response loss and repeats without DDL', async () => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async sql => { await execute(sql); throw new Error('lost') }
  await expect(executeFoundationSteps(f.store, steps, { apply: true })).rejects.toThrow('lost')
  f.store.execute = execute
  const result = await executeFoundationSteps(f.store, steps, { apply: true })
  expect(result.steps[0].status).toBe('reconciled')
  await executeFoundationSteps(f.store, steps, { apply: true })
  expect(f.executed).toHaveLength(9)
})
it('rejects a conflicting last table before any new journal or DDL', async () => {
  const f = fixture()
  f.tables.set(steps.at(-1).table, 'changed')
  await expect(executeFoundationSteps(f.store, steps, { apply: true })).rejects.toThrow('inplace_table_definition_conflict')
  expect(f.rows).toHaveLength(9)
  expect(f.executed).toHaveLength(0)
})
it('rejects unknown journal records and missing original columns', async () => {
  const f = fixture()
  f.rows.push({ ...receipt(steps[0]), id: 'unknown' })
  await expect(executeFoundationSteps(f.store, steps)).rejects.toThrow('inplace_unknown_history')
  f.rows.pop()
  f.store.column = async () => null
  await expect(executeFoundationSteps(f.store, steps)).rejects.toThrow('inplace_completed_column_missing')
})
it('ignores only the current auto-increment counter, retaining types and keys', () => {
  const ddl = 'CREATE TABLE `t` (\n  `id` int AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  expect(tableDefinitionHash(ddl.replace(' DEFAULT', ' AUTO_INCREMENT=99 DEFAULT'))).toBe(tableDefinitionHash(ddl))
  expect(tableDefinitionHash(ddl.replace('int', 'bigint'))).not.toBe(tableDefinitionHash(ddl))
})
it('accepts redundant explicit utf8mb4 with the same collation but rejects a changed collation', () => {
  const ddl = "CREATE TABLE `t` (\n  `state` enum('ok') COLLATE utf8mb4_unicode_ci NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
  expect(tableDefinitionHash(ddl.replace('COLLATE', 'CHARACTER SET utf8mb4 COLLATE'))).toBe(tableDefinitionHash(ddl))
  expect(tableDefinitionHash(ddl.replace('utf8mb4_unicode_ci', 'utf8mb4_general_ci'))).not.toBe(tableDefinitionHash(ddl))
})
