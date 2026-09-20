import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'

export async function readInferenceBuildRehearsalEvidence(root, plan) {
  const cases = [['prepare', 0], ['start-loss', 0], ['ddl-loss', 1], ['complete-loss', 0],
    ['cycle-ddl-loss', 12], ['resume', 0], ['replay', 0]]
  const reports = [], sources = []
  for (const [name, ddlCount] of cases) {
    const path = `docs/architecture/inference-restored-${name}-20260910.json`
    const bytes = await readFile(new URL(path, root)), report = JSON.parse(bytes)
    assert.ok(report.passed && report.target === 'dev_vue_m1_source_20260910_02'
      && report.currentDevVueWrites === 0 && report.protectedTableCount === 257)
    assert.equal(report.planHash, hash({ steps: plan.steps, transitions: plan.transitions }))
    assert.equal(report.referenceHash, plan.referenceHash); assert.equal(report.inventoryHash, plan.inventoryHash)
    assert.equal(report.ddlAttempted, ddlCount); assert.equal(report.ddlAcknowledged, ddlCount)
    assert.equal(report.executedStepIds.length, ddlCount)
    if (reports.length) {
      const prior = reports.at(-1)
      assert.deepEqual(report.beforeStates, prior.afterStates)
      for (const key of ['tools', 'baselineProofSha256', 'receiptSha256', 'protectedSnapshotHash']) assert.deepEqual(report[key], reports[0][key])
    }
    sources.push({ path, sha256: sha256(bytes) }); reports.push(report)
  }
  for (const tool of reports[0].tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
  const executed = reports.flatMap(report => report.executedStepIds)
  assert.deepEqual(executed, plan.added.map(step => step.id))
  assert.equal(new Set(executed).size, 13)
  const originalHistory = reports[0].history, final = reports.at(-1)
  assert.equal(originalHistory.length, 191); assert.equal(final.history.length, 204)
  assert.ok(final.history.every(row => row.status === 'completed'))
  assert.deepEqual(final.history.filter(row => !executed.includes(row.id)), originalHistory)
  assert.equal(final.totalTableCount, 270); assert.equal(final.buildTables.length, 12)
  for (const table of final.buildTables) {
    assert.equal(Number(table.rows), 0); assert.equal(table.hash, plan.finalTableHashes[table.name])
  }
  assert.ok(final.afterStates.length === 13 && final.afterStates.every(state => state === 'completed'))
  return { passed: true, sources, target: final.target, serverUuid: final.serverUuid,
    receiptSha256: final.receiptSha256, baselineProofSha256: final.baselineProofSha256,
    planHash: final.planHash, protectedSnapshotHash: final.protectedSnapshotHash, protectedTableCount: 257,
    completedSteps: 204, tableCount: 270, buildTableCount: 12, totalDdl: executed.length,
    replayDdl: final.ddlAttempted, originalHistoryUnchanged: true, currentDevVueWrites: 0 }
}
