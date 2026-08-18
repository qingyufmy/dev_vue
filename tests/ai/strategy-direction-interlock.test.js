import { describe, expect, it } from 'vitest'
import { applyStrategyDirectionInterlock, resolveStrategyDirectionInterlock,
  STRATEGY_REFERENCE_REFRESH_REASON, STRATEGY_REVERSAL_WAIT_REASON,
} from '../../server/routes/ai/strategy-direction-interlock.js'

const tradeSignal = (overrides = {}) => ({
  signal_type:'sell', entry_method:'market', position_action:'open',
  position_size_tier:'probe', position_size_factor:0.25,
  stop_loss_price:4428, take_profit_1_price:4388,
  execution_validation:{ status:'eligible', eligible:true, reason_codes:[] },
  _position_management:{ position_evaluations:overrides.position_evaluations || [] },
  ...overrides,
})

describe('platform strategy direction interlock', () => {
  it('blocks signal 24414 shape while preserving management evaluations', () => {
    const signal = tradeSignal({ position_evaluations:[
      { management_group_id:'group-46', action:'hold', reversal_candidate:true },
      { management_group_id:'group-47', action:'hold', reversal_candidate:true },
    ] })
    const portfolio = { positions:[
      { management_group_id:'group-46', direction:'buy' },
      { management_group_id:'group-47', direction:'buy' },
    ], pending_orders:[] }
    const resolution = resolveStrategyDirectionInterlock({
      signal, frozenPortfolio:portfolio, freshPortfolio:portfolio, blockingTasks:[],
    })
    const blocked = applyStrategyDirectionInterlock(signal, resolution, { latest_price:4395 })

    expect(resolution).toMatchObject({ allowed:false, reason_code:STRATEGY_REVERSAL_WAIT_REASON,
      frozen_opposite_count:2, fresh_opposite_count:2 })
    expect(blocked).toMatchObject({ signal_type:'hold', entry_method:'observe', position_action:'observe',
      candidate_entry:{ signal_type:'sell', direction:'sell', entry_price:4395 },
      execution_validation:{ status:'ineligible', eligible:false,
        reason_codes:[STRATEGY_REVERSAL_WAIT_REASON] } })
    expect(blocked._position_management).toBe(signal._position_management)
  })

  it('still blocks the same cycle when the fresh portfolio became flat', () => {
    const result = resolveStrategyDirectionInterlock({
      signal:tradeSignal(),
      frozenPortfolio:{ positions:[{ direction:'buy' }], pending_orders:[] },
      freshPortfolio:{ positions:[], pending_orders:[] },
      blockingTasks:[],
    })
    expect(result).toMatchObject({ allowed:false, frozen_opposite_count:1, fresh_opposite_count:0 })
  })

  it('allows a later fresh inference only when both snapshots are flat and tasks are settled', () => {
    const result = resolveStrategyDirectionInterlock({
      signal:tradeSignal(), frozenPortfolio:{ positions:[], pending_orders:[] },
      freshPortfolio:{ positions:[], pending_orders:[] }, blockingTasks:[],
    })
    expect(result).toMatchObject({ allowed:true, reason_code:null })
  })

  it('blocks unresolved opposite-direction tasks even after both snapshots are flat', () => {
    const result = resolveStrategyDirectionInterlock({
      signal:tradeSignal(), frozenPortfolio:{ positions:[], pending_orders:[] },
      freshPortfolio:{ positions:[], pending_orders:[] },
      blockingTasks:[{ task_id:8, direction:'buy', status:'MANUAL_REVIEW' }],
    })
    expect(result).toMatchObject({ allowed:false, blocking_task_count:1 })
  })

  it('fails closed for an unresolved task whose direction is unavailable', () => {
    const result = resolveStrategyDirectionInterlock({
      signal:tradeSignal(), frozenPortfolio:{ positions:[], pending_orders:[] },
      freshPortfolio:{ positions:[], pending_orders:[] },
      blockingTasks:[{ task_id:9, direction:null, status:'FAILED' }],
    })
    expect(result).toMatchObject({ allowed:false, blocking_task_count:1 })
  })

  it('fails closed when the post-model reference refresh is unavailable', () => {
    const result = resolveStrategyDirectionInterlock({
      signal:tradeSignal(), frozenPortfolio:{ positions:[], pending_orders:[] },
      freshPortfolio:null, refreshAvailable:false,
    })
    expect(result).toMatchObject({ allowed:false, reason_code:STRATEGY_REFERENCE_REFRESH_REASON })
  })

  it('fails closed when the frozen model snapshot had no trustworthy portfolio', () => {
    const result = resolveStrategyDirectionInterlock({
      signal:tradeSignal(),
      frozenPortfolio:{ status:'unavailable', positions:[], pending_orders:[] },
      freshPortfolio:{ positions:[], pending_orders:[] }, refreshAvailable:true,
    })
    expect(result).toMatchObject({ allowed:false, reason_code:STRATEGY_REFERENCE_REFRESH_REASON })
  })

  it('does not apply to observation signals', () => {
    const signal = { signal_type:'hold', entry_method:'observe' }
    expect(resolveStrategyDirectionInterlock({ signal })).toEqual({ allowed:true, applicable:false, reason_code:null })
  })
})
