import type { StrategySubscriptionCreateBody } from '@aurum/contracts'
export type SubscriptionTimeWindow = NonNullable<StrategySubscriptionCreateBody['receive_window']>
import { formatLaboratoryTime } from '~/lib/laboratory-display-time'
import type { StrategyKind, StrategySummary } from '@aurum/contracts'

export type StrategySection = 'library' | 'subscriptions'

export interface StrategyVersionView {
  id: string
  versionNumber: number
  promptText: string
  promptSha256: string
  inputContractVersion: string
  outputContractVersion: string
  config: Record<string, unknown>
  createdAt: string
}

export interface StrategyDetailView {
  strategy: StrategySummary
  versions: StrategyVersionView[]
  performance: import('@aurum/contracts').StrategyDetail['performance']
}

export interface CompileIssueView {
  level: 'error' | 'warning'
  code: string
  message: string
  path: string
}

export interface CompileResultView {
  valid: boolean
  issues: CompileIssueView[]
  normalizedConfig: Record<string, unknown>
  promptSha256: string
  inputContractVersion: string
  outputContractVersion: string
}

export interface StrategyDraft {
  status?: 'draft' | 'active'
  kind: StrategyKind
  name: string
  description: string
  promptText: string
  config: Record<string, unknown>
}

export interface SubscriptionDraft {
  receiveWindow?: SubscriptionTimeWindow
  accountId: string
  symbol: string
  analysisStrategyId: string
  traderStrategyId: string | null
  analysisEnabled: boolean
  traderEnabled: boolean
  status: 'active' | 'paused' | 'ended'
}

export interface StrategySubscriptionView {
  receiveWindow?: SubscriptionTimeWindow
  id: string
  accountId: string
  symbol: string
  analysisStrategyId: string
  analysisStrategyVersionId: string
  traderStrategyId: string | null
  traderStrategyVersionId: string | null
  analysisEnabled: boolean
  traderEnabled: boolean
  tradeSendEnabled: boolean
  status: 'active' | 'paused' | 'ended'
  cadenceSeconds: number
  revision: number
  updatedAt: string
}

export const strategyKindLabel: Record<StrategyKind, string> = {
  analysis: '行情分析',
  trader: '交易执行',
}

export const strategyStatusLabel = {
  draft: '草稿',
  active: '已发布',
  retired: '已退役',
} as const

export const subscriptionStatusLabel = {
  active: '运行中',
  paused: '已暂停',
  ended: '已结束',
} as const

export function findStrategyName(items: StrategySummary[], id: string | null) {
  if (!id) return '未配置'
  return items.find((item) => item.id === id)?.name ?? '策略暂不可用'
}

export function versionLabel(version: StrategyVersionView | undefined) {
  return version ? `v${version.versionNumber}` : '--'
}

export function defaultConfig(kind: StrategyKind): Record<string, unknown> {
  return kind === 'analysis' ? { timeframes: ['M5', 'M15', 'H1', 'H4'], candle_limit: 300 } : {}
}

export function formatDateTime(value: string | null | undefined) {
  return formatLaboratoryTime(value)
}
