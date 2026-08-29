import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

// Mock 依赖 — 路径必须与 scheduler.js 的导入路径一致
vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-06-26 12:00:00'),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  isBridgeAlive: vi.fn(() => true),
  getOwnBridgeMarketState: vi.fn(() => ({ alive:true, isOpen:true, reason:'market_open' })),
  getPlatformMarketClockState: vi.fn(() => ({ timezone_offset_minutes:480 })),
  getOwnBridgeTradeMode: vi.fn(() => 4),
  getBridgeTradeMode: vi.fn(() => 4),
  sendBridgeCommand: vi.fn(),
  sendToBrowsers: vi.fn(),
  broadcastAdminEvent: vi.fn(),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({
  mt5Bridge: vi.fn(),
  platformRates: vi.fn(),
  calculateMarketData: vi.fn(() => ({
    symbol: 'XAUUSD', timeframe: 'M5',
    latest_price: 2000, price_change: 10, price_change_pct: 0.5,
    atr_14: 10, volatility_pct: 0.3,
    strategy_score: { trend_strength: 0.6, data_confidence: 0.7 },
    kline_count: 100, positions: { total_positions: 0, details: [] },
    account: { balance: 10000, equity: 10500 },
  })),
}))

vi.mock('../../server/routes/ai/llm.js', () => ({
  maybeAiSignal: vi.fn(() => ({
    signal_type: 'buy', confidence: 0.7, recommended_volume: 0.03,
    analysis: 'test', reasoning: 'test',
    stop_loss_price: 1990, take_profit_1_price: 2010,
    _inference_source: 'ai',
  })),
}))

vi.mock('../../server/routes/ai/config.js', () => ({
  getAutoConfig: vi.fn(() => ({ enabled: true, symbols: 'XAUUSD' })),
  getGlobalAutoConfig: vi.fn(() => ({ symbols: 'XAUUSD', interval_minutes: 5 })),
  getCloseConfig: vi.fn(() => ({ enabled: false })),
  saveCloseConfig: vi.fn(),
  insertAudit: vi.fn(),
  signalOrderPayload: vi.fn(() => ({ symbol: 'XAUUSD', order_type: 'buy', volume: 0.03 })),
  getExecuteRiskConfig: vi.fn(() => ({})),
  getDeliveryExecuteRiskConfig: vi.fn(() => ({})),
  validateTradeRequest: vi.fn(),
  RiskReject: class RiskReject extends Error {},
  getAutoPromptTypeById: vi.fn(() => null),
  getAutoPromptTypes: vi.fn(() => []),
  getUnifiedAutoInferenceConfig: vi.fn(() => null),
  getAutoSubscribers: vi.fn(() => []),
  parsePromptSymbols: vi.fn(() => ['XAUUSD']),
  resolveEffectiveSymbols: vi.fn((selected, strategy) => {
    try {
      const parsed = JSON.parse(selected || strategy || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }),
  buildBridgeOrderCall: vi.fn(() => ({ bridgeAction: 'open', params: {} })),
}))

vi.mock('../../server/routes/ai/strategy.js', () => ({
  attachAtrAnchor: vi.fn(),
  buildStrategyContextFromTags: vi.fn(() => ({
    strategy_sequence: 'M5(100)',
    required_timeframes: ['M5'],
    timeframes: { M5: { summary: {}, klines: [] } },
  })),
  executeOrder: vi.fn(() => ({ status: 'success' })),
  handleAnalyze: vi.fn(),
  loadPrivatePortfolioContext: vi.fn(() => ({ positions:[], pendingOrders:[] })),
  resolveChanHistoryCount: vi.fn((_userId, _symbol, _timeframe, requestedCount, useChan) => useChan ? Math.max(requestedCount, 300) : requestedCount),
}))

vi.mock('../../server/routes/ai/utils.js', () => ({
  attachSignalTiming: vi.fn(),
  signalTtlSeconds: vi.fn(() => 120),
  stripBrokerSuffix: vi.fn(s => String(s || '').toUpperCase()),
  stripTimeframeTags: vi.fn((s) => s),
  round2: vi.fn((n) => n),
  parseTimeframeTags: vi.fn(() => []),
}))

vi.mock('../../server/redis.js', () => ({
  getRedis: vi.fn(() => null),
  isRedisAvailable: vi.fn(() => false),
}))

import { __schedulerTest, autoSchedulerState, getSubscriptionIndexHealth, getUserAutoRuntimeStatus, isAutoSchedulerRunning, rebuildRedisSubscriptions, updateSchedulerRedisState,
  startPendingReconciler, stopPendingReconciler, startAutoSchedulerReconciler, stopAutoSchedulerReconciler } from '../../server/routes/ai/scheduler.js'
import * as db from '../../server/db.js'
import * as marketData from '../../server/routes/ai/market-data.js'
import * as bridgeWs from '../../server/bridge-ws.js'
import * as config from '../../server/routes/ai/config.js'
import * as redis from '../../server/redis.js'

afterEach(() => {
  stopPendingReconciler()
  stopAutoSchedulerReconciler()
  vi.useRealTimers()
})

describe('isAutoSchedulerRunning', () => {
  it('未启动的调度器返回 false', () => {
    expect(isAutoSchedulerRunning(999)).toBe(false)
  })
})

describe('execution validation delivery gate', () => {
  it('keeps an explicit ineligible conclusion visible but terminally skipped', () => {
    const rows = __schedulerTest.buildSignalDeliveryRows({
      signalId:10, userIds:[7], onlineUserIds:new Set([7]), promptTypeId:3, symbol:'XAUUSD',
      createdAt:'2026-08-13 12:00:00', signalType:'buy', pendingAction:'none',
      executionValidation:{
        explicit:true,
        validation:{ status:'ineligible', eligible:false, reason_codes:['strategy_blocked'] },
      },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId:7,
      deliveryStatus:'delivered',
      executionStatus:'skipped',
    })
    expect(JSON.parse(rows[0].executionResult)).toMatchObject({
      status:'skipped',
      reason:'execution_validation_ineligible',
      execution_validation:{ status:'ineligible', eligible:false, reason_codes:['strategy_blocked'] },
      history_available:true,
    })
  })

  it('keeps malformed execution validation visible but terminally skipped', () => {
    const rows = __schedulerTest.buildSignalDeliveryRows({
      signalId:12, userIds:[7], onlineUserIds:new Set(), promptTypeId:3, symbol:'XAUUSD',
      createdAt:'2026-08-13 12:00:00', signalType:'sell', pendingAction:'none',
      executionValidation:{
        explicit:true,
        validation:{ status:'invalid_output', eligible:false, reason_codes:['execution_validation_status_invalid'] },
      },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ deliveryStatus:'stored_offline', executionStatus:'skipped' })
    expect(JSON.parse(rows[0].executionResult).execution_validation.status).toBe('invalid_output')
  })

  it('does not make an ineligible delivery actionable during recovery', () => {
    const result = __schedulerTest.signalDeliveryRecoveryActionable(
      { signal_type:'buy' },
      { execution_validation:{ status:'ineligible', eligible:false, reason_codes:['strategy_blocked'] } },
    )
    expect(result).toMatchObject({ actionable:false, reason:'execution_validation_ineligible' })
  })

  it('keeps legacy signals recoverable', () => {
    const rows = __schedulerTest.buildSignalDeliveryRows({
      signalId:11, userIds:[7], onlineUserIds:new Set([7]), promptTypeId:3, symbol:'XAUUSD',
      createdAt:'2026-08-13 12:00:00', signalType:'buy', pendingAction:'none',
    })
    expect(rows[0].executionStatus).toBe('not_attempted')
  })
})

describe('platform strategy direction interlock integration', () => {
  const referenceSource = { source_id:5, bridge_user_id:1, trading_account_id:3 }
  const signal = () => ({
    signal_type:'sell', entry_method:'market', position_action:'open',
    position_size_tier:'probe', position_size_factor:0.25,
    stop_loss_price:4428, take_profit_1_price:4388,
    execution_validation:{ status:'eligible', eligible:true, reason_codes:[] },
    _position_management:{ position_evaluations:[
      { management_group_id:'group-46', action:'hold', reversal_candidate:true },
      { management_group_id:'group-47', action:'hold', reversal_candidate:true },
    ] },
  })

  it('blocks signal 24414 shape before persistence while retaining management evaluations', async () => {
    const frozen = { positions:[{ direction:'buy' }, { direction:'buy' }], pending_orders:[] }
    const result = await __schedulerTest.enforcePlatformStrategyDirectionInterlock({
      signal:signal(), market:{ latest_price:4395, strategy_reference_portfolio:frozen },
      strategyId:1, inferenceUserId:1, symbol:'XAUUSD', referenceSource,
      getCurrentSource:vi.fn(async () => ({ ...referenceSource })),
      loadReferencePortfolio:vi.fn(async () => frozen),
      loadBlockingTasks:vi.fn(async () => []),
    })
    expect(result.resolution).toMatchObject({ allowed:false,
      reason_code:'strategy_reversal_waiting_for_exit', frozen_opposite_count:2 })
    expect(result.signal).toMatchObject({ signal_type:'hold', entry_method:'observe',
      execution_validation:{ eligible:false, reason_codes:['strategy_reversal_waiting_for_exit'] } })
    expect(result.signal._position_management.position_evaluations).toHaveLength(2)
  })

  it('fails closed when the observer source changes during inference', async () => {
    const result = await __schedulerTest.enforcePlatformStrategyDirectionInterlock({
      signal:signal(), market:{ strategy_reference_portfolio:{ positions:[], pending_orders:[] } },
      strategyId:1, inferenceUserId:1, symbol:'XAUUSD', referenceSource,
      getCurrentSource:vi.fn(async () => ({ ...referenceSource, trading_account_id:99 })),
      loadReferencePortfolio:vi.fn(), loadBlockingTasks:vi.fn(),
    })
    expect(result.signal.execution_validation).toMatchObject({ eligible:false,
      reason_codes:['strategy_reference_portfolio_refresh_unavailable'] })
    expect(result.resolution.refresh_error).toBe('reference_source_changed_during_inference')
  })

  it('fails closed when inference is running through a different bridge than the configured source', async () => {
    const result = await __schedulerTest.enforcePlatformStrategyDirectionInterlock({
      signal:signal(), market:{ strategy_reference_portfolio:null },
      strategyId:1, inferenceUserId:99, symbol:'XAUUSD', referenceSource,
    })
    expect(result.signal.execution_validation).toMatchObject({ eligible:false,
      reason_codes:['strategy_reference_portfolio_refresh_unavailable'] })
    expect(result.resolution.refresh_error).toBe('reference_source_bridge_mismatch')
  })

  it('allows the later cycle only after frozen and fresh portfolios are flat', async () => {
    const flat = { positions:[], pending_orders:[] }
    const original = signal()
    const result = await __schedulerTest.enforcePlatformStrategyDirectionInterlock({
      signal:original, market:{ strategy_reference_portfolio:flat },
      strategyId:1, inferenceUserId:1, symbol:'XAUUSD', referenceSource,
      getCurrentSource:vi.fn(async () => ({ ...referenceSource })),
      loadReferencePortfolio:vi.fn(async () => flat), loadBlockingTasks:vi.fn(async () => []),
    })
    expect(result.resolution).toMatchObject({ allowed:true })
    expect(result.signal).toBe(original)
  })
})

describe('unified-cycle observer source scope', () => {
  it('keeps the shared observer source in the real unified cycle scope', () => {
    const source = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
    const cycleStart = source.indexOf('async function runUnifiedAutoCycle')
    const cycleEnd = source.indexOf('\nasync function executeDelivery', cycleStart)
    const taskFenceStart = source.indexOf('async function assertModelTaskOwned')
    const taskFenceEnd = source.indexOf('\nasync function assertAutoInferenceApplyGate', taskFenceStart)

    expect(cycleStart).toBeGreaterThanOrEqual(0)
    expect(cycleEnd).toBeGreaterThan(cycleStart)
    expect(taskFenceStart).toBeGreaterThanOrEqual(0)
    expect(taskFenceEnd).toBeGreaterThan(taskFenceStart)

    const cycleBody = source.slice(cycleStart, cycleEnd)
    const taskFenceBody = source.slice(taskFenceStart, taskFenceEnd)
    expect(cycleBody.match(/let platformReferenceSource = null/g)).toHaveLength(1)
    expect(cycleBody).toContain('platformReferenceSource = await getObserverSourceForStrategy')
    expect(cycleBody).toContain('referenceSource:platformReferenceSource')
    expect(taskFenceBody).not.toContain('platformReferenceSource')
  })
})

describe('subscriber execution weekly gate', () => {
  it('uses the risk-snapshot clock and never falls back to the legacy bridge clock', () => {
    const evaluationNow = Date.parse('2026-08-21T15:30:00.000Z')
    const context = {
      user_id:28, trading_account_id:3, terminal_instance_id:null,
      broker_server:'ULTIMAMARKETS-DEMO', login:'18192234189',
      timezone_offset_minutes:480, clock_status:'verified',
      clock_source:'risk_snapshot_terminal', captured_at_utc_msc:evaluationNow,
      calibration_age_ms:1000,
    }

    // The test bridge mock intentionally does not provide
    // getPlatformMarketClockState. Calling the old bridgeWeeklyWindow lookup
    // would therefore fail; the context-only gate must still block Friday.
    expect(__schedulerTest.autoDeliveryWeeklyWindow(context, new Date(evaluationNow)))
      .toMatchObject({ blocked:true, reason:'weekly_flatten_window' })
    expect(__schedulerTest.autoDeliveryWeeklyWindow(null, new Date(evaluationNow)))
      .toMatchObject({ blocked:true, reason:'execution_clock_context_missing' })
  })
})

describe('automatic-analysis control state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redis.getRedis.mockReturnValue(null)
    redis.isRedisAvailable.mockReturnValue(false)
    for (const key of Object.keys(autoSchedulerState)) delete autoSchedulerState[key]
  })

  it('reports disabled when no subscription has automatic analysis enabled', async () => {
    db.queryOne.mockResolvedValueOnce(null)

    await expect(getUserAutoRuntimeStatus(42)).resolves.toMatchObject({
      enabled:false, running:false, paused_reason:'disabled',
    })
    expect(db.queryOne).toHaveBeenCalledTimes(1)
    expect(db.queryOne.mock.calls[0][0]).toContain('strategy_subscriptions')
  })

  it('shows a runtime synchronization warning only when the subscription is enabled', async () => {
    db.queryOne
      .mockResolvedValueOnce({ strategy_id:7, symbols_json:null })
      .mockResolvedValueOnce(null)

    await expect(getUserAutoRuntimeStatus(42)).resolves.toMatchObject({
      enabled:true, running:false, paused_reason:'no_runtime_scheduler', prompt_type_id:7,
    })
  })

  it('reports a trusted market closure before a per-key wait reason is written', async () => {
    db.queryOne
      .mockResolvedValueOnce({ strategy_id:7, symbols_json:null })
      .mockResolvedValueOnce({
        enabled:1, prompt_type_id:7, selected_symbols_json:null, interval_minutes:5,
      })
      .mockResolvedValueOnce(null)
    config.getAutoPromptTypeById.mockReturnValue({
      id:7, title:'test', scope:'private', owner_user_id:42, symbols_json:'["XAUUSD"]',
    })
    bridgeWs.getOwnBridgeMarketState.mockReturnValue({
      alive:true, isOpen:false, reason:'market_closed', tradeMode:0,
    })
    autoSchedulerState['7:XAUUSD'] = {
      subscribers:new Set([42]), inFlight:false, waitReason:'', lastError:null,
      lastRunAt:null, lastSignalId:null, stateUpdatedAtUtc:'', scheduleMode:'',
      scheduleIntervalMinutes:5, intervalMinutes:5, nextRunAtUtc:'',
      nextRunAtTerminal:'', currentSlotId:'', slotStartLagMs:0,
      lastSkippedSlotId:'', lastSkippedSlotReason:'', skippedSlotCount:0,
      terminalClockStatus:'', terminalClockSource:'', terminalTimezoneOffsetMinutes:null,
    }

    await expect(getUserAutoRuntimeStatus(42)).resolves.toMatchObject({
      enabled:true, running:false, paused_reason:'market_closed',
      market_state:{ alive:true, isOpen:false, reason:'market_closed' },
    })
  })
})

describe('runtime countdown constraints', () => {
  const nowMs = Date.parse('2026-08-05T05:00:00.000Z')

  it('uses a future runtime deadline even when Redis has no cooldown TTL', () => {
    const deadline = nowMs + 120_000
    expect(__schedulerTest.schedulerRuntimeNextRunAt({
      nextRunAtUtc:new Date(deadline).toISOString(),
    }, -2, nowMs)).toBe(deadline)
  })

  it('takes the later constraint within a key and the earlier key across symbols', () => {
    const firstKey = __schedulerTest.schedulerRuntimeNextRunAt({
      nextRunAtUtc:new Date(nowMs + 180_000).toISOString(),
    }, 300, nowMs)
    const secondKey = __schedulerTest.schedulerRuntimeNextRunAt({
      nextRunAtUtc:new Date(nowMs + 240_000).toISOString(),
    }, 90, nowMs)

    expect(firstKey).toBe(nowMs + 300_000)
    expect(secondKey).toBe(nowMs + 240_000)
    expect(Math.min(firstKey, secondKey)).toBe(nowMs + 240_000)
  })
})

describe('subscription index health', () => {
  it('records Redis unavailability instead of reporting a silent successful rebuild', async () => {
    await expect(rebuildRedisSubscriptions()).resolves.toMatchObject({ ok:false, error:'redis_unavailable' })
    expect(getSubscriptionIndexHealth()).toMatchObject({ ok:false, error:'redis_unavailable' })
  })

  it('indexes configured users even when their Bridge is offline', async () => {
    const sets = new Map()
    const hashes = new Map()
    const fakeRedis = {
      smembers: vi.fn(async key => [...(sets.get(key) || new Set())]),
      scard: vi.fn(async key => (sets.get(key) || new Set()).size),
      sadd: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.add(String(value))
        sets.set(key, set)
      }),
      srem: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.delete(String(value))
        sets.set(key, set)
      }),
      del: vi.fn(async key => { sets.delete(key); hashes.delete(key) }),
      hset: vi.fn(async (key, fields) => hashes.set(key, { ...(hashes.get(key) || {}), ...fields })),
      hgetall: vi.fn(async key => hashes.get(key) || {}),
    }
    redis.getRedis.mockReturnValue(fakeRedis)
    redis.isRedisAvailable.mockReturnValue(true)
    bridgeWs.isBridgeAlive.mockReturnValue(false)
    db.queryAll.mockResolvedValueOnce([{
      user_id:42, prompt_type_id:7, selected_symbols_json:'["XAUUSD"]', strategy_symbols_json:'["XAUUSD"]',
    }])

    await expect(rebuildRedisSubscriptions()).resolves.toMatchObject({
      ok:true, schedulerKeys:1, onlineUsers:0, configuredUsers:1,
    })
    expect(sets.get('auto:scheduler:keys')).toEqual(new Set(['7:XAUUSD']))
    expect(sets.get('auto:scheduler:7:XAUUSD:subs')).toEqual(new Set(['42']))
    expect(hashes.get('auto:user:42:auto')).toMatchObject({ enabled:'1', prompt_type_id:'7' })
  })

  it('repairs a missing runtime index on state publication and removes it on stop', async () => {
    const sets = new Map()
    const hashes = new Map()
    const fakeRedis = {
      smembers: vi.fn(async key => [...(sets.get(key) || new Set())]),
      sadd: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.add(String(value))
        sets.set(key, set)
      }),
      srem: vi.fn(async (key, ...values) => {
        const set = sets.get(key) || new Set()
        for (const value of values) set.delete(String(value))
        sets.set(key, set)
      }),
      del: vi.fn(async key => { sets.delete(key); hashes.delete(key) }),
      hset: vi.fn(async (key, fields) => hashes.set(key, { ...(hashes.get(key) || {}), ...fields })),
    }
    redis.getRedis.mockReturnValue(fakeRedis)
    redis.isRedisAvailable.mockReturnValue(true)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      nextRunInSeconds:120, nextRunAtUtc:'2026-08-05T05:02:00.000Z',
    })
    expect(sets.get('auto:scheduler:keys')).toEqual(new Set(['7:XAUUSD']))
    expect(sets.get('auto:scheduler:7:XAUUSD:subs')).toEqual(new Set(['42']))
    expect(hashes.get('auto:scheduler:7:XAUUSD:state')).toMatchObject({
      running:'1', subscriber_count:'1', next_run_in_seconds:'120', next_run_at_utc:'2026-08-05T05:02:00.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(1)
    expect(bridgeWs.broadcastAdminEvent.mock.calls[0][1]).toBe('scheduler_state')

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      nextRunInSeconds:120, nextRunAtUtc:'2026-08-05T05:02:00.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(1)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      progressPercent:55, progressSeq:2,
      nextRunInSeconds:120, nextRunAtUtc:'2026-08-05T05:02:00.000Z',
    })
    // Progress is already carried by auto_progress; scheduler_state dedupe
    // should not suppress or duplicate events for progress-only changes.
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(1)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      waitReason:'cooldown', nextRunInSeconds:90, nextRunAtUtc:'2026-08-05T05:01:30.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(2)

    await updateSchedulerRedisState('7:XAUUSD', {
      running:true, subscribers:new Set([42]), subscriberCount:1, intervalMinutes:5,
      waitReason:'cooldown', nextRunInSeconds:90, nextRunAtUtc:'2026-08-05T05:01:30.000Z',
    })
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(2)

    await updateSchedulerRedisState('7:XAUUSD', { running:false })
    expect(sets.get('auto:scheduler:keys') || new Set()).not.toContain('7:XAUUSD')
    expect(sets.has('auto:scheduler:7:XAUUSD:subs')).toBe(false)
    expect(hashes.has('auto:scheduler:7:XAUUSD:state')).toBe(false)
    expect(bridgeWs.broadcastAdminEvent).toHaveBeenCalledTimes(3)
    expect(bridgeWs.broadcastAdminEvent.mock.calls[2][2]).toMatchObject({ running:false, key:'7:XAUUSD' })
  })
})

describe('Pending order lifecycle exports', () => {
  it('reconcilePendingOrders 是函数', async () => {
    const mod = await import('../../server/routes/ai/scheduler.js')
    expect(typeof mod.reconcilePendingOrders).toBe('function')
  })

  it('startPendingReconciler 是函数', async () => {
    const mod = await import('../../server/routes/ai/scheduler.js')
    expect(typeof mod.startPendingReconciler).toBe('function')
  })

  it('stopPendingReconciler 是函数', async () => {
    const mod = await import('../../server/routes/ai/scheduler.js')
    expect(typeof mod.stopPendingReconciler).toBe('function')
  })
})

describe('periodic reconciler single-flight', () => {
  it('skips an overlapping pending tick, reruns after settle, and stops cleanly', async () => {
    vi.useFakeTimers()
    let releaseFirst
    let first = true
    db.queryAll.mockImplementation(() => {
      if (first) {
        first = false
        return new Promise(resolve => { releaseFirst = resolve })
      }
      return Promise.resolve([])
    })

    startPendingReconciler()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(__schedulerTest.getPeriodicRuntime().pendingReconcilerInFlight).toBe(true)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(__schedulerTest.getPeriodicRuntime().pendingReconcilerSkippedOverlap).toBe(1)

    releaseFirst([])
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(__schedulerTest.getPeriodicRuntime().pendingReconcilerInFlight).toBe(false)

    const callsAfterSettle = db.queryAll.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(db.queryAll.mock.calls.length).toBeGreaterThan(callsAfterSettle)

    stopPendingReconciler()
    const callsAfterStop = db.queryAll.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(db.queryAll.mock.calls.length).toBe(callsAfterStop)
  })

  it('skips an overlapping auto-scheduler reconciliation tick', async () => {
    vi.useFakeTimers()
    let releaseFirst
    let first = true
    db.queryAll.mockImplementation(() => {
      if (first) {
        first = false
        return new Promise(resolve => { releaseFirst = resolve })
      }
      return Promise.resolve([])
    })

    startAutoSchedulerReconciler()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(__schedulerTest.getPeriodicRuntime().autoReconcilerInFlight).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(__schedulerTest.getPeriodicRuntime().autoReconcilerSkippedOverlap).toBe(1)

    releaseFirst([])
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(__schedulerTest.getPeriodicRuntime().autoReconcilerInFlight).toBe(false)
  })
})

describe('reconcilePendingOrders', () => {
  let reconcilePendingOrders

  beforeEach(async () => {
    vi.clearAllMocks()
    db.queryAll.mockResolvedValue([])
    db.queryRun.mockResolvedValue({ changes:1 })
    bridgeWs.isBridgeAlive.mockReturnValue(true)
    bridgeWs.sendToBrowsers.mockResolvedValue({})
    marketData.mt5Bridge.mockResolvedValue({})

    // Re-import to get fresh module (clearAllMocks wipes mock implementations)
    const mod = await import('../../server/routes/ai/scheduler.js')
    reconcilePendingOrders = mod.reconcilePendingOrders
  })

  it('无 pending 行时直接返回', async () => {
    db.queryAll.mockResolvedValue([])
    await reconcilePendingOrders()
    expect(db.queryRun).not.toHaveBeenCalled()
    expect(marketData.mt5Bridge).not.toHaveBeenCalled()
  })

  it('still pending — ticket 在 pending_list 中，不改变状态', async () => {
    // First call: stale executing check (empty), Second call: delivery rows
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 1, user_id: 10, signal_id: 100, pending_ticket: '5001', pending_valid_until: '2026-12-31 23:59:59' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [{ ticket: 5001 }] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('filled — ticket 不在 pending_list 但在 positions 中', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 2, user_id: 10, signal_id: 200, pending_ticket: '5002', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [{ ticket: 5002 }] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const filledCall = db.queryRun.mock.calls.find(c => c[0].includes("'filled'"))
    expect(filledCall).toBeTruthy()
    expect(bridgeWs.sendToBrowsers.mock.calls.map(([, event]) => event)).toEqual([
      { type:'pending_filled', ticket:'5002', signal_id:200 },
      {
        type:'signal_execution_updated', signal_id:200, status:'success',
        reconciled:true, pending_state:'filled', trade_ticket:'5002',
      },
    ])
    expect(Math.max(...db.queryRun.mock.invocationCallOrder))
      .toBeLessThan(Math.min(...bridgeWs.sendToBrowsers.mock.invocationCallOrder))
  })

  it('does not broadcast successful fill events when outcome attribution persistence fails', async () => {
    db.queryAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 22, user_id: 10, signal_id: 2200, order_intent_id: 9220, pending_ticket: '5022', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])
    db.queryRun.mockImplementation(async sql => {
      if (String(sql).includes('signal_outcomes')) throw new Error('db_unavailable')
      return { changes:1 }
    })
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [{ ticket: 5022 }] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    expect(db.queryRun.mock.calls.some(c => c[0].includes('signal_outcomes'))).toBe(true)
    expect(db.queryRun.mock.calls.some(c => c[0].includes("pending_state = 'filled'"))).toBe(false)
    expect(bridgeWs.sendToBrowsers).not.toHaveBeenCalled()
  })

  it('marks a missing pending ticket filled from a targeted order lookup', async () => {
    db.queryAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 21, user_id: 10, signal_id: 2100, pending_ticket: '5021', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'order_lookup') return Promise.resolve({
        status:'success', found:true, kind:'pending', pending_state:'filled',
        ticket:'5021', position_id:'7021', deal:'8021',
      })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    expect(marketData.mt5Bridge).toHaveBeenCalledWith(10, 'order_lookup', {
      expected_kind:'pending', pending_ticket:'5021', lookback_seconds:30 * 24 * 60 * 60,
    }, { noFallback:true })
    expect(marketData.mt5Bridge.mock.calls.some(([, action]) => action === 'history')).toBe(false)
    const filledCall = db.queryRun.mock.calls.find(c => c[0].includes("'filled'"))
    expect(filledCall?.[1]?.[0]).toBe('7021')
  })

  it('expired — ticket 不在任一集合中，且已过有效期', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 3, user_id: 10, signal_id: 300, pending_ticket: '5003', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
      .mockResolvedValueOnce([])
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'order_lookup') return Promise.resolve({ status:'success', found:false, complete:true })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const expiredCall = db.queryRun.mock.calls.find(c => c[0].includes("'expired'"))
    expect(expiredCall).toBeTruthy()
  })

  it('cancelled — ticket 不在任一集合中，且未过有效期', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString().replace('T', ' ').slice(0, 19)
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 4, user_id: 10, signal_id: 400, pending_ticket: '5004', pending_valid_until: futureDate, src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const cancelledCall = db.queryRun.mock.calls.find(c => c[0].includes("'cancelled'"))
    expect(cancelledCall).toBeUndefined()
  })

  it('桥接离线时跳过该用户', async () => {
    bridgeWs.isBridgeAlive.mockReturnValue(false)
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 5, user_id: 20, signal_id: 500, pending_ticket: '5005', pending_valid_until: '2026-12-31 23:59:59', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows

    await reconcilePendingOrders()
    expect(marketData.mt5Bridge).not.toHaveBeenCalled()
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('pending_valid_until 为 null 时按 cancelled 处理（未过期分支）', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 6, user_id: 10, signal_id: 600, pending_ticket: '5006', pending_valid_until: null, src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const cancelledCall = db.queryRun.mock.calls.find(c => c[0].includes("'cancelled'"))
    expect(cancelledCall).toBeUndefined()
  })

  it('多用户并行处理', async () => {
    db.queryAll
      .mockResolvedValueOnce([])  // stale executing check
      .mockResolvedValueOnce([
        { id: 7, user_id: 10, signal_id: 700, pending_ticket: '5007', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' },
        { id: 8, user_id: 20, signal_id: 800, pending_ticket: '5008', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' },
      ])
      .mockResolvedValueOnce([])  // signal rows
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'order_lookup') return Promise.resolve({ status:'success', found:false, complete:true })
      return Promise.resolve({})
    })

    await reconcilePendingOrders()

    const expiredCalls = db.queryRun.mock.calls.filter(c => c[0].includes("'expired'"))
    expect(expiredCalls.length).toBe(2)
  })

  it('cancels an MT5 pending order after its configured validity expires', async () => {
    db.queryAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 9, user_id: 10, signal_id: 900, pending_ticket: '5009', pending_valid_until: '2020-01-01 00:00:00', src: 'delivery' }])
      .mockResolvedValueOnce([])
    marketData.mt5Bridge.mockImplementation((_uid, action) => {
      if (action === 'pending_list') return Promise.resolve({ orders: [{
        ticket: 5009, symbol: 'XAUUSD', side: 'buy', volume: 0.1, magic: 234000,
      }] })
      if (action === 'positions') return Promise.resolve({ positions: [] })
      if (action === 'cancel_pending') return Promise.resolve({ status: 'success', ticket: 5009 })
      return Promise.resolve({ status: 'error' })
    })

    await reconcilePendingOrders()

    expect(marketData.mt5Bridge).toHaveBeenCalledWith(10, 'cancel_pending', {
      ticket: '5009',
      expected_state: { ticket: '5009', symbol: 'XAUUSD', magic: 234000, volume: 0.1, direction: 'buy' },
    }, { noFallback: true })
    expect(db.queryRun.mock.calls.some(c => c[0].includes("pending_state = 'expired'"))).toBe(true)
  })
})
