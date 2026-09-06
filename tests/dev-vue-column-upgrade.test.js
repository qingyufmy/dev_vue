import { describe, expect, it } from 'vitest'
import { executeColumnSteps, inplaceColumnSteps } from '../scripts/lib/dev-vue-column-upgrade.mjs'

function fixture() {
  const journal = new Map(), columns = new Map(), executed = []
  return { journal, columns, executed, failAfterDdl: false,
    store: {
      journal: async id => journal.get(id) ?? null,
      column: async (table, name) => columns.get(`${table}.${name}`) ?? null,
      begin: async step => { journal.set(step.id, { checksum: step.checksum, status: 'started' }) },
      execute: async sql => {
        executed.push(sql)
        const step = inplaceColumnSteps.find(step => step.sql === sql)
        columns.set(`${step.table}.${step.column}`, { ...step.expected })
      },
      complete: async step => { journal.set(step.id, { checksum: step.checksum, status: 'completed' }) },
    },
  }
}

describe('same database additive upgrade steps', () => {
  it('plans without writes and applies each column once', async () => {
    const f = fixture()
    await executeColumnSteps(f.store)
    expect(f.journal.size).toBe(0)
    await executeColumnSteps(f.store, inplaceColumnSteps, { apply: true })
    await executeColumnSteps(f.store, inplaceColumnSteps, { apply: true })
    expect(f.executed).toHaveLength(9)
    expect(f.executed.every(sql => sql.startsWith('ALTER TABLE') && sql.includes('ADD COLUMN'))).toBe(true)
  })
  it('reconciles DDL success with lost response without executing it twice', async () => {
    const f = fixture(), execute = f.store.execute
    f.store.execute = async sql => { await execute(sql); throw new Error('connection_lost') }
    await expect(executeColumnSteps(f.store, inplaceColumnSteps, { apply: true })).rejects.toThrow('connection_lost')
    f.store.execute = execute
    const result = await executeColumnSteps(f.store, inplaceColumnSteps, { apply: true })
    expect(result.steps[0].status).toBe('reconciled')
    expect(f.executed).toHaveLength(9)
  })
  it('preflights the whole batch and rejects an unrecorded last column before writing', async () => {
    const f = fixture(), last = inplaceColumnSteps.at(-1)
    f.columns.set(`${last.table}.${last.column}`, last.expected)
    await expect(executeColumnSteps(f.store, inplaceColumnSteps, { apply: true })).rejects.toThrow('inplace_unrecorded_column')
    expect(f.journal.size).toBe(0)
    expect(f.executed).toHaveLength(0)
  })
  it('rejects altered definitions and checksums instead of overwriting', async () => {
    const f = fixture(), first = inplaceColumnSteps[0]
    f.journal.set(first.id, { checksum: 'changed', status: 'started' })
    await expect(executeColumnSteps(f.store)).rejects.toThrow('inplace_step_checksum_mismatch')
    f.journal.set(first.id, { checksum: first.checksum, status: 'started' })
    f.columns.set(`${first.table}.${first.column}`, { ...first.expected, nullable: 'NO' })
    await expect(executeColumnSteps(f.store)).rejects.toThrow('inplace_column_definition_conflict')
  })
})
