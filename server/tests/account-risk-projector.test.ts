import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlAccountRiskProjector, type VerifiedAccountRiskSource } from '../src/modules/risk/infrastructure/mysql-account-risk-projector.js'
const source: VerifiedAccountRiskSource = {
  facts: { accountId: '1', ownershipIntervalId: 'owner-1', businessDate: '2026-09-15', observedAt: '2026-09-15T08:00:00.000Z', historyComplete: true, equity: '1000', floatingPnl: '0', realizedNet: '0', netCapitalFlow: '0' },
  summary: { accountId: '1', userId: 1, businessDate: '2026-09-15', observedAt: '2026-09-15T08:00:00.000Z', equity: '1000', freeMargin: '900', margin: '100', openPositions: 1, pendingOrders: 0, totalVolume: '0.01', dailyOpenCount: 1, consecutiveLosses: 0, terminalTimezoneOffsetMinutes: 180, clockStatus: 'calibrated', lastSuccessfulOpenAt: null, cooldownUntil: null, dataComplete: true, revision: 1 },
  expectedBaselineRevision: null, expectedSummaryRevision: null,
}
function fixture(failSummary = false, captured: VerifiedAccountRiskSource | null = structuredClone(source)) {
  const execute = vi.fn(async (sql: string) => {
    if (failSummary && sql.startsWith('INSERT INTO account_risk_summaries')) throw Error('storage failed')
    if (sql.startsWith('SELECT id FROM trading_accounts') || sql.includes('SELECT o.user_id')) return [[{ id: '1', user_id: 1 }]]
    return [[]]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const capture = vi.fn(async () => captured)
  const projector = createMysqlAccountRiskProjector({ getConnection: async () => connection } as unknown as Pool, capture)
  return { connection, execute, projector }
}
it('commits baseline, summary and event together', async () => {
  const f = fixture()
  const result = await f.projector.project({ userId: 1, accountId: '1' })
  expect(result.marginLevelPercent).toBe(1000)
  for (const table of ['account_daily_risk_baselines', 'account_risk_states', 'account_risk_summaries', 'risk_state_events', 'outbox_events']) expect(f.execute.mock.calls.some(([sql]) => sql.startsWith(`INSERT INTO ${table}`))).toBe(true)
  expect(f.connection.beginTransaction).toHaveBeenCalledOnce()
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
it('rolls back the baseline too when summary persistence fails', async () => {
  const f = fixture(true)
  await expect(f.projector.project({ userId: 1, accountId: '1' })).rejects.toThrow('risk_storage_unavailable')
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
})
it('never writes when complete source evidence is absent', async () => {
  const f = fixture(false, null)
  await expect(f.projector.project({ userId: 1, accountId: '1' })).rejects.toThrow('risk_summary_source_unavailable')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})
it('rejects mixed account source facts before any baseline write', async () => {
  const mixed = structuredClone(source); mixed.summary.userId = 2
  const f = fixture(false, mixed)
  await expect(f.projector.project({ userId: 1, accountId: '1' })).rejects.toThrow('risk_summary_source_invalid')
  expect(f.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
})
