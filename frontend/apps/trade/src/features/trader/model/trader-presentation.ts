import { terminalDisplayDate } from '~/lib/terminal-display-time'
import type {
  OpenPosition,
  PendingOrder,
  TraderDecisionDetail,
  TraderDecisionSummary,
} from '@aurum/contracts'

type NullableValue = string | number | boolean | null | undefined

const actionLabels: Record<string, string> = {
  hold: '观望',
  market_order: '市价单',
  pending_order: '挂单',
  modify_position: '修改持仓',
  close_position: '平仓',
  modify_order: '修改挂单',
  cancel_order: '撤单',
}

const statusLabels: Record<string, string> = {
  proposed: '待风控',
  stale: '已失效',
  risk_rejected: '风控拒绝',
  accepted: '风控已通过',
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  partially_succeeded: '部分完成',
  rejected: '已拒绝',
  failed: '失败',
  uncertain: '待核实',
  cancelled: '已取消',
  expired: '已过期',
}

const sideLabels: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
}

const orderTypeLabels: Record<string, string> = {
  buy_limit: '买入限价',
  sell_limit: '卖出限价',
  buy_stop: '买入止损',
  sell_stop: '卖出止损',
  buy_stop_limit: '买入止损限价',
  sell_stop_limit: '卖出止损限价',
}

const sourceLabels: Record<string, string> = {
  manual: '手动交易',
  signal: 'AI 信号',
  unknown: '未知来源',
}

const fieldLabels: Record<string, string> = {
  action: '动作',
  side: '方向',
  symbol: '品种',
  ticket: '订单号',
  volume: '手数',
  price: '价格',
  entry: '入场价',
  open_price: '开仓价',
  current_price: '当前价',
  stop_loss: '止损价',
  take_profit: '止盈价',
  created_at: '创建时间',
  opened_at: '开仓时间',
  expires_at: '到期时间',
  source: '来源',
  signal_id: '信号编号',
  reason: '原因',
  status: '状态',
  operation_id: '操作编号',
}

export function actionLabel(value: NullableValue) {
  return mappedLabel(value, actionLabels)
}

export function decisionStatusLabel(value: NullableValue) {
  return mappedLabel(value, statusLabels)
}

/** Use for either a trader decision or an asynchronous execution status. */
export function statusLabel(value: NullableValue) {
  return decisionStatusLabel(value)
}

export function sideLabel(value: NullableValue) {
  return mappedLabel(value, sideLabels)
}

export function orderTypeLabel(value: NullableValue) {
  return mappedLabel(value, orderTypeLabels)
}

export function sourceLabel(value: NullableValue) {
  return mappedLabel(value, sourceLabels)
}

export function formatNullable(value: NullableValue) {
  if (value === null || value === undefined || value === '') return '--'
  return String(value)
}

export function formatDecimal(value: NullableValue, fractionDigits = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  const digits = Math.max(0, Math.min(8, Math.trunc(fractionDigits)))
  return numeric.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatPrice(value: NullableValue) {
  return formatDecimal(value, decimalPlaces(value))
}

export function formatVolume(value: NullableValue) {
  return formatDecimal(value, decimalPlaces(value))
}

export function formatDateTime(value: NullableValue, timezoneOffsetMinutes: number | null = null) {
  if (value === null || value === undefined || value === '') return '--'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  const displayDate = terminalDisplayDate(date, timezoneOffsetMinutes)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(displayDate)
}

export function clockStatusLabel(value: NullableValue) {
  return mappedLabel(value, {
    calibrated: '已校准', observer_bootstrap: '观摩源临时校准', stale: '校准已过期', unavailable: '无法校准',
  })
}

export function profitClass(value: NullableValue) {
  if (value === null || value === undefined || value === '') return 'text-muted-foreground'
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 'text-foreground'
  return numeric > 0 ? 'text-trade-up' : 'text-trade-down'
}

export const pnlClass = profitClass

export function isPosition(resource: OpenPosition | PendingOrder | null | undefined): resource is OpenPosition {
  return Boolean(resource && 'openPrice' in resource)
}

export function isPendingOrder(resource: OpenPosition | PendingOrder | null | undefined): resource is PendingOrder {
  return Boolean(resource && 'createdAt' in resource && 'type' in resource)
}

export function resourceKind(resource: OpenPosition | PendingOrder | null | undefined) {
  if (!resource) return '--'
  return isPosition(resource) ? '持仓' : '挂单'
}

export function resourceActionHint(resource: OpenPosition | PendingOrder | null | undefined) {
  if (!resource) return '暂无交易资源'
  return isPosition(resource)
    ? '平仓与保护修改必须由服务端受理，并以终端资源复核结果为准。'
    : '撤单与挂单修改必须由服务端受理，并以终端资源复核结果为准。'
}

export function readableRecord(value: Record<string, unknown>) {
  return Object.entries(value).map(([key, item]) => ({
    key,
    label: fieldLabels[key] ?? key.replaceAll('_', ' '),
    value: readableValue(item),
  }))
}

export function readableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return value.toString()
  try {
    const serialized = JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
    return serialized ?? '--'
  } catch {
    return '无法读取'
  }
}

export function actionParameterRecords(action: TraderDecisionDetail['actions'][number]) {
  return readableRecord(action.parameters)
}

export function expectedStateRecords(action: TraderDecisionDetail['actions'][number]) {
  return readableRecord(action.expected_state)
}

export function strategyName(strategies: { id: string; name: string }[], id: string) {
  return strategies.find((item) => item.id === id)?.name ?? '未命名策略'
}

export function decisionHasAnalysis(decision: TraderDecisionSummary | null | undefined) {
  return Boolean(decision?.analysisId)
}

function mappedLabel(value: NullableValue, labels: Record<string, string>) {
  if (value === null || value === undefined || value === '') return '--'
  return labels[String(value)] ?? '暂未识别'
}

function decimalPlaces(value: NullableValue) {
  if (value === null || value === undefined || value === '') return 2
  const text = String(value)
  const places = text.includes('.') ? text.split('.')[1]?.length ?? 0 : 0
  return Math.max(2, Math.min(8, places))
}
