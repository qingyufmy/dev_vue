import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 12:00:00'),
}))
vi.mock('../../server/db.js', () => db)

import {
  analyzeOutcomeAttribution,
  createSignalOutcomeTx,
  dealTimeForDatabase,
  isSystemManagedOutcomeSource,
  reconcileTerminalPendingOutcomes,
  reconcileSignalOutcomes,
  resolveOutcomeClosureTransition,
} from '../../server/routes/ai/signal-outcomes.js'

const outcome = (overrides = {}) => ({
  id: 1, user_id: 2, trading_account_id: 3, margin_mode: 'hedging', position_id: 'P1',
  entry_order_ticket: 'O1', pending_ticket: null, bridge_command_ref: 'AI-1', expected_volume: 1,
  approved_order_json: JSON.stringify({ sl: 90, tp: 120 }), ...overrides,
})
const deal = (overrides = {}) => ({
  deal_ticket: 'D1', order: 'O1', position_id: 'P1', entry: 0, magic: 234000,
  volume: 1, profit: 0, commission: -1, swap: 0, fee: 0, time: '2026-07-15 10:00:00', ...overrides,
})

describe('signal outcome attribution', () => {
  it('does not register direct user orders as AI-managed outcomes', async () => {
    const run = vi.fn()
    await expect(createSignalOutcomeTx(run, {
      trading_account_id:3, source_type:'manual',
    }, { order:1001 })).resolves.toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(isSystemManagedOutcomeSource('manual')).toBe(false)
    expect(isSystemManagedOutcomeSource('manual_ai')).toBe(true)
    expect(isSystemManagedOutcomeSource('auto_delivery')).toBe(true)
  })

  it('stores a pending order without trusting a bridge-supplied position alias', async () => {
    const calls = []
    const run = vi.fn(async (sql, params = []) => {
      calls.push([sql, params])
      if (sql.includes('FROM trading_accounts')) {
        return [[{ margin_mode:'hedging', broker_server:'Broker-Demo', login_account:'7788' }], []]
      }
      if (sql.includes('FROM ai_signals')) return [[], []]
      if (sql.includes('FROM mt5_account_ownership_history')) return [[], []]
      return [{ affectedRows:1 }, []]
    })

    await createSignalOutcomeTx(run, {
      id:9, user_id:2, trading_account_id:3, source_type:'auto_delivery', action:'pending',
      source_id:'101', approved_order_json:JSON.stringify({ symbol:'XAUUSD.s', volume:0.1, order_type:'sell_limit' }),
    }, { order:'7001', ticket:'7001', position_id:'7001', deal:0 }, 'pending')

    const insert = calls.find(([sql]) => sql.includes('INSERT INTO signal_outcomes'))
    expect(insert?.[1]?.[7]).toBeNull()
    expect(insert?.[1]?.[8]).toBe('7001')
    expect(insert?.[1]?.[9]).toBeNull()
  })

  it('attributes a complete hedging position and includes every fee', () => {
    const result = analyzeOutcomeAttribution(outcome(), [
      deal(),
      deal({ deal_ticket: 'D2', entry: 1, profit: 20, commission: -1, swap: -2, fee: -0.5, time: '2026-07-15 11:00:00' }),
    ])
    expect(result).toMatchObject({ attributionStatus: 'attributed', complete: true, entryVolume: 1, closedVolume: 1, netProfit: 15.5 })
    expect(result.matchedDeals).toHaveLength(2)
  })

  it('normalizes Bridge UTC ISO timestamps for MySQL DATETIME columns', () => {
    expect(dealTimeForDatabase({ time:'2026-07-31T09:07:49Z' })).toBe('2026-07-31 17:07:49')
    expect(dealTimeForDatabase({ time:'2026-07-31 12:07:49' })).toBe('2026-07-31 12:07:49')
    expect(dealTimeForDatabase({ time:'invalid' })).toBeNull()
    expect(dealTimeForDatabase({
      time:'2020-01-01T00:00:00Z', time_utc_msc:Date.parse('2026-07-31T09:07:49Z'),
    })).toBe('2026-07-31 17:07:49')
  })

  it('keeps a partially closed hedging position open', () => {
    const result = analyzeOutcomeAttribution(outcome(), [
      deal(), deal({ deal_ticket: 'D2', entry: 1, volume: 0.4, profit: 4 }),
    ], [{ ticket: 'P1', sl: 90, tp: 120 }])
    expect(result.complete).toBe(false)
    expect(result.closedVolume).toBe(0.4)
  })

  it('attributes a netting position when exactly one intent owns it', () => {
    const result = analyzeOutcomeAttribution(outcome({ margin_mode: 'netting' }), [
      deal(), deal({ deal_ticket: 'D2', entry: 1, profit: 10 }),
    ], [], [], 1)
    expect(result.attributionStatus).toBe('attributed')
    expect(result.complete).toBe(true)
  })

  it('refuses to allocate one netting position across multiple intents', () => {
    const result = analyzeOutcomeAttribution(outcome({ margin_mode: 'netting' }), [deal()], [], [], 2)
    expect(result).toMatchObject({ attributionStatus: 'attribution_ambiguous', complete: false })
    expect(result.matchedDeals).toEqual([])
  })

  it('detects manual volume changes, manual deals and SL/TP edits', () => {
    const result = analyzeOutcomeAttribution(outcome({ expected_volume: 0.5 }), [
      deal({ magic: 0, volume: 1 }),
    ], [{ ticket: 'P1', sl: 91, tp: 121 }])
    expect(result.externalIntervention).toBe(true)
    expect(result.interventions).toEqual(expect.arrayContaining([
      'external_volume_increase', 'non_system_magic_deal', 'stop_loss_modified', 'take_profit_modified',
    ]))
  })

  it('uses an administrator-authorized protection revision as the audit baseline', () => {
    const result = analyzeOutcomeAttribution(outcome({
      authorized_stop_loss:91,
      authorized_take_profit:121,
    }), [deal()], [{ ticket:'P1', sl:91, tp:121 }])
    expect(result.externalIntervention).toBe(false)
    expect(result.interventions).not.toContain('stop_loss_modified')
    expect(result.interventions).not.toContain('take_profit_modified')
  })

  it('requires two identical complete scans before review eligibility', () => {
    const result = analyzeOutcomeAttribution(outcome(), [deal(), deal({ deal_ticket: 'D2', entry: 1, profit: 2 })])
    const first = resolveOutcomeClosureTransition(outcome(), result, '2026-07-15 12:00:00')
    expect(first).toEqual({ status: 'closing', feeStableAt: '2026-07-15 12:00:00', reviewEligibleAt: null })
    const second = resolveOutcomeClosureTransition({ closing_candidate_hash: result.feeHash, fee_stable_at: first.feeStableAt }, result, '2026-07-15 12:01:00')
    expect(second).toEqual({ status: 'closed', feeStableAt: first.feeStableAt, reviewEligibleAt: '2026-07-15 12:01:00' })
  })
})

describe('position outcome monitor durability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leaves persistent open outcomes untouched while Bridge is offline', async () => {
    db.queryAll.mockResolvedValue([outcome({ status: 'open', order_intent_id: 8 })])
    const closed = await reconcileSignalOutcomes({ bridge: vi.fn().mockRejectedValue(new Error('offline')) })
    expect(closed).toBe(0)
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(db.queryRun).toHaveBeenCalledTimes(4)
  })

  it('retires terminal pending outcomes before they reach inference context', async () => {
    db.queryRun
      .mockResolvedValueOnce({ changes:3 })
      .mockResolvedValueOnce({ changes:2 })
      .mockResolvedValueOnce({ changes:97 })
      .mockResolvedValueOnce({ changes:97 })
    expect(await reconcileTerminalPendingOutcomes()).toBe(97)
    expect(db.queryRun.mock.calls[0][0]).toContain('outcomes.position_id = outcomes.pending_ticket')
    expect(db.queryRun.mock.calls[0][0]).toContain("COALESCE(NULLIF(TRIM(outcomes.entry_deal_ticket), ''), '0') = '0'")
    expect(db.queryRun.mock.calls[1][0]).toContain("tasks.task_type = 'position_exit'")
    expect(db.queryRun.mock.calls[2][0]).toContain("IN ('cancelled','expired','superseded')")
    expect(db.queryRun.mock.calls[2][0]).toContain("attribution_status = 'not_filled'")
  })

  it('automatically clears a protection pause after the system position is protected again', async () => {
    db.queryAll.mockResolvedValue([outcome({
      status:'open', order_intent_id:8, entry_direction:'buy',
      protection_status:'missing_stop_loss', original_stop_loss:90,
    })])
    const writes = []
    const run = vi.fn(async (sql) => {
      writes.push(sql)
      if (sql.includes('SELECT * FROM signal_outcomes')) {
        return [[outcome({
          status:'open', order_intent_id:8, entry_direction:'buy',
          protection_status:'missing_stop_loss', original_stop_loss:90,
        })], []]
      }
      if (sql.includes('COUNT(*) AS unresolved_count')) return [[{ unresolved_count:0 }], []]
      if (sql.includes('FROM risk_account_state') && sql.includes('FOR UPDATE')) {
        return [[{ halt_status:'protection_incident', halt_reason:'missing_stop_loss' }], []]
      }
      return [{ affectedRows:1 }, []]
    })
    db.withTransaction.mockImplementation(callback => callback(run))
    const bridge = vi.fn(async (_userId, action) => action === 'history'
      ? { status:'success', deals:[deal()], history_orders:[] }
      : { status:'success', positions:[{
        ticket:'P1', position_id:'P1', type:'buy', price_current:100,
        sl:90, tp:120, magic:234000, volume:1,
      }] })

    await reconcileSignalOutcomes({ bridge })

    expect(writes.some(sql => sql.includes("SET halt_status = 'active', halt_reason = NULL"))).toBe(true)
  })

  it('writes normalized close timestamps to both deal and outcome DATETIME columns', async () => {
    db.queryAll.mockResolvedValue([outcome({ status:'open', order_intent_id:8, entry_direction:'buy' })])
    const calls = []
    const locked = outcome({ status:'open', order_intent_id:8, entry_direction:'buy' })
    const run = vi.fn(async (sql, params = []) => {
      calls.push([sql, params])
      if (sql.includes('SELECT * FROM signal_outcomes')) return [[locked], []]
      if (sql.includes('COUNT(*) AS unresolved_count')) return [[{ unresolved_count:1 }], []]
      return [{ affectedRows:1 }, []]
    })
    db.withTransaction.mockImplementation(callback => callback(run))
    const bridge = vi.fn(async (_userId, action) => action === 'history'
      ? { status:'success', deals:[
          deal({ time:'2026-07-31T08:00:00Z' }),
          deal({ deal_ticket:'D2', entry:1, profit:2, time:'2026-07-31T09:07:49Z' }),
        ], history_orders:[] }
      : { status:'success', positions:[] })

    await reconcileSignalOutcomes({ bridge })

    const exitInsert = calls.find(([sql, params]) => sql.includes('INSERT IGNORE INTO signal_outcome_deals') && params[3] === 'D2')
    const outcomeUpdate = calls.find(([sql]) => sql.includes('fully_closed_at = ?'))
    expect(exitInsert?.[1]?.[16]).toBe('2026-07-31 17:07:49')
    expect(outcomeUpdate?.[1]?.[13]).toBe('2026-07-31 17:07:49')
  })

  it('enforces idempotency for both outcomes and MT5 deals in the schema', () => {
    const source = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const monitor = readFileSync(new URL('../../server/routes/ai/signal-outcomes.js', import.meta.url), 'utf8')
    expect(source).toContain('UNIQUE KEY uk_signal_outcome_intent (order_intent_id)')
    expect(source).toContain('UNIQUE KEY uk_outcome_account_deal (trading_account_id, deal_ticket)')
    expect(source).toContain("156_normalize_zero_deal_pending_identity")
    expect(monitor).toContain('INSERT IGNORE INTO signal_outcome_deals')
  })
})
