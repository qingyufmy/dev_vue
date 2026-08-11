import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-22 10:00:00'),
  parseBeijing: vi.fn(value => value ? new Date(String(value).replace(' ', 'T') + '+08:00') : null),
}))
vi.mock('../../server/db.js', () => db)

import {
  nextPerformanceWindow,
  normalizePerformanceDay,
  recentPerformanceWindow,
  saveAccountPerformanceChunk,
  getAccountPerformanceSummary,
  getAccountPerformanceSyncWindow,
  LEGACY_ACCOUNT_PERFORMANCE_SOURCE,
  getLegacyAccountPerformanceSummary,
} from '../../server/routes/ai/account-performance.js'

const context = {
  id:11, user_id:7, broker_server:'DooTechnology-Demo', login_account:'596520',
  first_verified_at:'2026-01-01 10:00:00', first_connected_at:'2026-01-01 10:00:00', ownership_history_id:91,
  ownership_started_at:'2026-07-01 09:00:00', account_currency:'USD', synced_through_date:'2026-07-20',
}

function payload() {
  return {
    status:'success', performance_version:1, date_from:'2026-07-21', date_to:'2026-07-22',
    timezone_offset_minutes:180,
    account:{ server:'DooTechnology-Demo', login:'596520', currency:'USD' },
    daily:[{
      business_date:'2026-07-21', trade_profit:12, commission:-1, swap:-0.5, fee:0,
      pnl_adjustment:0, realized_net:10.5, deposit:100, withdrawal:0, credit_change:0,
      other_capital_change:0, exit_deal_count:1, closed_position_count:1,
      winning_exit_count:1, losing_exit_count:0, closed_volume:0.02, data_complete:true,
    }],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('MT5 account performance windows', () => {
  it('continues catch-up in bounded 31-day chunks', () => {
    expect(nextPerformanceWindow({ firstConnectedAt:'2026-01-01', syncedThroughDate:null, today:'2026-03-15' }))
      .toEqual({ date_from:'2026-01-01', date_to:'2026-01-31' })
    expect(nextPerformanceWindow({ firstConnectedAt:'2026-01-01', syncedThroughDate:'2026-03-15', today:'2026-03-15' }))
      .toBeNull()
  })

  it('limits reconciliation to the current ownership period', () => {
    expect(recentPerformanceWindow({ firstConnectedAt:'2026-07-20', today:'2026-07-22', overlapDays:7 }))
      .toEqual({ date_from:'2026-07-20', date_to:'2026-07-22' })
  })

  it('keeps the stable binding start when ownership was rebound later', async () => {
    const run = vi.fn(async sql => sql.includes('FROM trading_accounts ta')
      ? [[{ ...context, first_connected_at:'2026-01-01 10:00:00', ownership_started_at:'2026-07-01 09:00:00',
        synced_through_date:null,
        timezone_offset_minutes:0, clock_status:'persisted' }], []]
      : [{ affectedRows:1 }, []])
    db.withTransaction.mockImplementation(fn => fn(run))

    const window = await getAccountPerformanceSyncWindow(7, 11)
    expect(window.first_connected_at).toBe('2026-01-01 10:00:00')
    expect(window.date_from).toBe('2026-01-01')
    const select = run.mock.calls.find(([sql]) => sql.includes('FROM trading_accounts ta'))[0]
    expect(select).toContain('bindings.first_connected_at')
    expect(select).not.toContain('ownership.started_at AS ownership_started_at')
  })

  it('rejects an inconsistent realized-net total', () => {
    expect(() => normalizePerformanceDay({ business_date:'2026-07-22', trade_profit:1, realized_net:2 }))
      .toThrow('performance_realized_net_mismatch')
  })

  it('uses the account terminal date and accepts a persisted offset while the market is closed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T23:30:00Z'))
    const run = vi.fn(async sql => sql.includes('FROM trading_accounts ta')
      ? [[{ ...context, timezone_offset_minutes:-120, clock_status:'persisted_stale' }], []]
      : [{ affectedRows:1 }, []])
    db.withTransaction.mockImplementation(fn => fn(run))

    const window = await getAccountPerformanceSyncWindow(7, 11)

    expect(window).toMatchObject({ date_from:'2026-07-21', date_to:'2026-07-22',
      timezone_offset_minutes:-120, clock_status:'persisted_stale' })
    vi.useRealTimers()
  })

  it('does not create a performance window before the account terminal clock is verified', async () => {
    const run = vi.fn(async sql => sql.includes('FROM trading_accounts ta')
      ? [[{ ...context, timezone_offset_minutes:null, clock_status:'unknown' }], []]
      : [{ affectedRows:1 }, []])
    db.withTransaction.mockImplementation(fn => fn(run))

    await expect(getAccountPerformanceSyncWindow(7, 11)).rejects.toThrow('terminal_clock_unverified')
    expect(run.mock.calls.some(([sql]) => sql.includes('INSERT INTO mt5_account_performance_sync_state'))).toBe(false)
  })

  it('uses the recent default observer clock for a first install on the same broker server', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T23:30:00Z'))
    const run = vi.fn(async sql => sql.includes('FROM trading_accounts ta')
      ? [[{ ...context, timezone_offset_minutes:null, clock_status:'unknown' }], []]
      : [{ affectedRows:1 }, []])
    db.withTransaction.mockImplementation(fn => fn(run))
    db.queryOne.mockResolvedValue({
      source_id:4, bridge_user_id:88, trading_account_id:44,
      broker_server:'dootechnology-demo', timezone_offset_minutes:-120,
      source_clock_status:'persisted_stale',
      last_calibrated_at_utc_msc:Date.now() - 2 * 24 * 60 * 60 * 1000,
    })

    const window = await getAccountPerformanceSyncWindow(7, 11)

    expect(window).toMatchObject({
      timezone_offset_minutes:-120, clock_status:'observer_bootstrap',
      clock_source:'default_observer_source', source_clock_status:'persisted_stale',
    })
    vi.useRealTimers()
  })
})

describe('MT5 account performance persistence', () => {
  it('marks the retained MySQL compatibility summary as legacy', async () => {
    db.queryOne.mockResolvedValue({ ownership_period_count:1, realized_net:12 })
    const result = await getLegacyAccountPerformanceSummary(11, 7)
    expect(result).toMatchObject({ ownership_period_count:1, realized_net:12,
      source:LEGACY_ACCOUNT_PERFORMANCE_SOURCE })
  })

  it('keeps the default risk-center path on Bridge SQLite summaries', () => {
    const source = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
    const bridgeSource = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
    const start = source.indexOf("router.get('/ai/risk-center', authMiddleware")
    const end = source.indexOf("router.post('/ai/risk-center/refresh'", start)
    const route = source.slice(start, end)
    expect(route).toContain('getBridgePerformanceSummary')
    expect(route).not.toContain('getAccountPerformanceSummary')
    expect(route).toContain('Promise.all')
    expect(bridgeSource).toContain("sendBridgeCommand(numericUserId, action, params, 5_000")
  })

  it('scopes account totals and sync state to the requested owner', async () => {
    db.queryOne.mockResolvedValue({ ownership_period_count:1 })

    await getAccountPerformanceSummary(11, 7)

    const [sql, params] = db.queryOne.mock.calls[0]
    expect(sql).toContain('owner.user_id = ?')
    expect(sql).toContain('state_owner.user_id = ?')
    expect(params).toEqual([11, 7, 11, 7, 11, 7, 11, 7])
  })

  it('keys daily data by ownership period and does not advance catch-up cursor during reconciliation', async () => {
    let syncParams = null
    const run = vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM trading_accounts ta')) return [[context], []]
      if (sql.includes('FROM mt5_account_performance_daily')) return [[{
        period_start_date:'2026-07-21', period_end_date:'2026-07-21', realized_net:10.5,
        deposit:100, withdrawal:0, credit_change:0, other_capital_change:0,
        exit_deal_count:1, closed_position_count:1, winning_exit_count:1,
        losing_exit_count:0, closed_volume:0.02, data_complete:1,
      }], []]
      if (sql.includes('INSERT INTO mt5_account_performance_sync_state')) syncParams = params
      return [{ affectedRows:1 }, []]
    })
    db.withTransaction.mockImplementation(fn => fn(run))

    const result = await saveAccountPerformanceChunk(7, 11, payload(), { advanceCursor:false })

    const dailyCall = run.mock.calls.find(([sql]) => sql.includes('INSERT INTO mt5_account_performance_daily'))
    expect(dailyCall[1].slice(0, 2)).toEqual([91, 11])
    expect(syncParams.slice(0, 4)).toEqual([91, 11, '2026-01-01', '2026-07-20'])
    expect(result.totals.net_account_change).toBe(110.5)
  })
})
