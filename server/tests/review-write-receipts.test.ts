import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createReviewWriteCommand, reviewWriteActions } from '../src/modules/reviews/application/review-write-command.js'
import { executeReviewWrite, type ReviewWriteResult } from '../src/modules/reviews/infrastructure/mysql-review-write-receipts.js'
import { ReviewError } from '../src/modules/reviews/domain/review.js'

const result = { resourceId: 'case-1', revision: 2, value: { status: 'confirmed' } }
const validate = (input: unknown): input is ReviewWriteResult<{ status: string }> => {
  if (!input || typeof input !== 'object') return false
  const value = input as typeof result
  return typeof value.resourceId === 'string' && typeof value.revision === 'number' && typeof value.value?.status === 'string'
}
function fixture() {
  let receipt: Record<string, unknown> | undefined
  let staged: Record<string, unknown> | undefined
  let effects = 0
  let pendingEffects = 0
  let loseCommit = false
  let failInsert = false
  const connection = {
    beginTransaction: vi.fn(async () => { staged = undefined; pendingEffects = 0 }),
    commit: vi.fn(async () => { if (staged) receipt = staged; effects += pendingEffects; if (loseCommit) { loseCommit = false; throw new Error('ack_lost') } }),
    rollback: vi.fn(async () => { staged = undefined; pendingEffects = 0 }), release: vi.fn(), destroy: vi.fn(),
    execute: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }]]
      if (sql.includes('FROM review_write_receipts_v4')) return [receipt ? [receipt] : []]
      if (sql.startsWith('INSERT INTO review_write_receipts_v4')) {
        if (failInsert) throw new Error('receipt_write_failed')
        staged = { action: values[2], request_sha256: values[3], resource_id: values[4], result_revision: String(values[5]), result_json: values[6], result_sha256: values[7] }
        return [{ affectedRows: 1 }]
      }
      throw new Error('unexpected SQL')
    }),
  }
  const work = vi.fn(async () => { pendingEffects++; return structuredClone(result) })
  const authorize = vi.fn(async (_connection: unknown, _resource: string | null) => {})
  return { connection, pool: { getConnection: async () => connection } as unknown as Pool, work, authorize,
    effects: () => effects, receipt: () => receipt!, loseCommit: () => { loseCommit = true }, failInsert: () => { failInsert = true } }
}
const command = (action: typeof reviewWriteActions[number] = 'return_case', body: unknown = { reason: 'original' }) => createReviewWriteCommand({
  actorUserId: 7, idempotencyKey: 'review-command-0001', action,
  targetId: action === 'create_manual_case' ? null : 'case-1', expectedRevision: action === 'create_manual_case' ? null : 1,
}, body)

it.each(reviewWriteActions)('%s persists and replays the original result without calling fresh work', async action => {
  const f = fixture(); const cmd = command(action)
  expect(await executeReviewWrite(f.pool, cmd, f.work, validate, f.authorize)).toEqual(result)
  f.work.mockRejectedValueOnce(new Error('fresh_CAS_would_fail'))
  expect(await executeReviewWrite(f.pool, cmd, f.work, validate, f.authorize)).toEqual(result)
  expect(f.work).toHaveBeenCalledOnce()
  expect(f.effects()).toBe(1)
  expect(f.authorize.mock.calls.map(call => call[1])).toEqual([null, 'case-1'])
})
it('rejects changed body and action without running the mutation again', async () => {
  const f = fixture()
  await executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)
  for (const cmd of [command('return_case', { reason: 'changed' }), command('confirm_version')]) {
    await expect(executeReviewWrite(f.pool, cmd, f.work, validate, f.authorize)).rejects.toThrow('review_idempotency_conflict')
  }
  expect(f.effects()).toBe(1)
  expect(f.work).toHaveBeenCalledOnce()
})
it('checks current authorization on replay and does not expose the stored result after revocation', async () => {
  const f = fixture()
  await executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)
  f.authorize.mockRejectedValueOnce(new ReviewError('review_case_not_found', 404))
  await expect(executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)).rejects.toThrow('review_case_not_found')
  expect(f.work).toHaveBeenCalledOnce()
})
it.each(['result_sha256', 'resource_id', 'result_revision', 'result_json'])('rejects a corrupt %s instead of repeating work', async field => {
  const f = fixture()
  await executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)
  f.receipt()[field] = 'corrupt'
  await expect(executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)).rejects.toThrow('review_receipt_invalid')
  expect(f.work).toHaveBeenCalledOnce()
})
it('rolls back the business effect if the receipt insert fails', async () => {
  const f = fixture(); f.failInsert()
  await expect(executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)).rejects.toThrow('receipt_write_failed')
  expect(f.effects()).toBe(0)
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.connection.rollback).toHaveBeenCalledOnce()
})
it('replays after a simulated committed transaction loses its acknowledgement', async () => {
  const f = fixture(); f.loseCommit()
  await expect(executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)).rejects.toThrow('review_commit_unknown')
  expect(f.connection.destroy).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.connection.release).not.toHaveBeenCalled()
  expect(await executeReviewWrite(f.pool, command(), f.work, validate, f.authorize)).toEqual(result)
  expect(f.effects()).toBe(1)
  expect(f.work).toHaveBeenCalledOnce()
})
