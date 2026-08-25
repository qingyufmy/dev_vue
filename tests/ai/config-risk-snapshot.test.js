import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryOne:vi.fn(), queryRun:vi.fn(), prepareIntent:vi.fn(), resolvePolicy:vi.fn(), evaluateCoreRisk:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  queryOne:(...args) => mocks.queryOne(...args),
  queryAll:vi.fn(() => []),
  queryRun:(...args) => mocks.queryRun(...args),
  withTransaction:vi.fn(),
  beijingNow:() => '2026-08-05 20:00:00',
  parseBeijing:() => new Date('2026-08-05T12:00:00.000Z'),
}))

vi.mock('../../server/routes/ai/order-intents.js', () => ({
  prepareAndExecuteOrderIntent:(...args) => mocks.prepareIntent(...args),
}))

vi.mock('../../server/routes/ai/risk-policy.js', () => ({
  DEFAULT_AI_VOLUME_STEP:0.01,
  evaluateCoreRisk:mocks.evaluateCoreRisk,
  persistRiskDecision:vi.fn(),
  resolveEffectiveRiskPolicy:(...args) => mocks.resolvePolicy(...args),
  resolvePlatformAiVolumeRange:vi.fn(),
}))

vi.mock('../../server/routes/ai/risk-state.js', () => ({
  AUTO_RECOVERABLE_RISK_REASONS:[
    'R3_RISK_DATA_INCOMPLETE', 'R3.1_DAILY_LOSS_LIMIT',
    'R3.2_CONSECUTIVE_LOSS_COOLDOWN', 'R3.3_MAX_DRAWDOWN',
  ],
  evaluateStatefulRiskTx:vi.fn(), syncTradingAccountIdentity:vi.fn(),
}))

vi.mock('../../server/routes/ai/rollout-governance.js', () => ({
  getRiskRuleRolloutModes:vi.fn(() => ({})),
}))

vi.mock('../../server/routes/ai/terminal-clock.js', () => ({
  applyDefaultObserverClockBootstrap:vi.fn(), trustedTerminalClock:vi.fn(),
  buildExecutionClockContext:vi.fn(({ userId, tradingAccountId, brokerServer, login, clock = {}, capturedAtUtcMsc }) => ({
    user_id:Number(userId), trading_account_id:Number(tradingAccountId), terminal_instance_id:null,
    broker_server:String(brokerServer || ''), login:String(login || ''),
    timezone_offset_minutes:clock.timezone_offset_minutes ?? null,
    clock_status:String(clock.clock_status || ''), clock_source:'risk_snapshot_terminal',
    captured_at_utc_msc:Number(capturedAtUtcMsc) || null, calibration_age_ms:null,
  })),
}))
vi.mock('../../server/routes/ai/observer-channels.js', () => ({ getDefaultObserverSourceClock:vi.fn() }))
vi.mock('../../server/routes/ai/audit-clock.js', () => ({
  auditTradingAccountId:vi.fn(() => null),
  buildAuditClockSnapshot:vi.fn(() => ({
    trading_account_id:null, created_at_utc_msc:Date.now(), terminal_timezone_offset_minutes:null,
    terminal_clock_status:'unavailable', terminal_clock_source:'',
  })),
}))

import { ADMIN_DIRECTED_ORDER_MAGIC, executeAdminDirectedOrderCore, executeOrderCore } from '../../server/routes/ai/config.js'

describe('executeOrderCore risk snapshot sizing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryRun.mockResolvedValue({ affectedRows:1 })
    mocks.queryOne.mockResolvedValue({
      last_deal_time_msc:0, last_deal_ticket:0, incremental_baseline_at:'2026-08-05 20:00:00',
    })
    mocks.resolvePolicy.mockResolvedValue({
      policy:{ max_position_size:0.5 }, policyVersionIds:[12],
    })
    mocks.prepareIntent.mockImplementation(async options => {
      const bridge = vi.fn(async (_userId, action) => {
        if (action !== 'risk_snapshot') throw new Error(`unexpected_bridge_action:${action}`)
        return {
          status:'success', complete:true, positions:[], pending:[],
          instruments:{ XAUUSD:{
            name:'XAUUSD', currency_profit:'USD', volume_min:0.01, volume_max:100,
            volume_step:0.01, tick_size:0.01, tick_value:1, contract_size:100,
            digits:2, point:0.01, trade_mode:4,
          } },
        }
      })
      const prepared = { ...options.request }
      const context = await options.loadRiskContext({
        bridge, actorId:7, tradingAccountId:9, request:prepared,
        account:{ equity:10_000, currency:'USD' }, quote:{ bid:4100, ask:4100.2 }, bridgeOptions:{},
      })
      const snapshotCall = bridge.mock.calls.find(call => call[1] === 'risk_snapshot')
      expect(context.instrument_validation).toMatchObject({ valid:true, status:'legacy', reasons:[] })
      return {
        status:'success',
        proposed_volume:snapshotCall[2].proposed_order.volume,
        prepared_volume:prepared.volume,
        policy_version_ids:context.risk_policy_version_ids,
      }
    })
  })

  it('keeps the model tier sentinel at zero but sends a positive policy volume for MT5 loss calculation', async () => {
    const result = await executeOrderCore(7, {}, {
      symbol:'XAUUSD', order_type:'buy', entry_method:'market', volume:0,
      position_size_tier:'light', position_size_factor:0.5,
      sl:4090, atr_anchor:10, signal_id:9500,
    }, 'ai_auto_execute', { tradingAccountId:9, sourceType:'auto_delivery' })

    expect(result).toMatchObject({
      status:'success', prepared_volume:0, proposed_volume:0.5, policy_version_ids:[12],
    })
  })

  it('executes an admin-directed order without AI risk evaluation and preserves dispatch fences', async () => {
    const beforeBridgeSend = vi.fn()
    const beforeBridgeSendTx = vi.fn()
    let intentOptions
    mocks.prepareIntent.mockImplementationOnce(async options => {
      intentOptions = options
      const risk = await options.validateRequest({}, {}, { ...options.request })
      expect(risk.approved_order).toMatchObject({
        sl:null, tp:null, stop_loss_price:null, take_profit_1_price:null,
        magic:ADMIN_DIRECTED_ORDER_MAGIC,
      })
      expect(risk.original_order).toMatchObject({ sl:null, tp:null })
      return { status:'success', order_intent_id:321 }
    })

    const result = await executeAdminDirectedOrderCore(7, {}, {
      symbol:'EURUSD', order_type:'buy', entry_method:'market', volume:0.37,
      sl:null, tp:null, stop_loss_price:null, take_profit_1_price:null,
      confirm:true, trading_account_id:9, signal_id:null,
    }, 'admin_strategy_source', {
      tradingAccountId:9, sourceType:'admin_strategy_source',
      sourceId:'77:dispatch:5:target:1', magic:ADMIN_DIRECTED_ORDER_MAGIC,
      beforeBridgeSend, beforeBridgeSendTx,
    })

    expect(result).toMatchObject({ status:'success', order_intent_id:321 })
    expect(intentOptions).toMatchObject({
      userId:7, tradingAccountId:9, signalId:null,
      sourceType:'admin_strategy_source', sourceId:'77:dispatch:5:target:1',
      action:'admin_strategy_source', request:expect.objectContaining({ sl:null, tp:null }),
      beforeBridgeSend:expect.anything(), beforeBridgeSendTx:expect.anything(),
    })
    expect(intentOptions.options).toMatchObject({ noFallback:true, magic:ADMIN_DIRECTED_ORDER_MAGIC })
    expect(intentOptions.beforeBridgeSend).toBe(beforeBridgeSend)
    expect(intentOptions.beforeBridgeSendTx).toBe(beforeBridgeSendTx)
    expect(intentOptions.loadRiskContext).toBeUndefined()
    expect(intentOptions.statefulValidate).toBeUndefined()
    expect(mocks.evaluateCoreRisk).not.toHaveBeenCalled()
    expect(mocks.resolvePolicy).not.toHaveBeenCalled()
  })
})
