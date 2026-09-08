import type { MacroSnapshotRecord } from '../domain/macro-snapshot.js'

export interface SnapshotObservation {
  factorCode: string
  observationAt: string
  availableAt: string
  ingestedAt: string
  value: string | null
}
export interface ReadableMacroSnapshot {
  record: MacroSnapshotRecord
  observations: SnapshotObservation[]
}
export interface MacroSnapshotQuery {
  asOf: string
  accessAt: string
  limit: number
  id?: string
  latest?: boolean
  after?: { publishedAt: string; id: string }
}
export interface PublicMacroSnapshotReader {
  list(query: MacroSnapshotQuery): Promise<ReadableMacroSnapshot[]>
}
