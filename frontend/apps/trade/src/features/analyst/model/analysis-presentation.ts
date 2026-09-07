import { formatLaboratoryTime } from '~/lib/laboratory-display-time'
import type { MarketAnalysisSummary } from '@aurum/contracts'

const biasLabels = {
  bullish: '偏多',
  bearish: '偏空',
  neutral: '中性',
  uncertain: '方向不明',
} as const

const opportunityLabels = {
  none: '观望',
  long_setup: '发现做多机会',
  short_setup: '发现做空机会',
} as const

export function biasLabel(value: MarketAnalysisSummary['marketBias']) {
  return biasLabels[value]
}

export function opportunityLabel(value: MarketAnalysisSummary['opportunity']) {
  return opportunityLabels[value]
}

export function biasTextClass(value: MarketAnalysisSummary['marketBias']) {
  if (value === 'bullish') return 'text-trade-up'
  if (value === 'bearish') return 'text-trade-down'
  if (value === 'uncertain') return 'text-warning'
  return 'text-foreground'
}

export function analysisTime(value: string) {
  return formatLaboratoryTime(value)
}

export function analysisValidity(summary: MarketAnalysisSummary, now = Date.now()) {
  return Date.parse(summary.validUntil) > now ? `有效至 ${analysisTime(summary.validUntil)}` : '结论已过有效期'
}

export function readableRecord(value: Record<string, unknown>) {
  return Object.entries(value).map(([key, item]) => ({ key, label: fieldLabel(key), value: readableValue(item) }))
}

const fieldLabels: Record<string, string> = {
  support: '支撑位', resistance: '阻力位', entry: '参考入场', stop_loss: '止损参考', take_profit: '止盈参考',
  condition: '条件', price: '价格', reason: '原因', timeframe: '观察周期', invalidation_price: '失效价格',
}

function fieldLabel(key: string) {
  return fieldLabels[key] ?? key.replaceAll('_', ' ')
}

function readableValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
