import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  AnalysisContextBuilder, AnalysisScheduler, AnalysisWorker, InferenceError, InferenceService, ModelInvocationError,
  nextScheduleSlotUtc, scheduleSlotUtc, traderTaskMode,
  type AnalysisRun, type AnalysisScheduleRepository, type AnalysisWorkClaim, type InferenceRepository,
  type MarketAnalysisSummary, type MarketAnalysisResult,
} from '../src/modules/inference/index.js'
import { StrategyService, type StrategyCatalog, type StrategyVersion } from '../src/modules/strategies/index.js'

const version: StrategyVersion = {
  id: '11', strategyId: '10', kind: 'analysis', version: 1, promptText: '分析行情与机会', promptHash: 'a'.repeat(64),
  config: { timeframes: ['M5'], candle_limit: 100 }, inputContractVersion: 'market-analysis-input/v1', outputContractVersion: 'market-analysis/v1',
}

const result: MarketAnalysisResult = {
  marketBias: 'neutral', opportunity: 'none', confidence: 70, summary: '暂时没有新的入场机会', marketRegime: 'range',
  supportingEvidence: [], counterEvidence: [], keyLevels: {}, invalidation: {}, dataGaps: [], analysisBody: '完整分析',
  analyzedAt: '2026-09-03T08:00:20.000Z', validUntil: '2026-09-03T08:05:00.000Z',
}

class Strategies implements StrategyCatalog {
  async listAvailable() { return [] }
  async findActiveVersion(_userId: number, strategyId: string) { return strategyId === version.strategyId ? version : null }
}

function run(id: string, trigger: AnalysisRun['trigger'] = 'scheduled'): AnalysisRun {
  return {
    id, userId: 42, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', marketSourceAccountId: '7', trigger,
    scheduleSlot: '2026-09-03T08:00:00.000Z', status: 'queued', inputSnapshotId: null, modelTaskId: null,
    marketAnalysisId: null, createdAt: '2026-09-03T08:00:00.000Z', updatedAt: '2026-09-03T08:00:00.000Z', revision: 1,
  }
}

function summary(id: string): MarketAnalysisSummary {
  return {
    id, userId: 42, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', marketBias: result.marketBias,
    opportunity: result.opportunity, confidence: result.confidence, summary: result.summary, analyzedAt: result.analyzedAt,
    validUntil: result.validUntil, inputSnapshotHash: 'c'.repeat(64), revision: 1,
  }
}

function repository(overrides: Partial<InferenceRepository> = {}): InferenceRepository {
  const unsupported = async () => { throw new Error('unsupported') }
  return {
    queueAnalysis: unsupported, getAnalysisRun: unsupported, beginAnalysis: unsupported, completeAnalysis: unsupported,
    failAnalysisAttempt: unsupported, failQueuedAnalysis: unsupported, requestTraderEvaluation: unsupported,
    beginTrader: unsupported, completeTrader: unsupported, getAnalysis: unsupported, getAnalysisDetail: unsupported,
    listAnalyses: unsupported, getTraderDecision: unsupported, listTraderDecisions: unsupported, ...overrides,
  } as InferenceRepository
}

describe('Stage 12B analysis scheduling and worker', () => {
  it('aligns five-minute slots and creates one analysis for multiple account subscriptions', async () => {
    const now = new Date('2026-09-03T08:02:31.000Z')
    expect(scheduleSlotUtc(now, 300)).toBe('2026-09-03T08:00:00.000Z')
    expect(nextScheduleSlotUtc(now, 300)).toBe('2026-09-03T08:05:00.000Z')
    const queued: Parameters<InferenceRepository['queueAnalysis']>[0][] = []
    const inferenceRepository = repository({
      async queueAnalysis(input) { queued.push(input); return { ...run(input.id), marketSourceAccountId: input.marketSourceAccountId, scheduleSlot: input.scheduleSlot } },
    })
    const advanced: string[] = []
    const schedules: AnalysisScheduleRepository = {
      async listDue() {
        return ['8', '7'].map(accountId => ({ subscriptionId: `s-${accountId}`, receiveTimezone: 'UTC', receiveWindow: { enabled: false }, userId: 42, marketSourceAccountId: accountId, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', cadenceSeconds: 300, nextDueAt: '2026-09-03T08:00:00.000Z' }))
      },
      async advance(subscriptionId) { advanced.push(subscriptionId); return true },
    }
    const scheduler = new AnalysisScheduler(schedules, new InferenceService(inferenceRepository, new StrategyService(new Strategies())))
    const tick = await scheduler.tick(now)
    expect(tick.failures).toEqual([])
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ marketSourceAccountId: '7', scheduleSlot: '2026-09-03T08:00:00.000Z', idempotencyKey: 'scheduled:11:XAUUSD:2026-09-03T08:00:00.000Z' })
    expect(advanced.sort()).toEqual(['s-7', 's-8'])
  })

  it('freezes explicit market and macro inputs without provider conversation state', async () => {
    const macroVersion = { ...version, config: {
      ...version.config, macro_evidence: { mode: 'context', accepted_schema_versions: [1], max_age_seconds: 172800 },
    } }
    const contexts = new AnalysisContextBuilder(
      { async read(input) { return { source_account_id: input.preferredAccountId, symbol: input.symbol, quote: { revision: 9 }, candles: { M5: [] } } } },
      { async latest() { return { id: 'macro-1', revision: 3, payload: { usd: 'strong' } } } },
    )
    const snapshot = await contexts.build(run('a1'), macroVersion, new Date('2026-09-03T08:00:10.000Z'))
    expect(snapshot).toMatchObject({ kind: 'analysis', strategy: { versionId: '11' }, market: { source_account_id: '7' }, macro: { id: 'macro-1' } })
    expect(JSON.stringify(snapshot)).not.toMatch(/conversation_id|previous_response_id|chat_history/)
  })

  it('retries the same frozen task once and applies only the fenced successful result', async () => {
    const base = run('analysis-1')
    let attempts = 0
    const completed: Array<Parameters<InferenceRepository['completeAnalysis']>[0]> = []
    const inferenceRepository = repository({
      async getAnalysisRun() { return base },
      async beginAnalysis(input) {
        return { run: { ...base, status: 'running', inputSnapshotId: input.snapshotId, modelTaskId: input.taskId, revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 1 }
      },
      async failAnalysisAttempt(input) {
        return { run: { ...base, status: 'running', revision: 2 }, taskId: input.taskId, attemptId: 'attempt-2', attemptNumber: 2, fencingToken: input.fencingToken } satisfies AnalysisWorkClaim
      },
      async completeAnalysis(input) { completed.push(input); return { analysis: summary(input.marketAnalysisId), traderRuns: [] } },
    })
    const service = new InferenceService(inferenceRepository, new StrategyService(new Strategies()))
    const contexts = new AnalysisContextBuilder(
      { async read() { return { source_account_id: '7', symbol: 'XAUUSD', quote: { revision: 9 }, candles: { M5: [] } } } },
      { async latest() { return null } },
    )
    const worker = new AnalysisWorker(inferenceRepository, service, new StrategyService(new Strategies()), contexts, {
      profileId: '2', provider: 'test', model: 'analysis-model', timeoutMs: 5_000, maxAttempts: 2,
      async analyze() { attempts += 1; if (attempts === 1) throw new ModelInvocationError('provider_busy', 'failed', true); return { result, usage: { total_tokens: 100 } } },
    }, 'worker-1')
    await expect(worker.process(base.id, new Date('2026-09-03T08:00:00.000Z'))).resolves.toMatchObject({ status: 'succeeded' })
    expect(attempts).toBe(2)
    expect(completed[0]).toMatchObject({ attemptId: 'attempt-2', fencingToken: 1 })
  })

  it('runs account trader only for a market opportunity or existing exposure', () => {
    expect(traderTaskMode('none', false, false)).toBeNull()
    expect(traderTaskMode('long_setup', false, false)).toBe('entry')
    expect(traderTaskMode('none', true, false)).toBe('manage')
    expect(traderTaskMode('short_setup', false, true)).toBe('both')
  })

  it('does not retry a model result after a newer analysis supersedes its fenced write', async () => {
    const base = run('analysis-stale')
    let modelCalls = 0
    let failureCalls = 0
    const inferenceRepository = repository({
      async getAnalysisRun() { return base },
      async beginAnalysis(input) {
        return { run: { ...base, status: 'running', inputSnapshotId: input.snapshotId, modelTaskId: input.taskId, revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 1 }
      },
      async completeAnalysis() { throw new InferenceError('analysis_revision_conflict', 409) },
      async failAnalysisAttempt() { failureCalls += 1; return null },
    })
    const service = new InferenceService(inferenceRepository, new StrategyService(new Strategies()))
    const contexts = new AnalysisContextBuilder(
      { async read() { return { source_account_id: '7', symbol: 'XAUUSD', quote: { revision: 9 }, candles: { M5: [] } } } },
      { async latest() { return null } },
    )
    const worker = new AnalysisWorker(inferenceRepository, service, new StrategyService(new Strategies()), contexts, {
      profileId: null, provider: 'test', model: 'analysis-model', timeoutMs: 5_000, maxAttempts: 3,
      async analyze() { modelCalls += 1; return { result, usage: null } },
    }, 'worker-1')
    await expect(worker.process(base.id, new Date('2026-09-03T08:00:00.000Z'))).resolves.toEqual({ status: 'ignored', code: 'analysis_revision_conflict' })
    expect(modelCalls).toBe(1)
    expect(failureCalls).toBe(0)
  })

  it('fails malformed model output as a contract error without retrying the provider', async () => {
    const base = run('analysis-invalid')
    let failureStatus = ''
    const inferenceRepository = repository({
      async getAnalysisRun() { return base },
      async beginAnalysis(input) {
        return { run: { ...base, status: 'running', inputSnapshotId: input.snapshotId, modelTaskId: input.taskId, revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 1 }
      },
      async failAnalysisAttempt(input) { failureStatus = input.failureStatus; return null },
    })
    const service = new InferenceService(inferenceRepository, new StrategyService(new Strategies()))
    const contexts = new AnalysisContextBuilder(
      { async read() { return { source_account_id: '7', symbol: 'XAUUSD', quote: { revision: 9 }, candles: { M5: [] } } } },
      { async latest() { return null } },
    )
    const worker = new AnalysisWorker(inferenceRepository, service, new StrategyService(new Strategies()), contexts, {
      profileId: null, provider: 'test', model: 'analysis-model', timeoutMs: 5_000, maxAttempts: 3,
      async analyze() { return { result: { ...result, opportunity: 'invalid' as MarketAnalysisResult['opportunity'] }, usage: null } },
    }, 'worker-1')
    await expect(worker.process(base.id, new Date('2026-09-03T08:00:00.000Z'))).resolves.toEqual({ status: 'failed', code: 'market_opportunity_invalid' })
    expect(failureStatus).toBe('contract_invalid')
  })

  it('preserves old V4 market-analysis values while migrating to opportunity and task modes', async () => {
    const sql = await readFile(new URL('../db/migrations/20260903_005_analysis_scheduler_and_account_fanout.sql', import.meta.url), 'utf8')
    expect(sql).toContain("WHEN 'long_candidate' THEN 'long_setup'")
    expect(sql).toContain("WHEN 'short_candidate' THEN 'short_setup'")
    expect(sql).toContain("ADD COLUMN task_mode ENUM('entry','manage','both')")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS macro_research_snapshots')
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i)
  })
})
