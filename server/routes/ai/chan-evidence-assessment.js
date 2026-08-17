const DATA_STATUS = Object.freeze({
  COMPLETE:'complete',
  INCOMPLETE:'incomplete',
  UNAVAILABLE:'unavailable',
  UNSUPPORTED:'unsupported',
  UNKNOWN:'unknown',
  NOT_APPLICABLE:'not_applicable',
})

const STRUCTURE_STATUS = Object.freeze({
  FORMED:'formed',
  PARTIAL:'partial',
  INSUFFICIENT:'insufficient_structure',
  UNAVAILABLE:'unavailable',
  NOT_APPLICABLE:'not_applicable',
})

const UNSUPPORTED_STATUSES = new Set(['unsupported', 'unsupported_policy', 'unsupported_timeframe_policy'])
const DATA_INCOMPLETE_CONTINUITY = new Set(['unknown_session', 'suspicious_gap', 'policy_missing'])
const STRUCTURE_INSUFFICIENT_STATUSES = new Set(['insufficient_bis', 'insufficient_klines'])
const STRUCTURE_PARTIAL_STATUSES = new Set(['partial', 'unreliable_segments', 'segment_history_unresolved'])

function lower(value) { return String(value == null ? '' : value).trim().toLowerCase() }

function chanDataIsIncomplete(chan = {}) {
  const capabilities = chan?.evidence_capabilities
  if (capabilities && capabilities.data_complete === false) return true
  const explicitDataComplete = capabilities?.data_complete === true
  // `data_complete` proves the historical/continuity/topology input, but it
  // does not prove absolute time placement.  A bad clock or untrusted time
  // location remains a data failure even when the structure calculator has
  // enough bars to produce a result.
  if (chan.absolute_time_location_reliable === false || chan.time_location_reliable === false) return true
  if (['unknown', 'untrusted'].includes(lower(chan.clock_trust_level))) return true
  if (capabilities && (capabilities.history_complete === false
    || capabilities.continuity_complete === false || capabilities.topology_input_complete === false)) return true
  if (chan.history_sufficient === false || chan.closed_history_sufficient === false) return true
  // `window_stable=false` is often a structural result for insufficient_bis;
  // do not turn it into a data error when the producer explicitly proved the
  // underlying input complete.  Without that proof, retain the conservative
  // legacy interpretation.
  if ((!explicitDataComplete && chan.window_stable === false) || chan.cache_internal_gap_unresolved === true) return true
  if (chan.structure_time_key_reliable === false) return true
  const continuity = chan.continuity && typeof chan.continuity === 'object' ? chan.continuity : null
  if (continuity && (continuity.known === false || continuity.reliable === false
    || DATA_INCOMPLETE_CONTINUITY.has(lower(continuity.status))
    || continuity.cache_internal_gap_unresolved === true)) return true
  if (DATA_INCOMPLETE_CONTINUITY.has(lower(chan.continuity_status))) return true
  // A legacy/partial Chan payload without an explicit data proof is not safe
  // to treat as structural-only; retain the conservative fail-closed rule.
  if (!explicitDataComplete && !['complete', 'ok'].includes(lower(chan.status))) return true
  return false
}

function chanIsUnsupported(chan = {}) {
  const codes = chan?.evidence_capabilities?.reason_codes
  return UNSUPPORTED_STATUSES.has(lower(chan.status))
    || (Array.isArray(codes) && codes.some(code => lower(code).includes('unsupported')))
}

function chanStructureStatus(chan = {}) {
  const status = lower(chan.status)
  if (!status) return STRUCTURE_STATUS.UNAVAILABLE
  if (STRUCTURE_INSUFFICIENT_STATUSES.has(status)) return STRUCTURE_STATUS.INSUFFICIENT
  if (STRUCTURE_PARTIAL_STATUSES.has(status)) return STRUCTURE_STATUS.PARTIAL
  const capabilities = chan.evidence_capabilities
  if (capabilities && capabilities.center_structure_usable === false && status !== 'ok' && status !== 'complete') {
    return STRUCTURE_STATUS.PARTIAL
  }
  return ['complete', 'ok'].includes(status) ? STRUCTURE_STATUS.FORMED : STRUCTURE_STATUS.PARTIAL
}

function aggregateStructureStatus(chans = []) {
  const statuses = chans.map(chanStructureStatus)
  if (!statuses.length || statuses.every(status => status === STRUCTURE_STATUS.UNAVAILABLE)) return STRUCTURE_STATUS.UNAVAILABLE
  if (statuses.includes(STRUCTURE_STATUS.PARTIAL)) return STRUCTURE_STATUS.PARTIAL
  if (statuses.includes(STRUCTURE_STATUS.INSUFFICIENT)) return STRUCTURE_STATUS.INSUFFICIENT
  return STRUCTURE_STATUS.FORMED
}

/**
 * Assess Chan evidence along two independent axes.  `data_status` answers
 * whether the requested source can be trusted; `structure_status` describes
 * what that trusted source actually formed.  In particular, a complete
 * fixed window with `insufficient_bis` is complete data with insufficient
 * structure, not missing data.
 */
export function assessChanEvidenceDimensions(requirementOrStatus, timeframeValues = []) {
  const requirement = requirementOrStatus && typeof requirementOrStatus === 'object'
    ? requirementOrStatus : { status:requirementOrStatus }
  const requirementStatus = lower(requirement.status)
  if (requirementStatus === 'disabled') {
    return { data_status:DATA_STATUS.NOT_APPLICABLE, structure_status:STRUCTURE_STATUS.NOT_APPLICABLE,
      status:'not_applicable', reason:null, issues:[] }
  }
  if (requirementStatus === 'unknown') {
    return { data_status:DATA_STATUS.UNKNOWN, structure_status:STRUCTURE_STATUS.UNAVAILABLE,
      status:'unknown', reason:'chan_requirement_unknown', issues:[] }
  }
  if (Array.isArray(requirement.unsupported_timeframes) && requirement.unsupported_timeframes.length) {
    return { data_status:DATA_STATUS.UNSUPPORTED, structure_status:STRUCTURE_STATUS.UNAVAILABLE,
      status:'unsupported', reason:'chan_timeframe_unsupported', issues:[] }
  }
  const chans = timeframeValues.map(value => value?.chan).filter(Boolean)
  if (!chans.length) {
    return { data_status:DATA_STATUS.UNAVAILABLE, structure_status:STRUCTURE_STATUS.UNAVAILABLE,
      status:'unavailable', reason:'chan_evidence_unavailable', issues:[] }
  }
  if (chans.some(chanIsUnsupported)) {
    return { data_status:DATA_STATUS.UNSUPPORTED, structure_status:aggregateStructureStatus(chans),
      status:'unsupported', reason:'chan_timeframe_unsupported', issues:[] }
  }
  const dataIncomplete = chans.some(chanDataIsIncomplete)
  const dataStatus = dataIncomplete ? DATA_STATUS.INCOMPLETE : DATA_STATUS.COMPLETE
  const structureStatus = aggregateStructureStatus(chans)
  const issues = []
  if (dataIncomplete) issues.push('chan_evidence_incomplete')
  else if (structureStatus === STRUCTURE_STATUS.INSUFFICIENT) issues.push('chan_structure_insufficient')
  else if (structureStatus === STRUCTURE_STATUS.PARTIAL) issues.push('chan_evidence_partial')
  const status = dataIncomplete || structureStatus !== STRUCTURE_STATUS.FORMED ? 'partial' : 'complete'
  return { data_status:dataStatus, structure_status:structureStatus, status,
    reason:issues[0] || null, issues }
}

export const CHAN_DATA_STATUSES = DATA_STATUS
export const CHAN_STRUCTURE_STATUSES = STRUCTURE_STATUS
