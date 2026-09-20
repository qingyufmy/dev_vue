import { createReviewWriteCommand } from '../src/modules/reviews/application/review-write-command.js'
import { reviewResultRow } from './review-result-fixture.js'
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlReviewRepository } from '../src/modules/reviews/infrastructure/mysql-review-repository.js'

describe('review case lock projection', () => {
  it('binds pagination as integer text for the deployed mysql2 prepared-statement protocol', async () => {
    const execute = vi.fn(async () => [[]])
    const repository = new MysqlReviewRepository({ execute } as unknown as Pool)
    expect(await repository.listCases(7, { tradingAccountId: '9007199254740993', limit: 10 })).toEqual([])
    expect(execute.mock.calls[0]).toEqual([expect.stringContaining('LIMIT ?'), [7, '9007199254740993', '10']])
    expect(await repository.listManualCandidates(7, '9007199254740993', 20)).toEqual([])
    expect(execute.mock.calls[1]).toEqual([expect.stringContaining('LIMIT ?'), [7, '9007199254740993', '20']])
  })
  it.each([
    { rows: [], error: 'review_case_not_found' },
    { rows: [{ revision: 2, status: 'awaiting_confirmation', current_version_id: 'v1' }], error: 'review_revision_conflict' },
    { rows: [{ revision: 1, status: 'confirmed', current_version_id: 'v1' }], error: 'review_version_not_found' },
  ])('retains scope and rejects $error before any mutation', async ({ rows, error }) => {
    const connection = { beginTransaction: vi.fn(), rollback: vi.fn(), commit: vi.fn(), release: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('FROM review_write_receipts_v4')) return [[]]
        if (sql.includes('FROM users') || sql.includes('FROM trading_account_ownerships')) return [[{ user_id: 7 }]]
        if (sql.startsWith('SELECT trading_account_id')) return [rows.length ? [{ trading_account_id: 'account-1' }] : []]
        return [rows]
      }) }
    const repository = new MysqlReviewRepository({ getConnection: async () => connection } as unknown as Pool)
    await expect(repository.returnCase({ command: createReviewWriteCommand({ actorUserId: 7, action: 'return_case', targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-return-0001' }, { reason: 'More evidence' }), userId: 7, caseId: 'case-1', expectedRevision: 1, reason: '补充证据', now: '2026-09-07T00:00:00.000Z' })).rejects.toThrow(error)
    expect(connection.execute.mock.calls.some(([sql]) => /^(UPDATE|INSERT)/.test(sql))).toBe(false)
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining('WHERE id=? AND user_id=? FOR UPDATE'), ['case-1', 7])
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
  })
})

 it.each(['commit', 'rollback'] as const)('destroys the connection after %s uncertainty', async phase => {
  const connection = { beginTransaction: vi.fn(), rollback: vi.fn(), commit: vi.fn(), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string) => sql.includes('FROM review_write_receipts_v4') ? [[]]
      : sql.includes('FROM users') || sql.includes('FROM trading_account_ownerships') ? [[{ user_id: 7 }]]
      : sql.startsWith('SELECT trading_account_id') ? [[{ trading_account_id: 'account-1' }]]
      : sql.startsWith('SELECT c.id')
      ? [[reviewResultRow]]
      : sql.startsWith('SELECT source_kind') || sql.startsWith('SELECT id,generation') ? [[]]
      : sql.startsWith('SELECT')
      ? [[{ revision: phase === 'rollback' ? 2 : 1, status: 'awaiting_confirmation', current_version_id: 'v1' }]]
      : [{ affectedRows: 1 }]) }
  connection[phase].mockRejectedValue(new Error('connection_lost'))
  const execute = vi.fn()
  const repository = new MysqlReviewRepository({ getConnection: async () => connection, execute } as unknown as Pool)
  await expect(repository.returnCase({ command: createReviewWriteCommand({ actorUserId: 7, action: 'return_case', targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-return-0001' }, { reason: 'More evidence' }), userId: 7, caseId: 'case-1', expectedRevision: 1, reason: 'more evidence', now: '2026-09-09T00:00:00.000Z' }))
    .rejects.toThrow(phase === 'commit' ? 'review_commit_unknown' : 'review_revision_conflict')
  expect(connection.destroy).toHaveBeenCalledOnce()
  expect(connection.release).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  if (phase === 'commit') expect(connection.rollback).not.toHaveBeenCalled()
  else expect(connection.commit).not.toHaveBeenCalled()
 })
