import { canonical, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createLearningCourseBackfill } from './v4-learning-course-backfill.mjs'
import { createLearningProgressBackfill } from './v4-learning-progress-backfill.mjs'
import { validateSpec as validateCourses } from './v4-learning-course-backfill-contract.mjs'
import { validateSpec as validateProgress } from './v4-learning-progress-backfill-contract.mjs'
import { migrateLearningCourse } from './v4-learning-course-migration.mjs'
import { migrateLearningProgress } from './v4-learning-progress-migration.mjs'

export function prepareLearningCore(input, { courseBatchSize = 100, progressBatchSize = 100 } = {}) {
  exactKeys(input, ['courses', 'progress'])
  const freeze = part => {
    exactKeys(part, ['repository', 'spec', 'sources', 'options'])
    return { repository: part.repository, ...structuredClone({ spec: part.spec, sources: part.sources, options: part.options }) }
  }
  const courses = freeze(input.courses), progress = freeze(input.progress)
  // Validate both domains before the first transaction, including the full child
  // conversion. A valid parent wave must not conceal an invalid child manifest.
  validateCourses(courses.spec); validateProgress(progress.spec)
  const parents = createLearningCourseBackfill(courses.sources, courses.options, { batchSize: courseBatchSize })
  const children = createLearningProgressBackfill(progress.sources, progress.options, { batchSize: progressBatchSize })
  for (const [part, pipeline] of [[courses, parents], [progress, children]]) {
    check(part.spec.runId === pipeline.runId && part.spec.bindings.snapshotHash === pipeline.sourceHash
      && part.spec.bindings.transformHash === pipeline.transformHash, 'learning_core_migration_binding')
  }
  check(courses.spec.runId !== progress.spec.runId, 'learning_core_run_collision')
  for (const key of ['logicalSourceId', 'sourceDatabase', 'targetDatabase', 'targetServerUuid', 'mirrorDatabase']) {
    check(courses.spec.bindings[key] === progress.spec.bindings[key], 'learning_core_scope_mismatch')
  }
  check(courses.options.run.sourceSnapshotId === progress.options.run.sourceSnapshotId, 'learning_core_snapshot_mismatch')
  const mappings = [...progress.options.lessonMappings].sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1)
  check(canonical(parents.lessonMappings) === canonical(mappings), 'learning_core_lesson_mapping_mismatch')
  return { courses, progress }
}

export async function migrateLearningCore(input, { mode = 'verify', courseBatchSize = 100, progressBatchSize = 100 } = {}) {
  check(['apply', 'recover', 'verify'].includes(mode), 'learning_core_migration_mode')
  const { courses, progress } = prepareLearningCore(input, { courseBatchSize, progressBatchSize })
  const courseResult = await migrateLearningCourse(courses.repository, courses.spec, courses.sources, courses.options, { mode, batchSize: courseBatchSize })
  if (courseResult.status !== 'verified') return { version: 'learning-core-migration/v1', mode, status: courseResult.status,
    courses: courseResult, progress: null, consumersSwitched: false }
  const progressResult = await migrateLearningProgress(progress.repository, progress.spec, progress.sources, progress.options, { mode, batchSize: progressBatchSize })
  return { version: 'learning-core-migration/v1', mode, status: progressResult.status, courses: courseResult, progress: progressResult, consumersSwitched: false }
}
