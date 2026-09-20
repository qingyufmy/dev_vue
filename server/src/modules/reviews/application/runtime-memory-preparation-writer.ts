export interface RuntimeMemoryPreparation {
  userId: number
  strategyId: string
  runtimeKind: 'analysis' | 'trader'
  runtimeId: string
  inputSnapshotId: string
  inputSnapshotHash: string
  libraryId: string
  libraryRevision: string
  revisionId: string
  versionNumber: number
  contentHash: string
  contentBytes: number
  estimatedTokens: number
  maxContextTokens: number
  estimateMethod: 'utf8_bytes_div4_v1'
  occurredAt: string
}

// The snapshot owner calls this on the same transaction connection after saving
// its input. This records preparation, not provider consumption or billed usage.
export interface RuntimeMemoryPreparationWriter {
  record(input: RuntimeMemoryPreparation): Promise<void>
}
