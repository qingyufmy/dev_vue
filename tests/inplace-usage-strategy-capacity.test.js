import { expect, it } from 'vitest'
import { loadUsageStrategyCapacityCoordinator } from '../scripts/lib/inplace-usage-strategy-capacity-schema.mjs'
import { loadFoundationForeignKeyCoordinator } from '../scripts/lib/inplace-foundation-foreign-key-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url), plan = await loadUsageStrategyCapacityCoordinator(root)
it('preserves all prior checksums', async () => { expect(plan.steps.slice(0,144)).toEqual((await loadFoundationForeignKeyCoordinator(root)).steps);expect(plan.steps).toHaveLength(145) })
it.each(plan.steps.slice(144).map(step => [step.id]))('recovers %s without repeating ALTER or resetting prior column changes', async id => {
  const rows = plan.steps.slice(0, 144).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 144) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
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
  expect(executed).toHaveLength(1)
})

it('changes only the nullable audit strategy integer capacity',()=>{ const row=plan.transitions.at(-1);expect(row.afterDefinition.replace(row.afterLine,row.beforeLine)).toBe(row.beforeDefinition);expect(row.beforeLine).toContain('DEFAULT NULL');expect(row.afterLine).toContain('bigint unsigned DEFAULT NULL') })
