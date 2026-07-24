import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryRun = vi.fn()
const mockQueryAll = vi.fn()
const mockEnqueuePaymentSideEffect = vi.fn()
const mockSchedulePaymentSideEffects = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne: (...args) => mockQueryOne(...args),
  queryRun: (...args) => mockQueryRun(...args),
  queryAll: (...args) => mockQueryAll(...args),
  withTransaction: async (fn) => fn(mockQueryRun),
  beijingNow: vi.fn(() => '2026-07-02 12:00:00'),
  parseBeijing: vi.fn((s) => {
    if (!s) return null
    const d = new Date(String(s).replace(' ', 'T') + '+08:00')
    return isNaN(d.getTime()) ? null : d
  }),
}))

vi.mock('../../server/jobs/payment-side-effects.js', () => ({
  enqueuePaymentSideEffect: (...args) => mockEnqueuePaymentSideEffect(...args),
  schedulePaymentSideEffects: (...args) => mockSchedulePaymentSideEffects(...args),
}))

const mockAdapter = {
  name: 'TRON',
  getConfirmations: vi.fn().mockResolvedValue(20),
  getRequiredConfirmations: vi.fn().mockReturnValue(19),
}

vi.mock('../../server/crypto/chains/index.js', () => ({
  adapters: {
    TRON: mockAdapter,
    ETH: { ...mockAdapter, name: 'ETH', getRequiredConfirmations: vi.fn().mockReturnValue(12) },
    BSC: { ...mockAdapter, name: 'BSC', getRequiredConfirmations: vi.fn().mockReturnValue(15) },
    SOL: { ...mockAdapter, name: 'SOL', getRequiredConfirmations: vi.fn().mockReturnValue(32) },
  },
  getAdapter: vi.fn((chain) => {
    const map = {
      TRON: mockAdapter,
      ETH: { ...mockAdapter, name: 'ETH', getRequiredConfirmations: vi.fn().mockReturnValue(12) },
      BSC: { ...mockAdapter, name: 'BSC', getRequiredConfirmations: vi.fn().mockReturnValue(15) },
      SOL: { ...mockAdapter, name: 'SOL', getRequiredConfirmations: vi.fn().mockReturnValue(32) },
    }
    return map[chain]
  }),
}))

let formatUsdtAmount, addWatchAddress, removeWatchAddress, scanTronPayment, startMonitor, stopMonitor, expirePendingOrder

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.resetModules()
  const mod = await import('../../server/crypto/monitor.js')
  formatUsdtAmount = mod.formatUsdtAmount
  addWatchAddress = mod.addWatchAddress
  removeWatchAddress = mod.removeWatchAddress
  scanTronPayment = mod.scanTronPayment
  startMonitor = mod.startMonitor
  stopMonitor = mod.stopMonitor
  expirePendingOrder = mod.expirePendingOrder
})

afterEach(() => {
  vi.useRealTimers()
  stopMonitor()
})

describe('formatUsdtAmount', () => {
  it('formats integer amounts with 2 decimals', () => {
    expect(formatUsdtAmount(100)).toBe('100.00')
  })

  it('formats decimal amounts with 2 decimals', () => {
    expect(formatUsdtAmount(99.9)).toBe('99.90')
  })

  it('formats string amounts', () => {
    expect(formatUsdtAmount('50.5')).toBe('50.50')
  })

  it('handles zero', () => {
    expect(formatUsdtAmount(0)).toBe('0.00')
  })

  it('handles large amounts', () => {
    expect(formatUsdtAmount(1000000)).toBe('1000000.00')
  })
})

describe('addWatchAddress', () => {
  it('inserts a watch address record into crypto_watch_list', async () => {
    mockQueryRun.mockResolvedValue({ insertId: 1, changes: 1 })
    await addWatchAddress({
      orderId: 'order-123',
      userId: 1,
      chain: 'TRON',
      address: 'TAddr123',
      expectedAmount: 99.9,
      expiresAt: '2026-07-02 13:00:00',
    })
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO crypto_watch_list'),
      expect.arrayContaining(['order-123', 1, 'TRON', 'TAddr123', 99.9, '2026-07-02 13:00:00'])
    )
  })

  it('returns the insertId', async () => {
    mockQueryRun.mockResolvedValue({ insertId: 42, changes: 1 })
    const id = await addWatchAddress({
      orderId: 'order-456',
      userId: 2,
      chain: 'ETH',
      address: '0xAbCd',
      expectedAmount: 50,
      expiresAt: '2026-07-02 13:00:00',
    })
    expect(id).toBe(42)
  })
})

describe('scanTronPayment', () => {
  it('matches confirmed TRC20 transfer by address, exact amount and order creation time', async () => {
    const createdMs = new Date('2026-07-02T08:00:00+08:00').getTime()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { transaction_id: 'old', to: 'TAddr', value: '50000001', block_timestamp: createdMs - 1000 },
          { transaction_id: 'wrong-amount', to: 'TAddr', value: '50000002', block_timestamp: createdMs + 1000 },
          { transaction_id: 'matched', to: 'TAddr', value: '50000001', block_timestamp: createdMs + 2000 },
        ],
      }),
    })

    const result = await scanTronPayment(
      { getApiBaseUrl: () => 'https://api.trongrid.io' },
      'TAddr',
      '50.000001',
      '2026-07-02 08:00:00',
      new Set()
    )

    expect(result).toEqual({ hash: 'matched', amount: 50.000001 })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('limit=200&only_confirmed=true&min_timestamp='),
      expect.any(Object)
    )
  })

  it('does not match a transfer with a different micro-USDT amount', async () => {
    const createdMs = new Date('2026-07-02T08:00:00+08:00').getTime()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ transaction_id: 'wrong', to: 'TAddr', value: '50000002', block_timestamp: createdMs + 2000 }],
      }),
    })

    const result = await scanTronPayment(
      { getApiBaseUrl: () => 'https://api.trongrid.io' },
      'TAddr',
      '50.000001',
      '2026-07-02 08:00:00',
      new Set()
    )
    expect(result).toBeNull()
  })
})

describe('removeWatchAddress', () => {
  it('deletes a watch address by id', async () => {
    mockQueryRun.mockResolvedValue({ changes: 1 })
    await removeWatchAddress(1)
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM crypto_watch_list'),
      [1]
    )
  })
})

describe('startMonitor / stopMonitor', () => {
  it('does not throw when called', () => {
    expect(() => startMonitor()).not.toThrow()
  })

  it('does not throw when stopping without starting', () => {
    expect(() => stopMonitor()).not.toThrow()
  })

  it('can be started and stopped without errors', () => {
    startMonitor()
    stopMonitor()
  })

  it('does not start duplicate monitors', () => {
    startMonitor()
    startMonitor()
    stopMonitor()
  })
})

describe('confirmation checker', () => {
  it('polls for confirming records and updates confirmations', async () => {
    mockQueryAll.mockResolvedValue([
      { id: 1, chain: 'TRON', tx_hash: 'tx1', status: 'confirming', order_id: 'o1', user_id: 1, required_confirmations: 19 },
    ])
    mockQueryRun.mockImplementation(sql => sql.includes('SELECT plan_expires_at')
      ? Promise.resolve([[{ plan_expires_at:null }]])
      : Promise.resolve({ changes:1 }))
    mockQueryOne.mockResolvedValue({ plan: 'plus', period: 'month', plan_label: 'Plus', amount: 100, amount_confirmed:90 })

    startMonitor()

    await vi.advanceTimersByTimeAsync(15000)

    expect(mockQueryAll).toHaveBeenCalledWith(
      expect.stringContaining("status = 'confirming'"),
      expect.any(Array)
    )
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crypto_watch_list'),
      [20, 1]
    )
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT plan_expires_at[\s\S]*FOR UPDATE/),
      [1]
    )
    expect(mockEnqueuePaymentSideEffect).toHaveBeenCalledWith(
      mockQueryRun,
      { orderId:'o1', userId:1 },
    )
    expect(mockSchedulePaymentSideEffects).toHaveBeenCalled()
  })

  it('updates order to paid when confirmations reach required', async () => {
    mockQueryAll.mockResolvedValue([
      { id: 1, chain: 'TRON', tx_hash: 'tx1', status: 'confirming', order_id: 'o1', user_id: 1, required_confirmations: 19 },
    ])
    mockQueryRun.mockImplementation(sql => sql.includes('SELECT plan_expires_at')
      ? Promise.resolve([[{ plan_expires_at:null }]])
      : Promise.resolve({ changes:1 }))
    mockQueryOne.mockResolvedValue({ plan: 'plus', period: 'monthly', amount_confirmed:100 })

    startMonitor()

    await vi.advanceTimersByTimeAsync(15000)

    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE orders'),
      expect.arrayContaining(['o1'])
    )
  })

  it('handles mysql transaction runner tuple when activating membership', async () => {
    mockQueryAll.mockResolvedValue([
      { id: 1, chain: 'TRON', tx_hash: 'tx1', status: 'confirming', order_id: 'o1', user_id: 1, required_confirmations: 19 },
    ])
    mockQueryRun.mockImplementation(sql => sql.includes('SELECT plan_expires_at')
      ? Promise.resolve([[{ plan_expires_at:null }]])
      : Promise.resolve([{ affectedRows:1 }]))
    mockQueryOne.mockResolvedValue({ plan: 'plus', period: 'month', plan_label: 'Plus', amount: 100, amount_confirmed:90 })

    startMonitor()
    await vi.advanceTimersByTimeAsync(15000)

    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET plan'),
      expect.any(Array)
    )
  })
})

describe('expiry checker', () => {
  it('expires an order and restores exactly its persisted referral credit', async () => {
    mockQueryRun.mockImplementation((sql) => {
      if (sql.trim().startsWith('SELECT user_id')) {
        return Promise.resolve([[{ user_id:7, status:'pending', referral_credit_applied:29 }]])
      }
      return Promise.resolve([{ affectedRows:1 }])
    })

    await expect(expirePendingOrder('test-order-1', { requirePendingWatch:true })).resolves.toBe(true)
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('referral_credit = referral_credit + ?'),
      [29, 7]
    )
  })

  it('marks expired watch_list records', async () => {
    mockQueryAll.mockImplementation((sql) => sql.includes('expires_at <')
      ? Promise.resolve([{ order_id:'test-order-1' }])
      : Promise.resolve([]))
    mockQueryRun.mockImplementation((sql) => {
      if (sql.trim().startsWith('SELECT user_id')) {
        return Promise.resolve([[{ user_id:7, status:'pending', referral_credit_applied:0 }]])
      }
      return Promise.resolve([{ affectedRows:1 }])
    })

    startMonitor()

    await vi.advanceTimersByTimeAsync(35000)

    expect(mockQueryAll).toHaveBeenCalledWith(
      expect.stringContaining("expires_at <"),
      expect.any(Array)
    )
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining("crypto_watch_list"),
      expect.any(Array)
    )
  })
})

describe('fallback poller', () => {
  it('polls pending addresses for each chain', async () => {
    mockQueryAll
      .mockResolvedValueOnce([
        { id: 1, chain: 'TRON', address: 'TAddr', expected_amount: 100, status: 'pending', order_id: 'o1', user_id: 1, required_confirmations: 19 },
      ])
      .mockResolvedValue([])
      .mockResolvedValue([])
      .mockResolvedValue([])

    startMonitor()

    await vi.advanceTimersByTimeAsync(65000)

    expect(mockQueryAll).toHaveBeenCalledWith(
      expect.stringContaining("status = 'pending'"),
      expect.any(Array)
    )
    expect(mockQueryAll).toHaveBeenCalledWith(
      expect.stringContaining("w.status = 'confirming'"),
      expect.any(Array)
    )
  })
})
