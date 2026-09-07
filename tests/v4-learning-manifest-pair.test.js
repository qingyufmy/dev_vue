import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { buildLearningManifestPair } from '../scripts/lib/v4-learning-manifest-pair.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
function fixture() {
  const c = learningCourseFixture(), p = learningProgressFixture()
  p.options.run.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  p.options.lessonMappings[0].lessonSourceHash = hash(c.source)
  p.options.basis.lessonMappingHash = hash(p.options.lessonMappings)
  const identity = kind => ({ database: 'dev_vue', serverUuid: c.options.run.id, storageMode: `inplace-learning-${kind}-v1`, schemaHash: 'c'.repeat(64) })
  return { sources: { courses: [c.source], progress: [p.source] }, options: { courses: c.options, progress: p.options },
    targetIdentities: { courses: identity('course'), progress: identity('progress') }, logicalSourceId: 'fixture', mirrorDatabase: 'mirror', admission: { approved: true, blockers: [] } }
}
it('creates a consistent pair using the same preflight as execution', () => {
  const pair = buildLearningManifestPair(fixture())
  expect(pair.courses.sourceIds).toEqual(['12'])
  expect(pair.progress.sourceIds).toEqual(['2'])
  expect(pair.courses.spec.runId).not.toBe(pair.progress.spec.runId)
})
it('rejects a locally valid child mapping that does not belong to the parent snapshot', () => {
  const input = fixture()
  input.options.progress.lessonMappings[0].lessonSourceHash = 'e'.repeat(64)
  input.options.progress.basis.lessonMappingHash = hash(input.options.progress.lessonMappings)
  expect(() => buildLearningManifestPair(input)).toThrow('learning_core_lesson_mapping_mismatch')
})
it('rejects different servers, snapshot identifiers and reused run IDs', () => {
  const server = fixture(); server.targetIdentities.progress.serverUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  expect(() => buildLearningManifestPair(server)).toThrow('learning_core_scope_mismatch')
  const snapshot = fixture()
  snapshot.options.progress.run.sourceSnapshotId = 'different'
  snapshot.options.progress.basis.sourceSnapshotId = 'different'
  expect(() => buildLearningManifestPair(snapshot)).toThrow('learning_core_snapshot_mismatch')
  const run = fixture(); run.options.progress.run.id = run.options.courses.run.id
  expect(() => buildLearningManifestPair(run)).toThrow('learning_core_run_collision')
})
