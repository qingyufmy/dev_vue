import { beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { createLearningCourseBackfill } from '../scripts/lib/v4-learning-course-backfill.mjs'
import { createLearningProgressBackfill } from '../scripts/lib/v4-learning-progress-backfill.mjs'
import { migrateLearningCore } from '../scripts/lib/v4-learning-core-migration.mjs'
import { migrateLearningCourse } from '../scripts/lib/v4-learning-course-migration.mjs'
import { migrateLearningProgress } from '../scripts/lib/v4-learning-progress-migration.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

vi.mock('../scripts/lib/v4-learning-course-migration.mjs', () => ({ migrateLearningCourse: vi.fn() }))
vi.mock('../scripts/lib/v4-learning-progress-migration.mjs', () => ({ migrateLearningProgress: vi.fn() }))
beforeEach(() => {
  vi.resetAllMocks()
  migrateLearningCourse.mockResolvedValue({ status: 'verified' })
  migrateLearningProgress.mockResolvedValue({ status: 'verified' })
})
function fixture() {
  const c = learningCourseFixture(), p = learningProgressFixture()
  const parents = createLearningCourseBackfill([c.source], c.options)
  p.options.run.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  p.options.lessonMappings = parents.lessonMappings
  p.options.basis.lessonMappingHash = hash(parents.lessonMappings)
  const children = createLearningProgressBackfill([p.source], p.options)
  const part = (fixture, pipeline) => ({ repository: {}, sources: [fixture.source], options: fixture.options,
    spec: { runId: pipeline.runId, admission: { approved: true, blockers: [] }, bindings: {
      logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror', targetServerUuid: c.options.run.id,
      snapshotHash: pipeline.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), transformHash: pipeline.transformHash,
      storageMode: pipeline.writer.storageMode, streams: [pipeline.stream] } } })
  return { courses: part(c, parents), progress: part(p, children) }
}
it('verifies course import before starting progress and keeps both run outcomes', async () => {
  const input = fixture()
  migrateLearningProgress.mockImplementation(async () => {
    expect(migrateLearningCourse).toHaveBeenCalledOnce()
    return { status: 'verified' }
  })
  expect(await migrateLearningCore(input, { mode: 'apply' })).toMatchObject({ status: 'verified', courses: { status: 'verified' }, progress: { status: 'verified' } })
  expect(migrateLearningCourse.mock.calls[0][4].mode).toBe('apply')
})
it.each(['not_committed', 'unknown'])('does not start children while parent outcome is %s', async status => {
  migrateLearningCourse.mockResolvedValue({ status })
  expect(await migrateLearningCore(fixture(), { mode: 'recover' })).toMatchObject({ status, progress: null })
  expect(migrateLearningProgress).not.toHaveBeenCalled()
})
it('validates child admission and conversion before any parent operation', async () => {
  const input = fixture()
  input.progress.spec.admission.blockers.push('unresolved_time')
  await expect(migrateLearningCore(input, { mode: 'apply' })).rejects.toThrow('backfill_wave_not_approved')
  const invalid = fixture()
  invalid.progress.options.userIds.clear()
  await expect(migrateLearningCore(invalid, { mode: 'apply' })).rejects.toThrow('learning_progress_parent_missing')
  expect(migrateLearningCourse).not.toHaveBeenCalled()
})
it('rejects cross-environment waves and plausible but unrelated lesson mappings', async () => {
  const input = fixture()
  input.progress.spec.bindings.targetServerUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  await expect(migrateLearningCore(input)).rejects.toThrow('learning_core_scope_mismatch')
  const unrelated = fixture()
  unrelated.progress.options.lessonMappings[0].lessonSourceHash = 'e'.repeat(64)
  unrelated.progress.options.basis.lessonMappingHash = hash(unrelated.progress.options.lessonMappings)
  const pipeline = createLearningProgressBackfill(unrelated.progress.sources, unrelated.progress.options)
  unrelated.progress.spec.bindings.transformHash = pipeline.transformHash
  await expect(migrateLearningCore(unrelated)).rejects.toThrow('learning_core_lesson_mapping_mismatch')
  expect(migrateLearningCourse).not.toHaveBeenCalled()
})
