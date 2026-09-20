import type { summarizeSegment } from './segment-summary.js'
import type { summarizeCenter } from './center-summary.js'
export type WindowSegment = NonNullable<ReturnType<typeof summarizeSegment>> & { structure_role?: string }
type CenterSummary = NonNullable<ReturnType<typeof summarizeCenter>>
export type WindowCenter = Omit<{ [K in keyof CenterSummary]?: CenterSummary[K] | null }, 'id' | 'zl' | 'zh' | 'status'> & { id: number | null; zl: number; zh: number; status: string }
export interface WindowEvidence {
  current_segment?: WindowSegment | null
  prev_segment?: WindowSegment | null
  latest_center?: WindowCenter | null
  structure_anchor?: { bootstrap_observation_time_utc_msc?: number | null }
  window_end_time_utc_msc?: number | null
  structure_time_key_reliable?: boolean
  time_location_reliable?: boolean
  history_sufficient?: boolean
  closed_history_sufficient?: boolean
  cache_internal_gap_unresolved?: boolean
  reliability?: string
  window_stable?: boolean
  segment_support_count?: number
  segment_count?: number
  raw_bar_count?: number
  window_start_time_utc_msc?: number | null
  _confirmed_segments?: readonly WindowSegment[]
  _confirmed_centers?: readonly WindowCenter[]
  _closed_rate_times_utc_msc?: readonly number[]
}

export function stableTerminalStructureKey(result: WindowEvidence | null | undefined) {
  const current = result?.current_segment?.stable_id
  const previous = result?.prev_segment?.stable_id
  const hasWithinWindowEvidence = result?.window_stable || Number(result?.segment_support_count) >= 1
  return hasWithinWindowEvidence && Number(result?.segment_count) >= 2 && current && previous ? `${previous}|${current}` : null
}

export function windowCanObserve(candidate: WindowEvidence | null | undefined, evidenceStartUtcMs: number | null) {
  const windowStart = Number(candidate?.window_start_time_utc_msc)
  const evidenceStart = Number(evidenceStartUtcMs)
  return !Number.isFinite(windowStart) || windowStart <= 0
    || !Number.isFinite(evidenceStart) || evidenceStart <= 0
    || windowStart <= evidenceStart
}

export function windowHasEvidenceContext(candidate: WindowEvidence | null | undefined, evidenceStartUtcMs: number | null, minimumBars = 0) {
  if (!windowCanObserve(candidate, evidenceStartUtcMs)) return false
  if (!(Number(minimumBars) > 0)) return true
  const times = Array.isArray(candidate?._closed_rate_times_utc_msc)
    ? candidate._closed_rate_times_utc_msc : []
  const evidenceStart = Number(evidenceStartUtcMs)
  if (!times.length || !Number.isFinite(evidenceStart) || evidenceStart <= 0) return false
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (Number(times[middle]) < evidenceStart) low = middle + 1
    else high = middle
  }
  return low >= Number(minimumBars)
}

export function terminalEvidenceStart(candidate: WindowEvidence | null | undefined) {
  const utcMs = Number(candidate?.prev_segment?.start_time_utc_msc)
  if (Number.isFinite(utcMs) && utcMs > 0) return utcMs
  const fallback = Number(candidate?.prev_segment?.start_time)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null
}

export function confirmedSegmentEvidence(candidate: WindowEvidence | null | undefined): readonly WindowSegment[] {
  if (Array.isArray(candidate?._confirmed_segments) && candidate._confirmed_segments.length > 0) {
    return candidate._confirmed_segments
  }
  return [candidate?.prev_segment, candidate?.current_segment].filter((value): value is WindowSegment => Boolean(value))
}
