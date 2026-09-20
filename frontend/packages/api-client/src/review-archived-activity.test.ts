import { archivedReviewEventsResponseSchema } from '@aurum/contracts'
import { expect, it, vi } from 'vitest'
import { createApiClient } from './index'
it('encodes historical activity routes and strictly decodes source status and pagination', async () => {
  const meta = { request_id: 'test', generated_at: '2026-09-11T00:00:00.000Z' }
  const bodies = [
    { items: [{ id: 'period_review_jobs:1', source_table: 'period_review_jobs', source_id: '1', original_status: 'running', stage: null,
      attempts: 1, error_code: null, created_at: meta.generated_at, updated_at: meta.generated_at, completed_at: null }], total: 2, next_offset: 1 },
    { items: [{ id: 'event:1', job_id: 'period_review_jobs:1', stage: null, original_status: 'done', message_code: null, occurred_at: meta.generated_at }], total: 1, next_offset: null },
    { items: [{ id: 'stage:1', job_id: 'manual_trade_review_jobs:1', generation: 1, stage: 'analysis', original_status: 'done',
      input_hash: null, output_hash: null, has_output: false, error_code: null, created_at: meta.generated_at, completed_at: null }], total: 1, next_offset: null },
  ]
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: bodies.shift(), meta }), { status: 200 }))
  const client = createApiClient({ fetchImpl })
  expect((await client.listArchivedReviewJobs('c/1', { pageSize: 1, offset: 0 })).data).toMatchObject({ nextOffset: 1, items: [{ originalStatus: 'running' }] })
  expect((await client.listArchivedReviewEvents('c/1')).data.items[0]).toMatchObject({ jobId: 'period_review_jobs:1' })
  expect((await client.listArchivedReviewStages('c/1')).data.items[0]).toMatchObject({ hasOutput: false })
  expect(fetchImpl.mock.calls.map(c => c[0])).toEqual(['/api/v4/review-cases/c%2F1/history/jobs?page_size=1&offset=0', '/api/v4/review-cases/c%2F1/history/events', '/api/v4/review-cases/c%2F1/history/stages'])
})

it('rejects missing original status, invalid UTC and excess internal fields', () => {
  const meta = { request_id: 'test', generated_at: '2026-09-11T00:00:00.000Z' }
  const row = { id: 'event:1', job_id: 'job:1', stage: null, original_status: 'done', message_code: null, occurred_at: meta.generated_at }
  for (const item of [{ ...row, original_status: undefined }, { ...row, occurred_at: '2026-09-11 00:00:00' }, { ...row, frozen_runtime_json: 'private' }]) {
    expect(archivedReviewEventsResponseSchema.safeParse({ data: { items: [item], total: 1, next_offset: null }, meta }).success).toBe(false)
  }
})
