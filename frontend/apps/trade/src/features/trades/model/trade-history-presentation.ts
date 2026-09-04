import type { TradeHistoryRecord, TradeHistorySource, TradeRecordDetail } from '@aurum/contracts'

export type TradeHistoryFilters = { symbol: string; side: '' | 'buy' | 'sell'; source: '' | TradeHistorySource; outcome: '' | 'profit' | 'loss' | 'breakeven'; from: string; to: string; query: string }
export const emptyTradeHistoryFilters = (): TradeHistoryFilters => ({ symbol: '', side: '', source: '', outcome: '', from: '', to: '', query: '' })

export const sourceLabel = (value: TradeHistorySource) => ({ system: '系统策略', manual: '手动交易', other_ea: '其他 EA', mixed: '混合来源', unknown: '待核实' })[value]
export const sideLabel = (value: TradeHistoryRecord['side']) => value === 'buy' ? '买入' : '卖出'
export const evidenceLabel = (value: TradeHistoryRecord['evidenceStatus']) => ({ complete: '证据完整', partial: '证据待补', conflicted: '证据冲突' })[value]
export const money = (value: string, currency = 'USD') => `${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
export const decimal = (value: string | null, digits = 2) => value === null ? '--' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
export const terminalTime = (value: string | null, offsetMinutes: number) => {
  if (!value) return '--'
  const date = new Date(new Date(value).getTime() + offsetMinutes * 60_000)
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`
}
export const attributionLink = (item: TradeRecordDetail['attributions'][number]) => {
  if (item.kind === 'market_analysis') return { label: '查看行情分析', to: { path: '/analyst', query: { analysis_id: item.sourceId } } }
  if (item.kind === 'trade_decision') return { label: '查看交易员决策', to: { path: '/trader', query: { decision_id: item.sourceId } } }
  if (item.kind === 'risk_decision') return { label: '查看风控评审', to: { path: '/risk', query: { decision_id: item.sourceId } } }
  if (item.kind === 'review_case') return { label: '查看交易复盘', to: { path: '/reviewer', query: { case_id: item.sourceId } } }
  return { label: item.kind === 'bridge_command' ? '查看终端指令证据' : '查看执行链路', to: { path: '/audit', query: { source_kind: item.kind, source_id: item.sourceId } } }
}
