import { beforeEach, expect, it, vi } from 'vitest'
import { canonical, hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { createLearningCourseBackfill } from '../scripts/lib/v4-learning-course-backfill.mjs'
import { prepareBatch } from '../scripts/lib/v4-learning-course-backfill-contract.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'
import { migrateLearningCourse } from '../scripts/lib/v4-learning-course-migration.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from '../scripts/lib/v4-learning-course-backfill-runner.mjs'

vi.mock('../scripts/lib/v4-learning-course-backfill-runner.mjs', () => ({
  prepareBackfillRun: vi.fn(), executeBackfillBatch: vi.fn(), recoverBackfillBatch: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  executeBackfillBatch.mockResolvedValue({ status: 'committed' })
  recoverBackfillBatch.mockResolvedValue({ status: 'committed' })
})
function fixture() {
  const { source, options } = learningCourseFixture(), pipeline = createLearningCourseBackfill([source], options)
  const row = pipeline.batches[0].rows[0]
  const spec = { runId: pipeline.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror', targetServerUuid: pipeline.runId,
    snapshotHash: pipeline.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), transformHash: pipeline.transformHash,
    storageMode: pipeline.writer.storageMode, streams: [pipeline.stream] } }
  const { course, lesson, media } = structuredClone(row.payload.entry.targets)
  const actualMedia = media.map((item, index) => ({ id: String(9007199254740993n + BigInt(index)), ...item }))
  const payload = { version: 1, sourceTable: 'courses', projection: 'learning-course-source/v1', source,
    sourceSnapshotId: options.run.sourceSnapshotId, registeredAtUtc: options.run.registeredAtUtc, basisHash: hash(options.basis),
    resolution: options.basis.resolutions[0], mediaBindings: actualMedia.map(item => ({ sourceKind: item.source_kind, id: item.id })) }
  const archive = { run_id: pipeline.runId, source_pk_sha256: hash(row.pk), source_bytes_sha256: hash(source), source_payload_json: canonical(payload) }
  const replies = [[source], [course], [lesson], actualMedia, [archive]]
  const tx = { targetIdentity: async () => ({ serverUuid: pipeline.runId, database: 'dev_vue', storageMode: pipeline.writer.storageMode, schemaHash: 'c'.repeat(64) }),
    findRun: async () => ({ bindings: spec.bindings, bindingsHash: hash(spec.bindings) }), connection: { execute: vi.fn(async () => [replies.shift()]) } }
  const repository = { transaction: vi.fn(work => work(tx)) }
  return { pipeline, spec, source, options, actualMedia, archive, repository, tx, run: mode => migrateLearningCourse(repository, spec, [source], options, { mode }) }
}
it('accepts full parent ID mappings and requires all three target tables and archive readback', async () => {
  const f = fixture()
  expect(prepareBatch(f.spec, f.pipeline.batches[0]).requestHash).toBe(hash(f.pipeline.batches[0]))
  expect((await f.run('apply')).status).toBe('verified')
  expect(prepareBackfillRun).toHaveBeenCalledOnce()
  expect(executeBackfillBatch).toHaveBeenCalledOnce()
  expect(f.tx.connection.execute).toHaveBeenCalledTimes(5)
  expect(f.tx.connection.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
})
it.each(['not_committed', 'unknown'])('recovery observes %s without creating or replaying a batch', async status => {
  const f = fixture()
  recoverBackfillBatch.mockResolvedValue({ status })
  expect(await f.run('recover')).toMatchObject({ status, audit: null })
  expect(prepareBackfillRun).not.toHaveBeenCalled()
  expect(executeBackfillBatch).not.toHaveBeenCalled()
  expect(f.repository.transaction).not.toHaveBeenCalled()
})
it('refuses committed rows whose actual media ID no longer matches the saved binding', async () => {
  const f = fixture()
  f.actualMedia[0].id = '999'
  await expect(f.run('verify')).rejects.toThrow('learning_course_migration_audit_failed')
  expect(executeBackfillBatch).not.toHaveBeenCalled()
})
it('rejects invalid archived JSON and extra media in the independent SQL results', async () => {
  const invalid = fixture()
  invalid.archive.source_payload_json = 'invalid'
  await expect(invalid.run('verify')).rejects.toThrow('learning_course_archive_json')
  const extra = fixture()
  extra.actualMedia.push({ ...extra.actualMedia[0], id: '999', source_kind: 'youtube_id' })
  await expect(extra.run('verify')).rejects.toThrow('learning_course_migration_audit_failed')
})
it('binds source and transform before touching state and propagates unknown commit', async () => {
  const f = fixture()
  f.spec.bindings.snapshotHash = 'e'.repeat(64)
  await expect(f.run('apply')).rejects.toThrow('learning_course_migration_binding')
  expect(prepareBackfillRun).not.toHaveBeenCalled()
  executeBackfillBatch.mockRejectedValue(new Error('backfill_commit_unknown'))
  await expect(fixture().run('apply')).rejects.toThrow('backfill_commit_unknown')
  expect(executeBackfillBatch).toHaveBeenCalledOnce()
  expect(recoverBackfillBatch).not.toHaveBeenCalled()
})
