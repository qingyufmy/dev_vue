import { expect, it } from 'vitest'
import { loadColumnConstraintsCoordinator } from '../scripts/lib/inplace-column-constraints-schema.mjs'
import { loadModelCapacityCoordinator } from '../scripts/lib/inplace-model-capacity-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url), plan = await loadColumnConstraintsCoordinator(root)
it('keeps historical checksums and changes only the nine reviewed constraints', async () => {
  expect(plan.steps.slice(0, 105)).toEqual((await loadModelCapacityCoordinator(root)).steps)
  expect(plan.steps).toHaveLength(114)
  const users = plan.transitions.slice(105).filter(row => row.step.table === 'users')
  expect(users).toHaveLength(6)
  for (const row of users) expect(row.after).toEqual({ ...row.before, nullable: 'NO' })
  expect(plan.transitions.at(-1).after).toEqual({ ...plan.transitions.at(-1).before, nullable: 'YES', defaultValue: null })
})
it.each(plan.steps.slice(105).map(step => [step.id]))('recovers %s without repeating ALTER or resetting prior column changes', async id => {
  const rows = plan.steps.slice(0, 105).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 105) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
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
  expect(executed).toHaveLength(9)
})
