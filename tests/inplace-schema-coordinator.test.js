import { describe, expect, it } from 'vitest'
import { loadInplaceSchemaCoordinator, coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const plan = await loadInplaceSchemaCoordinator(new URL('../', import.meta.url))
function fixture() {
  const rows = [], states = new Map(), executed = []
  const store = {
    history: async () => rows,
    column: async (table, column) => states.get(`${table}.${column}`) ?? null,
    tableHash: async table => states.get(table) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: '2026-09-07T00:00:00Z', completedAt: null }),
    execute: async sql => {
      const transition = plan.transitions.find(item => item.step.sql === sql)
      states.set(transition.key, transition.after); executed.push(transition.step.id)
    },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: '2026-09-07T00:00:00Z' }),
  }
  return { rows, states, executed, store }
}

describe('same database schema coordinator', () => {
  it('coordinates all frozen steps and accepts final FK state on repeat', async () => {
    const f = fixture()
    expect(plan.steps).toHaveLength(29)
    expect((await coordinateInplaceSchema(f.store, plan)).structureComplete).toBe(false)
    expect(f.rows).toHaveLength(0)
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).steps.every(row => row.status === 'completed')).toBe(true)
    expect(f.executed).toHaveLength(29)
  })
  it.each(plan.steps.map((step, index) => [step.id, index]))('recovers lost DDL acknowledgement at %s without replay', async (_id, index) => {
    const f = fixture(), execute = f.store.execute
    f.store.execute = async sql => { await execute(sql); if (sql === plan.steps[index].sql) throw new Error('lost_response') }
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('lost_response')
    f.store.execute = execute
    const result = await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect(result.steps[index].status).toBe('reconciled')
    expect(f.executed).toHaveLength(29)
  })
  it('preflights a late schema conflict before any early write', async () => {
    const f = fixture(); f.states.set(plan.transitions.at(-1).key, 'unexpected')
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.rows).toHaveLength(0)
  })
  it('rejects unknown history, gaps and checksum drift', async () => {
    for (const mutation of [rows => { rows[0].id = 'unknown' }, rows => rows.shift(), rows => { rows[0].checksum = 'changed' }]) {
      const f = fixture(); await coordinateInplaceSchema(f.store, plan, { apply: true }); mutation(f.rows)
      await expect(coordinateInplaceSchema(f.store, plan)).rejects.toThrow()
    }
  })
  it('retries started DDL that never executed', async () => {
    const f = fixture(); await f.store.begin(plan.steps[0])
    await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect(f.executed).toHaveLength(29); expect(f.rows).toHaveLength(29)
  })
  it.each(['begin', 'complete'])('recovers an acknowledged-lost %s journal write', async method => {
    for (const target of plan.steps) {
      const f = fixture(), original = f.store[method]
      f.store[method] = async step => { await original(step); if (step.id === target.id) throw new Error('journal_response_lost') }
      await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('journal_response_lost')
      f.store[method] = original
      expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
      expect(f.executed).toHaveLength(29); expect(f.rows).toHaveLength(29)
    }
  })
  it('rejects drift in an already completed column or final table', async () => {
    for (const key of [plan.transitions[0].key, 'strategies']) {
      const f = fixture(); await coordinateInplaceSchema(f.store, plan, { apply: true })
      f.states.set(key, null)
      await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
      expect(f.executed).toHaveLength(29)
    }
  })
})
