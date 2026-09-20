import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkReviewHistory, restoreReviewHistory, reviewChunkBytes } from './review-history-chunks.mjs'
import { createReviewHistoryChunkBatch, reviewChunkRole } from './review-history-chunk-batch.mjs'
import { canonical, hash } from './v4-backfill-contract.mjs'
const bundle = { table: 'trade_review_cases', id: '12', rows: {
  trade_review_cases: [{ id: '12', current_version_id: null, approved_version_id: null, evidence_json: ' 😀\r\n'.repeat(100000) }],
  trade_review_versions: [],
} }
test('multi-chunk archive restores exact Unicode, whitespace, source identity and bounded batches', () => {
  const chunks = chunkReviewHistory(bundle)
  assert.ok(chunks.length > 2)
  assert.deepEqual(restoreReviewHistory(chunks), bundle)
  const role = reviewChunkRole(bundle.id), bindings = { logicalSourceId: 'dev_vue', streams: [{ sourceTable: bundle.table, role }] }
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i].source.chunkBytes <= reviewChunkBytes)
    const batch = createReviewHistoryChunkBatch(chunks, i, { runId: '00000000-0000-0000-0000-000000000001', logicalSourceId: 'dev_vue',
      bindings, sequence: i + 1, startCursor: i === 0 ? null : [{ type: 'integer', value: String(i) }] })
    assert.equal(batch.rows, 1)
    assert.ok(Buffer.byteLength(canonical(chunks[i])) < 512 * 1024)
  }
})
test('rejects missing, reordered, duplicated, altered and cross-case chunks', () => {
  const chunks = chunkReviewHistory(bundle)
  assert.throws(() => restoreReviewHistory(chunks.slice(1)))
  assert.throws(() => restoreReviewHistory([...chunks].reverse()))
  assert.throws(() => restoreReviewHistory([chunks[0], ...chunks]))
  const changed = structuredClone(chunks); changed[0].source.data = changed[0].source.data.slice(4)
  changed[0].sourceHash = hash(changed[0].source)
  assert.throws(() => restoreReviewHistory(changed))
  const cross = structuredClone(chunks); cross[1].source.sourceId = '13'; cross[1].sourceHash = hash(cross[1].source)
  assert.throws(() => restoreReviewHistory(cross))
})
