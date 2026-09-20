import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadHistoryCollectionTaskUpgrade } from './lib/history-collection-task-upgrade.mjs'
const root = new URL('../', import.meta.url), json = async p => JSON.parse(await readFile(p, 'utf8'))
const restored = await json(new URL('docs/architecture/core-refactor-restored-baseline-20260910.json', root))
const baseline = await json(join(restored.archiveDirectory, 'history-task-current-baseline-v1.json'))
const loaded = await loadHistoryCollectionTaskUpgrade(root), step = loaded.added[0]
const reports = await Promise.all(['prepare', 'apply', 'replay'].map(name => json(new URL(`docs/architecture/history-task-current-${name}-20260910.json`, root))))
assert.equal(baseline.history.length, 190); assert.equal(baseline.snapshot.length, 257)
const protectedTables = baseline.snapshot.filter(t => t.name !== 'database_upgrade_steps_v4')
for (const tool of baseline.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
for (const [i, report] of reports.entries()) {
  assert.equal(report.kind, 'history-task-current-upgrade/v1'); assert.equal(report.passed, true)
  assert.equal(report.target, 'dev_vue'); assert.equal(report.serverUuid, restored.serverUuid)
  assert.equal(report.mode, ['--prepare', '--apply', '--replay'][i])
  assert.equal(report.businessWritesPerformed, false)
  assert.equal(report.planHash, baseline.planHash); assert.deepEqual(report.tools, baseline.tools)
  assert.equal(report.rehearsalEvidenceHash, baseline.rehearsalEvidenceHash)
  assert.equal(report.protectedSnapshotHash, hash(protectedTables)); assert.equal(report.protectedTableCount, 256)
  assert.deepEqual(report.history.filter(r => r.id !== step.id), baseline.history)
  assert.equal(report.history.length, i === 0 ? 190 : 191)
  assert.equal(report.ddlAttempted, i === 1 ? 1 : 0); assert.equal(report.ddlAcknowledged, i === 1 ? 1 : 0)
  assert.equal(report.beforeState, i === 2 ? 'completed' : 'pending')
  assert.equal(report.afterState, i === 0 ? 'pending' : 'completed')
  assert.deepEqual(report.tableState, i === 0 ? null : { hash: step.afterHash, rows: 0 })
  if (i > 0) {
    assert.equal(report.taskSchemaReady, true)
    assert.ok(report.history.every(r => r.status === 'completed'))
    assert.equal(report.history.find(r => r.id === step.id).checksum, step.checksum)
  }
}
assert.deepEqual(reports[1].history, reports[2].history)
const proof = { kind: 'history-task-current-upgrade-proof/v1', passed: true, target: 'dev_vue', serverUuid: restored.serverUuid,
  priorSteps: 190, completedSteps: 191, originalTables: 257, finalTables: 258,
  originalRows: baseline.snapshot.reduce((total,t) => total+Number(t.rows),0), protectedTableCount: 256,
  protectedSnapshotHash: hash(protectedTables), oldJournalUnchanged: true, ddlCount: 1, replayDdlCount: 0,
  newTableRows: 0, businessWritesPerformed: false, taskSchemaReady: true, evidenceHash: hash({baseline,reports}),
  planHash: baseline.planHash, observedAt: new Date().toISOString() }
const file = await open(new URL('docs/architecture/history-task-current-proof-20260910.json', root), 'wx', 0o600)
try { await file.writeFile(JSON.stringify(proof,null,2)+'\n'); await file.sync() } finally { await file.close() }
console.log(JSON.stringify(proof))
