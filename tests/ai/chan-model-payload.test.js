import { describe, expect, it } from 'vitest'
import {
  CHAN_MODEL_EVIDENCE_CAPABILITY_FIELDS,
  CHAN_MODEL_STRUCTURE_FIELDS,
  projectChanStructureForModel,
  projectStrategyContextChanForModel,
} from '../../server/routes/ai/chan-model-payload.js'

describe('Chan model payload projection', () => {
  it('keeps only the structure fields and boolean evidence capability whitelist', () => {
    const chan = {
      latest_structure: {
        local_state:'reversal_watch', local_bias:'down', background_bias:'up',
        active_pivot_state:'active', direction_basis:'developing_bi',
        latest_confirmed_fractal:{ type:'top', price:2010 },
        latest_confirmed_bi:{ id:1, dir:'up', start_price:1990, end_price:2010, confirmed:true,
          start_time_utc_msc:1, end_time_utc_msc:2 },
        pivot_breach_time_utc_msc:3,
        active_segment:{ stable_id:'segment-5', confirmed:false },
      },
      current_bi: { id:1, dir:'up', start_price:1990, end_price:2010, confirmed:true,
        start_time_utc_msc:1, end_time_utc_msc:2 },
      developing_bi: null,
      recent_bis: [{ id: 2 }],
      current_segment: { id: 3, confirmed: true, state: 'active', reason: '结构证据' },
      prev_segment: { id: 4 },
      candidate_segment: {
        id: 5, stable_id:'segment-5',
        confirmation_state:'awaiting_reverse_feature_fractal',
        confirmation_required:'reverse_feature_fractal',
        pending_endpoint_feature_gap:true,
        pending_endpoint_price:4696.7,
      },
      current_center: { lower: 1990, upper: 2010 },
      latest_center: { lower: 1980, upper: 2000 },
      latest_bi_center: { lower: 1970, upper: 1990 },
      active_center: { lower: 1960, upper: 1980 },
      divergence: { type: '底背驰', confirmed: true },
      forming_divergence: { type: '候选' },
      recent_divergences: [{ type: '顶背驰' }],
      entry_candidates: [{ type: '一买', price: 1995 }],
      trend_state: {
        state:'upward_breakout', direction:'up', phase:'breakout', confidence:'medium',
        reason:'price_above_closed_center_after_confirmed_rebreakout', center_id:1, segment_id:9,
      },
      price_vs_center: 'above',
      status: 'partial',
      evidence_capabilities: {
        history_complete:true,
        continuity_complete:true,
        topology_input_complete:true,
        data_complete:true,
        segment_direction_usable:true,
        center_structure_usable:false,
        entry_structure_usable:false,
        divergence_usable:false,
        reason_codes:['internal-only'],
      },
      warnings: ['internal-only'],
    }

    const projected = projectChanStructureForModel(chan)

    const retiredFields = new Set(['current_segment', 'prev_segment', 'current_center', 'latest_center'])
    expect(Object.keys(projected)).toEqual([
      ...CHAN_MODEL_STRUCTURE_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(chan, field)
        && !retiredFields.has(field)),
      'evidence_capabilities',
    ])
    expect(projected.current_bi).not.toBe(chan.current_bi)
    expect(projected.current_bi).toEqual({ id:1, dir:'up', start_price:1990, end_price:2010, confirmed:true })
    expect(projected.current_bi).not.toHaveProperty('start_time_utc_msc')
    expect(projected).not.toHaveProperty('current_segment')
    expect(projected).not.toHaveProperty('prev_segment')
    expect(projected).not.toHaveProperty('current_center')
    expect(projected).not.toHaveProperty('latest_center')
    expect(projected.latest_structure).toMatchObject({
      local_state:'reversal_watch', active_pivot_state:'active', direction_basis:'developing_bi',
      latest_confirmed_bi:{ id:1, dir:'up', start_price:1990, end_price:2010, confirmed:true },
    })
    expect(projected.latest_structure).not.toHaveProperty('pivot_breach_time_utc_msc')
    expect(projected.latest_structure.latest_confirmed_bi).not.toHaveProperty('start_time_utc_msc')
    expect(projected.latest_structure).not.toBe(chan.latest_structure)
    expect(projected.candidate_segment).toMatchObject({
      id:5,
      confirmation_state:'awaiting_reverse_feature_fractal',
      confirmation_required:'reverse_feature_fractal',
      pending_endpoint_feature_gap:true,
      pending_endpoint_price:4696.7,
    })
    expect(projected.trend_state).toEqual(chan.trend_state)
    expect(projected.trend_state).not.toBe(chan.trend_state)
    expect(projected.price_vs_center).toBe('above')
    expect(projected.evidence_capabilities).toEqual(Object.fromEntries(
      CHAN_MODEL_EVIDENCE_CAPABILITY_FIELDS.map(field => [field, chan.evidence_capabilities[field] === true]),
    ))
    expect(projected.evidence_capabilities).not.toHaveProperty('reason_codes')
    expect(projected).not.toHaveProperty('status')
    expect(projected).not.toHaveProperty('warnings')

    projected.current_bi.start_price = 1
    expect(chan.current_bi.start_price).toBe(1990)
    projected.evidence_capabilities.history_complete = false
    expect(chan.evidence_capabilities.history_complete).toBe(true)
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
          current_segment: { id: 1 },
          trend_state:{ state:'structural_rise_transition', direction:'up', phase:'transition' },
          price_vs_center:'none', structure_topology_reliable: true,
          evidence_capabilities:{ data_complete:true, reason_codes:['private'] },
        } }, klines: [{ close:2000 }] },
        M5: { summary: { chan: null }, klines: [] },
        M15: { summary: { other: true } },
      },
    }

    const projected = projectStrategyContextChanForModel(context)

    expect(projected).not.toBe(context)
    expect(projected.indicators).not.toBe(context.indicators)
    expect(projected.timeframes.H1.summary.chan).toEqual({
      current_segment:{ id:1 },
      price_vs_center:'none',
      trend_state:{ state:'structural_rise_transition', direction:'up', phase:'transition' },
      evidence_capabilities:Object.fromEntries(CHAN_MODEL_EVIDENCE_CAPABILITY_FIELDS
        .map(field => [field, field === 'data_complete'])),
    })
    expect(projected.timeframes.H1.summary.chan).not.toHaveProperty('structure_topology_reliable')
    expect(projected.timeframes.M5.summary.chan).toBeNull()
    expect(projected.timeframes.M15.summary).toEqual({ other:true })
    expect(context.timeframes.H1.summary.chan).toHaveProperty('trend_state.state', 'structural_rise_transition')
    expect(context.timeframes.H1.summary.chan).toHaveProperty('structure_topology_reliable', true)
  })

  it('rejects JSON-pointer references in new model-facing Chan structures', () => {
    const context = { timeframes: { H1: { summary: { chan: {
      current_segment: { $ref:'#/legacy/current_segment' },
    } } } } }
    expect(() => projectStrategyContextChanForModel(context))
      .toThrow('chan_model_payload_reference_forbidden')
  })

  it('rejects cyclic model-facing Chan structures', () => {
    const chan = { current_segment:{ id:1 } }
    chan.current_segment.parent = chan
    expect(() => projectChanStructureForModel(chan))
      .toThrow('chan_model_payload_reference_forbidden')
  })
})
