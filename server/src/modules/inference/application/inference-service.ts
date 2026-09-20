import { randomUUID } from 'node:crypto'
import type { ActiveStrategyVersionReader } from '../../strategies/index.js'
import type { AnalysisInputSnapshot, AnalysisWorkClaim, JsonObject, MarketAnalysisResult, TraderDecisionResult, TraderInputSnapshot, TraderWorkClaim } from '../domain/inference.js'
import { assertConfidence, assertMarketAnalysisResult, assertTraderDecisionResult, contentHash, InferenceError, normalizeSymbol, snapshotHash } from '../domain/inference.js'
import { applyTraderTakeProfit } from '../domain/trader-take-profit.js'
import type { InferenceRepository } from './inference-ports.js'

const MANUAL_COOLDOWN_SECONDS = 300

export class InferenceService {
  constructor(private readonly repository: InferenceRepository, private readonly strategies: ActiveStrategyVersionReader) {}

  async requestManualAnalysis(userId: number, strategyId: string, symbolInput: string, idempotencyKey: string, now = new Date()) {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new InferenceError('idempotency_key_invalid', 422)
    const strategy = await this.strategies.requireActiveVersion(userId, strategyId, 'analysis')
    return this.repository.queueAnalysis({
      id: randomUUID(), userId, strategyId, strategyVersionId: strategy.id, symbol: normalizeSymbol(symbolInput),
      trigger: 'manual', scheduleSlot: null, marketSourceAccountId: null,
      idempotencyKey, requestedAt: now.toISOString(), manualCooldownSeconds: MANUAL_COOLDOWN_SECONDS,
    })
  }

  async requestScheduledAnalysis(input: { userId: number; strategyId: string; strategyVersionId: string; symbol: string; marketSourceAccountId: string; scheduleSlot: string }, now = new Date()) {
    const strategy = await this.strategies.requireActiveVersion(input.userId, input.strategyId, 'analysis')
    if (strategy.id !== input.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
    const slot = new Date(input.scheduleSlot)
    if (!Number.isFinite(slot.getTime())) throw new InferenceError('schedule_slot_invalid', 422)
    const symbol = normalizeSymbol(input.symbol)
    return this.repository.queueAnalysis({
      id: randomUUID(), userId: input.userId, strategyId: input.strategyId, strategyVersionId: strategy.id,
      symbol, trigger: 'scheduled', scheduleSlot: slot.toISOString(), marketSourceAccountId: input.marketSourceAccountId,
      idempotencyKey: `scheduled:${strategy.id}:${symbol}:${slot.toISOString()}`,
      requestedAt: now.toISOString(), manualCooldownSeconds: MANUAL_COOLDOWN_SECONDS,
    })
  }

  async beginAnalysis(userId: number, runId: string, expectedRevision: number, snapshot: AnalysisInputSnapshot, model: { profileId: string | null; provider: string; model: string }, workerId: string, deadlineAt: string) {
    return this.repository.beginAnalysis({
      runId, userId, expectedRevision, snapshotId: randomUUID(), snapshot, snapshotHash: snapshotHash(snapshot),
      taskId: randomUUID(), attemptId: randomUUID(), modelProfileId: model.profileId, provider: model.provider,
      model: model.model, workerId, deadlineAt,
    })
  }

  async completeAnalysis(claim: AnalysisWorkClaim, result: MarketAnalysisResult, usage: JsonObject | null = null,
    allowAutomaticTraderDispatch = true) {
    assertMarketAnalysisResult(result)
    assertConfidence(result.confidence)
    const analyzedAt = Date.parse(result.analyzedAt)
    const validUntil = Date.parse(result.validUntil)
    if (!Number.isFinite(analyzedAt) || !Number.isFinite(validUntil) || validUntil <= analyzedAt) throw new InferenceError('analysis_validity_invalid', 422)
    return this.repository.completeAnalysis({
      runId: claim.run.id, userId: claim.run.userId, expectedRevision: claim.run.revision,
      marketAnalysisId: randomUUID(), taskId: claim.taskId, attemptId: claim.attemptId,
      fencingToken: claim.fencingToken, usage, result, allowAutomaticTraderDispatch,
    })
  }

  failAnalysisAttempt(claim: AnalysisWorkClaim, model: { provider: string; model: string }, error: { code: string; status: 'failed' | 'timed_out' | 'contract_invalid'; retryable: boolean }, maxAttempts: number) {
    return this.repository.failAnalysisAttempt({
      runId: claim.run.id, userId: claim.run.userId, expectedRevision: claim.run.revision,
      taskId: claim.taskId, attemptId: claim.attemptId, attemptNumber: claim.attemptNumber,
      fencingToken: claim.fencingToken, provider: model.provider, model: model.model,
      errorCode: error.code, failureStatus: error.status, retryable: error.retryable, maxAttempts,
    })
  }

  async requestAccountEvaluation(userId: number, input: Omit<Parameters<InferenceRepository['requestTraderEvaluation']>[0], 'id' | 'userId' | 'requestedAt' | 'idempotencyKey'>, idempotencyKey: string, now = new Date()) {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new InferenceError('idempotency_key_invalid', 422)
    if (!Number.isSafeInteger(input.subscriptionRevision) || input.subscriptionRevision < 1) throw new InferenceError('subscription_revision_invalid', 422)
    const strategy = await this.strategies.requireActiveVersion(userId, input.strategyId, 'trader')
    if (strategy.id !== input.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
    return this.repository.requestTraderEvaluation({ ...input, id: randomUUID(), userId, idempotencyKey, requestedAt: now.toISOString() })
  }

  async beginTrader(userId: number, runId: string, expectedRevision: number, snapshot: TraderInputSnapshot, model: { profileId: string | null; provider: string; model: string }, workerId: string, deadlineAt: string) {
    if (typeof snapshot.account.id !== 'string' || !snapshot.account.id) throw new InferenceError('trader_account_snapshot_invalid', 422)
    if (contentHash(snapshot.analysis.result) !== snapshot.analysis.contentHash) throw new InferenceError('trader_analysis_payload_hash_mismatch', 422)
    return this.repository.beginTrader({
      runId, userId, expectedRevision, snapshotId: randomUUID(), snapshot, snapshotHash: snapshotHash(snapshot),
      taskId: randomUUID(), attemptId: randomUUID(), modelProfileId: model.profileId, provider: model.provider,
      model: model.model, workerId, deadlineAt,
    })
  }

  async completeTrader(claim: TraderWorkClaim, snapshot: TraderInputSnapshot, result: TraderDecisionResult, usage: JsonObject | null = null) {
    assertConfidence(result.confidence)
    assertTraderDecisionResult(result, snapshot)
    const selectedResult = applyTraderTakeProfit(snapshot, result)
    return this.repository.completeTrader({
      runId: claim.run.id, userId: claim.run.userId, expectedRevision: claim.run.revision, decisionId: randomUUID(),
      taskId: claim.taskId, attemptId: claim.attemptId, fencingToken: claim.fencingToken, usage, result: selectedResult,
    })
  }

  failTraderAttempt(claim: TraderWorkClaim, model: { provider: string; model: string }, error: { code: string; status: 'failed' | 'timed_out' | 'contract_invalid'; retryable: boolean }, maxAttempts: number) {
    return this.repository.failTraderAttempt({
      runId: claim.run.id, userId: claim.run.userId, expectedRevision: claim.run.revision,
      taskId: claim.taskId, attemptId: claim.attemptId, attemptNumber: claim.attemptNumber,
      fencingToken: claim.fencingToken, provider: model.provider, model: model.model,
      errorCode: error.code, failureStatus: error.status, retryable: error.retryable, maxAttempts,
    })
  }

  analysis(userId: number, analysisId: string) { return this.repository.getAnalysisDetail(userId, analysisId) }
  decisions(userId: number, accountId: string, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new InferenceError('decision_list_limit_invalid', 400)
    return this.repository.listTraderDecisions(userId, accountId, limit)
  }
  decision(userId: number, decisionId: string) { return this.repository.getTraderDecision(userId, decisionId) }
}
