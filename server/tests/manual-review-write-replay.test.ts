import { reviewEvidenceHash } from '../src/modules/reviews/infrastructure/review-evidence-integrity.js'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { ReviewService } from '../src/modules/reviews/application/review-service.js'
import { MysqlReviewRepository } from '../src/modules/reviews/infrastructure/mysql-review-repository.js'
import { reviewResultRow } from './review-result-fixture.js'

const frozenEvidence = { schema_version: 'manual-candidate-evidence.v4.1', authority: { fixture: true }, trade: {
  status: 'ready_as_of', taskId: 'task', receiptId: 'receipt', completionHash: 'c'.repeat(64), asOfUtcMsc: Date.parse('2026-09-08T14:00:00.000Z'),
  evidence: { source: 'manual', userId: 7, accountId: 'account-1', recordId: 'record', revision: 1, facts: [{ fixture: true }],
    openedAt: '2026-09-08T12:00:00.000Z', closedAt: '2026-09-08T13:00:00.000Z', terminalTimezoneOffsetMinutes: 180,
    projection: { primaryTicket: '123', positionId: null, symbol: 'XAUUSD', side: 'buy', volumeOpened: '0.01', netProfit: '1' } } } }
const token = 'private-selection-token-0001'
const request = { candidateIds: ['candidate-1'], selectionTokens: [token], strategyId: 'strategy-1', idempotencyKey: 'manual-review-0001' }
function fixture(fault = '') {
  let now = new Date('2026-09-09T00:00:00.000Z')
  let owned = true
  let caseId = 'legacy-case-1'
  let receipt: Record<string, unknown> | undefined
  let staged: Record<string, unknown> | undefined
  let candidatesRead = 0
  let casesCreated = 0
  let jobsCreated = 0
  let outbox = 0
  let acknowledgementLost = false
  const connection = {
    beginTransaction: vi.fn(async () => { staged = undefined }),
    commit: vi.fn(async () => { if (staged) receipt = staged; if (fault === 'commit' && !acknowledgementLost) { acknowledgementLost = true; throw new Error('ack_lost') } }),
    rollback: vi.fn(async () => { staged = undefined }), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('FROM users')) return [[{ id: 7 }]]
      if (sql.includes('FROM review_write_receipts_v4')) return [receipt && values[1] === request.idempotencyKey ? [receipt] : []]
      if (sql.startsWith('SELECT id FROM review_cases_v4')) return [fault === 'legacy' ? [{ id: caseId }] : []]
      if (sql.startsWith('SELECT trading_account_id')) return [[{ trading_account_id: 'account-1' }]]
      if (sql.includes('FROM trading_account_ownerships')) return [owned ? [{ user_id: 7 }] : []]
      if (sql.includes('FROM manual_review_candidates_v4')) {
        candidatesRead++
        expect(sql).toContain('m.user_id=?')
        expect(values).toEqual([7, 7, 'candidate-1'])
        return [owned ? [{ id: 'candidate-1', trading_account_id: 'account-1', source_classification: 'manual', eligibility_status: 'eligible',
          selection_token_sha256: createHash('sha256').update(token).digest('hex'), selection_expires_at_utc: new Date('2026-09-09T00:01:00.000Z'),
          opened_at_utc: new Date('2026-09-08T12:00:00.000Z'), closed_at_utc: new Date('2026-09-08T13:00:00.000Z'),
          symbol: 'XAUUSD', side: 'buy', volume: '0.01', net_profit: '1.00', ticket: '123', position_id: null,
          terminal_timezone_offset_minutes: 180, revision: 1, evidence_sha256: reviewEvidenceHash(frozenEvidence) }] : []]
      }
      if (sql.includes('FROM manual_review_candidate_evidence_v4')) return [[{ evidence_json: frozenEvidence,
        evidence_sha256: reviewEvidenceHash(frozenEvidence), trade_record_id: 'record', trade_record_revision: 1, as_of_utc: '2026-09-08 14:00:00.000' }]]
      if (sql.includes('FROM strategies WHERE')) return [[{ kind: 'analysis', active_version_id: 'strategy-version-1' }]]
      if (sql.startsWith('INSERT INTO review_cases_v4')) { casesCreated++; caseId = String(values[0]); return [{ affectedRows: 1 }] }
      if (sql.startsWith('INSERT INTO review_jobs_v4')) jobsCreated++
      if (sql.startsWith('INSERT INTO outbox_events')) outbox++
      if (sql.startsWith('SELECT c.id')) {
        if (fault === 'read') throw new Error('result_read_failed')
        if (fault === 'missing') return [[]]
        return [[{ ...reviewResultRow, id: caseId, status: 'queued', revision: 1 }]]
      }
      if (sql.startsWith('SELECT source_kind') || sql.startsWith('SELECT id,generation')) return [[]]
      if (sql.startsWith('INSERT INTO review_write_receipts_v4')) {
        if (fault === 'receipt') throw new Error('receipt_insert_failed')
        expect(String(values[6])).not.toContain(token)
        staged = { action: values[2], request_sha256: values[3], resource_id: values[4], result_revision: String(values[5]), result_json: values[6], result_sha256: values[7] }
      }
      return [{ affectedRows: 1 }]
    }),
  }
  const service = new ReviewService(new MysqlReviewRepository({ getConnection: async () => connection } as unknown as Pool, () => ({ async verify() { if (fault === 'source') throw new Error('manual_review_source_changed') } })), () => now)
  return { service, connection, counts: () => ({ candidatesRead, casesCreated, jobsCreated, outbox }),
    revoke: () => { owned = false }, expire: () => { now = new Date('2026-09-10T00:00:00.000Z') } }
}
it('replays an expired selection without new case/job/outbox, rejects changed raw body and checks current ownership', async () => {
  const f = fixture()
  const first = await f.service.createManualCase(7, { ...request, userThesis: ' Original thesis ' })
  f.expire()
  expect(await f.service.createManualCase(7, { ...request, userThesis: ' Original thesis ' })).toEqual(first)
  expect(f.counts()).toEqual({ candidatesRead: 1, casesCreated: 1, jobsCreated: 1, outbox: 2 })
  for (const changed of [{ ...request, userThesis: 'Original thesis' }, { ...request, userThesis: null }, { ...request, userThesis: ' Original thesis ', strategyId: 'strategy-2' }]) {
    await expect(f.service.createManualCase(7, changed)).rejects.toThrow('review_idempotency_conflict')
  }
  f.revoke()
  await expect(f.service.createManualCase(7, { ...request, userThesis: ' Original thesis ' })).rejects.toThrow('review_case_not_found')
  await expect(f.service.createManualCase(7, { ...request, idempotencyKey: 'manual-review-0002' })).rejects.toThrow('manual_review_candidate_not_found')
  expect(f.counts().casesCreated).toBe(1)
})
it.each([['read', 'result_read_failed'], ['missing', 'review_write_result_missing'], ['receipt', 'receipt_insert_failed'], ['legacy', 'review_legacy_receipt_unavailable']])('%s fails before commit and preserves old data', async (fault, code) => {
  const f = fixture(fault)
  await expect(f.service.createManualCase(7, request)).rejects.toThrow(code)
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  if (fault === 'legacy') expect(f.counts()).toEqual({ candidatesRead: 0, casesCreated: 0, jobsCreated: 0, outbox: 0 })
  expect(f.connection.execute.mock.calls.some(([sql]) => /^(DELETE|DROP|TRUNCATE)/.test(sql))).toBe(false)
})
it('recovers the same creation after simulated commit acknowledgement loss', async () => {
  const f = fixture('commit')
  await expect(f.service.createManualCase(7, request)).rejects.toThrow('review_commit_unknown')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  f.expire()
  expect((await f.service.createManualCase(7, request)).summary.revision).toBe(1)
  expect(f.counts()).toEqual({ candidatesRead: 1, casesCreated: 1, jobsCreated: 1, outbox: 2 })
})

it('source revision rejection occurs before any case/job/outbox creation', async () => {
  const f = fixture('source')
  await expect(f.service.createManualCase(7, request)).rejects.toThrow('manual_review_source_changed')
  expect(f.counts()).toEqual({ candidatesRead: 1, casesCreated: 0, jobsCreated: 0, outbox: 0 })
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
