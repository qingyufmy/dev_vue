import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { decodeLearningManifest } from './v4-learning-manifest.mjs'
import { executeLearningManifests } from './v4-learning-manifest-executor.mjs'
import { readLearningCourseTargetIdentity } from './mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from './mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from './mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './mysql-learning-progress-audit-reader.mjs'
import { withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'

export async function runLearningCommand({ pool, database, expectedServerUuid, courseManifest, progressManifest, evidenceCatalog, mode }) {
  check(['check', 'apply', 'recover', 'verify'].includes(mode), 'learning_entry_mode')
  check(database === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(database), 'learning_entry_database')
  // Current dev_vue is not promoted for business backfill until the new learning
  // path has passed a real restored-copy rehearsal. Keep read-only commands usable.
  check(mode !== 'apply' || database !== 'dev_vue', 'learning_entry_dev_vue_apply_requires_rehearsal')
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
      // The check command must enforce the same cross-domain identity and mapping
      // requirements as apply, while never entering a migration transaction.
      for (const key of ['logicalSourceId', 'sourceDatabase', 'targetDatabase', 'targetServerUuid', 'mirrorDatabase']) {
        check(parent.spec.bindings[key] === child.spec.bindings[key], 'learning_core_scope_mismatch')
      }
      check(parent.spec.runId !== child.spec.runId, 'learning_core_run_collision')
      check(parent.options.run.sourceSnapshotId === child.options.run.sourceSnapshotId, 'learning_core_snapshot_mismatch')
      const mappings = courses.sources.map(source => ({ episodeId: source.episode_id, lessonId: source.id,
        lessonSourceHash: parent.options.basis.resolutions.find(row => row.sourceId === source.id).sourceHash }))
        .sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1)
      const actualMappings = [...child.options.lessonMappings].sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1)
      check(canonical(mappings) === canonical(actualMappings), 'learning_core_lesson_mapping_mismatch')
      if (mode === 'check') return { status: 'checked', sourceRows: { courses: sourceRows.courses.length, progress: sourceRows.progress.length }, databaseWrites: 0 }
      return executeLearningManifests({ pool, courseManifest, progressManifest, sources: sourceRows, userIds: progress.userIds, evidenceCatalog, mode })
    })
  } finally { connection?.release() }
}
