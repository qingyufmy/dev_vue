import { describe, expect, it } from 'vitest'
import { loadPaymentMatchCoordinator } from '../scripts/lib/inplace-payment-match-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const plan = await loadPaymentMatchCoordinator(new URL('../', import.meta.url))
function fixture() {
  const rows = [], states = new Map(), executed = []
  const stamp = '2026-09-07T00:00:00Z'
  for (const t of plan.transitions.slice(0, 48)) {
    states.set(t.key, t.after)
    rows.push({ id: t.step.id, checksum: t.step.checksum, status: 'completed', startedAt: stamp, completedAt: stamp })
  }
  const store = { history: async () => rows, column: async (t, c) => states.get(`${t}.${c}`) ?? null,
    tableHash: async t => states.get(t) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: stamp, completedAt: null }),
    execute: async sql => { const t = plan.transitions.find(t => t.step.sql === sql); states.set(t.key, t.after); executed.push(t.step.id) },
    complete: async step => Object.assign(rows.find(r => r.id === step.id), { status: 'completed', completedAt: stamp }) }
  return { store, rows, states, executed }
}
describe('payment order additive same database phase', () => {
  it('extends completed phases with one payment order table and repeats without DDL', async () => {
    const f = fixture()
    expect(plan.steps).toHaveLength(50)
    expect((await coordinateInplaceSchema(f.store, plan)).steps.filter(s => s.status === 'pending')).toHaveLength(2)
    await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
    expect(f.executed).toHaveLength(2)
  })
  it.each(['payment_transactions', 'payment_matches'])('recovers committed CREATE of %s without replay', async table => {
    const f = fixture(), execute = f.store.execute
    const target = plan.steps.find(s => s.table === table)
    f.store.execute = async sql => { await execute(sql); if (sql === target.sql) throw new Error('lost') }
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('lost')
    f.store.execute = execute
    const result = await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect(result.steps.find(s => s.id === target.id).status).toBe('reconciled')
    expect(f.executed).toHaveLength(2)
  })
  it('refuses an unrecorded last table before any writes', async () => {
    const f = fixture(); f.states.set('payment_matches', 'conflict')
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.rows).toHaveLength(48); expect(f.executed).toHaveLength(0)
  })
})
