import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryOne:vi.fn(), queryRun:vi.fn(), prepareIntent:vi.fn(), resolvePolicy:vi.fn(),
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
  evaluateCoreRisk:vi.fn(),
  persistRiskDecision:vi.fn(),
  resolveEffectiveRiskPolicy:(...args) => mocks.resolvePolicy(...args),
  resolvePlatformAiVolumeRange:vi.fn(),
}))

vi.mock('../../server/routes/ai/risk-state.js', () => ({
  evaluateStatefulRiskTx:vi.fn(), syncTradingAccountIdentity:vi.fn(),
}))

vi.mock('../../server/routes/ai/rollout-governance.js', () => ({
  getRiskRuleRolloutModes:vi.fn(() => ({})),
}))

vi.mock('../../server/routes/ai/terminal-clock.js', () => ({
  applyDefaultObserverClockBootstrap:vi.fn(), trustedTerminalClock:vi.fn(),
}))
vi.mock('../../server/routes/ai/observer-channels.js', () => ({ getDefaultObserverSourceClock:vi.fn() }))
vi.mock('../../server/routes/ai/audit-clock.js', () => ({
  auditTradingAccountId:vi.fn(() => null),
  buildAuditClockSnapshot:vi.fn(() => ({
    trading_account_id:null, created_at_utc_msc:Date.now(), terminal_timezone_offset_minutes:null,
    terminal_clock_status:'unavailable', terminal_clock_source:'',
  })),
}))

import { executeOrderCore } from '../../server/routes/ai/config.js'

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
            volume_step:0.01, tick_size:0.01, tick_value:1,
          } },
        }
      })
      const prepared = { ...options.request }
      const context = await options.loadRiskContext({
        bridge, actorId:7, tradingAccountId:9, request:prepared,
        account:{ equity:10_000, currency:'USD' }, quote:{ bid:4100, ask:4100.2 }, bridgeOptions:{},
      })
      const snapshotCall = bridge.mock.calls.find(call => call[1] === 'risk_snapshot')
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
})
