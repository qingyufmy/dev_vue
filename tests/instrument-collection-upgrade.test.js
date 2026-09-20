import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadInstrumentCollectionMigration } from '../scripts/lib/inplace-instrument-collection-schema.mjs'
import { coordinateInstrumentCollectionUpgrade as run, loadInstrumentCollectionUpgrade } from '../scripts/lib/instrument-collection-upgrade.mjs'

const registry = await loadInstrumentCollectionMigration(new URL('../', import.meta.url))
// Synthetic fingerprint for coordinator behavior only; not a real DDL reference or upgrade proof.
const plan = { ...registry, step: { ...registry.step, afterHash: 'a'.repeat(64) } }
const at = '2026-09-09T00:00:00.000Z'
test('binds real reference evidence and rejects incomplete or altered proof', async () => {
  const root = new URL('../', import.meta.url)
  const reference = JSON.parse(await readFile(new URL('docs/architecture/instrument-schema-reference-20260909.json', root), 'utf8'))
  const verified = await loadInstrumentCollectionUpgrade(root, reference)
  assert.match(verified.step.afterHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(verified.steps, registry.steps)
  for (const patch of [{ migrationSha256: 'changed' }, { checks: [] }, { referenceDatabaseRemoved: false }]) {
    await assert.rejects(loadInstrumentCollectionUpgrade(root, { ...reference, ...patch }), /reference_invalid/)
  }
})
function fixture() {
  const history = plan.prior.steps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: at, completedAt: at }))
  let table = null
  const calls = []
  const store = { verifyPlan: async () => {}, history: async () => structuredClone(history),
    verifyPrior: async rows => assert.equal(rows.length, 175), verifyProtected: async () => {}, tableState: async () => table,
    begin: async step => { calls.push('begin'); history.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: at, completedAt: null }) },
    execute: async () => { calls.push('ddl'); table = { hash: plan.step.afterHash, rows: 0 } },
    complete: async () => { calls.push('complete'); Object.assign(history.at(-1), { status: 'completed', completedAt: at }) } }
  return { store, history, calls, setTable: value => { table = value } }
}
test('inspection does not write and replay does not repeat CREATE', async () => {
  const f = fixture()
  assert.equal((await run(f.store, plan)).status, 'pending'); assert.deepEqual(f.calls, [])
  assert.deepEqual(await run(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 1 })
  assert.deepEqual(await run(f.store, plan, { apply: true }), { status: 'completed', ddlCount: 0 })
})
for (const stage of ['begin', 'execute', 'complete']) test(`recovers lost ${stage} acknowledgement by inspection`, async () => {
  const f = fixture(), original = f.store[stage]
  f.store[stage] = async (...args) => { await original(...args); throw Error('lost acknowledgement') }
  await assert.rejects(run(f.store, plan, { apply: true }), /unknown/)
  f.store[stage] = original
  assert.equal((await run(f.store, plan, { apply: true })).status, 'completed')
  assert.equal(f.calls.filter(call => call === 'ddl').length, 1)
})
test('refuses source-only registration without a canonical DDL fingerprint', async () => {
  await assert.rejects(run(fixture().store, registry, { apply: true }), /reference_hash_missing/)
})
test('does not adopt unrecorded or drifted tables and incomplete prior history', async () => {
  for (const alter of [f => f.setTable({ hash: plan.step.afterHash, rows: 0 }),
    f => f.setTable({ hash: 'b'.repeat(64), rows: 0 }), f => f.history.pop()]) {
    const f = fixture(); alter(f)
    await assert.rejects(run(f.store, plan, { apply: true })); assert.deepEqual(f.calls, [])
  }
})
