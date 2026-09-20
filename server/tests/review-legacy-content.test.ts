import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { assertLegacyReviewContent } from '../src/modules/reviews/domain/legacy-review-content.js'
import { assertReviewContent } from '../src/modules/reviews/domain/review.js'
import { authorizeReviewCaseWrite } from '../src/modules/reviews/infrastructure/mysql-review-case-write.js'
import { reviewVersionSchema } from '../../frontend/packages/contracts/src/index.js'

const rawText = ' {"原文":"保留空格与换行"}\r\n'
const content = { schemaVersion: 'review.legacy.v1', sourceTable: 'period_review_versions', sourceId: '1',
  sourceSha256: createHash('sha256').update(rawText).digest('hex'), originalContentHash: null, rawText }
it('preserves exact raw bytes and rejects tampering, extra inferred fields and modern writes', () => {
  expect(() => assertLegacyReviewContent(content)).not.toThrow()
  expect(() => assertLegacyReviewContent({ ...content, rawText: rawText.trim() })).toThrow('review_legacy_content_invalid')
  expect(() => assertLegacyReviewContent({ ...content, conclusion: 'mixed' })).toThrow('review_legacy_content_invalid')
  expect(() => assertReviewContent(content)).toThrow()
})
it('consumer accepts a null legacy conclusion and rejects a manufactured modern conclusion', () => {
  const version = { id: 'v1', review_case_id: 'c1', version: 1, author_kind: 'ai', conclusion: null,
    created_at: '2026-09-11T00:00:00.000Z', content: { schema_version: content.schemaVersion,
      source_table: content.sourceTable, source_id: content.sourceId, source_sha256: content.sourceSha256,
      original_content_hash: null, raw_text: rawText } }
  expect(reviewVersionSchema.parse(version).content).toEqual(content)
  expect(reviewVersionSchema.safeParse({ ...version, conclusion: 'mixed' }).success).toBe(false)
})
it('blocks imported case mutations after ownership validation using only reads', async () => {
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT trading_account_id')) return [[{ trading_account_id: 'a1', legacy_source_table: 'period_review_cases' }]]
    if (sql.includes('FROM trading_account_ownerships')) return [[{ user_id: 7 }]]
    throw new Error('unexpected mutation')
  })
  await expect(authorizeReviewCaseWrite({ execute } as unknown as PoolConnection, 7, 'c1')).rejects.toThrow('review_legacy_version_readonly')
  expect(execute).toHaveBeenCalledTimes(2)
})
