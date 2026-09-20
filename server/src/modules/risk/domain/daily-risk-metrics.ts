/** Full, verified day totals. Caller must certify account ownership and history coverage. */
export interface DailyRiskFacts {
  accountId: string
  ownershipIntervalId: string
  businessDate: string
  observedAt: string
  historyComplete: boolean
  equity: string
  floatingPnl: string
  realizedNet: string
  netCapitalFlow: string
}
export interface DailyRiskBaseline {
  accountId: string
  ownershipIntervalId: string
  businessDate: string
  observedAt: string
  dayStartEquity: string
  equityHighWater: string
  netCapitalFlow: string
}
const scale = 100_000_000n
function money(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(value)) throw Error('daily_risk_money_invalid')
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  return (BigInt(whole!) * scale + BigInt(fraction.padEnd(8, '0'))) * (negative ? -1n : 1n)
}
function text(value: bigint) {
  const absolute = value < 0n ? -value : value
  return `${value < 0n ? '-' : ''}${absolute / scale}.${(absolute % scale).toString().padStart(8, '0')}`
}
function percent(loss: bigint, base: bigint) {
  // Six decimal places, rounded conservatively upward so a boundary cannot be understated.
  return loss <= 0n ? 0 : Number((loss * 100_000_000n + base - 1n) / base) / 1_000_000
}
function instant(value: string) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw Error('daily_risk_time_invalid')
  return parsed
}
export function calculateDailyRiskMetrics(facts: DailyRiskFacts, previous: DailyRiskBaseline | null) {
  if (!facts.historyComplete) throw Error('daily_risk_history_incomplete')
  if (!facts.accountId || !facts.ownershipIntervalId || !/^\d{4}-\d{2}-\d{2}$/.test(facts.businessDate)
    || new Date(`${facts.businessDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== facts.businessDate) throw Error('daily_risk_scope_invalid')
  const observed = instant(facts.observedAt)
  if (previous && (previous.accountId !== facts.accountId || previous.ownershipIntervalId !== facts.ownershipIntervalId)) throw Error('daily_risk_scope_mismatch')
  if (previous && (observed < instant(previous.observedAt) || facts.businessDate < previous.businessDate)) throw Error('daily_risk_snapshot_stale')
  const equity = money(facts.equity), floating = money(facts.floatingPnl), realized = money(facts.realizedNet), capital = money(facts.netCapitalFlow)
  const sameDay = previous?.businessDate === facts.businessDate
  const start = sameDay ? money(previous!.dayStartEquity) : equity - realized - floating - capital
  const correctedHigh = sameDay ? money(previous!.equityHighWater) + capital - money(previous!.netCapitalFlow) : equity
  const high = equity > correctedHigh ? equity : correctedHigh
  if (equity <= 0n || start <= 0n || high <= 0n) throw Error('daily_risk_baseline_invalid')
  // Preserve the reviewed rule: floating gains do not offset realized day losses.
  const dayPnl = realized + (floating < 0n ? floating : 0n)
  return {
    baseline: { accountId: facts.accountId, ownershipIntervalId: facts.ownershipIntervalId, businessDate: facts.businessDate,
      observedAt: facts.observedAt, dayStartEquity: text(start), equityHighWater: text(high), netCapitalFlow: text(capital) },
    dailyLossPercent: percent(-dayPnl, start), drawdownPercent: percent(high - equity, high),
  }
}
