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

export interface StrategyCombinationDraft {
  status?: 'draft' | 'active'
  name: string
  description: string
  analysisPromptText: string
  analysisConfig: Record<string, unknown>
  traderPromptText: string
  traderConfig: Record<string, unknown>
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
  return items.find((item) => item.id === id)?.name ?? `策略 #${id}`
}

export function versionLabel(version: StrategyVersionView | undefined) {
  return version ? `v${version.versionNumber}` : '--'
}

export function defaultConfig(kind: StrategyKind): Record<string, unknown> {
  const common = { responsibility_mode: 'independent_roles_v2', symbols: [] }
  return kind === 'analysis' ? {
    ...common, interval_minutes: 60,
    market_data_plan: { version: 1, primary_timeframe: 'H1', timeframes: [{ timeframe: 'H1', kline_count: 300 }, { timeframe: 'H4', kline_count: 300 }] },
    chan_evidence: { version: 1, enabled: true }, price_action_evidence: { version: 1, enabled: false },
  } : {
    ...common,
    market_data_plan: { version: 1, primary_timeframe: 'M5', timeframes: [{ timeframe: 'M5', kline_count: 300 }, { timeframe: 'M15', kline_count: 300 }] },
    chan_evidence: { version: 1, enabled: false }, price_action_evidence: { version: 1, enabled: true }, entry_methods: ['market', 'limit', 'stop'],
  }
}

export function defaultPrompt(kind: StrategyKind) {
  if (kind === 'analysis') return `你是行情分析师。只使用系统提供的 H1、H4 缠论证据判断市场方向、阶段、关键区域、主情景、替代情景和失效条件，不读取账户状态，不提出下单、平仓或改单动作。

明确记录数据截止时间、生成时间和有效期。证据不足时保持不确定，不补造结构。opportunity 仅为兼容字段，不是交易许可。严格按系统要求的市场背景 JSON 合同输出，所有可读说明使用简体中文。`
  return `你是账户级 AI 交易员。使用本组合分析师给出的市场背景，以及系统本轮冻结的最新 M15、M5 非缠论价格行为、报价、持仓、挂单和风险事实，独立寻找机会并管理当前账户。

不得读取或重建缠论结构。每个开仓或挂单动作必须引用仍有效且未使用的客观事件，并记录 entry_scenario（trend、countertrend 或 range）及 scenario_invalidation。止损和止盈由你依据当前小周期结构与报价决定；背景过期时不得新增仓位，但可管理已有持仓和挂单。严格按系统交易决定 JSON 合同输出，不直接调用终端。`
}

export function formatDateTime(value: string | null | undefined) {
  return formatLaboratoryTime(value)
}
