import Fastify from 'fastify'
import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createReviewHttp } from '../src/modules/reviews/composition.js'
import { ReviewService } from '../src/modules/reviews/application/review-service.js'
import { MysqlReviewRepository } from '../src/modules/reviews/infrastructure/mysql-review-repository.js'
import { reviewResultRow } from './review-result-fixture.js'

it('preserves original body/CAS through HTTP, replays once and rechecks current ownership', async () => {
  let receipt: Record<string, unknown> | undefined
  let revision = 1
  let owned = true
  let writes = 0
  let events = 0
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
    execute: async (sql: string, values: unknown[]) => {
      if (sql.includes('FROM users')) return [[{ id: 7 }]]
      if (sql.includes('FROM review_write_receipts_v4')) return [receipt && values[1] === 'review-return-0001' ? [receipt] : []]
      if (sql.startsWith('SELECT trading_account_id')) return [[{ trading_account_id: 'account-1' }]]
      if (sql.includes('FROM trading_account_ownerships')) {
        expect(sql).toContain('SELECT user_id')
        expect(values).toEqual(['account-1', 7])
        return [owned ? [{ user_id: 7 }] : []]
      }
      if (sql.startsWith('SELECT revision,status')) return [[{ revision, status: 'awaiting_confirmation', current_version_id: 'v1' }]]
      if (sql.startsWith('UPDATE review_cases_v4')) { revision++; writes++; expect(values[0]).toBe('More evidence'); return [{ affectedRows: 1 }] }
      if (sql.startsWith('INSERT INTO outbox_events')) { events++; return [{ affectedRows: 1 }] }
      if (sql.startsWith('SELECT c.id')) return [[{ ...reviewResultRow, revision }]]
      if (sql.startsWith('SELECT source_kind') || sql.startsWith('SELECT id,generation')) return [[]]
      if (sql.startsWith('INSERT INTO review_write_receipts_v4')) {
        receipt = { action: values[2], request_sha256: values[3], resource_id: values[4], result_revision: String(values[5]), result_json: values[6], result_sha256: values[7] }
        return [{ affectedRows: 1 }]
      }
      throw new Error('unexpected SQL')
    },
  }
  const pool = { getConnection: async () => connection } as unknown as Pool
  const service = new ReviewService(new MysqlReviewRepository(pool))
  const app = Fastify()
  const authenticate = async () => ({ userId: 7 })
  await app.register(createReviewHttp(service, { authenticate, assertWrite: authenticate }))
  const headers = { 'if-match': '"1"', 'x-csrf-token': 'c'.repeat(32), 'idempotency-key': 'review-return-0001' }
  const send = (reason: string, requestHeaders = headers) => app.inject({ method: 'POST', url: '/api/v4/review-cases/case-1/return', headers: requestHeaders, payload: { reason } })
  try {
    const first = await send(' More evidence ')
    expect(first.statusCode, first.body).toBe(200)
    expect(first.headers.etag).toBe('"2"')
    revision = 8
    const replay = await send(' More evidence ')
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json().data).toEqual(first.json().data)
    expect(replay.headers.etag).toBe('"2"')
    expect(writes).toBe(1)
    expect(events).toBe(1)
    const conflict = await send('More evidence')
    expect(conflict.statusCode, conflict.body).toBe(409)
    expect(conflict.json().code).toBe('review_idempotency_conflict')
    const changedCas = await send(' More evidence ', { ...headers, 'if-match': '"8"' })
    expect(changedCas.statusCode).toBe(409)
    owned = false
    const deniedReplay = await send(' More evidence ')
    expect(deniedReplay.statusCode, deniedReplay.body).toBe(404)
    expect(deniedReplay.json().data).toBeUndefined()
    const deniedNew = await send('More evidence', { ...headers, 'idempotency-key': 'review-return-0002' })
    expect(deniedNew.statusCode).toBe(404)
    expect(writes).toBe(1)
    expect(events).toBe(1)
    const missingKey = await send('More evidence', { ...headers, 'idempotency-key': '' })
    expect(missingKey.statusCode).toBe(400)
  } finally { await app.close() }
})
