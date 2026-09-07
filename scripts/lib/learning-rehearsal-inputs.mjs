import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { buildLearningManifestPair } from './v4-learning-manifest-pair.mjs'

// Fixture-only preparation for the existing restored copy. The artificial offset
// tests conversion mechanics; it is not evidence of the historical source zone.
export function prepareLearningRehearsalInputs({ sources, targetIdentities, userIds, registeredAtUtc }) {
  const database = 'dev_vue_m1_source_20260907_02'
  check(Object.values(targetIdentities).length === 2 && ['courses', 'progress'].every(kind => targetIdentities[kind]?.database === database
    && targetIdentities[kind].serverUuid === 'ac423207-6ef3-11f1-b302-000c29fda104'), 'learning_rehearsal_target')
  const sorted = Object.fromEntries(['courses', 'progress'].map(kind => [kind, structuredClone(sources[kind]).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)]))
  const sourceSnapshotId = 'synthetic-learning-rehearsal-01'
  const proof = { evidenceId: sourceSnapshotId, evidenceSha256: hash({ kind: 'synthetic-learning-time-assumption/v1', database,
    offsetMinutes: 480, sourceHashes: { courses: hash(sorted.courses), progress: hash(sorted.progress) }, historicalEvidence: false }) }
  const evidenceCatalog = new Map([[proof.evidenceId, proof.evidenceSha256]])
  const time = raw => ({ raw, kind: raw === null ? 'source_null' : 'wall_clock', offsetMinutes: raw === null ? null : 480, ...proof })
  const lessonMappings = sorted.courses.map(source => ({ episodeId: source.episode_id, lessonId: source.id, lessonSourceHash: hash(source) }))
    .sort((a, b) => BigInt(a.episodeId) < BigInt(b.episodeId) ? -1 : 1)
  const courses = { run: { id: 'ffffffff-ffff-4fff-8fff-ffffffffff41', sourceSnapshotId, registeredAtUtc }, evidenceCatalog,
    basis: { version: 'learning-course-import/v1', sourceHash: hash(sorted.courses), sourceSnapshotId,
      resolutions: sorted.courses.map(source => ({ sourceId: source.id, sourceHash: hash(source), createdAt: time(source.created_at), updatedAt: time(source.updated_at),
        valueEvidence: { ...proof, requirements: ['access_review', 'duration_seconds', 'media_reference_review', 'projection_archive_review'] } })) } }
  const progress = { run: { id: 'ffffffff-ffff-4fff-8fff-ffffffffff42', sourceSnapshotId, registeredAtUtc }, evidenceCatalog, userIds: new Set(userIds), lessonMappings,
    basis: { version: 'learning-progress-import/v1', sourceHash: hash(sorted.progress), sourceSnapshotId, lessonMappingHash: hash(lessonMappings),
      resolutions: sorted.progress.map(source => ({ sourceId: source.id, sourceHash: hash(source), updatedAt: time(source.updated_at) })) } }
  const manifests = buildLearningManifestPair({ sources: sorted, options: { courses, progress }, targetIdentities, logicalSourceId: sourceSnapshotId,
    mirrorDatabase: 'dev_vue_m1_a', admission: { approved: true, blockers: [] }, courseBatchSize: 1, progressBatchSize: 1 })
  return { sources: sorted, options: { courses, progress }, manifests, evidenceCatalog,
    reviewedBasis: { version: 'learning-reviewed-basis/v1', logicalSourceId: sourceSnapshotId, mirrorDatabase: 'dev_vue_m1_a',
      admission: { approved: true, blockers: [] }, courseBatchSize: 1, progressBatchSize: 1,
      courses: { run: courses.run, basis: courses.basis }, progress: { run: progress.run, basis: progress.basis, lessonMappings } },
    historicalTimeVerified: false, currentDevVueApplyAuthorized: false }
}
