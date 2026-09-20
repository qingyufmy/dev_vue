import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadRiskPolicyReceiptUpgrade, coordinateRiskPolicyReceiptUpgrade as run, riskReceiptPlanHash } from '../scripts/lib/risk-policy-receipt-upgrade.mjs'

const root = new URL('../', import.meta.url)
const reference = JSON.parse(await readFile(new URL('docs/architecture/risk-policy-receipt-and-release-reference-v2-20260909.json', root), 'utf8'))
const plan = await loadRiskPolicyReceiptUpgrade(root, reference)
const at = '2026-09-09T00:00:00.000Z'
test('fingerprints executable steps and reference evidence without serializing historical factories', () => {
  const original = riskReceiptPlanHash(plan)
  assert.match(original, /^[a-f0-9]{64}$/)
  assert.notEqual(riskReceiptPlanHash({ ...plan, step: { ...plan.step, sql: 'changed' } }), original)
  assert.notEqual(riskReceiptPlanHash({ ...plan, referenceHash: 'changed' }), original)
})
function fixture() {
  const history = plan.prior.steps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: at, completedAt: at }))
  let table = null
  const calls = []
  const store = { verifyPlan: async () => {}, history: async () => structuredClone(history),
    verifyPrior: async rows => assert.equal(rows.length, 174), verifyProtected: async () => {}, tableState: async () => table,
    begin: async step => { calls.push('begin'); history.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: at, completedAt: null }) },
    execute: async () => { calls.push('ddl'); table = { hash: plan.step.afterHash, rows: 0 } },
    complete: async () => { calls.push('complete'); Object.assign(history.at(-1), { status: 'completed', completedAt: at }) } }
  return { store, history, calls, setTable: value => { table = value } }
}
test('appends step 175, inspects without writes and replays without DDL', async () => {
  assert.equal(plan.steps.length, 175)
  const f = fixture()
  assert.deepEqual(await run(f.store, plan), { status: 'pending', ddlCount: 0 }); assert.deepEqual(f.calls, [])
  assert.deepEqual(await run(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 1 })
  assert.deepEqual(await run(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 0 })
})
test('reconciles a lost CREATE acknowledgement without replaying it', async () => {
  const f = fixture(), execute = f.store.execute
  f.store.execute = async () => { await execute(); throw Error('lost response') }
  await assert.rejects(run(f.store, plan, { apply: true }), /ddl_unknown/)
  assert.deepEqual(await run(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 0 })
  assert.equal(f.calls.filter(x => x === 'ddl').length, 1)
})
test('refuses unrecorded tables, prior gaps and protected-data failures before writes', async () => {
  for (const change of [f => f.setTable({ hash: plan.step.afterHash, rows: 0 }), f => f.history.pop(),
    f => { f.store.verifyProtected = async () => { throw Error('protected changed') } }]) {
    const f = fixture(); change(f)
    await assert.rejects(run(f.store, plan, { apply: true })); assert.deepEqual(f.calls, [])
  }
})
test('rejects altered migration evidence and missing true-MySQL checks', async () => {
  for (const modify of [r => { r.migrationSha256 = 'bad' }, r => { r.checks.pop() }, r => { r.referenceDatabaseRemoved = false }]) {
    const invalid = structuredClone(reference); modify(invalid)
    await assert.rejects(loadRiskPolicyReceiptUpgrade(root, invalid), /reference/)
  }
})
