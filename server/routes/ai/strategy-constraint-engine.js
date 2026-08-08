export const STRATEGY_CONSTRAINT_ENGINE_VERSION = 'strategy-constraint-engine-v1'

function pathValue(root, path) {
  return String(path || '').split('.').reduce((value, key) => {
    if (value == null || typeof value !== 'object') return undefined
    return Object.hasOwn(value, key) ? value[key] : undefined
  }, root)
}

function operandValue(operand, context) {
  if (operand && typeof operand === 'object' && !Array.isArray(operand) && Object.hasOwn(operand, 'ref')) {
    return pathValue(context, operand.ref)
  }
  if (Array.isArray(operand)) return operand.map(item => operandValue(item, context))
  return operand
}

function sameValue(left, right) {
  if (left === right) return true
  if (typeof left === 'number' || typeof right === 'number') {
    const a = Number(left)
    const b = Number(right)
    return Number.isFinite(a) && Number.isFinite(b) && a === b
  }
  return false
}

export function evaluatePolicyExpression(expression, context = {}) {
  if (!expression || typeof expression !== 'object') return false
  if (Array.isArray(expression.all)) return expression.all.every(item => evaluatePolicyExpression(item, context))
  if (Array.isArray(expression.any)) return expression.any.some(item => evaluatePolicyExpression(item, context))
  if (expression.not) return !evaluatePolicyExpression(expression.not, context)
  const left = operandValue(expression.left, context)
  const right = operandValue(expression.right, context)
  switch (expression.op) {
    case 'eq': return sameValue(left, right)
    case 'neq': return !sameValue(left, right)
    case 'gt': return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) > Number(right)
    case 'gte': return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) >= Number(right)
    case 'lt': return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) < Number(right)
    case 'lte': return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) <= Number(right)
    case 'in': return Array.isArray(right) && right.some(item => sameValue(left, item))
    default: return false
  }
}

function actionPriority(action) {
  return { allow:0, skip_stage:1, hold_new_entry:2, reject_submission:3 }[action] ?? 0
}

export function evaluateStrategyConstraints(compiledPolicy, context, phase) {
  const results = []
  let action = 'allow'
  for (const constraint of compiledPolicy?.constraints || []) {
    if (!constraint.phases.includes(phase)) continue
    const applicable = constraint.when ? evaluatePolicyExpression(constraint.when, context) : true
    const passed = !applicable || evaluatePolicyExpression(constraint.require, context)
    const resultAction = passed ? 'allow' : constraint.on_fail
    if (actionPriority(resultAction) > actionPriority(action)) action = resultAction
    results.push({
      id:constraint.id,
      phase,
      scope:constraint.scope,
      applicable,
      passed,
      action:resultAction,
      counts_as_trigger:constraint.counts_as_trigger === true,
    })
  }
  return {
    engine_version:STRATEGY_CONSTRAINT_ENGINE_VERSION,
    phase,
    passed:results.every(result => result.passed),
    action,
    results,
  }
}

export function holdNewEntry(signal, gate = {}) {
  const result = { ...(signal || {}) }
  const originalType = String(result.signal_type || 'hold').toLowerCase()
  if (originalType === 'hold') return { ...result, strategy_policy_gate:gate }
  result.candidate_entry ||= {
    signal_type:originalType,
    direction:originalType.startsWith('buy') ? 'buy' : originalType.startsWith('sell') ? 'sell' : 'none',
    entry_method:result.entry_method || null,
    entry_price:result.limit_price ?? null,
    stop_limit_price:result.stop_limit_price ?? null,
    stop_loss_price:result.stop_loss_price ?? null,
    take_profit_1_price:result.take_profit_1_price ?? null,
    take_profit_2_price:result.take_profit_2_price ?? null,
    take_profit_3_price:result.take_profit_3_price ?? null,
  }
  result.signal_type = 'hold'
  result.entry_method = 'observe'
  result.recommended_volume = 0
  result.position_size_tier = 'observe'
  result.position_size_factor = 0
  result.limit_price = null
  result.stop_limit_price = null
  result.stop_loss_price = null
  result.take_profit_1_price = null
  result.take_profit_2_price = null
  result.take_profit_3_price = null
  result.pending_valid_until = null
  result.strategy_policy_gate = gate
  return result
}

export function applyConstraintAction(signal, evaluation) {
  if (!evaluation || evaluation.action === 'allow' || evaluation.action === 'skip_stage') {
    return { signal:{ ...(signal || {}), strategy_policy_gate:evaluation || null }, rejected:false }
  }
  if (evaluation.action === 'hold_new_entry') {
    return { signal:holdNewEntry(signal, evaluation), rejected:false }
  }
  return {
    signal:holdNewEntry(signal, evaluation),
    rejected:true,
    reason:'strategy_policy_submission_rejected',
  }
}
