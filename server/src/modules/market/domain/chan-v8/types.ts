export interface ChanRate {
  open: string | number
  high: string | number
  low: string | number
  close: string | number
  time?: string | number
  time_utc_msc?: number
}

export interface ChanBar {
  idx: number
  raw_idx: number
  raw_start_idx: number
  raw_end_idx: number
  high_raw_idx: number
  low_raw_idx: number
  high: number
  low: number
  open: number
  close: number
  time: string | number | undefined
}

export interface ChanFractal {
  idx: number
  raw_idx?: number
  raw_start_idx: number
  raw_end_idx: number
  extreme_raw_idx: number
  type: 'top' | 'bottom'
  price: number
  high: number
  low: number
  time: string | number | undefined
}

export interface ChanBi {
  id: number
  dir: 'up' | 'down'
  run_id: number
  start_idx: number
  end_idx: number
  raw_start_idx: number
  raw_end_idx: number
  start_price: number
  end_price: number
  high: number
  low: number
  confirmed: boolean
}

export type ChanDirection = 'up' | 'down'
export interface ChanFeature {
  source_start_index: number
  source_end_index: number
  high_source_index: number
  low_source_index: number
  high: number
  low: number
  start_price: number
  end_price: number
}
export interface ChanSegment {
  id: number
  dir: ChanDirection
  raw_start_idx: number
  raw_end_idx: number
  start_price: number
  end_price: number
  high: number
  low: number
  bi_ids: number[]
  start_bi_id: number
  end_bi_id: number
  broken: boolean
  ended_reason: string
  weak: boolean
  confirmation: string
}

export type EvidenceSegment = Pick<ChanSegment, 'id' | 'dir' | 'bi_ids' | 'start_price' | 'end_price' | 'high' | 'low'>
  & Partial<Omit<ChanSegment, 'id' | 'dir' | 'bi_ids' | 'start_price' | 'end_price' | 'high' | 'low'>>
  & { endpoint_raw_idx?: number | null }
