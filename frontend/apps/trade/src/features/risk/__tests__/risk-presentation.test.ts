import { expect, it } from 'vitest'
import type { RiskPolicy, RiskSummary } from '@aurum/contracts'
import { riskState, riskErrorMessage, riskDetailFields, ratio } from '../model/risk-presentation'
const now = Date.parse('2026-09-15T08:00:00Z')
const policy = { globalKillSwitch: false, accountKillSwitch: false, tradeSendEnabled: true, maxRiskSummaryAgeSeconds: 30, maxDailyLossPercent: 5, maxDrawdownPercent: 10, maxOpenPositions: 10, maxPendingOrders: 10, maxTotalVolume: 10, maxDailyOpenCount: 10, consecutiveLossLimit: 5 } as unknown as RiskPolicy
const summary = { observedAt: new Date(now).toISOString(), clockStatus: 'calibrated', terminalTimezoneOffsetMinutes: 180, dataComplete: true, incompleteReasons: [], dailyLossPercent: 0, drawdownPercent: 0, openPositions: 0, pendingOrders: 0, totalVolume: '0', dailyOpenCount: 0, consecutiveLosses: 0, cooldownUntil: null } as unknown as RiskSummary
it('does not hide known account blocks when summary is absent', () => {
  expect(riskState({ ...policy, accountKillSwitch: true }, null, now).level).toBe('blocked')
  expect(riskState(policy, null, now).level).toBe('unknown')
  expect(riskState({ ...policy, tradeSendEnabled: false }, summary, now).level).toBe('healthy')
})
it('stale, future and uncalibrated snapshots never appear healthy', () => {
  expect(riskState(policy, summary, now).level).toBe('healthy')
  for (const observedAt of [new Date(now - 31000).toISOString(), new Date(now + 6000).toISOString(), 'invalid']) expect(riskState(policy, { ...summary, observedAt }, now).level).toBe('blocked')
  expect(riskState(policy, { ...summary, clockStatus: 'stale' }, now).level).toBe('blocked')
})
it('does not expose internal diagnostics or payload keys', () => {
  expect(riskErrorMessage(Error('risk_summary_not_found'), '无法读取')).toBe('账户风险数据尚未生成')
  expect(riskErrorMessage(Error('SELECT secret'), '无法读取')).toBe('无法读取')
  expect(riskDetailFields({ symbol: 'XAUUSD.s', snapshot_hash: 'secret', volume: '0.01' })).toEqual([{ label: '品种', value: 'XAUUSD.s' }, { label: '手数', value: '0.01' }])
  expect(ratio('invalid', 10)).toBe(0)
})
