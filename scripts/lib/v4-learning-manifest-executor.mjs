import { requireBackfill as check } from './v4-backfill-contract.mjs'
import { decodeLearningManifest } from './v4-learning-manifest.mjs'
import { createLearningCourseBackfill } from './v4-learning-course-backfill.mjs'
import { createLearningProgressBackfill } from './v4-learning-progress-backfill.mjs'
import { MysqlLearningCourseBackfillRepository } from './mysql-learning-course-backfill.mjs'
import { MysqlLearningProgressBackfillRepository } from './mysql-learning-progress-backfill.mjs'
import { migrateLearningCore } from './v4-learning-core-migration.mjs'

// Configuration, fresh source/user reads and reviewed evidence remain supplied by
// the explicit command boundary. This adapter never starts a service or guesses
// historical time offsets. Both manifests are validated before obtaining a pool connection.
export async function executeLearningManifests({ pool, courseManifest, progressManifest, sources, userIds, evidenceCatalog, mode = 'verify' }) {
  const courses = decodeLearningManifest(courseManifest, { sources: sources.courses, evidenceCatalog })
  const progress = decodeLearningManifest(progressManifest, { sources: sources.progress, evidenceCatalog, userIds })
  check(courses.kind === 'courses' && progress.kind === 'progress', 'learning_manifest_domain_mismatch')
  const parent = createLearningCourseBackfill(courses.sources, courses.options, { batchSize: courses.batchSize })
  const child = createLearningProgressBackfill(progress.sources, progress.options, { batchSize: progress.batchSize })
  return migrateLearningCore({
    courses: { repository: new MysqlLearningCourseBackfillRepository(pool, parent.sourceEvidence), spec: courses.spec, sources: courses.sources, options: courses.options },
    progress: { repository: new MysqlLearningProgressBackfillRepository(pool, child.sourceEvidence), spec: progress.spec, sources: progress.sources, options: progress.options },
  }, { mode, courseBatchSize: courses.batchSize, progressBatchSize: progress.batchSize })
}
