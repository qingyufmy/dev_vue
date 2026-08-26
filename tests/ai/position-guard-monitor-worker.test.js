import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const previousPositionGuardFeature = process.env.POSITION_GUARD_FEATURE_ENABLED
beforeAll(() => { process.env.POSITION_GUARD_FEATURE_ENABLED = 'true' })
afterAll(() => {
  if (previousPositionGuardFeature === undefined) delete process.env.POSITION_GUARD_FEATURE_ENABLED
  else process.env.POSITION_GUARD_FEATURE_ENABLED = previousPositionGuardFeature
})
import {
  exactPositionGuardTarget,
  positionGuardBusinessDate,
  selectPositionGuardD1Window,
} from '../../server/workers/position-guard-monitor-worker.js'

describe('position guard monitor market-day helpers', () => {
  it('derives the terminal business date from a verified quote offset', () => {
    const observed = Date.parse('2026-08-24T22:30:00.000Z')
    expect(positionGuardBusinessDate(observed, 180)).toBe('2026-08-25')
    expect(positionGuardBusinessDate(observed, null)).toBeNull()
    expect(positionGuardBusinessDate(observed, 900)).toBeNull()
  })

  it('selects the previous closed D1 candle while the current candle is live', () => {
    const result = selectPositionGuardD1Window({
      status:'success',
      rates:[
        { time_utc_msc:1000, high:110, low:90, close:100 },
        { time_utc_msc:2000, high:120, low:100, close:110 },
      ],
      market_meta:{ last_bar_closed:false },
    })
    expect(result).toMatchObject({
      ok:true,
      previous_open_utc_msc:1000,
      current_open_utc_msc:2000,
      d1:{ high:110, low:90, close:100 },
    })
  })

  it('uses the final candle when the source explicitly marks it closed', () => {
    const result = selectPositionGuardD1Window({
      status:'success',
      rates:[{ time_utc_msc:1000, high:110, low:90, close:100 }],
      market_meta:{ last_bar_closed:true },
    })
    expect(result.ok).toBe(true)
    expect(result.previous_open_utc_msc).toBe(1000)
    expect(result.current_open_utc_msc).toBe(86_401_000)
  })

  it('fails closed when a live D1 window has no prior closed candle', () => {
    expect(selectPositionGuardD1Window({
      status:'success',
      rates:[{ time_utc_msc:2000, high:120, low:100, close:110 }],
      market_meta:{ last_bar_closed:false },
    })).toEqual({ ok:false, code:'position_guard_d1_not_ready' })
  })

  it('admits only the exact attributed system ticket', () => {
    const outcome = {
      status:'open', attribution_status:'attributed', external_intervention:0,
      system_magic:234000, position_id:'100', original_symbol:'XAUUSD.s', entry_direction:'buy',
    }
    const inventory = { positions:[{
      ticket:'100', symbol:'XAUUSD.s', type:'buy', magic:234000,
      volume:0.2, price_open:2300,
    }] }
    expect(exactPositionGuardTarget(outcome, inventory)).toMatchObject({ ticket:'100' })
    expect(exactPositionGuardTarget({ ...outcome, external_intervention:1 }, inventory)).toBeNull()
    expect(exactPositionGuardTarget(outcome, { positions:[{ ...inventory.positions[0], magic:7 }] })).toBeNull()
    expect(exactPositionGuardTarget(outcome, { positions:[{ ...inventory.positions[0], ticket:'101' }] })).toBeNull()
  })
})
