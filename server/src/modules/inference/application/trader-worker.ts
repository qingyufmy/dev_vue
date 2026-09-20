import type { ActiveStrategyVersionReader } from '../../strategies/index.js'
import type { JsonObject, TraderDecisionResult, TraderInputSnapshot } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'
import { ModelInvocationError } from './analysis-worker.js'
import type { InferenceRepository } from './inference-ports.js'
import type { InferenceService } from './inference-service.js'
import type { TraderContextBuilder } from './trader-context-builder.js'
import type { TraderWindowGuard } from './trader-window-guard.js'

export interface TraderModelGateway {
  readonly profileId: string | null
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number
  decide(input: { taskId: string; attemptId: string; snapshot: TraderInputSnapshot; signal: AbortSignal }): Promise<{ result: TraderDecisionResult; usage: JsonObject | null }>
}

export interface TraderModelGatewayResolver {
  resolve(input: { userId: number; strategyId: string; strategyVersionId: string }): Promise<TraderModelGateway>
}

export class TraderWorker {
  constructor(
    private readonly repository: InferenceRepository,
    private readonly inference: InferenceService,
    private readonly strategies: ActiveStrategyVersionReader,
    private readonly contexts: TraderContextBuilder,
    private readonly modelSource: TraderModelGateway | TraderModelGatewayResolver,
    private readonly workerId: string,
    private readonly windows: TraderWindowGuard,
    private readonly currentTime: () => Date = () => new Date(),
  ) {}

  async process(runId: string, now = new Date()) {
    const run = await this.repository.getTraderRun(runId)
    if (!run || run.status !== 'queued') return { status: 'ignored' as const }

    let strategy
    let windowHash: string
    try {
      windowHash = await this.windows.assertAllowed(run, this.currentTime())
      strategy = await this.strategies.requireActiveVersion(run.userId, run.strategyId, 'trader')
      if (strategy.id !== run.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
    } catch (error) {
      await this.repository.failQueuedTrader(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    let model
    try {
      model = 'resolve' in this.modelSource
        ? await this.modelSource.resolve({ userId: run.userId, strategyId: run.strategyId, strategyVersionId: run.strategyVersionId })
        : this.modelSource
    } catch (error) {
      await this.repository.failQueuedTrader(run.id, errorCode(error, 'trader_model_unavailable'))
      return { status: 'failed' as const, code: errorCode(error, 'trader_model_unavailable') }
    }

    let snapshot
    try {
      snapshot = await this.contexts.build(run, strategy, now)
      snapshot.subscriptionWindowHash = windowHash
    } catch (error) {
      if (error instanceof InferenceError && error.code === 'trader_contract_pending') {
        return { status: 'deferred' as const, code: error.code, retryAfterMs: 5000 }
      }
      if (isPreparationConflict(error)) return { status: 'deferred' as const, code: error.code, retryAfterMs: 1000 }
      await this.repository.failQueuedTrader(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    const timeoutMs = normalizeTimeout(model.timeoutMs)
    const maxAttempts = normalizeAttempts(model.maxAttempts)
    let claim
    try {
      claim = await this.inference.beginTrader(
        run.userId, run.id, run.revision, snapshot,
        { profileId: model.profileId, provider: model.provider, model: model.model },
        this.workerId, new Date(now.getTime() + timeoutMs * maxAttempts).toISOString(),
      )
    } catch (error) {
      if (isPreparationConflict(error)) return { status: 'deferred' as const, code: error.code, retryAfterMs: 1000 }
      if (error instanceof InferenceError && error.code === 'trader_account_busy') return { status: 'deferred' as const, code: error.code, retryAfterMs: error.retryAfterMs }
      if (error instanceof InferenceError && ['trader_schedule_changed', 'trader_preferences_changed'].includes(error.code)) {
        await this.repository.failQueuedTrader(run.id, error.code)
        return { status: 'failed' as const, code: error.code }
      }
      if (error instanceof InferenceError && error.status === 409) return { status: 'ignored' as const, code: error.code }
      throw error
    }

    while (true) {
      let output
      try {
        if (await this.windows.assertAllowed(run, this.currentTime()) !== windowHash) throw new InferenceError('trader_schedule_changed', 409)
        output = await model.decide({ taskId: claim.taskId, attemptId: claim.attemptId, snapshot, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        const failure = modelFailure(error)
        const retry = await this.inference.failTraderAttempt(claim, model, failure, maxAttempts)
        if (!retry) return { status: 'failed' as const, code: failure.code }
        claim = retry
        continue
      }

      try {
        if (await this.windows.assertAllowed(run, this.currentTime()) !== windowHash) throw new InferenceError('trader_schedule_changed', 409)
        const decision = await this.inference.completeTrader(claim, snapshot, output.result, output.usage)
        return decision.status === 'stale' ? { status: 'stale' as const, decision } : { status: 'succeeded' as const, decision }
      } catch (error) {
        if (error instanceof InferenceError && ['trader_schedule_closed', 'trader_schedule_changed', 'subscription_revision_conflict'].includes(error.code)) {
          await this.inference.failTraderAttempt(claim, model, new ModelInvocationError(error.code, 'failed', false), maxAttempts)
          return { status: 'failed' as const, code: error.code }
        }
        if (error instanceof InferenceError && error.status === 409) return { status: 'ignored' as const, code: error.code }
        if (error instanceof InferenceError && error.status === 422) {
          await this.inference.failTraderAttempt(claim, model, new ModelInvocationError(error.code, 'contract_invalid', false), maxAttempts)
          return { status: 'failed' as const, code: error.code }
        }
        throw error
      }
    }
  }
}

function normalizeTimeout(value: number) { return Number.isFinite(value) ? Math.max(1_000, Math.trunc(value)) : 120_000 }
function normalizeAttempts(value: number) { return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 3) : 1 }
function errorCode(error: unknown, fallback = 'trader_preparation_failed') {
  if (error instanceof InferenceError) return error.code
  const code = error instanceof Error ? error.message : ''
  return /^[a-z0-9_]{3,128}$/.test(code) ? code : fallback
}
function modelFailure(error: unknown) {
  if (error instanceof ModelInvocationError) return error
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return new ModelInvocationError('model_timeout', 'timed_out', true)
  if (error instanceof InferenceError) return new ModelInvocationError(error.code, 'contract_invalid', false)
  return new ModelInvocationError('model_request_failed', 'failed', true)
}

function isPreparationConflict(error: unknown): error is InferenceError {
  return error instanceof InferenceError && [
    'trader_context_torn_read', 'trader_account_revision_conflict',
    'trader_projection_revision_conflict', 'trader_quote_revision_conflict',
    'trader_contract_revision_conflict', 'trader_risk_revision_conflict',
  ].includes(error.code)
}
