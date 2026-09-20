import type { WindowEvidence, WindowSegment, WindowCenter } from './window-evidence.js'
import type { DivergenceEvidence, EntryEvidence } from './evidence-remapping.js'
import type { ChanEvidenceCapabilities } from './evidence-capabilities.js'
import type { buildLatestChanStructure } from './latest-structure.js'
import type { classifyChanTrend } from './trend.js'
export interface ChanAnchor {
  [key: string]: unknown
  bootstrap_observation_time_utc_msc?: number | null
  matched?: boolean
  current_result_usable?: boolean
  requested_time_utc_msc?: number | null
  time_matched?: boolean
  identity_matched?: boolean
  last_confirmed_segment_not_regressed?: boolean
}
export interface ChanResult extends WindowEvidence {
  [key: string]: unknown
  status: string
  reliability: string
  warnings: string[]
  center_count: number
  segment_count: number
  raw_bar_count: number
  active_bi_count: number
  bi_count: number
  latest_price: number | null
  current_segment: WindowSegment | null
  prev_segment: WindowSegment | null
  candidate_segment: WindowSegment | null
  current_center: WindowCenter | null
  latest_center: WindowCenter | null
  structure_anchor: ChanAnchor
  divergence: DivergenceEvidence
  forming_divergence: DivergenceEvidence
  recent_divergences: DivergenceEvidence[]
  entry_candidates: EntryEvidence[]
  latest_structure: ReturnType<typeof buildLatestChanStructure> | null
  trend_state: ReturnType<typeof classifyChanTrend>
  continuity_complete: boolean | string
  absolute_time_location_reliable: boolean
  authoritative_terminal_chain_confirmed?: boolean
  evidence_capabilities: Omit<ChanEvidenceCapabilities, 'local_structure_usable'> & { local_structure_usable?: boolean }
}
