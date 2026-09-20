import { expect, it, vi } from 'vitest'
import { createApiClient } from './index'
it('encodes case/version IDs and decodes paginated history, original text and metadata', async () => {
  const meta = { request_id: 'test', generated_at: '2026-09-11T00:00:00.000Z' }
  const summary = { id: 'v/1', review_case_id: 'c/1', version: 2, author_kind: 'ai', conclusion: null, created_at: meta.generated_at }
  const bodies = [{ data: { items: [summary], next_before_version: 2 }, meta },
    { data: { ...summary, content: { schema_version: 'review.legacy.v1', source_table: 'period_review_versions', source_id: '1',
      source_sha256: 'a'.repeat(64), original_content_hash: null, raw_text: ' 原文\r\n' } }, meta },
    { data: { review_case_id: 'c/1', source_table: 'period_review_cases', source_id: '1', source_status: 'approved',
      source_evidence_status: 'complete', source_strategy_id: '3', source_strategy_version: '10', timezone_source: 'legacy_case' }, meta }]
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }))
  const client = createApiClient({ fetchImpl })
  expect((await client.listReviewVersions('c/1', { pageSize: 1, beforeVersion: 3 })).data).toMatchObject({ nextBeforeVersion: 2, items: [{ versionNumber: 2 }] })
  expect((await client.getReviewVersion('c/1', 'v/1')).data.content).toMatchObject({ rawText: ' 原文\r\n' })
  expect((await client.getReviewHistoricalMetadata('c/1')).data).toMatchObject({ sourceStatus: 'approved', sourceStrategyVersion: '10' })
  expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(['/api/v4/review-cases/c%2F1/versions?page_size=1&before_version=3', '/api/v4/review-cases/c%2F1/versions/v%2F1', '/api/v4/review-cases/c%2F1/history'])
})
