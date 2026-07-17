import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 21:00:00'),
}))
vi.mock('../../server/db.js', () => db)

import {
  DEFAULT_RISK_POLICY, RISK_RULES, evaluateCoreRisk, isRelaxation,
  resolveEffectiveRiskPolicy, submitRiskPolicyChanges, persistRiskDecision,
} from '../../server/routes/ai/risk-policy.js'

const nowMs = Date.parse('2026-07-15T13:00:00Z')
const quote = { bid: 2000, ask: 2000.2, time_msc: nowMs }
const instrument = {
  name: 'XAUUSD.a', tick_value: 1, tick_size: 0.01, contract_size: 100,
  volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  digits: 2, point: 0.01, trade_mode: 4,
}
const request = {
  symbol: 'XAUUSD.a', order_type: 'buy', signal_type: 'buy', entry_method: 'market',
  source: 'ai', volume: 0.03, sl: 1990, tp: 2025, atr_anchor: 10,
  reference_price: 2000, signal_created_at: '2026-07-15T12:59:00Z', confirm: true,
}
const run = (overrides = {}) => evaluateCoreRisk({
  request: { ...request, ...(overrides.request || {}) },
  account: { equity: 10000, ...(overrides.account || {}) },
  quote: { ...quote, ...(overrides.quote || {}) }, instrument: { ...instrument, ...(overrides.instrument || {}) },
  policy: { ...DEFAULT_RISK_POLICY, ...(overrides.policy || {}) }, nowMs: overrides.nowMs ?? nowMs,
  ruleModes: overrides.ruleModes || {},
  brokerCalculation: overrides.brokerCalculation || null,
})

describe('L1/L4/L5 core risk gate', () => {
  it('passes a complete market signal and attaches broker slippage only', () => {
    const result = run()
    expect(result.decision_status).toBe('pass')
    expect(result.approved_order.volume).toBe(0.03)
    expect(result.approved_order.deviation).toBe(30)
    expect(result.original_order).not.toHaveProperty('deviation')
  })

  it('uses MT5 native loss calculation when it matches the final order', () => {
    const result = run({ brokerCalculation: {
      symbol: 'XAUUSD.a', order_type: 'buy', volume: 0.03,
      entry_price: 2000.2, sl: 1990, loss_to_sl: 45,
    } })
    expect(result.rule_results).toContainEqual(expect.objectContaining({
      code: 'R1.10_REAL_RISK',
      details: expect.objectContaining({ calculation_source: 'mt5_order_calc_profit', risk_amount: 45 }),
    }))
  })

  it('does not reuse MT5 native loss calculation after the gate changes SL', () => {
    const result = run({ request: { sl: 1995 }, brokerCalculation: {
      symbol: 'XAUUSD.a', order_type: 'buy', volume: 0.03,
      entry_price: 2000.2, sl: 1995, loss_to_sl: 1,
    } })
    expect(result.rule_results).toContainEqual(expect.objectContaining({
      code: 'R1.10_REAL_RISK',
      details: expect.objectContaining({ calculation_source: 'symbol_tick_metadata' }),
    }))
  })

  it('widens a tight SL, scales volume down, and fully rechecks', () => {
    const result = run({ request: { sl: 1995 } })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order.sl).toBe(1990.2)
    expect(result.approved_order.volume).toBe(0.01)
    expect(result.rule_results.some(item => item.code === 'R1.3_SL_WIDEN_VOLUME_DOWN')).toBe(true)
  })

  it('does not scale the minimum lot to zero for a sub-tick ATR rounding difference', () => {
    const result = run({ request: {
      signal_type: 'buy_limit', entry_method: 'limit', limit_price: 1998,
      volume: 0.01, sl: 1988, tp: 2015, atr_anchor: 10.0005,
    }, policy: { pending_price_deviation_pct: 1 } })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order.volume).toBe(0.01)
    expect(result.rule_results.some(item => item.code === 'R1.3_SL_WIDEN_VOLUME_DOWN')).toBe(false)
  })

  it('uses the nearest existing AI take-profit tier that satisfies minimum R:R', () => {
    const result = run({ request: {
      tp: 2008, tp_tier_used: 2,
      take_profit_candidates: [{ tier:1, price:2005 }, { tier:2, price:2008 }, { tier:3, price:2013 }],
    } })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order).toMatchObject({ tp:2013, tp_tier_used:3, tp_selection_source:'risk_adjusted' })
    expect(result.rule_results).toContainEqual(expect.objectContaining({ code:'R1.5_TP_TIER_UPGRADED', outcome:'adjust' }))
  })

  it('never increases AI volume when risk arithmetic is below broker minimum', () => {
    const result = run({ request: { volume: 0.01, sl: 1980 }, account: { equity: 100 } })
    expect(result).toMatchObject({ decision_status: 'reject', reject_code: 'R1.9_BELOW_MINIMUM_AFTER_RISK' })
  })

  it.each([
    [{ entry_method: 'magic' }, 'R5_SCHEMA_ENTRY_METHOD'],
    [{ signal_type: 'buy_limit', entry_method: 'limit', limit_price: null }, 'R5_SCHEMA_PENDING_PRICE'],
    [{ sl: null }, 'R1.2_STOP_LOSS_REQUIRED'],
    [{ sl: 2010 }, 'R1.6_SL_TP_DIRECTION'],
    [{ volume: 0.06 }, 'R1.9_AI_VOLUME_OUT_OF_RANGE'],
  ])('rejects invalid schema or core boundary %#', (fields, code) => {
    expect(run({ request: fields }).reject_code).toBe(code)
  })

  it('fails closed when any broker sizing parameter is absent', () => {
    expect(run({ instrument: { tick_value: undefined } }).reject_code).toBe('R1_INSTRUMENT_DATA_INCOMPLETE')
  })

  it('separates market drift from pending deviation', () => {
    expect(run({ request: { reference_price: 1990 } }).reject_code).toBe('R4.6_MARKET_SIGNAL_DRIFT')
    const pending = run({ request: {
      signal_type: 'buy_limit', entry_method: 'limit', limit_price: 1985,
      sl: 1975, tp: 2015, reference_price: 2000,
    } })
    expect(pending.reject_code).toBe('R1.7_PENDING_DEVIATION')
  })

  it('defaults pending validity without converting the order to market', () => {
    const result = run({ request: {
      signal_type: 'buy_limit', entry_method: 'limit', limit_price: 1998,
      sl: 1988, tp: 2015, reference_price: 2000,
    }, policy: { pending_price_deviation_pct: 1 } })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order).toMatchObject({ entry_method: 'limit', pending_valid_minutes: 240 })
  })

  it('enforces stop-limit trigger direction and post-trigger limit relation', () => {
    const wrongTrigger = run({ request: {
      order_type: 'sell', signal_type: 'sell_stop_limit', entry_method: 'stop_limit',
      limit_price: 2001, stop_limit_price: 2002, sl: 2012, tp: 1980,
    }, policy: { pending_price_deviation_pct: 1 } })
    expect(wrongTrigger.reject_code).toBe('R1.7_PENDING_DIRECTION')

    const wrongLimit = run({ request: {
      order_type: 'sell', signal_type: 'sell_stop_limit', entry_method: 'stop_limit',
      limit_price: 1999, stop_limit_price: 1998, sl: 2012, tp: 1980,
    }, policy: { pending_price_deviation_pct: 1 } })
    expect(wrongLimit.reject_code).toBe('R1.7_STOP_LIMIT_RELATION')

    const valid = run({ request: {
      order_type: 'sell', signal_type: 'sell_stop_limit', entry_method: 'stop_limit',
      limit_price: 1999, stop_limit_price: 2000, sl: 2012, tp: 1980,
    }, policy: { pending_price_deviation_pct: 1 } })
    expect(valid.decision_status).not.toBe('reject')
  })

  it('rejects stale quotes, expired signals, wide spread, and weekend opens', () => {
    const stale = run({ quote: { time_msc: nowMs - 11_000 } })
    expect(stale.reject_code).toBe('R4.4_QUOTE_STALE')
    expect(stale.rule_results.at(-1).details).toMatchObject({ quote_age_seconds:11, maximum_seconds:10 })
    expect(run({ request: { signal_created_at: '2026-07-15T12:40:00Z' } }).reject_code).toBe('R4.3_SIGNAL_EXPIRED')
    expect(run({ quote: { ask: 2001.1 } }).reject_code).toBe('R4.5_SPREAD_TOO_WIDE')
    expect(run({ nowMs: Date.parse('2026-07-18T02:00:00Z'), quote: { time_msc: Date.parse('2026-07-18T02:00:00Z') }, request: { signal_created_at: '2026-07-18T01:59:00Z' } }).reject_code).toBe('R4.2_WEEKEND_PROTECTION')
  })

  it('uses the bridge-normalized UTC timestamp before the raw MT5 wall-clock timestamp', () => {
    const result = run({ quote: { time_msc: nowMs + 3 * 3600_000, time_utc_msc: nowMs } })
    expect(result.decision_status).toBe('pass')
    expect(result.rule_results.some(item => item.code === 'R4.4_QUOTE_STALE' && item.outcome === 'reject')).toBe(false)
  })

  it('records an adjustable shadow rejection but still enforces mandatory boundaries', () => {
    const shadow = run({ request: { reference_price: 1990 }, ruleModes: {
      'R4.6_MARKET_SIGNAL_DRIFT': { mode: 'shadow', forced: false },
    } })
    expect(shadow.decision_status).toBe('pass')
    expect(shadow.rule_results).toContainEqual(expect.objectContaining({ code: 'R4.6_MARKET_SIGNAL_DRIFT', outcome: 'shadow_reject' }))
    const forced = run({ request: { volume: 0.06 }, ruleModes: {
      'R1.9_AI_VOLUME_OUT_OF_RANGE': { mode: 'shadow', forced: false },
    } })
    expect(forced.reject_code).toBe('R1.9_AI_VOLUME_OUT_OF_RANGE')
  })

  it('keeps every approved volume on step and at or below the AI suggestion', () => {
    for (const suggested of [0.01, 0.02, 0.03, 0.04, 0.05]) {
      for (const max of [0.01, 0.02, 0.05]) {
        const result = run({ request: { volume: suggested }, policy: { max_position_size: max } })
        if (result.approved_order) {
          expect(result.approved_order.volume).toBeLessThanOrEqual(suggested)
          expect(Math.abs(result.approved_order.volume * 100 - Math.round(result.approved_order.volume * 100))).toBeLessThan(1e-7)
        }
      }
    }
  })
})

describe('versioned policy semantics', () => {
  beforeEach(() => vi.clearAllMocks())

  it('classifies tightening and relaxation by each field safety direction', () => {
    expect(isRelaxation('max_position_size', 0.02, 0.03)).toBe(true)
    expect(isRelaxation('max_position_size', 0.03, 0.02)).toBe(false)
    expect(isRelaxation('min_rr', 1.5, 1.2)).toBe(true)
    expect(RISK_RULES.require_stop_loss.locked).toBe(true)
  })

  it('applies tightening and relaxation immediately in one version while retaining field audits', async () => {
    const writes = []
    db.withTransaction.mockImplementation(async fn => fn(async (sql, params = []) => {
      if (sql.includes('FROM risk_policy_sets')) return [[{ id: 7 }], []]
      if (sql.includes('FROM risk_policy_versions')) return [[{ id: 8, version_no: 2, config_json: JSON.stringify(DEFAULT_RISK_POLICY) }], []]
      writes.push({ sql, params })
      if (sql.startsWith('INSERT INTO risk_policy_versions')) return [{ insertId: 9 }, []]
      return [{ affectedRows: 1 }, []]
    }))
    const result = await submitRiskPolicyChanges({ policySetId: 7, actorId: 5, changes: { max_position_size: 0.02, market_signal_drift_atr: 0.5 }, reason: 'test' })
    expect(result.immediate_fields).toEqual(['max_position_size', 'market_signal_drift_atr'])
    expect(result.applied_fields).toEqual(['max_position_size', 'market_signal_drift_atr'])
    expect(result.pending_fields).toEqual([])
    const versionWrite = writes.find(item => item.sql.startsWith('INSERT INTO risk_policy_versions'))
    expect(JSON.parse(versionWrite.params[2])).toMatchObject({ max_position_size: 0.02, market_signal_drift_atr: 0.5 })
    expect(writes.some(item => item.sql.includes('risk_policy_change_items'))).toBe(true)
    expect(writes.filter(item => item.sql.includes('risk_policy_change_items')).every(item => item.sql.includes("'applied'"))).toBe(true)
  })

  it('resolves platform, account, due field and strategy profile with profile only tightening', async () => {
    db.queryOne.mockImplementation(async (sql, params) => {
      if (sql.includes("scope = 'platform'")) return { id: 1 }
      if (sql.includes("scope = 'account'")) return { id: 2 }
      if (sql.includes('risk_policy_versions')) return params[0] === 1
        ? { id: 11, config_json: '{"max_position_size":0.04}' }
        : { id: 12, config_json: '{"max_position_size":0.03,"min_rr":1.4,"market_signal_drift_atr":0.4}' }
      if (sql.includes('risk_profiles')) return { config_json: '{"max_position_size":0.02,"min_rr":1.6}' }
      return null
    })
    db.queryAll.mockResolvedValue([])
    const result = await resolveEffectiveRiskPolicy({ userId: 5, tradingAccountId: 6, riskProfileId: 7, legacyConfig: { max_position_size: 0.05 } })
    expect(result.policy).toMatchObject({ max_position_size: 0.02, min_rr: 1.6, market_signal_drift_atr: 0.4 })
    expect(result.policyVersionIds).toEqual([11, 12])
  })
})

describe('risk decision persistence', () => {
  it('links the durable order intent to the persisted decision', async () => {
    db.queryRun
      .mockResolvedValueOnce({ insertId: 43 })
      .mockResolvedValueOnce({ changes: 1 })
    await expect(persistRiskDecision(44, {
      decision_status: 'reject', reject_code: 'R1.7_PENDING_DIRECTION',
      original_order: {}, approved_order: null, rule_results: [],
    }, [7])).resolves.toBe(43)
    expect(db.queryRun).toHaveBeenNthCalledWith(2,
      'UPDATE order_intents SET risk_decision_id = ?, updated_at = ? WHERE id = ?',
      [43, '2026-07-15 21:00:00', 44])
  })
})
