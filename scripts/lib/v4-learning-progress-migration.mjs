import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { validateSpec } from './v4-learning-progress-backfill-contract.mjs'
import { createLearningProgressBackfill } from './v4-learning-progress-backfill.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './v4-learning-progress-backfill-runner.mjs'
import { readLearningProgressAudit } from './mysql-learning-progress-audit-reader.mjs'
import { auditLearningProgressImport } from './v4-learning-progress-audit.mjs'

// This application entry owns no connection configuration or deployment. Recovery
// observes existing outcomes only; it never registers a run or replays a writer.
export async function migrateLearningProgress(repository, spec, sources, options, { mode = 'verify', batchSize = 100 } = {}) {
  check(['apply', 'recover', 'verify'].includes(mode), 'learning_progress_migration_mode')
  spec = structuredClone(spec); options = structuredClone(options)
  const pipeline = createLearningProgressBackfill(sources, options, { batchSize })
  validateSpec(spec)
  check(spec.runId === pipeline.runId && spec.bindings.transformHash === pipeline.transformHash
    && spec.bindings.snapshotHash === pipeline.sourceHash, 'learning_progress_migration_binding')
  if (mode === 'apply') await prepareBackfillRun(repository, spec)
  const results = []
  for (const batch of pipeline.batches) {
    const result = mode === 'apply'
      ? await executeBackfillBatch(repository, spec, batch, pipeline.writer)
      : await recoverBackfillBatch(repository, spec, batch)
    results.push(result)
    if (result.status !== 'committed') return { version: 'learning-progress-migration/v1', mode, runId: spec.runId,
      status: result.status, batches: results, audit: null, consumersSwitched: false }
  }
  const audit = await repository.transaction(async tx => {
    const identity = await tx.targetIdentity()
    check(identity.serverUuid === spec.bindings.targetServerUuid && identity.database === spec.bindings.targetDatabase
      && identity.storageMode === spec.bindings.storageMode && identity.schemaHash === spec.bindings.schemaHash, 'learning_progress_migration_target')
    const run = await tx.findRun(spec.runId)
    check(run && run.bindingsHash === hash(spec.bindings) && canonical(run.bindings) === canonical(spec.bindings), 'backfill_run_bindings_mismatch')
    const read = await readLearningProgressAudit(tx.connection, spec.runId)
    return auditLearningProgressImport(read.sources, read.actual, read.archives, { ...options, actualLessons: read.actualLessons, userIds: read.userIds })
  })
  check(audit.importMatchesReviewedInputs, 'learning_progress_migration_audit_failed')
  return { version: 'learning-progress-migration/v1', mode, runId: spec.runId, status: 'verified', batches: results, audit, consumersSwitched: false }
}
