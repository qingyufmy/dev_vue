import { terminalDisplayDate } from '~/lib/terminal-display-time'
import type { RiskPolicy, RiskSummary } from '@aurum/contracts'

export const manualReleaseRuleLabels: Record<string, string> = {
  RISK_DAILY_LOSS_LIMIT: '当日亏损限制',
  RISK_DRAWDOWN_LIMIT: '当日回撤限制',
  RISK_DAILY_OPEN_LIMIT: '当日开仓次数限制',
  RISK_CONSECUTIVE_LOSS_LIMIT: '连续亏损限制',
  RISK_COOLDOWN_ACTIVE: '亏损冷静期',
}

export const rejectCodeLabels: Record<string, string> = {
  RISK_GLOBAL_KILL_SWITCH: '平台暂停交易',
  RISK_ACCOUNT_KILL_SWITCH: '账户暂停交易',
  RISK_DATA_INCOMPLETE: '风险数据不完整',
  RISK_DAILY_LOSS_LIMIT: '触及当日亏损限制',
  RISK_DRAWDOWN_LIMIT: '触及当日回撤限制',
  RISK_OPEN_POSITION_LIMIT: '持仓数量超限',
  RISK_PENDING_ORDER_LIMIT: '挂单数量超限',
  RISK_ORDER_VOLUME_LIMIT: '单笔手数超限',
  RISK_INSTRUMENT_DIRECTION_DISABLED: '券商不允许该方向开仓',
  RISK_TOTAL_VOLUME_LIMIT: '总手数超限',
  RISK_DAILY_OPEN_LIMIT: '当日开仓次数超限',
  RISK_CONSECUTIVE_LOSS_LIMIT: '连续亏损超限',
  RISK_COOLDOWN_ACTIVE: '处于亏损冷静期',
  RISK_SPREAD_LIMIT: '点差超限',
  RISK_STALE: '风险快照已过期',
}

export const availabilityCodeLabels: Record<string, string> = {
  risk_manual_release_disabled: '平台未开放手动解除功能',
  risk_manual_release_global_control: '平台级暂停无法由用户解除',
  risk_manual_release_account_kill_switch: '请先关闭账户暂停开关',
  risk_manual_release_data_incomplete: '风险数据不完整，暂不能解除',
  risk_manual_release_clock_unverified: '终端时钟尚未校准，暂不能解除',
  risk_manual_release_business_date_invalid: '交易日校验失败，暂不能解除',
  risk_manual_release_platform_limit: '已触及平台硬限制，用户不能解除',
  risk_manual_release_no_active_block: '当前没有可手动解除的限制',
  risk_manual_release_already_active: '当前已有一条有效的手动解除记录',
  risk_summary_not_found: '风险快照尚未生成，暂不能解除',
}

export const policyFields = [
  { key: 'maxRiskPerTradePercent', wire: 'max_risk_per_trade_percent', label: '单笔最大风险', description: '单笔计划风险占账户净值的上限。', suffix: '%', step: '0.01', group: 'loss' },
  { key: 'maxDailyLossPercent', wire: 'max_daily_loss_percent', label: '当日亏损上限', description: '达到后停止接受新的开仓动作。', suffix: '%', step: '0.01', group: 'loss' },
  { key: 'maxDrawdownPercent', wire: 'max_drawdown_percent', label: '当日回撤上限', description: '按账户交易日计算，经资金进出校正后，相对当日净值峰值的回撤上限。', suffix: '%', step: '0.01', group: 'loss' },
  { key: 'maxOpenPositions', wire: 'max_open_positions', label: '最多持仓笔数', description: '当前账户可同时存在的持仓数量。', suffix: '笔', step: '1', group: 'exposure' },
  { key: 'maxPendingOrders', wire: 'max_pending_orders', label: '最多挂单笔数', description: '当前账户可同时存在的挂单数量。', suffix: '笔', step: '1', group: 'exposure' },
  { key: 'maxOrderVolume', wire: 'max_order_volume', label: '单笔最大手数', description: '每笔新市价单或挂单的手数上限。', suffix: '手', step: '0.01', group: 'exposure' },
  { key: 'maxTotalVolume', wire: 'max_total_volume', label: '最大总手数', description: '持仓与新动作合计手数的约束。', suffix: '手', step: '0.01', group: 'exposure' },
  { key: 'maxSpreadPoints', wire: 'max_spread_points', label: '最大允许点差', description: '点差超过该值时拒绝新开仓。', suffix: '点', step: '0.1', group: 'market' },
  { key: 'minOpenIntervalSeconds', wire: 'min_open_interval_seconds', label: '最短开仓间隔', description: '两次成功开仓之间至少间隔多久。', suffix: '秒', step: '1', group: 'frequency' },
  { key: 'maxDailyOpenCount', wire: 'max_daily_open_count', label: '每日最多开仓', description: '按终端交易日累计的成功开仓次数。', suffix: '次', step: '1', group: 'frequency' },
  { key: 'consecutiveLossLimit', wire: 'consecutive_loss_limit', label: '连续亏损限制', description: '达到连续亏损次数后进入限制状态。', suffix: '次', step: '1', group: 'frequency' },
  { key: 'lossCooldownMinutes', wire: 'loss_cooldown_minutes', label: '亏损冷静期', description: '出现亏损后暂停新开仓的时间。', suffix: '分钟', step: '1', group: 'frequency' },
  { key: 'pendingValidMinutes', wire: 'pending_valid_minutes', label: '挂单最长有效期', description: '新挂单允许保留的最长时间。', suffix: '分钟', step: '1', group: 'orders' },
  { key: 'weekendCloseMinutes', wire: 'weekend_close_minutes', label: '周末前保护时间', description: '周末收盘前进入保护状态的提前量。', suffix: '分钟', step: '1', group: 'orders' },
] as const

export type NumericPolicyKey = typeof policyFields[number]['key']

export function riskState(policy: RiskPolicy | null, summary: RiskSummary | null, now = Date.now()) {
  if (!policy) return { level: 'unknown' as const, title: '风控规则待同步', detail: '尚未取得账户规则，请刷新后查看。', reasons: [] as string[] }
  const reasons: string[] = []
  if (policy.globalKillSwitch) reasons.push('平台已暂停交易')
  if (policy.accountKillSwitch) reasons.push('账户已手动暂停交易')
  if (!summary) return { level: reasons.length ? 'blocked' as const : 'unknown' as const, title: reasons[0] ?? '账户风险数据待准备', detail: '风险汇总尚未生成。可以先查看和设置规则，当前无法确认风险用量。', reasons }
  const observed = Date.parse(summary.observedAt)
  if (!Number.isFinite(observed) || observed > now + 5000 || now - observed > policy.maxRiskSummaryAgeSeconds * 1000) reasons.push('风险数据已过期，请等待更新')
  if (summary.clockStatus !== 'calibrated' || summary.terminalTimezoneOffsetMinutes === null) reasons.push('账户交易时区尚未确认')
  if (!summary.dataComplete || summary.incompleteReasons.length) reasons.push('风险数据不完整')
  if (Number(summary.dailyLossPercent) >= Number(policy.maxDailyLossPercent)) reasons.push('触及当日亏损限制')
  if (Number(summary.drawdownPercent) >= Number(policy.maxDrawdownPercent)) reasons.push('触及当日回撤限制')
  if (summary.openPositions >= policy.maxOpenPositions) reasons.push('持仓数量达到上限')
  if (summary.pendingOrders >= policy.maxPendingOrders) reasons.push('挂单数量达到上限')
  if (Number(summary.totalVolume) >= Number(policy.maxTotalVolume)) reasons.push('总手数达到上限')
  if (summary.dailyOpenCount >= policy.maxDailyOpenCount) reasons.push('当日开仓次数达到上限')
  if (summary.consecutiveLosses >= policy.consecutiveLossLimit) reasons.push('连续亏损达到上限')
  if (summary.cooldownUntil && Date.parse(summary.cooldownUntil) > now) reasons.push('处于亏损冷静期')
  if (reasons.length) return { level: 'blocked' as const, title: '部分交易动作受限', detail: `${reasons[0] ?? '账户触发风险限制'}；平仓、撤单或收紧保护价仍会按动作类型单独评审。`, reasons }

  const warning = [
    ratio(summary.dailyLossPercent, policy.maxDailyLossPercent),
    ratio(summary.drawdownPercent, policy.maxDrawdownPercent),
    ratio(summary.openPositions, policy.maxOpenPositions),
    ratio(summary.pendingOrders, policy.maxPendingOrders),
    ratio(summary.totalVolume, policy.maxTotalVolume),
    ratio(summary.dailyOpenCount, policy.maxDailyOpenCount),
  ].some((value) => value >= 80)
  return warning
    ? { level: 'warning' as const, title: '风险额度接近上限', detail: '至少一项风险指标已使用 80% 以上，请谨慎增加风险敞口。', reasons: [] as string[] }
    : { level: 'healthy' as const, title: '风险状态正常', detail: '当前快照未触发账户级限制，交易动作仍会逐笔经过服务端风控。', reasons: [] as string[] }
}

export function ratio(current: string | number, limit: string | number) {
  const maximum = Number(limit)
  if (!Number.isFinite(maximum) || maximum <= 0) return 0
  return Math.min(100, Math.max(0, (Number.isFinite(Number(current)) ? Number(current) : 0) / maximum * 100))
}

export function formatDecimal(value: string | number | null | undefined, digits = 2) {
  if (value === null || value === undefined || value === '') return '--'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '--'
}

export function formatDateTime(value: string | null | undefined, timezoneOffsetMinutes: number | null = null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  const shifted = terminalDisplayDate(date, timezoneOffsetMinutes)
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', hour12: false, dateStyle: 'short', timeStyle: 'medium' }).format(shifted)
}

export function releaseRuleLabel(code: string) {
  return manualReleaseRuleLabels[code] ?? '其他风险限制'
}

export function rejectCodeLabel(code: string | null) {
  if (!code) return '通过全部风控规则'
  return rejectCodeLabels[code] ?? '其他风控规则'
}

export function availabilityLabel(code: string | null | undefined) {
  return code ? availabilityCodeLabels[code] ?? '当前条件不支持手动解除' : '当前不可手动解除'
}

export function riskErrorMessage(reason: unknown, fallback: string) {
  const code = reason instanceof Error ? reason.message : ''
  const labels: Record<string, string> = {
    risk_summary_not_found: '账户风险数据尚未生成',
    risk_policy_not_found: '尚未取得账户风控规则',
    risk_account_forbidden: '当前账户不可访问，请重新选择账户',
    risk_summary_revision_conflict: '风险数据已更新，请刷新后重试',
    revision_conflict: '设置已更新，请刷新后重新编辑',
  }
  return labels[code] ?? fallback
}
export function riskDataReason(code: string) {
  const labels: Record<string, string> = {
    terminal_clock_unverified: '账户交易时区尚未确认',
    history_incomplete: '交易历史仍需补齐',
    account_snapshot_missing: '账户资金数据尚未同步',
    positions_incomplete: '持仓数据尚未同步完整',
    pending_orders_incomplete: '挂单数据尚未同步完整',
  }
  return labels[code] ?? '部分风险计算数据尚未准备完整'
}

export function riskActionLabel(kind: string) {
  return ({ market_order: '市价开仓', pending_order: '设置挂单', close_position: '平仓', partial_close: '部分平仓', modify_position: '调整持仓保护', modify_order: '修改挂单', cancel_order: '撤销挂单' } as Record<string, string>)[kind] ?? '交易操作'
}
export function riskDetailFields(value: Record<string, unknown>) {
  const labels: Record<string, string> = { symbol: '品种', ticket: '订单号', volume: '手数', price: '价格', stop_loss: '止损', take_profit: '止盈', spread_points: '点差', risk_percent: '风险比例', risk_amount: '风险金额', close_percent: '平仓比例', resolved_volume: '平仓手数', remaining_volume: '剩余手数' }
  return Object.entries(value).flatMap(([key, raw]) => labels[key] && (typeof raw === 'number' && Number.isFinite(raw) || typeof raw === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw)) ? [{ label: labels[key]!, value: String(raw) }] : [])
}
