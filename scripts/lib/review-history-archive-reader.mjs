import assert from 'node:assert/strict'
import { canonical, hash, streamIdentity } from './v4-backfill-contract.mjs'
import { reviewChunkRole } from './review-history-chunk-batch.mjs'
import { restoreReviewHistory } from './review-history-chunks.mjs'
const decode = value => typeof value === 'string' ? JSON.parse(value) : value

// Migration-only input: callers still validate the run, target and source manifest.
export async function readReviewHistoryArchive(db, { runId, sourceTable, sourceId, expectedBundleHash }) {
  assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.match(expectedBundleHash, /^[a-f0-9]{64}$/)
  const streamId = streamIdentity({ sourceTable, role: reviewChunkRole(sourceId) })
  const [rows] = await db.execute(`SELECT a.source_pk_sha256 pkHash,a.source_bytes_sha256 sourceHash,a.source_payload_json source,
    r.source_bytes_sha256 receiptHash,r.source_pk_json receiptPk,r.transformed_sha256 transformedHash,r.targets_json targets
    FROM data_migration_source_rows a JOIN data_migration_row_receipts r
      ON r.run_id=a.run_id AND r.stream_id=a.stream_id AND r.source_pk_sha256=a.source_pk_sha256
    WHERE a.run_id=? AND a.stream_id=?
    ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(a.source_payload_json,'$.chunkIndex')) AS UNSIGNED) LIMIT 257`, [runId, streamId])
  assert.ok(rows.length > 0 && rows.length <= 256, 'review_history_archive_incomplete')
  const chunks = rows.map((row, index) => {
    const pk = [{ type: 'integer', value: String(index + 1) }], pkHash = hash(pk)
    const targets = [{ table: 'data_migration_source_rows', pk: [
      { type: 'text', value: runId }, { type: 'text', value: streamId }, { type: 'text', value: pkHash },
    ] }]
    assert.equal(row.pkHash, pkHash); assert.equal(canonical(decode(row.receiptPk)), canonical(pk))
    assert.equal(row.sourceHash, row.receiptHash)
    assert.equal(canonical(decode(row.targets)), canonical(targets))
    assert.equal(row.transformedHash, hash({ stage: 'review_history_chunk_archived', targets }))
    return { source: decode(row.source), sourceHash: row.sourceHash }
  })
  const bundle = restoreReviewHistory(chunks)
  assert.equal(bundle.table, sourceTable); assert.equal(bundle.id, sourceId)
  assert.equal(hash(bundle), expectedBundleHash, 'review_history_archive_manifest_mismatch')
  return bundle
}
