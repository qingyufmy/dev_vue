import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { archiveCanonical, archiveHash, decodeReviewArchive } from '../src/modules/reviews/infrastructure/review-archive-decoder.js'
import { MysqlReviewArchivedActivityReader } from '../src/modules/reviews/infrastructure/mysql-review-archived-activity-reader.js'

function fixture() {
  const bundle = { table: 'trade_review_cases', id: '1', rows: { trade_review_cases: [{ id: '1' }] } }
  const bytes = Buffer.from(archiveCanonical(bundle))
  const ref = { runId: '11111111-1111-1111-1111-111111111111', sourceTable: bundle.table, sourceId: '1',
    streamId: archiveHash({ sourceTable: bundle.table, role: 'review-history-case-1-chunks-v1' }), bundleHash: archiveHash(bundle) }
  const pk = [{ type: 'integer', value: '1' }], pkHash = archiveHash(pk)
  const targets = [{ table: 'data_migration_source_rows', pk: [{ type: 'text', value: ref.runId },
    { type: 'text', value: ref.streamId }, { type: 'text', value: pkHash }] }]
  const source = { id: '1', schemaVersion: 'review.history.chunk.v1', sourceTable: ref.sourceTable, sourceId: '1',
    bundleSha256: ref.bundleHash, bundleBytes: bytes.length, chunkCount: 1, chunkIndex: 0,
    chunkBytes: bytes.length, chunkSha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'base64', data: bytes.toString('base64') }
  const row = { pkHash, source, sourceHash: archiveHash(source), receiptHash: archiveHash(source), receiptPk: pk,
    targets, transformedHash: archiveHash({ stage: 'review_history_chunk_archived', targets }) }
  return { bundle, ref, row }
}
it('rejects corrupted chunks, wrong receipts and substituted archive references', () => {
  const { bundle, ref, row } = fixture()
  expect(decodeReviewArchive([row], ref)).toEqual(bundle)
  for (const patch of [{ receiptHash: '0'.repeat(64) }, { transformedHash: '0'.repeat(64) },
    { source: { ...row.source, data: row.source.data + ' ' } }, { receiptPk: [] }, { targets: [] }]) {
    expect(() => decodeReviewArchive([{ ...row, ...patch }], ref)).toThrow('review_archive_invalid')
  }
  expect(() => decodeReviewArchive([row], { ...ref, sourceId: '2' })).toThrow('review_archive_invalid')
  expect(() => decodeReviewArchive([row, row], ref)).toThrow('review_archive_invalid')
})
it('authorizes cache hits and avoids loading the archive again for successive pages', async () => {
  const { ref, row } = fixture()
  const execute = vi.fn(async (_sql: string, values: unknown[]) => {
    if (_sql.includes('LEFT JOIN review_case_history_v4')) return [values[1] === 1 ? [ref] : [], []]
    return [[row], []]
  })
  const reader = new MysqlReviewArchivedActivityReader({ execute } as unknown as Pick<Pool, 'execute'>)
  await reader.page(1, 'case', 'jobs', { limit: 1, offset: 0 })
  await reader.page(1, 'case', 'events', { limit: 1, offset: 0 })
  expect(execute.mock.calls.filter(([sql]) => sql.includes('data_migration_source_rows'))).toHaveLength(1)
  await expect(reader.page(2, 'case', 'events', { limit: 1, offset: 0 })).rejects.toThrow('review_case_not_found')
  expect(execute).toHaveBeenCalledTimes(4)
  await expect(reader.page(1, 'case', 'jobs', { limit: 101, offset: 0 })).rejects.toThrow('review_history_pagination_invalid')
  expect(execute).toHaveBeenCalledTimes(4)
})
