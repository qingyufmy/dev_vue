import { describe, expect, it } from 'vitest'
import { buildDecisionDiagnostics } from '../../server/routes/ai/decision-diagnostics.js'

function frame({ dataComplete = true, directionUsable = true, direction = 'up', reasons = [], gap = false } = {}) {
  return { summary:{ chan:{
    cache_internal_gap_unresolved:gap,
    evidence_capabilities:{
      data_complete:dataComplete,
      segment_direction_usable:directionUsable,
      center_structure_usable:directionUsable,
      entry_structure_usable:directionUsable,
      reason_codes:reasons,
    },
    trend_state:{ direction },
  } } }
}

describe('decision diagnostics', () => {
  it('reports neutral data quality without inferring a strategy hold from Chan capabilities', () => {
    const result = buildDecisionDiagnostics({
      signal:{ signal_type:'hold', entry_method:'observe' },
      market:{ strategy_context:{ timeframes:{
        M5:frame({ dataComplete:false, directionUsable:false, gap:true, reasons:['cache_internal_gap_unresolved'] }),
        M15:frame({ direction:'down' }),
        H1:frame({ directionUsable:false, reasons:['no_confirmed_center'] }),
        H4:frame({ direction:'up' }),
      } } },
    })
    expect(result).toMatchObject({
      decision_diagnostics_version:1,
      decision_origin:'model',
      contributing_reasons:['market_data_unreliable'],
      affected_timeframes:['M5'],
    })
    expect(result.reason_details[0]).toMatchObject({ code:'market_data_unreliable', timeframes:['M5'] })
    expect(JSON.stringify(result)).not.toContain('structure_unconfirmed')
  })

  it('does not infer a strategy reason from usable data with unavailable Chan capabilities', () => {
    const result = buildDecisionDiagnostics({
      signal:{ signal_type:'hold', entry_method:'observe' },
      market:{ strategy_context:{ timeframes:{
        H1:frame({ directionUsable:false, reasons:[
          'no_confirmed_center', 'entry_structure_unusable', 'divergence_unusable',
        ] }),
      } } },
    })
    expect(result).toMatchObject({
      decision_origin:'model',
      contributing_reasons:['model_hold'],
      affected_timeframes:[],
    })
    expect(result.reason_details.some(item => item.code === 'structure_unconfirmed')).toBe(false)
  })

  it('attributes an enforced workflow hold to the constraint engine', () => {
    const result = buildDecisionDiagnostics({
      signal:{ signal_type:'hold', entry_method:'observe', candidate_entry:{ signal_type:'buy' } },
      modelSignalType:'buy',
      strategyPolicyRuntime:{ mode:'enforce', workflow_state:{ compliant:true, decision:{ defaulted:true } } },
    })
    expect(result).toMatchObject({
      decision_origin:'constraint_engine',
      contributing_reasons:['strategy_entry_conditions_unmet'],
    })
  })

  it('does not claim the constraint engine changed an existing model hold', () => {
    const result = buildDecisionDiagnostics({
      signal:{ signal_type:'hold', entry_method:'observe' },
      modelSignalType:'hold',
      strategyPolicyRuntime:{ mode:'enforce', workflow_state:{ compliant:true, decision:{ defaulted:true } } },
    })
    expect(result).toMatchObject({ decision_origin:'model', contributing_reasons:['model_hold'] })
  })

  it('attributes schema normalization without parsing model prose', () => {
    const result = buildDecisionDiagnostics({
      signal:{ signal_type:'hold', reasoning:'market_data_unreliable is written by the model',
        normalization_info:{ type:'l5_schema_hold', reason:'invalid_stop' } },
    })
    expect(result).toMatchObject({ decision_origin:'schema_normalized', contributing_reasons:[] })
  })

  it('does not present unused structure limitations as a cause of a trade decision', () => {
    const result = buildDecisionDiagnostics({
      signal:{ signal_type:'buy', entry_method:'market' },
      market:{ strategy_context:{ timeframes:{ H1:frame({ directionUsable:false, reasons:['no_confirmed_center'] }) } } },
    })
    expect(result).toMatchObject({ decision_origin:'model', contributing_reasons:[], affected_timeframes:[] })
  })

  it('does not use legacy market scoring to explain or rewrite a model decision', () => {
    const input = { signal:{ signal_type:'hold', entry_method:'observe' } }
    const baseline = buildDecisionDiagnostics({
      ...input,
      market:{ strategy_score:{ trend_strength:0, data_confidence:0.05, momentum_alignment:-1 } },
    })
    const highScore = buildDecisionDiagnostics({
      ...input,
      market:{ strategy_score:{ trend_strength:1, data_confidence:0.95, momentum_alignment:1 } },
    })
    expect(highScore).toEqual(baseline)
    expect(highScore).toMatchObject({ decision_origin:'model', contributing_reasons:['model_hold'] })
  })
})
