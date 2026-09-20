import assert from 'node:assert/strict'
import { canonical, hash, streamIdentity } from './v4-backfill-contract.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'
import { readReviewHistoryBundle } from './review-history-bundle.mjs'
import { chunkReviewHistory, restoreReviewHistory } from './review-history-chunks.mjs'

// A role identifies one case's archive stream; source PK is the ordinal chunk,
// not a fabricated old row ID. The envelope carries the original table and ID.
export const reviewChunkRole = caseId => {
  assert.match(caseId, /^[1-9]\d{0,19}$/)
  return `review-history-case-${caseId}-chunks-v1`
}
export function createReviewHistoryChunkBatch(allChunks, index, options) {
  const bundle = restoreReviewHistory(allChunks)
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < allChunks.length)
  assert.equal(options.sequence, index + 1)
  assert.equal(canonical(options.startCursor), canonical(index === 0 ? null : [{ type: 'integer', value: String(index) }]))
  const entry = allChunks[index], role = reviewChunkRole(bundle.id)
  const stream = streamIdentity({ sourceTable: bundle.table, role })
  return createFrozenSourceBatch([entry], options, { sourceTable: bundle.table, role, errorPrefix: 'review_chunk',
    createWriter() { return { async write(tx) {
      const live = await readReviewHistoryBundle(tx.connection, bundle.table, bundle.id)
      assert.equal(hash(live), entry.source.bundleSha256, 'review_history_source_changed')
      const current = chunkReviewHistory(live)[index]
      assert.equal(canonical(current), canonical(entry), 'review_history_chunk_changed')
    } } },
    projectRow(value) {
      const pk = [{ type: 'integer', value: value.source.id }]
      const targets = [{ table: 'data_migration_source_rows', pk: [
        { type: 'text', value: options.runId }, { type: 'text', value: stream }, { type: 'text', value: hash(pk) },
      ] }]
      return { pk, sourceHash: value.sourceHash, transformedHash: hash({ stage: 'review_history_chunk_archived', targets }), targets, source: value.source }
    },
  })
}
