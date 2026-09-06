import { describe, expect, it } from 'vitest'
import { loadReferralRuleCoordinator, originalReferralRuleDefinition } from '../scripts/lib/inplace-referral-rule-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const plan = await loadReferralRuleCoordinator(new URL('../', import.meta.url))
function fixture() {
  const rows = [], states = new Map(), executed = []
  const stamp = '2026-09-07T00:00:00Z'
  for (const t of plan.transitions.slice(0, -1)) {
    states.set(t.key, t.after)
    rows.push({ id: t.step.id, checksum: t.step.checksum, status: 'completed', startedAt: stamp, completedAt: stamp })
  }
  states.set('referral_rules', plan.transitions.at(-1).before)
  const store = { history: async () => rows, column: async (t, c) => states.get(`${t}.${c}`) ?? null,
    tableHash: async t => states.get(t) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: stamp, completedAt: null }),
    execute: async sql => { const t = plan.transitions.find(t => t.step.sql === sql); states.set(t.key, t.after); executed.push(t.step.id) },
    complete: async step => Object.assign(rows.find(r => r.id === step.id), { status: 'completed', completedAt: stamp }) }
  return { store, rows, states, executed }
}
describe('existing referral rule table upgrade', () => {
  it('extends 51 completed steps and performs exactly one ALTER across repeats', async () => {
    const f = fixture()
    expect(plan.steps).toHaveLength(52)
    expect((await coordinateInplaceSchema(f.store, plan)).steps.at(-1).status).toBe('pending')
    await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
    expect(f.executed).toHaveLength(1)
  })
  it('reconciles committed DDL without replay when completion acknowledgement is lost', async () => {
    const f = fixture(), execute = f.store.execute
    f.store.execute = async sql => { await execute(sql); throw Error('lost') }
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('lost')
    f.store.execute = execute
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).steps.at(-1).status).toBe('reconciled')
    expect(f.executed).toHaveLength(1)
  })
  it('rejects unjournaled ALTER and unrelated drift before writing', async () => {
    for (const actual of [plan.transitions.at(-1).after, 'drift']) {
      const f = fixture(); f.states.set('referral_rules', actual)
      await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
      expect(f.rows).toHaveLength(51); expect(f.executed).toHaveLength(0)
    }
  })
  it('normalizes only exact reviewed definitions for the original schema fingerprint', () => {
    const ref = plan.referralRuleReference
    expect(originalReferralRuleDefinition(ref.afterDdl, ref)).toBe(ref.beforeDdl)
    expect(originalReferralRuleDefinition(ref.beforeDdl, ref)).toBe(ref.beforeDdl)
    for (const ddl of [ref.afterDdl.replace('10000', '20000'), ref.afterDdl.replace('bigint unsigned', 'int unsigned'),
      ref.beforeDdl.replace('DEFAULT \'1000\'', 'DEFAULT \'2000\'')])
      expect(() => originalReferralRuleDefinition(ddl, ref)).toThrow('definition_conflict')
  })
})
