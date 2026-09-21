import type { ChanRate } from './types.js'
import type { ChanResult, ChanAnchor } from './chan-result.js'
import { resolveChanWindowPolicy, type WindowPolicyOptions } from './window-policy.js'
import { computeChanWindow, type ChanWindowOptions } from './compute-window.js'
import { emptyChanResult } from './empty-result.js'
import { calculateMacdSeries } from './macd.js'
import { round5 } from './rounding.js'
import { updateChanResultInPlace } from './result-update.js'
import { suppressUnconfirmedWindowStructure, protectUnanchoredShortHistory, protectBootstrapDependentEvidence, resolveUnanchoredStructureReason } from './result-protection.js'
import { selectStableChanResult } from './select-result.js'
import { buildFullWindowTemporalEvidence } from './temporal-window.js'
import { evaluateCrossWindowBootstrapEvidence } from './bootstrap-consensus.js'
import { buildChanEvidenceCapabilities } from './evidence-capabilities.js'
interface ChanDataQuality extends Record<string, unknown> {
  cache_internal_gap_details?: { from_utc_msc?: unknown; to_utc_msc?: unknown }[]
  expected_closures?: { from_utc_msc?: unknown; to_utc_msc?: unknown }[]
}
export interface ChanOptions extends ChanWindowOptions, WindowPolicyOptions {
  maximumHistoryCount?: number
  validationWindowCounts?: readonly number[]
  windowPolicyVersion?: string
  dataQuality?: ChanDataQuality | null
}
const MIN_KLINES_FOR_CHAN = 30, CHAN_CENTER_MIN_CONTEXT_BARS = 150
const CHAN_ALGORITHM_VERSION = 'chan_structure_v8'

export function computeChan(rates: readonly ChanRate[], timeframe: string, macdHist: readonly number[], options: ChanOptions = {}): ChanResult {
  const sourceHistoryCount = Array.isArray(rates) ? rates.length : 0
  const policy = resolveChanWindowPolicy(timeframe, options)
  if (policy.supported === false && !options.windowPolicy) {
    return emptyChanResult({
      timeframe,
      algorithm_version: CHAN_ALGORITHM_VERSION,
      status: 'unsupported_policy',
      warnings: ['chan_window_policy_unsupported_timeframe'],
      source_history_count: sourceHistoryCount,
      received_history_count: sourceHistoryCount,
      raw_bar_count: sourceHistoryCount,
      latest_price: Number.isFinite(Number(rates?.at?.(-1)?.close)) ? round5(Number(rates.at(-1)!.close)) : null,
      evidence_capabilities: {
        history_complete: false,
        continuity_complete: false,
        topology_input_complete: false,
        absolute_time_location_reliable: false,
        data_complete: false,
        segment_direction_usable: false,
        center_structure_usable: false,
        entry_structure_usable: false,
        divergence_usable: false,
        reason_codes: ['unsupported_timeframe_policy'],
      },
    })
  }
  const maximumHistoryCount = Math.max(MIN_KLINES_FOR_CHAN,
    Math.trunc(Number(options.maximumHistoryCount) || policy.target))
  const validationWindowCounts = [...new Set((Array.isArray(options.validationWindowCounts)
    ? options.validationWindowCounts : policy.validators)
    .map(value => Math.trunc(Number(value)))
    .filter(value => value >= MIN_KLINES_FOR_CHAN && value <= maximumHistoryCount))]
    .sort((a, b) => a - b)
  if (!validationWindowCounts.includes(maximumHistoryCount)) validationWindowCounts.push(maximumHistoryCount)
  const windowPolicyVersion = String(options.windowPolicyVersion || policy.windowPolicyVersion)
  // Indicators may ask the caller for a longer history. Chan is intentionally
  // bounded to the last target bars so an unrelated prefix cannot alter the
  // current structure.
  const calculationRates = sourceHistoryCount > maximumHistoryCount
    ? rates.slice(-maximumHistoryCount) : rates
  const calculationWindowCount = Array.isArray(calculationRates) ? calculationRates.length : 0
  const calculationMacdHist = sourceHistoryCount > maximumHistoryCount
    ? calculateMacdSeries(calculationRates.map(rate => Number(rate.close))).histSeries
    : Array.isArray(macdHist) && macdHist.length >= calculationWindowCount
      ? macdHist.slice(-calculationWindowCount)
      : calculateMacdSeries(calculationRates.map(rate => Number(rate.close))).histSeries
  const calculationStartUtcMs = Number(calculationRates?.[0]?.time_utc_msc)
  const calculationEndUtcMs = Number(calculationRates?.at?.(-1)?.time_utc_msc)
  const rawDataQuality: ChanDataQuality | null = options.dataQuality && typeof options.dataQuality === 'object'
    ? options.dataQuality : null
  // Anchor scope is determined against the same closed-bar slice that
  // computeChanWindow uses.  Comparing against the raw (possibly forming)
  // tail would allow an anchor from the future to enter the anchored path.
  const closedCalculationRates = rawDataQuality?.last_bar_closed === true
    ? calculationRates
    : (Array.isArray(calculationRates) ? calculationRates.slice(0, -1) : [])
  const closedCalculationStartUtcMs = Number(closedCalculationRates?.[0]?.time_utc_msc)
  const closedCalculationEndUtcMs = Number(closedCalculationRates?.at?.(-1)?.time_utc_msc)
  const withinCalculationWindow = (item: { from_utc_msc?: unknown; to_utc_msc?: unknown }) => {
    const from = Number(item?.from_utc_msc)
    const to = Number(item?.to_utc_msc)
    if (!Number.isFinite(from) || !Number.isFinite(to)
      || !Number.isFinite(calculationStartUtcMs) || !Number.isFinite(calculationEndUtcMs)) return true
    return to >= calculationStartUtcMs && from <= calculationEndUtcMs
  }
  const scopedDataQuality: ChanDataQuality | null = rawDataQuality ? {
    ...rawDataQuality,
    cache_internal_gap_details: Array.isArray(rawDataQuality.cache_internal_gap_details)
      ? rawDataQuality.cache_internal_gap_details.filter(withinCalculationWindow)
      : [],
    expected_closures: Array.isArray(rawDataQuality.expected_closures)
      ? rawDataQuality.expected_closures.filter(withinCalculationWindow)
      : [],
  } : rawDataQuality
  if (rawDataQuality?.cache_internal_gap_unresolved === true
    && Array.isArray(rawDataQuality.cache_internal_gap_details)
    && rawDataQuality.cache_internal_gap_details.length > 0
    && scopedDataQuality!.cache_internal_gap_details!.length === 0) {
    scopedDataQuality!.cache_internal_gap_unresolved = false
  }
  const requestedHistoryCount = Number(options.requestedHistoryCount)
  const calculationOptions = {
    ...options,
    dataQuality:scopedDataQuality,
    requestedHistoryCount:Number.isFinite(requestedHistoryCount) && requestedHistoryCount > 0
      ? Math.min(requestedHistoryCount, maximumHistoryCount)
      : maximumHistoryCount,
    maximumHistoryCount,
    validationWindowCounts,
    windowPolicyVersion,
  }
  const requestedTrustedAnchor = options.trustedStructureAnchor && typeof options.trustedStructureAnchor === 'object'
    ? options.trustedStructureAnchor : {}
  const requestedTrustedAnchorTime = Number(
    requestedTrustedAnchor.anchor_time_utc_msc ?? options.trustedStructureAnchorUtcMs)
  const hasTrustedAnchor = Number.isFinite(requestedTrustedAnchorTime) && requestedTrustedAnchorTime > 0
  const requestedAnchorCoreStableId = String(requestedTrustedAnchor.bootstrap_core_stable_id || '').trim() || null
  const requestedAnchorEntryStableId = String(requestedTrustedAnchor.bootstrap_entry_segment_stable_id || '').trim() || null
  const requestedAnchorLastConfirmedTime = Number(requestedTrustedAnchor.last_confirmed_segment_time_utc_msc)
  const normalizedRequestedAnchorLastConfirmedTime = Number.isFinite(requestedAnchorLastConfirmedTime)
    && requestedAnchorLastConfirmedTime > 0 ? requestedAnchorLastConfirmedTime : null
  const unanchoredOptions = {
    ...calculationOptions,
    trustedStructureAnchor:null,
    trustedStructureAnchorUtcMs:null,
  }
  const applyAnchorFallbackDiagnostics = (unanchored: ChanResult, anchorWarnings: string[], diagnostics: { time_matched?: boolean | undefined; identity_matched?: boolean | undefined; last_confirmed_segment_not_regressed?: boolean | undefined } = {}) => updateChanResultInPlace(unanchored, {
    status:'partial',
    reliability:unanchored.reliability === 'high' ? 'medium' : unanchored.reliability,
    warnings:[...new Set([...(unanchored.warnings || []), ...anchorWarnings])],
    structure_anchor:{
      ...(unanchored.structure_anchor || {}),
      requested_time_utc_msc:requestedTrustedAnchorTime,
      requested_core_stable_id:requestedAnchorCoreStableId,
      requested_entry_segment_stable_id:requestedAnchorEntryStableId,
      requested_last_confirmed_segment_time_utc_msc:normalizedRequestedAnchorLastConfirmedTime,
      matched:false,
      time_matched:diagnostics.time_matched === true,
      identity_matched:diagnostics.identity_matched === true,
      last_confirmed_segment_not_regressed:diagnostics.last_confirmed_segment_not_regressed === true,
    },
  })
  const anchorOutsideClosedWindow = hasTrustedAnchor
    && Number.isFinite(closedCalculationStartUtcMs)
    && requestedTrustedAnchorTime < closedCalculationStartUtcMs
  const anchorAfterClosedWindow = hasTrustedAnchor
    && Number.isFinite(closedCalculationEndUtcMs)
    && requestedTrustedAnchorTime > closedCalculationEndUtcMs
  let effectiveCalculationOptions = calculationOptions
  let primary: ChanResult
  let trustedAnchorMatched = false
  if (anchorOutsideClosedWindow) {
    // A persisted anchor can legitimately age out of the bounded window. Do
    // not spend a calculation on an anchored slice that cannot contain it;
    // use the normal unanchored path and retain the requested identity as a
    // diagnostic only.
    effectiveCalculationOptions = unanchoredOptions
    const unanchored = computeChanWindow(calculationRates, timeframe, calculationMacdHist, unanchoredOptions)
    primary = applyAnchorFallbackDiagnostics(unanchored, ['structure_anchor_outside_window'])
  } else if (anchorAfterClosedWindow) {
    // A future anchor is invalid input. Calculate once without it so the
    // result remains structurally inspectable, then fail closed before any
    // unanchored evidence can be promoted as authoritative.
    effectiveCalculationOptions = unanchoredOptions
    const unanchored = computeChanWindow(calculationRates, timeframe, calculationMacdHist, unanchoredOptions)
    const failedClosed = suppressUnconfirmedWindowStructure(unanchored)
    primary = applyAnchorFallbackDiagnostics(failedClosed, ['structure_anchor_future'])
    return updateChanResultInPlace(primary, {
      status:primary.status === 'ok' ? 'partial' : primary.status,
      reliability:'low',
      window_stable:false,
      structure_topology_reliable:false,
      authoritative_terminal_chain_confirmed:false,
      evidence_capabilities:buildChanEvidenceCapabilities(primary, {
        segment_direction_usable:false,
        center_structure_usable:false,
        entry_structure_usable:false,
        divergence_usable:false,
        reason_codes:['structure_anchor_future'],
      }),
      source_history_count:sourceHistoryCount,
      calculation_window_count:calculationWindowCount,
      maximum_history_count:maximumHistoryCount,
      validation_window_counts:validationWindowCounts,
      window_policy_version:windowPolicyVersion,
      window_selection:'full_window_unresolved',
    })
  } else {
    primary = computeChanWindow(calculationRates, timeframe, calculationMacdHist, calculationOptions)
    trustedAnchorMatched = hasTrustedAnchor && primary.structure_anchor?.matched === true
    if (hasTrustedAnchor && !trustedAnchorMatched) {
      const failedAnchorDiagnostics = primary.structure_anchor || {}
      const anchorWarnings = (primary.warnings || []).filter(item => item.startsWith('structure_anchor_'))
      effectiveCalculationOptions = unanchoredOptions
      const unanchored = computeChanWindow(calculationRates, timeframe, calculationMacdHist, unanchoredOptions)
      primary = applyAnchorFallbackDiagnostics(unanchored, anchorWarnings, {
        time_matched:failedAnchorDiagnostics.time_matched,
        identity_matched:failedAnchorDiagnostics.identity_matched,
        last_confirmed_segment_not_regressed:failedAnchorDiagnostics.last_confirmed_segment_not_regressed,
      })
      trustedAnchorMatched = false
    }
  }
  if (trustedAnchorMatched || options.fractalsForTest || !Array.isArray(calculationRates)) {
    const authoritativeTerminalChainConfirmed = trustedAnchorMatched
      && Number(primary.segment_count) >= 2
    return updateChanResultInPlace(primary, {
      authoritative_terminal_chain_confirmed: authoritativeTerminalChainConfirmed,
      evidence_capabilities:buildChanEvidenceCapabilities({
        ...primary,
        authoritative_terminal_chain_confirmed:authoritativeTerminalChainConfirmed,
      }),
      source_history_count:sourceHistoryCount,
      calculation_window_count:calculationWindowCount,
      maximum_history_count:maximumHistoryCount,
      validation_window_counts:validationWindowCounts,
      window_policy_version:windowPolicyVersion,
      window_selection:trustedAnchorMatched ? 'trusted_anchor' : 'full_window',
    })
  }
  if (calculationWindowCount < 300) {
    const protectedResult = protectUnanchoredShortHistory(primary, sourceHistoryCount, calculationWindowCount)
    return updateChanResultInPlace(protectedResult, {
      maximum_history_count:maximumHistoryCount,
      validation_window_counts:validationWindowCounts,
      window_policy_version:windowPolicyVersion,
    })
  }
  const sizes = candidateWindowCounts(validationWindowCounts, calculationWindowCount)
  const candidates = sizes.map(size => {
    if (size === calculationWindowCount) return primary
    const windowRates = calculationRates.slice(-size)
    const windowMacd = calculateMacdSeries(windowRates.map(rate => Number(rate.close))).histSeries
      return computeChanWindow(windowRates, timeframe, windowMacd, { ...effectiveCalculationOptions, requestedHistoryCount: size })
  })
  const selected = selectStableChanResult(candidates, {
    authoritativeCandidate:primary,
    minimumCenterContextBars:CHAN_CENTER_MIN_CONTEXT_BARS,
  })
  if (!selected) {
    const suppressedResult = suppressUnconfirmedWindowStructure(primary)
    return updateChanResultInPlace(suppressedResult, {
      source_history_count:sourceHistoryCount,
      calculation_window_count:calculationWindowCount,
      maximum_history_count:maximumHistoryCount,
      validation_window_counts:validationWindowCounts,
      window_policy_version:windowPolicyVersion,
      window_selection: 'full_window_unresolved',
    })
  }
  const temporalEvidence = buildFullWindowTemporalEvidence(calculationRates, timeframe, effectiveCalculationOptions, primary)
  const crossWindowBootstrap = evaluateCrossWindowBootstrapEvidence(
    candidates, primary, temporalEvidence, CHAN_CENTER_MIN_CONTEXT_BARS)
  const primaryStructureTimeKeyReliable = primary.structure_time_key_reliable === true
    || (primary.structure_time_key_reliable == null && primary.time_location_reliable === true)
  const promotionHistoryReady = calculationWindowCount >= maximumHistoryCount
    && primary.history_sufficient === true
    && primary.closed_history_sufficient === true
    && primaryStructureTimeKeyReliable
    && primary.cache_internal_gap_unresolved !== true
    && primary.reliability !== 'low'
  const promotionReady = promotionHistoryReady
    && selected.authoritative_terminal_chain_confirmed === true
    && temporalEvidence.temporal_identity_stable === true
    && crossWindowBootstrap.stable
  // A fully cross-confirmed unanchored calculation may publish entry-dependent
  // evidence immediately. Persisting the same boundary still gives later
  // cycles a trusted continuity anchor, but a second scheduler cycle is not an
  // extra eligibility gate once the full-window, temporal and entry identities
  // have already converged in this calculation.
  const recommendedAnchorTime = promotionReady
    ? Number(temporalEvidence.temporal_entry_start_time_utc_msc) || null : null
  const bootstrapCandidate = Boolean(promotionReady
    && Number(recommendedAnchorTime) > 0
    && temporalEvidence.temporal_core_stable_id
    && temporalEvidence.temporal_entry_segment_stable_id)
  const bootstrapUsableNow = bootstrapCandidate
  const anchorUnavailableReason = bootstrapUsableNow
    ? null : resolveUnanchoredStructureReason(selected)
  const bootstrapWarning = anchorUnavailableReason ? [anchorUnavailableReason] : []
  const warnings = [...new Set([...(selected.warnings || []), ...bootstrapWarning])]
  const reliability = !bootstrapUsableNow && selected.reliability === 'high' ? 'medium' : selected.reliability
  const protectedEvidence = protectBootstrapDependentEvidence(selected, bootstrapUsableNow, reliability, anchorUnavailableReason)
  return updateChanResultInPlace(selected, {
    status:warnings.length > 0 ? 'partial' : selected.status,
    reliability,
    warnings,
    temporal_identity_stable:temporalEvidence.temporal_identity_stable,
    temporal_closed_bar_support:temporalEvidence.temporal_closed_bar_support,
    temporal_closed_bar_validator_count:temporalEvidence.temporal_closed_bar_validator_count,
    cross_window_entry_support_count:crossWindowBootstrap.supportCount,
    cross_window_entry_validator_count:crossWindowBootstrap.validatorCount,
    ...protectedEvidence,
    structure_anchor:{
      ...(selected.structure_anchor || {}),
      requested_time_utc_msc:primary.structure_anchor?.requested_time_utc_msc ?? null,
      matched:false,
      recommended_time_utc_msc:recommendedAnchorTime,
      full_window_authoritative:true,
      temporal_identity_stable:temporalEvidence.temporal_identity_stable,
      temporal_closed_bar_support:temporalEvidence.temporal_closed_bar_support,
      temporal_closed_bar_validator_count:temporalEvidence.temporal_closed_bar_validator_count,
      cross_window_entry_support_count:crossWindowBootstrap.supportCount,
      cross_window_entry_validator_count:crossWindowBootstrap.validatorCount,
      bootstrap_identity:bootstrapCandidate ? JSON.stringify({
        core_stable_id:temporalEvidence.temporal_core_stable_id,
        entry_segment_stable_id:temporalEvidence.temporal_entry_segment_stable_id,
      }) : null,
      bootstrap_core_stable_id:bootstrapCandidate ? temporalEvidence.temporal_core_stable_id : null,
      bootstrap_entry_segment_stable_id:bootstrapCandidate ? temporalEvidence.temporal_entry_segment_stable_id : null,
      bootstrap_entry_start_time_utc_msc:bootstrapCandidate
        ? temporalEvidence.temporal_entry_start_time_utc_msc : null,
      bootstrap_observation_time_utc_msc:Number(primary.structure_anchor?.bootstrap_observation_time_utc_msc) || null,
      bootstrap_state:bootstrapCandidate ? 'confirmed'
        : selected.latest_center ? 'unconfirmed' : 'unavailable',
      current_result_usable:bootstrapUsableNow,
    },
    source_history_count:sourceHistoryCount,
    calculation_window_count: selected.raw_bar_count,
    maximum_history_count:maximumHistoryCount,
    validation_window_counts:validationWindowCounts,
    window_policy_version:windowPolicyVersion,
    window_selection: 'full_window_cross_confirmed',
  })
}

function candidateWindowCounts(validationWindowCounts: readonly number[], calculationWindowCount: number) {
  const sizes = validationWindowCounts.filter(size => size <= calculationWindowCount)
  // The actual full calculation is always the authoritative candidate. A
  // live source can be one closed bar short of its target; omitting that 1799
  // (or equivalent) candidate made cross-window selection impossible because
  // no supported group could contain the authoritative result.
  if (!sizes.includes(calculationWindowCount)) sizes.push(calculationWindowCount)
  return sizes.sort((a, b) => a - b)
}

export const __computeChanTest = { candidateWindowCounts }
