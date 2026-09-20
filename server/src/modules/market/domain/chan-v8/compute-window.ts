import type { ChanResult } from './chan-result.js'
import type { ChanRate, ChanFractal, ChanSegment } from './types.js'
import type { DivergenceResult } from './divergence-result.js'
import { divergenceResult as emptyDivergence } from './divergence-result.js'
import { normalizeBarsForChan, detectFractals } from './bars.js'
import { buildBis } from './bis.js'
import { inspectActivePivotLifecycle, buildDevelopingBi } from './pivot-lifecycle.js'
import { summarizeBi } from './bi-summary.js'
import { buildLatestChanStructure } from './latest-structure.js'
import { buildSegments } from './segments.js'
import { buildCenters } from './centers.js'
import { detectDivergence, detectDivergenceHistory } from './divergence.js'
import { buildFormingSegment, detectFormingDivergence } from './forming-divergence.js'
import { summarizeSegmentCandidate, summarizeSegment } from './segment-summary.js'
import { summarizeCenter, summarizeBiCenter } from './center-summary.js'
import { classifyChanTrend, prioritizeLatestChanStructure } from './trend.js'
import { detectChanEntryCandidates } from './entry-candidates.js'
import { buildChanEvidenceCapabilities } from './evidence-capabilities.js'
import { emptyChanResult } from './empty-result.js'
import { round3, round5 } from './rounding.js'
interface WindowRate extends ChanRate { clock_status?: string; platform?: string }
export interface ChanWindowOptions {
  requestedHistoryCount?: number
  dataQuality?: Record<string, unknown> | null
  fractalsForTest?: ChanFractal[]
  trustedStructureAnchor?: { anchor_time_utc_msc?: number; bootstrap_core_stable_id?: string; bootstrap_entry_segment_stable_id?: string; last_confirmed_segment_time_utc_msc?: number } | null
  trustedStructureAnchorUtcMs?: number | null
}
const MIN_KLINES_FOR_CHAN = 30, MIN_BIS_PER_SEGMENT = 3, FEED_LAST_N_BIS = 6, FEED_LAST_N_DIVERGENCES = 6
const MT4_CLOCK_SAMPLE_MAX_AGE_MS = 5 * 60 * 1000
const CHAN_ALGORITHM_VERSION = 'chan_structure_v8', CHAN_RULE_PROFILE = 'new_bi_feature_sequence_quorum_latest_active'

export function computeChanWindow(rates: readonly WindowRate[], timeframe: string, macdHist: readonly number[], options: ChanWindowOptions = {}): ChanResult {
  const warnings = []
  const dataQuality = options.dataQuality && typeof options.dataQuality === 'object' ? options.dataQuality : null
  const requestedHistoryCount = Number(options.requestedHistoryCount) || rates?.length || 0
  const historySufficient = Array.isArray(rates) && rates.length >= requestedHistoryCount
  if (!historySufficient) warnings.push('history_bars_below_requested')
  const lastBarClosed = dataQuality?.last_bar_closed === true
  const closedRates = Array.isArray(rates) ? (lastBarClosed ? rates : rates.slice(0, -1)) : []
  const latest = parseFloat(String(closedRates.at(-1)?.close))
  const windowStartTimeUtcMs = Number(closedRates[0]?.time_utc_msc || rates?.[0]?.time_utc_msc) || null
  const windowEndTimeUtcMs = Number(closedRates.at(-1)?.time_utc_msc || rates?.at?.(-1)?.time_utc_msc) || null
  const requestedClosedHistoryCount = Math.max(requestedHistoryCount - (lastBarClosed ? 0 : 1), 0)
  const closedHistorySufficient = closedRates.length >= requestedClosedHistoryCount
  if (!closedHistorySufficient && historySufficient) warnings.push('closed_history_bars_below_requested')
  const utcTimes = closedRates.map(rate => Number(rate?.time_utc_msc))
  const utcLocationComplete = closedRates.length > 0 && utcTimes.every(value => Number.isFinite(value) && value > 0)
  const utcSequenceMonotonic = utcLocationComplete && utcTimes.every((value, index) => index === 0 || value > utcTimes[index - 1]!)
  const clockStatus = String(dataQuality?.clock_status || rates?.at?.(-1)?.clock_status || 'unknown')
  const platform = String(dataQuality?.platform || rates?.at?.(-1)?.platform || '').trim().toLowerCase()
  const sourceId = Number(dataQuality?.source_id)
  const timezoneOffsetMinutes = Number(dataQuality?.timezone_offset_minutes)
  const clockSampleAgeMs = Number(dataQuality?.clock_sample_age_ms)
  const sourceIdentityReliable = dataQuality == null || (
    Number.isInteger(sourceId) && sourceId > 0 && (platform === 'mt4' || platform === 'mt5'))
  const mt4OffsetValid = Number.isInteger(timezoneOffsetMinutes)
    && timezoneOffsetMinutes >= -14 * 60 && timezoneOffsetMinutes <= 14 * 60
    && timezoneOffsetMinutes % 15 === 0
  const mt4ClockFresh = clockStatus === 'mt4_current_offset'
    && Number.isFinite(clockSampleAgeMs) && clockSampleAgeMs >= 0
    && clockSampleAgeMs <= MT4_CLOCK_SAMPLE_MAX_AGE_MS
  const mt4HistoricalOffsetUnverified = platform === 'mt4'
    && (clockStatus === 'mt4_current_offset' || clockStatus === 'mt4_cached_offset')
  const clockStatusTrusted = clockStatus === 'verified'
  const clockTrustLevel = clockStatus === 'verified'
    ? 'verified'
    : mt4HistoricalOffsetUnverified ? 'derived_unverified_history' : 'untrusted'
  const timeLocationReliable = dataQuality == null || (sourceIdentityReliable
    && clockStatusTrusted && utcLocationComplete && utcSequenceMonotonic)
  // MT4 only exposes historical broker-server timestamps.  Applying the
  // current server offset cannot prove an old candle's exact UTC instant
  // across a DST boundary, but it is still a deterministic structure key
  // while the market-data source remains scoped by account/server/offset.
  // Keep that weaker guarantee separate from time_location_reliable so price
  // structure can bootstrap without presenting an approximate UTC as exact.
  const mt4OffsetScopedStructureKey = platform === 'mt4' && sourceIdentityReliable
    && mt4OffsetValid && mt4ClockFresh && utcLocationComplete && utcSequenceMonotonic
  const structureTimeKeyReliable = dataQuality == null
    || (sourceIdentityReliable && utcLocationComplete && utcSequenceMonotonic
      && (clockStatusTrusted || mt4OffsetScopedStructureKey))
  const structureTimeKeyBasis = dataQuality == null || clockStatus === 'verified'
    ? 'utc_verified'
    : mt4OffsetScopedStructureKey ? 'mt4_current_offset_source_scoped' : 'untrusted'
  if (dataQuality && !clockStatusTrusted) warnings.push('market_clock_unverified')
  if (dataQuality && mt4HistoricalOffsetUnverified) warnings.push('mt4_historical_offset_unverified')
  if (dataQuality && !utcLocationComplete) warnings.push('utc_time_location_incomplete')
  if (dataQuality && utcLocationComplete && !utcSequenceMonotonic) warnings.push('utc_time_sequence_invalid')
  const cacheInternalGapUnresolved = Boolean(dataQuality?.cache_internal_gap_unresolved)
  if (cacheInternalGapUnresolved) warnings.push('cache_internal_gap_unresolved')
  const continuityStatus = String(dataQuality?.continuity_status || '').trim().toLowerCase()
  const continuityReason = dataQuality?.continuity_reason || null
  const continuityReasons = Array.isArray(dataQuality?.continuity_reasons)
    ? dataQuality.continuity_reasons.slice(0, 8) : []
  const unknownSessionGapCount = Number(dataQuality?.unknown_session_gap_count) || 0
  const continuityComplete = dataQuality == null || (
    dataQuality.continuity_complete !== false
      && unknownSessionGapCount === 0
      && !['suspicious_gap', 'unknown_session', 'policy_missing'].includes(continuityStatus)
      && (continuityStatus || continuityReasons.length === 0))
  if (!continuityComplete) warnings.push('continuity_incomplete')
  const closedMacdHist = Array.isArray(macdHist) ? macdHist.slice(0, closedRates.length) : []
  if (closedRates.length < MIN_KLINES_FOR_CHAN) {
    return emptyChanResult({
      status: 'insufficient_klines',
      timeframe,
      requested_history_count: requestedHistoryCount,
      received_history_count: rates?.length || 0,
      history_sufficient: historySufficient,
      requested_closed_history_count: requestedClosedHistoryCount,
      closed_history_sufficient: closedHistorySufficient,
      clock_status: clockStatus,
      clock_trust_level: clockTrustLevel,
      time_location_reliable: timeLocationReliable,
      absolute_time_location_reliable: timeLocationReliable,
      structure_time_key_reliable: structureTimeKeyReliable,
      structure_time_key_basis: structureTimeKeyBasis,
      cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
      cache_internal_gap_unresolved: cacheInternalGapUnresolved,
      continuity_complete: continuityComplete,
      continuity_status: continuityStatus || null,
      continuity_reason: continuityReason,
      continuity_reasons: continuityReasons,
      unknown_session_gap_count: unknownSessionGapCount,
      continuity_calendar_version: dataQuality?.continuity_calendar_version || null,
      expected_closures: Array.isArray(dataQuality?.expected_closures) ? dataQuality.expected_closures.slice(0, 8) : [],
      window_start_time_utc_msc: windowStartTimeUtcMs,
      window_end_time_utc_msc: windowEndTimeUtcMs,
      raw_bar_count: rates?.length || 0,
      latest_price: Number.isFinite(latest) ? round5(latest) : null,
      closed_bar_count: closedRates.length,
      divergence: emptyDivergence('insufficient_klines'),
      warnings: [...warnings, 'raw_bars_too_few'],
    })
  }
  const bars = normalizeBarsForChan(closedRates)
  if (bars.length < 10) warnings.push('processed_bars_too_few')
  const fractals = options.fractalsForTest || detectFractals(bars)
  const { bis: allBis, runs: biRuns, invalidCount, activeRunId, activePivot, lastDiscontinuity } = buildBis(fractals, bars)
  const confirmedBiRuns = biRuns
    .map(run => run.filter(b => b.confirmed !== false))
    .filter(run => run.length > 0)
  const activeConfirmedBis = confirmedBiRuns.find(run => run[0]?.run_id === activeRunId) || []
  const activePivotLifecycle = inspectActivePivotLifecycle(activePivot, closedRates)
  const developingBi = buildDevelopingBi(activePivot, closedRates, activePivotLifecycle)
  if (activeConfirmedBis.length < 3) {
    warnings.push('insufficient_confirmed_bis')
    const lastBi = activeConfirmedBis.at(-1) || null
    const insufficientResult = emptyChanResult({
      status: 'insufficient_bis',
      timeframe,
      requested_history_count: requestedHistoryCount,
      received_history_count: rates.length,
      history_sufficient: historySufficient,
      requested_closed_history_count: requestedClosedHistoryCount,
      closed_history_sufficient: closedHistorySufficient,
      clock_status: clockStatus,
      clock_trust_level: clockTrustLevel,
      time_location_reliable: timeLocationReliable,
      absolute_time_location_reliable: timeLocationReliable,
      structure_time_key_reliable: structureTimeKeyReliable,
      structure_time_key_basis: structureTimeKeyBasis,
      cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
      cache_internal_gap_unresolved: cacheInternalGapUnresolved,
      continuity_complete: continuityComplete,
      continuity_status: continuityStatus || null,
      continuity_reason: continuityReason,
      continuity_reasons: continuityReasons,
      unknown_session_gap_count: unknownSessionGapCount,
      continuity_calendar_version: dataQuality?.continuity_calendar_version || null,
      expected_closures: Array.isArray(dataQuality?.expected_closures) ? dataQuality.expected_closures.slice(0, 8) : [],
      window_start_time_utc_msc: windowStartTimeUtcMs,
      window_end_time_utc_msc: windowEndTimeUtcMs,
      raw_bar_count: rates.length,
      latest_price: Number.isFinite(latest) ? round5(latest) : null,
      closed_bar_count: closedRates.length,
      processed_bar_count: bars.length,
      fractal_count: fractals.length,
      bi_count: allBis.length,
      active_bi_count: activeConfirmedBis.length,
      bi_run_count: biRuns.length,
      active_bi_run_id: activeRunId,
      bi_discontinuity_count: invalidCount,
      last_bi_discontinuity: lastDiscontinuity,
      current_bi:summarizeBi(lastBi, closedRates),
      developing_bi: developingBi,
      recent_bis:activeConfirmedBis.slice(-FEED_LAST_N_BIS).map(bi => summarizeBi(bi, closedRates)),
      latest_structure:buildLatestChanStructure({
        fractals, activePivot, activePivotLifecycle, normalizedBars:bars, rates:closedRates,
        currentBi:lastBi, developingBi,
        currentSegment:null, candidateSegment:null,
      }),
      divergence: emptyDivergence('insufficient_bis'),
      warnings,
    })
    // A complete fixed window remains complete data even when the price
    // stream has not produced enough confirmed bis for higher structures.
    // Keep structural capability failures separate from data completeness.
    insufficientResult.evidence_capabilities = buildChanEvidenceCapabilities(insufficientResult)
    return insufficientResult
  }
  const trustedStructureAnchor = options.trustedStructureAnchor && typeof options.trustedStructureAnchor === 'object'
    ? options.trustedStructureAnchor : {}
  const requestedStructureAnchor = Number(
    trustedStructureAnchor.anchor_time_utc_msc ?? options.trustedStructureAnchorUtcMs)
  const requestedAnchorCoreStableId = String(trustedStructureAnchor.bootstrap_core_stable_id || '').trim()
  const requestedAnchorEntryStableId = String(trustedStructureAnchor.bootstrap_entry_segment_stable_id || '').trim()
  const requestedAnchorLastConfirmedTime = Number(trustedStructureAnchor.last_confirmed_segment_time_utc_msc)
  const requestedAnchorIdentityComplete = Boolean(requestedAnchorCoreStableId && requestedAnchorEntryStableId
    && Number.isFinite(requestedAnchorLastConfirmedTime) && requestedAnchorLastConfirmedTime > 0)
  const anchoredBiIndex = Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0
    ? activeConfirmedBis.findIndex(bi => Number(closedRates[Number(bi.raw_start_idx)]?.time_utc_msc) === requestedStructureAnchor)
    : -1
  const structureAnchorTimeMatched = anchoredBiIndex >= 0
  if (Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0 && !structureAnchorTimeMatched) {
    warnings.push('structure_anchor_not_found')
  }
  const segmentBis = structureAnchorTimeMatched ? activeConfirmedBis.slice(anchoredBiIndex) : activeConfirmedBis
  const {
    segments, candidate, resynced, stable: windowStable,
    supportCount: segmentSupportCount = 0,
    validatorCount: segmentValidatorCount = 0,
    supportRatio: segmentSupportRatio = 0,
    pairSupport: segmentPairSupport = [],
    historicalSegmentRuns = [],
  } = buildSegments(segmentBis, { trustedStart: structureAnchorTimeMatched })
  const windowResynced = structureAnchorTimeMatched || resynced
  if (!windowResynced) warnings.push('segment_window_not_resynced')
  else if (!windowStable) warnings.push('segment_window_unstable')
  else if (segmentValidatorCount > 0 && segmentSupportRatio < 1) warnings.push('segment_consensus_partial')
  const validSegs = segments.filter(s => !s.weak && s.bi_ids.length >= MIN_BIS_PER_SEGMENT)
  if (validSegs.length === 0) warnings.push('segments_not_confirmed')
  const centers = buildCenters(validSegs, {
    componentLevel:'segment',
    leadingSegmentIsEntry:structureAnchorTimeMatched,
  })
  const biCenters = buildCenters(activeConfirmedBis, { componentLevel: 'bi' })
  if (centers.length === 0) warnings.push('no_valid_center')
  const latestCenter = centers.length > 0 ? centers[centers.length - 1] : null
  const centerEntryUnconfirmed = Boolean(latestCenter && latestCenter.entry_segment_id == null)
  const centerEntryConfirmed = Boolean(latestCenter && latestCenter.entry_segment_id != null)
  if (centerEntryUnconfirmed) warnings.push('center_entry_unconfirmed')
  const lastSeg = validSegs.length > 0 ? validSegs[validSegs.length - 1] : null
  const lastBi = activeConfirmedBis.at(-1) || null
  const lastSegmentEndIndex = Number(lastSeg?.raw_end_idx)
  const confirmedStructureAgeBars = Number.isFinite(lastSegmentEndIndex)
    ? Math.max(0, closedRates.length - 1 - lastSegmentEndIndex)
    : null
  // A Chan segment may extend for an arbitrary number of bars until it is
  // broken by an opposite segment. Age is retained only as diagnostics; it
  // must not invalidate the current structure or its trend evidence.
  const activeCenter = latestCenter && latestCenter.status !== 'closed'
    && latest >= latestCenter.zl && latest <= latestCenter.zh ? latestCenter : null
  let priceVsCenter = 'none'
  if (latestCenter) {
    if (latest > latestCenter.zh) priceVsCenter = 'above'
    else if (latest < latestCenter.zl) priceVsCenter = 'below'
    else priceVsCenter = 'inside'
  }
  const divergence = {
    ...detectDivergence(validSegs, allBis, closedMacdHist, centers, closedRates),
    bi_run_id: activeRunId,
  }
  const historicalDivergenceMap = new Map<string, DivergenceResult & { bi_run_id: number | null }>()
  const currentRunDivergenceMap = new Map<string, DivergenceResult & { bi_run_id: number | null }>()
  const priorHistoricalSegmentRuns: ChanSegment[][] = []
  const recordHistoricalDivergence = (item: DivergenceResult, biRunId: number | null, currentRun = false) => {
    const tagged = { ...item, bi_run_id: biRunId }
    const key = tagged.divergence_key || `${tagged.type}:${tagged.departure_segment_id}:${tagged.departure_segment?.end_index}`
    historicalDivergenceMap.set(key, tagged)
    if (currentRun) currentRunDivergenceMap.set(key, tagged)
  }
  for (const runBis of confirmedBiRuns.filter(run => run !== activeConfirmedBis)) {
    const result = buildSegments(runBis, { trustedStart: false })
    if (!result.stable || result.segments.length < 2) continue
    priorHistoricalSegmentRuns.push(result.segments)
    const biRunId = runBis[0]?.run_id ?? null
    const runCenters = buildCenters(result.segments)
    for (const item of detectDivergenceHistory(result.segments, allBis, closedMacdHist, runCenters, closedRates)) {
      recordHistoricalDivergence(item, biRunId, false)
    }
  }
  for (const run of historicalSegmentRuns) {
    const runCenters = buildCenters(run)
    for (const item of detectDivergenceHistory(run, allBis, closedMacdHist, runCenters, closedRates)) {
      recordHistoricalDivergence(item, activeRunId, true)
    }
  }
  if (divergence.type === 'top' || divergence.type === 'bottom') {
    const key = divergence.divergence_key || `${divergence.type}:${divergence.departure_segment_id}:${divergence.departure_segment?.end_index}`
    historicalDivergenceMap.set(key, divergence)
    currentRunDivergenceMap.set(key, divergence)
  }
  const recentDivergences = [...historicalDivergenceMap.values()]
    .sort((a, b) => Number(a.departure_segment?.end_index || 0) - Number(b.departure_segment?.end_index || 0))
    .slice(-FEED_LAST_N_DIVERGENCES)
  const currentRunRecentDivergences = [...currentRunDivergenceMap.values()]
    .sort((a, b) => Number(a.departure_segment?.end_index || 0) - Number(b.departure_segment?.end_index || 0))
    .slice(-FEED_LAST_N_DIVERGENCES)
  const formingSegment = buildFormingSegment(candidate, allBis, (lastSeg?.id || 0) + 1)
  const candidateSegmentDiagnostic = summarizeSegmentCandidate(candidate, allBis, closedRates, (lastSeg?.id || 0) + 1)
  const candidateSegmentSummary = candidateSegmentDiagnostic?.active_for_current_state === false
    ? null : candidateSegmentDiagnostic
  const historicalCandidateSegment = candidateSegmentDiagnostic?.active_for_current_state === false
    ? candidateSegmentDiagnostic : null
  const formingDivergence = detectFormingDivergence(candidate, validSegs, allBis, closedMacdHist, centers, closedRates)
  if (divergence.type !== 'none') {
    // ok
  } else if (divergence.reason === 'invalid_macd_area' || divergence.reason === 'no_macd_data') {
    warnings.push('divergence_skipped_invalid_macd')
  }

  const lastSegmentRawIndex = Number(lastSeg?.raw_end_idx)
  const lastConfirmedSegmentTime = Number.isFinite(lastSegmentRawIndex)
    ? Number(closedRates[lastSegmentRawIndex]?.time_utc_msc) : null
  const confirmedSegmentSummaries = validSegs.map(segment => summarizeSegment(segment, allBis, closedRates))
  const confirmedCenterSummaries = centers.map(center => summarizeCenter(center, timeframe, validSegs, allBis, closedRates))
  const latestCenterSummary = confirmedCenterSummaries.at(-1) || null
  const requestedIdentityCenter = requestedAnchorIdentityComplete
    ? confirmedCenterSummaries.find(center => (
      center!.core_stable_id === requestedAnchorCoreStableId
      && center!.entry_segment_stable_id === requestedAnchorEntryStableId
      && Number(center!.entry_segment_start_time_utc_msc) === requestedStructureAnchor
    )) || null
    : null
  const structureAnchorIdentityMatched = Boolean(requestedIdentityCenter)
  const structureAnchorLastConfirmedNotRegressed = requestedAnchorIdentityComplete
    && Number.isFinite(lastConfirmedSegmentTime)
    && lastConfirmedSegmentTime! >= requestedAnchorLastConfirmedTime
  const structureAnchorMatched = structureAnchorTimeMatched
    && structureAnchorIdentityMatched && structureAnchorLastConfirmedNotRegressed
  if (Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0) {
    if (!requestedAnchorIdentityComplete) warnings.push('structure_anchor_identity_missing')
    else if (structureAnchorTimeMatched && !structureAnchorIdentityMatched) warnings.push('structure_anchor_identity_mismatch')
    else if (structureAnchorIdentityMatched && !structureAnchorLastConfirmedNotRegressed) {
      warnings.push('structure_anchor_last_segment_regressed')
    }
  }

  let reliability = 'low'
  if (cacheInternalGapUnresolved) reliability = 'low'
  else if (historySufficient && closedHistorySufficient && timeLocationReliable && validSegs.length >= 2 && centers.length > 0 && warnings.length === 0) reliability = 'high'
  else if (historySufficient && closedHistorySufficient && validSegs.length > 0) reliability = 'medium'

  let status = 'ok'
  if (validSegs.length === 0 && activeConfirmedBis.length >= 3) status = 'unreliable_segments'
  else if (validSegs.length > 0 && centers.length === 0) status = 'partial'
  else if (warnings.length > 0) status = 'partial'

  const latestStructureBase = buildLatestChanStructure({
    fractals,
    activePivot,
    activePivotLifecycle,
    normalizedBars:bars,
    rates:closedRates,
    currentBi:lastBi,
    developingBi,
    currentSegment:confirmedSegmentSummaries.at(-1) || null,
    candidateSegment:candidateSegmentDiagnostic,
  })
  const backgroundTrendState = classifyChanTrend(
    validSegs, centers, latest, divergence, reliability, formingSegment)
  const prioritizedStructure = prioritizeLatestChanStructure(
    backgroundTrendState, latestStructureBase, reliability)
  const trendState = prioritizedStructure.trend_state
  const latestStructure = prioritizedStructure.latest_structure
  const entryCandidates = detectChanEntryCandidates(validSegs, centers, divergence, currentRunRecentDivergences,
    allBis, closedRates, reliability, structureTimeKeyReliable, activeRunId)
  const entrySegment = latestCenter ? validSegs.find(segment => segment.id === latestCenter.entry_segment_id) || null : null
  const anchorRawIndex = Number(entrySegment?.raw_start_idx)
  const recommendedAnchorTime = centerEntryConfirmed && windowStable && structureTimeKeyReliable
    && !cacheInternalGapUnresolved && Number.isFinite(anchorRawIndex)
    ? Number(closedRates[anchorRawIndex]?.time_utc_msc) : null
  const bootstrapIdentity = latestCenterSummary?.core_stable_id && latestCenterSummary?.entry_segment_stable_id
    ? JSON.stringify({
      core_stable_id:latestCenterSummary.core_stable_id,
      entry_segment_stable_id:latestCenterSummary.entry_segment_stable_id,
    })
    : null

  const result = {
    algorithm_version: CHAN_ALGORITHM_VERSION,
    rule_profile: CHAN_RULE_PROFILE,
    timeframe,
    center_level: 'segment',
    status, reliability,
    requested_history_count: requestedHistoryCount,
    received_history_count: rates.length,
    history_sufficient: historySufficient,
    requested_closed_history_count: requestedClosedHistoryCount,
    closed_history_sufficient: closedHistorySufficient,
    clock_status: clockStatus,
    clock_trust_level: clockTrustLevel,
    time_location_reliable: timeLocationReliable,
    absolute_time_location_reliable: timeLocationReliable,
    structure_time_key_reliable: structureTimeKeyReliable,
    structure_time_key_basis: structureTimeKeyBasis,
    structure_topology_reliable:Boolean(windowStable && structureTimeKeyReliable
      && continuityComplete
      && !cacheInternalGapUnresolved
      && validSegs.length >= 2 && centers.length > 0),
    cache_gap_refilled: Boolean(dataQuality?.cache_gap_refilled),
    cache_internal_gap_unresolved: cacheInternalGapUnresolved,
    continuity_complete: continuityComplete,
    continuity_status: continuityStatus || null,
    continuity_reason: continuityReason,
    continuity_reasons: continuityReasons,
    unknown_session_gap_count: unknownSessionGapCount,
    continuity_calendar_version: dataQuality?.continuity_calendar_version || null,
    expected_closures: Array.isArray(dataQuality?.expected_closures) ? dataQuality.expected_closures.slice(0, 8) : [],
    window_resynced: windowResynced,
    window_stable: windowStable,
    segment_support_count: segmentSupportCount,
    segment_validator_count: segmentValidatorCount,
    segment_support_ratio: round3(segmentSupportRatio),
    segment_pair_support: segmentPairSupport,
    structure_anchor: {
      requested_time_utc_msc: Number.isFinite(requestedStructureAnchor) && requestedStructureAnchor > 0 ? requestedStructureAnchor : null,
      matched: structureAnchorMatched,
      time_matched:structureAnchorTimeMatched,
      identity_matched:structureAnchorIdentityMatched,
      last_confirmed_segment_not_regressed:structureAnchorLastConfirmedNotRegressed,
      requested_core_stable_id:requestedAnchorCoreStableId || null,
      requested_entry_segment_stable_id:requestedAnchorEntryStableId || null,
      requested_last_confirmed_segment_time_utc_msc:Number.isFinite(requestedAnchorLastConfirmedTime)
        && requestedAnchorLastConfirmedTime > 0 ? requestedAnchorLastConfirmedTime : null,
      recommended_time_utc_msc: Number.isFinite(recommendedAnchorTime) && recommendedAnchorTime! > 0 ? recommendedAnchorTime : null,
      last_confirmed_segment_time_utc_msc: Number.isFinite(lastConfirmedSegmentTime) && lastConfirmedSegmentTime! > 0 ? lastConfirmedSegmentTime : null,
      bootstrap_identity: bootstrapIdentity,
      bootstrap_core_stable_id: latestCenterSummary?.core_stable_id || null,
      bootstrap_entry_segment_stable_id: latestCenterSummary?.entry_segment_stable_id || null,
      bootstrap_entry_start_time_utc_msc: Number(latestCenterSummary?.entry_segment_start_time_utc_msc) || null,
      bootstrap_observation_time_utc_msc: Number(windowEndTimeUtcMs) || null,
      full_window_authoritative: false,
      temporal_identity_stable: false,
      temporal_closed_bar_support: 0,
      temporal_closed_bar_validator_count: 0,
      bootstrap_state: bootstrapIdentity ? 'candidate' : 'unavailable',
      current_result_usable:structureAnchorMatched,
    },
    window_start_time_utc_msc: windowStartTimeUtcMs,
    window_end_time_utc_msc: windowEndTimeUtcMs,
    raw_bar_count: rates.length,
    latest_price: Number.isFinite(latest) ? round5(latest) : null,
    closed_bar_count: closedRates.length, processed_bar_count: bars.length,
    fractal_count: fractals.length,
    bi_count: allBis.length,
    active_bi_count: activeConfirmedBis.length,
    bi_run_count: biRuns.length,
    active_bi_run_id: activeRunId,
    bi_discontinuity_count: invalidCount,
    last_bi_discontinuity: lastDiscontinuity,
    segment_count: validSegs.length,
    center_count: centers.length,
    bi_center_count: biCenters.length,
    confirmed_structure_age_bars: confirmedStructureAgeBars,
    confirmed_structure_max_age_bars: null,
    confirmed_structure_age_semantics: 'diagnostic_only_no_expiry',
    historical_segment_run_count: priorHistoricalSegmentRuns.length + historicalSegmentRuns.length,
    historical_segment_count: [...priorHistoricalSegmentRuns, ...historicalSegmentRuns].reduce((sum, run) => sum + run.length, 0),
    current_bi:summarizeBi(lastBi, closedRates),
    developing_bi: developingBi,
    recent_bis:activeConfirmedBis.slice(-FEED_LAST_N_BIS).map(bi => summarizeBi(bi, closedRates)),
    current_segment: confirmedSegmentSummaries.at(-1)
      ? { ...confirmedSegmentSummaries.at(-1)!, structure_role:'latest_confirmed' } : null,
    prev_segment: confirmedSegmentSummaries.at(-2)
      ? { ...confirmedSegmentSummaries.at(-2)!, structure_role:'previous_confirmed' } : null,
    candidate_segment:candidateSegmentSummary,
    historical_candidate_segment:historicalCandidateSegment,
    current_center:confirmedCenterSummaries.at(-1) || null,
    active_center:activeCenter ? confirmedCenterSummaries.find(center => center!.id === activeCenter.id) || null : null,
    latest_center:confirmedCenterSummaries.at(-1) || null,
    latest_bi_center: summarizeBiCenter(biCenters.at(-1), timeframe, activeConfirmedBis, closedRates),
    price_vs_center: priceVsCenter,
    divergence,
    forming_divergence: formingDivergence,
    recent_divergences: recentDivergences,
    latest_structure:latestStructure,
    trend_state: trendState,
    entry_candidates: entryCandidates,
    warnings,
  }
  const completeResult = Object.assign(result, { evidence_capabilities: buildChanEvidenceCapabilities(result) })
  Object.defineProperty(completeResult, '_confirmed_segments', {
    value:confirmedSegmentSummaries,
    enumerable:false,
  })
  Object.defineProperty(completeResult, '_confirmed_centers', {
    value:confirmedCenterSummaries,
    enumerable:false,
  })
  Object.defineProperty(completeResult, '_closed_rate_times_utc_msc', {
    value:utcTimes,
    enumerable:false,
  })
  return completeResult
}
