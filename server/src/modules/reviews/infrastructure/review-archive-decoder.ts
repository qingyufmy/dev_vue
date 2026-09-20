import { createHash } from 'node:crypto'
import { ReviewError } from '../domain/review.js'

export const archiveInvalid = () => new ReviewError('review_archive_invalid', 503)
export function archiveAssert(value: unknown): asserts value { if (!value) throw archiveInvalid() }
export function archiveCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { archiveAssert(Number.isSafeInteger(value)); return JSON.stringify(value) }
  if (Array.isArray(value)) return '[' + value.map(archiveCanonical).join(',') + ']'
  archiveAssert(value && Object.getPrototypeOf(value) === Object.prototype)
  const row = value as Record<string, unknown>
  return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + archiveCanonical(row[key])).join(',') + '}'
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const archiveHash = (value: unknown) => sha(archiveCanonical(value))
export const archiveJson = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value
export interface ReviewArchiveReference { runId: string; streamId: string; sourceTable: string; sourceId: string; bundleHash: string }
export interface ReviewArchiveReceipt {
  pkHash: string; sourceHash: string; source: unknown; receiptHash: string
  receiptPk: unknown; transformedHash: string; targets: unknown
}

/** Runtime decoder for the immutable review.history.chunk.v1 archive format. */
export function decodeReviewArchive(rows: ReviewArchiveReceipt[], ref: ReviewArchiveReference): unknown {
  try {
    archiveAssert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.runId))
    archiveAssert(/^[1-9][0-9]{0,19}$/.test(ref.sourceId) && /^[a-f0-9]{64}$/.test(ref.bundleHash))
    archiveAssert(['trade_review_cases', 'manual_trade_review_cases', 'period_review_cases'].includes(ref.sourceTable))
    archiveAssert(ref.streamId === archiveHash({ sourceTable: ref.sourceTable, role: `review-history-case-${ref.sourceId}-chunks-v1` }))
    archiveAssert(rows.length > 0 && rows.length <= 256)
    const parts: Buffer[] = []
    let total = 0
    for (const [index, receipt] of rows.entries()) {
      const pk = [{ type: 'integer', value: String(index + 1) }], pkHash = archiveHash(pk)
      const targets = [{ table: 'data_migration_source_rows', pk: [
        { type: 'text', value: ref.runId }, { type: 'text', value: ref.streamId }, { type: 'text', value: pkHash },
      ] }]
      archiveAssert(receipt.pkHash === pkHash && archiveCanonical(archiveJson(receipt.receiptPk)) === archiveCanonical(pk))
      archiveAssert(receipt.sourceHash === receipt.receiptHash && archiveCanonical(archiveJson(receipt.targets)) === archiveCanonical(targets))
      archiveAssert(receipt.transformedHash === archiveHash({ stage: 'review_history_chunk_archived', targets }))
      const row = archiveJson(receipt.source) as Record<string, unknown>
      archiveAssert(row && Object.keys(row).sort().join('|') === ['id','schemaVersion','sourceTable','sourceId','bundleSha256','bundleBytes','chunkCount','chunkIndex','chunkBytes','chunkSha256','encoding','data'].sort().join('|'))
      archiveAssert(archiveHash(row) === receipt.sourceHash && row.schemaVersion === 'review.history.chunk.v1' && row.encoding === 'base64')
      archiveAssert(row.id === String(index + 1) && row.chunkIndex === index && row.chunkCount === rows.length)
      archiveAssert(row.sourceTable === ref.sourceTable && row.sourceId === ref.sourceId && row.bundleSha256 === ref.bundleHash)
      archiveAssert(typeof row.bundleBytes === 'number' && Number.isSafeInteger(row.bundleBytes) && row.bundleBytes > 0 && row.bundleBytes <= 64 * 1024 * 1024)
      if (index === 0) total = row.bundleBytes
      archiveAssert(total === row.bundleBytes && typeof row.data === 'string' && row.data.length <= 349528)
      const bytes = Buffer.from(row.data, 'base64')
      archiveAssert(bytes.toString('base64') === row.data && bytes.length > 0 && bytes.length <= 262144)
      archiveAssert(bytes.length === row.chunkBytes && sha(bytes) === row.chunkSha256)
      if (index < rows.length - 1) archiveAssert(bytes.length === 262144)
      parts.push(bytes)
    }
    const bytes = Buffer.concat(parts)
    archiveAssert(bytes.length === total && sha(bytes) === ref.bundleHash)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), bundle = JSON.parse(text)
    archiveAssert(archiveCanonical(bundle) === text && bundle.table === ref.sourceTable && bundle.id === ref.sourceId)
    archiveAssert(Array.isArray(bundle.rows?.[ref.sourceTable]) && bundle.rows[ref.sourceTable].length === 1 && bundle.rows[ref.sourceTable][0].id === ref.sourceId)
    return bundle
  } catch { throw archiveInvalid() }
}
