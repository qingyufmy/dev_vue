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
  sadd: vi.fn(),
  expire: vi.fn(),
  smembers: vi.fn(),
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
  mockRedis.sadd.mockResolvedValue(1)
  mockRedis.expire.mockResolvedValue(1)
  mockRedis.smembers.mockResolvedValue([])
  mockQueryRun.mockResolvedValue({ affectedRows: 1 })
})

describe('weekly MT5 risk window', () => {
  it('only locks from Friday 23:00 through 23:59 MT5 time', async () => {
    const { isWeeklyFlattenWindow, isWeeklyFlattenPrimaryWindow } = await import('../server/jobs/weekly-risk-window.js')

    expect(isWeeklyFlattenWindow(new Date('2026-07-17T19:59:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-17T20:00:00.000Z'))).toBe(true)
    expect(isWeeklyFlattenPrimaryWindow(new Date('2026-07-17T20:30:00.000Z'))).toBe(true)
    expect(isWeeklyFlattenPrimaryWindow(new Date('2026-07-17T21:00:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-18T20:00:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-19T23:59:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-20T00:00:00.000Z'))).toBe(false)
  })

  it('calculates the next Friday 23:00 MT5 start', async () => {
    const { currentWeeklyFlattenEnd, nextWeeklyFlattenStart } = await import('../server/jobs/weekly-risk-window.js')

    expect(nextWeeklyFlattenStart(new Date('2026-07-17T19:00:00.000Z')).toISOString()).toBe('2026-07-17T20:00:00.000Z')
    expect(nextWeeklyFlattenStart(new Date('2026-07-17T21:00:00.000Z')).toISOString()).toBe('2026-07-24T20:00:00.000Z')
    expect(currentWeeklyFlattenEnd(new Date('2026-07-17T20:30:00.000Z')).toISOString()).toBe('2026-07-17T21:00:00.000Z')
  })

  it('uses the MT5 Saturday date as the cycle id', async () => {
    const { weeklyFlattenCycleId } = await import('../server/jobs/weekly-risk-window.js')

    expect(weeklyFlattenCycleId(new Date('2026-07-17T20:00:00.000Z'))).toBe('2026-07-18')
    expect(weeklyFlattenCycleId(new Date('2026-07-18T20:00:00.000Z'))).toBe('2026-07-18')
    expect(weeklyFlattenCycleId(new Date('2026-07-19T23:00:00.000Z'))).toBe('2026-07-18')
    expect(weeklyFlattenCycleId(new Date('2026-07-21T03:00:00.000Z'))).toBe('2026-07-18')
  })

  it('moves the same MT5 window when the broker offset changes', async () => {
    const { isWeeklyFlattenWindow, setWeeklyMarketTimezoneOffset } = await import('../server/jobs/weekly-risk-window.js')
    setWeeklyMarketTimezoneOffset(120)
    expect(isWeeklyFlattenWindow(new Date('2026-07-17T20:30:00.000Z'))).toBe(false)
    expect(isWeeklyFlattenWindow(new Date('2026-07-17T21:30:00.000Z'))).toBe(true)
    setWeeklyMarketTimezoneOffset(180)
  })

  it('returns a deterministic rejection during the risk window', async () => {
    const { weeklyRiskLockResult } = await import('../server/jobs/weekly-risk-window.js')
    const result = weeklyRiskLockResult(new Date('2026-07-17T20:00:00.000Z'))

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('weekly_market_close_risk_lock')
    expect(result.message).toBe('周末风险控制期间禁止新增交易')
    expect(result.details.cycle).toBe('2026-07-18')
  })

  it('can be explicitly disabled by deployment configuration', async () => {
    process.env.WEEKLY_SYSTEM_FLATTEN_ENABLED = 'false'
    const { isWeeklyFlattenWindow, weeklyRiskLockResult } = await import('../server/jobs/weekly-risk-window.js')
    const now = new Date('2026-07-17T20:00:00.000Z')

    expect(isWeeklyFlattenWindow(now)).toBe(false)
    expect(weeklyRiskLockResult(now)).toBeNull()
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

    const result = await runWeeklySystemFlattenForUser(7, runAt, () => runAt)

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

    const result = await runWeeklySystemFlattenForUser(7, runAt, () => runAt)

    expect(result.status).toBe('unsupported_netting')
    expect(mockSendBridgeCommand.mock.calls.map(call => call[1])).toEqual(['system_trade_inventory'])
    expect(mockRedis.set).not.toHaveBeenCalledWith(expect.stringContaining(':completed'), expect.anything(), 'EX', expect.anything())
  })

  it('does not re-check a user after the cycle is completed', async () => {
    mockRedis.get.mockResolvedValue('done')
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt, () => runAt)

    expect(result.status).toBe('already_completed')
    expect(mockSendBridgeCommand).not.toHaveBeenCalled()
  })

  it('stops sending MT5 commands when the MT5 Saturday 00:00 deadline is reached', async () => {
    const endedAt = new Date('2026-07-17T21:00:00.000Z')
    const clock = vi.fn()
      .mockReturnValueOnce(runAt)
      .mockReturnValue(endedAt)
    mockSendBridgeCommand
      .mockResolvedValueOnce({
        status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
        pending_orders: [{ ticket: 11, symbol: 'XAUUSD' }],
        positions: [{ ticket: 33, symbol: 'XAUUSD', volume: 0.01 }],
      })
      .mockResolvedValueOnce({ status: 'success', ticket: 11 })
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt, clock)

    expect(result.status).toBe('window_ended')
    expect(mockSendBridgeCommand.mock.calls.map(call => call[1])).toEqual([
      'system_trade_inventory', 'cancel_system_pending',
    ])
  })

  it('contains Redis completion-check failures without sending MT5 commands', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('redis down'))
    const { runWeeklySystemFlattenForUser } = await import('../server/jobs/weekly-system-flatten.js')

    const result = await runWeeklySystemFlattenForUser(7, runAt, () => runAt)

    expect(result.status).toBe('redis_unavailable')
    expect(result.error).toBe('redis down')
    expect(mockSendBridgeCommand).not.toHaveBeenCalled()
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

describe('weekly flatten deadline finalization', () => {
  it('persists the cycle member and result in one Redis Lua operation', async () => {
    const { __weeklyFlattenTest } = await import('../server/jobs/weekly-system-flatten.js')
    const cycle = '2026-09-05'

    await __weeklyFlattenTest.rememberCycleResult(cycle, 6, { status: 'partial' })

    expect(mockRedis.eval).toHaveBeenCalledWith(
      __weeklyFlattenTest.REMEMBER_CYCLE_RESULT_LUA,
      2,
      'risk:weekly_flatten:2026-09-05:users',
      'risk:weekly_flatten:2026-09-05:user:6:last_result',
      '6',
      JSON.stringify({ status: 'partial' }),
      '1209600'
    )
    expect(mockRedis.sadd).not.toHaveBeenCalled()
    expect(mockRedis.expire).not.toHaveBeenCalled()
  })

  it('reports an unfinished user without sending another MT5 command', async () => {
    const { __weeklyFlattenTest, finalizeWeeklyFlattenCycle } = await import('../server/jobs/weekly-system-flatten.js')
    const cycle = '2026-07-25'
    __weeklyFlattenTest.rememberLocalResult(cycle, 7, {
      status: 'partial', remaining_pending: [11], remaining_positions: [22],
    })

    const result = await finalizeWeeklyFlattenCycle(cycle)

    expect(result).toEqual({ status: 'finalized', users: [{ userId: 7, status: 'failed' }] })
    expect(mockSendBridgeCommand).not.toHaveBeenCalled()
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trade_audit_logs'),
      expect.arrayContaining([7, '周末风险清理到期'])
    )
    expect(mockSendToBrowsers).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'weekly_flatten_state', status: 'failed', reason: 'deadline_reached',
    }))
  })

  it('does not report a completed user as failed', async () => {
    const { __weeklyFlattenTest, finalizeWeeklyFlattenCycle } = await import('../server/jobs/weekly-system-flatten.js')
    const cycle = '2026-08-01'
    __weeklyFlattenTest.rememberLocalResult(cycle, 8, { status: 'completed' })

    const result = await finalizeWeeklyFlattenCycle(cycle)

    expect(result).toEqual({ status: 'finalized', users: [{ userId: 8, status: 'completed' }] })
    expect(mockQueryRun).not.toHaveBeenCalled()
    expect(mockSendToBrowsers).not.toHaveBeenCalled()
    expect(mockSendBridgeCommand).not.toHaveBeenCalled()
  })

  it('uses the persisted Redis result after a process restart', async () => {
    const { __weeklyFlattenTest, finalizeWeeklyFlattenCycle } = await import('../server/jobs/weekly-system-flatten.js')
    const cycle = '2026-08-08'
    __weeklyFlattenTest.rememberLocalResult(cycle, 9, { status: 'partial' })
    mockRedis.smembers.mockResolvedValueOnce(['9'])
    mockRedis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ status: 'completed' }))

    const result = await finalizeWeeklyFlattenCycle(cycle)

    expect(result).toEqual({ status: 'finalized', users: [{ userId: 9, status: 'completed' }] })
    expect(mockQueryRun).not.toHaveBeenCalled()
    expect(mockSendToBrowsers).not.toHaveBeenCalled()
  })

  it('does not silently finalize a Redis member whose persisted result is missing', async () => {
    const { finalizeWeeklyFlattenCycle } = await import('../server/jobs/weekly-system-flatten.js')
    const cycle = '2026-08-15'
    mockRedis.smembers.mockResolvedValueOnce(['11'])
    mockRedis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const result = await finalizeWeeklyFlattenCycle(cycle)

    expect(result).toEqual({ status: 'finalized', users: [{ userId: 11, status: 'failed' }] })
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO trade_audit_logs'),
      expect.arrayContaining([
        11,
        '周末风险清理到期',
        null,
        expect.any(String),
        expect.stringContaining('系统执行条件未满足'),
      ])
    )
    expect(mockSendToBrowsers).toHaveBeenCalledWith(11, expect.objectContaining({
      type: 'weekly_flatten_state', status: 'failed', reason: 'deadline_reached',
    }))
  })

  it('waits for an in-flight reconnect run before writing the deadline result', async () => {
    const { __weeklyFlattenTest, finalizeWeeklyFlattenCycle } = await import('../server/jobs/weekly-system-flatten.js')
    const runAt = new Date('2026-07-17T20:59:59.000Z')
    let releaseInventory
    mockSendBridgeCommand.mockReturnValueOnce(new Promise(resolve => { releaseInventory = resolve }))

    const endedAt = new Date('2026-07-17T21:00:00.000Z')
    const trackedRun = __weeklyFlattenTest.runTrackedUserFlatten(10, runAt, () => endedAt)
    let finalized = false
    const finalizing = finalizeWeeklyFlattenCycle('2026-07-18').then(result => {
      finalized = true
      return result
    })
    await Promise.resolve()
    expect(finalized).toBe(false)

    releaseInventory({
      status: 'success', account: { login: 1, server: 'demo', is_hedging: true },
      pending_orders: [], positions: [],
    })
    await trackedRun
    const result = await finalizing

    expect(result).toEqual({ status: 'finalized', users: [{ userId: 10, status: 'failed' }] })
    expect(mockSendBridgeCommand).toHaveBeenCalledTimes(1)
  })
})
