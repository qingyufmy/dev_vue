import { createReviewWriteCommand } from '../src/modules/reviews/application/review-write-command.js'
import { reviewResultRow } from './review-result-fixture.js'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlReviewRepository } from '../src/modules/reviews/infrastructure/mysql-review-repository.js'
import type { ReviewContent } from '../src/modules/reviews/domain/review.js'

const now = new Date('2026-09-09T00:00:00.000Z')
const content: ReviewContent = {
  schemaVersion: 'review.v4.1', conclusion: 'mixed', headline: 'Review', summary: 'Evidence',
  metrics: { netProfit: '0', tradeCount: 0, winRatePercent: null, profitFactor: null }, tradeEpisodes: [],
  roles: { analyst: { assessment: 'effective', summary: 'Evidence', evidenceRefs: [] }, trader: { assessment: 'effective', summary: 'Evidence', evidenceRefs: [] }, risk: { assessment: 'effective', summary: 'Evidence', evidenceRefs: [] }, execution: { assessment: 'effective', summary: 'Evidence', evidenceRefs: [] } },
  counterexamples: [], memoryCandidates: [], evidenceRefs: [], fullAnalysisText: 'Evidence',
}
const input = { userId: 7, caseId: 'case-1', expectedRevision: 1, now: now.toISOString() }
const actions = [
  { name: 'generation', run: (r: MysqlReviewRepository) => r.requestGeneration({ ...input, command: createReviewWriteCommand({ actorUserId: 7, action: 'request_generation', targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-case-write-0001' }, {}), mode: 'retry' }) },
  { name: 'version', run: (r: MysqlReviewRepository) => r.createUserVersion({ ...input, command: createReviewWriteCommand({ actorUserId: 7, action: 'create_version', targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-case-write-0001' }, {}), content }) },
  { name: 'confirmation', run: (r: MysqlReviewRepository) => r.confirmVersion({ ...input, command: createReviewWriteCommand({ actorUserId: 7, action: 'confirm_version', targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-case-write-0001' }, {}), versionId: 'v1' }) },
  { name: 'return', run: (r: MysqlReviewRepository) => r.returnCase({ ...input, command: createReviewWriteCommand({ actorUserId: 7, action: 'return_case', targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-return-0001' }, { reason: 'More evidence' }), reason: 'More evidence' }) },
  { name: 'memory rejection', run: (r: MysqlReviewRepository) => r.decideMemoryUpdate({ ...input, command: createReviewWriteCommand({ actorUserId: 7, action: 'decide_memory_update', targetId: 'update-1', expectedRevision: 1, idempotencyKey: 'memory-decision-0001' }, { decision: 'reject' }), updateId: 'update-1', decision: 'reject' }) },
]

it.each(actions.flatMap(action => ['success', 'read failure', 'missing result'].map(mode => ({ ...action, mode }))))('$name $mode reads on the transaction connection before commit', async ({ run, name, mode }) => {
  const events: string[] = []
  const failure = new Error('read_failed')
  const connection = {
    beginTransaction: vi.fn(async () => { events.push('begin') }),
    commit: vi.fn(async () => { events.push('commit') }),
    rollback: vi.fn(async () => { events.push('rollback') }), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT c.id') || sql.includes('u.id=? AND u.library_id=? LIMIT 1')) {
        events.push('result')
        if (mode === 'read failure') throw failure
        if (mode === 'missing result') return [[]]
        if (name === 'memory rejection') {
          expect(values).toEqual(['update-1', 'library-1'])
          return [[{ id: 'update-1', library_id: 'library-1', source_review_case_id: 'case-1', source_review_version_id: 'v1', update_kind: 'short_term', diff_preview_text: 'text', status: 'rejected', revision: 2, expected_library_revision: 1, proposal_json: { memory_key: 'key', title: 'title', content: 'text', evidence_refs: [] }, conflict_json: [], created_at_utc: now }]]
        }
        expect(values).toEqual([7, 'case-1'])
        return [[{ ...reviewResultRow, status: name === 'generation' ? 'queued' : name === 'version' ? 'awaiting_confirmation' : name === 'confirmation' ? 'confirmed' : 'needs_changes' }]]
      }
      if (sql.startsWith('SELECT u.library_id')) return [[{ library_id: 'library-1' }]]
      if (sql.includes('FROM users') || sql.includes('FROM trading_account_ownerships')) return [[{ user_id: 7 }]]
      if (sql.startsWith('SELECT trading_account_id')) return [[{ trading_account_id: 'account-1' }]]
      if (sql.startsWith('SELECT revision,status')) return [[{ revision: 1, status: 'awaiting_confirmation', evidence_status: 'complete', evidence_sha256: 'hash', evidence_revision: 1, current_version_id: 'v1' }]]
      if (sql.startsWith('SELECT id FROM review_cases_v4')) return [[{ id: 'case-1' }]]
      if (sql.startsWith('SELECT v.id')) return [[{ id: 'v1', content_json: content, full_analysis_text: content.fullAnalysisText }]]
      if (sql.includes('l.owner_user_id,l.revision')) return [[{ id: 'update-1', library_id: 'library-1', owner_user_id: 7, revision: 1, status: 'awaiting_confirmation', library_revision: 1 }]]
      if (sql.startsWith('SELECT')) return [[]]
      events.push('write')
      return [{ affectedRows: 1 }]
    }),
  }
  const poolExecute = vi.fn(async () => { throw new Error('pool_read_forbidden') })
  const repository = new MysqlReviewRepository({ getConnection: async () => connection, execute: poolExecute } as unknown as Pool)
  if (mode === 'success') {
    await expect(run(repository)).resolves.toBeTruthy()
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(events.indexOf('result')).toBeLessThan(events.indexOf('commit'))
    expect(connection.rollback).not.toHaveBeenCalled()
  } else {
    await expect(run(repository)).rejects.toThrow(mode === 'read failure' ? failure : 'review_write_result_missing')
    expect(connection.commit).not.toHaveBeenCalled()
    expect(connection.rollback).toHaveBeenCalledOnce()
  }
  expect(poolExecute).not.toHaveBeenCalled()
  expect(connection.release).toHaveBeenCalledOnce()
})
