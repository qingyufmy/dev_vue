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
      execute: vi.fn(async () => [rows]) }
    const repository = new MysqlReviewRepository({ getConnection: async () => connection } as unknown as Pool)
    await expect(repository.returnCase({ userId: 7, caseId: 'case-1', expectedRevision: 1, reason: '补充证据', now: '2026-09-07T00:00:00.000Z' })).rejects.toThrow(error)
    expect(connection.execute).toHaveBeenCalledOnce()
    expect(connection.execute.mock.calls[0]).toEqual([expect.stringContaining('WHERE id=? AND user_id=? FOR UPDATE'), ['case-1', 7]])
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
  })
})
