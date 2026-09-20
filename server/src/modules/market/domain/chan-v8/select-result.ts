import type { DivergenceEvidence, EntryEvidence } from './evidence-remapping.js'
import type { ChanResult } from './chan-result.js'
import { stableTerminalStructureKey, terminalEvidenceStart, windowCanObserve, confirmedSegmentEvidence } from './window-evidence.js'
import { buildCrossWindowConsensusSegments, candidateEndsWithSegmentChain } from './segment-consensus.js'
import { selectConsensusCenters } from './center-consensus.js'
import { stableCenterCoreKey } from './center-consensus-evidence.js'
import { divergenceResult as emptyDivergence, DETERMINISTIC_NO_DIVERGENCE_REASONS } from './divergence-result.js'
import { CONCLUSIVE_FORMING_NONE_REASONS, stableDivergenceEvidenceKey, stableFormingCandidateEvidenceKey, stableEntryEvidenceKey, remapDivergenceToConsensus, remapFormingDivergenceToConsensus, preserveHistoricalDivergenceReferences, remapEntryCandidateToConsensus } from './evidence-remapping.js'
import { selectEvidenceConsensus, conservativeDivergence, majorityEvidenceItems } from './evidence-voting.js'
import { classifyChanTrend, prioritizeLatestChanStructure } from './trend.js'
import { updateClonedChanResult } from './result-update.js'
import { round3 } from './rounding.js'

export function selectStableChanResult(candidates: readonly ChanResult[], options: { authoritativeCandidate?: ChanResult | null; minimumCenterContextBars?: number } = {}): ChanResult | null {
  const explicitAuthoritativeCandidate = options.authoritativeCandidate || null
  const authoritativeCandidate = explicitAuthoritativeCandidate || candidates[0] || null
  const groups = new Map<string, ChanResult[]>()
  for (const candidate of candidates) {
    const key = stableTerminalStructureKey(candidate)
    if (!key) continue
    const group = groups.get(key) || []
    group.push(candidate)
    groups.set(key, group)
  }
  const supported = [...groups.values()].map(group => {
    const evidenceStart = terminalEvidenceStart(group[0])
    const eligible = candidates.filter(candidate => windowCanObserve(candidate, evidenceStart))
    return { group, evidenceStart, eligibleCount:eligible.length, ratio:eligible.length ? group.length / eligible.length : 0 }
  }).filter(item => (!explicitAuthoritativeCandidate || item.group.includes(authoritativeCandidate!))
    && item.group.length >= 2 && item.group.length * 2 > item.eligibleCount)
  if (supported.length === 0) return null
  supported.sort((a, b) => (
    b.ratio - a.ratio
    || b.group.length - a.group.length
    || Math.max(...b.group.map(item => item.center_count * 10000 + item.segment_count * 100 + item.raw_bar_count))
      - Math.max(...a.group.map(item => item.center_count * 10000 + item.segment_count * 100 + item.raw_bar_count))
  ))
  if (supported[1] && supported[0]!.ratio === supported[1].ratio && supported[0]!.group.length === supported[1].group.length) return null
  const winnerEvidence = supported[0]!
  const winner = winnerEvidence.group
  const validatorCount = winnerEvidence.eligibleCount
  const confirmedSuffix = buildCrossWindowConsensusSegments(winner, candidates)
  if (confirmedSuffix.segments.length < 2) return null
  const derivedCandidates = winner.filter(candidate => candidateEndsWithSegmentChain(candidate, confirmedSuffix.segments))
  if (derivedCandidates.length < 2) return null
  const derivedValidatorCount = derivedCandidates.length
  // The complete window owns the phase and the public structure chain.  A
  // shorter suffix is only a validator; using it as the output base can make
  // a confirmed full-window anchor disagree with the returned center.
  if (explicitAuthoritativeCandidate && !derivedCandidates.includes(authoritativeCandidate!)) return null
  const selected: ChanResult = explicitAuthoritativeCandidate
    ? authoritativeCandidate!
    : [...derivedCandidates].sort((a, b) => (
      b.center_count - a.center_count || b.segment_count - a.segment_count || b.raw_bar_count - a.raw_bar_count
    ))[0]!
  const consensus = explicitAuthoritativeCandidate
    ? { ...confirmedSuffix, segments:confirmedSegmentEvidence(authoritativeCandidate) }
    : confirmedSuffix
  if (consensus.segments.length < 2) return null
  const timeframe = selected?.latest_center?.source_timeframe || selected?.current_center?.source_timeframe || null
  const centerConsensus = selectConsensusCenters(
    derivedCandidates, candidates, consensus.segments, timeframe, authoritativeCandidate,
    Number(options.minimumCenterContextBars) || 0)
  const summarizedCenters = centerConsensus.centers
  const latestConsensusCenter = summarizedCenters.at(-1) || null
  const centerCandidates = latestConsensusCenter ? centerConsensus.latestCandidates : []
  const consensusCenterEntryConfirmed = Boolean(latestConsensusCenter
    && latestConsensusCenter.entry_segment_stable_id && latestConsensusCenter.entry_segment_id != null)
  const consensusAnchorState = !latestConsensusCenter
    ? 'unavailable'
    : consensusCenterEntryConfirmed ? 'candidate' : 'unconfirmed'
  const divergenceCandidates = derivedCandidates.map(candidate => {
    const divergence = candidate?.divergence
    if (!latestConsensusCenter) return { ...candidate, divergence:emptyDivergence('no_cross_window_center') }
    if (stableCenterCoreKey(candidate?.latest_center, candidate) !== stableCenterCoreKey(latestConsensusCenter)) {
      return { ...candidate, divergence:emptyDivergence('center_reference_mismatch') }
    }
    const directional = divergence?.type === 'top' || divergence?.type === 'bottom'
    if (!directional && DETERMINISTIC_NO_DIVERGENCE_REASONS.has(String(divergence?.reason || ''))) {
      const localCenter = candidate?.latest_center || null
      const sameEntry = Boolean(latestConsensusCenter.entry_segment_stable_id
        && localCenter?.entry_segment_stable_id === latestConsensusCenter.entry_segment_stable_id)
      // An open centre legitimately has no departure segment yet.  Treat a
      // shared null departure as the same structural reference, while still
      // rejecting candidates that refer to a different departure.
      const consensusDeparture = latestConsensusCenter.departure_segment_stable_id || null
      const localDeparture = localCenter?.departure_segment_stable_id || null
      const sameDeparture = localDeparture === consensusDeparture
      return sameEntry && sameDeparture
        ? candidate
        : { ...candidate, divergence:emptyDivergence('center_reference_mismatch') }
    }
    if (!divergence?.confirmed) return candidate
    const entry = divergence.entry_segment?.stable_id || null
    const departure = divergence.departure_segment?.stable_id || null
    const entryMatches = Boolean(entry && latestConsensusCenter.entry_segment_stable_id
      && entry === latestConsensusCenter.entry_segment_stable_id)
    const departureMatches = Boolean(departure && latestConsensusCenter.departure_segment_stable_id
      && departure === latestConsensusCenter.departure_segment_stable_id)
    return entryMatches && departureMatches
      ? candidate
      : { ...candidate, divergence:emptyDivergence('center_reference_mismatch') }
  })
  const divergenceConsensus = selectEvidenceConsensus(divergenceCandidates,
    candidate => stableDivergenceEvidenceKey(candidate?.divergence))
  const divergenceWinner = divergenceConsensus.group
  const formingCandidates = latestConsensusCenter
    ? derivedCandidates.map(candidate => {
      if (stableCenterCoreKey(candidate?.latest_center, candidate) !== stableCenterCoreKey(latestConsensusCenter)) {
        return { ...candidate, forming_divergence:emptyDivergence('center_reference_mismatch') }
      }
      const forming = candidate?.forming_divergence
      const directional = forming?.type === 'top' || forming?.type === 'bottom'
      if (!directional && CONCLUSIVE_FORMING_NONE_REASONS.has(String(forming?.reason || ''))) {
        const localCenter = candidate?.latest_center || null
        const sameEntry = Boolean(latestConsensusCenter.entry_segment_stable_id
          && localCenter?.entry_segment_stable_id === latestConsensusCenter.entry_segment_stable_id)
        const consensusDeparture = latestConsensusCenter.departure_segment_stable_id || null
        const localDeparture = localCenter?.departure_segment_stable_id || null
        if (!sameEntry || localDeparture !== consensusDeparture) {
          return { ...candidate, forming_divergence:emptyDivergence('center_reference_mismatch') }
        }
      }
      return candidate
    })
    : derivedCandidates.map(candidate => ({ ...candidate, forming_divergence:emptyDivergence('no_cross_window_center') }))
  const formingConsensus = selectEvidenceConsensus(formingCandidates, candidate => stableFormingCandidateEvidenceKey(candidate))
  const formingWinner = formingConsensus.group
  const votedDivergence = divergenceWinner
    ? conservativeDivergence(divergenceWinner.map(candidate => candidate.divergence))
    : null
  const consensusDivergence = votedDivergence
    ? remapDivergenceToConsensus(votedDivergence, consensus.segments, summarizedCenters, latestConsensusCenter)
    : null
  const votedFormingDivergence = formingWinner
    ? conservativeDivergence(formingWinner.map(candidate => candidate.forming_divergence))
    : null
  const consensusFormingDivergence = votedFormingDivergence
    ? remapFormingDivergenceToConsensus(votedFormingDivergence,
      formingWinner?.[0]?.latest_center, formingWinner?.[0], consensus.segments, latestConsensusCenter)
    : null
  const recentDivergences = majorityEvidenceItems<ChanResult, DivergenceEvidence, DivergenceEvidence | undefined>(derivedCandidates,
    candidate => Array.isArray(candidate?.recent_divergences) ? candidate.recent_divergences : [],
    stableDivergenceEvidenceKey, derivedValidatorCount, conservativeDivergence,
    item => Number(item?.entry_segment?.start_time_utc_msc || item?.departure_segment?.start_time_utc_msc) || null)
    .map(item => preserveHistoricalDivergenceReferences(item, consensus.segments, summarizedCenters))
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
  const entryCandidates = latestConsensusCenter
    ? majorityEvidenceItems<ChanResult, EntryEvidence, EntryEvidence>(centerCandidates,
      candidate => Array.isArray(candidate?.entry_candidates) ? candidate.entry_candidates : [],
      stableEntryEvidenceKey, centerCandidates.length, items => items[0]!,
      item => Number(item?.center?.start_time_utc_msc || item?.segment?.start_time_utc_msc) || null)
      .map(item => remapEntryCandidateToConsensus(item, consensus.segments, summarizedCenters))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
    : []
  const confirmedWarnings = (selected.warnings || []).filter(item => (
    item !== 'segment_window_unstable'
    && item !== 'center_entry_unconfirmed'
    && item !== 'no_valid_center'
    // This warning belonged to the removed fixed-age gate. Ignore it when a
    // legacy candidate is still present in a cross-window validation set.
    && item !== 'confirmed_structure_stale'
  ))
  if (latestConsensusCenter) {
    // Center existence is independently confirmed below; local-window center warnings
    // are not allowed to leak into the cross-window result.
  } else if (centerConsensus.hadEvidence) confirmedWarnings.push('center_cross_window_unstable')
  else confirmedWarnings.push('no_valid_center')
  if (latestConsensusCenter && !consensusCenterEntryConfirmed) confirmedWarnings.push('center_entry_unconfirmed')
  const divergenceFailureReason = !latestConsensusCenter
    ? 'no_cross_window_center'
    : divergenceConsensus.eligibleCount < 2
      ? 'divergence_evidence_unavailable' : 'divergence_cross_window_unstable'
  if (!consensusDivergence && latestConsensusCenter) confirmedWarnings.push(divergenceFailureReason)
  const uniqueWarnings = [...new Set(confirmedWarnings)]
  const confirmedStatus = consensus.segments.length > 0 && summarizedCenters.length === 0
    ? 'partial'
    : uniqueWarnings.length > 0 ? 'partial' : 'ok'
  const confirmedReliability = selected.history_sufficient && selected.closed_history_sufficient
    && selected.time_location_reliable && consensus.segments.length >= 2 && summarizedCenters.length > 0
    && uniqueWarnings.length === 0
    ? 'high'
    : selected.history_sufficient && selected.closed_history_sufficient && consensus.segments.length > 0
      ? 'medium'
      : 'low'
  const structureTopologyReliable = selected.history_sufficient && selected.closed_history_sufficient
    && selected.structure_time_key_reliable === true
    && selected.continuity_complete !== false
    && selected.cache_internal_gap_unresolved !== true
    && consensus.segments.length >= 2 && summarizedCenters.length > 0
  const latestPrice = Number(selected.latest_price)
  const priceVsCenter = !latestConsensusCenter || !Number.isFinite(latestPrice)
    ? 'none'
    : latestPrice > Number(latestConsensusCenter.zh) ? 'above'
      : latestPrice < Number(latestConsensusCenter.zl) ? 'below' : 'inside'
  const backgroundTrendState = classifyChanTrend(consensus.segments, summarizedCenters, latestPrice,
    consensusDivergence || emptyDivergence(divergenceFailureReason), confirmedReliability,
    selected.candidate_segment)
  const prioritizedStructure = prioritizeLatestChanStructure(
    backgroundTrendState, selected.latest_structure, confirmedReliability)
  const trendState = prioritizedStructure.trend_state
  const formingFailureReason = formingConsensus.eligibleCount < 2
    ? 'forming_evidence_unavailable' : 'forming_cross_window_unstable'
  return updateClonedChanResult(selected, {
    status: confirmedStatus,
    reliability: confirmedReliability,
    window_stable: true,
    structure_topology_reliable:structureTopologyReliable,
    segment_count:consensus.segments.length,
    center_count:summarizedCenters.length,
    confirmed_structure_max_age_bars:null,
    confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
    current_segment:consensus.segments.at(-1)
      ? { ...consensus.segments.at(-1)!, structure_role:'latest_confirmed' } : null,
    prev_segment:consensus.segments.at(-2)
      ? { ...consensus.segments.at(-2)!, structure_role:'previous_confirmed' } : null,
    current_center:latestConsensusCenter,
    active_center:latestConsensusCenter && latestConsensusCenter.status !== 'closed'
      && priceVsCenter === 'inside' ? latestConsensusCenter : null,
    latest_center:latestConsensusCenter,
    price_vs_center:priceVsCenter,
    structure_anchor:{
      ...(selected.structure_anchor || {}),
      recommended_time_utc_msc:null,
      last_confirmed_segment_time_utc_msc:Number(consensus.segments.at(-1)?.end_time_utc_msc) || null,
      full_window_authoritative:false,
      temporal_identity_stable:false,
      temporal_closed_bar_support:0,
      temporal_closed_bar_validator_count:0,
      bootstrap_state:consensusAnchorState,
    },
    divergence:consensusDivergence || emptyDivergence(divergenceFailureReason),
    forming_divergence:consensusFormingDivergence || emptyDivergence(formingFailureReason),
    recent_divergences: recentDivergences,
    latest_structure:prioritizedStructure.latest_structure,
    trend_state:trendState,
    entry_candidates: entryCandidates,
    warnings: uniqueWarnings,
    cross_window_support_count: winner.length,
    cross_window_validator_count: validatorCount,
    cross_window_total_count:candidates.length,
    cross_window_support_ratio: validatorCount > 0 ? round3(winner.length / validatorCount) : 0,
    cross_window_segment_pair_support:consensus.pairSupport,
    cross_window_derived_support_count: derivedCandidates.length,
    authoritative_terminal_chain_confirmed:derivedCandidates.includes(authoritativeCandidate!),
    cross_window_derived_support_ratio: Number(consensus.validatorCount) > 0
      ? round3(consensus.supportCount! / consensus.validatorCount!) : 0,
    cross_window_center_support_count: latestConsensusCenter ? centerConsensus.latestSupportCount : 0,
    cross_window_center_validator_count:latestConsensusCenter ? centerConsensus.latestValidatorCount : 0,
    cross_window_divergence_support_count: divergenceWinner?.length || 0,
    cross_window_divergence_validator_count:divergenceConsensus.eligibleCount,
    cross_window_forming_support_count:formingWinner?.length || 0,
    cross_window_forming_validator_count:formingConsensus.eligibleCount,
    cross_window_trend_support_count:derivedCandidates.length,
  })
}
