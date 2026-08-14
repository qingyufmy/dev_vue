import { describe, expect, it } from 'vitest'
import {
  CHAN_MODEL_STRUCTURE_FIELDS,
  projectChanStructureForModel,
  projectStrategyContextChanForModel,
} from '../../server/routes/ai/chan-model-payload.js'

describe('Chan model payload projection', () => {
  it('keeps only the fourteen structure fields and deep-clones their values', () => {
    const chan = {
      current_bi: { id: 1, points: [{ price: 2000 }] },
      developing_bi: null,
      recent_bis: [{ id: 2 }],
      current_segment: { id: 3, confirmed: true, state: 'active', reason: '结构证据' },
      prev_segment: { id: 4 },
      candidate_segment: { id: 5 },
      current_center: { lower: 1990, upper: 2010 },
      latest_center: { lower: 1980, upper: 2000 },
      latest_bi_center: { lower: 1970, upper: 1990 },
      active_center: { lower: 1960, upper: 1980 },
      divergence: { type: '底背驰', confirmed: true },
      forming_divergence: { type: '候选' },
      recent_divergences: [{ type: '顶背驰' }],
      entry_candidates: [{ type: '一买', price: 1995 }],
      trend_state: 'up',
      price_vs_center: 'above',
      status: 'partial',
      evidence_capabilities: { entry_structure_usable: false },
      warnings: ['internal-only'],
    }

    const projected = projectChanStructureForModel(chan)

    expect(Object.keys(projected)).toEqual(CHAN_MODEL_STRUCTURE_FIELDS)
    expect(projected).toEqual(Object.fromEntries(CHAN_MODEL_STRUCTURE_FIELDS
      .filter(field => Object.prototype.hasOwnProperty.call(chan, field))
      .map(field => [field, chan[field]])))
    expect(projected.current_bi).not.toBe(chan.current_bi)
    expect(projected.current_bi.points).not.toBe(chan.current_bi.points)
    expect(projected.current_segment).toMatchObject({ confirmed:true, state:'active', reason:'结构证据' })
    expect(projected).not.toHaveProperty('trend_state')
    expect(projected).not.toHaveProperty('price_vs_center')
    expect(projected).not.toHaveProperty('evidence_capabilities')
    expect(projected).not.toHaveProperty('status')
    expect(projected).not.toHaveProperty('warnings')

    projected.current_bi.points[0].price = 1
    expect(chan.current_bi.points[0].price).toBe(2000)
  })

  it('does not invent absent fields and preserves explicit null structure values', () => {
    const chan = { current_segment: null, entry_candidates: [], status: 'ok' }
    expect(projectChanStructureForModel(chan)).toEqual({ current_segment:null, entry_candidates:[] })
    expect(projectChanStructureForModel(null)).toEqual({})
    expect(projectChanStructureForModel(undefined)).toEqual({})
    expect(projectChanStructureForModel([])).toEqual({})
  })

  it('projects each timeframe without mutating the full strategy context', () => {
    const context = {
      indicators: { entry_ema34: { ready:true, value:2001 } },
      timeframes: {
        H1: { summary: { chan: {
          current_segment: { id: 1 }, trend_state: 'up', structure_topology_reliable: true,
        } }, klines: [{ close:2000 }] },
        M5: { summary: { chan: null }, klines: [] },
        M15: { summary: { other: true } },
      },
    }

    const projected = projectStrategyContextChanForModel(context)

    expect(projected).not.toBe(context)
    expect(projected.indicators).not.toBe(context.indicators)
    expect(projected.timeframes.H1.summary.chan).toEqual({ current_segment:{ id:1 } })
    expect(projected.timeframes.H1.summary.chan).not.toHaveProperty('trend_state')
    expect(projected.timeframes.H1.summary.chan).not.toHaveProperty('structure_topology_reliable')
    expect(projected.timeframes.M5.summary.chan).toBeNull()
    expect(projected.timeframes.M15.summary).toEqual({ other:true })
    expect(context.timeframes.H1.summary.chan).toHaveProperty('trend_state', 'up')
    expect(context.timeframes.H1.summary.chan).toHaveProperty('structure_topology_reliable', true)
  })

  it('rejects JSON-pointer references in new model-facing Chan structures', () => {
    const context = { timeframes: { H1: { summary: { chan: {
      current_segment: { $ref:'#/legacy/current_segment' },
    } } } } }
    expect(() => projectStrategyContextChanForModel(context))
      .toThrow('chan_model_payload_reference_forbidden')
  })
})
