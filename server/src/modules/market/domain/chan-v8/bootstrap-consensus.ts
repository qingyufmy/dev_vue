import { windowHasEvidenceContext, type WindowEvidence } from './window-evidence.js'
import { confirmedCenterEvidence, centerCoreStableIds } from './center-consensus-evidence.js'

export function centerBootstrapIdentity(candidate: WindowEvidence | null | undefined) {
  const center = candidate?.latest_center || null
  const coreStableId = center?.core_stable_id || null
  const entryStableId = center?.entry_segment_stable_id || null
  const entryStartUtcMs = Number(center?.entry_segment_start_time_utc_msc)
  if (!coreStableId || !entryStableId || !Number.isFinite(entryStartUtcMs) || entryStartUtcMs <= 0) return null
  return {
    key:JSON.stringify({ core_stable_id:coreStableId, entry_segment_stable_id:entryStableId }),
    coreStableId,
    entryStableId,
    entryStartUtcMs,
  }
}

export function summarizeTemporalBootstrapEvidence(snapshots: readonly (WindowEvidence | null)[] = []) {
  const validatorCount = snapshots.length
  const valid = snapshots.map(candidate => {
    const identity = centerBootstrapIdentity(candidate)
    const observationUtcMs = Number(candidate?.structure_anchor?.bootstrap_observation_time_utc_msc
      || candidate?.window_end_time_utc_msc)
    const stableStructureTimeKey = candidate?.structure_time_key_reliable === true
      || (candidate?.structure_time_key_reliable == null && candidate?.time_location_reliable === true)
    const reliable = candidate?.window_stable === true
      && stableStructureTimeKey
      && candidate?.history_sufficient !== false
      && candidate?.closed_history_sufficient !== false
      && candidate?.cache_internal_gap_unresolved !== true
      && candidate?.reliability !== 'low'
      && Number.isFinite(observationUtcMs) && observationUtcMs > 0
    return reliable && identity ? { candidate, identity, observationUtcMs } : null
  }).filter((value): value is NonNullable<typeof value> => Boolean(value))
  const groups = new Map<string, typeof valid>()
  for (const item of valid) {
    const group = groups.get(item.identity.key) || []
    group.push(item)
    groups.set(item.identity.key, group)
  }
  const winner = [...groups.values()].sort((a, b) => b.length - a.length)[0] || []
  const observations = new Set(winner.map(item => item.observationUtcMs))
  const stable = validatorCount === 3 && winner.length === 3 && observations.size === 3
  const identity = stable ? winner[0]!.identity : null
  return {
    full_window_authoritative:true,
    temporal_identity_stable:stable,
    temporal_closed_bar_support:winner.length,
    temporal_closed_bar_validator_count:validatorCount,
    temporal_core_stable_id:identity?.coreStableId || null,
    temporal_entry_segment_stable_id:identity?.entryStableId || null,
    temporal_entry_start_time_utc_msc:identity?.entryStartUtcMs || null,
    temporal_observation_times_utc_msc:[...observations].sort((a, b) => a - b),
  }
}

export function evaluateCrossWindowBootstrapEvidence(candidates: readonly WindowEvidence[], authoritativeCandidate: WindowEvidence | null, temporalEvidence: ReturnType<typeof summarizeTemporalBootstrapEvidence> | null, minimumContextBars = 0) {
  const entryStartUtcMs = Number(temporalEvidence?.temporal_entry_start_time_utc_msc)
  const coreStableId = temporalEvidence?.temporal_core_stable_id || null
  const entryStableId = temporalEvidence?.temporal_entry_segment_stable_id || null
  if (temporalEvidence?.temporal_identity_stable !== true || !coreStableId || !entryStableId
    || !Number.isFinite(entryStartUtcMs) || entryStartUtcMs <= 0) {
    return { stable:false, supportCount:0, validatorCount:0 }
  }
  const authoritativeIdentity = centerBootstrapIdentity(authoritativeCandidate)
  if (authoritativeIdentity?.coreStableId !== coreStableId || authoritativeIdentity?.entryStableId !== entryStableId) {
    return { stable:false, supportCount:0, validatorCount:0 }
  }
  const eligible = candidates.filter(candidate => (
    windowHasEvidenceContext(candidate, entryStartUtcMs, minimumContextBars)))
  const supporters = eligible.filter(candidate => confirmedCenterEvidence(candidate).some(center => (
    (center?.core_stable_id || centerCoreStableIds(center, candidate).join('|')) === coreStableId
      && center?.entry_segment_stable_id === entryStableId
  )))
  return {
    stable:supporters.length >= 2 && supporters.length * 2 > eligible.length,
    supportCount:supporters.length,
    validatorCount:eligible.length,
  }
}
