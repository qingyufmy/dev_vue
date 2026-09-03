export type StrategyKind = 'analysis' | 'trader'
export type StrategyScope = 'platform' | 'user'
export type StrategyStatus = 'draft' | 'active' | 'retired'

export interface StrategySummary {
  id: string
  kind: StrategyKind
  scope: StrategyScope
  ownerUserId: number | null
  name: string
  description: string
  status: StrategyStatus
  activeVersionId: string | null
  revision: number
}

export interface StrategyVersion {
  id: string
  strategyId: string
  kind: StrategyKind
  version: number
  promptText: string
  promptHash: string
  config: Record<string, unknown>
  inputContractVersion: string
  outputContractVersion: string
}

export class StrategyAccessError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code)
  }
}

export function assertStrategyKind(value: string): asserts value is StrategyKind {
  if (value !== 'analysis' && value !== 'trader') throw new StrategyAccessError('strategy_kind_invalid', 422)
}
