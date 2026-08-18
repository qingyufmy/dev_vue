import { readExecutionValidation } from './signal-execution-validation.js'

export const STRATEGY_REVERSAL_WAIT_REASON = 'strategy_reversal_waiting_for_exit'
export const STRATEGY_REFERENCE_REFRESH_REASON = 'strategy_reference_portfolio_refresh_unavailable'

function direction(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized.startsWith('buy')) return 'buy'
  if (normalized.startsWith('sell')) return 'sell'
  return null
}

function portfolioRows(portfolio) {
  return [
    ...(Array.isArray(portfolio?.positions) ? portfolio.positions : []),
    ...(Array.isArray(portfolio?.pending_orders) ? portfolio.pending_orders : []),
  ]
}

function conflictingRows(portfolio, candidateDirection) {
  const opposite = candidateDirection === 'buy' ? 'sell' : 'buy'
  return portfolioRows(portfolio).filter(row => direction(row?.direction || row?.side || row?.order_type) === opposite)
}

export function resolveStrategyDirectionInterlock({ signal, frozenPortfolio, freshPortfolio,
  blockingTasks = [], refreshAvailable = true } = {}) {
  const candidateDirection = direction(signal?.signal_type)
  if (!candidateDirection) return { allowed:true, applicable:false, reason_code:null }
  const frozenAvailable = frozenPortfolio && typeof frozenPortfolio === 'object'
    && String(frozenPortfolio.status || '').toLowerCase() !== 'unavailable'
    && Array.isArray(frozenPortfolio.positions) && Array.isArray(frozenPortfolio.pending_orders)
  const freshAvailable = freshPortfolio && typeof freshPortfolio === 'object'
    && String(freshPortfolio.status || '').toLowerCase() !== 'unavailable'
    && Array.isArray(freshPortfolio.positions) && Array.isArray(freshPortfolio.pending_orders)
  if (!refreshAvailable || !frozenAvailable || !freshAvailable) {
    return {
      allowed:false,
      applicable:true,
      reason_code:STRATEGY_REFERENCE_REFRESH_REASON,
      candidate_direction:candidateDirection,
      frozen_opposite_count:conflictingRows(frozenPortfolio, candidateDirection).length,
      fresh_opposite_count:null,
      blocking_task_count:0,
    }
  }

  const frozenConflicts = conflictingRows(frozenPortfolio, candidateDirection)
  const freshConflicts = conflictingRows(freshPortfolio, candidateDirection)
  const opposite = candidateDirection === 'buy' ? 'sell' : 'buy'
  const taskConflicts = (Array.isArray(blockingTasks) ? blockingTasks : [])
    .filter(task => !direction(task?.direction) || direction(task?.direction) === opposite)
  const blocked = frozenConflicts.length > 0 || freshConflicts.length > 0 || taskConflicts.length > 0
  return {
    allowed:!blocked,
    applicable:true,
    reason_code:blocked ? STRATEGY_REVERSAL_WAIT_REASON : null,
    candidate_direction:candidateDirection,
    frozen_opposite_count:frozenConflicts.length,
    fresh_opposite_count:freshConflicts.length,
    blocking_task_count:taskConflicts.length,
  }
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function candidateEntry(signal, market) {
  const signalType = String(signal?.signal_type || '').trim().toLowerCase()
  const entryMethod = String(signal?.entry_method || 'market').trim().toLowerCase()
  return {
    signal_type:signalType,
    direction:direction(signalType),
    entry_method:entryMethod,
    entry_price:positiveNumber(entryMethod === 'market' ? market?.latest_price : signal?.limit_price),
    stop_limit_price:positiveNumber(signal?.stop_limit_price),
    stop_loss_price:positiveNumber(signal?.stop_loss_price),
    take_profit_1_price:positiveNumber(signal?.take_profit_1_price),
    take_profit_2_price:positiveNumber(signal?.take_profit_2_price),
    take_profit_3_price:positiveNumber(signal?.take_profit_3_price),
  }
}

/** Block only the new-entry axis. Position-management evaluations remain on
 * the signal so they can still be persisted and executed through lineage. */
export function applyStrategyDirectionInterlock(signal, resolution, market = {}) {
  if (!signal || resolution?.allowed !== false) return signal
  const previousValidation = readExecutionValidation(signal).validation
  const reasonCodes = [...new Set([
    ...(Array.isArray(previousValidation.reason_codes) ? previousValidation.reason_codes : []),
    resolution.reason_code || STRATEGY_REVERSAL_WAIT_REASON,
  ])]
  const originalType = String(signal.signal_type || '').trim().toLowerCase()
  const originalEntryMethod = String(signal.entry_method || 'market').trim().toLowerCase()
  return {
    ...signal,
    signal_type:'hold',
    entry_method:'observe',
    position_action:'observe',
    recommended_volume:0,
    position_size_tier:'observe',
    position_size_factor:0,
    position_size_reason:'旧方向持仓或挂单尚未完成退出，本轮不允许反向开仓。',
    decision_summary:'旧方向尚未完成退出和对账，本轮仅管理现有订单，不执行反向开仓。',
    candidate_entry:signal.candidate_entry || candidateEntry(signal, market),
    limit_price:null,
    stop_limit_price:null,
    stop_loss_price:null,
    take_profit_1_price:null,
    take_profit_2_price:null,
    take_profit_3_price:null,
    recommended_take_profit_tier:null,
    pending_valid_minutes:0,
    pending_valid_until:null,
    normalization_info:{
      type:'strategy_direction_interlock',
      reason:resolution.reason_code || STRATEGY_REVERSAL_WAIT_REASON,
      original_signal_type:originalType,
      original_entry_method:originalEntryMethod,
    },
    direction_interlock:{ ...resolution },
    execution_validation:{ status:'ineligible', eligible:false, reason_codes:reasonCodes },
  }
}
