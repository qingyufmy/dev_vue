import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'

// Validate the durable states, not just the summary's passed flag.
export function verifyHistoryTaskRehearsal(plan, baseline, reports) {
  assert.equal(baseline.kind, 'history-task-upgrade-baseline/v1')
  assert.equal(baseline.target, 'dev_vue_m1_source_20260910_01')
  assert.equal(baseline.planHash, hash(plan))
  assert.equal(plan.prior.steps.length, 190)
  assert.equal(plan.added.length, 1)
  const step = plan.added[0]
  assert.equal(plan.steps.length, 191)
  assert.deepEqual(plan.steps, [...plan.prior.steps, step])
  const prior = validateColumnHistory(baseline.history, plan.prior.steps)
  assert.equal(prior.size, 190)
  assert.ok([...prior.values()].every(row => row.status === 'completed'))
  const protectedTables = baseline.snapshot.filter(t => ![step.table, 'database_upgrade_steps_v4'].includes(t.name))
  assert.equal(baseline.snapshot.length, 257)
  assert.equal(protectedTables.length, 256)
  assert.equal(new Set(baseline.snapshot.map(t => t.name)).size, 257)
  const modes = ['--prepare', '--inject-start-loss', '--inject-ddl-loss', '--inject-complete-loss', '--replay']
  const before = ['pending', 'pending', 'pending', 'reconcile', 'completed']
  const after = ['pending', 'pending', 'reconcile', 'completed', 'completed']
  const errors = [null, 'history_runtime_begin_unknown', 'history_runtime_ddl_unknown', 'history_runtime_complete_unknown', null]
  assert.equal(reports.length, modes.length)
  for (const [i, report] of reports.entries()) {
    assert.equal(report.kind, 'history-task-restored-upgrade/v1')
    assert.equal(report.passed, true)
    assert.equal(report.mode, modes[i])
    assert.equal(report.target, baseline.target)
    assert.equal(report.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
    assert.equal(report.planHash, baseline.planHash)
    assert.deepEqual(report.tools, baseline.tools)
    assert.equal(report.restoredReceiptSha256, baseline.restoredReceiptSha256)
    assert.equal(report.currentDevVueWrites, 0)
    assert.equal(report.protectedSnapshotHash, hash(protectedTables))
    assert.equal(report.protectedTableCount, protectedTables.length)
    assert.equal(report.beforeState, before[i])
    assert.equal(report.afterState, after[i])
    assert.equal(report.ddlAttempted, i === 2 ? 1 : 0)
    assert.equal(report.ddlAcknowledged, i === 2 ? 1 : 0)
    assert.equal(report.injectedError ?? null, errors[i])
    assert.equal(report.history.length, i === 0 ? 190 : 191)
    const entries = validateColumnHistory(report.history, plan.steps)
    assert.deepEqual(report.history.filter(row => row.id !== step.id), baseline.history)
    if (i > 0) assert.equal(entries.get(step.id).status, i < 3 ? 'started' : 'completed')
    assert.deepEqual(report.tableState, i < 2 ? null : { hash: step.afterHash, rows: 0 })
    if (i === 0 || i === 4) assert.deepEqual(report.result, { status: after[i], ddlCount: 0 })
  }
  assert.deepEqual(reports[1].history, reports[2].history)
  assert.equal(reports[2].history.at(-1).startedAt, reports[3].history.at(-1).startedAt)
  assert.deepEqual(reports[3].history, reports[4].history)
  return { status: 'verified', evidenceHash: hash({ baseline, reports }) }
}
