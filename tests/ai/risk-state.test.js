import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(), logAudit: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 21:00:00'),
  parseBeijing: vi.fn(value => value ? new Date(String(value).replace(' ', 'T') + '+08:00') : null),
}))
vi.mock('../../server/db.js', () => db)

import { DEFAULT_RISK_POLICY } from '../../server/routes/ai/risk-policy.js'
import {
  aggregateClosedPositions, calculateAccountRiskMetrics, consecutiveLossCooldownUntil, evaluateStatefulRiskTx,
  forceResetRiskAccountState, refreshRiskAccountState, RISK_CALCULATION_SEMANTIC_VERSION,
  setGlobalKillSwitch, syncTradingAccountIdentity,
} from '../../server/routes/ai/risk-state.js'

const accountRow = {
  id: 4, user_id: 2, review_status: 'approved', observe_status: 'active',
  observed_until: '2026-07-01 00:00:00', is_deleted: 0,
}
const stateRow = {
  trading_account_id: 4, user_id: 2, business_date: '2026-07-15', day_start_equity: 10000,
  cumulative_cash_flow: 0, equity_high_water: 10000, halt_status: 'active', user_kill_switch: 0,
}
const history = (orders = [], statistics = {}) => ({
  status: 'success', orders, statistics: { deposit: 0, withdrawal: 0, credit: 0, ...statistics },
  pagination: { total_count: orders.length },
})
const instrument = { contract_size: 100, volume_min: 0.01 }
const snapshot = (overrides = {}) => ({
  account: { equity: 10000, currency: 'USD', margin: 0, margin_level: 0 },
  positions: [], pending: [], historyToday: history(), historyAll: history(),
  instruments: { XAUUSD: instrument }, instrument, fxRates: {}, snapshot_complete: true,
  broker_calculation: { volume:0.01, required_margin:100 },
  ...overrides,
})
const request = { symbol: 'XAUUSD', order_type: 'buy', volume: 0.01, quote_price: 2000, reference_price: 2000, atr_anchor: 10 }
const identityRun = async sql => {
  if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[], []]
  if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[], []]
  if (sql.includes('FROM mt5_account_bindings')) return [[], []]
  if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId: 5 }, []]
  return [{ affectedRows: 1 }, []]
}

function runner({ state = stateRow, reserved = { volume: 0, daily_count: 0, notional: 0 }, successes = 0, latest = null, duplicates = [], updates = [] } = {}) {
  return vi.fn(async (sql, params = []) => {
    if (sql.includes('FROM trading_accounts')) return [[accountRow], []]
    if (sql.includes('FROM global_risk_control')) return [[{ global_kill_switch: 0 }], []]
    if (sql.includes('FROM risk_account_state')) return [[state], []]
    if (sql.includes('SUM(rr.reserved_volume)') || sql.includes('SUM(reserved_volume)')) return [[reserved], []]
    if (sql.includes('COUNT(*) AS count')) return [[{ count: successes }], []]
    if (sql.includes('ORDER BY completed_at')) return [latest ? [latest] : [], []]
    if (sql.includes('approved_order_json')) return [duplicates, []]
    if (sql.startsWith('UPDATE risk_account_state')) updates.push({ sql, params })
    return [{ affectedRows: 1 }, []]
  })
}

describe('account metrics', () => {
  it('clears a stale incomplete-data halt after a complete incremental snapshot', async () => {
    const updates = []
    db.withTransaction.mockImplementation(async fn => fn(runner({
      state: { ...stateRow, halt_status: 'halted', halt_reason: 'R3_RISK_DATA_INCOMPLETE', data_complete: 0 },
      updates,
    })))
    const result = await refreshRiskAccountState(2, 4, {
      account: { equity: 10000, currency: 'USD' }, positions: [], pending: [], instruments: {}, fxRates: {},
      snapshot_complete: true, risk_snapshot_version: 1, businessDate: '2026-07-15',
      timezone_offset_minutes:180, clock_status:'verified',
      increment: { requested_cursor: {}, through_cursor: {}, closed_positions: [], account_events: [] },
    }, DEFAULT_RISK_POLICY)
    expect(result).toMatchObject({ halt_status: 'active', halt_reason: null, data_complete: true })
    expect(result.transition).toMatchObject({ recovered:true, previous_reason:'R3_RISK_DATA_INCOMPLETE', next_status:'active' })
    expect(result.last_recovered_at).toBe('2026-07-15 21:00:00')
    const update = updates.find(item => item.sql.startsWith('UPDATE risk_account_state'))
    expect(update.params).toContain('active')
    expect(update.params).toContain(1)
    expect(update.sql).toContain('halt_started_at')
    expect(update.sql).toContain('last_recovered_at')
    expect(update.sql).toContain('manual_reset_business_date')
    expect(update.sql).toContain('risk_calculation_version')
  })

  it('aggregates partial closes by complete position', () => {
    const result = aggregateClosedPositions([
      { position_id: 7, profit: -10, commission: -1, close_time: '2026-07-15 10:00:00' },
      { position_id: 7, profit: 15, swap: -1, close_time: '2026-07-15 11:00:00' },
      { position_id: 8, profit: -2, fee: -1, close_time: '2026-07-15 12:00:00' },
    ])
    expect(result).toEqual([
      { position_id: '8', net: -3, close_time: '2026-07-15 12:00:00' },
      { position_id: '7', net: 3, close_time: '2026-07-15 11:00:00' },
    ])
  })

  it('uses Beijing daily baseline and includes fees plus floating loss', () => {
    const result = calculateAccountRiskMetrics({
      ...snapshot({
        account: { equity: 10870, currency: 'USD' },
        positions: [{ symbol: 'XAUUSD', volume: 0.01, price_current: 2000, profit: -100 }],
        historyToday: history([{ position_id: 1, profit: -20, commission: -5, swap: -2, fee: -3 }], { deposit: 1000 }),
        historyAll: history([{ position_id: 1, profit: -20, commission: -5, swap: -2, fee: -3 }], { deposit: 1000 }),
      }),
      previousState: {}, businessDate: '2026-07-15',
    })
    expect(result.realized).toBe(-30)
    expect(result.day_start_equity).toBe(10000)
    expect(result.daily_loss_pct).toBe(1.3)
  })

  it('corrects high-water equity for deposits and withdrawals', () => {
    const deposit = calculateAccountRiskMetrics({ ...snapshot({ account: { equity: 10500, currency: 'USD' }, historyAll: history([], { deposit: 1500 }), historyToday: history() }), previousState: { ...stateRow, cumulative_cash_flow: 1000, equity_high_water: 10000 }, businessDate:'2026-07-15' })
    expect(deposit.equity_high_water).toBe(10500)
    expect(deposit.drawdown_pct).toBe(0)
    const withdrawal = calculateAccountRiskMetrics({ ...snapshot({ account: { equity: 9500, currency: 'USD' }, historyAll: history([], { deposit: 500 }), historyToday: history() }), previousState: { ...stateRow, cumulative_cash_flow: 1000, equity_high_water: 10000 }, businessDate:'2026-07-15' })
    expect(withdrawal.equity_high_water).toBe(9500)
    expect(withdrawal.drawdown_pct).toBe(0)
  })

  it('resets daily loss and high-water drawdown on a new MT5 business date', () => {
    const result = calculateAccountRiskMetrics({
      risk_snapshot_version:1,
      account:{ equity:9200, currency:'USD' }, positions:[], pending:[], instruments:{}, fxRates:{},
      snapshot_complete:true, businessDate:'2026-07-16', timezone_offset_minutes:180,
      clock_status:'verified', previousState:{ ...stateRow, day_realized_net:-200 },
      increment:{ requested_cursor:{}, through_cursor:{}, closed_positions:[], account_events:[] },
    })
    expect(result.day_start_equity).toBe(9200)
    expect(result.daily_loss_pct).toBe(0)
    expect(result.equity_high_water).toBe(9200)
    expect(result.drawdown_pct).toBe(0)
    expect(result.data_complete).toBe(true)
  })

  it('uses the manual reset floating baseline instead of counting unchanged open loss', () => {
    const previousState = { ...stateRow, risk_calculation_version:RISK_CALCULATION_SEMANTIC_VERSION,
      manual_reset_business_date:'2026-07-15', manual_reset_floating_baseline:-900,
      day_realized_net:0, day_start_equity:10000, last_deal_time_msc:1000, last_deal_ticket:10 }
    const base = {
      risk_snapshot_version:1, account:{ equity:10000, currency:'USD' }, pending:[], instruments:{}, fxRates:{},
      snapshot_complete:true, businessDate:'2026-07-15', timezone_offset_minutes:180, clock_status:'verified', previousState,
      increment:{ requested_cursor:{ time_msc:1000, ticket:10 }, through_cursor:{ time_msc:1000, ticket:10 }, closed_positions:[], account_events:[] },
    }
    const unchanged = calculateAccountRiskMetrics({ ...base,
      positions:[{ symbol:'XAUUSD', profit:-900 }] })
    expect(unchanged).toMatchObject({ day_floating_pnl:0, daily_loss_pct:0 })

    const worsened = calculateAccountRiskMetrics({ ...base,
      account:{ equity:9900, currency:'USD' }, positions:[{ symbol:'XAUUSD', profit:-1000 }] })
    expect(worsened).toMatchObject({ day_floating_pnl:-100, daily_loss_pct:1 })

    const closed = calculateAccountRiskMetrics({ ...base, account:{ equity:10000, currency:'USD' }, positions:[],
      increment:{ requested_cursor:{ time_msc:1000, ticket:10 }, through_cursor:{ time_msc:2000, ticket:20 },
        closed_positions:[{ close_time_msc:2000, close_deal_ticket:20, business_date:'2026-07-15', net:-900 }], account_events:[] } })
    expect(closed).toMatchObject({ realized:-900, day_floating_pnl:900, daily_loss_pct:0 })
  })

  it('clears the manual reset baseline when the MT5 business date changes', () => {
    const result = calculateAccountRiskMetrics({
      risk_snapshot_version:1, account:{ equity:9200, currency:'USD' }, positions:[], pending:[], instruments:{}, fxRates:{},
      snapshot_complete:true, businessDate:'2026-07-16', timezone_offset_minutes:180, clock_status:'verified',
      previousState:{ ...stateRow, risk_calculation_version:RISK_CALCULATION_SEMANTIC_VERSION,
        manual_reset_business_date:'2026-07-15', manual_reset_floating_baseline:-900, day_realized_net:0 },
      increment:{ requested_cursor:{}, through_cursor:{}, closed_positions:[], account_events:[] },
    })
    expect(result).toMatchObject({ manual_reset_business_date:null, manual_reset_floating_baseline:null,
      day_floating_pnl:0, daily_loss_pct:0 })
  })

  it('rebases legacy same-day high-water on a trusted first snapshot without clearing realized loss', () => {
    const result = calculateAccountRiskMetrics({
      risk_snapshot_version:1, account:{ equity:9500, currency:'USD' }, positions:[], pending:[], instruments:{}, fxRates:{},
      snapshot_complete:true, businessDate:'2026-07-15', timezone_offset_minutes:180, clock_status:'verified',
      previousState:{ ...stateRow, risk_calculation_version:0, day_realized_net:-300,
        day_start_equity:10000, equity_high_water:12000 },
      increment:{ requested_cursor:{}, through_cursor:{}, closed_positions:[], account_events:[] },
    })
    expect(result).toMatchObject({ realized:-300, equity_high_water:9500, drawdown_pct:0,
      risk_calculation_version:RISK_CALCULATION_SEMANTIC_VERSION, risk_calculation_rebased:true })
  })

  it('fails closed when full position history was paginated', () => {
    const result = calculateAccountRiskMetrics({ ...snapshot({ historyAll: { ...history(), pagination: { total_count: 2 } } }), previousState: stateRow })
    expect(result.data_complete).toBe(false)
  })

  it('applies only incremental MT5 events after the persisted cursor', () => {
    const result = calculateAccountRiskMetrics({
      risk_snapshot_version: 1,
      account: { equity: 9920, currency: 'USD' },
      positions: [{ symbol: 'XAUUSD', volume: 0.01, price_current: 2000, profit: -20 }],
      pending: [], instruments: { XAUUSD: instrument }, fxRates: {}, snapshot_complete: true,
      businessDate: '2026-07-15', timezone_offset_minutes:180, clock_status:'verified', previousState: {
        ...stateRow, day_realized_net: -10, consecutive_losses: 1,
        cumulative_cash_flow: 1000, last_deal_time_msc: 1000, last_deal_ticket: 10,
      },
      increment: {
        requested_cursor: { time_msc: 1000, ticket: 10 },
        through_cursor: { time_msc: 3000, ticket: 30 },
        closed_positions: [
          { position_id: 1, close_time_msc: 1000, close_deal_ticket: 10, business_date: '2026-07-15', net: -99 },
          { position_id: 2, close_time_msc: 2000, close_deal_ticket: 20, business_date: '2026-07-15', net: -30 },
        ],
        account_events: [
          { time_msc: 3000, ticket: 30, business_date: '2026-07-15', category: 'capital', amount: 500 },
        ],
      },
    })
    expect(result.realized).toBe(-40)
    expect(result.consecutive_losses).toBe(2)
    expect(result.cumulative_cash_flow).toBe(1500)
    expect(result.last_deal_time_msc).toBe(3000)
    expect(result.data_complete).toBe(true)
  })

  it('anchors consecutive-loss cooldown to the actual threshold-crossing close time', () => {
    const policy = { ...DEFAULT_RISK_POLICY, consecutive_loss_limit:3, loss_cooldown_minutes:120 }
    const oldCrossingUtcMs = Date.parse('2026-07-17T20:00:00Z')
    const metrics = { consecutive_losses:4, timezone_offset_minutes:180, loss_streak_events:[
      { previous_count:2, count:3, close_time_msc:oldCrossingUtcMs + 180 * 60000, close_time_utc_msc:oldCrossingUtcMs },
      { previous_count:3, count:4, close_time_msc:oldCrossingUtcMs + 3600000 + 180 * 60000, close_time_utc_msc:oldCrossingUtcMs + 3600000 },
    ] }
    expect(consecutiveLossCooldownUntil(metrics, 2, policy, Date.parse('2026-07-20T01:20:00Z'))).toBeNull()
    expect(consecutiveLossCooldownUntil(metrics, 2, policy, Date.parse('2026-07-17T20:30:00Z'))).toBe('2026-07-18 06:00:00')
  })

  it('fails closed with a specific reason when the Bridge cursor skips ahead', () => {
    const result = calculateAccountRiskMetrics({
      risk_snapshot_version: 1, account: { equity: 10000, currency: 'USD' },
      positions: [], pending: [], instruments: { XAUUSD: instrument }, fxRates: {},
      snapshot_complete: true, businessDate: '2026-07-15', timezone_offset_minutes:180, clock_status:'verified',
      previousState: { ...stateRow, last_deal_time_msc: 1000, last_deal_ticket: 10 },
      increment: {
        requested_cursor: { time_msc: 2000, ticket: 20 },
        through_cursor: { time_msc: 2000, ticket: 20 }, closed_positions: [], account_events: [],
      },
    })
    expect(result.data_complete).toBe(false)
    expect(result.data_incomplete_reasons).toContain('deal_cursor_gap')
  })

  it('fails closed when an incremental snapshot has no verified terminal clock', () => {
    const result = calculateAccountRiskMetrics({
      risk_snapshot_version:1, account:{ equity:10000, currency:'USD' }, positions:[], pending:[],
      instruments:{}, fxRates:{}, snapshot_complete:true, businessDate:'2026-07-15',
      increment:{ requested_cursor:{}, through_cursor:{}, closed_positions:[], account_events:[] },
    })
    expect(result.data_complete).toBe(false)
    expect(result.data_incomplete_reasons).toContain('terminal_clock_unverified')
  })

  it('force-resets the current MT5-day risk counters and audits the override', async () => {
    const updates = []
    const run = runner({
      state:{ ...stateRow, halt_status:'halted', halt_reason:'R3.3_MAX_DRAWDOWN',
        day_realized_net:-500, day_floating_pnl:-200, drawdown_pct:9, consecutive_losses:4,
        cooldown_until:'2026-07-16 10:00:00', last_deal_time_msc:1000, last_deal_ticket:10 },
      updates,
    })
    db.withTransaction.mockImplementation(async fn => fn(run))
    const result = await forceResetRiskAccountState(2, 4, {
      account:{ equity:9300, currency:'USD' }, positions:[{ symbol:'XAUUSD', profit:-900, swap:0 }], snapshot_complete:true,
      risk_snapshot_version:1, data_incomplete_reasons:[],
      businessDate:'2026-07-15', timezone_offset_minutes:180, clock_status:'verified',
      increment:{ through_cursor:{ time_msc:2000, ticket:20 } },
    }, '用户确认恢复')
    expect(result).toMatchObject({ manual_reset:true, halt_status:'active', halt_reason:null,
      business_date:'2026-07-15', day_realized_net:0, day_floating_pnl:0,
      manual_reset_business_date:'2026-07-15', manual_reset_floating_baseline:-900,
      equity_high_water:9300, drawdown_pct:0, consecutive_losses:0,
      risk_calculation_version:RISK_CALCULATION_SEMANTIC_VERSION })
    const update = updates.find(item => item.sql.startsWith('UPDATE risk_account_state'))
    expect(update.sql).toContain("halt_status = 'active'")
    expect(update.sql).toContain('day_realized_net = 0')
    expect(update.sql).toContain('manual_reset_floating_baseline')
    expect(update.params).toContain(2000)
    expect(run.mock.calls.some(([sql]) => String(sql).includes("'risk_account_manual_reset'"))).toBe(true)
  })

  it('refuses a manual reset unless the incremental MT5 snapshot is complete and verified', async () => {
    const run = runner({ state:{ ...stateRow, halt_status:'halted', halt_reason:'R3.3_MAX_DRAWDOWN' } })
    db.withTransaction.mockImplementation(async fn => fn(run))
    const base = {
      account:{ equity:9300, currency:'USD' }, positions:[], snapshot_complete:true,
      risk_snapshot_version:1, data_incomplete_reasons:[], businessDate:'2026-07-15',
      timezone_offset_minutes:180, clock_status:'verified', increment:{ through_cursor:{} },
    }
    await expect(forceResetRiskAccountState(2, 4,
      { ...base, data_incomplete_reasons:['positions_incomplete'] }, '用户确认恢复'))
      .rejects.toThrow('risk_manual_reset_snapshot_unverified')
    await expect(forceResetRiskAccountState(2, 4,
      { ...base, risk_snapshot_version:0 }, '用户确认恢复'))
      .rejects.toThrow('risk_manual_reset_snapshot_unverified')
    expect(run.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE risk_account_state'))).toBe(false)
  })
})

describe('stateful gate', () => {
  it('does not apply the retired same-direction exposure cap', async () => {
    const result = await evaluateStatefulRiskTx(runner(), {
      userId: 2, accountId: 4, intentId: 9, request: { ...request, volume: 0.02 }, policy: DEFAULT_RISK_POLICY,
      snapshot: snapshot({ positions: [{ symbol: 'XAUUSD', type: 'buy', volume: 0.09, price_current: 2000 }] }),
    })
    expect(result.reject_code).toBeUndefined()
  })

  it('enforces daily count including active reservations', async () => {
    const observedRunner = runner({ reserved: { volume: 0, daily_count: 2, notional: 0 }, successes: 8 })
    const result = await evaluateStatefulRiskTx(observedRunner, {
      userId: 2, accountId: 4, intentId: 9, request, policy: { ...DEFAULT_RISK_POLICY, max_daily_open_count:10 }, snapshot: snapshot(),
    })
    expect(result.reject_code).toBe('R2.3_DAILY_OPEN_COUNT')
    const reservationQuery = observedRunner.mock.calls.find(call => String(call[0]).includes('SUM(rr.reserved_volume)'))?.[0]
    expect(reservationQuery).toContain("rr.expires_at > NOW() OR oi.status IN ('bridge_sending','uncertain')")
  })

  it('observes an adjustable state rule in shadow mode without blocking the order', async () => {
    const result = await evaluateStatefulRiskTx(runner({ reserved: { volume: 0, daily_count: 2, notional: 0 }, successes: 8 }), {
      userId: 2, accountId: 4, intentId: 9, request, policy: { ...DEFAULT_RISK_POLICY, max_daily_open_count:10 }, snapshot: snapshot(),
      ruleModes: { 'R2.3_DAILY_OPEN_COUNT': { mode: 'shadow', forced: false } },
    })
    expect(result.reject_code).toBeUndefined()
    expect(result.shadow_rules).toContainEqual(expect.objectContaining({ code: 'R2.3_DAILY_OPEN_COUNT', outcome: 'shadow_reject' }))
  })

  it('automatically clears a persisted halt after current risk conditions recover', async () => {
    const updates = []
    const result = await evaluateStatefulRiskTx(runner({ state: { ...stateRow, halt_status: 'halted', halt_reason: 'R3.3_MAX_DRAWDOWN' }, updates }), {
      userId: 2, accountId: 4, intentId: 9, request, policy: DEFAULT_RISK_POLICY, snapshot: snapshot(),
    })
    expect(result.reject_code).toBeUndefined()
    expect(updates[0].params).toContain('active')
    expect(updates[0].sql).toContain('manual_reset_floating_baseline')
    expect(updates[0].sql).toContain('risk_calculation_version')
  })

  it('does not re-arm an expired consecutive-loss cooldown without a new threshold crossing', async () => {
    const losses = [
      { position_id: 3, profit: -1, close_time: '2026-07-15 12:00:00' },
      { position_id: 2, profit: -1, close_time: '2026-07-15 11:00:00' },
      { position_id: 1, profit: -1, close_time: '2026-07-15 10:00:00' },
    ]
    const result = await evaluateStatefulRiskTx(runner({ state: { ...stateRow, consecutive_losses: 3, cooldown_until: '2020-01-01 00:00:00' } }), {
      userId: 2, accountId: 4, intentId: 9, request,
      policy: { ...DEFAULT_RISK_POLICY, consecutive_loss_limit: 3 },
      snapshot: snapshot({ historyAll: history(losses) }),
    })
    expect(result.reject_code).toBeUndefined()
  })

  it('persists a fail-closed halt when history is incomplete', async () => {
    const updates = []
    const result = await evaluateStatefulRiskTx(runner({ updates }), {
      userId: 2, accountId: 4, intentId: 9, request, policy: DEFAULT_RISK_POLICY,
      snapshot: snapshot({ historyAll: { status: 'error' } }),
    })
    expect(result.reject_code).toBe('R3_RISK_DATA_INCOMPLETE')
    expect(updates[0].params).toContain('halted')
  })

  it('allows a near-price order from a different signal and leaves idempotency to order intents', async () => {
    const duplicate = { approved_order_json: JSON.stringify({ order_type: 'buy', reference_price: 2000.5 }) }
    const observedRunner = runner({ duplicates: [duplicate] })
    const result = await evaluateStatefulRiskTx(observedRunner, {
      userId: 2, accountId: 4, intentId: 9, request, policy: DEFAULT_RISK_POLICY, snapshot: snapshot(),
    })
    expect(result).toMatchObject({ approved_volume: request.volume, adjusted:false })
    expect(result.reject_code).toBeUndefined()
    expect(observedRunner.mock.calls.some(([sql]) => String(sql).includes('approved_order_json'))).toBe(false)
  })

  it('does not cap an approved order merely because the account is newly connected', async () => {
    const observedRunner = runner()
    observedRunner.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM trading_accounts')) return [[{ ...accountRow, observed_until: '2099-01-01 00:00:00' }], []]
      return runner()(sql, params)
    })
    const result = await evaluateStatefulRiskTx(observedRunner, {
      userId: 2, accountId: 4, intentId: 9, request: { ...request, volume: 0.03 },
      policy: DEFAULT_RISK_POLICY, snapshot: snapshot(),
    })
    expect(result).toMatchObject({ adjusted: false, approved_volume: 0.03 })
  })

  it('does not apply the retired projected margin-level threshold', async () => {
    const result = await evaluateStatefulRiskTx(runner({ state:{ ...stateRow, day_start_equity:1000, equity_high_water:1000 } }), {
      userId:2, accountId:4, intentId:9, request,
      policy:DEFAULT_RISK_POLICY,
      snapshot:snapshot({ account:{ equity:1000, currency:'USD', margin:200, margin_level:500 },
        broker_calculation:{ volume:0.01, required_margin:200 } }),
    })
    expect(result.reject_code).toBeUndefined()
    expect(result).not.toHaveProperty('projected_margin_level_pct')
  })

  it('does not require an MT5 projected-margin calculation', async () => {
    const result = await evaluateStatefulRiskTx(runner(), {
      userId:2, accountId:4, intentId:9, request,
      policy:DEFAULT_RISK_POLICY,
      snapshot:snapshot({ broker_calculation:null }),
    })
    expect(result.reject_code).toBeUndefined()
  })

  it('serializes 20 attempts so reservations cannot exceed the daily limit', async () => {
    let reservations = 0
    let lock = Promise.resolve()
    const attempt = () => {
      const next = lock.then(async () => {
        const result = await evaluateStatefulRiskTx(runner({ reserved: { volume: 0, daily_count: reservations, notional: 0 } }), {
          userId: 2, accountId: 4, intentId: 100 + reservations, request,
          policy: { ...DEFAULT_RISK_POLICY, max_daily_open_count: 3 }, snapshot: snapshot(),
        })
        if (!result.reject_code) reservations += 1
        return result
      })
      lock = next.catch(() => {})
      return next
    }
    const results = await Promise.all(Array.from({ length: 20 }, attempt))
    expect(results.filter(result => !result.reject_code)).toHaveLength(3)
    expect(results.filter(result => result.reject_code === 'R2.3_DAILY_OPEN_COUNT')).toHaveLength(17)
  })
})

describe('identity and platform permissions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retries the whole identity transaction once after a MySQL deadlock', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
    const delays = []
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      delays.push(delay)
      callback()
      return 0
    })
    db.withTransaction.mockImplementationOnce(async () => { throw deadlock })
    db.withTransaction.mockImplementation(async callback => callback(identityRun))

    try {
      await expect(syncTradingAccountIdentity(2, { server: 'Demo', login: 123, trade_allowed: true }))
        .resolves.toMatchObject({ accountId: 5, verified: true })
    } finally {
      timer.mockRestore()
    }

    expect(db.withTransaction).toHaveBeenCalledTimes(2)
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBeGreaterThanOrEqual(10)
    expect(delays[0]).toBeLessThanOrEqual(20)
  })

  it('stops after three MySQL deadlock transaction attempts', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { errno: 1213 })
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(callback => {
      callback()
      return 0
    })
    db.withTransaction.mockImplementation(async () => { throw deadlock })

    try {
      await expect(syncTradingAccountIdentity(2, { server: 'Demo', login: 123, trade_allowed: true }))
        .rejects.toBe(deadlock)
    } finally {
      timer.mockRestore()
    }

    expect(db.withTransaction).toHaveBeenCalledTimes(3)
  })

  it('does not retry an ordinary transaction error even when its message mentions deadlock', async () => {
    const error = new Error('ER_LOCK_DEADLOCK')
    db.withTransaction.mockImplementation(async () => { throw error })

    await expect(syncTradingAccountIdentity(2, { server: 'Demo', login: 123, trade_allowed: true }))
      .rejects.toBe(error)
    expect(db.withTransaction).toHaveBeenCalledTimes(1)
  })

  it('serializes same-identity syncs while allowing a failed flight to be retried', async () => {
    let txCount = 0
    let active = 0
    let maxActive = 0
    let resolveStarted
    const started = new Promise(resolve => { resolveStarted = resolve })
    let releaseFirst
    const firstGate = new Promise(resolve => { releaseFirst = resolve })
    db.withTransaction.mockImplementation(async callback => {
      txCount += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (txCount === 1) resolveStarted()
      if (txCount === 1) await firstGate
      try {
        return await callback(identityRun)
      } finally {
        active -= 1
      }
    })

    const first = syncTradingAccountIdentity(2, { server: ' Demo ', login: '123', trade_allowed: true })
    await started
    const second = syncTradingAccountIdentity(3, { server: 'demo', login: 123, trade_allowed: true })
    await Promise.resolve()
    expect(txCount).toBe(1)
    expect(maxActive).toBe(1)
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(txCount).toBe(2)

    const failure = new Error('identity transaction failed')
    db.withTransaction.mockImplementationOnce(async () => { throw failure })
    await expect(syncTradingAccountIdentity(2, { server: 'DEMO', login: '123', trade_allowed: true }))
      .rejects.toBe(failure)
    await expect(syncTradingAccountIdentity(2, { server: 'demo', login: '123', trade_allowed: true }))
      .resolves.toMatchObject({ accountId: 5, verified: true })
  })

  it('runs different-identity syncs in parallel', async () => {
    let txCount = 0
    let active = 0
    let maxActive = 0
    let resolveFirstStarted, resolveSecondStarted
    const firstStarted = new Promise(resolve => { resolveFirstStarted = resolve })
    const secondStarted = new Promise(resolve => { resolveSecondStarted = resolve })
    const releases = []
    db.withTransaction.mockImplementation(async callback => {
      txCount += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      if (txCount === 1) resolveFirstStarted()
      if (txCount === 2) resolveSecondStarted()
      await new Promise(resolve => { releases.push(resolve) })
      try {
        return await callback(identityRun)
      } finally {
        active -= 1
      }
    })

    const first = syncTradingAccountIdentity(2, { server: 'Demo-A', login: 123, trade_allowed: true })
    await firstStarted
    const second = syncTradingAccountIdentity(2, { server: 'Demo-B', login: 123, trade_allowed: true })
    await secondStarted
    expect(txCount).toBe(2)
    expect(maxActive).toBe(2)
    releases.forEach(resolve => resolve())
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('emits ownership audit side effects only once after a retried transaction succeeds', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { sqlState: '40001' })
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(callback => {
      callback()
      return 0
    })
    db.withTransaction.mockImplementationOnce(async () => { throw deadlock })
    db.withTransaction.mockImplementation(async callback => callback(async sql => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[{ id: 99, user_id: 8, observe_status: 'active' }], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[{ current_user_id: 8, current_trading_account_id: 99 }], []]
      if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId: 5 }, []]
      if (sql.includes('SELECT id FROM mt5_account_ownership_history')) return [[], []]
      return [{ affectedRows: 1 }, []]
    }))

    try {
      await expect(syncTradingAccountIdentity(2, { server: 'Demo', login: 123, trade_allowed: true }))
        .resolves.toMatchObject({ ownershipTransferred: true, previousOwnerUserIds: [8] })
    } finally {
      timer.mockRestore()
    }

    expect(db.withTransaction).toHaveBeenCalledTimes(2)
    expect(db.logAudit).toHaveBeenCalledTimes(2)
    expect(db.logAudit.mock.calls.map(([entry]) => entry.action)).toEqual([
      'mt5_account_ownership_acquired', 'mt5_account_ownership_transferred',
    ])
  })

  it('persists the Bridge-reported account margin mode instead of assuming netting', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[], []]
      writes.push({ sql, params })
      if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId:5 }, []]
      return [{ affectedRows:1 }, []]
    }))

    await expect(syncTradingAccountIdentity(2, {
      server:'Broker-Demo', login:123, trade_allowed:true, source:'mt4', margin_mode:-1,
    })).resolves.toMatchObject({ accountId:5, verified:true })
    const insert = writes.find(write => write.sql.startsWith('INSERT INTO trading_accounts'))
    expect(insert.params[3]).toBe('hedging')
  })

  it('auto-verifies a Bridge account and migrates existing subscriptions to the connected account', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[{ id: 1, user_id:2, broker_server: 'Old', login_account: '1', is_deleted: 0 }], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[], []]
      writes.push({ sql, params })
      if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId: 2 }, []]
      return [{ affectedRows: 1 }, []]
    }))
    const result = await syncTradingAccountIdentity(2, { server: 'New', login: 9, trade_allowed:true }, 1)
    expect(result).toEqual({ accountId: 2, switched: true, verified: true, anomalyCode: null,
      ownershipTransferred:false, previousOwnerUserIds:[] })
    const subscriptionMigration = writes.find(write => write.sql.includes('strategy_subscriptions SET trading_account_id = ?'))
    expect(subscriptionMigration?.params).toEqual([2, '2026-07-15 21:00:00', 2, 1])
    expect(writes.some(write => write.sql.includes('strategy_subscriptions SET execution_enabled = 0'))).toBe(false)
    expect(writes.some(write => write.sql.includes('INSERT INTO trading_accounts') && write.sql.includes('first_verified_at') && write.sql.includes('NULL'))).toBe(true)
  })

  it('automatically transfers a trade-authorized duplicate MT5 account to the latest user', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async sql => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[{ id:99, user_id:8, observe_status:'active' }], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[{ current_user_id:8, current_trading_account_id:99 }], []]
      if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId: 3 }, []]
      writes.push(sql)
      return [{ affectedRows: 1 }, []]
    }))
    const result = await syncTradingAccountIdentity(2, { server: 'Demo', login: 123, trade_allowed:true })
    expect(result).toEqual({ accountId:3, switched:false, verified:true, anomalyCode:null,
      ownershipTransferred:true, previousOwnerUserIds:[8] })
    expect(writes.some(sql => sql.includes("observe_status = 'transferred'"))).toBe(true)
    expect(writes.some(sql => sql.includes('UPDATE auto_scheduler SET enabled = 0'))).toBe(true)
    expect(db.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action:'mt5_account_ownership_acquired' }))
  })

  it('does not repeat an ownership transfer when the bound owner reconnects beside a switched historical row', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async sql => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[{
        id:3, user_id:2, broker_server:'Demo', login_account:'123', is_deleted:0,
        observe_status:'active',
      }], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[
        { id:3, user_id:2, broker_server:'Demo', login_account:'123', observe_status:'active' },
        { id:99, user_id:8, broker_server:'Demo', login_account:'123', observe_status:'switched' },
      ], []]
      if (sql.includes('FROM mt5_account_bindings')) {
        return [[{ current_user_id:2, current_trading_account_id:3 }], []]
      }
      if (sql.includes('SELECT id FROM mt5_account_ownership_history')) return [[], []]
      writes.push(sql)
      return [{ affectedRows:1 }, []]
    }))

    const result = await syncTradingAccountIdentity(
      2,
      { server:'Demo', login:123, trade_allowed:true }
    )

    expect(result).toEqual({
      accountId:3, switched:false, verified:true, anomalyCode:null,
      ownershipTransferred:false, previousOwnerUserIds:[],
    })
    expect(writes.some(sql => sql.includes('UPDATE auto_scheduler SET enabled = 0'))).toBe(false)
    expect(writes.some(sql => sql.includes('user_bridge_settings'))).toBe(false)
    expect(db.logAudit).not.toHaveBeenCalledWith(expect.objectContaining({
      action:'mt5_account_ownership_acquired',
    }))
  })

  it('does not transfer ownership from a bridge without account trading permission', async () => {
    db.withTransaction.mockImplementation(async fn => fn(async sql => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[{ id:99, user_id:8, observe_status:'active' }], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[{ current_user_id:8, current_trading_account_id:99 }], []]
      if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId: 3 }, []]
      return [{ affectedRows: 1 }, []]
    }))
    const result = await syncTradingAccountIdentity(2, { server:'Demo', login:123, trade_allowed:false })
    expect(result).toEqual({ accountId:3, switched:false, verified:false,
      anomalyCode:'account_trade_permission_required', ownershipTransferred:false, previousOwnerUserIds:[] })
  })

  it('clears legacy administrator-review state after Bridge identity verification', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[{
        id: 7, broker_server: 'Demo', login_account: '123', is_deleted: 0,
        review_status: 'rejected', observe_status: 'frozen', anomaly_code: 'admin_rejected',
      }], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[{
        id:7, user_id:2, broker_server:'Demo', login_account:'123', observe_status:'frozen',
      }], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[], []]
      writes.push({ sql, params })
      return [{ affectedRows: 1 }, []]
    }))
    const result = await syncTradingAccountIdentity(2, { server: 'Demo', login: 123, trade_allowed:true })
    expect(result).toEqual({ accountId:7, switched:false, verified:true, anomalyCode:null,
      ownershipTransferred:false, previousOwnerUserIds:[] })
    const accountUpdate = writes.find(write => write.sql.includes('first_verified_at = COALESCE'))
    expect(accountUpdate.params[0]).toBe('approved')
    expect(accountUpdate.params[1]).toBe('active')
  })

  it('clears a stale ownership-transfer halt when the authorized account reconnects', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async sql => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[{
        id:7, user_id:2, broker_server:'Demo', login_account:'123', is_deleted:0,
        review_status:'approved', observe_status:'transferred', anomaly_code:'account_transferred',
      }], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[{
        id:7, user_id:2, broker_server:'Demo', login_account:'123', observe_status:'transferred',
      }], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[{ current_user_id:2, current_trading_account_id:7 }], []]
      writes.push(sql)
      return [{ affectedRows:1 }, []]
    }))

    await expect(syncTradingAccountIdentity(2, { server:'Demo', login:123, trade_allowed:true }))
      .resolves.toMatchObject({ accountId:7, verified:true })
    const stateWrite = writes.find(sql => sql.includes('INSERT INTO risk_account_state'))
    expect(stateWrite).toContain("halt_reason IN ('R6_ACCOUNT_TRADE_PERMISSION_REQUIRED', 'R6_ACCOUNT_TRANSFERRED')")
    expect(stateWrite).toContain('data_incomplete_reason = CASE')
  })

  it('only admins can clear the global kill switch', async () => {
    await expect(setGlobalKillSwitch(2, 'user', false, 'ok')).rejects.toThrow('admin_required')
  })
})
