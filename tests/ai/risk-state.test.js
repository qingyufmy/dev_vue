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
  refreshRiskAccountState, setGlobalKillSwitch, syncTradingAccountIdentity,
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
      increment: { requested_cursor: {}, through_cursor: {}, closed_positions: [], account_events: [] },
    }, DEFAULT_RISK_POLICY)
    expect(result).toMatchObject({ halt_status: 'active', halt_reason: null, data_complete: true })
    const update = updates.find(item => item.sql.startsWith('UPDATE risk_account_state'))
    expect(update.params).toContain('active')
    expect(update.params).toContain(1)
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
    const deposit = calculateAccountRiskMetrics({ ...snapshot({ account: { equity: 10500, currency: 'USD' }, historyAll: history([], { deposit: 1500 }), historyToday: history() }), previousState: { ...stateRow, cumulative_cash_flow: 1000, equity_high_water: 10000 } })
    expect(deposit.equity_high_water).toBe(10500)
    expect(deposit.drawdown_pct).toBe(0)
    const withdrawal = calculateAccountRiskMetrics({ ...snapshot({ account: { equity: 9500, currency: 'USD' }, historyAll: history([], { deposit: 500 }), historyToday: history() }), previousState: { ...stateRow, cumulative_cash_flow: 1000, equity_high_water: 10000 } })
    expect(withdrawal.equity_high_water).toBe(9500)
    expect(withdrawal.drawdown_pct).toBe(0)
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
      businessDate: '2026-07-15', previousState: {
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
      snapshot_complete: true, businessDate: '2026-07-15',
      previousState: { ...stateRow, last_deal_time_msc: 1000, last_deal_ticket: 10 },
      increment: {
        requested_cursor: { time_msc: 2000, ticket: 20 },
        through_cursor: { time_msc: 2000, ticket: 20 }, closed_positions: [], account_events: [],
      },
    })
    expect(result.data_complete).toBe(false)
    expect(result.data_incomplete_reasons).toContain('deal_cursor_gap')
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

  it('detects price/time duplicates beyond signal-id idempotency', async () => {
    const duplicate = { approved_order_json: JSON.stringify({ order_type: 'buy', reference_price: 2000.5 }) }
    const result = await evaluateStatefulRiskTx(runner({ duplicates: [duplicate] }), {
      userId: 2, accountId: 4, intentId: 9, request, policy: DEFAULT_RISK_POLICY, snapshot: snapshot(),
    })
    expect(result.reject_code).toBe('R2.4_PRICE_TIME_DUPLICATE')
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

  it('auto-verifies a Bridge account without an artificial observation limit and pauses old subscriptions on identity switch', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM trading_accounts WHERE user_id')) return [[{ id: 1, user_id:2, broker_server: 'Old', login_account: '1', is_deleted: 0 }], []]
      if (sql.startsWith('SELECT * FROM trading_accounts\n      WHERE UPPER')) return [[], []]
      if (sql.includes('FROM mt5_account_bindings')) return [[], []]
      writes.push(sql)
      if (sql.startsWith('INSERT INTO trading_accounts')) return [{ insertId: 2 }, []]
      return [{ affectedRows: 1 }, []]
    }))
    const result = await syncTradingAccountIdentity(2, { server: 'New', login: 9, trade_allowed:true }, 1)
    expect(result).toEqual({ accountId: 2, switched: true, verified: true, anomalyCode: null,
      ownershipTransferred:false, previousOwnerUserIds:[] })
    expect(writes.some(sql => sql.includes('strategy_subscriptions SET execution_enabled = 0'))).toBe(true)
    expect(writes.some(sql => sql.includes('INSERT INTO trading_accounts') && sql.includes('first_verified_at') && sql.includes('NULL'))).toBe(true)
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
