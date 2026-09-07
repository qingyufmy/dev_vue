import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { auditLearningCourseImport, learningCourseAuditFields } from '../scripts/lib/v4-learning-course-audit.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'

function fixture() {
  const { source, options } = learningCourseFixture()
  const common = { created_at_utc: '2025-12-31 17:00:00.000', updated_at_utc: null, revision: '1', origin: 'legacy_import',
    migration_run_id: options.run.id, source_sha256: hash(source), imported_at_utc: '2026-09-07 00:00:00.000' }
  // Independently spelled-out SQL readback, not converter output.
  const actual = {
    courses: [{ id: '12', title: 'fixture-title', description: 'fixture-description', category_key: 'indicator', cover_locator: null,
      gradient_token: null, access_level: 'logged_in', status: 'published', sort_order: null, ...common }],
    lessons: [{ id: '12', course_id: '12', public_episode_id: '100', display_number: '3', title: 'fixture-title', content_type: 'video', duration_ms: '599000', sort_order: '0', ...common }],
    media: [{ id: '9007199254740993', lesson_id: '12', source_kind: 'bilibili_id', locator: 'fixture-bv', ...common },
      { id: '9007199254740994', lesson_id: '12', source_kind: 'article_url', locator: 'https://example.invalid/original?a=1', ...common }],
  }
  const archives = [{ sourceId: '12', runId: options.run.id, sourceHash: hash(source), sourcePkHash: hash([{ type: 'integer', value: '12' }]),
    payload: { version: 1, sourceTable: 'courses', projection: 'learning-course-source/v1', source: structuredClone(source), sourceSnapshotId: options.run.sourceSnapshotId,
      registeredAtUtc: options.run.registeredAtUtc, basisHash: hash(options.basis), resolution: structuredClone(options.basis.resolutions[0]),
      mediaBindings: actual.media.map(row => ({ sourceKind: row.source_kind, id: row.id })) } }]
  return { source, options, actual, archives, audit: () => auditLearningCourseImport([source], actual, archives, options) }
}
it('checks parent facts, every media field, exact generated IDs and all source fields', () => {
  const f = fixture(), result = f.audit()
  expect(result.importMatchesReviewedInputs).toBe(true)
  expect(result.targetRows).toEqual({ courses: 1, lessons: 1, media: 2 })
  expect(result.mediaAvailabilityVerified).toBe(false)
  expect(result.deletionAuthorized).toBe(false)
})
it('detects independent corruption of every field in each target table', () => {
  for (const [table, fields] of Object.entries(learningCourseAuditFields)) for (const field of fields) {
    const f = fixture()
    f.actual[table][0][field] = field.endsWith('_at_utc') ? '2026-01-02 00:00:00.000' : field === 'id' ? '999' : 'corrupt'
    expect(f.audit().importMatchesReviewedInputs, `${table}.${field}`).toBe(false)
  }
})
it('detects edits to all 26 archived fields including counters and empty locators', () => {
  for (const field of Object.keys(fixture().source)) {
    const f = fixture()
    f.archives[0].payload.source[field] = 'changed'
    expect(f.audit().differences, field).toContainEqual({ sourceId: '12', field: 'archive', code: 'payload_mismatch' })
  }
})
it('rejects missing or unexpected media and reassignment of generated IDs', () => {
  const missing = fixture()
  missing.actual.media.pop()
  expect(missing.audit().differences).toContainEqual({ sourceId: '12', field: 'media', code: 'missing' })
  const extra = fixture()
  extra.actual.media.push({ ...extra.actual.media[0], id: '999', source_kind: 'youtube_id' })
  expect(extra.audit().differences).toContainEqual({ sourceId: '999', field: 'media', code: 'unexpected' })
  const rebound = fixture()
  rebound.archives[0].payload.mediaBindings[0].id = '999'
  expect(rebound.audit().differences).toContainEqual({ sourceId: '12', field: 'media.id', code: 'value_mismatch' })
  const reordered = fixture()
  reordered.archives[0].payload.mediaBindings.reverse()
  expect(reordered.audit().differences).toContainEqual({ sourceId: '12', field: 'mediaBindings', code: 'kind_mismatch' })
})
it('rejects duplicate natural keys and missing review evidence', () => {
  const duplicate = fixture()
  duplicate.actual.media.push({ ...duplicate.actual.media[0], id: '999' })
  expect(duplicate.audit).toThrow('learning_course_audit_media_duplicate')
  const missing = fixture()
  missing.options.evidenceCatalog.clear()
  expect(missing.audit).toThrow('learning_course_audit_evidence')
  const source = fixture()
  source.source.quiz_count = '10'
  expect(source.audit).toThrow('learning_course_audit_basis')
})
it('does not accept absent source archives even when every business row matches', () => {
  const f = fixture()
  f.archives.length = 0
  expect(f.audit().importMatchesReviewedInputs).toBe(false)
})
