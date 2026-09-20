export interface RuntimeStrategyMemoryScope {
  userId: number
  strategyId: string
  strategyKind: 'analysis' | 'trader'
}

export type RuntimeStrategyMemory = {
  state: 'absent'
  strategyId: string
} | {
  state: 'disabled' | 'ready'
  strategyId: string
  libraryId: string
  libraryRevision: string
  mode: 'off' | 'shadow' | 'active'
  status: 'active' | 'revalidating' | 'retired'
  revisionId: string | null
  versionNumber: number | null
  contentHash: string | null
  contentText: string | null
  maxContextTokens: number
}

// Returns one current immutable revision, never pending proposals or historical
// versions. Permission failure and broken source evidence are errors, not absence.
export interface RuntimeStrategyMemoryReader {
  read(scope: RuntimeStrategyMemoryScope): Promise<RuntimeStrategyMemory>
}
