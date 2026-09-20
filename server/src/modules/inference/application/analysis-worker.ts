import type { ActiveStrategyVersionReader } from '../../strategies/index.js'
import type { AnalysisInputSnapshot, AnalysisRun, JsonObject, MarketAnalysisResult } from '../domain/inference.js'
import { InferenceError } from '../domain/inference.js'
import type { AnalysisContextBuilder } from './analysis-context-builder.js'
import type { InferenceRepository } from './inference-ports.js'
import type { InferenceService } from './inference-service.js'
import type { AnalysisWindowGuard } from './analysis-window-guard.js'
import { analysisModelSnapshot } from './analysis-model-snapshot.js'

export interface AnalysisModelGateway {
  readonly profileId: string | null
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number
  analyze(input: { taskId: string; attemptId: string; snapshot: AnalysisInputSnapshot; signal: AbortSignal }): Promise<{ result: MarketAnalysisResult; usage: JsonObject | null }>
}

export interface AnalysisModelGatewayResolver {
  resolve(input: { userId: number; strategyId: string; strategyVersionId: string; trigger: AnalysisRun['trigger'] }): Promise<AnalysisModelGateway>
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
    private readonly strategies: ActiveStrategyVersionReader,
    private readonly contexts: AnalysisContextBuilder,
    private readonly modelSource: AnalysisModelGateway | AnalysisModelGatewayResolver,
    private readonly workerId: string,
    private readonly windows: AnalysisWindowGuard,
    private readonly currentTime: () => Date = () => new Date(),
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  async process(runId: string, now = new Date()) {
    const run = await this.repository.getAnalysisRun(runId)
    if (!run || run.status !== 'queued') return { status: 'ignored' as const }

    let strategy
    try {
      await this.windows.assertAllowed(run, this.currentTime())
      strategy = await this.strategies.requireActiveVersion(run.userId, run.strategyId, 'analysis')
      if (strategy.id !== run.strategyVersionId) throw new InferenceError('strategy_version_conflict', 409)
    } catch (error) {
      await this.repository.failQueuedAnalysis(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    let model
    try {
      model = 'resolve' in this.modelSource
        ? await this.modelSource.resolve({ userId: run.userId, strategyId: run.strategyId, strategyVersionId: run.strategyVersionId, trigger: run.trigger })
        : this.modelSource
    } catch (error) {
      await this.repository.failQueuedAnalysis(run.id, errorCode(error, 'analysis_model_unavailable'))
      return { status: 'failed' as const, code: errorCode(error, 'analysis_model_unavailable') }
    }

    let snapshot
    try {
      for (let attempt = 0; ; attempt++) {
        try { snapshot = await this.contexts.build(run, strategy, now); break }
        catch (error) {
          if (!(error instanceof InferenceError) || error.code !== 'market_candle_close_pending' || attempt >= 3) throw error
          await this.wait(5000)
          now = this.currentTime()
          await this.windows.assertAllowed(run, now)
        }
      }
    } catch (error) {
      await this.repository.failQueuedAnalysis(run.id, errorCode(error))
      return { status: 'failed' as const, code: errorCode(error) }
    }

    const timeoutMs = normalizeTimeout(model.timeoutMs)
    const maxAttempts = normalizeAttempts(model.maxAttempts)
    let claim
    try { claim = await this.inference.beginAnalysis(
      run.userId, run.id, run.revision, snapshot,
      { profileId: model.profileId, provider: model.provider, model: model.model },
      this.workerId, new Date(now.getTime() + timeoutMs * maxAttempts).toISOString(),
    ) } catch (error) {
      // Deterministic preparation failures must not remain queued after queue retries end.
      if (!(error instanceof InferenceError) || error.code === 'analysis_revision_conflict') throw error
      await this.repository.failQueuedAnalysis(run.id, error.code)
      return { status: 'failed' as const, code: error.code }
    }

    while (true) {
      let output
      try {
        // Context preparation and provider retries can cross a window boundary.
        await this.windows.assertAllowed(run, this.currentTime())
        output = await model.analyze({ taskId: claim.taskId, attemptId: claim.attemptId, snapshot: analysisModelSnapshot(snapshot), signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        const failure = modelFailure(error)
        const retry = await this.inference.failAnalysisAttempt(claim, model, failure, maxAttempts)
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
            model,
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

function errorCode(error: unknown, fallback = 'analysis_preparation_failed') {
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
