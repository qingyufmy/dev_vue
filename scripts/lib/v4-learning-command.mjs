import { assertLearningPromotion } from './learning-dev-vue-promotion.mjs'
import { prepareLearningCore } from './v4-learning-core-migration.mjs'
import { requireBackfill as check } from './v4-backfill-contract.mjs'
import { decodeLearningManifest } from './v4-learning-manifest.mjs'
import { executeLearningManifests } from './v4-learning-manifest-executor.mjs'
import { readLearningCourseTargetIdentity } from './mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from './mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from './mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './mysql-learning-progress-audit-reader.mjs'
import { withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'

export async function runLearningCommand({ pool, database, expectedServerUuid, courseManifest, progressManifest, evidenceCatalog, mode, promotionPath }) {
  check(['check', 'apply', 'recover', 'verify'].includes(mode), 'learning_entry_mode')
  check(database === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(database), 'learning_entry_database')
  if (mode === 'apply' && database === 'dev_vue') {
    await assertLearningPromotion(promotionPath, { courses: courseManifest, progress: progressManifest }, expectedServerUuid)
  }
  let connection
  try {
    connection = await pool.getConnection()
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    return await withInplaceUpgradeLock(connection, database, async () => {
      const identities = [await readLearningCourseTargetIdentity(connection), await readLearningProgressTargetIdentity(connection)]
      for (const [index, manifest] of [courseManifest, progressManifest].entries()) {
        const actual = identities[index], binding = manifest.spec.bindings
        check(actual.serverUuid === expectedServerUuid && actual.serverUuid === binding.targetServerUuid && actual.database === database
          && actual.database === binding.targetDatabase && actual.storageMode === binding.storageMode && actual.schemaHash === binding.schemaHash, 'learning_entry_identity')
      }
      await connection.query('START TRANSACTION READ ONLY')
      let courses, progress
      try {
        courses = await readLearningCourseAudit(connection, courseManifest.spec.runId)
        progress = await readLearningProgressAudit(connection, progressManifest.spec.runId)
      } finally { await connection.rollback() }
      const sourceRows = { courses: courses.sources, progress: progress.sources }
      const parent = decodeLearningManifest(courseManifest, { sources: sourceRows.courses, evidenceCatalog })
      const child = decodeLearningManifest(progressManifest, { sources: sourceRows.progress, evidenceCatalog, userIds: progress.userIds })
      check(parent.kind === 'courses' && child.kind === 'progress', 'learning_entry_domains')
      prepareLearningCore({
        courses: { repository: null, spec: parent.spec, sources: parent.sources, options: parent.options },
        progress: { repository: null, spec: child.spec, sources: child.sources, options: child.options },
      }, { courseBatchSize: parent.batchSize, progressBatchSize: child.batchSize })
      if (mode === 'check') return { status: 'checked', sourceRows: { courses: sourceRows.courses.length, progress: sourceRows.progress.length }, databaseWrites: 0 }
      return executeLearningManifests({ pool, courseManifest, progressManifest, sources: sourceRows, userIds: progress.userIds, evidenceCatalog, mode })
    })
  } finally { connection?.release() }
}
