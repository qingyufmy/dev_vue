export const DECISION_DIAGNOSTICS_VERSION = 1

const TIMEFRAME_ORDER = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1']
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function cleanTimeframe(value) {
  const timeframe = String(value || '').trim().toUpperCase()
  return TIMEFRAME_ORDER.includes(timeframe) ? timeframe : null
}

function sortedTimeframes(values) {
  return [...new Set(values.map(cleanTimeframe).filter(Boolean))]
    .sort((left, right) => TIMEFRAME_ORDER.indexOf(left) - TIMEFRAME_ORDER.indexOf(right))
}

function chanFrames(market = {}) {
  const frames = objectValue(market?.strategy_context?.timeframes) || {}
  return Object.entries(frames).map(([rawTimeframe, frame]) => {
    const timeframe = cleanTimeframe(rawTimeframe)
    const chan = objectValue(frame?.summary?.chan) || objectValue(frame?.chan)
    return timeframe && chan ? { timeframe, chan } : null
  }).filter(Boolean)
}

function continuityState(chan = {}) {
  const continuity = objectValue(chan.continuity) || {}
  const status = String(
    continuity.status
      || continuity.continuity_status
      || chan.continuity_status
      || ''
  ).trim().toLowerCase()
  const unresolved = chan.cache_internal_gap_unresolved === true
    || continuity.cache_internal_gap_unresolved === true
  return { status, unresolved }
}

function failedStrategyGate(signal = {}, strategyPolicyRuntime = null) {
  const runtime = objectValue(strategyPolicyRuntime)
  if (!runtime || String(runtime.mode || '').toLowerCase() !== 'enforce') return false
  const workflow = objectValue(runtime.workflow_state)
  if (workflow?.compliant === false || workflow?.decision?.defaulted === true) return true
  const constraints = objectValue(runtime.constraint_results) || {}
  return Object.values(constraints).some(result => objectValue(result)?.passed === false)
    || ['hold_new_entry', 'reject_submission'].includes(String(signal?.strategy_policy_gate?.action || ''))
}

function normalizedBySchema(signal = {}) {
  return Boolean(objectValue(signal.normalization_info)?.type || objectValue(signal.normalization_info)?.reason)
}

/**
 * Build bounded, deterministic diagnostics from model/schema outcomes and
 * explicit strategy-policy constraints.  The market argument is used only to
 * report a neutral data-quality status; Chan capabilities never explain why a
 * model chose to hold and are deliberately not converted into decision
 * reasons here.
 */
export function buildDecisionDiagnostics({ signal = {}, market = {}, strategyPolicyRuntime = null,
  modelSignalType = null } = {}) {
  const direction = String(signal.signal_type || 'hold').trim().toLowerCase()
  const isHold = direction === 'hold' || String(signal.entry_method || '').toLowerCase() === 'observe'
  const details = new Map()
  const add = (code, timeframes = [], sourceCodes = []) => {
    const current = details.get(code) || { code, timeframes:[], source_codes:[] }
    current.timeframes = sortedTimeframes([...current.timeframes, ...timeframes])
    current.source_codes = [...new Set([...current.source_codes, ...sourceCodes]
      .map(value => String(value || '').trim()).filter(Boolean))].slice(0, 12)
    details.set(code, current)
  }

  for (const { timeframe, chan } of chanFrames(market)) {
    const capabilities = objectValue(chan.evidence_capabilities) || {}
    const reasonCodes = Array.isArray(capabilities.reason_codes) ? capabilities.reason_codes : []
    const continuity = continuityState(chan)
    const dataUnreliable = capabilities.data_complete === false
      || continuity.unresolved
      || ['suspicious_gap', 'unknown_session', 'unavailable'].includes(continuity.status)
    if (isHold && dataUnreliable) {
      add('market_data_unreliable', [timeframe], [
        ...reasonCodes.filter(code => ['cache_internal_gap_unresolved', 'data_incomplete'].includes(code)),
        continuity.status,
      ])
      continue
    }

  }

  const originalDirection = String(modelSignalType || direction).trim().toLowerCase()
  const constraintHold = isHold && originalDirection !== 'hold'
    && failedStrategyGate(signal, strategyPolicyRuntime)
  if (constraintHold) add('strategy_entry_conditions_unmet')
  if (isHold && !constraintHold && !normalizedBySchema(signal) && details.size === 0) add('model_hold')

  const decisionOrigin = constraintHold
    ? 'constraint_engine'
    : normalizedBySchema(signal) ? 'schema_normalized' : 'model'
  const reasonDetails = [...details.values()]
  return {
    decision_diagnostics_version:DECISION_DIAGNOSTICS_VERSION,
    decision_origin:decisionOrigin,
    contributing_reasons:reasonDetails.map(item => item.code),
    affected_timeframes:sortedTimeframes(reasonDetails.flatMap(item => item.timeframes)),
    reason_details:reasonDetails,
  }
}
