import { expect, it } from 'vitest'
import { loadAccountBuildSteps, accountBuildDefinition, executeAccountBuild } from '../scripts/lib/inplace-account-build.mjs'
import { loadFoundationSteps } from '../scripts/lib/inplace-foundation-upgrade.mjs'
import { inplaceColumnSteps } from '../scripts/lib/dev-vue-column-upgrade.mjs'
const root = new URL('../', import.meta.url)
const build = await loadAccountBuildSteps(root), foundation = await loadFoundationSteps(root)
const time = '2026-09-06T00:00:00.000Z'
const receipt = (step, status = 'completed') => ({ id: step.id, checksum: step.checksum, status, startedAt: time, completedAt: status === 'completed' ? time : null })
function fixture() {
  const rows = [...inplaceColumnSteps, ...foundation].map(step => receipt(step)), tables = new Map(foundation.map(step => [step.table, step.expectedHash])), executed = []
  const store = { history: async () => rows, column: async (table, name) => inplaceColumnSteps.find(step => step.table === table && step.column === name)?.expected ?? null,
    tableHash: async name => tables.get(name) ?? null, begin: async step => rows.push(receipt(step, 'started')),
    execute: async sql => { const step = build.find(step => step.sql === sql); tables.set(step.table, step.expectedHash); executed.push(step.id) },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), receipt(step)) }
  return { rows, tables, executed, store }
}
it('rewrites only the four table identities and retains users and column names', () => {
  expect(accountBuildDefinition('REFERENCES `trading_accounts` (`id`), `trading_account_id`, REFERENCES `users` (`id`)'))
    .toBe('REFERENCES `trading_accounts_v4_build` (`id`), `trading_account_id`, REFERENCES `users` (`id`)')
  expect(build.every(step => step.sql.startsWith(`CREATE TABLE \`${step.table}\``))).toBe(true)
})
it('resumes a committed working-table CREATE without replay and preserves the first eighteen steps', async () => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async sql => { await execute(sql); throw new Error('lost') }
  await expect(executeAccountBuild(f.store, foundation, build, { apply: true })).rejects.toThrow('lost')
  f.store.execute = execute
  const result = await executeAccountBuild(f.store, foundation, build, { apply: true })
  expect(result.steps[9].status).toBe('reconciled')
  await executeAccountBuild(f.store, foundation, build, { apply: true })
  expect(f.executed).toHaveLength(4)
  expect(f.rows).toHaveLength(22)
})
it('rejects old foundation drift before creating any working table', async () => {
  const f = fixture()
  f.tables.set(foundation[0].table, 'changed')
  await expect(executeAccountBuild(f.store, foundation, build, { apply: true })).rejects.toThrow('inplace_table_definition_conflict')
  expect(f.executed).toHaveLength(0)
})
