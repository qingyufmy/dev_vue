import type { EvidenceSegment } from './types.js'
import type { WindowCenter } from './window-evidence.js'
import type { DivergenceResult } from './divergence-result.js'
type TrendDivergence = Pick<DivergenceResult, 'type' | 'confirmed' | 'strength' | 'center_id' | 'departure_segment_id'>
import type { buildLatestChanStructure } from './latest-structure.js'
const MIN_BIS_PER_SEGMENT = 3
type TrendSegment = Pick<EvidenceSegment, 'id' | 'dir'> & { weak?: boolean; bi_ids?: number[]; bi_count?: number; end_price?: number }

export function emptyTrendState(reason = 'structure_unavailable') {
  return {
    state: 'unavailable',
    direction: 'neutral',
    local_bias: 'neutral',
    background_direction: 'neutral',
    phase: 'unknown',
    reversal_bias: 'none',
    confidence: 'low',
    reason,
    center_id: null,
    segment_id: null,
  }
}


export function capStructureConfidence(reliability: string, preferred = 'medium') {
  if (reliability === 'low') return 'low'
  if (reliability === 'high') return preferred
  return preferred === 'high' ? 'medium' : preferred
}

export function classifyChanTrendBackground(segments: readonly TrendSegment[], centers: readonly WindowCenter[], latestPrice: number | null, divergence: TrendDivergence | null, reliability = 'low', formingSegment: Pick<EvidenceSegment, 'dir'> & { id?: number } | null = null) {
  const validSegments = segments.filter(segment => !segment.weak && (
    (Array.isArray(segment.bi_ids) && segment.bi_ids.length >= MIN_BIS_PER_SEGMENT)
    || Number(segment.bi_count) >= MIN_BIS_PER_SEGMENT
  ))
  const latestSegment = validSegments.at(-1)
  const latestCenter = centers.at(-1)
  const formingDirection = ['up', 'down'].includes(formingSegment?.dir ?? '') ? formingSegment!.dir : null
  if (!latestSegment) return emptyTrendState('no_confirmed_segment')

  if (divergence?.confirmed && divergence.type === 'top') {
    return {
      state: 'upward_exhaustion', direction: 'up', phase: 'exhaustion', reversal_bias: 'down',
      confidence: capStructureConfidence(reliability, divergence.strength === 'strong' ? 'high' : 'medium'),
      reason: 'confirmed_top_divergence', center_id: divergence.center_id ?? latestCenter?.id ?? null,
      segment_id: divergence.departure_segment_id ?? latestSegment.id,
    }
  }
  if (divergence?.confirmed && divergence.type === 'bottom') {
    return {
      state: 'downward_exhaustion', direction: 'down', phase: 'exhaustion', reversal_bias: 'up',
      confidence: capStructureConfidence(reliability, divergence.strength === 'strong' ? 'high' : 'medium'),
      reason: 'confirmed_bottom_divergence', center_id: divergence.center_id ?? latestCenter?.id ?? null,
      segment_id: divergence.departure_segment_id ?? latestSegment.id,
    }
  }

  if (centers.length >= 2) {
    const previousCenter = centers.at(-2)
    if (latestCenter!.zl > previousCenter!.zh) {
      return {
        state: 'uptrend', direction: 'up', phase: 'trend', reversal_bias: 'none',
        confidence: capStructureConfidence(reliability, 'high'), reason: 'centers_rising_without_overlap',
        center_id: latestCenter!.id, segment_id: latestSegment.id,
      }
    }
    if (latestCenter!.zh < previousCenter!.zl) {
      return {
        state: 'downtrend', direction: 'down', phase: 'trend', reversal_bias: 'none',
        confidence: capStructureConfidence(reliability, 'high'), reason: 'centers_falling_without_overlap',
        center_id: latestCenter!.id, segment_id: latestSegment.id,
      }
    }
  }

  if (latestCenter) {
    const breakoutSegment = validSegments.find(segment => segment.id === latestCenter.closed_by_segment_id)
    const numericLatestPrice = Number(latestPrice)
    const priceKnown = latestPrice != null && Number.isFinite(numericLatestPrice)
    const priceAbove = priceKnown && numericLatestPrice > Number(latestCenter.zh)
    const priceBelow = priceKnown && numericLatestPrice < Number(latestCenter.zl)
    if (latestCenter.status === 'closed' && (priceAbove || priceBelow)) {
      const outsideDirection = priceAbove ? 'up' : 'down'
      const matchingClose = breakoutSegment?.dir === outsideDirection ? breakoutSegment : null
      const hasCloseId = latestCenter.closed_by_segment_id != null
      const closeId = Number(latestCenter.closed_by_segment_id)
      const confirmedRebreakout = hasCloseId && Number.isFinite(closeId)
        ? validSegments.filter(segment => Number(segment.id) > closeId
          && segment.dir === outsideDirection
          && (outsideDirection === 'up'
            ? Number(segment.end_price) > Number(latestCenter.zh)
            : Number(segment.end_price) < Number(latestCenter.zl))).at(-1)
        : null
      const confirmedBreakout = confirmedRebreakout || matchingClose
      if (confirmedBreakout) {
        return {
          state: outsideDirection === 'up' ? 'upward_breakout' : 'downward_breakout',
          direction: outsideDirection, phase: 'breakout', reversal_bias: 'none',
          confidence: capStructureConfidence(reliability),
          reason: confirmedRebreakout
            ? `price_${priceAbove ? 'above' : 'below'}_closed_center_after_confirmed_rebreakout`
            : `price_${priceAbove ? 'above' : 'below'}_closed_center`,
          center_id: latestCenter.id, segment_id: confirmedBreakout.id,
        }
      }
      return {
        state: priceAbove ? 'upward_breakout_pending' : 'downward_breakout_pending',
        direction: outsideDirection, phase: 'breakout_candidate', reversal_bias: 'none',
        confidence: 'low',
        reason: `price_${priceAbove ? 'above' : 'below'}_closed_center_without_confirmed_rebreakout`,
        center_id: latestCenter!.id, segment_id: latestSegment.id,
      }
    }
    if (latestCenter.status !== 'closed' && priceAbove) {
      return {
        state: 'upward_breakout_pending', direction: 'up', phase: 'breakout_candidate', reversal_bias: 'none',
        confidence: 'low', reason: 'price_above_unclosed_center',
        center_id: latestCenter!.id, segment_id: latestSegment.id,
      }
    }
    if (latestCenter.status !== 'closed' && priceBelow) {
      return {
        state: 'downward_breakout_pending', direction: 'down', phase: 'breakout_candidate', reversal_bias: 'none',
        confidence: 'low', reason: 'price_below_unclosed_center',
        center_id: latestCenter!.id, segment_id: latestSegment.id,
      }
    }
    return {
      state: 'consolidation', direction: 'neutral', phase: 'range', reversal_bias: 'none',
      confidence: capStructureConfidence(reliability), reason: latestCenter.status === 'closed' ? 'price_returned_to_center' : 'center_active',
      center_id: latestCenter.id, segment_id: latestSegment.id,
    }
  }

  if (formingDirection) {
    return {
      state: latestSegment.dir === 'up' ? 'structural_rise_transition' : 'structural_decline_transition',
      direction: latestSegment.dir === 'up' ? 'up' : 'down', phase: 'transition',
      reversal_bias: formingDirection === latestSegment.dir ? 'none' : formingDirection,
      confidence: 'low',
      reason: formingDirection === latestSegment.dir
        ? 'forming_segment_continues_confirmed_direction'
        : 'forming_opposite_segment_unconfirmed',
      center_id: null, segment_id: latestSegment.id,
      candidate_segment_id: formingSegment!.id ?? null,
      candidate_direction: formingDirection,
    }
  }

  return {
    state: latestSegment.dir === 'up' ? 'structural_rise' : 'structural_decline',
    direction: latestSegment.dir === 'up' ? 'up' : 'down',
    phase: 'structure', reversal_bias: 'none', confidence: 'low', reason: 'segments_without_center',
    center_id: null, segment_id: latestSegment.id,
  }
}

export function prioritizeLatestChanStructure(backgroundTrend: ReturnType<typeof classifyChanTrendBackground>, latestStructure: ReturnType<typeof buildLatestChanStructure> | null, reliability = 'low') {
  if (!latestStructure || typeof latestStructure !== 'object') {
    return { trend_state:backgroundTrend, latest_structure:latestStructure ?? null }
  }
  const backgroundDirection = ['up', 'down'].includes(backgroundTrend?.direction)
    ? backgroundTrend.direction : 'neutral'
  const confirmedDirection = ['up', 'down'].includes(latestStructure.confirmed_direction)
    ? latestStructure.confirmed_direction : null
  const activePivotState = String(latestStructure.active_pivot_state || '')
  const developingDirection = (!activePivotState || activePivotState === 'active')
    && ['up', 'down'].includes(latestStructure.developing_direction)
    ? latestStructure.developing_direction : null
  const updatedLatestStructure = {
    ...latestStructure,
    background_bias:backgroundDirection,
  }
  if (!confirmedDirection) {
    return {
      trend_state:{ ...backgroundTrend, background_direction:backgroundDirection,
        local_bias:latestStructure.local_bias || 'neutral' },
      latest_structure:updatedLatestStructure,
    }
  }
  if (developingDirection && developingDirection !== confirmedDirection) {
    const fractalType = latestStructure.latest_confirmed_fractal?.type
    return {
      trend_state:{
        ...backgroundTrend,
        state:confirmedDirection === 'up' ? 'up_reversal_watch' : 'down_reversal_watch',
        direction:confirmedDirection,
        local_bias:developingDirection,
        background_direction:backgroundDirection,
        phase:'transition',
        reversal_bias:developingDirection,
        confidence:'low',
        reason:fractalType
          ? `latest_confirmed_${fractalType}_fractal_with_developing_${developingDirection}_bi`
          : `latest_confirmed_${confirmedDirection}_bi_with_developing_${developingDirection}_bi`,
      },
      latest_structure:updatedLatestStructure,
    }
  }
  if (backgroundDirection !== 'neutral' && confirmedDirection !== backgroundDirection) {
    return {
      trend_state:{
        ...backgroundTrend,
        state:confirmedDirection === 'up' ? 'up_transition_confirmed' : 'down_transition_confirmed',
        direction:confirmedDirection,
        local_bias:confirmedDirection,
        background_direction:backgroundDirection,
        phase:'transition',
        reversal_bias:'none',
        confidence:capStructureConfidence(reliability, 'medium'),
        reason:`latest_confirmed_${confirmedDirection}_bi_opposes_background`,
      },
      latest_structure:updatedLatestStructure,
    }
  }
  return {
    trend_state:{ ...backgroundTrend, direction:confirmedDirection, local_bias:confirmedDirection,
      background_direction:backgroundDirection },
    latest_structure:updatedLatestStructure,
  }
}

export function classifyChanTrend(segments: readonly TrendSegment[], centers: readonly WindowCenter[], latestPrice: number | null, divergence: TrendDivergence | null, reliability = 'low', formingSegment: Pick<EvidenceSegment, 'dir'> & { id?: number } | null = null,
  latestStructure: ReturnType<typeof buildLatestChanStructure> | null = null) {
  const backgroundTrend = classifyChanTrendBackground(
    segments, centers, latestPrice, divergence, reliability, formingSegment)
  if (!latestStructure) return backgroundTrend
  return prioritizeLatestChanStructure(backgroundTrend, latestStructure, reliability).trend_state
}
