import test from 'node:test'
import assert from 'node:assert/strict'
import { hash, streamIdentity } from './v4-backfill-contract.mjs'
import { chunkReviewHistory } from './review-history-chunks.mjs'
import { reviewChunkRole } from './review-history-chunk-batch.mjs'
import { readReviewHistoryArchive } from './review-history-archive-reader.mjs'
const bundle = { table: 'trade_review_cases', id: '12', rows: {
  trade_review_cases: [{ id: '12', current_version_id: null, approved_version_id: null, evidence_json: '😀'.repeat(100000) }], trade_review_versions: [],
} }
const runId = '00000000-0000-0000-0000-000000000001'
const request = { runId, sourceTable: bundle.table, sourceId: bundle.id, expectedBundleHash: hash(bundle) }
const streamId = streamIdentity({ sourceTable: bundle.table, role: reviewChunkRole(bundle.id) })
function fixture() {
  const rows = chunkReviewHistory(bundle).map(entry => {
    const receiptPk = [{ type: 'integer', value: entry.source.id }], pkHash = hash(receiptPk)
    const targets = [{ table: 'data_migration_source_rows', pk: [
      { type: 'text', value: runId }, { type: 'text', value: streamId }, { type: 'text', value: pkHash },
    ] }]
    return { pkHash, receiptPk, targets, source: entry.source, sourceHash: entry.sourceHash, receiptHash: entry.sourceHash,
      transformedHash: hash({ stage: 'review_history_chunk_archived', targets }) }
  })
  return { rows, db: { execute: async (_sql, parameters) => { assert.deepEqual(parameters, [runId, streamId]); return [rows] } } }
}
test('requires matching archive, receipt, target and full manifest before returning source', async () => {
  const f = fixture(); assert.deepEqual(await readReviewHistoryArchive(f.db, request), bundle)
  await assert.rejects(readReviewHistoryArchive(f.db, { ...request, expectedBundleHash: 'a'.repeat(64) }), /review_history_archive_manifest_mismatch/)
  f.rows[0].receiptHash = 'b'.repeat(64); await assert.rejects(readReviewHistoryArchive(f.db, request))
})
test('refuses missing receipt rows and altered ordinal target references', async () => {
  const missing = fixture(); missing.rows.pop(); await assert.rejects(readReviewHistoryArchive(missing.db, request))
  const altered = fixture(); altered.rows[0].targets[0].pk[2].value = 'c'.repeat(64)
  await assert.rejects(readReviewHistoryArchive(altered.db, request))
})
