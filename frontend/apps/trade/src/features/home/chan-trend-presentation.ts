import type { PublicMarketSnapshotData } from '@aurum/contracts'

type Structure = PublicMarketSnapshotData['structure']
type Trend = NonNullable<NonNullable<Structure>['trend']>

const confidenceLabels = { high: '高置信度', medium: '中等置信度', low: '低置信度' } as const
const reliabilityLabels = { high: '高', medium: '中等', low: '较低' } as const

function primaryLabel(trend: Trend | null | undefined) {
  if (!trend) return '待确认'
  if (trend.phase === 'range' || trend.state === 'consolidation') return '盘整'
  if (trend.direction === 'up') return '向上'
  if (trend.direction === 'down') return '向下'
  return '方向未定'
}

function phaseLabel(trend: Trend | null | undefined): string | null {
  if (!trend) return null
  const labels: Record<string, string> = {
    up_reversal_watch: '向下反转 · 尚未确认',
    down_reversal_watch: '向上反转 · 尚未确认',
    upward_exhaustion: '上涨动能衰减',
    downward_exhaustion: '下跌动能衰减',
    upward_breakout_pending: '向上突破待确认',
    downward_breakout_pending: '向下突破待确认',
    up_transition_confirmed: '向上转换已确认',
    down_transition_confirmed: '向下转换已确认',
    structural_rise_transition: '上升结构形成中',
    structural_decline_transition: '下降结构形成中',
    uptrend: '趋势结构已确认',
    downtrend: '趋势结构已确认',
    structural_rise: '结构已确认',
    structural_decline: '结构已确认',
    unavailable: '结构证据不足',
  }
  const stateLabel = labels[trend.state]
  if (stateLabel) return stateLabel
  if (trend.phase === 'exhaustion') return '动能衰减'
  if (trend.phase === 'transition') return '结构过渡中'
  if (trend.phase === 'breakout_candidate') return '突破待确认'
  if (trend.phase === 'trend') return '趋势结构已确认'
  if (trend.phase === 'structure') return '结构已确认'
  return null
}

function phaseCaption(trend: Trend | null | undefined): string | null {
  if (!trend || !phaseLabel(trend)) return null
  if (trend.state === 'up_reversal_watch' || trend.state === 'down_reversal_watch') return '形成中笔'
  if (trend.phase === 'breakout_candidate') return '形成中'
  return '当前阶段'
}

function primaryCaption(trend: Trend | null | undefined): string {
  if (!trend) return '结构'
  if (trend.state === 'up_reversal_watch' || trend.state === 'down_reversal_watch') return '已确认笔'
  if (trend.phase === 'breakout_candidate') return '当前方向'
  if (trend.phase === 'range' || trend.state === 'consolidation') return '当前结构'
  if (trend.direction === 'up' || trend.direction === 'down') return '已确认结构'
  return '结构'
}

function qualityLabels(structure: Structure): string[] {
  if (!structure) return []
  const values: string[] = []
  if (structure.trend?.confidence && structure.trend.confidence !== 'high') values.push(confidenceLabels[structure.trend.confidence])
  if (structure.status === 'partial') values.push('部分可用')
  else if (structure.status === 'insufficient_klines') values.push('历史不足')
  else if (structure.status !== 'ok') values.push('结构待确认')
  return values
}

export function presentChanTrend(structure: Structure) {
  const trend = structure?.trend
  const primary = primaryLabel(trend)
  const phase = phaseLabel(trend)
  const secondaryCaption = phaseCaption(trend)
  const quality = qualityLabels(structure)
  const mainCaption = primaryCaption(trend)
  const details = [`${mainCaption}${primary}`, secondaryCaption && phase ? `${secondaryCaption}${phase}` : phase, ...quality]
  const reliability = structure ? `整体可靠性${reliabilityLabels[structure.reliability]}` : '整体可靠性待确认'
  const guideHint = secondaryCaption?.startsWith('形成中')
    ? '图中走势指引来自形成中笔，不代表新段已经确认。' : null
  return {
    primary,
    primaryCaption: mainCaption,
    phase,
    phaseCaption: secondaryCaption,
    quality,
    tone: trend?.direction === 'up' ? 'bg-trade-up' : trend?.direction === 'down' ? 'bg-trade-down' : 'bg-muted-foreground',
    ariaLabel: `缠论结构：${details.filter(Boolean).join('，')}`,
    title: `${details.filter(Boolean).join('；')}；${reliability}${guideHint ? `。${guideHint}` : ''}`,
  }
}
