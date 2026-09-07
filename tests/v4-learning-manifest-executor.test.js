import { expect, it, vi } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { buildLearningManifest } from '../scripts/lib/v4-learning-manifest.mjs'
import { executeLearningManifests } from '../scripts/lib/v4-learning-manifest-executor.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

function fixture() {
  const c = learningCourseFixture(), p = learningProgressFixture()
  p.options.run.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  p.options.lessonMappings[0].lessonSourceHash = hash(c.source)
  p.options.basis.lessonMappingHash = hash(p.options.lessonMappings)
  const build = (kind, f) => buildLearningManifest({ kind, sources: [f.source], options: f.options, logicalSourceId: 'fixture', mirrorDatabase: 'mirror',
    admission: { approved: true, blockers: [] }, targetIdentity: { database: 'dev_vue', serverUuid: c.options.run.id,
      storageMode: `inplace-learning-${kind === 'courses' ? 'course' : 'progress'}-v1`, schemaHash: 'c'.repeat(64) } })
  return { pool: { getConnection: vi.fn(async () => { throw Error('offline fixture') }) }, courseManifest: build('courses', c), progressManifest: build('progress', p),
    sources: { courses: [c.source], progress: [p.source] }, userIds: p.options.userIds, evidenceCatalog: c.options.evidenceCatalog, mode: 'verify' }
}
it('validates both saved manifests and reaches the real parent repository first', async () => {
  const input = fixture()
  expect(await executeLearningManifests(input)).toMatchObject({ status: 'unknown', progress: null })
  expect(input.pool.getConnection).toHaveBeenCalledOnce()
})
it('does not obtain a connection when a saved child manifest or current user set is invalid', async () => {
  const invalid = fixture(); invalid.progressManifest.batchSize = 2
  await expect(executeLearningManifests(invalid)).rejects.toThrow('learning_manifest_hash')
  expect(invalid.pool.getConnection).not.toHaveBeenCalled()
  const missing = fixture(); missing.userIds.clear()
  await expect(executeLearningManifests(missing)).rejects.toThrow('learning_progress_parent_missing')
  expect(missing.pool.getConnection).not.toHaveBeenCalled()
})
