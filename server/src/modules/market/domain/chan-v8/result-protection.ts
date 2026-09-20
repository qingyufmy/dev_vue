import type { ChanResult } from './chan-result.js'
import { updateChanResultInPlace } from './result-update.js'
import { divergenceResult as emptyDivergence } from './divergence-result.js'
import { emptyTrendState, classifyChanTrend } from './trend.js'
import { buildChanEvidenceCapabilities } from './evidence-capabilities.js'

export function suppressUnconfirmedWindowStructure(primary: ChanResult) {
  const warnings = [...new Set([
    ...(primary.warnings || []).filter(item => item !== 'segment_consensus_partial'
      && item !== 'center_entry_unconfirmed'),
    'segment_cross_window_unstable',
    'segments_not_confirmed',
    'no_valid_center',
  ])]
  return updateChanResultInPlace(primary, {
    status: Number(primary.active_bi_count || primary.bi_count) >= 3 ? 'segment_history_unresolved' : primary.status,
    reliability: 'low',
    window_stable: false,
    structure_topology_reliable:false,
    cross_window_support_count: 0,
    cross_window_validator_count: 0,
    cross_window_support_ratio: 0,
    segment_count: 0,
    center_count: 0,
    historical_segment_run_count: 0,
    historical_segment_count: 0,
    confirmed_structure_age_bars: null,
    confirmed_structure_max_age_bars: null,
    confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
    structure_anchor: {
      ...(primary.structure_anchor || {}),
      matched: false,
      recommended_time_utc_msc: null,
      last_confirmed_segment_time_utc_msc: null,
      full_window_authoritative:false,
      temporal_identity_stable:false,
      temporal_closed_bar_support:0,
      temporal_closed_bar_validator_count:0,
      bootstrap_state:'unavailable',
      bootstrap_identity:null,
      bootstrap_core_stable_id:null,
      bootstrap_entry_segment_stable_id:null,
      bootstrap_entry_start_time_utc_msc:null,
      current_result_usable:false,
    },
    current_segment: null,
    prev_segment: null,
    current_center: null,
    active_center: null,
    latest_center: null,
    price_vs_center: 'none',
    divergence: emptyDivergence('segment_cross_window_unstable'),
    forming_divergence: emptyDivergence('segment_cross_window_unstable'),
    recent_divergences: [],
    trend_state: emptyTrendState('segment_cross_window_unstable'),
    entry_candidates: [],
    evidence_capabilities: {
      history_complete: primary?.evidence_capabilities?.history_complete === true,
      continuity_complete: primary?.evidence_capabilities?.continuity_complete === true,
      topology_input_complete: primary?.evidence_capabilities?.topology_input_complete === true,
      absolute_time_location_reliable: primary?.absolute_time_location_reliable
        ?? primary?.time_location_reliable === true,
      data_complete: primary?.evidence_capabilities?.data_complete === true,
      local_structure_usable:primary?.evidence_capabilities?.local_structure_usable === true,
      segment_direction_usable: false,
      center_structure_usable: false,
      entry_structure_usable: false,
      divergence_usable: false,
      reason_codes: [...new Set([
        ...(primary?.evidence_capabilities?.reason_codes || []),
        'fixed_window_not_converged',
      ])],
    },
    warnings,
  })
}

export function resolveUnanchoredStructureReason(result: ChanResult) {
  const warnings = new Set(Array.isArray(result?.warnings) ? result.warnings : [])
  if (!result?.latest_center) {
    if (warnings.has('center_cross_window_unstable')) return 'center_cross_window_unstable'
    if (warnings.has('no_valid_center')) return 'no_valid_center'
    if (Number(result?.center_count) > 0) return 'center_cross_window_unstable'
    return 'no_confirmed_center'
  }
  const entryConfirmed = Boolean(result.latest_center.entry_segment_stable_id
    && Number(result.latest_center.entry_segment_id) > 0)
  if (!entryConfirmed || warnings.has('center_entry_unconfirmed')) return 'center_entry_unconfirmed'
  if (warnings.has('center_cross_window_unstable')) return 'center_cross_window_unstable'
  return 'entry_structure_unconfirmed'
}

export function protectBootstrapDependentEvidence(selected: ChanResult, usable: boolean, reliability: string, unavailableReason: string | null = null) {
  if (usable) {
    const usableSelected = {
      ...selected,
      structure_anchor:{
        ...(selected?.structure_anchor || {}),
        current_result_usable:true,
      },
    }
    return {
      divergence:selected.divergence,
      forming_divergence:selected.forming_divergence,
      recent_divergences:selected.recent_divergences,
      trend_state:selected.trend_state,
      entry_candidates:selected.entry_candidates,
      evidence_capabilities:buildChanEvidenceCapabilities(usableSelected),
    }
  }
  const reason = String(unavailableReason || resolveUnanchoredStructureReason(selected))
  const divergence = emptyDivergence(reason)
  return {
    divergence,
    forming_divergence:emptyDivergence(reason),
    recent_divergences:[],
    trend_state:classifyChanTrend(
      [selected?.prev_segment, selected?.current_segment].filter((value): value is NonNullable<typeof value> => Boolean(value)),
      [selected?.latest_center].filter((value): value is NonNullable<typeof value> => Boolean(value)),
      Number(selected?.latest_price), divergence, reliability, selected?.candidate_segment,
      selected?.latest_structure),
    entry_candidates:[],
    evidence_capabilities:buildChanEvidenceCapabilities(selected, {
      entry_structure_usable:false,
      divergence_usable:false,
      reason_codes:[reason],
    }),
  }
}

export function protectUnanchoredShortHistory(primary: ChanResult, sourceHistoryCount: number, calculationWindowCount: number) {
  const reliability = primary.reliability === 'high' ? 'medium' : primary.reliability
  const unavailableReason = resolveUnanchoredStructureReason(primary)
  const warnings = [...new Set([...(primary.warnings || []), unavailableReason])]
  const hasEntryDependentStructure = Number(primary.segment_count) > 0
    || Number(primary.center_count) > 0
    || primary.divergence?.type === 'top' || primary.divergence?.type === 'bottom'
    || primary.forming_divergence?.type === 'top' || primary.forming_divergence?.type === 'bottom'
    || (Array.isArray(primary.recent_divergences) && primary.recent_divergences.length > 0)
    || (Array.isArray(primary.entry_candidates) && primary.entry_candidates.length > 0)
  const protectedEvidence = hasEntryDependentStructure
    ? protectBootstrapDependentEvidence(primary, false, reliability, unavailableReason)
    : {
      divergence:primary.divergence,
      forming_divergence:primary.forming_divergence,
      recent_divergences:primary.recent_divergences,
      trend_state:primary.trend_state,
      entry_candidates:primary.entry_candidates,
    }
  return updateChanResultInPlace(primary, {
    status:primary.status === 'ok' ? 'partial' : primary.status,
    reliability,
    warnings,
    temporal_identity_stable:false,
    temporal_closed_bar_support:0,
    temporal_closed_bar_validator_count:0,
    cross_window_entry_support_count:0,
    cross_window_entry_validator_count:0,
    confirmed_structure_max_age_bars:null,
    confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
    authoritative_terminal_chain_confirmed:false,
    ...protectedEvidence,
    evidence_capabilities:buildChanEvidenceCapabilities(primary, {
      entry_structure_usable:false,
      divergence_usable:false,
      reason_codes:[unavailableReason],
    }),
    structure_anchor:{
      ...(primary.structure_anchor || {}),
      matched:false,
      recommended_time_utc_msc:null,
      full_window_authoritative:true,
      temporal_identity_stable:false,
      temporal_closed_bar_support:0,
      temporal_closed_bar_validator_count:0,
      cross_window_entry_support_count:0,
      cross_window_entry_validator_count:0,
      bootstrap_identity:null,
      bootstrap_core_stable_id:null,
      bootstrap_entry_segment_stable_id:null,
      bootstrap_entry_start_time_utc_msc:null,
      bootstrap_state:'unavailable',
      current_result_usable:false,
    },
    source_history_count:sourceHistoryCount,
    calculation_window_count:calculationWindowCount,
    window_selection:'full_window_unanchored',
  })
}
