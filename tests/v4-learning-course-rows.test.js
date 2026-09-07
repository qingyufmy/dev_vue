import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareLearningCourseRows } from '../scripts/lib/v4-learning-course-rows.mjs'
import { prepareLearningProgressRows } from '../scripts/lib/v4-learning-progress-rows.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
it('preserves all 26 fields and emits separate course, lesson and kind-bound references', () => {
  const f = learningCourseFixture(), result = prepareLearningCourseRows([f.source], f.options), entry = result.entries[0]
  expect(entry.provenance.source).toEqual(f.source)
  expect(Object.keys(entry.provenance.source)).toHaveLength(26)
  expect(entry.targets.course).toMatchObject({ id: '12', title: f.source.title, sort_order: null, access_level: 'logged_in', created_at_utc: '2025-12-31 17:00:00.000' })
  expect(entry.targets.lesson).toMatchObject({ id: '12', course_id: '12', public_episode_id: '100', duration_ms: '599000', sort_order: '0' })
  expect(entry.targets.media).toHaveLength(2)
  expect(entry.targets.media.find(row => row.source_kind === 'article_url').locator).toBe(f.source.article_url)
  expect(entry.provenance.source.quiz_count).toBe('9')
  expect(entry.targets.course).not.toHaveProperty('quiz_count')
  expect(result.mediaAvailabilityVerified).toBe(false)
})
it('provides the exact parent mapping required by progress conversion', () => {
  const f = learningCourseFixture(), courses = prepareLearningCourseRows([f.source], f.options), progress = learningProgressFixture()
  progress.options.lessonMappings = courses.lessonMappings
  progress.options.basis.lessonMappingHash = hash(courses.lessonMappings)
  expect(prepareLearningProgressRows([progress.source], progress.options).entries[0].target.lesson_id).toBe(courses.entries[0].targets.lesson.id)
})
it('refuses source drift, repeated public episodes and incomplete time/semantic evidence', () => {
  for (const change of [f => { f.source.title = 'changed' }, f => { f.options.basis.resolutions[0].createdAt.offsetMinutes = null },
    f => { f.options.basis.resolutions[0].valueEvidence.requirements.pop() }, f => f.options.evidenceCatalog.clear()]) {
    const f = learningCourseFixture(); change(f); expect(() => prepareLearningCourseRows([f.source], f.options)).toThrow()
  }
  const f = learningCourseFixture()
  expect(() => prepareLearningCourseRows([f.source, { ...f.source, id: '13' }], f.options)).toThrow('duplicate')
})
it('keeps nullable access and state instead of granting access or fabricating defaults', () => {
  const f = learningCourseFixture()
  f.source.access_level = null; f.source.status = null; f.source.duration = null
  f.options.basis.sourceHash = hash([f.source]); f.options.basis.resolutions[0].sourceHash = hash(f.source)
  const entry = prepareLearningCourseRows([f.source], f.options).entries[0]
  expect(entry.targets.course.access_level).toBe(null)
  expect(entry.targets.course.status).toBe(null)
  expect(entry.targets.lesson.duration_ms).toBe(null)
})
