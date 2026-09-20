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

const fieldLabels: Record<string, string> = {
  support: '支撑位', resistance: '阻力位',
  condition: '条件', price: '价格', reason: '原因', timeframe: '观察周期', invalidation_price: '失效价格',
  h1: '1 小时', h4: '4 小时', m1: '1 分钟', m5: '5 分钟', m15: '15 分钟',
  developingBi: '形成中的笔', latestConfirmedBi: '已确认的笔', startPrice: '起点价格', endPrice: '终点价格',
  latestConfirmedTopFractalPrice: '已确认顶分型价格', latestConfirmedBottomFractalPrice: '已确认底分型价格',
  localBias: '当前方向', confirmedDirection: '已确认方向', dir: '方向', confirmed: '已确认',
  structuralProtectionAvailable: '存在结构保护位', m15SameDirectionConfirmation: '15 分钟同向确认',
  availableM5EventsStillValid: '5 分钟信号仍有效',
}
const valueLabels: Record<string, string> = { up: '向上', down: '向下', neutral: '中性' }
export function readableRecord(value: Record<string, unknown>) {
  const result: { key: string; label: string; value: string }[] = []
  function visit(record: Record<string, unknown>, path: string[], labels: string[], depth: number) {
    if (depth > 4) return
    for (const [key, item] of Object.entries(record)) {
      const label = fieldLabels[key]
      if (!label || item == null || item === '') continue
      const nextPath = [...path, key], nextLabels = [...labels, label]
      if (Array.isArray(item)) {
        const values = item.filter(v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim()))
        if (values.length) result.push({key:nextPath.join('.'),label:nextLabels.join(' · '),value:values.map(v=>valueLabels[String(v)] ?? String(v)).join('、')})
      } else if (typeof item === 'object') visit(item as Record<string, unknown>, nextPath, nextLabels, depth + 1)
      else if (['string', 'number', 'boolean'].includes(typeof item)) result.push({
        key: nextPath.join('.'), label: nextLabels.join(' · '),
        value: typeof item === 'boolean' ? (item ? '是' : '否') : valueLabels[String(item)] ?? String(item),
      })
    }
  }
  visit(value, [], [], 0)
  return result
}

export function marketRegimeLabel(value: string) {
  if (!value) return '暂未给出明确市场环境'
  const labels: Record<string, string> = {
    unavailable: '市场环境暂无法判断', unknown: '市场环境暂无法判断', transition: '行情过渡阶段', up_reversal_watch: '关注向上反转', down_reversal_watch: '关注向下反转',
    trending: '趋势行情', ranging: '区间震荡', volatile: '波动较大', bullish: '偏多', bearish: '偏空',
  }
  return value.split(/\s*\/\s*/).map(part => labels[part] ?? (/[\u4e00-\u9fff]/.test(part) ? part : '暂未说明')).join(' · ')
}

export function marketDirectionRatio(bull: unknown, bear: unknown) {
  if (typeof bull !== 'number' || typeof bear !== 'number' || !Number.isFinite(bull + bear) || bull < 0 || bear < 0 || bull + bear <= 0) return null
  const bullish = Math.round(bull / (bull + bear) * 1000) / 10
  return { bullish, bearish: Math.round((100 - bullish) * 10) / 10 }
}
