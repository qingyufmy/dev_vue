import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { loadRiskStructureMigration } from '../scripts/lib/inplace-risk-structure.mjs'
import { coordinateRiskStructure } from '../scripts/lib/risk-structure-coordinator.mjs'

const plan = await loadRiskStructureMigration(new URL('../', import.meta.url))
const at = '2026-09-09T00:00:00.000Z'
function fixture() {
  const history = plan.prior.steps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: at, completedAt: at }))
  const states = new Map(), hashes = new Map(), calls = []
  const definitions = plan.additions.map(step => {
    const beforeHash = hashes.get(step.table) ?? null
    const afterHash = createHash('sha256').update(step.id).digest('hex')
    hashes.set(step.table, afterHash)
    return { stepId: step.id, beforeHash, afterHash }
  })
  const store = {
    async verifyPlan() { return definitions }, async history() { return structuredClone(history) },
    async tableState(table) { return states.get(table) ?? null },
    async snapshot() { return [{ name: 'old_table', rows: 3 }, ...[...states].map(([name, value]) => ({ name, rows: value.rows }))] },
    async verifyProtected(snapshot) { assert.deepEqual(snapshot, [{ name: 'old_table', rows: 3 }]) },
    async verifyPrior(rows, snapshot) { assert.equal(rows.length, 166); assert.deepEqual(snapshot, [{ name: 'old_table', rows: 3 }]); return { status: 'completed' } },
    async begin(step) { calls.push(['begin', step.id]); history.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: at, completedAt: null }) },
    async execute(step) { calls.push(['ddl', step.id]); states.set(step.table, { hash: definitions.find(row => row.stepId === step.id).afterHash, rows: 0 }) },
    async complete(step) { calls.push(['complete', step.id]); Object.assign(history.find(row => row.id === step.id), { status: 'completed', completedAt: at }) },
  }
  return { store, states, history, definitions, calls }
}
test('inspect is read-only; all eight transitions including the repeated policy table complete once', async () => {
  const f = fixture()
  assert.deepEqual(await coordinateRiskStructure(f.store, plan), { status: 'pending', ddlCount: 0 })
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await coordinateRiskStructure(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 8 })
  f.states.get('risk_policy_sets_v4').rows = 3
  assert.deepEqual(await coordinateRiskStructure(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 0 })
})
for (const index of [0, 2]) test(`lost DDL response at step ${index} reconciles without repeating CREATE or ALTER`, async () => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async step => { await execute(step); if (step.id === plan.additions[index].id) throw Error('connection lost') }
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /ddl_unknown/)
  assert.equal((await coordinateRiskStructure(f.store, plan)).status, 'reconcile')
  f.store.execute = execute
  await coordinateRiskStructure(f.store, plan, { apply: true })
  assert.equal(f.calls.filter(([kind, id]) => kind === 'ddl' && id === plan.additions[index].id).length, 1)
})
test('lost completion response resumes from durable history', async () => {
  const f = fixture(), complete = f.store.complete
  f.store.complete = async step => { await complete(step); throw Error('lost') }
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /complete_unknown/)
  f.store.complete = complete
  await coordinateRiskStructure(f.store, plan, { apply: true })
  assert.equal(f.calls.filter(([kind]) => kind === 'ddl').length, 8)
})
test('a conflicting later table rejects before recording the first step', async () => {
  const f = fixture()
  f.states.set('risk_manual_releases', { hash: 'a'.repeat(64), rows: 0 })
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /table_conflict/)
  assert.equal(f.calls.length, 0)
})
test('DDL rows, missing completed structures, and broken old history are rejected', async () => {
  const f = fixture()
  await f.store.begin(plan.additions[0]); await f.store.execute(plan.additions[0])
  f.states.get('risk_policy_sets_v4').rows = 1
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /premature_rows/)
  const g = fixture()
  await coordinateRiskStructure(g.store, plan, { apply: true })
  g.states.delete('account_risk_states')
  await assert.rejects(coordinateRiskStructure(g.store, plan), /table_conflict/)
  const h = fixture(); h.history[0].checksum = 'bad'
  await assert.rejects(coordinateRiskStructure(h.store, plan, { apply: true }), /checksum_mismatch/)
  assert.equal(h.calls.length, 0)
})
test('rejects changed definitions and protected-data failures before writes', async () => {
  const f = fixture(); f.definitions[2].beforeHash = null
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /definition_chain/)
  assert.equal(f.calls.length, 0)
  const g = fixture(); g.store.verifyProtected = async () => { throw Error('old data changed') }
  await assert.rejects(coordinateRiskStructure(g.store, plan, { apply: true }), /old data changed/)
  assert.equal(g.calls.length, 0)
})
test('lost begin acknowledgement never sends DDL until a fresh inspection', async () => {
  const f = fixture(), begin = f.store.begin
  f.store.begin = async step => { await begin(step); throw Error('lost begin') }
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /begin_unknown/)
  assert.equal(f.calls.filter(([kind]) => kind === 'ddl').length, 0)
  f.store.begin = begin
  await coordinateRiskStructure(f.store, plan, { apply: true })
  assert.equal(f.calls.filter(([kind, id]) => kind === 'begin' && id === plan.additions[0].id).length, 1)
})
test('invalid DDL postcondition is not marked complete', async () => {
  const f = fixture()
  f.store.execute = async step => { f.states.set(step.table, { hash: 'f'.repeat(64), rows: 0 }) }
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /table_conflict/)
  assert.equal(f.calls.filter(([kind]) => kind === 'complete').length, 0)
  assert.equal(f.history.at(-1).status, 'started')
})
test('snapshot disagreement and failed nested prior proof block writes', async () => {
  const f = fixture()
  f.store.snapshot = async () => [{ name: 'old_table', rows: 3 }, { name: 'risk_manual_releases', rows: 0 }]
  await assert.rejects(coordinateRiskStructure(f.store, plan, { apply: true }), /snapshot_disagreement/)
  assert.equal(f.calls.length, 0)
  const g = fixture(); g.store.verifyPrior = async () => ({ status: 'pending' })
  await assert.rejects(coordinateRiskStructure(g.store, plan, { apply: true }), /prior_not_completed/)
  assert.equal(g.calls.length, 0)
})
