import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonical, hash, exactKeys } from './v4-backfill-contract.mjs'
import { validateReviewHistoryBundle } from './review-history-bundle.mjs'

export const reviewChunkBytes = 256 * 1024
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function chunkReviewHistory(bundle) {
  const { sourceHash } = validateReviewHistoryBundle(bundle)
  const bytes = Buffer.from(canonical(bundle), 'utf8')
  assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024, 'review_history_archive_size')
  const count = Math.ceil(bytes.length / reviewChunkBytes)
  const chunks = []
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * reviewChunkBytes, (i + 1) * reviewChunkBytes)
    const source = { id: String(i + 1), schemaVersion: 'review.history.chunk.v1', sourceTable: bundle.table, sourceId: bundle.id,
      bundleSha256: sourceHash, bundleBytes: bytes.length, chunkCount: count, chunkIndex: i,
      chunkBytes: part.length, chunkSha256: sha(part), encoding: 'base64', data: part.toString('base64') }
    chunks.push({ source, sourceHash: hash(source) })
  }
  return chunks
}

export function restoreReviewHistory(chunks) {
  assert.ok(Array.isArray(chunks) && chunks.length > 0 && chunks.length <= 256, 'review_history_chunk_count')
  const first = chunks[0]?.source, parts = []
  for (const [index, entry] of chunks.entries()) {
    exactKeys(entry, ['source', 'sourceHash'])
    const row = entry.source
    exactKeys(row, ['id', 'schemaVersion', 'sourceTable', 'sourceId', 'bundleSha256', 'bundleBytes', 'chunkCount', 'chunkIndex', 'chunkBytes', 'chunkSha256', 'encoding', 'data'])
    assert.equal(hash(row), entry.sourceHash, 'review_history_chunk_hash')
    assert.equal(row.schemaVersion, 'review.history.chunk.v1'); assert.equal(row.encoding, 'base64')
    assert.equal(row.id, String(index + 1)); assert.equal(row.chunkIndex, index); assert.equal(row.chunkCount, chunks.length)
    assert.equal(row.sourceTable, first.sourceTable); assert.equal(row.sourceId, first.sourceId)
    assert.equal(row.bundleSha256, first.bundleSha256); assert.equal(row.bundleBytes, first.bundleBytes)
    assert.ok(Number.isSafeInteger(row.bundleBytes) && row.bundleBytes > 0 && row.bundleBytes <= 64 * 1024 * 1024)
    assert.ok(typeof row.data === 'string' && row.data.length <= Math.ceil(reviewChunkBytes / 3) * 4)
    const bytes = Buffer.from(row.data, 'base64')
    assert.equal(bytes.toString('base64'), row.data, 'review_history_base64_invalid')
    assert.ok(bytes.length > 0 && bytes.length <= reviewChunkBytes)
    assert.equal(bytes.length, row.chunkBytes); assert.equal(sha(bytes), row.chunkSha256)
    if (index < chunks.length - 1) assert.equal(bytes.length, reviewChunkBytes)
    parts.push(bytes)
  }
  const bytes = Buffer.concat(parts)
  assert.equal(bytes.length, first.bundleBytes); assert.equal(sha(bytes), first.bundleSha256, 'review_history_bundle_hash')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), bundle = JSON.parse(text)
  assert.equal(canonical(bundle), text, 'review_history_canonical_mismatch')
  assert.equal(bundle.table, first.sourceTable); assert.equal(bundle.id, first.sourceId)
  validateReviewHistoryBundle(bundle)
  return bundle
}
