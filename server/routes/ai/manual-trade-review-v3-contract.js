import {
  requiredManualReviewConfidence,
  requiredManualReviewObject,
  requiredManualReviewText,
  validateFrozenStrategyPath,
  validateManualReviewEvidenceRefs,
} from './manual-trade-review-contract.js'

export const MANUAL_TRADE_REVIEW_V3_VERSION = 'manual-trade-review-v3'
export const MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION = 'manual-trade-counterfactual-point-v3'
export const MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION = 'manual-trade-review-aggregate-v1'

const CANDIDATE_KEYS = new Set([
  'anchor_minus_2', 'anchor_minus_1', 'anchor', 'anchor_plus_1', 'anchor_plus_2',
])
const CANDIDATE_KEY_OFFSET = new Map([
  ['anchor_minus_2', -2], ['anchor_minus_1', -1], ['anchor', 0],
  ['anchor_plus_1', 1], ['anchor_plus_2', 2],
])
const DECISIONS = new Set(['buy', 'sell', 'hold', 'insufficient_evidence'])
const ENTRY_METHODS = new Set(['market', 'limit', 'stop', 'stop_limit', 'observe', 'unknown'])
const POSITION_SIZE_TIERS = new Set(['none', 'probe', 'light', 'standard', 'unknown'])
const DIRECTION_MATCHES = new Set([
  'same_direction_entry', 'same_direction_observe', 'opposite_direction', 'hold', 'insufficient_evidence',
])
const PROTECTION_QUALITIES = new Set(['reasonable', 'partial', 'unreasonable', 'unknown'])
const ORIGINS = new Set(['strategy_derived', 'manual_logic_inferred', 'unexplained'])
const RULE_STATUSES = new Set(['aligned', 'partial', 'conflict', 'unknown', 'not_applicable'])
const OPTIMIZATION_STATES = new Set(['hypothesis', 'insufficient_evidence'])
const AGGREGATE_RECOMMENDATION_STATES = new Set(['observe', 'ready_for_human_review', 'insufficient_evidence'])
const EXECUTION_FEASIBILITY = new Set(['pass', 'fail', 'unknown'])
const REVIEW_TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])

const MAX_SIGNAL_COUNT = 20
const MAX_BLOCKING_RULE_COUNT = 20
const MAX_EVIDENCE_REF_COUNT = 40
const MAX_TAKE_PROFIT_COUNT = 10
const MAX_CHAIN_COUNT = 40
const MAX_HYPOTHESIS_COUNT = 30
const MAX_SOURCE_COUNT = 20

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function error(code) {
  throw new Error(`manual_trade_review_v3_${code}`)
}

function normalizedText(value, field, max = 6000) {
  try {
    return requiredManualReviewText(value, field, max)
  } catch {
    error(`${field}_required`)
  }
}

function optionalText(value, field, max = 6000) {
  if (value == null || String(value).trim() === '') return null
  return normalizedText(value, field, max)
}

function boundedNumber(value, field, { positive = false, nonNegative = false } = {}) {
  if (value == null || value === '') error(`${field}_invalid`)
  if (typeof value === 'boolean') error(`${field}_invalid`)
  const number = Number(value)
  if (!Number.isFinite(number)
    || (positive && number <= 0)
    || (nonNegative && number < 0)) error(`${field}_invalid`)
  return number
}

function integerNumber(value, field) {
  const number = boundedNumber(value, field)
  if (!Number.isSafeInteger(number)) error(`${field}_invalid`)
  return number
}

function optionalNumber(value, field, { positive = false, nonNegative = false } = {}) {
  if (value == null || value === '') return null
  return boundedNumber(value, field, { positive, nonNegative })
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') error(`${field}_invalid`)
  return value
}

function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.has(value)) error(`${field}_invalid`)
  return value
}

function arrayValue(value, field, max, { required = true } = {}) {
  if (!Array.isArray(value)) error(`${field}_required`)
  if (required && value.length === 0) error(`${field}_required`)
  return value.slice(0, max)
}

function setFromRefs(value) {
  if (value instanceof Set) return value
  return new Set(Array.isArray(value) ? value.map(item => String(item)) : [])
}

function evidenceRefs(value, allowedEvidenceRefs, field = 'evidence_refs') {
  const refs = arrayValue(value, field, MAX_EVIDENCE_REF_COUNT)
  try {
    return validateManualReviewEvidenceRefs(refs, setFromRefs(allowedEvidenceRefs), { required:true })
  } catch {
    error(`${field}_invalid`)
  }
}

function allowedRefs(options = {}) {
  const value = options.allowedEvidenceRefs ?? options.allowed_evidence_refs ?? options.evidenceRefs
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set)) {
    return [value.pre_entry_refs, value.outcome_refs, value.evidence_refs]
      .flatMap(item => Array.isArray(item) ? item : [])
  }
  return value
}

function strategySnapshotFromOptions(options = {}) {
  return options.strategySnapshot ?? options.strategy_snapshot ?? options.frozenStrategy ?? options.frozen_strategy
}

function normalizeTimeframe(value) {
  const normalized = String(value == null ? '' : value).trim().toUpperCase()
  return REVIEW_TIMEFRAMES.has(normalized) ? normalized : null
}

function declaredTimeframes(strategySnapshot = {}) {
  const plan = strategySnapshot?.market_data_plan || strategySnapshot?.marketDataPlan || {}
  const raw = Array.isArray(plan.timeframes) ? plan.timeframes : []
  const values = raw.map(item => typeof item === 'string' ? item : item?.timeframe ?? item?.tf)
  const primary = plan.primary_timeframe ?? plan.primaryTimeframe
  return new Set([...values, primary].map(normalizeTimeframe).filter(Boolean))
}

function optionTimeframes(options = {}, field, fallback = []) {
  const supplied = options[field] ?? options[field.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)]
  const values = supplied instanceof Set ? [...supplied] : Array.isArray(supplied) ? supplied : fallback
  return new Set(values.map(normalizeTimeframe).filter(Boolean))
}

function evidenceReferenceTimeframe(value) {
  const parts = String(value == null ? '' : value).split(':')
  return normalizeTimeframe(parts.at(-1))
}

function ensureTimeframeEvidence(timeframes, refs, field) {
  if (!timeframes.size) return
  const referenceTimeframes = refs.map(evidenceReferenceTimeframe).filter(Boolean)
  if (!referenceTimeframes.length || referenceTimeframes.some(value => !timeframes.has(value))) {
    error(`${field}_evidence_timeframe_invalid`)
  }
  for (const timeframe of timeframes) {
    if (!referenceTimeframes.includes(timeframe)) error(`${field}_evidence_timeframe_missing`)
  }
}

function validateOutputTimeframe(value, field, options = {}, refs = [], {
  requireStrategyDeclared = true, checkEvidenceRefs = true,
} = {}) {
  const timeframe = normalizeTimeframe(value)
  if (!timeframe) error(`${field}_invalid`)
  const declared = optionTimeframes(options, 'strategyDeclaredTimeframes', [...declaredTimeframes(strategySnapshotFromOptions(options))])
  if (requireStrategyDeclared && declared.size && !declared.has(timeframe)) error(`${field}_undeclared`)
  const available = optionTimeframes(options, 'evidenceAvailableTimeframes')
  if (available.size && !available.has(timeframe)) error(`${field}_evidence_unavailable`)
  if (checkEvidenceRefs) ensureTimeframeEvidence(new Set([timeframe]), refs, field)
  return timeframe
}

export function deriveManualTradeReviewDeclaredTimeframes(strategySnapshot = {}) {
  return [...declaredTimeframes(strategySnapshot)].sort()
}

export function deriveManualTradeReviewEvidenceTimeframes(value = {}) {
  const frames = new Set()
  const timeframes = value?.timeframes && typeof value.timeframes === 'object' ? Object.keys(value.timeframes) : []
  timeframes.forEach(item => { const normalized = normalizeTimeframe(item); if (normalized) frames.add(normalized) })
  const refs = Array.isArray(value) ? value : value?.allowedEvidenceRefs ?? value?.allowed_evidence_refs ?? []
  refs.forEach(item => { const normalized = evidenceReferenceTimeframe(item); if (normalized) frames.add(normalized) })
  return [...frames].sort()
}

function candidateKey(value) {
  if (typeof value !== 'string' || !CANDIDATE_KEYS.has(value)) error('candidate_key_invalid')
  return value
}

function strategyPath(value, strategySnapshot, { allowEmpty = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowEmpty) return null
    error('strategy_rule_path_required')
  }
  if (!object(strategySnapshot)) error('strategy_snapshot_required')
  try {
    return validateFrozenStrategyPath(value, strategySnapshot)
  } catch (cause) {
    const code = String(cause?.message || '')
    if (code.endsWith('_unknown')) error('strategy_rule_path_unknown')
    error('strategy_rule_path_invalid')
  }
}

function normalizeStrategySignal(signal, options = {}) {
  if (!object(signal)) error('strategy_signal_invalid')
  const refs = evidenceRefs(signal.evidence_refs, allowedRefs(options), 'strategy_signal_evidence_refs')
  return {
    strategy_rule_path:strategyPath(signal.strategy_rule_path, strategySnapshotFromOptions(options)),
    timeframe:validateOutputTimeframe(signal.timeframe, 'strategy_signal_timeframe', options, refs),
    observation:normalizedText(signal.observation, 'strategy_signal_observation'),
    inference:normalizedText(signal.inference, 'strategy_signal_inference'),
    evidence_refs:refs,
  }
}

function normalizeProtectionPlan(plan) {
  if (!object(plan)) error('protection_plan_required')
  const takeProfitPrices = arrayValue(plan.take_profit_prices, 'take_profit_prices', MAX_TAKE_PROFIT_COUNT, { required:false })
    .map(value => boundedNumber(value, 'take_profit_price', { positive:true }))
  return {
    invalidation_logic:normalizedText(plan.invalidation_logic, 'invalidation_logic'),
    stop_loss_price:optionalNumber(plan.stop_loss_price, 'stop_loss_price', { positive:true }),
    take_profit_prices:takeProfitPrices,
    recommended_take_profit_tier:optionalText(plan.recommended_take_profit_tier, 'recommended_take_profit_tier', 128),
    position_size_tier:enumValue(plan.position_size_tier, POSITION_SIZE_TIERS, 'position_size_tier'),
  }
}

/**
 * Normalize one isolated, pre-outcome candidate point. Unknown model fields,
 * including any model-supplied direction match, are deliberately discarded.
 */
export function normalizeManualTradeReviewCounterfactualPoint(input, options = {}) {
  if (!object(input)) error('candidate_invalid')
  const version = input.output_contract_version == null
    ? MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION
    : input.output_contract_version
  if (version !== MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION) error('candidate_contract_version_invalid')
  const decision = enumValue(input.decision, DECISIONS, 'decision')
  const signals = arrayValue(input.strategy_signals, 'strategy_signals', MAX_SIGNAL_COUNT, { required:false })
    .map(signal => normalizeStrategySignal(signal, options))
  if ((decision === 'buy' || decision === 'sell') && signals.length === 0) error('strategy_signals_required')
  const blockingRules = arrayValue(input.blocking_rules, 'blocking_rules', MAX_BLOCKING_RULE_COUNT, { required:false })
    .map(value => normalizedText(value, 'blocking_rule', 500))
  const normalized = {
    output_contract_version:MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION,
    candidate_key:candidateKey(input.candidate_key),
    decision,
    entry_allowed:booleanValue(input.entry_allowed, 'entry_allowed'),
    entry_method:enumValue(input.entry_method, ENTRY_METHODS, 'entry_method'),
    entry_price_reference:optionalNumber(input.entry_price_reference, 'entry_price_reference', { positive:true }),
    strategy_signals:signals,
    blocking_rules:blockingRules,
    protection_plan:normalizeProtectionPlan(input.protection_plan),
    confidence:boundedNumber(input.confidence, 'confidence', { nonNegative:true }),
  }
  if (normalized.confidence > 1) error('confidence_invalid')
  return normalized
}

export const normalizeManualTradeReviewCandidatePoint = normalizeManualTradeReviewCounterfactualPoint
export const validateManualTradeReviewCounterfactualPoint = normalizeManualTradeReviewCounterfactualPoint

function normalizeDirection(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase()
  if (normalized === 'buy' || normalized === 'long' || normalized === '0') return 'buy'
  if (normalized === 'sell' || normalized === 'short' || normalized === '1') return 'sell'
  return null
}

function candidateOffset(candidate, index) {
  if (Number.isFinite(Number(candidate?.offset_bars))) return Number(candidate.offset_bars)
  return CANDIDATE_KEY_OFFSET.get(candidate?.candidate_key) ?? index
}

function serverDirectionMatch(candidate, actualDirection) {
  const decision = candidate?.decision
  if (!actualDirection || decision === 'insufficient_evidence') return 'insufficient_evidence'
  if (decision === 'hold') return 'hold'
  if (decision !== 'buy' && decision !== 'sell') return 'insufficient_evidence'
  if (decision !== actualDirection) return 'opposite_direction'
  return candidate.entry_allowed === true && candidate.entry_method !== 'observe'
    ? 'same_direction_entry'
    : 'same_direction_observe'
}

function eligibilityFor(candidate) {
  if (!candidate || candidate.decision === 'insufficient_evidence') return 'unknown'
  if (candidate.decision === 'hold') return 'not_applicable'
  return candidate.entry_allowed === true && candidate.entry_method !== 'observe' ? 'eligible' : 'blocked'
}

function sortedCandidates(candidates = []) {
  return candidates.map((candidate, index) => ({ candidate, index, offset: candidateOffset(candidate, index) }))
    .sort((left, right) => left.offset - right.offset || left.index - right.index)
}

/**
 * Derive all direction relationship fields from frozen candidates and the
 * actual trade direction. Model-provided match fields are never consulted.
 */
export function deriveManualTradeReviewDirectionSummary(candidates = [], actualDirection, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) error('candidates_required')
  const direction = normalizeDirection(actualDirection)
  const normalized = candidates.map(candidate => {
    if (candidate?.output_contract_version === MANUAL_TRADE_REVIEW_COUNTERFACTUAL_POINT_V3_VERSION) return candidate
    return normalizeManualTradeReviewCounterfactualPoint(candidate, options)
  })
  const ordered = sortedCandidates(normalized)
  const protectionByCandidate = options.protectionByCandidate ?? options.protection_by_candidate ?? {}
  const candidateResults = ordered.map(({ candidate, offset }) => {
    const match = serverDirectionMatch(candidate, direction)
    const protection = protectionByCandidate instanceof Map
      ? protectionByCandidate.get(candidate.candidate_key)
      : protectionByCandidate?.[candidate.candidate_key]
    return {
      candidate_key:candidate.candidate_key,
      offset_bars:offset,
      model_signal:candidate.decision,
      direction_match:match,
      strategy_eligibility:eligibilityFor(candidate),
      execution_feasibility:EXECUTION_FEASIBILITY.has(protection?.execution_feasibility)
        ? protection.execution_feasibility : 'unknown',
    }
  })
  const sameDirection = candidateResults.filter(item => item.direction_match === 'same_direction_entry'
    || item.direction_match === 'same_direction_observe')
  const sameDirectionEntries = candidateResults.filter(item => item.direction_match === 'same_direction_entry')
  const first = sameDirection[0] || null
  const directionMatch = first?.direction_match
    || (candidateResults.some(item => item.direction_match === 'opposite_direction') ? 'opposite_direction'
      : candidateResults.some(item => item.direction_match === 'hold') ? 'hold' : 'insufficient_evidence')
  return {
    actual_direction:direction,
    direction_match:directionMatch,
    first_same_direction_candidate:first?.candidate_key || null,
    first_same_direction_entry:firstDirectionEntry(sameDirectionEntries),
    same_direction_candidate_count:sameDirection.length,
    same_direction_entry_count:sameDirectionEntries.length,
    timing_difference_bars:first ? first.offset_bars : null,
    candidates:candidateResults,
  }
}

function firstDirectionEntry(items) {
  return items[0]?.candidate_key || null
}

export const deriveManualTradeReviewCounterfactualSummary = deriveManualTradeReviewDirectionSummary
export const deriveManualTradeReviewCandidateSummary = deriveManualTradeReviewDirectionSummary
export const summarizeManualTradeReviewCounterfactualCandidates = deriveManualTradeReviewDirectionSummary

function finitePrice(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null
}

function contractValue(spec, keys) {
  for (const key of keys) {
    const value = finitePrice(spec?.[key])
    if (value != null) return value
  }
  return null
}

function priceStepValid(price, step) {
  if (price == null || step == null) return null
  const units = price / step
  return Math.abs(units - Math.round(units)) <= Math.max(1e-8, Math.abs(units) * 1e-8)
}

function rangeStatus(value, policy, prefix) {
  if (!policy || !Number.isFinite(Number(value))) return 'unknown'
  const min = Number(policy[`${prefix}_min_atr`] ?? policy[`${prefix}_min`])
  const max = Number(policy[`${prefix}_max_atr`] ?? policy[`${prefix}_max`])
  if (!Number.isFinite(min) && !Number.isFinite(max)) return 'unknown'
  if (Number.isFinite(min) && value < min) return 'fail'
  if (Number.isFinite(max) && value > max) return 'fail'
  return 'pass'
}

function combineQuality({ directionValid, missingPrices, contractStatus, structureStatus, strategyStatus }) {
  if (missingPrices) return 'unknown'
  if (directionValid === false || contractStatus === 'fail' || structureStatus === 'fail' || strategyStatus === 'fail') {
    return 'unreasonable'
  }
  if (directionValid == null) return 'unknown'
  if ([contractStatus, structureStatus, strategyStatus].includes('unknown')) return 'partial'
  return 'reasonable'
}

/**
 * Mechanically assess a proposed protection plan. No current broker default is
 * inferred: when historical contract facts are absent, execution feasibility
 * remains unknown.
 */
export function evaluateManualTradeReviewProtectionPlan(plan, context = {}) {
  if (!object(plan)) error('protection_plan_required')
  const direction = normalizeDirection(context.direction)
  const entryPrice = finitePrice(context.entryPrice ?? context.entry_price)
  const stopLoss = finitePrice(plan.stop_loss_price)
  const takeProfits = Array.isArray(plan.take_profit_prices)
    ? plan.take_profit_prices.map(value => finitePrice(value)).filter(value => value != null)
    : []
  const directionValid = direction && entryPrice != null && stopLoss != null
    ? direction === 'buy' ? stopLoss < entryPrice : stopLoss > entryPrice
    : null
  const takeProfitDirection = direction && entryPrice != null && takeProfits.length
    ? takeProfits.every(price => direction === 'buy' ? price > entryPrice : price < entryPrice)
    : null
  const takeProfitOrderValid = direction && takeProfits.length > 1
    ? takeProfits.every((price, index) => index === 0
      || (direction === 'buy' ? price > takeProfits[index - 1] : price < takeProfits[index - 1])) : takeProfits.length ? true : null
  const stopDistance = directionValid === true && entryPrice != null && stopLoss != null
    ? Math.abs(entryPrice - stopLoss) : null
  const takeProfitDistances = entryPrice != null
    ? takeProfits.map(price => Math.abs(price - entryPrice)) : []
  const riskRewardRatios = stopDistance > 0
    ? takeProfitDistances.map(distance => distance / stopDistance) : []
  const atr = finitePrice(context.atr ?? context.atr_value)
  const stopDistanceAtr = atr && stopDistance != null ? stopDistance / atr : null
  const takeProfitDistanceAtr = atr ? takeProfitDistances.map(distance => distance / atr) : []

  const contractSpec = object(context.contractSpec ?? context.contract_spec)
    ? (context.contractSpec ?? context.contract_spec) : null
  const contractAvailable = contractSpec?.available === false
    ? false
    : contractSpec != null && [
      'minimum_stop_distance', 'min_stop_distance', 'minimum_stop_distance_price',
      'minimum_take_profit_distance', 'min_take_profit_distance', 'minimum_distance',
      'price_step', 'tick_size', 'point', 'digits',
    ].some(key => contractSpec[key] != null)
  let executionFeasibility = 'unknown'
  const contractChecks = { available:contractAvailable === true ? true : contractAvailable === false ? false : null,
    stop_distance:'unknown', take_profit_distance:'unknown', price_step:'unknown' }
  if (contractAvailable === true && entryPrice != null && stopLoss != null && takeProfits.length) {
    let contractFail = false
    const minimumStop = contractValue(contractSpec, ['minimum_stop_distance_price', 'minimum_stop_distance', 'min_stop_distance'])
    const minimumTakeProfit = contractValue(contractSpec, ['minimum_take_profit_distance_price', 'minimum_take_profit_distance', 'min_take_profit_distance'])
    const minimumDistance = contractValue(contractSpec, ['minimum_distance'])
    const stopFloor = minimumStop ?? minimumDistance
    const takeProfitFloor = minimumTakeProfit ?? minimumDistance
    if (stopFloor != null && stopDistance != null) {
      contractChecks.stop_distance = stopDistance >= stopFloor ? 'pass' : 'fail'
      contractFail ||= contractChecks.stop_distance === 'fail'
    }
    if (takeProfitFloor != null && takeProfitDistances.length) {
      contractChecks.take_profit_distance = takeProfitDistances.every(distance => distance >= takeProfitFloor) ? 'pass' : 'fail'
      contractFail ||= contractChecks.take_profit_distance === 'fail'
    }
    const step = contractValue(contractSpec, ['price_step', 'tick_size', 'point'])
    if (step != null && entryPrice != null && stopLoss != null && takeProfits.length) {
      const prices = [entryPrice, stopLoss, ...takeProfits]
      contractChecks.price_step = prices.every(price => priceStepValid(price, step)) ? 'pass' : 'fail'
      contractFail ||= contractChecks.price_step === 'fail'
    }
    executionFeasibility = contractFail ? 'fail' : 'pass'
  }

  const rawStrategyStatus = context.strategyConsistency ?? context.strategy_consistency
  const strategyStatus = rawStrategyStatus === 'pass' || rawStrategyStatus === 'reasonable' ? 'pass'
    : rawStrategyStatus === 'fail' || rawStrategyStatus === 'unreasonable' ? 'fail'
      : rawStrategyStatus === 'unknown' || rawStrategyStatus === 'partial' ? 'unknown' : 'unknown'
  const strategyConsistency = strategyStatus
  const strategyPolicy = object(context.atrPolicy ?? context.atr_policy) ? (context.atrPolicy ?? context.atr_policy) : null
  const stopStructureStatus = rangeStatus(stopDistanceAtr, strategyPolicy, 'stop_loss')
  const takeProfitStructureStatuses = takeProfitDistanceAtr.map(value => rangeStatus(value, strategyPolicy, 'take_profit'))
  const structureStatus = stopStructureStatus === 'fail' || takeProfitStructureStatuses.includes('fail')
    ? 'fail'
    : stopStructureStatus === 'pass' || takeProfitStructureStatuses.includes('pass')
      ? (stopStructureStatus === 'unknown' && takeProfitStructureStatuses.every(status => status !== 'fail') ? 'unknown' : 'pass')
      : 'unknown'
  const directionCheck = directionValid === false || takeProfitDirection === false || takeProfitOrderValid === false ? false
    : directionValid === true && takeProfitDirection === true ? true : null
  return {
    direction,
    entry_price:entryPrice,
    stop_loss_price:stopLoss,
    take_profit_prices:takeProfits,
    stop_loss_direction_valid:directionValid,
    take_profit_direction_valid:takeProfitDirection,
    take_profit_order_valid:takeProfitOrderValid,
    risk_reward_ratios:riskRewardRatios,
    stop_distance:stopDistance,
    take_profit_distances:takeProfitDistances,
    stop_distance_atr:stopDistanceAtr,
    take_profit_distance_atr:takeProfitDistanceAtr,
    strategy_consistency:strategyConsistency,
    structure_consistency:structureStatus,
    contract_checks:contractChecks,
    execution_feasibility:executionFeasibility,
    protection_quality:combineQuality({
      directionValid:directionCheck,
      missingPrices:directionCheck == null && (entryPrice == null || stopLoss == null || !takeProfits.length),
      contractStatus:executionFeasibility,
      structureStatus,
      strategyStatus,
    }),
  }
}

export const evaluateManualTradeReviewProtection = evaluateManualTradeReviewProtectionPlan
export const assessManualTradeReviewProtection = evaluateManualTradeReviewProtectionPlan

function normalizeRuleComparison(item, options = {}) {
  if (!object(item)) error('rule_comparison_invalid')
  const status = enumValue(item.status, RULE_STATUSES, 'rule_comparison_status')
  const path = strategyPath(item.rule_path, strategySnapshotFromOptions(options), { allowEmpty:['unknown', 'not_applicable'].includes(status) })
  return {
    rule_path:path,
    rule_summary:normalizedText(item.rule_summary, 'rule_summary'),
    observed_evidence:normalizedText(item.observed_evidence, 'observed_evidence'),
    status,
    evidence_refs:evidenceRefs(item.evidence_refs, allowedRefs(options), 'rule_comparison_evidence_refs'),
  }
}

function normalizeTechnicalChainItem(item, options = {}) {
  if (!object(item)) error('technical_analysis_chain_item_invalid')
  const origin = enumValue(item.origin, ORIGINS, 'technical_analysis_origin')
  const paths = arrayValue(item.strategy_rule_paths, 'strategy_rule_paths', 20, { required:false })
    .map(path => strategyPath(path, strategySnapshotFromOptions(options)))
  if (origin === 'strategy_derived' && paths.length === 0) error('strategy_rule_paths_required')
  if (origin !== 'strategy_derived' && paths.length > 0) error('strategy_rule_paths_origin_invalid')
  const refs = evidenceRefs(item.evidence_refs, allowedRefs(options), 'technical_evidence_refs')
  const timeframes = arrayValue(item.timeframes, 'technical_timeframes', 20, { required:false })
    .map(value => validateOutputTimeframe(value, 'technical_timeframe', options, refs,
      { requireStrategyDeclared:origin === 'strategy_derived', checkEvidenceRefs:false }))
  // A technical claim covering multiple periods must cite at least one exact
  // evidence reference for each of those periods.  References from another
  // period cannot be used to support a higher/lower timeframe statement.
  ensureTimeframeEvidence(new Set(timeframes), refs, 'technical')
  return {
    origin,
    method_label:normalizedText(item.method_label, 'technical_method_label', 200),
    timeframes,
    observations:arrayValue(item.observations, 'technical_observations', 30, { required:false })
      .map(value => normalizedText(value, 'technical_observation')),
    reasoning:normalizedText(item.reasoning, 'technical_reasoning'),
    would_support_same_direction_without_outcome:booleanValue(
      item.would_support_same_direction_without_outcome,
      'technical_outcome_independence',
    ),
    strategy_rule_paths:paths,
    evidence_refs:refs,
    limitations:normalizedText(item.limitations, 'technical_limitations'),
  }
}

function resolveDerivedSummary(value, options = {}) {
  const direct = options.serverDerivedSummary ?? options.server_derived_summary
  if (direct && object(direct)) return direct
  if (Array.isArray(options.candidates) && options.candidates.length) {
    return deriveManualTradeReviewDirectionSummary(options.candidates, options.actualDirection, options)
  }
  error('server_derived_summary_required')
}

function normalizeCounterfactualSummary(value, options = {}) {
  const derived = resolveDerivedSummary(value, options)
  const match = enumValue(derived.direction_match ?? derived.server_derived_direction_match,
    DIRECTION_MATCHES, 'server_derived_direction_match')
  const serverProtection = options.serverProtectionAssessment ?? options.server_protection_assessment
    ?? options.protectionAssessment ?? options.protection_assessment
  const protectionQuality = serverProtection?.protection_quality ?? serverProtection?.protectionQuality ?? 'unknown'
  return {
    server_derived_direction_match:match,
    first_same_direction_candidate:derived.first_same_direction_candidate == null
      ? null : candidateKey(derived.first_same_direction_candidate),
    timing_difference_bars:derived.timing_difference_bars == null
      ? null : integerNumber(derived.timing_difference_bars, 'timing_difference_bars'),
    protection_quality:enumValue(protectionQuality, PROTECTION_QUALITIES, 'protection_quality'),
  }
}

function normalizeOptimizationHypothesis(item, options = {}) {
  if (!object(item)) error('optimization_hypothesis_invalid')
  const state = item.state == null ? 'hypothesis' : enumValue(item.state, OPTIMIZATION_STATES, 'optimization_state')
  const targetPath = strategyPath(item.target_path, strategySnapshotFromOptions(options), { allowEmpty:state === 'insufficient_evidence' })
  const refs = evidenceRefs(item.supporting_review_refs ?? item.supporting_trade_refs,
    options.sourceRefSet ?? options.sourceRefs, 'supporting_review_refs')
  const counterEvidence = arrayValue(item.counter_evidence ?? item.counterexample_review_refs,
    'counter_evidence', MAX_SOURCE_COUNT, { required:false }).map(value => normalizedText(value, 'counter_evidence_ref', 200))
  return {
    hypothesis_id:optionalText(item.hypothesis_id ?? item.candidate_id, 'hypothesis_id', 128),
    target_path:targetPath,
    current_rule_summary:normalizedText(item.current_rule_summary, 'current_rule_summary'),
    observed_gap:normalizedText(item.observed_gap, 'observed_gap'),
    proposed_change:normalizedText(item.proposed_change, 'proposed_change'),
    supporting_review_refs:refs,
    counter_evidence:counterEvidence,
    applicable_when:requiredManualReviewObject(item.applicable_when, 'applicable_when'),
    risk_if_applied:normalizedText(item.risk_if_applied, 'risk_if_applied'),
    validation_needed:normalizedText(item.validation_needed, 'validation_needed'),
    confidence:requiredManualReviewConfidence(item.confidence),
    state,
  }
}

/** Normalize the post-outcome v3 result after all candidate points are frozen. */
export function normalizeManualTradeReviewV3Content(input, options = {}) {
  if (!object(input)) error('content_invalid')
  const version = input.output_contract_version == null ? MANUAL_TRADE_REVIEW_V3_VERSION : input.output_contract_version
  if (version !== MANUAL_TRADE_REVIEW_V3_VERSION) error('content_contract_version_invalid')
  const content = {
    output_contract_version:MANUAL_TRADE_REVIEW_V3_VERSION,
    review_summary:normalizedText(input.review_summary, 'review_summary'),
    why_profitable:normalizeWhyProfitable(input.why_profitable),
    // A v3 review must explain at least one evidence-backed technical chain.
    // When no method can be reconstructed, the model must still emit one
    // `unexplained` item with its evidence limitations instead of omitting the
    // core business answer.
    technical_analysis_chain:arrayValue(input.technical_analysis_chain, 'technical_analysis_chain', MAX_CHAIN_COUNT)
      .map(item => normalizeTechnicalChainItem(item, options)),
    counterfactual_summary:normalizeCounterfactualSummary(input.counterfactual_summary, options),
    rule_comparisons:arrayValue(input.rule_comparisons, 'rule_comparisons', 50, { required:false })
    .map(item => normalizeRuleComparison(item, options)),
    strengths:arrayValue(input.strengths, 'strengths', 30, { required:false })
      .map(value => normalizedText(value, 'strength')),
    issues:arrayValue(input.issues, 'issues', 30, { required:false })
      .map(value => normalizedText(value, 'issue')),
    strategy_optimization_hypotheses:arrayValue(input.strategy_optimization_hypotheses, 'strategy_optimization_hypotheses', MAX_HYPOTHESIS_COUNT, { required:false })
      .map(item => normalizeOptimizationHypothesis(item, options)),
    confidence:boundedNumber(input.confidence, 'confidence', { nonNegative:true }),
    limitations:arrayValue(input.limitations, 'limitations', 30, { required:false })
      .map(value => normalizedText(value, 'limitation')),
  }
  if (content.confidence > 1) error('confidence_invalid')
  return content
}

export const validateManualTradeReviewV3Content = normalizeManualTradeReviewV3Content
export const validateManualTradeReviewV3Output = normalizeManualTradeReviewV3Content

function normalizeWhyProfitable(value) {
  if (!object(value)) error('why_profitable_required')
  return {
    direction_contribution:normalizedText(value.direction_contribution, 'direction_contribution'),
    entry_timing_contribution:normalizedText(value.entry_timing_contribution, 'entry_timing_contribution'),
    holding_contribution:normalizedText(value.holding_contribution, 'holding_contribution'),
    exit_contribution:normalizedText(value.exit_contribution, 'exit_contribution'),
    luck_or_uncontrolled_factors:normalizedText(value.luck_or_uncontrolled_factors, 'luck_or_uncontrolled_factors'),
  }
}

function sourceReference(value) {
  return normalizedText(value, 'source_reference', 256)
}

function sourceKey(source) {
  if (typeof source === 'string') return sourceReference(source)
  if (!object(source)) error('aggregate_source_invalid')
  if (source.ref != null || source.reference != null) {
    return sourceReference(source.ref ?? source.reference)
  }
  const caseId = source.case_id ?? source.caseId
  const versionId = source.version_id ?? source.versionId
  const hash = source.content_hash ?? source.contentHash
  if (caseId == null || versionId == null || hash == null) error('aggregate_source_invalid')
  return `case:${sourceReference(caseId)}:version:${sourceReference(versionId)}:hash:${sourceReference(hash)}`
}

function sourceConfirmed(source) {
  if (typeof source === 'string') return false
  return source.confirmed === true || source.confirmation_status === 'confirmed'
    || source.status === 'confirmed' || source.status === 'approved'
    || source.review_status === 'confirmed' || source.review_status === 'approved'
    || source.version_status === 'confirmed'
}

function normalizeAggregateSources(options = {}) {
  const rawSources = options.sources ?? options.sourceRefs
  const sources = rawSources instanceof Set ? [...rawSources] : rawSources
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > MAX_SOURCE_COUNT) error('aggregate_source_count_invalid')
  const confirmedRefs = setFromRefs(options.confirmedSourceRefs ?? options.confirmed_source_refs)
  const normalized = sources.map(source => {
    const ref = sourceKey(source)
    return { ref, confirmed:sourceConfirmed(source) || confirmedRefs.has(ref) }
  })
  if (new Set(normalized.map(source => source.ref)).size !== normalized.length) error('aggregate_source_duplicate')
  return normalized
}

function sourceSet(options) {
  const sources = normalizeAggregateSources(options)
  return {
    sources,
    refs:new Set(sources.map(source => source.ref)),
    confirmed:new Set(sources.filter(source => source.confirmed).map(source => source.ref)),
    evidenceComplete:Number.isFinite(Number(options.evidenceComplete ?? options.evidence_complete))
      ? Number(options.evidenceComplete ?? options.evidence_complete) : 0,
    strategyVersions:Array.isArray(options.strategyVersions ?? options.strategy_versions)
      ? (options.strategyVersions ?? options.strategy_versions) : [],
  }
}

function aggregateRefArray(value, field, refs, { required = false } = {}) {
  const values = arrayValue(value, field, MAX_SOURCE_COUNT, { required })
    .map(item => sourceReference(item))
  if (values.some(item => !refs.has(item))) error(`${field}_invalid`)
  return [...new Set(values)]
}

function deriveAggregateSourceSummary(sourceData) {
  return {
    total:sourceData.sources.length,
    confirmed:sourceData.confirmed.size,
    evidence_complete:Number(sourceData.evidenceComplete || 0),
    strategy_versions:Array.isArray(sourceData.strategyVersions) ? sourceData.strategyVersions.slice(0, MAX_SOURCE_COUNT) : [],
  }
}

function normalizeAggregateHypothesis(item, sourceData, options = {}) {
  if (!object(item)) error('aggregate_hypothesis_invalid')
  const requestedState = enumValue(item.recommendation_state, AGGREGATE_RECOMMENDATION_STATES, 'recommendation_state')
  const supporting = aggregateRefArray(item.supporting_review_refs, 'supporting_review_refs', sourceData.refs, { required:true })
  const counterexamples = aggregateRefArray(item.counterexample_review_refs, 'counterexample_review_refs', sourceData.refs, { required:false })
  const targetPath = item.target_path == null || String(item.target_path).trim() === ''
    ? null : strategyPath(item.target_path, strategySnapshotFromOptions(options))
  const enoughConfirmedSupport = supporting.filter(ref => sourceData.confirmed.has(ref)).length >= 3
  const hasIndependentCounterexample = counterexamples.some(ref => !supporting.includes(ref))
  const ready = requestedState === 'ready_for_human_review'
    && enoughConfirmedSupport && hasIndependentCounterexample && targetPath != null
  const recommendationState = ready
    ? 'ready_for_human_review'
    : requestedState === 'observe' ? 'observe' : 'insufficient_evidence'
  return {
    pattern_id:optionalText(item.pattern_id, 'pattern_id', 128),
    target_path:targetPath,
    current_rule_summary:normalizedText(item.current_rule_summary, 'aggregate_current_rule_summary'),
    observed_gap:normalizedText(item.observed_gap, 'aggregate_observed_gap'),
    proposed_change:normalizedText(item.proposed_change, 'aggregate_proposed_change'),
    supporting_review_refs:supporting,
    counterexample_review_refs:counterexamples,
    support_count:supporting.length,
    applicable_when:requiredManualReviewObject(item.applicable_when, 'aggregate_applicable_when'),
    risk_if_applied:normalizedText(item.risk_if_applied, 'aggregate_risk_if_applied'),
    validation_needed:normalizedText(item.validation_needed, 'aggregate_validation_needed'),
    recommendation_state:recommendationState,
    confidence:requiredManualReviewConfidence(item.confidence),
  }
}

/**
 * Validate an aggregate model result against the frozen source set. A model
 * cannot promote its own recommendation to human-review-ready status.
 */
export function normalizeManualTradeReviewAggregateOutput(input, options = {}) {
  if (!object(input)) error('aggregate_content_invalid')
  const version = input.output_contract_version == null ? MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION : input.output_contract_version
  if (version !== MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION) error('aggregate_contract_version_invalid')
  const sourceData = sourceSet(options)
  const sourceSummary = deriveAggregateSourceSummary(sourceData)
  const normalized = {
    output_contract_version:MANUAL_TRADE_REVIEW_AGGREGATE_V1_VERSION,
    source_summary:sourceSummary,
    recurring_patterns:arrayValue(input.recurring_patterns, 'recurring_patterns', 40, { required:false })
      .map(item => normalizeAggregatePattern(item, sourceData)),
    strategy_gaps:arrayValue(input.strategy_gaps, 'strategy_gaps', 40, { required:false })
      .map(value => normalizedText(value, 'strategy_gap')),
    protection_findings:arrayValue(input.protection_findings, 'protection_findings', 40, { required:false })
      .map(value => normalizedText(value, 'protection_finding')),
    version_comparisons:arrayValue(input.version_comparisons, 'version_comparisons', 20, { required:false })
      .map(value => normalizedText(value, 'version_comparison')),
    strategy_optimization_hypotheses:arrayValue(input.strategy_optimization_hypotheses, 'strategy_optimization_hypotheses', MAX_HYPOTHESIS_COUNT, { required:false })
      .map(item => normalizeAggregateHypothesis(item, sourceData, options)),
    limitations:arrayValue(input.limitations, 'limitations', 40, { required:false })
      .map(value => normalizedText(value, 'aggregate_limitation')),
  }
  return normalized
}

export const validateManualTradeReviewAggregateOutput = normalizeManualTradeReviewAggregateOutput
export const validateManualTradeReviewAggregateContent = normalizeManualTradeReviewAggregateOutput

function normalizeAggregatePattern(item, sourceData) {
  if (!object(item)) error('recurring_pattern_invalid')
  const supporting = aggregateRefArray(item.supporting_review_refs, 'pattern_supporting_review_refs', sourceData.refs, { required:true })
  const counterexamples = aggregateRefArray(item.counterexample_review_refs, 'pattern_counterexample_review_refs', sourceData.refs, { required:false })
  return {
    pattern:normalizedText(item.pattern, 'pattern'),
    supporting_review_refs:supporting,
    counterexample_review_refs:counterexamples,
    support_count:supporting.length,
    confidence:requiredManualReviewConfidence(item.confidence),
  }
}

export function buildManualTradeReviewAggregateSourceSummary(sources = [], { evidenceComplete = 0, strategyVersions = [] } = {}) {
  const sourceData = sourceSet({ sources, evidenceComplete, strategyVersions })
  return deriveAggregateSourceSummary(sourceData)
}
