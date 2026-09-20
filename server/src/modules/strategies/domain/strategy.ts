export type StrategyKind = 'analysis' | 'trader'
export type StrategyScope = 'platform' | 'user'
export type StrategyStatus = 'draft' | 'active' | 'retired'
export type StrategySubscriptionStatus = 'active' | 'paused' | 'ended'
export type StrategyIssueLevel = 'error' | 'warning'

export interface StrategySummary {
  id: string
  kind: StrategyKind
  scope: StrategyScope
  ownerUserId: number | null
  name: string
  description: string
  status: StrategyStatus
  activeVersionId: string | null
  pairedTraderStrategy?: {
    id: string
    name: string
    status: StrategyStatus
    activeVersionId: string | null
  } | null
  revision: number
}

export interface StrategyPerformance {
  status: 'available' | 'insufficient' | 'mixed_currency'
  currency: string | null
  currencies: string[]
  netProfit: string | null
  maxDrawdown: string | null
  returnPercent: string | null
  maxDrawdownPercent: string | null
  tradeCount: number
  winRatePercent: string | null
  profitFactor: string | null
  periodStart: string | null
  periodEnd: string | null
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

export interface StrategyVersionDetail extends StrategyVersion {
  createdByUserId: number
  createdAt: string
}

export interface StrategyDetail {
  summary: StrategySummary
  versions: StrategyVersionDetail[]
  performance?: StrategyPerformance
}

export interface StrategyCompileIssue {
  level: StrategyIssueLevel
  code: string
  message: string
  path: string | null
}

export interface StrategyCompileResult {
  valid: boolean
  kind: StrategyKind
  promptHash: string
  normalizedConfig: Record<string, unknown>
  inputContractVersion: string
  outputContractVersion: string
  issues: StrategyCompileIssue[]
}

export interface StrategySubscriptionSchedule {
  cadenceSeconds: number
  receiveTimezone: string
  receiveWindow: Record<string, unknown>
  nextDueAt: string | null
  revision: number
}

export interface StrategySubscription {
  id: string
  userId: number
  tradingAccountId: string
  standardSymbol: string
  analysisStrategyId: string
  analysisStrategyVersionId: string
  traderStrategyId: string | null
  traderStrategyVersionId: string | null
  analysisEnabled: boolean
  traderEnabled: boolean
  tradeSendEnabled: boolean
  status: StrategySubscriptionStatus
  revision: number
  createdAt: string
  updatedAt: string
  schedule: StrategySubscriptionSchedule
}

export interface CreateStrategyInput {
  userId: number
  idempotencyKey: string
  kind: StrategyKind
  name: string
  description: string
  promptText: string
  config: Record<string, unknown>
}

export interface UpdateStrategyMetadataInput {
  userId: number
  idempotencyKey: string
  strategyId: string
  expectedRevision: number
  name: string
  description: string
}

export interface CreateStrategyVersionInput {
  name?: string
  description?: string
  status?: 'draft' | 'active'
  idempotencyKey: string
  userId: number
  strategyId: string
  expectedRevision: number
  promptText: string
  config: Record<string, unknown>
}

export interface PublishStrategyVersionInput {
  idempotencyKey: string
  userId: number
  strategyId: string
  versionId: string
  expectedRevision: number
}

export interface RetireStrategyInput {
  idempotencyKey: string
  userId: number
  strategyId: string
  expectedRevision: number
}

export interface CreateStrategySubscriptionInput {
  receiveWindow?: Record<string, unknown>
  idempotencyKey: string
  userId: number
  tradingAccountId: string
  standardSymbol: string
  analysisStrategyId: string
  traderStrategyId?: string | null
  analysisEnabled?: boolean
  traderEnabled?: boolean
  tradeSendEnabled?: boolean
  status?: StrategySubscriptionStatus
}

export interface UpdateStrategySubscriptionInput {
  receiveWindow?: Record<string, unknown>
  idempotencyKey: string
  userId: number
  subscriptionId: string
  expectedRevision: number
  standardSymbol?: string
  analysisStrategyId?: string
  traderStrategyId?: string | null
  analysisEnabled?: boolean
  traderEnabled?: boolean
  tradeSendEnabled?: boolean
  status?: StrategySubscriptionStatus
}

export class StrategyAccessError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly errors: StrategyCompileIssue[] = [],
  ) {
    super(code)
  }
}

export function assertStrategyKind(value: string): asserts value is StrategyKind {
  if (value !== 'analysis' && value !== 'trader') throw new StrategyAccessError('strategy_kind_invalid', 422)
}
