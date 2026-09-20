import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlRiskReviewSettlement } from '../src/modules/inference/infrastructure/mysql-risk-review-settlement.js'

function fixture(affectedRows: number) {
  const db = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ affectedRows }]) }
  return { db, settle: createMysqlRiskReviewSettlement({ getConnection: async () => db } as unknown as Pool) }
}

it('expires only an unreviewed proposal and releases its unused entry reservation atomically', async () => {
  const { db, settle } = fixture(1)
  await settle('d1', 'risk_review_market_context_incomplete')
  expect(db.execute.mock.calls[0]![0]).toContain("status='proposed' AND risk_decision_id IS NULL")
  expect(db.execute.mock.calls[1]![0]).toContain("state='reserved' AND risk_decision_id IS NULL")
  expect(JSON.parse(db.execute.mock.calls[2]![1][2])).toMatchObject({ decision_id: 'd1', status: 'stale' })
  expect(db.commit).toHaveBeenCalledOnce()
})

it('does not release claims or publish duplicate events after concurrent completion', async () => {
  const { db, settle } = fixture(0)
  await settle('d1', 'risk_review_market_context_incomplete')
  expect(db.execute).toHaveBeenCalledTimes(1)
})

it('rolls back decision status if the durable notification fails', async () => {
  const { db, settle } = fixture(1)
  db.execute.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{ affectedRows: 1 }]).mockRejectedValueOnce(new Error('outbox_failed'))
  await expect(settle('d1', 'risk_review_market_context_incomplete')).rejects.toThrow('outbox_failed')
  expect(db.commit).not.toHaveBeenCalled()
  expect(db.rollback).toHaveBeenCalledOnce()
  expect(db.release).toHaveBeenCalledOnce()
})
