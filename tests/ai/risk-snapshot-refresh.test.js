import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), sendBridgeCommand:vi.fn(), isBridgeAlive:vi.fn(),
  getBridgeDataRoute:vi.fn(), resolvePolicy:vi.fn(), refreshRiskAccountState:vi.fn(),
  forceResetRiskAccountState:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  queryAll:(...args) => mocks.queryAll(...args),
  queryOne:(...args) => mocks.queryOne(...args),
  parseBeijing:value => value ? new Date(String(value).replace(' ', 'T') + '+08:00') : null,
}))
vi.mock('../../server/bridge-ws.js', () => ({
  sendBridgeCommand:(...args) => mocks.sendBridgeCommand(...args),
  isBridgeAlive:(...args) => mocks.isBridgeAlive(...args),
  getBridgeDataRoute:(...args) => mocks.getBridgeDataRoute(...args),
}))
vi.mock('../../server/routes/ai/risk-policy.js', () => ({
  resolveEffectiveRiskPolicy:(...args) => mocks.resolvePolicy(...args),
}))
vi.mock('../../server/routes/ai/risk-state.js', () => ({
  AUTO_RECOVERABLE_RISK_REASONS:[
    'R3_RISK_DATA_INCOMPLETE', 'R3.1_DAILY_LOSS_LIMIT',
    'R3.2_CONSECUTIVE_LOSS_COOLDOWN', 'R3.3_MAX_DRAWDOWN',
  ],
  forceResetRiskAccountState:(...args) => mocks.forceResetRiskAccountState(...args),
  refreshRiskAccountState:(...args) => mocks.refreshRiskAccountState(...args),
}))

import { refreshRecoverableRiskAccounts } from '../../server/routes/ai/risk-snapshot-refresh.js'

const route = {
  terminal_instance_id:'terminal-1', connection_generation:7,
  account_ref:{ broker_server:'Demo-Server', login:'839069' }, platform:'mt5',
}
const row = (overrides = {}) => ({
  trading_account_id:4, broker_server:'Demo-Server', login_account:'839069',
  first_verified_at:'2026-08-25 08:00:00', halt_status:'halted',
  halt_reason:'R3.3_MAX_DRAWDOWN', user_kill_switch:0, data_complete:1,
  last_deal_time_msc:0, last_deal_ticket:0, last_risk_snapshot_at:null,
  ...overrides,
})
const completeSnapshot = () => ({
  status:'success', complete:true, snapshot_version:1,
  account:{ server:'Demo-Server', login:'839069', currency:'USD', equity:10_000 },
  positions:[], pending:[], instruments:{}, incomplete_reasons:[],
  timezone_offset_minutes:180, clock_status:'verified', business_date:'2026-08-25',
  increment:{ requested_cursor:{}, through_cursor:{}, closed_positions:[], account_events:[] },
})

describe('recoverable risk snapshot refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isBridgeAlive.mockReturnValue(true)
    mocks.getBridgeDataRoute.mockReturnValue(route)
    mocks.queryAll.mockResolvedValue([row()])
    mocks.queryOne.mockResolvedValue({ symbol:'XAUUSD' })
    mocks.sendBridgeCommand.mockResolvedValue(completeSnapshot())
    mocks.resolvePolicy.mockResolvedValue({ policy:{ daily_loss_limit_pct:8, max_drawdown_pct:8 } })
    mocks.refreshRiskAccountState.mockResolvedValue({
      halt_status:'active', halt_reason:null, data_complete:true,
      transition:{ recovered:true },
    })
    mocks.forceResetRiskAccountState.mockResolvedValue({
      halt_status:'active', halt_reason:null, data_complete:true, manual_reset:true,
    })
  })

  it('selects recoverable R3 states and binds every snapshot to the exact terminal route', async () => {
    const result = await refreshRecoverableRiskAccounts(2)
    expect(result).toMatchObject({ attempted:1, refreshed:1, recovered:1, bridge_connected:true })
    const [sql, params] = mocks.queryAll.mock.calls[0]
    expect(sql).toContain('ras.halt_reason IN')
    expect(sql).toContain('ras.user_kill_switch = 0')
    expect(sql).toContain("ras.halt_status <> 'protection_incident'")
    expect(sql).toContain("ras.halt_reason NOT LIKE 'R6_%'")
    expect(params).toEqual([2,
      'R3_RISK_DATA_INCOMPLETE', 'R3.1_DAILY_LOSS_LIMIT',
      'R3.2_CONSECUTIVE_LOSS_COOLDOWN', 'R3.3_MAX_DRAWDOWN'])
    const snapshotCall = mocks.sendBridgeCommand.mock.calls.find(call => call[1] === 'risk_snapshot')
    expect(snapshotCall[2]).toMatchObject({
      terminal_instance_id:'terminal-1', account_ref:route.account_ref,
    })
    expect(snapshotCall[4]).toMatchObject({ noFallback:true })
    expect(mocks.refreshRiskAccountState).toHaveBeenCalledTimes(1)
  })

  it('does not update state after a failed Bridge snapshot', async () => {
    mocks.sendBridgeCommand.mockResolvedValue({ status:'error', error:'bridge_timeout' })
    const result = await refreshRecoverableRiskAccounts(2)
    expect(result).toMatchObject({ attempted:1, refreshed:0, recovered:0, recoverable_remaining:1 })
    expect(mocks.refreshRiskAccountState).not.toHaveBeenCalled()
  })

  it('coalesces concurrent refreshes for one account and terminal generation', async () => {
    let resolveSnapshot
    mocks.sendBridgeCommand.mockReturnValue(new Promise(resolve => { resolveSnapshot = resolve }))
    const first = refreshRecoverableRiskAccounts(2)
    const second = refreshRecoverableRiskAccounts(2)
    await Promise.resolve()
    resolveSnapshot(completeSnapshot())
    const [left, right] = await Promise.all([first, second])
    expect(left.refreshed).toBe(1)
    expect(right.refreshed).toBe(1)
    expect(mocks.sendBridgeCommand.mock.calls.filter(call => call[1] === 'risk_snapshot')).toHaveLength(1)
  })

  it('does not write state when the exact route changes during quote enrichment', async () => {
    const replacement = { ...route, terminal_instance_id:'terminal-2' }
    let routeReads = 0
    mocks.getBridgeDataRoute.mockImplementation(() => {
      routeReads += 1
      return routeReads >= 3 ? replacement : route
    })
    mocks.sendBridgeCommand.mockImplementation((userId, command) => command === 'risk_snapshot'
      ? { ...completeSnapshot(), positions:[{ symbol:'EURUSD' }], instruments:{ EURUSD:{ name:'EURUSD', currency_profit:'EUR' } } }
      : { status:'success', bid:1, ask:1 })
    const result = await refreshRecoverableRiskAccounts(2)
    expect(result).toMatchObject({ attempted:1, refreshed:0, recovered:0 })
    expect(result.results[0].error).toBe('bridge_route_changed')
    expect(mocks.refreshRiskAccountState).not.toHaveBeenCalled()
  })

  it('allows only a targeted active account refresh after a policy save', async () => {
    mocks.queryAll.mockResolvedValue([row({ halt_status:'active', halt_reason:null, data_complete:1 })])
    mocks.refreshRiskAccountState.mockResolvedValue({ halt_status:'active', halt_reason:null, data_complete:true, transition:null })
    const result = await refreshRecoverableRiskAccounts(2, { accountId:4, includeActive:true, trigger:'policy_save' })
    expect(result).toMatchObject({ attempted:1, refreshed:1, recovered:0 })
    const [sql] = mocks.queryAll.mock.calls[0]
    expect(sql).toContain('OR ta.id = ?')
    expect(sql).toContain('AND ta.id = ?')
    expect(mocks.refreshRiskAccountState).toHaveBeenCalledWith(2, 4,
      expect.objectContaining({ risk_refresh_trigger:'policy_save' }), expect.anything())
  })

  it('uses a verified targeted snapshot for an audited manual reset', async () => {
    const result = await refreshRecoverableRiskAccounts(2, {
      accountId:4, forceReset:true, resetReason:'用户确认恢复', trigger:'risk_center_manual_reset',
    })
    expect(result).toMatchObject({ attempted:1, refreshed:1, recovered:1 })
    expect(result.results[0]).toMatchObject({ manual_reset:true })
    expect(mocks.queryAll.mock.calls[0][0]).toContain('OR ta.id = ?')
    expect(mocks.forceResetRiskAccountState).toHaveBeenCalledWith(2, 4,
      expect.objectContaining({ businessDate:'2026-08-25', timezone_offset_minutes:180,
        clock_status:'verified', snapshot_complete:true }), '用户确认恢复')
    expect(mocks.refreshRiskAccountState).not.toHaveBeenCalled()
  })

  it('waits for an ordinary flight, then re-fetches the strict route for one manual reset', async () => {
    let snapshotCalls = 0
    let releaseOrdinary
    const ordinarySnapshot = new Promise(resolve => { releaseOrdinary = resolve })
    mocks.sendBridgeCommand.mockImplementation((userId, command) => {
      if (command !== 'risk_snapshot') return { status:'success', bid:1, ask:1 }
      snapshotCalls += 1
      return snapshotCalls === 1 ? ordinarySnapshot : completeSnapshot()
    })
    const ordinary = refreshRecoverableRiskAccounts(2)
    await vi.waitFor(() => expect(snapshotCalls).toBe(1))
    const manual = refreshRecoverableRiskAccounts(2, {
      accountId:4, includeActive:true, forceReset:true,
      resetReason:'用户确认恢复', trigger:'risk_center_manual_reset',
    })
    releaseOrdinary(completeSnapshot())
    const [ordinaryResult, manualResult] = await Promise.all([ordinary, manual])
    expect(ordinaryResult.refreshed).toBe(1)
    expect(manualResult.results[0]).toMatchObject({ refreshed:true, manual_reset:true })
    expect(snapshotCalls).toBe(2)
    expect(mocks.refreshRiskAccountState).toHaveBeenCalledTimes(1)
    expect(mocks.forceResetRiskAccountState).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent manual resets into one forced snapshot and write', async () => {
    let releaseSnapshot
    const snapshot = new Promise(resolve => { releaseSnapshot = resolve })
    let snapshotCalls = 0
    mocks.sendBridgeCommand.mockImplementation((userId, command) => {
      if (command !== 'risk_snapshot') return { status:'success', bid:1, ask:1 }
      snapshotCalls += 1
      return snapshot
    })
    const first = refreshRecoverableRiskAccounts(2, {
      accountId:4, includeActive:true, forceReset:true,
      resetReason:'用户确认恢复', trigger:'risk_center_manual_reset',
    })
    await vi.waitFor(() => expect(snapshotCalls).toBe(1))
    const second = refreshRecoverableRiskAccounts(2, {
      accountId:4, includeActive:true, forceReset:true,
      resetReason:'重复点击', trigger:'risk_center_manual_reset',
    })
    releaseSnapshot(completeSnapshot())
    const [left, right] = await Promise.all([first, second])
    expect(left.results[0]).toMatchObject({ manual_reset:true })
    expect(right.results[0]).toMatchObject({ manual_reset:true })
    expect(snapshotCalls).toBe(1)
    expect(mocks.forceResetRiskAccountState).toHaveBeenCalledTimes(1)
  })
})
