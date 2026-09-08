import { expect, it } from 'vitest'
import { loadModelCapacityCoordinator, originalCapacityDefinition } from '../scripts/lib/inplace-model-capacity-schema.mjs'
import { loadTemporalPrecisionCoordinator } from '../scripts/lib/inplace-temporal-precision-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'
import { executeModelCapacityUpgrade } from '../scripts/lib/execute-model-capacity-upgrade.mjs'

const root = new URL('../', import.meta.url), plan = await loadModelCapacityCoordinator(root)
function fixture() {
  const rows = plan.steps.slice(0, 91).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed',
    startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 91) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
  const store = {
    history: async () => rows,
    column: async (table, column) => states.get(`${table}.${column}`) ?? null,
    tableHash: async table => states.get(table) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: '2026-09-08T00:00:00Z', completedAt: null }),
    execute: async sql => { const row = plan.transitions.find(item => item.step.sql === sql); states.set(row.key, row.after); executed.push(row.step.id) },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: '2026-09-08T00:00:00Z' }),
  }
  return { rows, states, executed, store }
}
it('keeps 91 historical steps and preserves NULL/default/collation for all 14 non-key columns', async () => {
  expect(plan.steps.slice(0, 91)).toEqual((await loadTemporalPrecisionCoordinator(root)).steps)
  expect(plan.steps).toHaveLength(105)
  for (const { before, after, step } of plan.transitions.slice(91)) {
    expect({ ...after, type: before.type }).toEqual(before)
    expect(step.column).not.toMatch(/^(id|strategy_id|status)$/)
  }
})
it.each(plan.steps.slice(91).map(row => [row.id]))('recovers %s after DDL without repetition', async id => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async sql => { await execute(sql); if (f.executed.at(-1) === id) throw Error('ddl_ack_lost') }
  await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('ddl_ack_lost')
  f.store.execute = execute
  expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).steps.find(row => row.id === id).status).toBe('reconciled')
  expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
  expect(f.executed).toHaveLength(14)
})
it('rejects a non-strict SQL session before reading or changing the schema', async () => {
  const connection = { query: async () => [[{ db: 'dev_vue', uuid: 'ac423207-6ef3-11f1-b302-000c29fda104', sql_mode: 'NO_ENGINE_SUBSTITUTION' }]] }
  await expect(executeModelCapacityUpgrade(connection, { database: 'dev_vue' })).rejects.toThrow('strict_mode_required')
})
it('does not hide an unexpected default change in structure comparison', () => {
  const row = plan.transitions.find(item => item.step.id.includes('daily_requests_per_user'))
  expect(originalCapacityDefinition(row.step.table, row.step.afterLine, [row])).toBe(row.step.beforeLine)
  expect(() => originalCapacityDefinition(row.step.table, row.step.afterLine.replace("'100'", "'0'"), [row])).toThrow('definition_changed')
})
