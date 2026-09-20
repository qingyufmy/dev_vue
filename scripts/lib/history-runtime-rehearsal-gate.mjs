import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { historyRuntimePlanHash } from './history-runtime-upgrade.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

// Evidence must prove both interrupted states and the final zero-DDL replay.
export function verifyHistoryRuntimeRehearsal(plan, reference, baseline, reports) {
  assert.equal(baseline.kind, 'history-runtime-baseline/v1')
  assert.deepEqual(baseline.identity, { database: 'dev_vue_m1_source_20260909_01', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104' })
  assert.equal(baseline.referenceHash, hash(reference))
  assert.equal(baseline.planHash, historyRuntimePlanHash(plan))
  const prior = validateColumnHistory(baseline.priorHistory, plan.prior.steps)
  assert.equal(prior.size, 176)
  assert.ok([...prior.values()].every(row => row.status === 'completed'))
  assert.equal(reports.length, 5)
  const modes = ['--prepare', '--inject-create-loss', '--inject-alter-loss', '--resume', '--resume']
  const counts = [176, 177, 184, 188, 188], ddls = [0, 1, 7, 4, 0]
  for (const [index, report] of reports.entries()) {
    assert.equal(report.passed, true)
    assert.equal(report.kind, 'history-runtime-upgrade-rehearsal/v1')
    assert.equal(report.mode, modes[index])
    assert.deepEqual(report.identity, baseline.identity)
    assert.equal(report.baselineHash, hash(baseline))
    assert.deepEqual(report.tools, baseline.tools)
    assert.equal(report.currentDatabaseWrites, 0)
    assert.equal(report.protectedSnapshotHash, hash(baseline.protectedSnapshot))
    assert.equal(report.ddlAttempted, ddls[index]); assert.equal(report.ddlAcknowledged, ddls[index])
    assert.equal(report.result.status, ['pending', 'reconcile', 'reconcile', 'completed', 'completed'][index])
    assert.equal(report.result.ddlCount, index === 3 ? 4 : 0)
    assert.equal(report.history.length, counts[index])
    const entries = validateColumnHistory(report.history, plan.steps)
    const priorIds = new Set(plan.prior.steps.map(step => step.id))
    assert.deepEqual(report.history.filter(row => priorIds.has(row.id)), baseline.priorHistory)
    for (const step of plan.added) {
      const entry = entries.get(step.id)
      if (entry) assert.equal(entry.status, index === 1 && step === plan.added[0]
        || index === 2 && step === plan.added[7] ? 'started' : 'completed')
    }
    const expected = Object.fromEntries(Object.keys(plan.finalTableHashes).map(table => [table, null]))
    for (const step of plan.added) if (entries.has(step.id)) expected[step.table] = step.afterHash
    assert.deepEqual(Object.keys(report.tableStates).sort(), Object.keys(expected).sort())
    for (const [table, value] of Object.entries(expected)) {
      const actual = report.tableStates[table]
      if (value === null) assert.equal(actual, null)
      else {
        assert.equal(actual.hash, value); assert.equal(actual.rows, 0)
        assert.equal(tableDefinitionHash(actual.ddl), value)
      }
    }
  }
  assert.deepEqual(reports[3].history, reports[4].history)
  return { status: 'verified', evidenceHash: hash({ baseline, reports }) }
}
