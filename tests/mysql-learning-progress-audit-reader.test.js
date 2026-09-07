import { expect, it, vi } from 'vitest'
import { readLearningProgressAudit } from '../scripts/lib/mysql-learning-progress-audit-reader.mjs'
import { auditLearningProgressImport } from '../scripts/lib/v4-learning-progress-audit.mjs'
import { createLearningProgressBackfill } from '../scripts/lib/v4-learning-progress-backfill.mjs'
import { prepareBatch } from '../scripts/lib/v4-learning-progress-backfill-contract.mjs'
import { canonical, hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

function fixture() {
  const { source, options } = learningProgressFixture(), pipeline = createLearningProgressBackfill([source], options)
  const row = pipeline.batches[0].rows[0], stream = streamIdentity(pipeline.stream)
  const payload = pipeline.sourceEvidence(stream, row)
  const archive = { run_id: pipeline.runId, source_pk_sha256: hash(row.pk), source_bytes_sha256: hash(source), source_payload_json: canonical(payload) }
  const replies = [[source], [structuredClone(row.payload.entry.target)], [archive], [{ id: '12', public_episode_id: '100', source_sha256: 'b'.repeat(64) }], [{ id: '1' }]]
  const connection = { execute: vi.fn(async () => [replies.shift()]) }
  return { options, pipeline, connection, archive }
}
it('reads distinct SQL evidence and supplies all audit inputs in a caller-owned snapshot', async () => {
  const f = fixture(), read = await readLearningProgressAudit(f.connection, f.pipeline.runId)
  expect(auditLearningProgressImport(read.sources, read.actual, read.archives, { ...f.options, actualLessons: read.actualLessons, userIds: read.userIds }).importMatchesReviewedInputs).toBe(true)
  expect(f.connection.execute).toHaveBeenCalledTimes(5)
  expect(f.connection.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  expect(f.connection.execute.mock.calls[2][1]).toEqual([f.pipeline.runId, streamIdentity(f.pipeline.stream)])
})
it('rejects malformed archive JSON and invalid runs without guessing', async () => {
  const f = fixture()
  f.archive.source_payload_json = '{invalid'
  await expect(readLearningProgressAudit(f.connection, f.pipeline.runId)).rejects.toThrow('learning_progress_archive_json')
  const invalid = fixture()
  await expect(readLearningProgressAudit(invalid.connection, 'other')).rejects.toThrow('learning_progress_audit_run')
  expect(invalid.connection.execute).not.toHaveBeenCalled()
})
it('accepts the real closed pipeline under the learning-only contract and rejects cross-domain targets', () => {
  const f = fixture(), p = f.pipeline
  const spec = { runId: p.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror', targetServerUuid: p.runId,
    snapshotHash: p.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), transformHash: p.transformHash,
    storageMode: p.writer.storageMode, streams: [p.stream] } }
  expect(prepareBatch(spec, p.batches[0]).requestHash).toBe(hash(p.batches[0]))
  const wrong = structuredClone(p.batches[0])
  wrong.rows[0].targets[0].table = 'system_settings'
  expect(() => prepareBatch(spec, wrong)).toThrow('backfill_inplace_target_invalid')
  spec.bindings.streams[0].sourceTable = 'courses'
  expect(() => prepareBatch(spec, p.batches[0])).toThrow('backfill_learning_progress_stream_invalid')
})
