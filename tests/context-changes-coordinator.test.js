import { expect, it } from 'vitest'
import { loadTradingContextChanges } from '../scripts/lib/inplace-trading-context-changes.mjs'
import { coordinateContextChanges } from '../scripts/lib/context-changes-coordinator.mjs'

const plan = await loadTradingContextChanges(new URL('../', import.meta.url))
const at = '2026-09-08T00:00:00.000Z'
function fixture() {
  const history = plan.prior.steps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: at, completedAt: at }))
  let table = null, failDdl = false, failComplete = false, protectedValid = true, priorValid = true
  const calls = [], priorSnapshots = []
  const store = {
    async verifyPlan() { calls.push('verify-plan') }, async history() { return structuredClone(history) },
    async tableState() { return table },
    async snapshot() { return [{ name: 'old_table', rows: 3 }, ...(table ? [{ name: 'trading_context_changes_v4', rows: table.rows }] : [])] },
    async verifyProtected(snapshot, completed) { calls.push('protected-' + completed); if (!protectedValid) throw Error('old_rows_changed') },
    async verifyPrior(rows, snapshot) { expect(rows).toHaveLength(164); priorSnapshots.push(snapshot); if (!priorValid) throw Error('old_schema_changed'); return { status: 'completed' } },
    async begin(step) { calls.push('begin'); history.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: at, completedAt: null }) },
    async execute() { calls.push('ddl'); table = { matches: true, rows: 0 }; if (failDdl) throw Error('lost-ddl-ack') },
    async complete() { calls.push('complete'); history.at(-1).status = 'completed'; history.at(-1).completedAt = at; if (failComplete) throw Error('lost-complete-ack') },
  }
  return { store, history, calls, priorSnapshots, setTable: value => { table = value },
    failDdl: () => { failDdl = true }, failComplete: () => { failComplete = true },
    damageProtected: () => { protectedValid = false }, damagePrior: () => { priorValid = false } }
}

it('defaults to read-only and preserves the full old snapshot for historical checks', async () => {
  const f = fixture()
  expect(await coordinateContextChanges(f.store, plan)).toEqual({ status: 'pending', ddlCount: 0 })
  expect(f.calls).not.toContain('begin')
  expect(f.priorSnapshots).toEqual([[{ name: 'old_table', rows: 3 }]])
})

it('creates once, validates before completion and accepts future rows after completed registration', async () => {
  const f = fixture()
  expect(await coordinateContextChanges(f.store, plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 1 })
  f.setTable({ matches: true, rows: 4 })
  expect(await coordinateContextChanges(f.store, plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 0 })
  expect(f.calls.filter(call => call === 'ddl')).toHaveLength(1)
  expect(f.priorSnapshots.every(snapshot => snapshot.length === 1 && snapshot[0].name === 'old_table')).toBe(true)
})

it('recovers lost DDL acknowledgement by completing the journal without another create', async () => {
  const f = fixture(); f.failDdl()
  await expect(coordinateContextChanges(f.store, plan, { apply: true })).rejects.toThrow('context_changes_ddl_unknown')
  expect(await coordinateContextChanges(f.store, plan)).toEqual({ status: 'reconcile', ddlCount: 0 })
  expect(await coordinateContextChanges(f.store, plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 0 })
  expect(f.calls.filter(call => call === 'ddl')).toHaveLength(1)
})

it('recognizes a completed journal after lost completion acknowledgement', async () => {
  const f = fixture(); f.failComplete()
  await expect(coordinateContextChanges(f.store, plan, { apply: true })).rejects.toThrow('context_changes_complete_unknown')
  expect(await coordinateContextChanges(f.store, plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 0 })
})

it('rejects unregistered, mismatched or prematurely populated tables', async () => {
  for (const [recorded, table, code] of [[false, { matches: true, rows: 0 }, 'unrecorded_table'],
    [true, { matches: false, rows: 0 }, 'table_conflict'], [true, { matches: true, rows: 1 }, 'uncompleted_table_has_rows']]) {
    const f = fixture()
    if (recorded) await f.store.begin(plan.additions[0])
    f.setTable(table)
    await expect(coordinateContextChanges(f.store, plan, { apply: true })).rejects.toThrow('context_changes_' + code)
    expect(f.calls).not.toContain('ddl')
  }
})

it('does not hide unexpected history or failures from old data and schema verification', async () => {
  for (const kind of ['unknown', 'rows', 'schema']) {
    const f = fixture()
    if (kind === 'unknown') f.history.push({ id: 'other' })
    if (kind === 'rows') f.damageProtected()
    if (kind === 'schema') f.damagePrior()
    await expect(coordinateContextChanges(f.store, plan, { apply: true })).rejects.toThrow()
    expect(f.calls).not.toContain('begin')
  }
})

it('rejects a missing completed table and metadata/snapshot disagreement', async () => {
  const f = fixture()
  await coordinateContextChanges(f.store, plan, { apply: true })
  f.setTable(null)
  await expect(coordinateContextChanges(f.store, plan)).rejects.toThrow('context_changes_completed_table_missing')
  const g = fixture()
  await g.store.begin(plan.additions[0]); g.setTable({ matches: true, rows: 0 })
  g.store.snapshot = async () => [{ name: 'old_table', rows: 3 }]
  await expect(coordinateContextChanges(g.store, plan)).rejects.toThrow('context_changes_snapshot_table_disagreement')
})

it('never records completion when the DDL postcondition is invalid', async () => {
  const f = fixture()
  f.store.execute = async () => { f.setTable({ matches: false, rows: 0 }) }
  await expect(coordinateContextChanges(f.store, plan, { apply: true })).rejects.toThrow('context_changes_table_conflict')
  expect(f.calls).not.toContain('complete')
  expect(f.history.at(-1).status).toBe('started')
})
