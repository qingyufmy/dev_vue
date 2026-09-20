import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { ReviewService } from '../src/modules/reviews/application/review-service.js'
import { MysqlReviewRepository } from '../src/modules/reviews/infrastructure/mysql-review-repository.js'
import { reviewContentFromWire } from '../src/modules/reviews/domain/review.js'
import { reviewResultRow } from './review-result-fixture.js'

const wire = {
  schema_version: 'review.v4.1', conclusion: 'mixed', headline: 'Review', summary: 'Evidence',
  metrics: { net_profit: '0', trade_count: 0, win_rate_percent: null, profit_factor: null }, trade_episodes: [],
  roles: Object.fromEntries(['analyst', 'trader', 'risk', 'execution'].map(role => [role, { assessment: 'effective', summary: 'Evidence', evidence_refs: [] }])),
  counterexamples: [], memory_candidates: [], evidence_refs: [], full_analysis_text: 'Evidence',
}
const key = 'review-case-operation-0001'
const cases = [
  { name: 'generation', status: 'queued', run: (s: ReviewService) => s.requestGeneration(7, 'case-1', 1, 'retry', key), change: (s: ReviewService) => s.requestGeneration(7, 'case-1', 1, 'refresh_evidence', key) },
  { name: 'version', status: 'awaiting_confirmation', run: (s: ReviewService) => s.createVersion(7, 'case-1', 1, wire, key), change: (s: ReviewService) => s.createVersion(7, 'case-1', 1, { ...wire, headline: 'Changed' }, key) },
  { name: 'confirmation', status: 'confirmed', run: (s: ReviewService) => s.confirm(7, 'case-1', 'v1', 1, key), change: (s: ReviewService) => s.confirm(7, 'case-1', 'v2', 1, key) },
]
it.each(cases)('$name replays original results without repeating business writes or fresh CAS', async ({ status, run, change }) => {
  let receipt: Record<string, unknown> | undefined
  let revision = 1
  let owned = true
  let mutations = 0
  let caseLocks = 0
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
    execute: async (sql: string, values: unknown[]) => {
      if (sql.includes('FROM users')) return [[{ id: 7 }]]
      if (sql.includes('FROM review_write_receipts_v4')) return [receipt ? [receipt] : []]
      if (sql.startsWith('SELECT trading_account_id')) return [[{ trading_account_id: 'account-1' }]]
      if (sql.includes('FROM trading_account_ownerships')) return [owned ? [{ user_id: 7 }] : []]
      if (sql.startsWith('SELECT revision,status')) { caseLocks++; return [[{ revision, status: 'awaiting_confirmation', evidence_status: 'complete', evidence_sha256: 'a'.repeat(64), evidence_revision: 1, current_version_id: 'v1' }]] }
      if (sql.startsWith('SELECT c.id')) return [[{ ...reviewResultRow, revision, status }]]
      if (sql.startsWith('SELECT v.id')) return [[{ id: 'v1', content_json: reviewContentFromWire(wire), full_analysis_text: 'Evidence' }]]
      if (sql.startsWith('SELECT')) return [[]]
      if (sql.startsWith('INSERT INTO review_write_receipts_v4')) {
        receipt = { action: values[2], request_sha256: values[3], resource_id: values[4], result_revision: String(values[5]), result_json: values[6], result_sha256: values[7] }
        return [{ affectedRows: 1 }]
      }
      mutations++
      if (sql.startsWith('UPDATE review_cases_v4')) revision++
      return [{ affectedRows: 1 }]
    },
  }
  const service = new ReviewService(new MysqlReviewRepository({ getConnection: async () => connection } as unknown as Pool))
  const first = await run(service)
  expect(first.summary).toMatchObject({ revision: 2, status })
  const count = mutations
  expect(count).toBeGreaterThan(0)
  revision = 20
  expect(await run(service)).toEqual(first)
  expect(caseLocks).toBe(1)
  expect(mutations).toBe(count)
  await expect(change(service)).rejects.toThrow('review_idempotency_conflict')
  owned = false
  await expect(run(service)).rejects.toThrow('review_case_not_found')
  expect(mutations).toBe(count)
})
