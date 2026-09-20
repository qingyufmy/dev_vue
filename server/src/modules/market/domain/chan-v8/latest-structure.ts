import type { ChanFractal, ChanBar, ChanRate } from './types.js'
import { inspectActivePivotLifecycle, type buildDevelopingBi } from './pivot-lifecycle.js'
import { summarizeBi, summarizeLatestConfirmedFractal, type BiSummaryInput } from './bi-summary.js'
import type { summarizeSegment, summarizeSegmentCandidate } from './segment-summary.js'
interface LatestStructureInput {
  fractals: readonly ChanFractal[]
  activePivot?: ChanFractal | null
  activePivotLifecycle?: ReturnType<typeof inspectActivePivotLifecycle> | null
  normalizedBars: readonly ChanBar[]
  rates: readonly ChanRate[]
  currentBi: BiSummaryInput | null
  developingBi: ReturnType<typeof buildDevelopingBi>
  currentSegment: ReturnType<typeof summarizeSegment>
  candidateSegment: ReturnType<typeof summarizeSegmentCandidate>
}

export function buildLatestChanStructure({ fractals, activePivot = null, activePivotLifecycle = null, normalizedBars, rates,
  currentBi, developingBi, currentSegment, candidateSegment }: LatestStructureInput) {
  // The latest raw fractal can be too close to the previous pivot to form a
  // legal bi. Current structure must follow the pivot accepted by buildBis,
  // otherwise the reported fractal can contradict current_bi/developing_bi.
  const effectiveActivePivot = activePivot || (Array.isArray(fractals) ? fractals.at(-1) : null)
  const pivotLifecycle = activePivotLifecycle || inspectActivePivotLifecycle(effectiveActivePivot, rates)
  const latestFractalBase = summarizeLatestConfirmedFractal(
    effectiveActivePivot ? [effectiveActivePivot] : fractals, normalizedBars, rates)
  const latestFractal = latestFractalBase ? {
    ...latestFractalBase,
    active_for_developing_bi:pivotLifecycle.state === 'active',
  } : null
  const confirmedDirection = ['up', 'down'].includes(currentBi?.dir ?? '') ? currentBi!.dir : null
  const developingDirection = pivotLifecycle.state === 'active' && ['up', 'down'].includes(developingBi?.dir ?? '')
    ? developingBi!.dir : null
  const reversalWatch = Boolean(confirmedDirection && developingDirection && confirmedDirection !== developingDirection)
  const localBias = reversalWatch ? developingDirection : confirmedDirection || developingDirection || 'neutral'
  const directionBasis = reversalWatch ? 'developing_bi'
    : confirmedDirection && pivotLifecycle.state === 'origin_breached' ? 'confirmed_bi_continuation'
      : confirmedDirection ? 'confirmed_bi' : developingDirection ? 'developing_bi' : 'unavailable'
  const currentBiId = Number(currentBi?.id)
  const candidateConnected = candidateSegment?.active_for_current_state === true
    && Number(candidateSegment?.last_included_bi_id) === currentBiId
  const confirmedSegmentConnected = currentSegment?.confirmed === true
    && Number(currentSegment?.last_included_bi_id) === currentBiId
  const activeSegment = candidateConnected
    ? candidateSegment
    : confirmedSegmentConnected ? currentSegment : null
  const latestRateUtcMs = Number(rates?.at?.(-1)?.time_utc_msc)
  const basis = []
  if (latestFractal) basis.push(`latest_confirmed_${latestFractal.type}_fractal`)
  if (confirmedDirection) basis.push(`latest_confirmed_${confirmedDirection}_bi`)
  if (developingDirection) basis.push(`developing_${developingDirection}_bi`)
  if (pivotLifecycle.state === 'origin_breached') basis.push('active_pivot_origin_breached')
  if (candidateSegment?.lifecycle_state === 'invalidated') basis.push('historical_candidate_retired')
  return {
    as_of_time_utc_msc:Number.isFinite(latestRateUtcMs) ? latestRateUtcMs : null,
    latest_confirmed_fractal:latestFractal,
    latest_confirmed_bi:summarizeBi(currentBi, rates),
    developing_bi:developingDirection && developingBi ? { ...developingBi } : null,
    active_segment:activeSegment ? {
      stable_id:activeSegment.stable_id ?? null,
      dir:activeSegment.dir,
      lifecycle_state:activeSegment.lifecycle_state,
      confirmed:activeSegment.confirmed === true,
      connected_to_latest_bi:true,
      start_price:activeSegment.start_price,
      end_price:activeSegment.end_price,
      last_included_bi_id:activeSegment.last_included_bi_id ?? null,
    } : null,
    local_state:reversalWatch ? 'reversal_watch'
      : confirmedDirection || developingDirection ? 'continuation' : 'unavailable',
    local_bias:localBias,
    confirmed_direction:confirmedDirection || 'neutral',
    developing_direction:developingDirection || 'neutral',
    active_pivot_state:pivotLifecycle.state,
    direction_basis:directionBasis,
    pivot_breach_price:pivotLifecycle.breach_price,
    pivot_breach_time:pivotLifecycle.breach_time,
    pivot_breach_time_utc_msc:pivotLifecycle.breach_time_utc_msc,
    continuation_extreme_price:pivotLifecycle.continuation_extreme_price,
    continuation_extreme_time:pivotLifecycle.continuation_extreme_time,
    continuation_extreme_time_utc_msc:pivotLifecycle.continuation_extreme_time_utc_msc,
    background_bias:'neutral',
    historical_context_used_for_direction:false,
    basis,
  }
}
