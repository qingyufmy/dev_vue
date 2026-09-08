import { describe, expect, it } from 'vitest'
import { loadIndependentStructureCoordinator } from '../scripts/lib/inplace-independent-structure-schema.mjs'
import { loadLearningCompletionCoordinator } from '../scripts/lib/inplace-learning-completion-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url)
const plan = await loadIndependentStructureCoordinator(root)
function fixture() {
  const rows = plan.steps.slice(0, 64).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed',
    startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((transition, index) => {
    if (index < 64) states.set(transition.key, transition.after)
    else if (!states.has(transition.key)) states.set(transition.key, transition.before)
  })
  const store = {
    history: async () => rows,
    column: async (table, column) => states.get(`${table}.${column}`) ?? null,
    tableHash: async table => states.get(table) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: '2026-09-08T00:00:00Z', completedAt: null }),
    execute: async sql => {
      const transition = plan.transitions.find(row => row.step.sql === sql)
      states.set(transition.key, transition.after); executed.push(transition.step.id)
    },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: '2026-09-08T00:00:00Z' }),
  }
  return { rows, states, executed, store }
}

describe('independent structure upgrade', () => {
  it('keeps all 64 historical checksums and contains only ten CREATEs and one same-library FK', async () => {
    const prior = await loadLearningCompletionCoordinator(root)
    expect(plan.steps.slice(0, 64)).toEqual(prior.steps)
    expect(plan.steps).toHaveLength(75)
    expect(plan.steps.slice(64).filter(row => row.sql.startsWith('CREATE'))).toHaveLength(10)
    expect(plan.steps.slice(64).filter(row => row.sql.startsWith('ALTER'))).toHaveLength(1)
    expect(plan.steps.slice(64).some(row => /^(INSERT|UPDATE|DELETE|DROP)/.test(row.sql))).toBe(false)
  })
  it.each(plan.steps.slice(64).map(row => [row.id]))('recovers %s after DDL without re-executing it', async id => {
    const f = fixture(), execute = f.store.execute
    f.store.execute = async sql => { await execute(sql); if (f.executed.at(-1) === id) throw Error('ddl_ack_lost') }
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('ddl_ack_lost')
    f.store.execute = execute
    const result = await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect(result.steps.find(row => row.id === id).status).toBe('reconciled')
    expect(f.executed).toHaveLength(11)
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).steps.every(row => row.status === 'completed')).toBe(true)
    expect(f.executed).toHaveLength(11)
  })
  it('rejects an unrecorded late table before writing any journal entry or DDL', async () => {
    const f = fixture(); f.states.set('bridge_v4_pairing_requests', 'unexpected')
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.rows).toHaveLength(64); expect(f.executed).toHaveLength(0)
  })
  it('rejects modified historical checksums', async () => {
    const f = fixture(); f.rows[63].checksum = '0'.repeat(64)
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('checksum_mismatch')
    expect(f.executed).toHaveLength(0)
  })
})
