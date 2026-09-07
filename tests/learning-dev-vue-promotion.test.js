import { prepareLearningCourseRows } from '../scripts/lib/v4-learning-course-rows.mjs'
import { prepareLearningProgressRows } from '../scripts/lib/v4-learning-progress-rows.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
import { expect, it } from 'vitest'
import { validateLearningPromotion } from '../scripts/lib/learning-dev-vue-promotion.mjs'
function fixture() {
  const binding = { targetDatabase: 'dev_vue', targetServerUuid: 'server', schemaHash: 'schema', manifestHash: 'manifest' }
  const rule = { raw: '2026-06-17 12:30:00', offsetMinutes: 0 }
  const manifest = { spec: { bindings: binding }, options: { basis: { resolutions: [{ createdAt: rule, updatedAt: rule }] } } }
  const promotion = { kind: 'learning-dev-vue-promotion/v1', timePolicy: 'legacy-wall-clock-as-utc', userAcceptedHistoricalOffsetLoss: true, manifestHashes: { courses: 'manifest', progress: 'manifest' } }
  const audit = { importMatchesReviewedInputs: true, differences: [], control: { verified: true } }
  const receipt = { kind: 'learning-backfill-rehearsal/v1', executionHost: 'local', commitUnknownObserved: true,
    partialRecoveryDidNotWrite: true, fullRecoveryVerified: true, repeatNoop: true, fixtureCleanupVerified: true,
    cliEndToEndVerified: true, cli: { allTableRowsRestored: true },
    identities: { courses: { serverUuid: 'server', schemaHash: 'schema' }, progress: { serverUuid: 'server', schemaHash: 'schema' } }, courseAudit: audit, progressAudit: audit }
  return { promotion, receipt, manifests: { courses: structuredClone(manifest), progress: structuredClone(manifest) } }
}
it('admits only the exact manifests with the accepted zero offset policy and successful rehearsal', () => {
  const f = fixture()
  expect(() => validateLearningPromotion(f.promotion, f.receipt, f.manifests, 'server')).not.toThrow()
})
it.each(['commitUnknownObserved','partialRecoveryDidNotWrite','fullRecoveryVerified','repeatNoop','fixtureCleanupVerified','cliEndToEndVerified'])('rejects missing rehearsal proof %s', key => {
  const f = fixture(); f.receipt[key] = false
  expect(() => validateLearningPromotion(f.promotion, f.receipt, f.manifests, 'server')).toThrow('learning_promotion_rehearsal')
})
it('rejects a replacement manifest or target and historical offset conversion', () => {
  const f = fixture(); f.promotion.manifestHashes.courses = 'other'
  expect(() => validateLearningPromotion(f.promotion, f.receipt, f.manifests, 'server')).toThrow('learning_promotion_binding')
  f.promotion.manifestHashes.courses = 'manifest'; f.manifests.progress.options.basis.resolutions[0].updatedAt.offsetMinutes = 480
  expect(() => validateLearningPromotion(f.promotion, f.receipt, f.manifests, 'server')).toThrow('learning_promotion_time_offset')
})

it('preserves legacy wall values as UTC including null, without the former eight-hour shift', () => {
  const c = learningCourseFixture(), p = learningProgressFixture()
  c.options.basis.resolutions[0].createdAt.offsetMinutes = 0
  p.options.basis.resolutions[0].updatedAt.offsetMinutes = 0
  const course = prepareLearningCourseRows([c.source], c.options).entries[0]
  const progress = prepareLearningProgressRows([p.source], p.options).entries[0]
  expect(course.targets.course.created_at_utc).toBe('2026-01-01 01:00:00.000')
  expect(course.targets.course.updated_at_utc).toBeNull()
  expect(progress.target.updated_at_utc).toBe('2026-01-01 01:00:00.000')
  expect(course.provenance.source).toEqual(c.source)
})
