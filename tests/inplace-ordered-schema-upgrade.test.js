import { describe, expect, it } from 'vitest'
import { orderedSchemaStep, executeOrderedSchema } from '../scripts/lib/inplace-ordered-schema-upgrade.mjs'
const hash = value => value.repeat(64)
const time = '2026-09-06T00:00:00.000Z'
const steps = [
  orderedSchemaStep({ id: 'strategy_create', table: 'strategies', sql: 'CREATE TABLE `strategies` (id BIGINT UNSIGNED NOT NULL PRIMARY KEY)', beforeHash: null, afterHash: hash('a') }),
  orderedSchemaStep({ id: 'version_create', table: 'strategy_versions', sql: 'CREATE TABLE `strategy_versions` (id BIGINT UNSIGNED NOT NULL PRIMARY KEY)', beforeHash: null, afterHash: hash('b') }),
  orderedSchemaStep({ id: 'strategy_active_fk', table: 'strategies', sql: 'ALTER TABLE `strategies` ADD CONSTRAINT `fk_active` FOREIGN KEY (active_version_id) REFERENCES strategy_versions (id)', beforeHash: hash('a'), afterHash: hash('c') }),
]
const plan = { priorSteps: [], initialTables: { strategies: null, strategy_versions: null }, steps }
function fixture() {
  const rows = [], tables = new Map(), executed = []
  const store = { history: async () => rows, assertPrerequisites: async () => {}, tableHash: async table => tables.get(table) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: time, completedAt: null }),
    execute: async sql => { const step = steps.find(step => step.sql === sql); tables.set(step.table, step.afterHash); executed.push(step.id) },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: time }) }
  return { store, rows, tables, executed }
}
describe('ordered in-place schema transitions', () => {
  it('accepts final ALTER state on repeat without comparing obsolete CREATE fingerprints', async () => {
    const f = fixture()
    await executeOrderedSchema(f.store, plan, { apply: true })
    expect((await executeOrderedSchema(f.store, plan, { apply: true })).steps.every(step => step.status === 'completed')).toBe(true)
    expect(f.executed).toHaveLength(3)
  })
  it.each([0, 1, 2])('reconciles lost DDL response at transition %i without replay', async index => {
    const f = fixture(), execute = f.store.execute
    f.store.execute = async sql => { await execute(sql); if (sql === steps[index].sql) throw new Error('lost_response') }
    await expect(executeOrderedSchema(f.store, plan, { apply: true })).rejects.toThrow('lost_response')
    f.store.execute = execute
    const result = await executeOrderedSchema(f.store, plan, { apply: true })
    expect(result.steps[index].status).toBe('reconciled')
    expect(f.executed).toHaveLength(3)
  })
  it('retries a durable started step whose DDL did not execute', async () => {
    const f = fixture(); await f.store.begin(steps[0])
    await executeOrderedSchema(f.store, plan, { apply: true })
    expect(f.rows).toHaveLength(3); expect(f.executed).toHaveLength(3)
  })
  it('rejects an unexpected later table before any write', async () => {
    const f = fixture(); f.tables.set('strategy_versions', hash('b'))
    await expect(executeOrderedSchema(f.store, plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.rows).toHaveLength(0); expect(f.executed).toHaveLength(0)
  })
  it('rejects missing or drifted completed state, history gaps and plan mutation', async () => {
    const f = fixture(); await executeOrderedSchema(f.store, plan, { apply: true })
    f.tables.set('strategies', hash('a'))
    await expect(executeOrderedSchema(f.store, plan)).rejects.toThrow('schema_conflict')
    f.tables.set('strategies', hash('c')); f.rows.shift()
    await expect(executeOrderedSchema(f.store, plan)).rejects.toThrow('history_gap')
    const changed = { ...plan, steps: [{ ...steps[0], afterHash: hash('d') }, ...steps.slice(1)] }
    await expect(executeOrderedSchema(fixture().store, changed)).rejects.toThrow('chain_invalid')
  })
  it('does not write when prerequisites fail or during planning', async () => {
    const f = fixture(); await executeOrderedSchema(f.store, plan)
    f.store.assertPrerequisites = async () => { throw new Error('old_source_drift') }
    await expect(executeOrderedSchema(f.store, plan, { apply: true })).rejects.toThrow('old_source_drift')
    expect(f.rows).toHaveLength(0); expect(f.executed).toHaveLength(0)
  })
  it('rejects destructive ALTER and multiple statements', () => {
    expect(() => orderedSchemaStep({ ...steps[2], sql: steps[2].sql + ', DROP COLUMN active_version_id' })).toThrow()
    expect(() => orderedSchemaStep({ ...steps[2], sql: steps[2].sql + ', ADD COLUMN unsafe INT' })).toThrow()
    expect(() => orderedSchemaStep({ ...steps[2], sql: steps[2].sql + ' ON DELETE CASCADE' })).toThrow()
    expect(() => orderedSchemaStep({ ...steps[2], sql: steps[2].sql + '; DROP TABLE strategies' })).toThrow()
  })
})
