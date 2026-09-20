import { describe, expect, it } from 'vitest'
import { projectChanStructureForModel, projectStrategyContextChanForModel } from '../src/modules/market/index.js'

describe('model Chan projection', () => {
  it.each([true, false])('retains only the matching active segment (confirmed=%s)', confirmed => {
    const source = {
      latest_structure: { active_segment: { stable_id: 'live', confirmed }, pivot_breach_time: 10 },
      current_segment: { stable_id: 'live' }, candidate_segment: { stable_id: 'live' },
      prev_segment: { stable_id: 'old' }, current_center: { id: 'old' }, price_vs_center: 'above',
      current_bi: { id: 1, start_price: 20, start_time_utc_msc: 10 },
      evidence_capabilities: { history_complete: true, data_complete: 1, reason_codes: ['internal'] },
    }
    const before = structuredClone(source)
    const result = projectChanStructureForModel(source)
    expect(result).toHaveProperty(confirmed ? 'current_segment' : 'candidate_segment', { stable_id: 'live' })
    expect(result).not.toHaveProperty(confirmed ? 'candidate_segment' : 'current_segment')
    for (const key of ['prev_segment', 'current_center', 'price_vs_center']) expect(result).not.toHaveProperty(key)
    expect(result.latest_structure).not.toHaveProperty('pivot_breach_time')
    expect(result.current_bi).toEqual({ id: 1, start_price: 20 })
    expect(result.current_bi).not.toBe(source.current_bi)
    expect(result.evidence_capabilities).toMatchObject({ history_complete: true, data_complete: false })
    expect(result.evidence_capabilities).not.toHaveProperty('reason_codes')
    expect(source).toEqual(before)
  })

  it('preserves unavailable calculations and unrelated context without inventing structures', () => {
    const source = { indicators: { ema: 7 }, timeframes: {
      M5: { summary: { chan: null } }, H1: { summary: {} },
      H4: { summary: { chan: { current_segment: null, status: 'internal' } } },
    } }
    const result = projectStrategyContextChanForModel(source)
    expect(result).toEqual({ indicators: { ema: 7 }, timeframes: {
      M5: { summary: { chan: null } }, H1: { summary: {} }, H4: { summary: { chan: { current_segment: null } } },
    } })
    expect(result.indicators).not.toBe(source.indicators)
  })

  it('rejects pointers and cycles but permits repeated ordinary objects', () => {
    expect(() => projectChanStructureForModel({ ignored: { $ref: '#/x' } })).toThrow('chan_model_payload_reference_forbidden')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => projectChanStructureForModel(cyclic)).toThrow('chan_model_payload_reference_forbidden')
    const shared = { id: 1 }
    expect(projectChanStructureForModel({ current_bi: shared, developing_bi: shared }))
      .toEqual({ current_bi: { id: 1 }, developing_bi: { id: 1 } })
  })
})
