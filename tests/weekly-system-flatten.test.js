import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryRun = vi.fn()
const mockSendBridgeCommand = vi.fn()
const mockSendToBrowsers = vi.fn()
const mockGetAllBridges = vi.fn()
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
  del: vi.fn(),
}

vi.mock('../server/db.js', () => ({ queryRun: mockQueryRun }))
vi.mock('../server/redis.js', () => ({ getRedis: () => mockRedis, isRedisAvailable: () => true }))
vi.mock('../server/bridge-ws.js', () => ({
  getAllBridges: mockGetAllBridges,
  sendBridgeCommand: mockSendBridgeCommand,
  sendToBrowsers: mockSendToBrowsers,
}))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.WEEKLY_SYSTEM_FLATTEN_ENABLED
  mockRedis.get.mockResolvedValue(null)
  mockRedis.set.mockResolvedValue('OK')
  mockRedis.eval.mockResolvedValue(1)
  mockQueryRun.mockResolvedValue({ affectedRows: 1 })
})

describe('weekly Beijing risk window', () => {
  it('locks from Saturday 04:00 through Monday 07:59 Beijing', async () => {
    const { isWeeklyFlattenWindow, isWeeklyFlattenPrimaryWindow } = await import('../server/jobs/weekly-risk-window.js')

    expect(isWeeklyFlattenWindow(new Date('2026-07-17T19:59:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-17T20:00:00.000Z'))).toBe(true)
    expect(isWeeklyFlattenPrimaryWindow(new Date('2026-07-17T20:30:00.000Z'))).toBe(true)
    expect(isWeeklyFlattenPrimaryWindow(new Date('2026-07-17T21:00:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-19T23:59:00.000Z'))).toBe(true)
    expect(isWeeklyFlattenWindow(new Date('2026-07-20T00:00:00.000Z'))).toBe(false)
  })

  it('uses the Saturday Beijing date as the cycle id', async () => {
    const { weeklyFlattenCycleId } = await import('../server/jobs/weekly-risk-window.js')

    expect(weeklyFlattenCycleId(new Date('2026-07-17T20:00:00.000Z'))).toBe('2026-07-18')
    expect(weeklyFlattenCycleId(new Date('2026-07-18T20:00:00.000Z'))).toBe('2026-07-18')
    expect(weeklyFlattenCycleId(new Date('2026-07-19T23:00:00.000Z'))).toBe('2026-07-18')
  })

  it('returns a deterministic rejection during the risk window', async () => {
    const { weeklyRiskLockResult } = await import('../server/jobs/weekly-risk-window.js')
    const result = weeklyRiskLockResult(new Date('2026-07-17T20:00:00.000Z'))

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('weekly_market_close_risk_lock')
    expect(result.message).toBe('周末风险控制期间禁止新增交易')
    expect(result.details.cycle).toBe('2026-07-18')
  })
})

describe('weekly system flatten execution', () => {
  const runAt = new Date('2026-07-17T20:05:00.000Z')

  it('cancels system pending orders, closes hedging positions and verifies zero inventory', async () => {
    mockSendBridgeCommand
      .mockResolvedValueOnce({
        status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
        pending_orders: [{ ticket: 11, symbol: 'XAUUSD' }],
        positions: [{ ticket: 22, symbol: 'XAUUSD', volume: 0.01 }],
      })
      .mockResolvedValueOnce({ status: 'success', ticket: 11 })
      .mockResolvedValueOnce({ status: 'success', ticket: 22 })
      .mockResolvedValueOnce({
        status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
        pending_orders: [], positions: [],
      })
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt)

    expect(result.status).toBe('completed')
    expect(mockSendBridgeCommand.mock.calls.map(call => call[1])).toEqual([
      'system_trade_inventory', 'cancel_system_pending', 'close_system_position', 'system_trade_inventory',
    ])
    expect(mockQueryRun).toHaveBeenCalledWith(expect.stringContaining("pending_state = 'cancelled'"), [7, '11'])
    expect(mockRedis.set).toHaveBeenCalledWith(
      'risk:weekly_flatten:2026-07-18:user:7:completed', expect.any(String), 'EX', 1209600
    )
  })

  it('does not close positions on a netting account', async () => {
    mockSendBridgeCommand.mockResolvedValueOnce({
      status: 'success', account: { login: 1, server: 'demo', is_hedging: false },
      pending_orders: [], positions: [{ ticket: 22, symbol: 'XAUUSD', volume: 0.01 }],
    })
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt)

    expect(result.status).toBe('unsupported_netting')
    expect(mockSendBridgeCommand.mock.calls.map(call => call[1])).toEqual(['system_trade_inventory'])
    expect(mockRedis.set).not.toHaveBeenCalledWith(expect.stringContaining(':completed'), expect.anything(), 'EX', expect.anything())
  })

  it('re-verifies a completed user during the primary window', async () => {
    mockRedis.get.mockResolvedValue('done')
    mockSendBridgeCommand.mockResolvedValue({
      status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
      pending_orders: [], positions: [],
    })
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt)

    expect(result.status).toBe('already_completed')
    expect(result.verified).toBe(true)
    expect(mockSendBridgeCommand).toHaveBeenCalledWith(7, 'system_trade_inventory', {}, 15000, { noFallback: true })
  })

  it('clears the completion marker and closes a late-arriving position', async () => {
    mockRedis.get.mockResolvedValue('done')
    mockSendBridgeCommand
      .mockResolvedValueOnce({
        status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
        pending_orders: [], positions: [{ ticket: 33, symbol: 'XAUUSD', volume: 0.01 }],
      })
      .mockResolvedValueOnce({ status: 'success', ticket: 33 })
      .mockResolvedValueOnce({
        status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
        pending_orders: [], positions: [],
      })
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt)

    expect(result.status).toBe('completed')
    expect(mockRedis.del).toHaveBeenCalledWith('risk:weekly_flatten:2026-07-18:user:7:completed')
    expect(mockSendBridgeCommand.mock.calls.map(call => call[1])).toContain('close_system_position')
  })
})

describe('weekly flatten concurrency', () => {
  it('limits concurrent users while preserving result order', async () => {
    const { __weeklyFlattenTest } = await import('../server/jobs/weekly-system-flatten.js')
    let active = 0
    let maxActive = 0
    const results = await __weeklyFlattenTest.mapWithConcurrency([1, 2, 3, 4], 2, async item => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return item * 10
    })

    expect(maxActive).toBe(2)
    expect(results).toEqual([10, 20, 30, 40])
  })
})
