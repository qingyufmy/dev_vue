import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { loadHistoryRuntimeUpgrade, historyRuntimePlanHash } from './history-runtime-upgrade.mjs'
import { verifyHistoryRuntimeRehearsal } from './history-runtime-rehearsal-gate.mjs'

const root = new URL('../../', import.meta.url)
const json = async name => JSON.parse(await readFile(new URL(`docs/architecture/${name}-20260909.json`, root)))
const reference = await json('history-runtime-reference'), plan = await loadHistoryRuntimeUpgrade(root, reference)
const evidence = await Promise.all(['prepare', 'create-loss', 'alter-loss', 'resume', 'replay'].map(mode => json(`history-runtime-upgrade-${mode}`)))
// Keep unit tests portable: substitute a synthetic protected baseline, retain real DDL/journal evidence.
function fixture() {
  const reports = structuredClone(evidence)
  const baseline = { kind: 'history-runtime-baseline/v1', identity: reports[0].identity, referenceHash: hash(reference),
    planHash: historyRuntimePlanHash(plan), priorHistory: reports[0].history, tools: reports[0].tools,
    protectedSnapshot: [{ name: 'protected_fixture', fingerprint: 'unchanged' }] }
  for (const report of reports) {
    report.baselineHash = hash(baseline); report.protectedSnapshotHash = hash(baseline.protectedSnapshot)
  }
  return { baseline, reports }
}
test('accepts complete interrupted and zero-DDL replay evidence', () => {
  const { baseline, reports } = fixture()
  assert.equal(verifyHistoryRuntimeRehearsal(plan, reference, baseline, reports).status, 'verified')
})
for (const [name, mutate] of [
  ['missing report', reports => reports.pop()],
  ['wrong target', reports => { reports[1].identity.database = 'dev_vue' }],
  ['changed tool', reports => { reports[2].tools[0].sha256 = 'wrong' }],
  ['protected data changed', reports => { reports[3].protectedSnapshotHash = 'wrong' }],
  ['fake completion', reports => { reports[2].result.status = 'completed' }],
  ['duplicate DDL on replay', reports => { reports[4].ddlAttempted = 1 }],
  ['changed checkpoint', reports => { reports[4].history.at(-1).checksum = 'wrong' }],
  ['changed final DDL', reports => { reports[4].tableStates.account_trade_records_v4.ddl += ' drift' }],
  ['unexpected business rows', reports => { reports[3].tableStates.account_trade_records_v4.rows = 1 }],
  ['missing target table', reports => { delete reports[4].tableStates.account_trade_records_v4 }],
]) {
  test(`rejects ${name}`, () => {
    const { baseline, reports } = fixture(); mutate(reports)
    assert.throws(() => verifyHistoryRuntimeRehearsal(plan, reference, baseline, reports))
  })
}
