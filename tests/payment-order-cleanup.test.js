import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryAll = vi.fn()
const mockWithTransaction = vi.fn()

vi.mock('../server/db.js', () => ({
  queryAll: (...args) => mockQueryAll(...args),
  withTransaction: (...args) => mockWithTransaction(...args),
  beijingNow: vi.fn(() => '2026-07-23 12:00:00'),
  parseBeijing: vi.fn(value => {
    if (value instanceof Date) return value
    const date = new Date(String(value).replace(' ', 'T') + '+08:00')
    return Number.isNaN(date.getTime()) ? null : date
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.PAYMENT_EXPIRED_ORDER_RETENTION_DAYS
  delete process.env.PAYMENT_EXPIRED_ORDER_CLEANUP_BATCH_SIZE
  delete process.env.PAYMENT_EXPIRED_ORDER_CLEANUP_ENABLED
})

describe('payment order cleanup', () => {
  it('deletes only retained expired orders and their orphaned watch rows in batches', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([{ affectedRows: 3 }])
    mockWithTransaction.mockImplementation(async callback => callback(run))
    mockQueryAll
      .mockResolvedValueOnce([{ id: 11, order_id: 'o-11' }, { id: 12, order_id: 'o-12' }])
      .mockResolvedValueOnce([])

    const { purgeExpiredPaymentOrders } = await import('../server/jobs/payment-order-cleanup.js')
    const result = await purgeExpiredPaymentOrders({ retentionDays: 30, batchSize: 2 })

    expect(mockQueryAll.mock.calls[0][0]).toContain("status = 'expired'")
    expect(mockQueryAll.mock.calls[0][0]).toContain('crypto_expires_at')
    expect(mockQueryAll.mock.calls[0][1]).toEqual([
      '2026-06-23 12:00:00',
      '2026-06-23 12:00:00',
      2,
    ])
    expect(run.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('DELETE FROM orders'),
      expect.stringContaining('DELETE FROM crypto_watch_list'),
    ])
    expect(run.mock.calls[1][0]).toContain('NOT EXISTS')
    expect(result).toMatchObject({
      status: 'completed',
      cutoff: '2026-06-23 12:00:00',
      deletedOrders: 2,
      deletedWatchRows: 3,
      batches: 1,
    })
  })

  it('does not delete anything when no retained expired orders exist', async () => {
    mockQueryAll.mockResolvedValue([])
    const { purgeExpiredPaymentOrders } = await import('../server/jobs/payment-order-cleanup.js')

    const result = await purgeExpiredPaymentOrders()

    expect(result.status).toBe('completed')
    expect(result.deletedOrders).toBe(0)
    expect(result.deletedWatchRows).toBe(0)
    expect(mockWithTransaction).not.toHaveBeenCalled()
  })

  it('prevents overlapping cleanup cycles', async () => {
    let release
    const pending = new Promise(resolve => { release = resolve })
    mockQueryAll.mockReturnValueOnce(pending)

    const { purgeExpiredPaymentOrders } = await import('../server/jobs/payment-order-cleanup.js')
    const first = purgeExpiredPaymentOrders()
    const second = await purgeExpiredPaymentOrders()
    expect(second).toEqual({ status: 'already_running' })

    release([])
    await expect(first).resolves.toMatchObject({ status: 'completed' })
  })
})
