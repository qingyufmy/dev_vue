import { expect, it } from 'vitest'
import { calculateDailyRiskMetrics, type DailyRiskFacts } from '../src/modules/risk/domain/daily-risk-metrics.js'
const facts: DailyRiskFacts = { accountId: '1', ownershipIntervalId: 'owner-1', businessDate: '2026-09-15', observedAt: '2026-09-15T08:00:00.000Z', historyComplete: true, equity: '1000', floatingPnl: '0', realizedNet: '0', netCapitalFlow: '0' }
it('reconstructs the day baseline and does not offset losses with floating gains', () => {
  const result = calculateDailyRiskMetrics({ ...facts, equity: '990', realizedNet: '-20', floatingPnl: '10' }, null)
  expect(result.baseline.dayStartEquity).toBe('1000.00000000')
  expect(result.dailyLossPercent).toBe(2)
})
it('corrects cash flow and preserves the same-day high water', () => {
  const baseline = calculateDailyRiskMetrics(facts, null).baseline
  const next = calculateDailyRiskMetrics({ ...facts, equity: '1180', realizedNet: '-20', netCapitalFlow: '200' }, baseline)
  expect(next.baseline.equityHighWater).toBe('1200.00000000')
  expect(next.dailyLossPercent).toBe(2)
  expect(next.drawdownPercent).toBe(1.666667)
  expect(calculateDailyRiskMetrics({ ...facts, equity: '800', netCapitalFlow: '-200' }, baseline).drawdownPercent).toBe(0)
})
it('starts a new day from its first complete snapshot instead of yesterday peak', () => {
  const previous = calculateDailyRiskMetrics({ ...facts, equity: '2000' }, null).baseline
  const next = calculateDailyRiskMetrics({ ...facts, businessDate: '2026-09-16', observedAt: '2026-09-16T08:00:00.000Z', equity: '900' }, previous)
  expect(next.drawdownPercent).toBe(0)
  expect(next.baseline.dayStartEquity).toBe('900.00000000')
})
it('replaying full totals does not apply cash flow twice', () => {
  const current = { ...facts, equity: '1100', netCapitalFlow: '100' }
  const first = calculateDailyRiskMetrics(current, null)
  expect(calculateDailyRiskMetrics(current, first.baseline)).toEqual(first)
})
it.each([{ historyComplete: false }, { equity: 'NaN' }, { equity: '0' }, { observedAt: 'invalid' }, { businessDate: '2026-02-30' }])('rejects incomplete or invalid facts %j', patch => {
  expect(() => calculateDailyRiskMetrics({ ...facts, ...patch }, null)).toThrow()
})
it('rejects account mixing and time reversal without modifying the prior state', () => {
  const previous = calculateDailyRiskMetrics(facts, null).baseline
  const frozen = structuredClone(previous)
  expect(() => calculateDailyRiskMetrics({ ...facts, accountId: '2' }, previous)).toThrow('daily_risk_scope_mismatch')
  expect(() => calculateDailyRiskMetrics({ ...facts, observedAt: '2026-09-15T07:00:00.000Z' }, previous)).toThrow('daily_risk_snapshot_stale')
  expect(previous).toEqual(frozen)
})
