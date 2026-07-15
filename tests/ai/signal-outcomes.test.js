import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 12:00:00'),
}))
vi.mock('../../server/db.js', () => db)

import {
  analyzeOutcomeAttribution,
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
  it('attributes a complete hedging position and includes every fee', () => {
    const result = analyzeOutcomeAttribution(outcome(), [
      deal(),
      deal({ deal_ticket: 'D2', entry: 1, profit: 20, commission: -1, swap: -2, fee: -0.5, time: '2026-07-15 11:00:00' }),
    ])
    expect(result).toMatchObject({ attributionStatus: 'attributed', complete: true, entryVolume: 1, closedVolume: 1, netProfit: 15.5 })
    expect(result.matchedDeals).toHaveLength(2)
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
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('enforces idempotency for both outcomes and MT5 deals in the schema', () => {
    const source = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const monitor = readFileSync(new URL('../../server/routes/ai/signal-outcomes.js', import.meta.url), 'utf8')
    expect(source).toContain('UNIQUE KEY uk_signal_outcome_intent (order_intent_id)')
    expect(source).toContain('UNIQUE KEY uk_outcome_account_deal (trading_account_id, deal_ticket)')
    expect(monitor).toContain('INSERT IGNORE INTO signal_outcome_deals')
  })
})
