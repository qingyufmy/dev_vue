import { evaluateTraderRisk } from '../src/modules/risk/application/trader-risk-review.js'
import { riskRoutes } from '../src/modules/risk/transport/http/risk-routes.js'
import { riskPolicyHash } from '../src/modules/risk/domain/risk.js'
import { resolveStrategyRiskBudget } from '../src/modules/strategies/index.js'
import { withPositionSizingContext } from '../src/modules/risk/application/position-sizing-context.js'
import { contentHash, type ProposedDecisionEvidence, type ProposedDecisionEvidenceReader } from '../src/modules/inference/index.js'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { TraderAction, TraderDecisionResult } from '../src/modules/inference/index.js'
import {
  buildAccountRiskSummary, DEFAULT_RISK_POLICY, evaluateRisk, resolveRiskPolicy, RiskError,
  assessManualRelease, RiskReviewWorker, RiskService,
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
  async getPolicyReceipt() { return null }
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
  return { ...values, maxOrderVolume: 1 }
}

describe('Stage 12D deterministic risk review', () => {
  it('resolves percentage closes in both reducing-only and mixed approved actions', () => {
    const close = action({ actionId: 'partial-1', kind: 'close_position', parameters: { ticket: 'p-1', close_percent: '80' } })
    for (const actions of [[close], [close, action()]]) {
      const candidate = input({ result: decision(actions) }); candidate.positions[0]!.symbol = 'XAUUSD'
      const evaluated = evaluateRisk(candidate, now)
      expect(evaluated.status).toBe('approved')
      expect(evaluated.approvedActions[0]!.parameters).toEqual({ ticket: 'p-1', volume: '0.08' })
      expect(candidate.result.actions[0]!.parameters).toEqual({ ticket: 'p-1', close_percent: '80' })
      expect(evaluated.rules).toContainEqual(expect.objectContaining({ code: 'RISK_PARTIAL_CLOSE_VOLUME_RESOLVED' }))
    }
  })
  it('does not approve an impossible partial close or a conflicting explicit volume', () => {
    const close = action({ kind: 'close_position', parameters: { ticket: 'p-1', close_percent: '80' } })
    const candidate = input({ result: decision([close]) }); candidate.positions[0] = { ticket: 'p-1', symbol: 'XAUUSD', volume: '0.01' }
    expect(evaluateRisk(candidate, now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_PARTIAL_CLOSE_BELOW_MINIMUM', approvedActions: [] })
    close.parameters.volume = null
    expect(evaluateRisk(candidate, now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_PARTIAL_CLOSE_MODE_CONFLICT' })
  })
  it('rejects opening in a direction excluded by the broker while retaining a permitted buy', () => {
    const candidate = input()
    for (const allowedOpenSides of [[], ['sell']] as Array<Array<'buy' | 'sell'>>) {
      expect(evaluateRisk({ ...candidate, instrument: { ...candidate.instrument, allowedOpenSides } }, now).rejectCode)
        .toBe('RISK_INSTRUMENT_DIRECTION_DISABLED')
    }
    expect(evaluateRisk({ ...candidate, instrument: { ...candidate.instrument, allowedOpenSides: ['buy'] } }, now).status).toBe('approved')
  })
  it('does not apply an otherwise valid historical release after the capability is disabled', () => {
    const blocked = summary({ dailyLossPercent: 3.2 })
    const disabled = policy()
    disabled.values.manualReleaseEnabled = false
    expect(assessManualRelease(disabled, blocked, now)).toEqual({ available: false, code: 'risk_manual_release_disabled' })
    expect(evaluateRisk(input({ policy: disabled, summary: blocked, manualRelease: manualRelease(blocked) }), now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_DAILY_LOSS_LIMIT', manualReleaseId: null })
  })

  it('enforces each order volume independently from aggregate exposure', () => {
    const limited = policy({ maxOrderVolume: 0.05 })
    expect(evaluateRisk(input({ policy: limited }), now)).toMatchObject({ rejectCode: 'RISK_ORDER_VOLUME_LIMIT' })
    const equal = action({ parameters: { ...action().parameters, volume: '0.05' } })
    expect(evaluateRisk(input({ policy: limited, result: decision([equal]) }), now)).toMatchObject({ status: 'approved' })
    const pending = action({ kind: 'pending_order', parameters: { ...action().parameters, price: '3530.20' } })
    expect(evaluateRisk(input({ policy: limited, result: decision([pending]) }), now)).toMatchObject({ rejectCode: 'RISK_ORDER_VOLUME_LIMIT' })
    expect(() => policy({ maxOrderVolume: 2 })).toThrow()
  })

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
    await expect(new RiskService(repository).replacePolicy(42, '7', 3, {}, '没有实际变更', 'original-policy-key')).rejects.toMatchObject({ code: 'risk_policy_changes_required' })
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

  it('rejects explicit volume even when a sub-float equity difference exceeds the budget', () => {
    const bounded = action({ parameters: { ...action().parameters, stop_loss: '3520.20' } })
    const candidate = input({ result: decision([bounded]), policy: policy({ maxRiskPerTradePercent: 1 }) })
    expect(evaluateRisk(candidate, now).status).toBe('approved')
    candidate.summary.equity = '9999.999999999999999999'
    expect(evaluateRisk(candidate, now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_PER_TRADE_LIMIT' })
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

  it.each([{ userId: 9 }, { accountId: '8' }])('rejects a replay receipt outside the request principal or account: %j', async (foreignScope) => {
    const repository = new MemoryRiskRepository()
    repository.currentSummary = summary({ dailyLossPercent: 3.2 })
    const service = new RiskService(repository)
    const request = { userId: 42, accountId: '7', expectedSummaryRevision: 6, idempotencyKey: 'release-scope-test', acknowledgeRisk: true, reason: '确认风险后恢复交易' }
    const release = await service.createManualRelease(request, now)
    repository.currentRelease = { ...release, ...foreignScope }
    await expect(service.createManualRelease(request, now)).rejects.toMatchObject({ code: 'risk_account_forbidden', status: 403 })
    expect(repository.currentRelease).toEqual({ ...release, ...foreignScope })
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
    const updated = await app.inject({ method: 'PUT', url: '/api/v4/risk-accounts/7/policy', headers: { 'if-match': '"3"', 'idempotency-key': 'original-policy-key', 'x-csrf-token': 'csrf-test-token-0123456789abcdef' }, payload: { max_risk_per_trade_percent: '0.5', reason: '降低单笔风险' } })
    expect(updated.statusCode).toBe(200); expect(repository.replaceInput).toMatchObject({ expectedRevision: 3, patch: { maxRiskPerTradePercent: 0.5 } })
    const missingCas = await app.inject({ method: 'PUT', url: '/api/v4/risk-accounts/7/policy', payload: { reason: '无版本' } })
    expect(missingCas.statusCode).toBe(428)
    repository.currentSummary = summary({ dailyLossPercent: 3.2 })
    const available = await app.inject({ method: 'GET', url: '/api/v4/risk-accounts/7/manual-release' })
    expect(available.json().data).toMatchObject({ release: null, availability: { available: true, rules: ['RISK_DAILY_LOSS_LIMIT'], policy_set_revision: '4', risk_state_revision: '6' } })
    const released = await app.inject({ method: 'POST', url: '/api/v4/risk-accounts/7/manual-release', headers: { 'if-match': '"6"', 'idempotency-key': 'release-request-http-1', 'x-csrf-token': 'csrf-test-token-0123456789abcdef' }, payload: { acknowledge_risk: true, reason: '确认风险后恢复交易' } })
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
    expect(openapi).toContain('stage-12s-authoritative-trade-history')
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


describe('server-owned position tier action resolution', () => {
  function evidenceReader(value: RiskEvaluationInput, change?: (evidence: ProposedDecisionEvidence) => void): ProposedDecisionEvidenceReader {
    const evidence: ProposedDecisionEvidence = { decisionId: value.decisionId, decisionRevision: value.decisionRevision,
      userId: value.policy.userId, accountId: value.policy.accountId, analysisRevision: value.currentRevisions.analysis,
      decisionHash: contentHash(value.result), confidence: 80, analysisId: 'analysis-1', snapshotId: 'snapshot-1', snapshotHash: 'a'.repeat(64),
      symbol: 'XAUUSD', capturedAt: now.toISOString(), market: { candles: { H1: [{}] },
        candle_coverage: { version: 1, status: 'complete', frames: [{ timeframe: 'H1', requested_bars: 1, available_bars: 1 }] } } }
    change?.(evidence)
    return { async read() { return evidence } }
  }
  it('builds trusted context from the public evidence port and retains its provenance', async () => {
    const value = tierInput()
    const prepared = await withPositionSizingContext(value, evidenceReader(value))
    const evaluation = evaluateRisk(prepared, now)
    expect(evaluation.status).toBe('approved')
    expect(prepared.positionSizingContext!.actions[0]!.applyAddCap).toBe(false)
    expect(evaluation.rules.find(rule => rule.code === 'RISK_POSITION_SIZE_RESOLVED')!.details.source_evidence)
      .toEqual({ snapshotId: 'snapshot-1', snapshotHash: 'a'.repeat(64), decisionHash: contentHash(value.result) })
  })
  it('caps partial frozen coverage without using the model dataGaps claim', async () => {
    const value = tierInput()
    const prepared = await withPositionSizingContext(value, evidenceReader(value, evidence => {
      evidence.market = { candles: { H1: [{}] }, candle_coverage: { version: 1, status: 'partial',
        frames: [{ timeframe: 'H1', requested_bars: 2, available_bars: 1 }] } }
    }))
    expect(evaluateRisk(prepared, now).approvedActions[0]!.parameters.volume).toBe('0.02')
  })
  it('discards stale supplied context when frozen evidence is absent or mismatched', async () => {
    const value = tierInput()
    for (const change of [
      (evidence: ProposedDecisionEvidence) => { delete evidence.market.candle_coverage },
      (evidence: ProposedDecisionEvidence) => { evidence.decisionHash = 'mismatched' },
      (evidence: ProposedDecisionEvidence) => { evidence.symbol = 'EURUSD' },
      (evidence: ProposedDecisionEvidence) => { evidence.market.candles = { H1: [] } },
    ]) {
      const prepared = await withPositionSizingContext(value, evidenceReader(value, change))
      expect(prepared.positionSizingContext).toBeUndefined()
      expect(evaluateRisk(prepared, now).rejectCode).toBe('RISK_POSITION_SIZING_CONTEXT_MISSING')
    }
  })
  function tierInput() {
    const value = input()
    delete value.result.actions[0]!.parameters.volume
    value.result.actions[0]!.parameters.position_size_tier = 'standard'
    value.positionSizingContext = { decisionId: value.decisionId, decisionRevision: value.decisionRevision,
      userId: value.policy.userId, accountId: value.policy.accountId, policyHash: riskPolicyHash(value.policy),
      revisions: { ...value.currentRevisions }, actions: [{ actionId: 'action-1', evidenceCap: 'standard', applyAddCap: false }] }
    return value
  }
  it.each(['fixed', 'reversal', 'unknown', 'continuation'])('uses the trusted strategy ceiling for explicit volume and tier sizing: %s', regime => {
    const value = tierInput()
    const selected = resolveStrategyRiskBudget(regime === 'fixed' ? { version: 1, max_risk_per_trade_percent: '0.5' }
      : { version: 2, max_risk_per_trade_percent: '1', default_risk_per_trade_percent: '0.5', market_regime_limits: { continuation: '1', reversal: '0.5' } }, regime)
    value.strategyBudgetContext = { decisionId: value.decisionId, decisionRevision: value.decisionRevision,
      userId: value.policy.userId, accountId: value.policy.accountId, subscriptionRevision: value.currentRevisions.subscription,
      decisionHash: contentHash(value.result), snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), strategyId: '20', versionId: '21',
      promptHash: 'b'.repeat(64), configHash: 'c'.repeat(64), strategyRiskCeilingPercent: selected.ceiling!,
      ...(selected.selection ? { strategyRiskSelection: selected.selection } : {}) }
    const evaluated = evaluateRisk(value, now)
    expect(evaluated.status).toBe('approved')
    expect(evaluated.approvedActions[0]!.parameters.volume).toBe(regime === 'continuation' ? '0.1' : '0.05')
    expect(evaluated.rules).toContainEqual(expect.objectContaining({ code: 'RISK_STRATEGY_BUDGET_VERIFIED',
      details: expect.objectContaining({ strategy_risk_ceiling_percent: selected.ceiling, config_hash: 'c'.repeat(64) }) }))
    expect(evaluateRisk({ ...value, result: decision() }, now).rejectCode).toBe(regime === 'continuation' ? null : 'RISK_PER_TRADE_LIMIT')
    const inflated = decision()
    inflated.actions[0]!.parameters.risk_ceiling_percent = '100'
    expect(evaluateRisk({ ...value, result: inflated }, now).rejectCode).toBe(regime === 'continuation' ? null : 'RISK_PER_TRADE_LIMIT')
    value.strategyBudgetContext.subscriptionRevision++
    expect(evaluateRisk(value, now).rejectCode).toBe('RISK_STRATEGY_BUDGET_CONTEXT_STALE')
  })
  it('applies an action ceiling after the tier and never relaxes the account cap', () => {
    const value = tierInput()
    value.result.actions[0]!.parameters.position_size_tier = 'light'
    value.result.actions[0]!.parameters.risk_ceiling_percent = '0.5'
    const reviewed = evaluateRisk(value, now)
    expect(reviewed.status).toBe('approved')
    expect(reviewed.approvedActions[0]!.parameters.volume).toBe('0.05')
    expect(reviewed.rules).toContainEqual(expect.objectContaining({ code: 'RISK_ACTION_APPROVED',
      details: expect.objectContaining({ action_risk_ceiling_percent: '0.5' }) }))
    const fixed = input()
    fixed.result.actions[0]!.parameters.risk_ceiling_percent = '0.5'
    expect(evaluateRisk(fixed, now).rejectCode).toBe('RISK_PER_TRADE_LIMIT')
    fixed.result.actions[0]!.parameters.risk_ceiling_percent = '100'
    fixed.result.actions[0]!.parameters.volume = '1'
    expect(evaluateRisk(fixed, now).rejectCode).toBe('RISK_PER_TRADE_LIMIT')
    fixed.result.actions[0]!.parameters.risk_ceiling_percent = null
    expect(evaluateRisk(fixed, now).rejectCode).toBe('RISK_ACTION_RISK_CEILING_INVALID')
  })
  it('returns a concrete approved volume without mutating the model proposal', () => {
    const value = tierInput(), evaluated = evaluateRisk(value, now)
    expect(evaluated.status).toBe('approved')
    expect(evaluated.approvedActions[0]!.parameters.volume).toBe('0.1')
    expect(evaluated.approvedActions[0]!.parameters.position_size_tier).toBeUndefined()
    expect(value.result.actions[0]!.parameters.volume).toBeUndefined()
    expect(value.result.actions[0]!.parameters.position_size_tier).toBe('standard')
    expect(evaluateRisk({ ...value, result: { ...value.result, actions: evaluated.approvedActions } }, now).status).toBe('approved')
    expect(evaluated.rules.some(rule => rule.code === 'RISK_POSITION_SIZE_RESOLVED')).toBe(true)
  })
  it('hands the resolved volume and audit rule to the persistence port', async () => {
    const repository = new MemoryRiskRepository()
    repository.candidate = tierInput()
    const worker = new RiskReviewWorker(repository)
    await worker.process('decision-1', now)
    expect(repository.completeInput!.evaluation.status).toBe('approved')
    expect(repository.completeInput!.evaluation.approvedActions[0]!.parameters.volume).toBe('0.1')
    expect(repository.completeInput!.evaluation.approvedActions[0]!.parameters.position_size_tier).toBeUndefined()
    expect(repository.completeInput!.evaluation.rules.find(rule => rule.code === 'RISK_POSITION_SIZE_RESOLVED')!.details.requested_tier).toBe('standard')
    expect(repository.candidate.result.actions[0]!.parameters.volume).toBeUndefined()
  })
  it('uses the trusted evidence cap and add state instead of model parameters', () => {
    const value = tierInput()
    value.positionSizingContext!.actions[0]!.applyAddCap = true
    value.result.actions[0]!.parameters.is_add = false
    expect(evaluateRisk(value, now).approvedActions[0]!.parameters.volume).toBe('0.02')
    value.positionSizingContext!.actions[0]!.applyAddCap = false
    value.positionSizingContext!.actions[0]!.evidenceCap = 'light'
    expect(evaluateRisk(value, now).approvedActions[0]!.parameters.volume).toBe('0.05')
  })
  it('rejects ambiguous sizing and missing server context', () => {
    const value = tierInput()
    value.result.actions[0]!.parameters.volume = '0.1'
    expect(evaluateRisk(value, now).rejectCode).toBe('RISK_POSITION_SIZE_MODE_CONFLICT')
    delete value.result.actions[0]!.parameters.volume
    delete value.positionSizingContext
    expect(evaluateRisk(value, now).rejectCode).toBe('RISK_POSITION_SIZING_CONTEXT_MISSING')
  })
  it('binds sizing evidence to the decision, policy and current revisions', () => {
    for (const change of [
      (value: RiskEvaluationInput) => { value.positionSizingContext!.decisionId = 'other' },
      (value: RiskEvaluationInput) => { value.positionSizingContext!.policyHash = 'stale' },
      (value: RiskEvaluationInput) => { value.positionSizingContext!.revisions.positions++ },
    ]) {
      const value = tierInput(); change(value)
      expect(evaluateRisk(value, now).rejectCode).toBe('RISK_POSITION_SIZING_CONTEXT_STALE')
    }
  })
  it('keeps aggregate exposure limits effective after sizing', () => {
    const value = tierInput(); value.summary.totalVolume = '0.99'
    const evaluated = evaluateRisk(value, now)
    expect(evaluated.rejectCode).toBe('RISK_TOTAL_VOLUME_LIMIT')
    expect(evaluated.approvedActions).toEqual([])
  })
  it('preserves the explicit volume path without requiring tier context', () => {
    const value = input()
    expect(evaluateRisk(value, now).approvedActions[0]!.parameters.volume).toBe('0.10')
  })
})


it('rechecks a newer quote and binds only the approved copy to it', () => {
  const candidate = input({ currentRevisions: { ...revisions, quote: 10 },
    quote: { ...input().quote, revision: 10 } })
  const frozen = structuredClone(candidate)
  const evaluation = evaluateTraderRisk(candidate, now)
  expect(evaluation.status).toBe('approved')
  expect(evaluation.approvedActions[0]!.expectedState.quoteRevision).toBe(10)
  expect(evaluation.rules.some(rule => rule.code === 'RISK_QUOTE_REVIEWED')).toBe(true)
  expect(candidate).toEqual(frozen)
})

it('rejects an excessive spread in the new quote rather than merely rebinding revisions', () => {
  const candidate = input({ currentRevisions: { ...revisions, quote: 10 },
    quote: { ...input().quote, ask: '3540', revision: 10 } })
  expect(evaluateTraderRisk(candidate, now)).toMatchObject({ status: 'rejected', rejectCode: 'RISK_SPREAD_LIMIT', approvedActions: [] })
})

it.each(['positions', 'pendingOrders', 'contract', 'risk', 'subscription'] as const)(
  'still rejects changed %s during quote review', key => {
    const candidate = input({ currentRevisions: { ...revisions, quote: 10, [key]: revisions[key] + 1 },
      quote: { ...input().quote, revision: 10 } })
    const evaluation = evaluateTraderRisk(candidate, now)
    expect(evaluation.status).toBe('rejected')
    expect(evaluation.approvedActions).toEqual([])
  })

it('rejects torn and regressed quote evidence', () => {
  expect(() => evaluateTraderRisk(input({ currentRevisions: { ...revisions, quote: 10 } }), now))
    .toThrow('risk_review_quote_revision_conflict')
  expect(() => evaluateTraderRisk(input({ currentRevisions: { ...revisions, quote: 8 },
    quote: { ...input().quote, revision: 8 } }), now)).toThrow('risk_review_quote_revision_conflict')
})


it('persists the freshly reviewed quote with the worker approval', async () => {
  const repository = new MemoryRiskRepository()
  repository.candidate = input({ currentRevisions: { ...revisions, quote: 10 },
    quote: { ...input().quote, revision: 10 } })
  expect(await new RiskReviewWorker(repository).process('decision-1', now)).toMatchObject({ status: 'approved' })
  expect(repository.completeInput?.expectedRevisions.quote).toBe(10)
  expect(repository.completeInput?.evaluation.approvedActions[0]?.expectedState.quoteRevision).toBe(10)
  expect(repository.candidate.result.actions[0]?.expectedState.quoteRevision).toBe(9)
})


it('re-evaluates refreshed account and risk data and preserves the frozen proposal', async () => {
  const repository = new MemoryRiskRepository()
  repository.candidate = input({ currentRevisions: { ...revisions, account: 10, risk: 7 },
    summary: summary({ revision: 7, equity: '11000', freeMargin: '10800' }) })
  const frozen = structuredClone(repository.candidate.result)
  expect(await new RiskReviewWorker(repository).process('decision-1', now)).toMatchObject({ status: 'approved' })
  expect(repository.completeInput?.evaluation.approvedActions[0]?.expectedState)
    .toMatchObject({ accountRevision: 10, riskRevision: 7 })
  expect(repository.candidate.result).toEqual(frozen)
})

it.each([
  [{ dailyLossPercent: 99 }, 'RISK_PLATFORM_DAILY_LOSS_LIMIT'],
  [{ dataComplete: false }, 'RISK_DATA_INCOMPLETE'],
  [{ observedAt: '2026-09-02T09:00:00.000Z' }, 'RISK_SUMMARY_STALE'],
])('rejects newly unsafe or stale risk data', (change, code) => {
  const evaluation = evaluateTraderRisk(input({ currentRevisions: { ...revisions, account: 10, risk: 7 },
    summary: summary({ revision: 7, ...change }) }), now)
  expect(evaluation).toMatchObject({ status: 'rejected', rejectCode: code, approvedActions: [] })
})

it.each(['account', 'risk'] as const)('rejects regressed or missing %s revisions', key => {
  for (const value of [0, revisions[key] - 1]) {
    expect(() => evaluateTraderRisk(input({ currentRevisions: { ...revisions, [key]: value } }), now))
      .toThrow(`risk_review_${key}_revision_conflict`)
  }
})


it('does not approve the original size after equity falls below its risk budget', () => {
  expect(evaluateTraderRisk(input({ currentRevisions: { ...revisions, account: 10, risk: 7 },
    summary: summary({ revision: 7, equity: '9000', freeMargin: '8800' }) }), now))
    .toMatchObject({ status: 'rejected', approvedActions: [] })
})


it('re-reads and rejects deteriorated risk after a rolled-back review conflict', async () => {
  const repository = new MemoryRiskRepository()
  const save = repository.completeReview.bind(repository)
  let calls = 0
  repository.completeReview = async value => {
    if (++calls === 1) {
      repository.candidate = input({ currentRevisions: { ...revisions, risk: 7 }, summary: summary({ revision: 7, dailyLossPercent: 99 }) })
      throw new RiskError('risk_summary_revision_conflict', 409)
    }
    return save(value)
  }
  expect(await new RiskReviewWorker(repository).process('decision-1', now)).toMatchObject({ status: 'rejected' })
  expect(calls).toBe(2)
  expect(repository.completeInput?.evaluation.approvedActions).toEqual([])
})

it('bounds repeated context conflicts to three fresh reviews', async () => {
  const repository = new MemoryRiskRepository()
  let calls = 0
  repository.completeReview = async () => { calls++; throw new RiskError('risk_review_context_revision_conflict', 409) }
  expect(await new RiskReviewWorker(repository).process('decision-1', now)).toMatchObject({ status: 'stale' })
  expect(calls).toBe(3)
})

const capturedPosition = { accountId: '7', ticket: 'manual-1', symbol: 'XAUUSD.s', side: 'buy', volume: '0.01',
  openPrice: '3500', stopLoss: '3490', takeProfit: null, revision: 12, currentPrice: '3529', floatingProfit: '29' }
it('reviews unchanged manual positions and binds only the approved position revision', () => {
  const candidate = input({ positions: [{ ...capturedPosition, revision: 13, currentPrice: '3530', floatingProfit: '30' }],
    frozenPositions: { positions: [capturedPosition], revision: 12 }, currentRevisions: { ...revisions, positions: 13 } })
  const original = structuredClone(candidate)
  const evaluated = evaluateTraderRisk(candidate, now)
  expect(evaluated.status).toBe('approved')
  expect(evaluated.approvedActions[0]!.expectedState.positionsRevision).toBe(13)
  expect(candidate).toEqual(original)
})
it.each([{ volume: '0.02' }, { stopLoss: '3480' }, { takeProfit: '3600' }, { revision: 14 }, { ticket: 'other' }])(
  'rejects changed or inconsistent position evidence %j', change => {
    const candidate = input({ positions: [{ ...capturedPosition, revision: 13, ...change }],
      frozenPositions: { positions: [capturedPosition], revision: 12 }, currentRevisions: { ...revisions, positions: 13 } })
    expect(evaluateTraderRisk(candidate, now).status).toBe('rejected')
  })
