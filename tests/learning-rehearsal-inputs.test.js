import { expect, it } from 'vitest'
import { prepareLearningRehearsalInputs } from '../scripts/lib/learning-rehearsal-inputs.mjs'
import { decodeLearningManifest } from '../scripts/lib/v4-learning-manifest.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
function fixture() {
  const identity = kind => ({ database: 'dev_vue_m1_source_20260907_02', serverUuid: 'ac423207-6ef3-11f1-b302-000c29fda104',
    storageMode: `inplace-learning-${kind}-v1`, schemaHash: 'c'.repeat(64) })
  return { sources: { courses: [learningCourseFixture().source], progress: [learningProgressFixture().source] },
    targetIdentities: { courses: identity('course'), progress: identity('progress') }, userIds: new Set(['1']), registeredAtUtc: '2026-09-07T00:00:00.000Z' }
}
it('builds matching one-row batches with explicit synthetic time provenance', () => {
  const prepared = prepareLearningRehearsalInputs(fixture())
  expect(prepared.historicalTimeVerified).toBe(false)
  expect(prepared.currentDevVueApplyAuthorized).toBe(false)
  for (const kind of ['courses', 'progress']) {
    const read = decodeLearningManifest(prepared.manifests[kind], { sources: prepared.sources[kind], evidenceCatalog: prepared.evidenceCatalog, userIds: new Set(['1']) })
    expect(read.batchSize).toBe(1)
    expect(read.options.run.sourceSnapshotId).toContain('synthetic')
  }
})
it('refuses current dev_vue and different VM identities', () => {
  const current = fixture(); current.targetIdentities.courses.database = 'dev_vue'
  expect(() => prepareLearningRehearsalInputs(current)).toThrow('learning_rehearsal_target')
  const other = fixture(); other.targetIdentities.progress.serverUuid = 'b'.repeat(36)
  expect(() => prepareLearningRehearsalInputs(other)).toThrow('learning_rehearsal_target')
})
it('still rejects missing actual users and invalid source values', () => {
  const missing = fixture(); missing.userIds.clear()
  expect(() => prepareLearningRehearsalInputs(missing)).toThrow('learning_progress_parent_missing')
  const invalid = fixture(); invalid.sources.courses[0].duration = '09:59'
  expect(() => prepareLearningRehearsalInputs(invalid)).toThrow()
})
