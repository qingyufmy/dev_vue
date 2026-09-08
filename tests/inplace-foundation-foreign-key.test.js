import { expect, it } from 'vitest'
import { loadFoundationForeignKeyCoordinator, removeFoundationForeignKeyDefinitions } from '../scripts/lib/inplace-foundation-foreign-key-schema.mjs'
import { loadRuntimeIndexCoordinator } from '../scripts/lib/inplace-runtime-index-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url), plan = await loadFoundationForeignKeyCoordinator(root)
it('preserves all prior checksums', async () => { expect(plan.steps.slice(0,139)).toEqual((await loadRuntimeIndexCoordinator(root)).steps);expect(plan.steps).toHaveLength(144) })
it.each(plan.steps.slice(139).map(step => [step.id]))('recovers %s without repeating ALTER or resetting prior column changes', async id => {
  const rows = plan.steps.slice(0, 139).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 139) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
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
  expect(executed).toHaveLength(5)
})

it('preserves all old indexes and constraints when checking data parity',()=>{
const additions=plan.transitions.slice(139)
for(const name of new Set(additions.map(r=>r.step.table))){const rows=additions.filter(r=>r.step.table===name);expect(removeFoundationForeignKeyDefinitions(name,rows.at(-1).afterDefinition,additions)).toBe(rows[0].beforeDefinition);expect(removeFoundationForeignKeyDefinitions(name,rows.at(-1).afterDefinition.replace('REFERENCES','ON DELETE CASCADE REFERENCES'),additions)).not.toBe(rows[0].beforeDefinition)}
})
