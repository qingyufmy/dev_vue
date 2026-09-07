import { verifyLearningMigrationControl } from './v4-learning-control-audit.mjs'
import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { validateSpec } from './v4-learning-course-backfill-contract.mjs'
import { createLearningCourseBackfill } from './v4-learning-course-backfill.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './v4-learning-course-backfill-runner.mjs'
import { readLearningCourseAudit } from './mysql-learning-course-audit-reader.mjs'
import { auditLearningCourseImport } from './v4-learning-course-audit.mjs'

// This application entry owns no connection configuration or deployment. Recovery
// observes existing outcomes only; it never registers a run or replays a writer.
export async function migrateLearningCourse(repository, spec, sources, options, { mode = 'verify', batchSize = 100 } = {}) {
  check(['apply', 'recover', 'verify'].includes(mode), 'learning_course_migration_mode')
  spec = structuredClone(spec); options = structuredClone(options)
  const pipeline = createLearningCourseBackfill(sources, options, { batchSize })
  validateSpec(spec)
  check(spec.runId === pipeline.runId && spec.bindings.transformHash === pipeline.transformHash
    && spec.bindings.snapshotHash === pipeline.sourceHash, 'learning_course_migration_binding')
  if (mode === 'apply') await prepareBackfillRun(repository, spec)
  const results = []
  for (const batch of pipeline.batches) {
    const result = mode === 'apply'
      ? await executeBackfillBatch(repository, spec, batch, pipeline.writer)
      : await recoverBackfillBatch(repository, spec, batch)
    results.push(result)
    if (result.status !== 'committed') return { version: 'learning-course-migration/v1', mode, runId: spec.runId,
      status: result.status, batches: results, audit: null, consumersSwitched: false }
  }
  const audit = await repository.transaction(async tx => {
    const identity = await tx.targetIdentity()
    check(identity.serverUuid === spec.bindings.targetServerUuid && identity.database === spec.bindings.targetDatabase
      && identity.storageMode === spec.bindings.storageMode && identity.schemaHash === spec.bindings.schemaHash, 'learning_course_migration_target')
    const run = await tx.findRun(spec.runId)
    check(run && run.bindingsHash === hash(spec.bindings) && canonical(run.bindings) === canonical(spec.bindings), 'backfill_run_bindings_mismatch')
    const control = await verifyLearningMigrationControl(tx.connection, spec, pipeline)
    const read = await readLearningCourseAudit(tx.connection, spec.runId)
    const result = auditLearningCourseImport(read.sources, read.actual, read.archives, options)
    return { ...result, control }
  })
  check(audit.importMatchesReviewedInputs, 'learning_course_migration_audit_failed')
  return { version: 'learning-course-migration/v1', mode, runId: spec.runId, status: 'verified', batches: results, audit, consumersSwitched: false }
}
