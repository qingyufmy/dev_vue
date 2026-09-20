import type { segmentLocation } from './segment-location.js'

export interface DivergenceResult {
  reason: string
  type: string
  state: string
  confirmed: boolean
  segment_confirmed: boolean
  strength: string
  divergence_key: string | null
  category: string | null
  center_id: number | null
  entry_segment_id: number | null
  departure_segment_id: number | null
  divergence_class: string | null
  structure_class: string | null
  trend_confirmed: boolean
  qualified_for_reversal_watch: boolean
  zero_axis_reset: boolean
  zero_axis_tolerance: number | null
  center_dif_min_abs: number | null
  center_dea_min_abs: number | null
  entry_segment: ReturnType<typeof segmentLocation>
  departure_segment: ReturnType<typeof segmentLocation>
  area_cur: number
  area_prev: number
  peak_cur: number
  peak_prev: number
  dif_peak_cur: number
  dif_peak_prev: number
  dea_peak_cur: number
  dea_peak_prev: number
  dif_ratio: number | null
  dea_ratio: number | null
  area_ratio: number | null
  peak_ratio: number | null
  area_reduction_pct: number | null
  peak_reduction_pct: number | null
  price_extreme_cur: number
  price_extreme_prev: number
}
export const DETERMINISTIC_NO_DIVERGENCE_REASONS = new Set([
  'macd_no_divergence', 'no_price_extreme_break', 'not_after_center',
])

export function divergenceResult(reason: string, overrides: Partial<DivergenceResult> = {}): DivergenceResult {
  const hasConfirmedDirectionalEvidence = (overrides.type === 'top' || overrides.type === 'bottom')
    && overrides.confirmed === true
  const state = overrides.state === 'forming'
    ? 'forming'
    : DETERMINISTIC_NO_DIVERGENCE_REASONS.has(String(reason || ''))
      ? 'evaluated'
      : hasConfirmedDirectionalEvidence
        ? 'confirmed'
        : overrides.state === 'evaluated'
          ? 'evaluated'
          : 'unavailable'
  return {
    type: 'none', confirmed: false, segment_confirmed: false, strength: 'none', reason,
    divergence_key: null,
    category: null, center_id: null, entry_segment_id: null, departure_segment_id: null,
    divergence_class: null, structure_class: null, trend_confirmed: false,
    qualified_for_reversal_watch: false, zero_axis_reset: false,
    zero_axis_tolerance: null, center_dif_min_abs: null, center_dea_min_abs: null,
    entry_segment: null, departure_segment: null,
    area_cur: 0, area_prev: 0, peak_cur: 0, peak_prev: 0,
    dif_peak_cur: 0, dif_peak_prev: 0, dea_peak_cur: 0, dea_peak_prev: 0,
    dif_ratio: null, dea_ratio: null,
    area_ratio: null, peak_ratio: null, area_reduction_pct: null, peak_reduction_pct: null,
    price_extreme_cur: 0, price_extreme_prev: 0,
    ...overrides,
    state,
  }
}
