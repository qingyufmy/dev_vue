import { expect, it } from 'vitest'
import { loadModelCheckCoordinator, removeModelCheckDefinition } from '../scripts/lib/inplace-model-check-schema.mjs'
import { loadDefaultNormalizationCoordinator } from '../scripts/lib/inplace-default-normalization-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url), plan = await loadModelCheckCoordinator(root)
it('preserves all prior checksums', async () => { expect(plan.steps.slice(0,131)).toEqual((await loadDefaultNormalizationCoordinator(root)).steps);expect(plan.steps).toHaveLength(133) })
it.each(plan.steps.slice(131).map(step => [step.id]))('recovers %s without repeating ALTER or resetting prior column changes', async id => {
  const rows = plan.steps.slice(0, 131).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 131) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
  const execute = async sql => { const row = plan.transitions.find(item => item.step.sql === sql); states.set(row.key, row.after); executed.push(row.step.id) }
  const store = { history: async () => rows, column: async (table, column) => states.get(`${table}.${column}`) ?? null,
    tableHash: async table => states.get(table) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: '2026-09-08T00:00:00Z', completedAt: null }),
    execute: async sql => { await execute(sql); if (executed.at(-1) === id) throw Error('lost_ack') },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: '2026-09-08T00:00:00Z' }) }
  await expect(coordinateInplaceSchema(store, plan, { apply: true })).rejects.toThrow('lost_ack')
  store.execute = execute
  expect((await coordinateInplaceSchema(store, plan, { apply: true })).steps.find(row => row.id === id).status).toBe('reconciled')
  expect((await coordinateInplaceSchema(store, plan, { apply: true })).structureComplete).toBe(true)
  expect(executed).toHaveLength(2)
})

it('normalizes only the exact new CHECK while retaining unexpected changes', () => {
for (const row of plan.transitions.slice(131)) {
 expect(removeModelCheckDefinition(row.afterDefinition,row)).toBe(row.beforeDefinition)
 expect(removeModelCheckDefinition(row.afterDefinition.replace('CHECK (','CHECK (NOT '),row)).not.toBe(row.beforeDefinition)
 expect(removeModelCheckDefinition(row.afterDefinition.replace('NOT NULL','NULL'),row)).not.toBe(row.beforeDefinition)
}
})
