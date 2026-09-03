import type { StrategyService } from '../../strategies/application/strategy-service.js'
import type { JsonObject, TraderDecisionResult, TraderInputSnapshot } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'
import { ModelInvocationError } from './analysis-worker.js'
import type { InferenceRepository } from './inference-ports.js'
import type { InferenceService } from './inference-service.js'
import type { TraderContextBuilder } from './trader-context-builder.js'

export interface TraderModelGateway {
  readonly profileId: string | null
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number
  decide(input: { taskId: string; attemptId: string; snapshot: TraderInputSnapshot; signal: AbortSignal }): Promise<{ result: TraderDecisionResult; usage: JsonObject | null }>
}

export class TraderWorker {
  constructor(
    private readonly repository: InferenceRepository,
    private readonly inference: InferenceService,
    private readonly strategies: StrategyService,
    private readonly contexts: TraderContextBuilder,
    private readonly model: TraderModelGateway,
    private readonly workerId: string,
  ) {}

  async process(runId: string, now = new Date()) {
    const run = await this.repository.getTraderRun(runId)
    if (!run || run.status !== 'queued') return { status: 'ignored' as const }

    let strategy
    let snapshot
    try {
      strategy = await this.strategies.requireActiveVersion(run.userId, run.strategyId, 'trader')
      if (strategy.id !== run.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
      snapshot = await this.contexts.build(run, strategy, now)
    } catch (error) {
      await this.repository.failQueuedTrader(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    const timeoutMs = normalizeTimeout(this.model.timeoutMs)
    const maxAttempts = normalizeAttempts(this.model.maxAttempts)
    let claim
    try {
      claim = await this.inference.beginTrader(
        run.userId, run.id, run.revision, snapshot,
        { profileId: this.model.profileId, provider: this.model.provider, model: this.model.model },
        this.workerId, new Date(now.getTime() + timeoutMs * maxAttempts).toISOString(),
      )
    } catch (error) {
      if (error instanceof InferenceError && error.code === 'trader_account_busy') return { status: 'deferred' as const, code: error.code, retryAfterMs: error.retryAfterMs }
      if (error instanceof InferenceError && error.status === 409) return { status: 'ignored' as const, code: error.code }
      throw error
    }

    while (true) {
      let output
      try {
        output = await this.model.decide({ taskId: claim.taskId, attemptId: claim.attemptId, snapshot, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        const failure = modelFailure(error)
        const retry = await this.inference.failTraderAttempt(claim, this.model, failure, maxAttempts)
        if (!retry) return { status: 'failed' as const, code: failure.code }
        claim = retry
        continue
      }

      try {
        const decision = await this.inference.completeTrader(claim, snapshot, output.result, output.usage)
        return decision.status === 'stale' ? { status: 'stale' as const, decision } : { status: 'succeeded' as const, decision }
      } catch (error) {
        if (error instanceof InferenceError && error.status === 409) return { status: 'ignored' as const, code: error.code }
        if (error instanceof InferenceError && error.status === 422) {
          await this.inference.failTraderAttempt(claim, this.model, new ModelInvocationError(error.code, 'contract_invalid', false), maxAttempts)
          return { status: 'failed' as const, code: error.code }
        }
        throw error
      }
    }
  }
}

function normalizeTimeout(value: number) { return Number.isFinite(value) ? Math.max(1_000, Math.trunc(value)) : 120_000 }
function normalizeAttempts(value: number) { return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 3) : 1 }
function errorCode(error: unknown) { return error instanceof InferenceError ? error.code : 'trader_preparation_failed' }
function modelFailure(error: unknown) {
  if (error instanceof ModelInvocationError) return error
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return new ModelInvocationError('model_timeout', 'timed_out', true)
  if (error instanceof InferenceError) return new ModelInvocationError(error.code, 'contract_invalid', false)
  return new ModelInvocationError('model_request_failed', 'failed', true)
}
