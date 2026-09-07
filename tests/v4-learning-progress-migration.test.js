import { beforeEach, expect, it, vi } from 'vitest'
import { canonical, hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { createLearningProgressBackfill } from '../scripts/lib/v4-learning-progress-backfill.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
import { migrateLearningProgress } from '../scripts/lib/v4-learning-progress-migration.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from '../scripts/lib/v4-learning-progress-backfill-runner.mjs'

vi.mock('../scripts/lib/v4-learning-progress-backfill-runner.mjs', () => ({
  prepareBackfillRun: vi.fn(), executeBackfillBatch: vi.fn(), recoverBackfillBatch: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  executeBackfillBatch.mockResolvedValue({ status: 'committed' })
  recoverBackfillBatch.mockResolvedValue({ status: 'committed' })
})
function fixture() {
  const { source, options } = learningProgressFixture(), pipeline = createLearningProgressBackfill([source], options)
  const row = pipeline.batches[0].rows[0]
  const spec = { runId: pipeline.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror', targetServerUuid: pipeline.runId,
    snapshotHash: pipeline.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), transformHash: pipeline.transformHash,
    storageMode: pipeline.writer.storageMode, streams: [pipeline.stream] } }
  const target = structuredClone(row.payload.entry.target)
  const replies = [[source], [target], [{ run_id: pipeline.runId, source_pk_sha256: hash(row.pk), source_bytes_sha256: hash(source),
    source_payload_json: canonical(pipeline.sourceEvidence(streamIdentity(pipeline.stream), row)) }],
  [{ id: '12', public_episode_id: '100', source_sha256: 'b'.repeat(64) }], [{ id: '1' }]]
  const tx = { targetIdentity: async () => ({ serverUuid: pipeline.runId, database: 'dev_vue', storageMode: pipeline.writer.storageMode, schemaHash: 'c'.repeat(64) }),
    findRun: async () => ({ bindings: spec.bindings, bindingsHash: hash(spec.bindings) }), connection: { execute: vi.fn(async () => [replies.shift()]) } }
  const repository = { transaction: vi.fn(work => work(tx)) }
  return { spec, source, options, target, repository, tx, run: mode => migrateLearningProgress(repository, spec, [source], options, { mode }) }
}
it('applies batches and requires independent readback before reporting verified', async () => {
  const f = fixture()
  expect((await f.run('apply')).status).toBe('verified')
  expect(prepareBackfillRun).toHaveBeenCalledOnce()
  expect(executeBackfillBatch).toHaveBeenCalledOnce()
  expect(recoverBackfillBatch).not.toHaveBeenCalled()
  expect(f.tx.connection.execute).toHaveBeenCalledTimes(5)
})
it.each(['not_committed', 'unknown'])('recovery stops at %s without writes or false audit', async status => {
  const f = fixture()
  recoverBackfillBatch.mockResolvedValue({ status })
  expect(await f.run('recover')).toMatchObject({ status, audit: null })
  expect(prepareBackfillRun).not.toHaveBeenCalled()
  expect(executeBackfillBatch).not.toHaveBeenCalled()
  expect(f.repository.transaction).not.toHaveBeenCalled()
})
it('checks committed recovery against current rows and refuses corrupted progress', async () => {
  const f = fixture()
  f.target.watched_ms = '599000'
  await expect(f.run('recover')).rejects.toThrow('learning_progress_migration_audit_failed')
  expect(executeBackfillBatch).not.toHaveBeenCalled()
})
it('rejects a source/transform binding mismatch before touching repository state', async () => {
  const f = fixture()
  f.spec.bindings.snapshotHash = 'e'.repeat(64)
  await expect(f.run('apply')).rejects.toThrow('learning_progress_migration_binding')
  expect(prepareBackfillRun).not.toHaveBeenCalled()
  expect(f.repository.transaction).not.toHaveBeenCalled()
})
it('propagates unknown apply without switching to retry or recovery automatically', async () => {
  const f = fixture()
  executeBackfillBatch.mockRejectedValue(new Error('backfill_commit_unknown'))
  await expect(f.run('apply')).rejects.toThrow('backfill_commit_unknown')
  expect(executeBackfillBatch).toHaveBeenCalledOnce()
  expect(recoverBackfillBatch).not.toHaveBeenCalled()
  expect(f.repository.transaction).not.toHaveBeenCalled()
})
