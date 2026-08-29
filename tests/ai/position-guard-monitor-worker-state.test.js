import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const previousPositionGuardFeature = process.env.POSITION_GUARD_FEATURE_ENABLED
process.env.POSITION_GUARD_FEATURE_ENABLED = 'true'

const mocks = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-26 09:00:00'),
  parseBeijing:vi.fn(() => null),
  queryAll:vi.fn(),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
  getBridgeDataRoute:vi.fn(),
  getBridgeGeneration:vi.fn(() => 7),
  getOwnBridgeMarketState:vi.fn(() => ({ alive:true, isOpen:true, reason:'market_open' })),
  mt5Bridge:vi.fn(),
  getPlatformRates:vi.fn(),
  evaluatePositionGuard:vi.fn(),
  getPositionGuardQuote:vi.fn(),
  getPositionGuardQuoteCacheMetrics:vi.fn(() => ({})),
  getPositionGuardGlobalControl:vi.fn(),
  listEnabledPositionGuardAccounts:vi.fn(),
  requestPositionManagementWorkerRun:vi.fn(),
  stripBrokerSuffix:vi.fn(value => String(value ?? '').split('.')[0]),
}))

vi.mock('../../server/db.js', () => ({
  beijingNow:mocks.beijingNow,
  parseBeijing:mocks.parseBeijing,
  queryAll:mocks.queryAll,
  queryOne:mocks.queryOne,
  queryRun:mocks.queryRun,
  withTransaction:mocks.withTransaction,
}))
vi.mock('../../server/bridge-ws.js', () => ({
  getBridgeDataRoute:mocks.getBridgeDataRoute,
  getBridgeGeneration:mocks.getBridgeGeneration,
  getOwnBridgeMarketState:mocks.getOwnBridgeMarketState,
}))
vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:mocks.mt5Bridge }))
vi.mock('../../server/routes/ai/platform-market-data.js', () => ({ getPlatformRates:mocks.getPlatformRates }))
vi.mock('../../server/routes/ai/position-guard-engine.js', () => ({
  evaluatePositionGuard:mocks.evaluatePositionGuard,
}))
vi.mock('../../server/routes/ai/position-guard-quote-cache.js', () => ({
  getPositionGuardQuote:mocks.getPositionGuardQuote,
  getPositionGuardQuoteCacheMetrics:mocks.getPositionGuardQuoteCacheMetrics,
}))
vi.mock('../../server/routes/ai/position-guard.js', () => ({
  getPositionGuardGlobalControl:mocks.getPositionGuardGlobalControl,
  listEnabledPositionGuardAccounts:mocks.listEnabledPositionGuardAccounts,
}))
vi.mock('../../server/routes/ai/position-management-worker.js', () => ({
  requestPositionManagementWorkerRun:mocks.requestPositionManagementWorkerRun,
}))
vi.mock('../../server/routes/ai/utils.js', () => ({ stripBrokerSuffix:mocks.stripBrokerSuffix }))

const {
  resetPositionGuardMonitorForTests,
  runPositionGuardMonitorOnce,
  requestPositionGuardMonitorRun,
  startPositionGuardMonitorWorker,
} = await import('../../server/workers/position-guard-monitor-worker.js')

const account = {
  user_id:1,
  trading_account_id:2,
  ownership_history_id:3,
  broker_server_key:'Broker-Server',
  login_account:'123456',
}

afterAll(() => {
  if (previousPositionGuardFeature === undefined) delete process.env.POSITION_GUARD_FEATURE_ENABLED
  else process.env.POSITION_GUARD_FEATURE_ENABLED = previousPositionGuardFeature
})
const outcome = {
  id:7,
  user_id:1,
  trading_account_id:2,
  ownership_history_id:3,
  status:'open',
  attribution_status:'attributed',
  external_intervention:0,
  position_id:'100',
  original_symbol:'XAUUSD.s',
  entry_direction:'buy',
  system_magic:234000,
  strategy_id:11,
  strategy_version:1,
  thesis_id:'thesis-1',
  management_group_id:'group-1',
}
const state = {
  id:9,
  outcome_id:7,
  user_id:1,
  trading_account_id:2,
  ownership_history_id:3,
  ticket:'100',
  original_symbol:'XAUUSD.s',
  standard_symbol:'XAUUSD',
  profile_version_id:4,
  config_hash:'config-hash',
  state_version:2,
  pivot_business_date:'2026-08-26',
  pivot_snapshot_json:JSON.stringify({ d1:{ high:2310, low:2290, close:2300 } }),
  pivot_cross_since_utc_ms:null,
  pivot_tp_done:0,
  first_target_done:0,
  break_even_pending:0,
  break_even_done:0,
  pending_task_id:null,
  completed_at:null,
  retry_after:null,
}
const profile = {
  version_id:4,
  profile_id:2,
  version_no:1,
  config_json:JSON.stringify({ pivot_method:'fibonacci' }),
  config_hash:'config-hash',
  standard_symbol:'XAUUSD',
  config:{ pivot_method:'fibonacci' },
}
const quote = {
  observed_at_utc_msc:Date.parse('2026-08-26T00:00:00.000Z'),
  timezone_offset_minutes:480,
  bid:2300,
  ask:2300.1,
}

describe('position guard monitor database state compatibility', () => {
  beforeEach(() => {
    resetPositionGuardMonitorForTests()
    vi.clearAllMocks()
    mocks.beijingNow.mockReturnValue('2026-08-26 09:00:00')
    mocks.parseBeijing.mockReturnValue(null)
    mocks.getPositionGuardGlobalControl.mockResolvedValue({ enabled:true })
    mocks.listEnabledPositionGuardAccounts.mockResolvedValue([account])
    mocks.getBridgeDataRoute.mockReturnValue({
      terminal_instance_id:'terminal-1',
      connection_epoch:8,
      account_ref:'account-1',
      platform:'mt5',
    })
    mocks.queryAll.mockResolvedValue([outcome])
    mocks.queryOne.mockImplementation(async sql => (
      sql.includes('FROM position_guard_position_states') ? state : profile
    ))
    mocks.queryRun.mockResolvedValue({ changes:1 })
    mocks.mt5Bridge.mockImplementation(async (_userId, operation) => {
      if (operation === 'system_trade_inventory') {
        return {
          status:'success',
          account:{ server:'Broker-Server', login:'123456' },
          positions:[{
            ticket:'100', symbol:'XAUUSD.s', type:'buy', magic:234000,
            volume:0.01, price_open:2299, sl:0, tp:0,
          }],
        }
      }
      return {
        status:'success',
        instrument:{
          digits:2, point:0.01, trade_tick_size:0.01,
          volume_min:0.01, volume_step:0.01,
        },
      }
    })
    mocks.evaluatePositionGuard.mockReturnValue({
      ok:false,
      error:{ code:'invalid_stage_state_flag' },
    })
  })

  it('records evaluation failures from a MySQL-shaped state without creating a task', async () => {
    const result = await runPositionGuardMonitorOnce({
      now:Date.parse('2026-08-26T00:00:01.000Z'),
      quoteProvider:vi.fn(async () => ({ ok:true, quote })),
    })

    expect(result).toMatchObject({ skipped:false, active:1, evaluated:1, created:0 })
    expect(mocks.evaluatePositionGuard).toHaveBeenCalledWith(expect.objectContaining({
      stage_state:state,
    }))
    expect(mocks.queryRun).toHaveBeenCalledTimes(1)
    const [sql, params] = mocks.queryRun.mock.calls[0]
    expect(sql).toContain('SET last_evaluated_at = ?, last_error_code = ?, updated_at = ?')
    expect(params).toEqual([
      '2026-08-26 09:00:00',
      'invalid_stage_state_flag',
      '2026-08-26 09:00:00',
      state.id,
      state.state_version,
    ])
    expect(mocks.withTransaction).not.toHaveBeenCalled()
    expect(mocks.requestPositionManagementWorkerRun).not.toHaveBeenCalled()
  })

  it('skips a trusted market closure before reading outcomes or inventory', async () => {
    mocks.getOwnBridgeMarketState.mockReturnValue({
      alive:true, isOpen:false, reason:'market_closed', tradeMode:0,
    })

    const result = await runPositionGuardMonitorOnce({
      now:Date.parse('2026-08-26T00:00:01.000Z'),
      quoteProvider:vi.fn(),
    })

    expect(result).toMatchObject({ skipped:false, active:0, evaluated:0, created:0 })
    expect(mocks.getOwnBridgeMarketState).toHaveBeenCalledWith(account.user_id)
    expect(mocks.queryAll).not.toHaveBeenCalled()
    expect(mocks.queryOne).not.toHaveBeenCalled()
    expect(mocks.mt5Bridge).not.toHaveBeenCalled()
    expect(mocks.evaluatePositionGuard).not.toHaveBeenCalled()
    expect(mocks.requestPositionManagementWorkerRun).not.toHaveBeenCalled()
  })

  it('rechecks a closed account on the slower cadence and resumes when open', async () => {
    const closedState = { alive:true, isOpen:false, reason:'market_closed', tradeMode:0 }
    const openState = { alive:true, isOpen:true, reason:'market_open', tradeMode:4 }
    mocks.getOwnBridgeMarketState.mockReturnValue(closedState)
    const first = await runPositionGuardMonitorOnce({
      now:Date.parse('2026-08-26T00:00:01.000Z'), quoteProvider:vi.fn(),
    })
    expect(first).toMatchObject({ evaluated:0, created:0 })

    mocks.getOwnBridgeMarketState.mockReturnValue(openState)
    const beforeRetry = await runPositionGuardMonitorOnce({
      now:Date.parse('2026-08-26T00:00:30.000Z'), quoteProvider:vi.fn(),
    })
    expect(beforeRetry).toMatchObject({ evaluated:0, created:0 })
    expect(mocks.getOwnBridgeMarketState).toHaveBeenCalledTimes(1)

    const afterRetry = await runPositionGuardMonitorOnce({
      now:Date.parse('2026-08-26T00:01:01.000Z'), quoteProvider:vi.fn(async () => ({ ok:false })),
    })
    expect(afterRetry).toMatchObject({ skipped:false, evaluated:0, created:0 })
    expect(mocks.getOwnBridgeMarketState).toHaveBeenCalledTimes(2)
    expect(mocks.queryAll).toHaveBeenCalled()
  })

  it('fails closed before reading the database when the deployment gate is off', async () => {
    const previous = process.env.POSITION_GUARD_FEATURE_ENABLED
    delete process.env.POSITION_GUARD_FEATURE_ENABLED
    try {
      resetPositionGuardMonitorForTests()
      vi.clearAllMocks()
      const result = await runPositionGuardMonitorOnce({
        quoteProvider:vi.fn(),
      })
      expect(result).toEqual({
        skipped:true,
        reason:'position_guard_feature_disabled',
        evaluated:0,
        created:0,
      })
      expect(mocks.getPositionGuardGlobalControl).not.toHaveBeenCalled()
      expect(mocks.listEnabledPositionGuardAccounts).not.toHaveBeenCalled()
      expect(mocks.queryAll).not.toHaveBeenCalled()
      expect(mocks.queryOne).not.toHaveBeenCalled()
      expect(mocks.queryRun).not.toHaveBeenCalled()
      expect(mocks.mt5Bridge).not.toHaveBeenCalled()
      expect(requestPositionGuardMonitorRun()).toEqual({ skipped:true, reason:'position_guard_feature_disabled' })
      expect(startPositionGuardMonitorWorker()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.POSITION_GUARD_FEATURE_ENABLED
      else process.env.POSITION_GUARD_FEATURE_ENABLED = previous
    }
  })
})
