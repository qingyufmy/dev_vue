import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ACTION_TYPES,
  REASON_CODES,
  calculatePivotLevels,
  evaluatePositionGuard,
  findFirstTargetLevel,
} from '../../server/routes/ai/position-guard-engine.js'

const d1 = { high: 110, low: 90, close: 100 }
const contract = {
  point: 0.01,
  price_digits: 2,
  volume_min: 0.01,
  volume_step: 0.01,
  stops_level_points: 0,
  freeze_level_points: 0,
}

function params(overrides = {}) {
  return {
    pivot_method: 'fibonacci',
    break_stop: { enabled: true, distance_price: 9, open_near_price: 10 },
    pivot_cross_stop: { enabled: true, distance_price: 8, min_duration_seconds: 0 },
    retrace_stop: { enabled: true, distance_price: 5 },
    pivot_take_profit: { enabled: true, tolerance_price: 3, close_percent: 50, move_break_even: true },
    first_target_take_profit: {
      enabled: true,
      tolerance_price: 3,
      close_percent: 50,
      move_break_even: true,
      break_even_offset_price: 2,
    },
    ...overrides,
  }
}

function position(overrides = {}) {
  return {
    ticket: 'ticket-1',
    symbol: 'XAUUSD',
    direction: 'buy',
    open: 105,
    current: 105,
    sl: null,
    tp: null,
    volume: 1,
    ...overrides,
  }
}

function evaluate(overrides = {}) {
  return evaluatePositionGuard({
    d1,
    contract,
    params: params(),
    position: position(),
    quote: { bid: 105, ask: 105.1 },
    now_ms: 1_000,
    ...overrides,
  })
}

function disableAllExcept(section) {
  const value = params()
  for (const key of Object.keys(value)) {
    if (key === 'pivot_method') continue
    value[key] = { ...value[key], enabled: key === section }
  }
  return value
}

describe('Pivot levels', () => {
  it('calculates Fibonacci levels from the previous closed D1 candle', () => {
    const result = calculatePivotLevels({ ...d1, method: 'fibonacci' })

    expect(result.ok).toBe(true)
    expect(result.levels).toEqual({
      P: 100,
      R1: 107.64,
      R2: 112.36,
      R3: 120,
      S1: 92.36,
      S2: 87.64,
      S3: 80,
    })
  })

  it('calculates Standard levels from the previous closed D1 candle', () => {
    const result = calculatePivotLevels({ ...d1, method: 'standard' })

    expect(result.ok).toBe(true)
    expect(result.levels).toEqual({
      P: 100,
      R1: 110,
      S1: 90,
      R2: 120,
      S2: 80,
      R3: 130,
      S3: 70,
    })
  })
})

describe('PivotGuard rule evaluation', () => {
  it.each([
    ['buy', { open: 110 }, { bid: 91.99, ask: 92.09 }],
    ['sell', { open: 90 }, { bid: 107.91, ask: 108.01 }],
  ])('uses the correct %s quote for P-cross stop', (direction, positionOverrides, quote) => {
    const result = evaluate({
      params: disableAllExcept('pivot_cross_stop'),
      position: position({ direction, current: quote.bid, ...positionOverrides }),
      quote,
    })

    expect(result.action.type).toBe(ACTION_TYPES.FULL_EXIT)
    expect(result.action.trigger_code).toBe(REASON_CODES.PIVOT_CROSS_STOP)
  })

  it('keeps the fixed same-side filter for P-cross stops', () => {
    const result = evaluate({
      params: disableAllExcept('pivot_cross_stop'),
      position: position({ direction: 'buy', open: 90, current: 91 }),
      quote: { bid: 91, ask: 91.1 },
    })

    expect(result.action.type).toBe(ACTION_TYPES.OBSERVE)
    expect(result.action.trigger_code).toBe(REASON_CODES.NONE)
  })

  it.each([
    ['buy', { open: 115 }, { bid: 107.35, ask: 107.45 }],
    ['sell', { open: 85 }, { bid: 92.55, ask: 92.65 }],
  ])('evaluates %s retrace stop using the correct side of the key level', (direction, positionOverrides, quote) => {
    const result = evaluate({
      params: disableAllExcept('retrace_stop'),
      position: position({ direction, current: quote.bid, ...positionOverrides }),
      quote,
    })

    expect(result.action.type).toBe(ACTION_TYPES.FULL_EXIT)
    expect(result.action.trigger_code).toBe(REASON_CODES.RETRACE_STOP)
  })

  it.each([
    ['buy', { open: 94 }, { bid: 83.35, ask: 83.45 }],
    ['sell', { open: 106 }, { bid: 116.55, ask: 116.65 }],
  ])('evaluates %s near-key break stop with bid/ask semantics', (direction, positionOverrides, quote) => {
    const result = evaluate({
      params: disableAllExcept('break_stop'),
      position: position({ direction, current: quote.bid, ...positionOverrides }),
      quote,
    })

    expect(result.action.type).toBe(ACTION_TYPES.FULL_EXIT)
    expect(result.action.trigger_code).toBe(REASON_CODES.BREAK_STOP)
  })

  it('honors strict priority: P-cross before retrace and break', () => {
    const result = evaluate({
      position: position({ direction: 'buy', open: 115, current: 91 }),
      quote: { bid: 91, ask: 91.1 },
    })

    expect(result.action.type).toBe(ACTION_TYPES.FULL_EXIT)
    expect(result.action.trigger_code).toBe(REASON_CODES.PIVOT_CROSS_STOP)
  })

  it('requires P-cross duration and resets the timer when price returns inside', () => {
    const crossParams = params({
      break_stop: { ...params().break_stop, enabled: false },
      retrace_stop: { ...params().retrace_stop, enabled: false },
      pivot_take_profit: { ...params().pivot_take_profit, enabled: false },
      first_target_take_profit: { ...params().first_target_take_profit, enabled: false },
      pivot_cross_stop: { ...params().pivot_cross_stop, min_duration_seconds: 3 },
    })
    const input = {
      params: crossParams,
      position: position({ direction: 'buy', open: 110, current: 91 }),
      quote: { bid: 91, ask: 91.1 },
    }
    const first = evaluate({ ...input, now_ms: 1_000 })
    const second = evaluate({ ...input, now_ms: 3_999, stage_state: first.next_stage_state })
    const returnedInside = evaluate({
      ...input,
      now_ms: 4_000,
      quote: { bid: 100, ask: 100.1 },
      position: position({ direction: 'buy', open: 110, current: 100 }),
      stage_state: second.next_stage_state,
    })
    const third = evaluate({ ...input, now_ms: 10_000, stage_state: returnedInside.next_stage_state })
    const fourth = evaluate({ ...input, now_ms: 13_000, stage_state: third.next_stage_state })

    expect(first.action.trigger_code).toBe(REASON_CODES.PIVOT_CROSS_PENDING)
    expect(first.next_stage_state.pivotCrossSinceMs).toBe(1_000)
    expect(second.action.trigger_code).toBe(REASON_CODES.PIVOT_CROSS_PENDING)
    expect(returnedInside.next_stage_state.pivotCrossSinceMs).toBeNull()
    expect(third.action.trigger_code).toBe(REASON_CODES.PIVOT_CROSS_PENDING)
    expect(fourth.action.type).toBe(ACTION_TYPES.FULL_EXIT)
  })

  it('selects the nearest profitable level from all seven levels', () => {
    const pivot = calculatePivotLevels({ ...d1, method: 'fibonacci' })

    expect(findFirstTargetLevel(pivot.levels, 'buy', 105)).toBe(107.64)
    expect(findFirstTargetLevel(pivot.levels, 'sell', 92)).toBe(87.64)
  })

  it('takes profit at P for a long position and marks the shared first target stage', () => {
    const result = evaluate({
      params: disableAllExcept('pivot_take_profit'),
      position: position({ direction: 'buy', open: 95, current: 99 }),
      quote: { bid: 99, ask: 99.1 },
    })

    expect(result.action.type).toBe(ACTION_TYPES.PARTIAL_EXIT)
    expect(result.action.trigger_code).toBe(REASON_CODES.PIVOT_TAKE_PROFIT)
    expect(result.action.close_percent).toBe(50)
    expect(result.action.close_volume).toBe(0.5)
    expect(result.next_stage_state.pivotTakeProfitDone).toBe(true)
    expect(result.next_stage_state.firstTargetDone).toBe(true)
    expect(result.action.next_protection).toMatchObject({
      type: ACTION_TYPES.MOVE_PROTECTION,
      source_stage: 'first_target_take_profit',
      price: 97,
    })
  })

  it('takes the first target for a short position and normalizes partial volume', () => {
    const result = evaluate({
      params: {
        ...disableAllExcept('first_target_take_profit'),
        first_target_take_profit: {
          enabled: true,
          tolerance_price: 0,
          close_percent: 33,
          move_break_even: false,
          break_even_offset_price: 2,
        },
      },
      contract: { ...contract, volume_step: 0.1, volume_min: 0.1 },
      position: position({ direction: 'sell', open: 105, current: 107, volume: 1 }),
      quote: { bid: 99.9, ask: 100 },
    })

    expect(result.action.type).toBe(ACTION_TYPES.PARTIAL_EXIT)
    expect(result.action.trigger_code).toBe(REASON_CODES.FIRST_TARGET_TAKE_PROFIT)
    expect(result.action.target_level).toBe(100)
    expect(result.action.close_volume).toBe(0.3)
  })

  it('maps close_percent 100 to a full exit', () => {
    const result = evaluate({
      params: {
        ...disableAllExcept('first_target_take_profit'),
        first_target_take_profit: {
          enabled: true,
          tolerance_price: 3,
          close_percent: 100,
          move_break_even: true,
          break_even_offset_price: 2,
        },
      },
      position: position({ direction: 'buy', open: 105, current: 108 }),
      quote: { bid: 108, ask: 108.1 },
    })

    expect(result.action.type).toBe(ACTION_TYPES.FULL_EXIT)
    expect(result.action.close_percent).toBe(100)
    expect(result.action.close_volume).toBe(1)
    expect(result.action.next_protection).toBeUndefined()
  })

  it('skips an already completed stage on the same snapshot', () => {
    const result = evaluate({
      params: {
        ...disableAllExcept('first_target_take_profit'),
        first_target_take_profit: {
          ...disableAllExcept('first_target_take_profit').first_target_take_profit,
          move_break_even: false,
        },
      },
      position: position({ direction: 'buy', open: 105, current: 108 }),
      quote: { bid: 108, ask: 108.1 },
      stage_state: { first_target_done: true },
    })

    expect(result.action.type).toBe(ACTION_TYPES.OBSERVE)
    expect(result.action.trigger_code).toBe(REASON_CODES.NONE)
  })
})

describe('break-even protection state machine', () => {
  it('returns move_protection only on the next evaluation after partial exit', () => {
    const first = evaluate({
      params: disableAllExcept('first_target_take_profit'),
      position: position({ direction: 'buy', open: 105, current: 108, sl: null }),
      quote: { bid: 108, ask: 108.1 },
    })
    const second = evaluate({
      params: disableAllExcept('first_target_take_profit'),
      position: position({ direction: 'buy', open: 105, current: 108, sl: null }),
      quote: { bid: 108, ask: 108.1 },
      stage_state: first.next_stage_state,
    })

    expect(first.action.type).toBe(ACTION_TYPES.PARTIAL_EXIT)
    expect(first.action.next_protection).toBeDefined()
    expect(second.action.type).toBe(ACTION_TYPES.MOVE_PROTECTION)
    expect(second.action.new_sl).toBe(107)
    expect(second.action.side_effect).toBe(true)
  })

  it.each([
    ['buy', 109, 107],
    ['sell', 101, 103],
  ])('never widens an existing %s stop', (direction, existingSl, desiredSl) => {
    const result = evaluate({
      params: disableAllExcept('first_target_take_profit'),
      position: position({ direction, open: 105, current: direction === 'buy' ? 108 : 102, sl: existingSl }),
      quote: direction === 'buy' ? { bid: 108, ask: 108.1 } : { bid: 102, ask: 102.1 },
      stage_state: { first_target_done: true },
    })

    expect(desiredSl).toBe(direction === 'buy' ? 107 : 103)
    expect(result.action.type).toBe(ACTION_TYPES.OBSERVE)
    expect(result.action.trigger_code).toBe(REASON_CODES.PROTECTION_ALREADY_STRICTER)
    expect(result.action.side_effect).toBe(false)
    expect(result.next_stage_state.breakEvenDone).toBe(true)
  })

  it('waits when broker distance prevents a stricter stop', () => {
    const result = evaluate({
      params: disableAllExcept('first_target_take_profit'),
      contract: { ...contract, stops_level_points: 500 },
      position: position({ direction: 'buy', open: 105, current: 105.1, sl: null }),
      quote: { bid: 107, ask: 107.1 },
      stage_state: { first_target_done: true },
    })

    expect(result.action.type).toBe(ACTION_TYPES.OBSERVE)
    expect(result.action.trigger_code).toBe(REASON_CODES.PROTECTION_NOT_READY)
    expect(result.action.side_effect).toBe(false)
  })
})

describe('fail-closed validation and scope', () => {
  it.each([
    [{ ...d1, method: 'fibonacci', high: Number.NaN }, 'invalid_d1_ohlc'],
    [{ ...d1, method: 'fibonacci', low: Number.POSITIVE_INFINITY }, 'invalid_d1_ohlc'],
    [{ ...d1, method: 'fibonacci', close: -1 }, 'invalid_d1_ohlc'],
    [{ ...d1, method: 'unknown' }, 'invalid_pivot_method'],
  ])('rejects invalid pivot input with stable code', (input, code) => {
    expect(calculatePivotLevels(input)).toMatchObject({ ok: false, error: { code } })
  })

  it('rejects invalid rule distances, percentages and missing contract specs', () => {
    expect(evaluate({
      params: {
        ...params(),
        break_stop: { ...params().break_stop, distance_price: -1 },
      },
    })).toMatchObject({ ok: false, error: { code: 'invalid_config_distance' } })
    expect(evaluate({
      params: {
        ...params(),
        first_target_take_profit: { ...params().first_target_take_profit, close_percent: 101 },
      },
    })).toMatchObject({ ok: false, error: { code: 'invalid_config_close_percent' } })
    expect(evaluate({ contract: undefined })).toMatchObject({ ok: false, error: { code: 'invalid_contract' } })
    expect(evaluate({ params: { ...params(), removed_control: 1 } }))
      .toMatchObject({ ok: false, error: { code: 'invalid_config_field' } })
  })

  it('accepts the nullable timestamp and numeric TINYINT stage values returned by MySQL', () => {
    const result = evaluate({
      params: disableAllExcept('break_stop'),
      stage_state: {
        pivot_cross_since_utc_ms: null,
        pivot_tp_done: 0,
        first_target_done: 1,
        break_even_pending: 0,
        break_even_done: 1,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.action.type).toBe(ACTION_TYPES.OBSERVE)
    expect(result.next_stage_state).toMatchObject({
      pivotCrossSinceMs: null,
      pivotTakeProfitDone: false,
      firstTargetDone: true,
      breakEvenPending: false,
      breakEvenDone: true,
    })
  })

  it.each([
    ['timestamp', { pivot_cross_since_utc_ms: 'not-a-timestamp' }, 'invalid_stage_state_timestamp'],
    ['flag', { first_target_done: 2 }, 'invalid_stage_state_flag'],
    ['flag', { first_target_done: '1' }, 'invalid_stage_state_flag'],
    ['flag', { first_target_done: null }, 'invalid_stage_state_flag'],
  ])('rejects an invalid non-null stage %s value', (_name, stageState, code) => {
    expect(evaluate({ stage_state: stageState })).toMatchObject({
      ok: false,
      error: { code },
    })
  })

  it('does not contain removed account-level protection state or execution controls', () => {
    const source = readFileSync(new URL('../../server/routes/ai/position-guard-engine.js', import.meta.url), 'utf8')

    expect(source).not.toMatch(/maxLoss|drawdown|InpMaxLoss|InpDrawdown|maxProfit/i)
    expect(source).not.toMatch(/magic|polling|retry/i)
  })
})
