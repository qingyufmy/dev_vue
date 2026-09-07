import { expect, it } from 'vitest'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { auditLearningProgressImport } from '../scripts/lib/v4-learning-progress-audit.mjs'
import { createLearningProgressBackfill } from '../scripts/lib/v4-learning-progress-backfill.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

function fixture() {
  const { source, options } = learningProgressFixture()
  // Expected SQL readback is hand-specified, not supplied by the converter.
  const actual = [{ id: '2', user_id: '1', lesson_id: '12', watched_ms: '2049000', reported_duration_ms: '599000', completed: '1', quiz_passed: '0',
    updated_at_utc: '2025-12-31 17:00:00.000000', revision: '1', origin: 'legacy_import', migration_run_id: options.run.id,
    source_sha256: hash(source), imported_at_utc: '2026-09-07 00:00:00.000000' }]
  const pipeline = createLearningProgressBackfill([source], options)
  const row = pipeline.batches[0].rows[0], stream = streamIdentity(pipeline.stream)
  const archives = [{ sourceId: '2', runId: options.run.id, sourceHash: hash(source), sourcePkHash: hash(row.pk), payload: pipeline.sourceEvidence(stream, row) }]
  options.actualLessons = [{ id: '12', public_episode_id: '100', source_sha256: 'b'.repeat(64) }]
  return { source, options, actual, archives, pipeline, row, stream, audit: () => auditLearningProgressImport([source], actual, archives, options) }
}

it('audits all fields and preserved over-duration progress against archived source and parents', () => {
  const f = fixture(), result = f.audit()
  expect(result.importMatchesReviewedInputs).toBe(true)
  expect(result.checkedTargetFields).toHaveLength(13)
  expect(result.deletionAuthorized).toBe(false)
  expect(f.archives[0].payload.source).toEqual(f.source)
})
it('detects corruption in each of thirteen target fields independently', () => {
  const baseline = fixture().actual[0]
  for (const field of Object.keys(baseline)) {
    const f = fixture()
    f.actual[0][field] = field.endsWith('_at_utc') ? '2026-01-02 00:00:00.000' : 'corrupt'
    const result = f.audit()
    expect(result.importMatchesReviewedInputs, field).toBe(false)
    expect(result.differences.length, field).toBeGreaterThan(0)
  }
})
it('rejects missing, extra and duplicate target/archive rows and stale parents', () => {
  const f = fixture()
  f.options.userIds.clear()
  f.options.actualLessons[0].public_episode_id = '101'
  f.archives[0].payload.source.completed = '0'
  expect(f.audit().differences.map(row => row.field)).toEqual(['user', 'lesson', 'archive'])
  f.actual.length = 0; f.archives.length = 0
  expect(f.audit().differences.map(row => row.field)).toContain('target')
  const extra = fixture()
  extra.actual.push({ ...extra.actual[0], id: '3' }); extra.archives.push({ ...extra.archives[0], sourceId: '3' })
  expect(extra.audit().differences.map(row => row.code)).toEqual(['unexpected', 'unexpected'])
  extra.actual.push({ ...extra.actual[0] })
  expect(extra.audit).toThrow('learning_progress_audit_duplicate')
})
it('requires reviewed time and mapping evidence and exact archive identity', () => {
  const f = fixture()
  f.options.evidenceCatalog.clear()
  expect(f.audit).toThrow('learning_progress_audit_evidence')
  const changed = fixture()
  changed.options.lessonMappings[0].lessonId = '13'
  expect(changed.audit).toThrow('learning_progress_audit_basis')
  const archive = fixture()
  archive.archives[0].sourcePkHash = 'c'.repeat(64)
  expect(archive.audit().differences).toEqual([{ sourceId: '2', field: 'archive', code: 'identity_mismatch' }])
})
it.each([
  [null, null], ['0.001000', '1'], ['9223372036854775.807', '9223372036854775807'],
])('checks exact duration %s without rounding or clamping', (seconds, expected) => {
  const f = fixture()
  f.source.watched_seconds = seconds
  f.source.updated_at = null
  f.source.completed = null
  f.options.basis.sourceHash = hash([f.source])
  const resolution = f.options.basis.resolutions[0]
  resolution.sourceHash = hash(f.source)
  Object.assign(resolution.updatedAt, { raw: null, kind: 'source_null', offsetMinutes: null })
  Object.assign(f.actual[0], { watched_ms: expected, completed: null, updated_at_utc: null, source_sha256: hash(f.source) })
  // Archive assembled independently of batch builder for these boundary cases.
  f.archives[0].sourceHash = hash(f.source)
  Object.assign(f.archives[0].payload, { source: structuredClone(f.source), basisHash: hash(f.options.basis), resolution: structuredClone(resolution) })
  expect(f.audit().importMatchesReviewedInputs).toBe(true)
})
it('freezes batches and archive payloads against input or returned-object mutation', async () => {
  const f = fixture()
  expect(f.row.transformedHash).toBe(hash({ payload: f.row.payload, targets: f.row.targets }))
  expect(() => f.pipeline.sourceEvidence('unrelated', f.row)).toThrow('learning_progress_evidence_stream')
  f.source.watched_seconds = '1'
  expect(f.pipeline.sourceEvidence(f.stream, f.row).source.watched_seconds).toBe('2049')
  f.row.payload.entry.provenance.lessonMapping.lessonId = '13'
  await expect(f.pipeline.writer.write({}, f.row)).rejects.toThrow('learning_progress_batch_row_changed')
  expect(() => f.pipeline.sourceEvidence(f.stream, f.row)).toThrow('learning_progress_batch_row_changed')
})
it('produces deterministic ordered checkpoints and rejects invalid batch sizes', () => {
  const { source, options } = learningProgressFixture()
  const second = { ...source, id: '3', episode_id: '101' }
  options.lessonMappings.push({ episodeId: '101', lessonId: '13', lessonSourceHash: 'c'.repeat(64) })
  options.basis.lessonMappingHash = hash(options.lessonMappings)
  options.basis.sourceHash = hash([source, second])
  options.basis.resolutions.push({ ...structuredClone(options.basis.resolutions[0]), sourceId: '3', sourceHash: hash(second) })
  const a = createLearningProgressBackfill([second, source], options, { batchSize: 1 })
  const b = createLearningProgressBackfill([source, second], options, { batchSize: 1 })
  expect(a.batches).toEqual(b.batches)
  expect(a.batches.map(batch => batch.sequence)).toEqual([1, 2])
  expect(a.batches[1].startCursor).toEqual(a.batches[0].endCursor)
  expect(() => createLearningProgressBackfill([source], options, { batchSize: 501 })).toThrow('learning_progress_batch_size')
})
