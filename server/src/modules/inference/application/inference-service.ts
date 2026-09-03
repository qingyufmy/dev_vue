import { randomUUID } from 'node:crypto'
import type { StrategyService } from '../../strategies/application/strategy-service.js'
import type { AnalysisInputSnapshot, MarketAnalysisResult, TraderDecisionResult, TraderInputSnapshot } from '../domain/inference.js'
import { assertConfidence, contentHash, InferenceError, normalizeSymbol, snapshotHash } from '../domain/inference.js'
import type { InferenceRepository } from './inference-ports.js'

const MANUAL_COOLDOWN_SECONDS = 180

export class InferenceService {
  constructor(private readonly repository: InferenceRepository, private readonly strategies: StrategyService) {}

  async requestManualAnalysis(userId: number, strategyId: string, symbolInput: string, idempotencyKey: string, now = new Date()) {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new InferenceError('idempotency_key_invalid', 422)
    const strategy = await this.strategies.requireActiveVersion(userId, strategyId, 'analysis')
    return this.repository.queueAnalysis({
      id: randomUUID(), userId, strategyId, strategyVersionId: strategy.id, symbol: normalizeSymbol(symbolInput),
      trigger: 'manual', idempotencyKey, requestedAt: now.toISOString(), manualCooldownSeconds: MANUAL_COOLDOWN_SECONDS,
    })
  }

  async beginAnalysis(userId: number, runId: string, expectedRevision: number, snapshot: AnalysisInputSnapshot) {
    return this.repository.beginAnalysis({ runId, userId, expectedRevision, snapshotId: randomUUID(), snapshot, snapshotHash: snapshotHash(snapshot) })
  }

  async completeAnalysis(userId: number, runId: string, expectedRevision: number, result: MarketAnalysisResult) {
    assertConfidence(result.confidence)
    const analyzedAt = Date.parse(result.analyzedAt)
    const validUntil = Date.parse(result.validUntil)
    if (!Number.isFinite(analyzedAt) || !Number.isFinite(validUntil) || validUntil <= analyzedAt) throw new InferenceError('analysis_validity_invalid', 422)
    return this.repository.completeAnalysis({ runId, userId, expectedRevision, marketAnalysisId: randomUUID(), result })
  }

  async requestAccountEvaluation(userId: number, input: Omit<Parameters<InferenceRepository['requestTraderEvaluation']>[0], 'id' | 'userId' | 'requestedAt' | 'idempotencyKey'>, idempotencyKey: string, now = new Date()) {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 128) throw new InferenceError('idempotency_key_invalid', 422)
    if (!Number.isSafeInteger(input.subscriptionRevision) || input.subscriptionRevision < 1) throw new InferenceError('subscription_revision_invalid', 422)
    const strategy = await this.strategies.requireActiveVersion(userId, input.strategyId, 'trader')
    if (strategy.id !== input.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
    return this.repository.requestTraderEvaluation({ ...input, id: randomUUID(), userId, idempotencyKey, requestedAt: now.toISOString() })
  }

  async beginTrader(userId: number, runId: string, expectedRevision: number, snapshot: TraderInputSnapshot) {
    if (typeof snapshot.account.id !== 'string' || !snapshot.account.id) throw new InferenceError('trader_account_snapshot_invalid', 422)
    if (contentHash(snapshot.analysis.result) !== snapshot.analysis.contentHash) throw new InferenceError('trader_analysis_payload_hash_mismatch', 422)
    return this.repository.beginTrader({ runId, userId, expectedRevision, snapshotId: randomUUID(), snapshot, snapshotHash: snapshotHash(snapshot) })
  }

  async completeTrader(userId: number, runId: string, expectedRevision: number, result: TraderDecisionResult) {
    assertConfidence(result.confidence)
    if (result.action === 'hold' && result.actions.length > 0) throw new InferenceError('hold_actions_forbidden', 422)
    if (result.action !== 'hold' && result.actions.length === 0) throw new InferenceError('trader_actions_required', 422)
    if (result.action !== 'hold' && !result.actions.some(action => action.kind === result.action)) throw new InferenceError('trader_action_summary_mismatch', 422)
    const actionIds = new Set(result.actions.map(action => action.actionId))
    if (actionIds.size !== result.actions.length) throw new InferenceError('trader_action_id_duplicate', 422)
    return this.repository.completeTrader({ runId, userId, expectedRevision, decisionId: randomUUID(), result })
  }

  analysis(userId: number, analysisId: string) { return this.repository.getAnalysisDetail(userId, analysisId) }
  analyses(userId: number, limit = 50) { return this.repository.listAnalyses(userId, Math.min(Math.max(limit, 1), 100)) }
  decisions(userId: number, accountId: string, limit = 50) { return this.repository.listTraderDecisions(userId, accountId, Math.min(Math.max(limit, 1), 100)) }
  decision(userId: number, decisionId: string) { return this.repository.getTraderDecision(userId, decisionId) }
}
