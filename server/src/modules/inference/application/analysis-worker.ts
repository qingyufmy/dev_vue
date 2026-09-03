import type { StrategyService } from '../../strategies/application/strategy-service.js'
import type { AnalysisInputSnapshot, JsonObject, MarketAnalysisResult } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'
import type { AnalysisContextBuilder } from './analysis-context-builder.js'
import type { InferenceRepository } from './inference-ports.js'
import type { InferenceService } from './inference-service.js'

export interface AnalysisModelGateway {
  readonly profileId: string | null
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number
  analyze(input: { taskId: string; attemptId: string; snapshot: AnalysisInputSnapshot; signal: AbortSignal }): Promise<{ result: MarketAnalysisResult; usage: JsonObject | null }>
}

export class ModelInvocationError extends Error {
  constructor(readonly code: string, readonly status: 'failed' | 'timed_out' | 'contract_invalid', readonly retryable: boolean) {
    super(code)
  }
}

export class AnalysisWorker {
  constructor(
    private readonly repository: InferenceRepository,
    private readonly inference: InferenceService,
    private readonly strategies: StrategyService,
    private readonly contexts: AnalysisContextBuilder,
    private readonly model: AnalysisModelGateway,
    private readonly workerId: string,
  ) {}

  async process(runId: string, now = new Date()) {
    const run = await this.repository.getAnalysisRun(runId)
    if (!run || run.status !== 'queued') return { status: 'ignored' as const }

    let strategy
    try {
      strategy = await this.strategies.requireActiveVersion(run.userId, run.strategyId, 'analysis')
      if (strategy.id !== run.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
    } catch (error) {
      await this.repository.failQueuedAnalysis(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    let snapshot
    try {
      snapshot = await this.contexts.build(run, strategy, now)
    } catch (error) {
      await this.repository.failQueuedAnalysis(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    const timeoutMs = normalizeTimeout(this.model.timeoutMs)
    const maxAttempts = normalizeAttempts(this.model.maxAttempts)
    let claim = await this.inference.beginAnalysis(
      run.userId, run.id, run.revision, snapshot,
      { profileId: this.model.profileId, provider: this.model.provider, model: this.model.model },
      this.workerId, new Date(now.getTime() + timeoutMs * maxAttempts).toISOString(),
    )

    while (true) {
      let output
      try {
        output = await this.model.analyze({ taskId: claim.taskId, attemptId: claim.attemptId, snapshot, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        const failure = modelFailure(error)
        const retry = await this.inference.failAnalysisAttempt(claim, this.model, failure, maxAttempts)
        if (!retry) return { status: 'failed' as const, code: failure.code }
        claim = retry
        continue
      }

      try {
        const completed = await this.inference.completeAnalysis(claim, output.result, output.usage)
        return { status: 'succeeded' as const, ...completed }
      } catch (error) {
        if (error instanceof InferenceError && error.status === 409) {
          return { status: 'ignored' as const, code: error.code }
        }
        if (error instanceof InferenceError && error.status === 422) {
          await this.inference.failAnalysisAttempt(
            claim,
            this.model,
            new ModelInvocationError(error.code, 'contract_invalid', false),
            maxAttempts,
          )
          return { status: 'failed' as const, code: error.code }
        }
        throw error
      }
    }
  }
}

function normalizeTimeout(value: number) {
  return Number.isFinite(value) ? Math.max(1_000, Math.trunc(value)) : 120_000
}

function normalizeAttempts(value: number) {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 3) : 1
}

function errorCode(error: unknown) {
  return error instanceof InferenceError ? error.code : 'analysis_preparation_failed'
}

function modelFailure(error: unknown) {
  if (error instanceof ModelInvocationError) return error
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return new ModelInvocationError('model_timeout', 'timed_out', true)
  if (error instanceof InferenceError) return new ModelInvocationError(error.code, 'contract_invalid', false)
  return new ModelInvocationError('model_request_failed', 'failed', true)
}
