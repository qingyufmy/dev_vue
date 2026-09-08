import { expect, it } from 'vitest'
import { loadTemporalPrecisionCoordinator, originalTemporalDefinition } from '../scripts/lib/inplace-temporal-precision-schema.mjs'
import { loadIndependentStructureCoordinator } from '../scripts/lib/inplace-independent-structure-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url), plan = await loadTemporalPrecisionCoordinator(root)
function fixture() {
  const rows = plan.steps.slice(0, 75).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed',
    startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 75) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
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
it('keeps all 75 earlier checksums and preserves every nullable/default behavior', async () => {
  expect(plan.steps.slice(0, 75)).toEqual((await loadIndependentStructureCoordinator(root)).steps)
  expect(plan.steps).toHaveLength(91)
  for (const { before, after, step } of plan.transitions.slice(75)) {
    expect(after).toEqual({ ...before, type: 'datetime(3)', defaultValue: before.defaultValue === 'now()' ? 'now(3)' : null })
    expect(step.sql).not.toMatch(/ON UPDATE|CONVERT_TZ|DATE_ADD|DATE_SUB|UPDATE .* SET/)
  }
})
it.each(plan.steps.slice(75).map(row => [row.id]))('resumes %s without re-executing ALTER', async id => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async sql => { await execute(sql); if (f.executed.at(-1) === id) throw Error('ddl_ack_lost') }
  await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('ddl_ack_lost')
  f.store.execute = execute
  expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).steps.find(row => row.id === id).status).toBe('reconciled')
  expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
  expect(f.executed).toHaveLength(16)
})
it('rejects unexpected default and nullability changes before any write', async () => {
  for (const mutation of [{ defaultValue: 'now()' }, { nullable: 'YES' }]) {
    const f = fixture(), row = plan.transitions.at(-1)
    f.states.set(row.key, { ...row.before, ...mutation })
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.executed).toHaveLength(0)
  }
})
it('restores only reviewed precision tokens for schema comparison and rejects altered defaults', () => {
  const row = plan.transitions.find(item => item.step.id.includes('users_created_at'))
  expect(originalTemporalDefinition('users', row.step.afterLine, [row])).toBe(row.step.beforeLine)
  expect(() => originalTemporalDefinition('users', row.step.afterLine.replace('now(3)', "'2000-01-01'"), [row])).toThrow('definition_changed')
  expect(originalTemporalDefinition('users', row.step.afterLine + '\n  `other` int NOT NULL', [row])).toContain('`other` int NOT NULL')
})
