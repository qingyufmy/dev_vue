const STRATEGY_ROOTS = new Set(['strategy_policy', 'market_data_plan', 'entry_methods', 'symbols', 'use_chan_analysis'])
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/

function pathSegments(path) {
  if (!PATH_PATTERN.test(path)) return null
  return path.replace(/\[(\d+)\]/g, '.$1').split('.')
}

export function validateFrozenStrategyPath(value, snapshot = {}, { allowEmpty = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowEmpty) return null
    throw new Error('manual_trade_review_output_rule_path_required')
  }
  const path = String(value).normalize('NFKC').trim()
  const segments = pathSegments(path)
  if (!segments || !STRATEGY_ROOTS.has(segments[0])
    || segments.some(segment => FORBIDDEN_PATH_SEGMENTS.has(String(segment).toLowerCase()))) {
    throw new Error('manual_trade_review_output_rule_path_invalid')
  }
  let current = snapshot
  for (const segment of segments) {
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))
      || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error('manual_trade_review_output_rule_path_unknown')
    }
    current = current[segment]
  }
  return path
}

function addMarketReferences(target, identity, phase, path = {}) {
  for (const [timeframe, frame] of Object.entries(path?.timeframes || {})) {
    const normalized = String(timeframe || '').trim().toUpperCase()
    if (!normalized) continue
    target.add(`market:${identity}:${phase}:${normalized}`)
    if (frame?.chan) target.add(`chan:${identity}:${phase}:${normalized}`)
  }
}

export function buildManualReviewEvidenceCatalog(sourceRows = [], evidence = {}) {
  const preEntry = new Set()
  const outcome = new Set()
  const tradeRefs = new Set()
  const trades = evidence?.market_data?.trades || {}
  for (const row of sourceRows) {
    const identity = String(row?.source_identity_hash || '').trim()
    if (!identity) continue
    tradeRefs.add(identity)
    preEntry.add(`trade:${identity}`)
    outcome.add(`trade:${identity}`)
    const path = trades[identity] || {}
    addMarketReferences(preEntry, identity, 'pre_entry', path.pre_entry)
    addMarketReferences(outcome, identity, 'pre_entry', path.pre_entry)
    addMarketReferences(outcome, identity, 'outcome', path.outcome_path)
  }
  return {
    trade_refs:[...tradeRefs].sort(),
    pre_entry_refs:[...preEntry].sort(),
    outcome_refs:[...outcome].sort(),
  }
}

export function validateManualReviewEvidenceRefs(values, allowedValues, { required = false } = {}) {
  if (!Array.isArray(values)) throw new Error('manual_trade_review_output_reference_invalid')
  const allowed = allowedValues instanceof Set ? allowedValues : new Set(allowedValues || [])
  const normalized = [...new Set(values.map(value => String(value == null ? '' : value).normalize('NFKC').trim())
    .filter(Boolean))]
  if ((required && !normalized.length) || normalized.some(value => !allowed.has(value))) {
    throw new Error('manual_trade_review_output_reference_invalid')
  }
  return normalized
}

export function requiredManualReviewText(value, field, max = 6000) {
  if (typeof value !== 'string') throw new Error(`manual_trade_review_output_${field}_required`)
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  if (!normalized) throw new Error(`manual_trade_review_output_${field}_required`)
  return normalized
}

export function requiredManualReviewArray(value, field, max = 20) {
  if (!Array.isArray(value)) throw new Error(`manual_trade_review_output_${field}_required`)
  return value.slice(0, max)
}

export function requiredManualReviewObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`manual_trade_review_output_${field}_required`)
  }
  return value
}

export function requiredManualReviewEnum(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error('manual_trade_review_output_enum_invalid')
  return value
}

export function requiredManualReviewConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('manual_trade_review_output_confidence_invalid')
  }
  return number
}
