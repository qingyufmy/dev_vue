import { expect, it, vi } from 'vitest'
import { canonical, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { createLearningProgressBackfill } from '../scripts/lib/v4-learning-progress-backfill.mjs'
import { MysqlLearningProgressBackfillRepository } from '../scripts/lib/mysql-learning-progress-backfill.mjs'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'

function fixture() {
  const { source, options } = learningProgressFixture(), pipeline = createLearningProgressBackfill([source], options)
  const row = pipeline.batches[0].rows[0], stream = streamIdentity(pipeline.stream)
  const connection = { query: vi.fn(async () => [[]]), execute: vi.fn(async sql => sql.startsWith('SELECT source_bytes')
    ? [[{ source_bytes_sha256: row.sourceHash, source_payload_json: canonical(pipeline.sourceEvidence(stream, row)) }]] : [{ affectedRows: 1 }]),
  beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const repository = new MysqlLearningProgressBackfillRepository({ getConnection: async () => connection }, pipeline.sourceEvidence)
  return { pipeline, row, stream, connection, repository, write: tx => tx.insertReceipt(pipeline.runId, stream, pipeline.batches[0].batchId, row) }
}
it('persists receipt and complete source archive on the transaction connection before commit', async () => {
  const f = fixture()
  await f.repository.transaction(f.write)
  expect(f.connection.execute.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['INSERT', 'INSERT', 'SELECT'])
  expect(f.connection.execute.mock.calls[1][1][4]).toBe(canonical(f.pipeline.sourceEvidence(f.stream, f.row)))
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.query.mock.calls[0][0]).toBe('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
})
it('destroys a connection when setting snapshot isolation fails before beginning work', async () => {
  const f = fixture()
  f.connection.query.mockRejectedValue(new Error('isolation unavailable'))
  await expect(f.repository.transaction(f.write)).rejects.toThrow('backfill_storage_failed')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.beginTransaction).not.toHaveBeenCalled()
  expect(f.connection.execute).not.toHaveBeenCalled()
})
it('rolls back receipts when archive readback fails and rejects another run before SQL', async () => {
  const f = fixture()
  f.connection.execute.mockImplementation(async sql => sql.startsWith('SELECT') ? [[]] : [{ affectedRows: 1 }])
  await expect(f.repository.transaction(f.write)).rejects.toThrow('backfill_learning_evidence_readback')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
  const other = fixture()
  await expect(other.repository.transaction(tx => tx.insertReceipt('other', other.stream, 'batch', other.row))).rejects.toThrow('backfill_learning_run_mismatch')
  expect(other.connection.execute).not.toHaveBeenCalled()
})
it('reports unknown commit, destroys connection, and never retries', async () => {
  const f = fixture()
  f.connection.commit.mockRejectedValue(new Error('lost acknowledgement'))
  await expect(f.repository.transaction(f.write)).rejects.toThrow('backfill_commit_unknown')
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).not.toHaveBeenCalled()
})
