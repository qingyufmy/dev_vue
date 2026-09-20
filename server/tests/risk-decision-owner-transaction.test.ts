import { expect, it, vi } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { MysqlRiskRepository } from '../src/modules/risk/infrastructure/mysql-risk-repository.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy, riskPolicyHash } from '../src/modules/risk/domain/risk.js'
import type { CompleteRiskReviewInput } from '../src/modules/risk/application/risk-ports.js'
import { createMysqlTradeDecisionRiskWriter } from '../src/modules/inference/infrastructure/mysql-trade-decision-risk-writer.js'
import { contentHash, type DecisionStrategyEvidence } from '../src/modules/inference/index.js'
import { readStrategyBudgetContext } from '../src/modules/risk/application/strategy-budget-context.js'

function fixture(recorded: boolean) {
  const date = '2026-09-09T00:00:00.000Z'
  const policy = resolveRiskPolicy({ accountId: '7', userId: 42, platformPolicyVersionId: '101',
    accountPolicyVersionId: null, policySetRevision: 0, platform: { values: DEFAULT_RISK_POLICY, globalKillSwitch: false, revision: 1 },
    account: null, updatedAt: date })
  const statements: string[] = []
  const execute = vi.fn(async (sql: string) => {
    statements.push(sql)
    if (sql.startsWith('SELECT CAST(trading_account_id')) return [[{ trading_account_id: '7', user_id: 42 }]]
    if (sql.startsWith('SELECT id FROM trading_accounts')) return [[{ id: '7' }]]
    if (sql.startsWith('SELECT revision,status')) return [[{ revision: 2, status: 'proposed', risk_decision_id: null }]]
    if (sql.startsWith('SELECT revision FROM account_risk_states')) return [[{ revision: 1 }]]
    if (sql.startsWith('SELECT a.revision')) return [[Object.fromEntries(['analysis', 'subscription', 'account', 'positions', 'pending_orders', 'quote', 'contract', 'risk'].map(key => [key + '_revision', 1]))]]
    if (sql.includes("p.scope='platform'")) return [[{ version_id: '101', policy_json: DEFAULT_RISK_POLICY, updated_at_utc: date }]]
    if (sql.includes("p.scope='account'")) return [[]]
    if (sql.startsWith('SELECT kill_switch')) return [[{ kill_switch: 0, revision: 1 }]]
    if (sql.startsWith('INSERT INTO ')) return [{ affectedRows: 1 }]
    if (sql.includes('FROM risk_decisions_v4 rd')) return [[{ id: 'risk-1', created_at_utc: date }]]
    throw Error('unexpected SQL')
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  const recordRiskReview = vi.fn(async () => recorded)
  const factory = vi.fn(() => ({ recordRiskReview }))
  const repository = new MysqlRiskRepository({ getConnection: async () => connection } as unknown as Pool, factory)
  const input = { decisionId: 'decision-1', riskDecisionId: 'risk-1', decisionRevision: 2, accountRiskRevision: 1,
    policySetRevision: 0, expectedRevisions: { analysis: 1, subscription: 1, account: 1, positions: 1, pendingOrders: 1, quote: 1, contract: 1, risk: 1 },
    evaluation: { status: 'approved', policyHash: riskPolicyHash(policy), manualReleaseId: null, evaluatedAt: date },
  } as CompleteRiskReviewInput
  return { repository, input, connection, factory, recordRiskReview, statements }
}

it('binds the owner capability to the risk transaction and commits risk, decision and outbox together', async () => {
  const f = fixture(true)
  await f.repository.completeReview(f.input)
  expect(f.factory).toHaveBeenCalledWith(f.connection)
  expect(f.recordRiskReview).toHaveBeenCalledWith({ decisionId: 'decision-1', userId: 42, accountId: '7',
    expectedRevision: 2, riskDecisionId: 'risk-1', outcome: 'approved' })
  expect(f.connection.commit).toHaveBeenCalledOnce()
  expect(f.connection.rollback).not.toHaveBeenCalled()
  expect(f.statements.some(sql => sql.startsWith('INSERT INTO outbox_events'))).toBe(true)
  expect(f.statements.some(sql => sql.startsWith('UPDATE trade_decisions'))).toBe(false)
})

it('rolls back the risk writes on owner revision conflict before creating outbox', async () => {
  const f = fixture(false)
  await expect(f.repository.completeReview(f.input)).rejects.toMatchObject({ code: 'risk_trade_decision_revision_conflict', status: 409 })
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
  expect(f.statements.some(sql => sql.startsWith('INSERT INTO outbox_events'))).toBe(false)
})

it('rolls back when the injected owner writer fails without leaking its driver error', async () => {
  const f = fixture(true)
  f.recordRiskReview.mockRejectedValueOnce(Error('private driver details'))
  await expect(f.repository.completeReview(f.input)).rejects.toMatchObject({ code: 'risk_storage_unavailable' })
  expect(f.connection.rollback).toHaveBeenCalledOnce()
  expect(f.connection.commit).not.toHaveBeenCalled()
})

it('owner adapter scopes compare-and-set to user, account, version and unreviewed status', async () => {
  const execute = vi.fn().mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([[{ payload_json: { actions: [] }, content_sha256: contentHash({ actions: [] }) }]])
    .mockResolvedValueOnce([{ affectedRows: 0 }])
  const writer = createMysqlTradeDecisionRiskWriter({ execute } as unknown as PoolConnection)
  const input = { decisionId: 'd', userId: 42, accountId: '7', expectedRevision: 2, riskDecisionId: 'r', outcome: 'rejected' as const }
  expect(await writer.recordRiskReview(input)).toBe(true)
  expect(await writer.recordRiskReview(input)).toBe(false)
  expect(execute.mock.calls[0]?.[1]).toEqual(['r', 'risk_rejected', 'd', 42, '7', 2])
  expect(execute.mock.calls[0]?.[0]).toContain("AND status='proposed' AND risk_decision_id IS NULL")
})

it.each(['same', 'changed', 'missing', 'regime_same', 'regime_changed', 'regime_unknown'] as const)('revalidates strategy budget on the risk transaction before writes: %s', async mode => {
  const f = fixture(true), config = { risk_budget: mode.startsWith('regime_')
    ? { version: 2, max_risk_per_trade_percent: '1', default_risk_per_trade_percent: '0.5', market_regime_limits: { continuation: '1', reversal: '0.5' } }
    : { version: 1, max_risk_per_trade_percent: '0.5' } }
  const evidence: DecisionStrategyEvidence = { decisionId: 'decision-1', decisionRevision: 2, userId: 42, accountId: '7',
    decisionHash: 'd'.repeat(64), snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64),
    strategyScope: { subscriptionId: '8', subscriptionRevision: 1, userId: 42, accountId: '7', traderStrategyId: '20',
      traderStrategyVersionId: '21', configHash: contentHash(config), promptHash: 'b'.repeat(64) } }
  const configValue = { config, configHash: contentHash(config), promptHash: evidence.strategyScope.promptHash, strategyId: '20', versionId: '21' }
  if (mode.startsWith('regime_')) evidence.analysisMarketRegime = mode === 'regime_unknown' ? 'unknown' : 'reversal'
  const evidenceReader = { read: vi.fn(async () => evidence) }, configReader = { read: vi.fn(async () => configValue) }
  const context = await readStrategyBudgetContext({ decisionId: 'decision-1', decisionRevision: 2, decisionHash: evidence.decisionHash,
    policy: { userId: 42, accountId: '7' } as never, currentRevisions: f.input.expectedRevisions }, evidenceReader, configReader)
  f.input.strategyBudgetContext = { ...context }
  expect(context.strategyRiskCeilingPercent).toBe('0.5')
  if (mode === 'regime_changed') evidence.analysisMarketRegime = 'continuation'
  if (mode === 'changed') f.input.strategyBudgetContext.strategyRiskCeilingPercent = '2'
  if (mode === 'missing') delete f.input.strategyBudgetContext
  const evidenceFactory = vi.fn(() => evidenceReader), configFactory = vi.fn(() => configReader)
  const repository = new MysqlRiskRepository({ getConnection: async () => f.connection } as unknown as Pool, f.factory,
    undefined, undefined, { evidence: evidenceFactory, config: configFactory })
  if (mode === 'same' || mode === 'regime_same' || mode === 'regime_unknown') {
    await repository.completeReview(f.input)
    expect(f.connection.commit).toHaveBeenCalledOnce()
    expect(evidenceFactory).toHaveBeenCalledWith(f.connection)
    expect(configFactory).toHaveBeenCalledWith(f.connection)
  } else {
    await expect(repository.completeReview(f.input)).rejects.toMatchObject({ code: mode === 'missing' ? 'risk_strategy_evidence_missing' : 'risk_strategy_budget_changed' })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.statements.some(sql => sql.startsWith('INSERT'))).toBe(false)
  }
})
