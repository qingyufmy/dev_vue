import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRun = vi.fn()
const mockQueryRun = vi.fn()
const mockProcessReferralCommission = vi.fn()

vi.mock('../server/db.js', () => ({
  queryRun: (...args) => mockQueryRun(...args),
  withTransaction: async fn => fn(mockRun),
}))

vi.mock('../server/utils.js', () => ({
  processReferralCommission: (...args) => mockProcessReferralCommission(...args),
}))

import {
  claimPaymentSideEffect,
  completePaymentSideEffect,
  enqueuePaymentSideEffect,
  retryPaymentSideEffect,
} from '../server/jobs/payment-side-effects.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('enqueuePaymentSideEffect', () => {
  it('uses an order-level upsert on the caller transaction', async () => {
    mockRun.mockResolvedValue([{ affectedRows:1 }])
    await enqueuePaymentSideEffect(mockRun, { orderId:'order-1', userId:7 })
    expect(mockRun).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO payment_side_effects[\s\S]*ON DUPLICATE KEY UPDATE/),
      ['order-1', 7],
    )
  })

  it('rejects malformed queue records', async () => {
    await expect(enqueuePaymentSideEffect(mockRun, { orderId:'', userId:0 }))
      .rejects.toThrow('invalid_payment_side_effect')
  })
})

describe('claimPaymentSideEffect', () => {
  it('locks and claims one ready or stale record', async () => {
    mockRun
      .mockResolvedValueOnce([[{ id:3, order_id:'order-3', user_id:9, attempt_count:1 }]])
      .mockResolvedValueOnce([{ affectedRows:1 }])
    await expect(claimPaymentSideEffect()).resolves.toMatchObject({
      id:3, order_id:'order-3', user_id:9, attempt_count:2,
    })
    expect(mockRun.mock.calls[0][0]).toMatch(/FOR UPDATE/)
  })
})

describe('completePaymentSideEffect', () => {
  it('writes deduplicated notifications, referral and completion in one transaction', async () => {
    mockRun.mockImplementation(sql => {
      if (sql.includes('FROM orders')) {
        return Promise.resolve([[{
          order_id:'order-4', user_id:11, plan:'plus', plan_label:'Plus', period:'month',
          amount_confirmed:'26.10', status:'paid',
        }]])
      }
      return Promise.resolve([{ affectedRows:1 }])
    })
    await expect(completePaymentSideEffect({ id:4, order_id:'order-4', user_id:11 }))
      .resolves.toEqual({ status:'completed', orderId:'order-4' })
    expect(mockRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO notifications'),
      expect.arrayContaining(['payment:order-4:success']),
    )
    expect(mockProcessReferralCommission).toHaveBeenCalledWith(
      11, '26.10', 'plus', 'Plus', 'month', 'order-4', { run:mockRun },
    )
    expect(mockRun).toHaveBeenCalledWith(
      expect.stringContaining("status = 'completed'"),
      [4],
    )
  })

  it('fails closed when the order is not paid', async () => {
    mockRun.mockResolvedValueOnce([[{ order_id:'order-5', user_id:11, status:'pending' }]])
    await expect(completePaymentSideEffect({ id:5, order_id:'order-5', user_id:11 }))
      .rejects.toThrow('payment_order_not_paid')
  })
})

describe('retryPaymentSideEffect', () => {
  it('persists a bounded failure message and retry time', async () => {
    mockQueryRun.mockResolvedValue({ changes:1 })
    await retryPaymentSideEffect({ id:6 }, new Error('temporary failure'))
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'retry'[\s\S]*INTERVAL 1 MINUTE/),
      ['temporary failure', 6],
    )
  })
})
