interface CapabilityInput {
  history_complete?: boolean
  closed_history_sufficient?: boolean
  history_sufficient?: boolean
  structure_time_key_reliable?: boolean
  continuity_complete?: boolean | string
  cache_internal_gap_unresolved?: boolean
  topology_input_complete?: boolean
  absolute_time_location_reliable?: boolean
  time_location_reliable?: boolean
  window_stable?: boolean
  authoritative_terminal_chain_confirmed?: boolean
  structure_topology_reliable?: boolean
  continuity_status?: string | null
  unknown_session_gap_count?: number
  segment_count?: number
  center_count?: number
  closed_bar_count?: number
  latest_structure?: { local_bias?: string | null; latest_confirmed_fractal?: unknown; latest_confirmed_bi?: unknown } | null
  current_segment?: { dir?: string; structure_role?: string } | null
  trend_state?: { direction?: string } | null
  structure_anchor?: { current_result_usable?: boolean; matched?: boolean } | null
  latest_center?: { entry_segment_stable_id?: string | null; entry_segment_id?: number | null } | null
  divergence?: { reason?: string | null } | null
}
export interface ChanEvidenceCapabilities {
  history_complete: boolean; continuity_complete: boolean; topology_input_complete: boolean
  absolute_time_location_reliable: boolean; data_complete: boolean; local_structure_usable: boolean
  segment_direction_usable: boolean; center_structure_usable: boolean; entry_structure_usable: boolean
  divergence_usable: boolean; reason_codes: string[]
}
const MACD_WARMUP_BARS = 40

export function buildChanEvidenceCapabilities(result: CapabilityInput | null, overrides: Partial<ChanEvidenceCapabilities> = {}): ChanEvidenceCapabilities {
  // Keep the three data-quality dimensions explicit.  A source can have a
  // stable, account-scoped structure key while its historical UTC location is
  // still approximate (for example MT4's current-offset conversion).  The
  // latter must not make otherwise valid price topology disappear.
  const historyComplete = overrides.history_complete ?? (result?.history_complete ?? (
    result?.history_sufficient === true
      && result?.closed_history_sufficient === true
  ))
  const structureTimeKeyReliable = result?.structure_time_key_reliable === true
  const continuityStatus = String(result?.continuity_status || '').trim().toLowerCase()
  const continuityComplete = overrides.continuity_complete ?? (result?.continuity_complete ?? (
    result?.cache_internal_gap_unresolved !== true
      && Number(result?.unknown_session_gap_count || 0) === 0
      && !['suspicious_gap', 'unknown_session', 'policy_missing'].includes(continuityStatus)
  ))
  const topologyInputComplete = overrides.topology_input_complete ?? (result?.topology_input_complete ?? (
    historyComplete
      && continuityComplete
      && structureTimeKeyReliable
  ))
  const absoluteTimeLocationReliable = overrides.absolute_time_location_reliable
    ?? (result?.absolute_time_location_reliable ?? result?.time_location_reliable === true)
  const dataComplete = overrides.data_complete ?? topologyInputComplete
  const localStructure = overrides.local_structure_usable ?? (
    dataComplete
      && result?.latest_structure
      && ['up', 'down'].includes(result.latest_structure.local_bias ?? '')
      && Boolean(result.latest_structure.latest_confirmed_fractal
        || result.latest_structure.latest_confirmed_bi)
  )
  const currentSegmentDirection = result?.current_segment?.dir
  const segmentDirectionValue = ['up', 'down'].includes(currentSegmentDirection ?? '')
    ? currentSegmentDirection : result?.trend_state?.direction
  const segmentDirection = overrides.segment_direction_usable ?? (
    historyComplete
      && continuityComplete
      && structureTimeKeyReliable
      && result?.window_stable === true
      && result?.authoritative_terminal_chain_confirmed === true
      && Number(result?.segment_count) > 0
      && ['up', 'down'].includes(segmentDirectionValue ?? '')
  )
  const centerStructure = overrides.center_structure_usable ?? (
    segmentDirection
      && Number(result?.center_count) > 0
      && result?.structure_topology_reliable === true
  )
  const entryStructure = overrides.entry_structure_usable ?? (
    centerStructure
      && result?.structure_anchor?.current_result_usable === true
      && Boolean(result?.latest_center?.entry_segment_stable_id)
      && Number(result?.latest_center?.entry_segment_id) > 0
  )
  const divergenceReason = String(result?.divergence?.reason || '')
  const hasDivergenceEvidence = Boolean(result?.divergence
    && typeof result.divergence === 'object' && divergenceReason)
  const divergenceEvidenceUnavailable = new Set([
    'no_macd_data', 'insufficient_valid_segments', 'no_valid_center',
    'no_cross_window_center', 'center_reference_mismatch', 'no_entry_segment',
    'macd_warmup_overlap', 'invalid_macd_area',
    'divergence_evidence_unavailable', 'divergence_cross_window_unstable',
  ]).has(divergenceReason) || !hasDivergenceEvidence
  const divergence = overrides.divergence_usable ?? (
    entryStructure
      && Number(result?.closed_bar_count) >= MACD_WARMUP_BARS
      && !divergenceEvidenceUnavailable
  )
  const reasonCodes = new Set(Array.isArray(overrides.reason_codes) ? overrides.reason_codes : [])
  if (!dataComplete) reasonCodes.add(result?.cache_internal_gap_unresolved === true
    ? 'cache_internal_gap_unresolved' : 'data_incomplete')
  if (!continuityComplete) reasonCodes.add('continuity_incomplete')
  if (!absoluteTimeLocationReliable) reasonCodes.add('absolute_time_location_unreliable')
  if (!localStructure) reasonCodes.add('local_structure_unusable')
  if (!segmentDirection) reasonCodes.add('segment_direction_unusable')
  if (!centerStructure) reasonCodes.add(Number(result?.center_count) > 0
    ? 'center_structure_unusable' : 'no_confirmed_center')
  if (!entryStructure) reasonCodes.add(result?.latest_center
    ? 'entry_structure_unconfirmed' : 'entry_structure_unusable')
  if (!divergence) reasonCodes.add(divergenceEvidenceUnavailable
    ? 'divergence_evidence_unavailable' : 'divergence_unusable')
  return {
    history_complete: Boolean(historyComplete),
    continuity_complete: Boolean(continuityComplete),
    topology_input_complete: Boolean(topologyInputComplete),
    absolute_time_location_reliable: Boolean(absoluteTimeLocationReliable),
    data_complete: Boolean(dataComplete),
    local_structure_usable:Boolean(localStructure),
    segment_direction_usable: Boolean(segmentDirection),
    center_structure_usable: Boolean(centerStructure),
    entry_structure_usable: Boolean(entryStructure),
    divergence_usable: Boolean(divergence),
    reason_codes: [...reasonCodes],
  }
}

export function withChanEvidenceCapabilities<T extends CapabilityInput>(result: T, overrides: Partial<ChanEvidenceCapabilities> = {}) {
  return { ...result, evidence_capabilities: buildChanEvidenceCapabilities(result, overrides) }
}
