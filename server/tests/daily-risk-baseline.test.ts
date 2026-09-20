import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { projectDailyRiskBaseline } from '../src/modules/risk/infrastructure/mysql-daily-risk-baseline.js'
import { sha256Canonical } from '../src/shared/canonical-json.js'
const facts = { accountId: '1', ownershipIntervalId: 'owner-1', businessDate: '2026-09-15', observedAt: '2026-09-15T08:00:00.000Z', historyComplete: true, equity: '1000', floatingPnl: '0', realizedNet: '0', netCapitalFlow: '0' }
const row = { business_date: facts.businessDate, observed_at: '2026-09-15T07:00:00.000000Z', day_start_equity: '1000', equity_high_water: '1000', net_capital_flow: '0', daily_loss_percent: '0', drawdown_percent: '0', revision: 2, source_hash: 'old' }
function fixture(current: unknown = null, allowed = true) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT o.user_id')) return [allowed ? [{ user_id: 1 }] : []]
    if (sql.includes('FROM account_daily_risk_baselines')) return [current ? [current] : []]
    return [[{ id: 1 }]]
  })
  return { execute, connection: { execute } as unknown as Pick<PoolConnection, 'execute'> }
}
it('creates a new day in the caller transaction and retains decimal values', async () => {
  const f = fixture()
  expect(await projectDailyRiskBaseline(f.connection, 1, facts, null)).toEqual({ applied: true, revision: 1, dailyLossPercent: 0, drawdownPercent: 0 })
  expect(f.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1)
})
it('checks ownership before accepting even an identical snapshot', async () => {
  const f = fixture({ ...row, source_hash: sha256Canonical(facts) }, false)
  await expect(projectDailyRiskBaseline(f.connection, 2, facts, 2)).rejects.toThrow('daily_risk_account_forbidden')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})
it('does not write a replay and does not compound capital flow', async () => {
  const f = fixture({ ...row, source_hash: sha256Canonical(facts) })
  expect((await projectDailyRiskBaseline(f.connection, 1, facts, 1)).applied).toBe(false)
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})
it('rejects stale revisions and incomplete history before persistence', async () => {
  await expect(projectDailyRiskBaseline(fixture(row).connection, 1, facts, 1)).rejects.toThrow('daily_risk_revision_conflict')
  const f = fixture()
  await expect(projectDailyRiskBaseline(f.connection, 1, { ...facts, historyComplete: false }, null)).rejects.toThrow('daily_risk_history_incomplete')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})
it('starts a new daily revision while rejecting older dates', async () => {
  const f = fixture(row)
  expect((await projectDailyRiskBaseline(f.connection, 1, { ...facts, businessDate: '2026-09-16', observedAt: '2026-09-16T08:00:00.000Z' }, null)).revision).toBe(1)
  await expect(projectDailyRiskBaseline(fixture(row).connection, 1, { ...facts, businessDate: '2026-09-14' }, null)).rejects.toThrow('daily_risk_snapshot_stale')
})
