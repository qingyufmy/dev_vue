const STRATEGY_ROOTS = new Set(['strategy_policy', 'market_data_plan', 'entry_methods', 'symbols', 'use_chan_analysis'])
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/

function pathSegments(path) {
  if (!PATH_PATTERN.test(path)) return null
  return path.replace(/\[(\d+)\]/g, '.$1').split('.')
}

function legalStrategyPath(path) {
  const segments = pathSegments(path)
  return Boolean(segments && STRATEGY_ROOTS.has(segments[0])
    && !segments.some(segment => FORBIDDEN_PATH_SEGMENTS.has(String(segment).toLowerCase())))
}

/**
 * Enumerate every addressable value under the frozen strategy roots.  The
 * returned paths use the same grammar as validateFrozenStrategyPath, include
 * array indexes, and are independent of object insertion order.
 */
export function buildFrozenStrategyPaths(snapshot = {}) {
  const paths = new Set()
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const walk = (value, path, ancestors = new Set()) => {
    if (!legalStrategyPath(path)) return
    paths.add(path)
    if (value == null || typeof value !== 'object' || ancestors.has(value)) return
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(value)
    if (Array.isArray(value)) {
      for (const key of Object.keys(value).filter(item => /^(0|[1-9]\d*)$/.test(item)).sort((left, right) => Number(left) - Number(right))) {
        walk(value[key], `${path}[${key}]`, nextAncestors)
      }
      return
    }
    for (const key of Object.keys(value).sort()) {
      const normalizedKey = String(key).normalize('NFKC')
      if (normalizedKey !== key || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(normalizedKey)) continue
      walk(value[key], `${path}.${normalizedKey}`, nextAncestors)
    }
  }
  for (const root of STRATEGY_ROOTS) {
    if (Object.prototype.hasOwnProperty.call(source, root)) walk(source[root], root)
  }
  return [...paths].sort()
}

export function validateFrozenStrategyPath(value, snapshot = {}, { allowEmpty = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowEmpty) return null
    throw new Error('manual_trade_review_output_rule_path_required')
  }
  const path = String(value).normalize('NFKC').trim()
  const segments = pathSegments(path)
  if (!segments || !legalStrategyPath(path)) {
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

function candidatePointValues(path = {}) {
  const points = path?.counterfactual_points ?? path?.counterfactualPoints
    ?? path?.candidate_points ?? path?.candidatePoints
  if (Array.isArray(points)) return points
  if (points && typeof points === 'object') return Object.values(points)
  return []
}

/**
 * Build the exact, phase-specific references that a single counterfactual
 * point is allowed to cite.  The candidate key is part of every market ref so
 * one point cannot cite another point's cutoff evidence by accident.
 */
export function buildManualReviewCounterfactualEvidenceRefs(identity, candidateKey, point = {}) {
  const normalizedIdentity = String(identity || '').trim()
  const normalizedKey = String(candidateKey || point?.candidate_key || point?.candidateKey || '').trim()
  const refs = new Set()
  const market = point?.closed_market_data ?? point?.closedMarketData
    ?? point?.market_data ?? point?.marketData ?? point?.path ?? {}
  for (const [timeframe, frame] of Object.entries(market?.timeframes || {})) {
    const normalizedTimeframe = String(timeframe || '').trim().toUpperCase()
    if (!normalizedTimeframe || !normalizedKey) continue
    refs.add(`market:${normalizedIdentity}:counterfactual:${normalizedKey}:${normalizedTimeframe}`)
    if (frame?.chan) refs.add(`chan:${normalizedIdentity}:counterfactual:${normalizedKey}:${normalizedTimeframe}`)
  }
  return [...refs].sort()
}

export function buildManualReviewEvidenceCatalog(sourceRows = [], evidence = {}) {
  const preEntry = new Set()
  const outcome = new Set()
  const tradeRefs = new Set()
  const counterfactual = new Set()
  const counterfactualByTrade = {}
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
    const points = candidatePointValues(path)
    for (const point of points) {
      const candidateKey = String(point?.candidate_key || point?.candidateKey || '').trim()
      if (!candidateKey) continue
      const refs = buildManualReviewCounterfactualEvidenceRefs(identity, candidateKey, point)
      counterfactualByTrade[identity] = counterfactualByTrade[identity] || {}
      counterfactualByTrade[identity][candidateKey] = refs
      // Candidate +1 may be after the real entry.  Keep those exact refs out
      // of the legacy blind pre_entry catalog; point prompts receive their
      // own allow-list, while the outcome stage can cite the frozen set.
      refs.forEach(ref => { counterfactual.add(ref); outcome.add(ref) })
    }
  }
  return {
    trade_refs:[...tradeRefs].sort(),
    pre_entry_refs:[...preEntry].sort(),
    outcome_refs:[...outcome].sort(),
    counterfactual_refs:[...counterfactual].sort(),
    counterfactual_refs_by_trade:counterfactualByTrade,
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
