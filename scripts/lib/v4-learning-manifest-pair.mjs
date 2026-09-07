import { buildLearningManifest } from './v4-learning-manifest.mjs'
import { prepareLearningCore } from './v4-learning-core-migration.mjs'

export function buildLearningManifestPair({ sources, options, targetIdentities, logicalSourceId, mirrorDatabase, admission,
  courseBatchSize = 100, progressBatchSize = 100 }) {
  const courses = buildLearningManifest({ kind: 'courses', sources: sources.courses, options: options.courses, targetIdentity: targetIdentities.courses,
    logicalSourceId, mirrorDatabase, admission, batchSize: courseBatchSize })
  const progress = buildLearningManifest({ kind: 'progress', sources: sources.progress, options: options.progress, targetIdentity: targetIdentities.progress,
    logicalSourceId, mirrorDatabase, admission, batchSize: progressBatchSize })
  prepareLearningCore({
    courses: { repository: null, spec: courses.spec, sources: sources.courses, options: options.courses },
    progress: { repository: null, spec: progress.spec, sources: sources.progress, options: options.progress },
  }, { courseBatchSize, progressBatchSize })
  return { courses, progress }
}
