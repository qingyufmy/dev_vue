import { expect, it } from 'vitest'
import { prepareLearningProgressRows } from '../scripts/lib/v4-learning-progress-rows.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
it('preserves original data while mapping public episode to a distinct internal lesson', () => {
  const f = learningProgressFixture(), result = prepareLearningProgressRows([f.source], f.options)
  expect(result.entries[0].target).toMatchObject({ id: '2', user_id: '1', lesson_id: '12', watched_ms: '2049000', reported_duration_ms: '599000', completed: '1', quiz_passed: '0', updated_at_utc: '2025-12-31 17:00:00.000' })
  expect(Object.keys(result.entries[0].target)).toHaveLength(13)
  expect(result.entries[0].provenance.source).toEqual(f.source)
})
it('rejects absent users, ambiguous lessons, source drift and unresolved time', () => {
  for (const mutate of [f => f.options.userIds.clear(), f => f.options.lessonMappings.push({ ...f.options.lessonMappings[0] }),
    f => { f.source.watched_seconds = '2050' }, f => { f.options.basis.resolutions[0].updatedAt.offsetMinutes = null },
    f => f.options.evidenceCatalog.clear(), f => { f.options.lessonMappings[0].lessonSourceHash = 'c'.repeat(64) }]) {
    const f = learningProgressFixture(); mutate(f); expect(() => prepareLearningProgressRows([f.source], f.options)).toThrow()
  }
})
it('refuses multiple progress facts for one user and public lesson', () => {
  const f = learningProgressFixture()
  expect(() => prepareLearningProgressRows([f.source, { ...f.source, id: '3' }], f.options)).toThrow('duplicate')
})
