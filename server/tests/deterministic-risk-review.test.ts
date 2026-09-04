import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { TraderAction, TraderDecisionResult } from '../src/modules/inference/index.js'
import {
  buildAccountRiskSummary, DEFAULT_RISK_POLICY, evaluateRisk, resolveRiskPolicy, RiskError,
  assessManualRelease, RiskReviewWorker, riskRoutes, RiskService,
  type AccountRiskSummary, type CompleteRiskReviewInput, type EffectiveRiskPolicy,
  type CreateManualRiskReleaseInput, type ManualRiskRelease, type ReplaceAccountRiskPolicyInput, type RiskDecisionDetail, type RiskDecisionSummary,
  type RiskEvaluationInput, type RiskRepository, type SaveRiskSummaryInput,
} from '../src/modules/risk/index.js'

const now = new Date('2026-09-03T09:00:10.000Z')
const revisions = { analysis: 2, subscription: 4, account: 8, positions: 12, pendingOrders: 13, quote: 9, contract: 7, risk: 6 }

function policy(account = {}, globalKillSwitch = false): EffectiveRiskPolicy {
  return resolveRiskPolicy({
    accountId: '7', userId: 42, platformPolicyVersionId: '101', accountPolicyVersionId: '102', policySetRevision: 3,
    platform: { values: platformValues(), globalKillSwitch, revision: 2 },
    account: { tradeSendEnabled: true, ...account }, updatedAt: '2026-09-03T08:00:00.000Z',
  })
}

function summary(overrides: Partial<AccountRiskSummary> = {}): AccountRiskSummary {
  return {
    accountId: '7', userId: 42, businessDate: '2026-09-03', equity: '10000', freeMargin: '9800', marginLevelPercent: 5000,
    dailyLossPercent: 0.5, drawdownPercent: 1, openPositions: 1, pendingOrders: 0, totalVolume: '0.10',
    dailyOpenCount: 1, consecutiveLosses: 0, lastSuccessfulOpenAt: '2026-09-03T08:50:00.000Z', cooldownUntil: null,
    terminalTimezoneOffsetMinutes: 180, clockStatus: 'calibrated',
    dataComplete: true, incompleteReasons: [], observedAt: '2026-09-03T09:00:08.000Z', revision: 6, ...overrides,
  }
}

const expectedState = {
  analysisRevision: 2, subscriptionRevision: 4, accountRevision: 8, positionsRevision: 12,
  pendingOrdersRevision: 13, quoteRevision: 9, contractRevision: 7, riskRevision: 6,
}

function action(overrides: Partial<TraderAction> = {}): TraderAction {
  return {
    actionId: 'action-1', kind: 'market_order',
    parameters: { symbol: 'XAUUSD', side: 'buy', volume: '0.10', stop_loss: '3521', reference_price: '3530.20' },
    expectedState, ...overrides,
  }
}

function decision(actions: TraderAction[] = [action()]): TraderDecisionResult {
  return { action: actions[0]?.kind ?? 'hold', side: actions.length ? 'buy' : null, confidence: 80, summary: '账户可考虑执行', actions, reasoning: '账户和行情匹配' }
}

function input(overrides: Partial<RiskEvaluationInput> = {}): RiskEvaluationInput {
  return {
    decisionId: 'decision-1', decisionRevision: 1, decisionCreatedAt: '2026-09-03T09:00:00.000Z', decisionStatus: 'proposed',
    result: decision(), policy: policy(), summary: summary(),
    quote: { symbol: 'XAUUSD', bid: '3530.10', ask: '3530.20', observedAt: '2026-09-03T09:00:09.000Z', revision: 9 },
    instrument: { symbol: 'XAUUSD', point: '0.01', tickSize: '0.01', tickValue: '1', volumeMin: '0.01', volumeMax: '100', volumeStep: '0.01', tradeEnabled: true, revision: 7 },
    positions: [{ ticket: 'p-1', side: 'buy', volume: '0.10', currentPrice: '3530.10', stopLoss: '3510' }], pendingOrders: [], currentRevisions: revisions,
    ...overrides,
  }
}

function riskDecision(id = 'risk-1'): RiskDecisionSummary {
  return { id, tradeDecisionId: 'decision-1', userId: 42, accountId: '7', status: 'approved', rejectCode: null, platformPolicyVersionId: '101', accountPolicyVersionId: '102', accountRiskRevision: 6, manualReleaseId: null, createdAt: now.toISOString(), revision: 1 }
}

function manualRelease(blocked = summary({ dailyLossPercent: 3.2 })): ManualRiskRelease {
  const assessment = assessManualRelease(policy(), blocked, now)
  if (!assessment.available) throw new Error(assessment.code)
  return {
    id: 'release-1', userId: 42, accountId: '7', platformPolicyVersionId: '101', accountPolicyVersionId: '102',
    policySetRevision: 3, status: 'active', releasedRules: assessment.rules,
    baseline: assessment.baseline, riskStateRevision: blocked.revision, breachFingerprint: assessment.breachFingerprint,
    reason: '用户确认风险后恢复交易', expiresAt: assessment.expiresAt, createdAt: now.toISOString(),
    invalidatedAt: null, invalidationReason: null, revision: 1,
  }
}

class MemoryRiskRepository implements RiskRepository {
  candidate: RiskEvaluationInput | null = input()
  completeInput: CompleteRiskReviewInput | null = null
  replaceInput: ReplaceAccountRiskPolicyInput | null = null
  currentPolicy = policy()
  currentSummary = summary()
  currentRelease: ManualRiskRelease | null = null
  releaseRequestHash: string | null = null
  releaseIdempotencyKey: string | null = null

  async getEffectivePolicy(userId: number, accountId: string) { return userId === 42 && accountId === '7' ? this.currentPolicy : null }
  async replaceAccountPolicy(value: ReplaceAccountRiskPolicyInput) { this.replaceInput = value; this.currentPolicy = { ...this.currentPolicy, policySetRevision: value.expectedRevision + 1, values: { ...this.currentPolicy.values, ...value.patch }, updatedAt: value.changedAt }; return this.currentPolicy }
  async getAccountSummary(userId: number, accountId: string) { return userId === 42 && accountId === '7' ? this.currentSummary : null }
  async saveAccountSummary(value: SaveRiskSummaryInput) { this.currentSummary = value.summary; return value.summary }
  async createManualRelease(value: CreateManualRiskReleaseInput) { this.currentRelease = value.release; this.releaseRequestHash = value.requestHash; this.releaseIdempotencyKey = value.idempotencyKey; return value.release }
  async getManualReleaseByIdempotency(userId: number, accountId: string, idempotencyKey: string) { return userId === 42 && accountId === '7' && idempotencyKey === this.releaseIdempotencyKey && this.currentRelease && this.releaseRequestHash ? { release: this.currentRelease, requestHash: this.releaseRequestHash } : null }
  async getManualRelease(userId: number, accountId: string) { return userId === 42 && accountId === '7' ? this.currentRelease : null }
  async loadReviewCandidate(decisionId: string) { return decisionId === 'decision-1' ? this.candidate : null }
  async completeReview(value: CompleteRiskReviewInput) { this.completeInput = value; return { ...riskDecision(value.riskDecisionId), status: value.evaluation.status, rejectCode: value.evaluation.rejectCode } }
  async getDecision(userId: number, id: string): Promise<RiskDecisionDetail | null> { return userId === 42 ? { ...riskDecision(id), evaluation: evaluateRisk(input(), now) } : null }
  async listDecisions(userId: number, accountId: string) { return userId === 42 && accountId === '7' ? [riskDecision()] : [] }
}

function platformValues() {
  const { tradeSendEnabled: _tradeSendEnabled, accountKillSwitch: _accountKillSwitch, ...values } = DEFAULT_RISK_POLICY
  return values
}

describe('Stage 12D deterministic risk review', () => {
  it('keeps mandatory platform rules locked and rejects account relaxations outside the platform boundary', () => {
    expect(policy({ requireStopLoss: false } as never).values.requireStopLoss).toBe(true)
    expect(() => policy({ maxRiskPerTradePercent: 2 })).toThrowError(expect.objectContaining({ code: 'risk_policy_maxRiskPerTradePercent_relaxation_forbidden' }))
    expect(policy({ maxRiskPerTradePercent: 0.5 }).values.maxRiskPerTradePercent).toBe(0.5)
    expect(policy({}, true).globalKillSwitch).toBe(true)
    expect(() => resolveRiskPolicy({
      accountId: '7', userId: 42, platformPolicyVersionId: '101', accountPolicyVersionId: null, policySetRevision: 0,
      platform: { values: { ...platformValues(), maxRiskSummaryAgeSeconds: Number.NaN }, globalKillSwitch: false, revision: 1 },
      account: null, updatedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: 'risk_platform_numeric_rule_invalid' }))
  })

  it('rejects empty account policy writes and entries without a frozen reference price', async () => {
    const repository = new MemoryRiskRepository()
    await expect(new RiskService(repository).replacePolicy(42, '7', 3, {}, '没有实际变更')).rejects.toMatchObject({ code: 'risk_policy_changes_required' })
    const withoutReference = action({ parameters: { symbol: 'XAUUSD', side: 'buy', volume: '0.10', stop_loss: '3521' } })
    expect(evaluateRisk(input({ result: decision([withoutReference]) }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_REFERENCE_PRICE_REQUIRED' })
  })

  it('builds a normalized account summary and fails closed on contradictory completeness', () => {
    expect(buildAccountRiskSummary({ ...summary(), margin: '200', incompleteReasons: [] })).toMatchObject({ marginLevelPercent: 5000, dataComplete: true })
    expect(() => buildAccountRiskSummary({ ...summary(), margin: '200', incompleteReasons: ['history_gap'] })).toThrowError(expect.objectContaining({ code: 'risk_summary_completeness_conflict' }))
  })

  it('approves a current bounded entry without mutating the AI action', () => {
    const candidate = input(); const original = structuredClone(candidate.result)
    const result = evaluateRisk(candidate, now)
    expect(result).toMatchObject({ status: 'approved', rejectCode: null, approvedActions: [{ actionId: 'action-1' }] })
    expect(candidate.result).toEqual(original)
    expect(result.rules).toContainEqual(expect.objectContaining({ code: 'RISK_ACTION_APPROVED', details: expect.objectContaining({ risk_amount: 92, risk_percent: 0.92, volume: 0.1 }) }))
  })

  it('rejects incomplete state, stale expected revisions and per-trade risk deterministically', () => {
    expect(evaluateRisk(input({ summary: summary({ dataComplete: false, incompleteReasons: ['history_gap'] }) }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_DATA_INCOMPLETE' })
    const stale = action({ expectedState: { ...expectedState, quoteRevision: 8 } })
    expect(evaluateRisk(input({ result: decision([stale]) }), now)).toMatchObject({ rejectCode: 'RISK_EXPECTED_STATE_STALE' })
    const oversized = action({ parameters: { ...action().parameters, volume: '1.00' } })
    expect(evaluateRisk(input({ result: decision([oversized]) }), now)).toMatchObject({ rejectCode: 'RISK_PER_TRADE_LIMIT' })
    expect(evaluateRisk(input({ policy: policy({}, true) }), now)).toMatchObject({ rejectCode: 'RISK_GLOBAL_KILL_SWITCH' })
    expect(evaluateRisk(input({ summary: summary({ lastSuccessfulOpenAt: '2026-09-03T09:00:00.000Z' }) }), now)).toMatchObject({ rejectCode: 'RISK_MIN_OPEN_INTERVAL' })
    expect(evaluateRisk(input({ summary: summary({ observedAt: '2026-09-03T08:59:00.000Z' }) }), now)).toMatchObject({ rejectCode: 'RISK_SUMMARY_STALE' })
  })

  it('keeps the AI revision set strict while allowing explicit non-AI sources to bind only captured revisions', () => {
    const staleAnalysis = action({ expectedState: { ...expectedState, analysisRevision: 99 } })
    expect(evaluateRisk(input({ result: decision([staleAnalysis]) }), now)).toMatchObject({ rejectCode: 'RISK_EXPECTED_STATE_STALE' })
    expect(evaluateRisk(input({
      result: decision([staleAnalysis]),
      requiredRevisionKeys: ['account', 'positions', 'pendingOrders', 'quote', 'contract', 'risk'],
    }), now)).toMatchObject({ status: 'approved', rejectCode: null })
  })

  it('still validates account scope and risk revision for a no-execution hold result', () => {
    const hold = decision([])
    expect(evaluateRisk(input({ result: hold, summary: summary({ accountId: '8' }) }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_ACCOUNT_SCOPE_MISMATCH' })
    expect(evaluateRisk(input({ result: hold }), now)).toMatchObject({ status: 'approved', approvedActions: [] })
  })

  it('allows one audited account-level release but relocks on deterioration or a platform ceiling', () => {
    const blocked = summary({ dailyLossPercent: 3.2 })
    const released = evaluateRisk(input({ summary: blocked, manualRelease: manualRelease(blocked) }), now)
    expect(released).toMatchObject({ status: 'approved', manualReleaseId: 'release-1', manualReleaseRevision: 1 })
    expect(released.rules).toContainEqual(expect.objectContaining({ code: 'RISK_MANUAL_RELEASE_APPLIED', outcome: 'passed' }))
    expect(evaluateRisk(input({ summary: summary({ dailyLossPercent: 3.3 }), manualRelease: manualRelease(blocked) }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_DAILY_LOSS_LIMIT', manualReleaseId: null })
    expect(evaluateRisk(input({ summary: blocked, manualRelease: { ...manualRelease(blocked), platformPolicyVersionId: 'older-policy' } }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_DAILY_LOSS_LIMIT' })
    expect(evaluateRisk(input({ summary: summary({ dailyLossPercent: 5 }), manualRelease: manualRelease(blocked) }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_PLATFORM_DAILY_LOSS_LIMIT' })
    expect(assessManualRelease(policy(), summary({ dailyLossPercent: 5 }), now)).toEqual({ available: false, code: 'risk_manual_release_platform_limit' })
    expect(assessManualRelease(policy(), summary({ dailyLossPercent: 3.2, businessDate: '2026-02-30' }), now)).toEqual({ available: false, code: 'risk_manual_release_business_date_invalid' })
  })

  it('creates a manual release only after explicit acknowledgement and a current risk revision', async () => {
    const repository = new MemoryRiskRepository()
    repository.currentSummary = summary({ dailyLossPercent: 3.2 })
    const service = new RiskService(repository)
    await expect(service.createManualRelease({ userId: 42, accountId: '7', expectedSummaryRevision: 6, idempotencyKey: 'release-request-1', acknowledgeRisk: false, reason: '恢复交易' }, now)).rejects.toMatchObject({ code: 'risk_manual_release_acknowledgement_required' })
    const release = await service.createManualRelease({ userId: 42, accountId: '7', expectedSummaryRevision: 6, idempotencyKey: 'release-request-1', acknowledgeRisk: true, reason: '确认风险后恢复交易' }, now)
    expect(release).toMatchObject({ accountId: '7', status: 'active', releasedRules: ['RISK_DAILY_LOSS_LIMIT'], riskStateRevision: 6 })
    await expect(service.manualReleaseState(42, '7', now)).resolves.toMatchObject({
      release: { id: release.id, status: 'active' },
      availability: { available: false, code: 'risk_manual_release_already_active', rules: [], expiresAt: null, riskStateRevision: 6 },
    })
    await expect(service.createManualRelease({ userId: 42, accountId: '7', expectedSummaryRevision: 6, idempotencyKey: 'release-request-1', acknowledgeRisk: true, reason: '确认风险后恢复交易' }, now)).resolves.toMatchObject({ id: release.id })
    await expect(service.createManualRelease({ userId: 42, accountId: '7', expectedSummaryRevision: 6, idempotencyKey: 'release-request-1', acknowledgeRisk: true, reason: '修改后的恢复原因' }, now)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(assessManualRelease(policy({}, true), repository.currentSummary, now)).toEqual({ available: false, code: 'risk_manual_release_global_control' })
    await expect(service.manualRelease(9, '7')).rejects.toMatchObject({ code: 'risk_policy_not_found' })
  })

  it('allows exact close, cancel and tighter protection while risk-increasing actions remain halted', () => {
    const closed = action({ kind: 'close_position', parameters: { ticket: 'p-1' } })
    const halted = input({ policy: policy({ accountKillSwitch: true }), summary: summary({ dataComplete: false, incompleteReasons: ['history_gap'] }), result: decision([closed]) })
    expect(evaluateRisk(halted, now)).toMatchObject({ status: 'approved', approvedActions: [{ kind: 'close_position' }] })
    const tighter = action({ kind: 'modify_position', parameters: { ticket: 'p-1', stop_loss: '3520' } })
    expect(evaluateRisk(input({ policy: policy({ accountKillSwitch: true }), result: decision([tighter]) }), now)).toMatchObject({ status: 'approved' })
    const takeProfitOnly = action({ kind: 'modify_position', parameters: { ticket: 'p-1', take_profit: '3650' } })
    expect(evaluateRisk(input({ policy: policy({ accountKillSwitch: true }), result: decision([takeProfitOnly]) }), now)).toMatchObject({ status: 'approved' })
    const wider = action({ kind: 'modify_position', parameters: { ticket: 'p-1', stop_loss: '3500' } })
    expect(evaluateRisk(input({ result: decision([wider]) }), now)).toMatchObject({ rejectCode: 'RISK_MODIFICATION_REQUIRES_DETERMINISTIC_DIFF' })
  })

  it('persists one independent risk decision with frozen policy and account revisions and creates no execution intent', async () => {
    const repository = new MemoryRiskRepository()
    const result = await new RiskReviewWorker(repository).process('decision-1', now)
    expect(result).toMatchObject({ status: 'approved', decision: { tradeDecisionId: 'decision-1' } })
    expect(repository.completeInput).toMatchObject({ decisionId: 'decision-1', decisionRevision: 1, accountRiskRevision: 6, policySetRevision: 3, expectedRevisions: revisions, evaluation: { status: 'approved' } })
    expect(JSON.stringify(repository.completeInput)).not.toMatch(/execution_intent|bridge_command|terminal/i)
  })

  it('persists malformed market inputs as a fail-closed rejection instead of retrying forever', async () => {
    const repository = new MemoryRiskRepository()
    repository.candidate = input({ quote: { ...input().quote, ask: 'not-a-price' } })
    const result = await new RiskReviewWorker(repository).process('decision-1', now)
    expect(result).toMatchObject({ status: 'rejected', decision: { rejectCode: 'risk_quote_invalid' } })
    expect(repository.completeInput?.evaluation).toMatchObject({ approvedActions: [], rejectCode: 'risk_quote_invalid' })
  })

  it('drops a reviewed result when any locked revision changes before commit', async () => {
    const repository = new MemoryRiskRepository()
    repository.completeReview = async () => { throw new RiskError('risk_review_context_revision_conflict', 409) }
    await expect(new RiskReviewWorker(repository).process('decision-1', now)).resolves.toEqual({ status: 'stale', code: 'risk_review_context_revision_conflict' })
  })

  it('exposes policy CAS, summary and risk-decision HTTP resources with full payload only on HTTP', async () => {
    const repository = new MemoryRiskRepository(); const service = new RiskService(repository)
    const app = Fastify({ logger: false })
    await app.register(riskRoutes, { prefix: '/api/v4', service, auth: { async authenticate() { return { userId: 42 } }, async assertWrite() { return { userId: 42 } } } })
    const current = await app.inject({ method: 'GET', url: '/api/v4/risk-accounts/7/policy' })
    expect(current.statusCode).toBe(200); expect(current.headers.etag).toBe('"3"')
    expect(current.json().data).toMatchObject({ fail_closed_on_incomplete_data: true, max_quote_age_seconds: 15, max_risk_summary_age_seconds: 30 })
    const updated = await app.inject({ method: 'PUT', url: '/api/v4/risk-accounts/7/policy', headers: { 'if-match': '"3"' }, payload: { max_risk_per_trade_percent: '0.5', reason: '降低单笔风险' } })
    expect(updated.statusCode).toBe(200); expect(repository.replaceInput).toMatchObject({ expectedRevision: 3, patch: { maxRiskPerTradePercent: 0.5 } })
    const missingCas = await app.inject({ method: 'PUT', url: '/api/v4/risk-accounts/7/policy', payload: { reason: '无版本' } })
    expect(missingCas.statusCode).toBe(428)
    repository.currentSummary = summary({ dailyLossPercent: 3.2 })
    const available = await app.inject({ method: 'GET', url: '/api/v4/risk-accounts/7/manual-release' })
    expect(available.json().data).toMatchObject({ release: null, availability: { available: true, rules: ['RISK_DAILY_LOSS_LIMIT'], policy_set_revision: '4', risk_state_revision: '6' } })
    const released = await app.inject({ method: 'POST', url: '/api/v4/risk-accounts/7/manual-release', headers: { 'if-match': '"6"', 'idempotency-key': 'release-request-http-1' }, payload: { acknowledge_risk: true, reason: '确认风险后恢复交易' } })
    expect(released.statusCode).toBe(201); expect(released.json().data).toMatchObject({ status: 'active', released_rules: ['RISK_DAILY_LOSS_LIMIT'] })
    const currentRelease = await app.inject({ method: 'GET', url: '/api/v4/risk-accounts/7/manual-release' })
    expect(currentRelease.json().data.release).toMatchObject({ account_id: '7', risk_state_revision: '6' })
    expect(currentRelease.json().data.availability).toMatchObject({ available: true, code: null, rules: ['RISK_DAILY_LOSS_LIMIT'], policy_set_revision: '4', risk_state_revision: '6' })
    const detail = await app.inject({ method: 'GET', url: '/api/v4/risk-decisions/risk-1' })
    expect(detail.json().data).toHaveProperty('rules')
    await app.close()
  })

  it('adds append-only normalized migration and keeps execution, Bridge and external I/O outside Stage 12D', async () => {
    const sql = await readFile(new URL('../db/migrations/20260903_007_deterministic_risk_review.sql', import.meta.url), 'utf8')
    const releaseSql = await readFile(new URL('../db/migrations/20260903_008_manual_risk_release.sql', import.meta.url), 'utf8')
    const repository = await readFile(new URL('../src/modules/risk/infrastructure/mysql-risk-repository.ts', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS risk_policy_versions_v4')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS account_risk_states')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS risk_state_events')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS risk_decisions_v4')
    expect(sql).toContain('legacy_source_table')
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i)
    expect(releaseSql).toContain('CREATE TABLE IF NOT EXISTS risk_manual_releases')
    expect(releaseSql).toContain('breach_fingerprint')
    expect(releaseSql).toContain('uk_risk_manual_release_request')
    expect(releaseSql).toContain('legacy_source_table')
    expect(releaseSql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i)
    expect(repository).toContain("'risk.decision.created'")
    expect(repository).not.toMatch(/execution_intents|bridge_commands|command\.request|OrderSend/i)
  })

  it('publishes only small risk invalidation events and keeps policy, rules and approved actions on HTTP', async () => {
    const openapi = await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8')
    const realtime = await readFile(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8')
    expect(openapi).toContain('/risk-accounts/{account_id}/summary')
    expect(openapi).toContain('/risk-decisions/{risk_decision_id}')
    expect(openapi).toContain('approved_actions')
    expect(openapi).toContain('stage-12r-reviewer-memory-core')
    expect(openapi).toContain('/risk-accounts/{account_id}/manual-release')
    expect(realtime).toContain('risk.policy.changed')
    expect(realtime).toContain('risk.summary.changed')
    expect(realtime).toContain('risk.decision.created')
    expect(realtime).toContain('risk.manual_release.changed')
    expect(realtime).not.toContain('approved_actions')
    expect(realtime).not.toContain('breach_fingerprint')
    expect(realtime).not.toContain('released_rules')
  })
})
