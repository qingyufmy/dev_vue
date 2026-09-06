import { describe, expect, it } from 'vitest'
import { loadUserDefaultsCoordinator, originalUserDefaultDefinition } from '../scripts/lib/inplace-user-defaults.mjs'
import { readFile } from 'node:fs/promises'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const plan = await loadUserDefaultsCoordinator(new URL('../', import.meta.url))
function fixture() {
  const rows = [], states = new Map(), executed = []
  const stamp = '2026-09-07T00:00:00Z'
  for (const t of plan.transitions.slice(0, 40)) {
    states.set(t.key, t.after)
    rows.push({ id: t.step.id, checksum: t.step.checksum, status: 'completed', startedAt: stamp, completedAt: stamp })
  }
  for (const t of plan.transitions.slice(40)) states.set(t.key, t.before)
  const store = { history: async () => rows, column: async (t, c) => states.get(`${t}.${c}`) ?? null,
    tableHash: async t => states.get(t) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: stamp, completedAt: null }),
    execute: async sql => { const t = plan.transitions.find(t => t.step.sql === sql); states.set(t.key, t.after); executed.push(t.step.id) },
    complete: async step => Object.assign(rows.find(r => r.id === step.id), { status: 'completed', completedAt: stamp }) }
  return { store, rows, states, executed }
}
describe('user defaults preserve existing rows', () => {
  it('extends completed phases with five default-only changes and repeats without DDL', async () => {
    const f = fixture()
    expect(plan.steps).toHaveLength(45)
    expect((await coordinateInplaceSchema(f.store, plan)).steps.filter(s => s.status === 'pending')).toHaveLength(5)
    await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect((await coordinateInplaceSchema(f.store, plan, { apply: true })).structureComplete).toBe(true)
    expect(f.executed).toHaveLength(5)
  })
  it.each(plan.steps.slice(40).map(s => s.column))('recovers committed default change of %s without replay', async column => {
    const f = fixture(), execute = f.store.execute
    const target = plan.steps.find(s => s.column === column)
    f.store.execute = async sql => { await execute(sql); if (sql === target.sql) throw new Error('lost') }
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('lost')
    f.store.execute = execute
    const result = await coordinateInplaceSchema(f.store, plan, { apply: true })
    expect(result.steps.find(s => s.id === target.id).status).toBe('reconciled')
    expect(f.executed).toHaveLength(5)
  })
  it('refuses an unrecorded last table before any writes', async () => {
    const f = fixture(); f.states.set(plan.transitions.at(-1).key, 'conflict')
    await expect(coordinateInplaceSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.rows).toHaveLength(40); expect(f.executed).toHaveLength(0)
  })
})

const reference = JSON.parse(await readFile(new URL('../docs/migration/dev-vue-users-default-reference-20260907.json', import.meta.url)))
it('restores only reviewed default tokens while retaining unrelated schema changes', () => {
  let after = reference.ddl
  for (const t of plan.transitions.slice(40)) {
    after = after.split('\n').map(line => line.startsWith(`  \`${t.step.column}\` `) ? line.replace(`DEFAULT '${t.before.defaultValue}'`, 'DEFAULT NULL') : line).join('\n')
  }
  expect(originalUserDefaultDefinition(after)).toBe(reference.ddl)
  expect(originalUserDefaultDefinition(after.replace('tinyint DEFAULT NULL', 'bigint DEFAULT NULL'))).not.toBe(reference.ddl)
  expect(() => originalUserDefaultDefinition(after.replace('`email_verified`', '`renamed`'))).toThrow('definition')
})
