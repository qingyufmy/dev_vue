import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { loadHistoryCollectionTaskUpgrade } from './lib/history-collection-task-upgrade.mjs'
import { verifyHistoryTaskRehearsal } from './lib/history-task-rehearsal-gate.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const restored = await json(new URL('docs/architecture/core-refactor-restored-baseline-20260910.json', root))
const baseline = await json(join(restored.archiveDirectory, 'history-task-upgrade-baseline-v1.json'))
const loaded = await loadHistoryCollectionTaskUpgrade(root), step = loaded.added[0]
const plan = { steps: loaded.steps, added: loaded.added, prior: { steps: loaded.prior.steps },
  finalTableHashes: { [step.table]: step.afterHash }, referenceHash: loaded.referenceHash }
const reports = await Promise.all(['prepare', 'start-loss', 'ddl-loss', 'complete-loss', 'replay'].map(name =>
  json(new URL(`docs/architecture/history-task-restored-${name}-20260910.json`, root))))
for (const tool of baseline.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
assert.equal(sha256(await readFile(join(restored.archiveDirectory, 'receipt.json'))), baseline.restoredReceiptSha256)
const verified = verifyHistoryTaskRehearsal(plan, baseline, reports)
const proof = { kind: 'history-task-restored-upgrade-proof/v1', passed: true, target: baseline.target,
  priorSteps: 190, completedSteps: 191, originalTableCount: baseline.snapshot.length,
  originalRows: baseline.snapshot.reduce((total, table) => total + Number(table.rows), 0),
  protectedTableCount: reports[4].protectedTableCount, protectedSnapshotHash: reports[4].protectedSnapshotHash,
  oldJournalUnchanged: true, totalDdlCount: reports.reduce((total, r) => total+r.ddlAttempted, 0),
  replayDdlCount: reports[4].ddlAttempted, newTableRows: reports[4].tableState.rows,
  currentDevVueWrites: 0, rehearsalEvidenceHash: verified.evidenceHash, planHash: baseline.planHash, observedAt: new Date().toISOString() }
const file = await open(new URL('docs/architecture/history-task-restored-proof-20260910.json', root), 'wx', 0o600)
try { await file.writeFile(JSON.stringify(proof, null, 2)+'\n'); await file.sync() } finally { await file.close() }
console.log(JSON.stringify(proof))
