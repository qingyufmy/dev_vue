import { terminalDisplayDate } from '~/lib/terminal-display-time'
import type { RiskPolicy, RiskSummary } from '@aurum/contracts'

export const manualReleaseRuleLabels: Record<string, string> = {
  RISK_DAILY_LOSS_LIMIT: '当日亏损限制',
  RISK_DRAWDOWN_LIMIT: '账户回撤限制',
  RISK_DAILY_OPEN_LIMIT: '当日开仓次数限制',
  RISK_CONSECUTIVE_LOSS_LIMIT: '连续亏损限制',
  RISK_COOLDOWN_ACTIVE: '亏损冷静期',
}

export const rejectCodeLabels: Record<string, string> = {
  RISK_GLOBAL_KILL_SWITCH: '平台暂停交易',
  RISK_ACCOUNT_KILL_SWITCH: '账户暂停交易',
  RISK_TRADE_SEND_DISABLED: '交易发送已关闭',
  RISK_DATA_INCOMPLETE: '风险数据不完整',
  RISK_DAILY_LOSS_LIMIT: '触及当日亏损限制',
  RISK_DRAWDOWN_LIMIT: '触及账户回撤限制',
  RISK_OPEN_POSITION_LIMIT: '持仓数量超限',
  RISK_PENDING_ORDER_LIMIT: '挂单数量超限',
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
  risk_manual_release_trade_send_disabled: '请先开启交易发送',
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
  { key: 'maxDrawdownPercent', wire: 'max_drawdown_percent', label: '最大回撤上限', description: '账户回撤达到该比例后限制交易。', suffix: '%', step: '0.01', group: 'loss' },
  { key: 'maxOpenPositions', wire: 'max_open_positions', label: '最多持仓笔数', description: '当前账户可同时存在的持仓数量。', suffix: '笔', step: '1', group: 'exposure' },
  { key: 'maxPendingOrders', wire: 'max_pending_orders', label: '最多挂单笔数', description: '当前账户可同时存在的挂单数量。', suffix: '笔', step: '1', group: 'exposure' },
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

export function riskState(policy: RiskPolicy | null, summary: RiskSummary | null) {
  if (!policy || !summary) return { level: 'unknown' as const, title: '等待风险数据', detail: '正在读取当前账户的风险规则与实时摘要。', reasons: [] as string[] }
  const reasons: string[] = []
  if (policy.globalKillSwitch) reasons.push('平台已暂停交易')
  if (policy.accountKillSwitch) reasons.push('账户已手动暂停交易')
  if (!policy.tradeSendEnabled) reasons.push('交易发送已关闭')
  if (!summary.dataComplete) reasons.push('风险数据不完整')
  if (Number(summary.dailyLossPercent) >= Number(policy.maxDailyLossPercent)) reasons.push('触及当日亏损限制')
  if (Number(summary.drawdownPercent) >= Number(policy.maxDrawdownPercent)) reasons.push('触及账户回撤限制')
  if (summary.openPositions >= policy.maxOpenPositions) reasons.push('持仓数量达到上限')
  if (summary.pendingOrders >= policy.maxPendingOrders) reasons.push('挂单数量达到上限')
  if (Number(summary.totalVolume) >= Number(policy.maxTotalVolume)) reasons.push('总手数达到上限')
  if (summary.dailyOpenCount >= policy.maxDailyOpenCount) reasons.push('当日开仓次数达到上限')
  if (summary.consecutiveLosses >= policy.consecutiveLossLimit) reasons.push('连续亏损达到上限')
  if (summary.cooldownUntil && Date.parse(summary.cooldownUntil) > Date.now()) reasons.push('处于亏损冷静期')
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
  return Math.min(100, Math.max(0, Number(current) / maximum * 100))
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
  return manualReleaseRuleLabels[code] ?? code
}

export function rejectCodeLabel(code: string | null) {
  if (!code) return '通过全部风控规则'
  return rejectCodeLabels[code] ?? code
}

export function availabilityLabel(code: string | null | undefined) {
  return code ? availabilityCodeLabels[code] ?? code : '当前不可手动解除'
}
