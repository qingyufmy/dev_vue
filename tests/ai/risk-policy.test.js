import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(), withTransaction: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-15 21:00:00'),
}))
vi.mock('../../server/db.js', () => db)

import {
  DEFAULT_RISK_POLICY, RISK_RULES, evaluateCoreRisk, isRelaxation,
  normalizePlatformRiskConfig, resolveEffectiveRiskPolicy, resolvePlatformAiVolumeRange, submitRiskPolicyChanges, persistRiskDecision, weekendProtectionState,
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
  it('passes a complete market signal and converts the remaining percentage budget to MT5 points', () => {
    const result = run()
    expect(result.decision_status).toBe('pass')
    expect(result.approved_order.volume).toBe(0.03)
    expect(result.approved_order.deviation).toBe(180)
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

  it('turns a fixed AI tier into a deterministic fraction of the user risk budget', () => {
    const result = run({
      request:{ volume:1, position_size_tier:'probe', position_size_factor:0.25 },
      policy:{ max_position_size:1, max_risk_per_trade_pct:1 },
    })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order.volume).toBe(0.02)
    expect(result.rule_results).toContainEqual(expect.objectContaining({
      code:'R1.10_REAL_RISK',
      details:expect.objectContaining({ full_risk_cap:100, risk_cap:25, position_size_factor:0.25, position_size_tier:'probe' }),
    }))
  })

  it('uses the current user position limit instead of a legacy AI lot placeholder', () => {
    const result = run({
      request:{ volume:0.03, position_size_tier:'standard', position_size_factor:0.25 },
      policy:{ max_position_size:0.5, max_risk_per_trade_pct:1 },
    })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order).toMatchObject({ volume:0.09, position_size_tier:'standard', position_size_factor:1 })
    expect(result.rule_results).toContainEqual(expect.objectContaining({
      code:'R1.10_REAL_RISK',
      details:expect.objectContaining({ position_limit_lots:0.5, full_risk_cap:100, risk_cap:100 }),
    }))
  })

  it('preserves the AI stop loss and reuses the matching MT5 native loss calculation', () => {
    const result = run({ request: { sl: 1995 }, brokerCalculation: {
      symbol: 'XAUUSD.a', order_type: 'buy', volume: 0.03,
      entry_price: 2000.2, sl: 1995, loss_to_sl: 1,
    } })
    expect(result.rule_results).toContainEqual(expect.objectContaining({
      code: 'R1.10_REAL_RISK',
      details: expect.objectContaining({ calculation_source: 'mt5_order_calc_profit' }),
    }))
    expect(result.approved_order.sl).toBe(1995)
  })

  it('does not rewrite a tight AI stop loss', () => {
    const result = run({ request: { sl: 1995 } })
    expect(result.decision_status).toBe('pass')
    expect(result.approved_order.sl).toBe(1995)
    expect(result.approved_order.volume).toBe(0.03)
    expect(result.rule_results.some(item => item.code === 'R1.3_SL_WIDEN_VOLUME_DOWN')).toBe(false)
  })

  it('does not scale the minimum lot to zero for a sub-tick ATR rounding difference', () => {
    const result = run({ request: {
      signal_type: 'buy_limit', entry_method: 'limit', limit_price: 1998,
      volume: 0.01, sl: 1988, tp: 2015, atr_anchor: 10.0005,
    } })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order.volume).toBe(0.01)
    expect(result.rule_results.some(item => item.code === 'R1.3_SL_WIDEN_VOLUME_DOWN')).toBe(false)
  })

  it('keeps the selected AI take-profit tier without a minimum R:R override', () => {
    const result = run({ request: {
      tp: 2008, tp_tier_used: 2,
      take_profit_candidates: [{ tier:1, price:2005 }, { tier:2, price:2008 }, { tier:3, price:2013 }],
    } })
    expect(result.decision_status).toBe('pass')
    expect(result.approved_order).toMatchObject({ tp:2008, tp_tier_used:2 })
    expect(result.rule_results.some(item => item.code === 'R1.5_TP_TIER_UPGRADED')).toBe(false)
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
    [{ volume: 100.01 }, 'R1.9_AI_VOLUME_OUT_OF_RANGE'],
  ])('rejects invalid schema or core boundary %#', (fields, code) => {
    expect(run({ request: fields }).reject_code).toBe(code)
  })

  it('fails closed when any broker sizing parameter is absent', () => {
    expect(run({ instrument: { tick_value: undefined } }).reject_code).toBe('R1_INSTRUMENT_DATA_INCOMPLETE')
  })

  it('applies execution deviation to market orders without limiting intentional pending distance', () => {
    expect(run({ request: { reference_price: 1990 } }).reject_code).toBe('R4.6_EXECUTION_PRICE_DEVIATION')
    const pending = run({ request: {
      signal_type: 'buy_limit', entry_method: 'limit', limit_price: 1975,
      sl: 1965, tp: 2015, reference_price: 2000,
    } })
    expect(pending.decision_status).toBe('adjust')
    expect(pending.approved_order.deviation).toBe(197)
  })

  it('uses 0.1 percent as a symmetric price interval and deducts already-used movement', () => {
    const base = {
      request:{ reference_price:4073, sl:4060, tp:4100, atr_anchor:20 },
      quote:{ bid:4073, ask:4073 },
      policy:{ max_execution_price_deviation_pct:0.1 },
    }
    const centered = run(base)
    expect(centered.decision_status).toBe('pass')
    expect(centered.approved_order.deviation).toBe(407)
    const nearUpper = run({ ...base, quote:{ bid:4076.99, ask:4077 } })
    expect(nearUpper.decision_status).toBe('pass')
    expect(nearUpper.approved_order.deviation).toBe(7)
    const outside = run({ ...base, quote:{ bid:4077.07, ask:4077.08 } })
    expect(outside.reject_code).toBe('R4.6_EXECUTION_PRICE_DEVIATION')
    expect(outside.rule_results.at(-1).details).toMatchObject({ allowed_min:4068.927, allowed_max:4077.073, maximum_pct:0.1 })
  })

  it('defaults pending validity without converting the order to market', () => {
    const result = run({ request: {
      signal_type: 'buy_limit', entry_method: 'limit', limit_price: 1998,
      sl: 1988, tp: 2015, reference_price: 2000,
    } })
    expect(result.decision_status).toBe('adjust')
    expect(result.approved_order).toMatchObject({ entry_method: 'limit', pending_valid_minutes: 180 })
  })

  it('enforces stop-limit trigger direction and post-trigger limit relation', () => {
    const wrongTrigger = run({ request: {
      order_type: 'sell', signal_type: 'sell_stop_limit', entry_method: 'stop_limit',
      limit_price: 2001, stop_limit_price: 2002, sl: 2012, tp: 1980,
    } })
    expect(wrongTrigger.reject_code).toBe('R1.7_PENDING_DIRECTION')

    const wrongLimit = run({ request: {
      order_type: 'sell', signal_type: 'sell_stop_limit', entry_method: 'stop_limit',
      limit_price: 1999, stop_limit_price: 1998, sl: 2012, tp: 1980,
    } })
    expect(wrongLimit.reject_code).toBe('R1.7_STOP_LIMIT_RELATION')

    const valid = run({ request: {
      order_type: 'sell', signal_type: 'sell_stop_limit', entry_method: 'stop_limit',
      limit_price: 1999, stop_limit_price: 2000, sl: 2012, tp: 1980,
    } })
    expect(valid.decision_status).not.toBe('reject')
  })

  it('rejects stale quotes, expired signals, wide spread, and weekend opens', () => {
    const stale = run({ quote: { time_msc: nowMs - 16_000 } })
    expect(stale.reject_code).toBe('R4.4_QUOTE_STALE')
    expect(stale.rule_results.at(-1).details).toMatchObject({ quote_age_seconds:16, maximum_seconds:15 })
    expect(run({ request: { signal_created_at: '2026-07-15T12:40:00Z' } }).reject_code).toBe('R4.3_SIGNAL_EXPIRED')
    expect(run({ quote: { ask: 2001.3 } }).reject_code).toBe('R4.5_SPREAD_TOO_WIDE')
    expect(run({ nowMs: Date.parse('2026-07-18T02:00:00Z'), quote: { time_msc: Date.parse('2026-07-18T02:00:00Z') }, request: { signal_created_at: '2026-07-18T01:59:00Z' } }).reject_code).toBe('R4.2_WEEKEND_PROTECTION')
  })

  it('calculates weekend protection in the calibrated MT5 timezone instead of Beijing time', () => {
    const previouslyWrong = Date.parse('2026-07-17T14:30:00Z') // 北京周五22:30，MT5 UTC+3 周五17:30
    expect(weekendProtectionState(previouslyWrong, 120, 180).protected).toBe(false)

    const beforeBoundary = Date.parse('2026-07-17T18:59:00Z') // MT5 周五21:59
    expect(weekendProtectionState(beforeBoundary, 120, 180).protected).toBe(false)
    const atBoundary = Date.parse('2026-07-17T19:00:00Z') // MT5 周五22:00，距周六00:00两小时
    expect(weekendProtectionState(atBoundary, 120, 180)).toMatchObject({
      protected:true, timezone_offset_minutes:180, mt5_weekday:5, mt5_time:'22:00',
    })

    const mondayOpen = Date.parse('2026-07-19T21:00:00Z') // MT5 周一00:00
    expect(weekendProtectionState(mondayOpen, 120, 180).protected).toBe(false)
  })

  it('uses the quote clock offset and falls back to MT5 UTC+3 only when it is unavailable', () => {
    const utcTime = Date.parse('2026-07-17T19:30:00Z')
    expect(weekendProtectionState(utcTime, 120, 120).protected).toBe(false) // MT5 UTC+2 周五21:30
    expect(weekendProtectionState(utcTime, 120, 180).protected).toBe(true)  // MT5 UTC+3 周五22:30
    expect(weekendProtectionState(utcTime, 120, null).timezone_offset_minutes).toBe(180)
    const utcPlus2 = run({ nowMs:utcTime, quote:{ time_msc:utcTime, timezone_offset_minutes:120 },
      request:{ signal_created_at:'2026-07-17T19:29:00Z' } })
    expect(utcPlus2.decision_status).toBe('pass')
    const utcPlus3 = run({ nowMs:utcTime, quote:{ time_msc:utcTime, timezone_offset_minutes:180 },
      request:{ signal_created_at:'2026-07-17T19:29:00Z' }, policy:{ weekend_close_minutes:120 } })
    expect(utcPlus3.reject_code).toBe('R4.2_WEEKEND_PROTECTION')
    expect(utcPlus3.rule_results.at(-1).details).toMatchObject({ timezone_offset_minutes:180, mt5_time:'22:30' })
  })

  it('uses the bridge-normalized UTC timestamp before the raw MT5 wall-clock timestamp', () => {
    const result = run({ quote: { time_msc: nowMs + 3 * 3600_000, time_utc_msc: nowMs } })
    expect(result.decision_status).toBe('pass')
    expect(result.rule_results.some(item => item.code === 'R4.4_QUOTE_STALE' && item.outcome === 'reject')).toBe(false)
  })

  it('records an adjustable shadow rejection but still enforces mandatory boundaries', () => {
    const shadow = run({ request: { reference_price: 1990 }, ruleModes: {
      'R4.6_EXECUTION_PRICE_DEVIATION': { mode: 'shadow', forced: false },
    } })
    expect(shadow.decision_status).toBe('pass')
    expect(shadow.rule_results).toContainEqual(expect.objectContaining({ code: 'R4.6_EXECUTION_PRICE_DEVIATION', outcome: 'shadow_reject' }))
    const forced = run({ request: { volume: 100.01 }, ruleModes: {
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
    expect(RISK_RULES.require_stop_loss.locked).toBe(true)
    expect(DEFAULT_RISK_POLICY).not.toHaveProperty('observation_hours')
    expect(DEFAULT_RISK_POLICY).not.toHaveProperty('ai_volume_step')
    expect(DEFAULT_RISK_POLICY).not.toHaveProperty('sl_atr_max')
    expect(DEFAULT_RISK_POLICY).not.toHaveProperty('min_rr')
    expect(DEFAULT_RISK_POLICY).not.toHaveProperty('max_directional_exposure_lots')
    expect(DEFAULT_RISK_POLICY).not.toHaveProperty('min_margin_level_pct')
  })

  it('uses the administrator range as the user boundary independently of the platform default', () => {
    const normalized = normalizePlatformRiskConfig({
      currentValues: DEFAULT_RISK_POLICY,
      valueChanges: { max_risk_per_trade_pct: 1 },
      controlChanges: {
        max_risk_per_trade_pct: { allowed_min:0.01, allowed_max:20 },
      },
    })
    expect(normalized.controls.max_risk_per_trade_pct.allowed_max).toBe(20)
    expect(normalizePlatformRiskConfig({
      currentValues: DEFAULT_RISK_POLICY,
      controlChanges: { max_position_size: { allowed_min:0.001, allowed_max:1 } },
    })).toMatchObject({
      values: { max_position_size:0.05 },
      controls: { max_position_size:{ allowed_min:0.001, allowed_max:1 } },
    })
    expect(() => normalizePlatformRiskConfig({ valueChanges:{ observation_hours:72 } })).toThrow('unknown_risk_field:observation_hours')
    expect(() => normalizePlatformRiskConfig({ valueChanges:{ min_margin_level_pct:300 } })).toThrow('unknown_risk_field:min_margin_level_pct')
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
    const result = await submitRiskPolicyChanges({ policySetId: 7, actorId: 5, changes: { max_position_size: 0.02, max_execution_price_deviation_pct: 0.05 }, reason: 'test' })
    expect(result.immediate_fields).toEqual(['max_position_size', 'max_execution_price_deviation_pct'])
    expect(result.applied_fields).toEqual(['max_position_size', 'max_execution_price_deviation_pct'])
    expect(result.pending_fields).toEqual([])
    const versionWrite = writes.find(item => item.sql.startsWith('INSERT INTO risk_policy_versions'))
    expect(JSON.parse(versionWrite.params[2])).toMatchObject({ max_position_size: 0.02, max_execution_price_deviation_pct: 0.05 })
    expect(writes.some(item => item.sql.includes('risk_policy_change_items'))).toBe(true)
    expect(writes.filter(item => item.sql.includes('risk_policy_change_items')).every(item => item.sql.includes("'applied'"))).toBe(true)
  })

  it('resolves platform, account, due field and strategy profile with profile only tightening', async () => {
    db.queryOne.mockImplementation(async (sql, params) => {
      if (sql.includes("scope = 'platform'")) return { id: 1 }
      if (sql.includes("scope = 'account'")) return { id: 2 }
      if (sql.includes('risk_policy_versions')) return params[0] === 1
        ? { id: 11, config_json: '{"max_position_size":0.04}' }
        : { id: 12, config_json: '{"max_position_size":0.08,"min_rr":1.4,"max_execution_price_deviation_pct":0.08,"daily_loss_limit_pct":5}' }
      if (sql.includes('risk_profiles')) return { config_json: '{"max_position_size":0.02,"min_rr":1.6}' }
      return null
    })
    db.queryAll.mockResolvedValue([])
    const result = await resolveEffectiveRiskPolicy({ userId: 5, tradingAccountId: 6, riskProfileId: 7, legacyConfig: { max_position_size: 0.05 } })
    expect(result.policy).toMatchObject({ max_position_size: 0.02, max_execution_price_deviation_pct:0.08, daily_loss_limit_pct:3 })
    expect(result.policy).not.toHaveProperty('min_rr')
    expect(result.policyVersionIds).toEqual([11, 12])
  })

  it('applies the administrator user range to inherited platform values', async () => {
    db.queryOne.mockImplementation(async (sql) => {
      if (sql.includes("scope = 'platform'")) return { id:1 }
      if (sql.includes("scope = 'account'")) return null
      if (sql.includes('risk_policy_versions')) return { id:11, config_json:JSON.stringify({
        values:{ max_risk_per_trade_pct:1, weekend_close_minutes:60 },
        controls:{
          max_risk_per_trade_pct:{ allowed_min:0.01, allowed_max:0.4, locked_value:null, user_editable:true },
          weekend_close_minutes:{ allowed_min:120, allowed_max:2880, locked_value:null, user_editable:true },
        },
      }) }
      return null
    })
    const result = await resolveEffectiveRiskPolicy({ userId:5, tradingAccountId:6 })
    expect(result.platformPolicy).toMatchObject({ max_risk_per_trade_pct:0.4, weekend_close_minutes:120 })
    expect(result.policy).toMatchObject({ max_risk_per_trade_pct:0.4, weekend_close_minutes:120 })
  })

  it('allows an account value above the platform default up to the administrator maximum', async () => {
    db.queryOne.mockImplementation(async (sql, params) => {
      if (sql.includes("scope = 'platform'")) return { id:1 }
      if (sql.includes("scope = 'account'")) return { id:2 }
      if (sql.includes('risk_policy_versions')) return Number(params[0]) === 1
        ? { id:11, config_json:JSON.stringify({
            values:{ max_position_size:0.05 },
            controls:{ max_position_size:{ allowed_min:0.001, allowed_max:1, locked_value:null, user_editable:true } },
          }) }
        : { id:12, config_json:JSON.stringify({ max_position_size:1 }) }
      return null
    })
    const result = await resolveEffectiveRiskPolicy({ userId:5, tradingAccountId:6 })
    expect(result.platformPolicy.max_position_size).toBe(0.05)
    expect(result.controls.max_position_size.allowed_max).toBe(1)
    expect(result.policy.max_position_size).toBe(1)
  })

  it('uses the administrator range as the shared AI recommendation boundary', async () => {
    db.queryOne.mockImplementation(async (sql) => {
      if (sql.includes("scope = 'platform'")) return { id:1 }
      if (sql.includes("scope = 'account'")) return null
      if (sql.includes('risk_policy_versions')) return { id:11, config_json:JSON.stringify({
        values:{ max_position_size:0.05 },
        controls:{ max_position_size:{ allowed_min:0.001, allowed_max:1, locked_value:null, user_editable:true } },
      }) }
      return null
    })
    await expect(resolvePlatformAiVolumeRange()).resolves.toEqual({ min:0.01, max:1, step:0.01 })
  })

  it('does not let the legacy scheduler limit override the account risk policy', async () => {
    db.queryOne.mockImplementation(async (sql, params) => {
      if (sql.includes("scope = 'platform'")) return { id:1 }
      if (sql.includes("scope = 'account'")) return { id:2 }
      if (sql.includes('risk_policy_versions')) return Number(params[0]) === 1
        ? { id:11, config_json:JSON.stringify({
            values:{ max_position_size:0.05 },
            controls:{ max_position_size:{ allowed_min:0.001, allowed_max:0.1, locked_value:null, user_editable:true } },
          }) }
        : { id:12, config_json:JSON.stringify({ max_position_size:0.08 }) }
      return null
    })
    const result = await resolveEffectiveRiskPolicy({ userId:5, tradingAccountId:6, legacyConfig:{ max_position_size:0.01 } })
    expect(result.policy.max_position_size).toBe(0.08)
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
