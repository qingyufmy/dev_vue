import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { loadHistoryCollectionTaskUpgrade } from './history-collection-task-upgrade.mjs'
import { verifyHistoryTaskRehearsal } from './history-task-rehearsal-gate.mjs'

const root = new URL('../../', import.meta.url)
const loaded = await loadHistoryCollectionTaskUpgrade(root), step = loaded.added[0]
const plan = { steps: loaded.steps, added: loaded.added, prior: { steps: loaded.prior.steps },
  finalTableHashes: { [step.table]: step.afterHash }, referenceHash: loaded.referenceHash }
const evidence = await Promise.all(['prepare', 'start-loss', 'ddl-loss', 'complete-loss', 'replay'].map(async name =>
  JSON.parse(await readFile(new URL(`docs/architecture/history-task-restored-${name}-20260910.json`, root)))))

function fixture() {
  const reports = structuredClone(evidence), first = reports[0]
  // Private backup files are not required by the portable tests.
  const snapshot = [...Array.from({ length: 256 }, (_, i) => ({ name: `fixture_${i}`, rows: 0 })),
    { name: 'database_upgrade_steps_v4', rows: 190 }]
  const baseline = { kind: 'history-task-upgrade-baseline/v1', target: first.target,
    planHash: hash(plan), tools: first.tools, restoredReceiptSha256: first.restoredReceiptSha256,
    history: structuredClone(first.history), snapshot }
  for (const report of reports) report.protectedSnapshotHash = hash(snapshot.slice(0, 256))
  return { baseline, reports }
}

test('accepts all three durable acknowledgement losses and zero-DDL replay', () => {
  const { baseline, reports } = fixture()
  assert.equal(verifyHistoryTaskRehearsal(plan, baseline, reports).status, 'verified')
})
for (const [name, mutate] of [
  ['missing evidence', r => r.pop()],
  ['wrong target', r => { r[2].target = 'dev_vue' }],
  ['wrong server', r => { r[1].serverUuid = 'other' }],
  ['changed tool', r => { r[2].tools[0].sha256 = 'changed' }],
  ['changed backup', r => { r[2].restoredReceiptSha256 = 'changed' }],
  ['protected rows changed', r => { r[3].protectedSnapshotHash = 'changed' }],
  ['old checkpoint changed', r => { r[1].history[0].startedAt = '2000-01-01T00:00:00Z' }],
  ['false completion', r => { r[2].afterState = 'completed' }],
  ['missing injected failure', r => { delete r[2].injectedError }],
  ['wrong table DDL', r => { r[3].tableState.hash = 'changed' }],
  ['unexpected new rows', r => { r[3].tableState.rows = 1 }],
  ['replay DDL', r => { r[4].ddlAttempted = 1 }],
  ['checkpoint rewrite on replay', r => { r[4].history.at(-1).completedAt = '2099-01-01T00:00:00Z' }],
  ['current database writes', r => { r[3].currentDevVueWrites = 1 }],
]) test(`rejects ${name}`, () => {
  const { baseline, reports } = fixture()
  mutate(reports)
  assert.throws(() => verifyHistoryTaskRehearsal(plan, baseline, reports))
})
