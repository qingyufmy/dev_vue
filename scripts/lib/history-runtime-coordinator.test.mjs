import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadHistoryRuntimeUpgrade } from './history-runtime-upgrade.mjs'
import { coordinateHistoryRuntimeUpgrade } from './history-runtime-coordinator.mjs'

const root = new URL('../../', import.meta.url)
const plan = await loadHistoryRuntimeUpgrade(root, JSON.parse(await readFile(new URL('docs/architecture/history-runtime-reference-20260909.json', root))))
const stamp = '2026-09-09T00:00:00.000Z'
const row = (step, status) => ({ id: step.id, checksum: step.checksum, status, startedAt: stamp, completedAt: status === 'completed' ? stamp : null })
function fixture(failAt = null, phase = 'execute') {
  const history = plan.prior.steps.map(step => row(step, 'completed')), tables = new Map(), executed = []
  let failed = false
  const fail = (step, at) => {
    if (!failed && step.id === failAt && phase === at) { failed = true; throw Error('ack_lost') }
  }
  const store = {
    async verifyPlan() {}, async verifyPrior() {}, async verifyProtected() {},
    async history() { return structuredClone(history) },
    async tableState(table) { return tables.get(table) ?? null },
    async begin(step) { history.push(row(step, 'started')); fail(step, 'begin') },
    async execute(step) {
      assert.equal(tables.get(step.table)?.hash ?? null, step.beforeHash)
      tables.set(step.table, { hash: step.afterHash, rows: 0 }); executed.push(step.id); fail(step, 'execute')
    },
    async complete(step) { Object.assign(history.find(item => item.id === step.id), row(step, 'completed')); fail(step, 'complete') },
  }
  return { store, tables, history, executed }
}

test('read-only preflight performs no writes; full execution and replay validate final structures', async () => {
  const f = fixture()
  assert.deepEqual(await coordinateHistoryRuntimeUpgrade(f.store, plan), { status: 'pending', ddlCount: 0 })
  assert.equal(f.history.length, 176)
  assert.deepEqual(await coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 12 })
  f.tables.get(plan.added[0].table).rows = 1
  assert.deepEqual(await coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 0 })
})
for (const step of plan.added) {
  for (const phase of ['begin', 'execute', 'complete']) {
    test(`${step.id}: recovers ${phase} acknowledgement loss without repeating DDL`, async () => {
      const f = fixture(step.id, phase)
      await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /history_runtime_.*_unknown/)
      assert.equal((await coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true })).status, 'completed')
      assert.deepEqual(f.executed, plan.added.map(item => item.id))
    })
  }
}
test('rejects a preexisting later table before any write', async () => {
  const f = fixture(), step = plan.added.at(-1)
  f.tables.set(step.table, { hash: step.afterHash, rows: 0 })
  await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /table_conflict/)
  assert.equal(f.history.length, 176); assert.equal(f.executed.length, 0)
})
test('rejects conflicting ALTER state and populated unfinished tables', async () => {
  const step = plan.added[8], f = fixture(step.id)
  await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /ddl_unknown/)
  f.tables.get(step.table).hash = 'wrong'
  await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /table_conflict/)
  f.tables.set(step.table, { hash: step.afterHash, rows: 1 })
  await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /populated_table/)
})
test('rejects out-of-order journal records', async () => {
  const f = fixture(); f.history.push(row(plan.added[1], 'completed'))
  await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /history_gap/)
  assert.equal(f.executed.length, 0)
})
test('lost acknowledgement before DDL takes effect can resume from the recorded before-state', async () => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async () => { throw Error('connection_lost') }
  await assert.rejects(coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true }), /ddl_unknown/)
  f.store.execute = execute
  assert.equal((await coordinateHistoryRuntimeUpgrade(f.store, plan, { apply: true })).ddlCount, 12)
})
