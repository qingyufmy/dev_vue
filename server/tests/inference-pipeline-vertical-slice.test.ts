import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { contentHash, InferenceError, InferenceService, inferenceRoutes, snapshotHash, type AnalysisInputSnapshot, type AnalysisRun, type InferenceRepository, type MarketAnalysisSummary, type TraderDecisionSummary, type TraderInputSnapshot, type TraderRun } from '../src/modules/inference/index.js'
import { StrategyService, type StrategyCatalog, type StrategyKind, type StrategySummary, type StrategyVersion } from '../src/modules/strategies/index.js'

const analysisVersion: StrategyVersion = { id: '11', strategyId: '10', kind: 'analysis', version: 1, promptText: '只分析行情', promptHash: 'a'.repeat(64), config: {}, inputContractVersion: 'market-analysis-input/v1', outputContractVersion: 'market-analysis/v1' }
const traderVersion: StrategyVersion = { id: '21', strategyId: '20', kind: 'trader', version: 1, promptText: '结合账户给出动作', promptHash: 'b'.repeat(64), config: {}, inputContractVersion: 'account-trader-input/v1', outputContractVersion: 'trade-decision/v1' }

class MemoryStrategies implements StrategyCatalog {
  async listAvailable(_userId: number, kind?: StrategyKind): Promise<StrategySummary[]> { return [analysisVersion, traderVersion].filter(item => !kind || item.kind === kind).map(item => ({ id: item.strategyId, kind: item.kind, scope: 'user', ownerUserId: 42, name: item.kind, description: '', status: 'active', activeVersionId: item.id, revision: 1 })) }
  async findActiveVersion(userId: number, strategyId: string) { if (userId !== 42) return null; return strategyId === '10' ? analysisVersion : strategyId === '20' ? traderVersion : null }
}

class MemoryInference implements InferenceRepository {
  queueInput: Parameters<InferenceRepository['queueAnalysis']>[0] | null = null
  beginAnalysisInput: Parameters<InferenceRepository['beginAnalysis']>[0] | null = null
  completeAnalysisInput: Parameters<InferenceRepository['completeAnalysis']>[0] | null = null
  traderInput: Parameters<InferenceRepository['requestTraderEvaluation']>[0] | null = null
  beginTraderInput: Parameters<InferenceRepository['beginTrader']>[0] | null = null
  completeTraderInput: Parameters<InferenceRepository['completeTrader']>[0] | null = null

  async queueAnalysis(input: Parameters<InferenceRepository['queueAnalysis']>[0]) { this.queueInput = input; return analysisRun(input.id, input.trigger) }
  async getAnalysisRun(id: string) { return analysisRun(id, 'manual') }
  async getTraderRun(id: string) { return traderRun(id) }
  async beginAnalysis(input: Parameters<InferenceRepository['beginAnalysis']>[0]) { this.beginAnalysisInput = input; return { run: { ...analysisRun(input.runId, 'manual'), status: 'running' as const, inputSnapshotId: input.snapshotId, modelTaskId: input.taskId, revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 1 } }
  async completeAnalysis(input: Parameters<InferenceRepository['completeAnalysis']>[0]) { this.completeAnalysisInput = input; return { analysis: marketAnalysis(input.marketAnalysisId), traderRuns: input.runId.includes('scheduled') ? [traderRun('trader-auto')] : [] } }
  async failAnalysisAttempt() { return null }
  async failQueuedAnalysis() {}
  async requestTraderEvaluation(input: Parameters<InferenceRepository['requestTraderEvaluation']>[0]) { this.traderInput = input; return traderRun(input.id) }
  async beginTrader(input: Parameters<InferenceRepository['beginTrader']>[0]) { this.beginTraderInput = input; return { run: { ...traderRun(input.runId), status: 'running' as const, inputSnapshotId: input.snapshotId, modelTaskId: input.taskId, accountRevision: input.snapshot.accountRevision, quoteRevision: input.snapshot.quoteRevision, contractRevision: input.snapshot.contractRevision, riskRevision: input.snapshot.riskRevision, revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 1 } }
  async completeTrader(input: Parameters<InferenceRepository['completeTrader']>[0]) { this.completeTraderInput = input; return decision(input.decisionId) }
  async failTraderAttempt() { return null }
  async failQueuedTrader() {}
  async getAnalysis(userId: number, id: string) { return userId === 42 ? marketAnalysis(id) : null }
  async getAnalysisDetail(userId: number, id: string) { return userId === 42 ? { summary: marketAnalysis(id), result: analysisResult } : null }
  async listAnalyses(userId: number) { return userId === 42 ? [marketAnalysis('a1')] : [] }
  async getTraderDecision(userId: number, id: string) { return userId === 42 ? { summary: decision(id), result: holdDecision } : null }
  async listTraderDecisions(userId: number, accountId: string) { return userId === 42 && accountId === '7' ? [decision('d1')] : [] }
}

function analysisRun(id: string, trigger: AnalysisRun['trigger']): AnalysisRun { return { id, userId: 42, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', marketSourceAccountId: null, trigger, scheduleSlot: null, status: 'queued', inputSnapshotId: null, modelTaskId: null, marketAnalysisId: null, createdAt: '2026-09-03T08:00:00.000Z', updatedAt: '2026-09-03T08:00:00.000Z', revision: 1 } }
function analysisClaim(id: string) { return { run: { ...analysisRun(id, id.includes('scheduled') ? 'scheduled' : 'manual'), status: 'running' as const, revision: 2 }, taskId: `task-${id}`, attemptId: `attempt-${id}`, attemptNumber: 1, fencingToken: 1 } }
function marketAnalysis(id: string): MarketAnalysisSummary { return { id, userId: 42, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', marketBias: 'bullish', opportunity: 'long_setup', confidence: 76, summary: '结构偏多', analyzedAt: analysisResult.analyzedAt, validUntil: analysisResult.validUntil, inputSnapshotHash: 'c'.repeat(64), revision: 1 } }
function traderRun(id: string): TraderRun { return { id, userId: 42, tradingAccountId: '7', subscriptionId: '30', subscriptionRevision: 4, marketAnalysisId: 'a1', strategyId: '20', strategyVersionId: '21', taskMode: 'entry', analysisRevision: 1, accountRevision: null, quoteRevision: null, contractRevision: null, riskRevision: null, positionsRevision: 0, pendingOrdersRevision: 0, status: 'queued', inputSnapshotId: null, modelTaskId: null, decisionId: null, createdAt: '2026-09-03T08:00:01.000Z', updatedAt: '2026-09-03T08:00:01.000Z', revision: 1 } }
function decision(id: string): TraderDecisionSummary { return { id, userId: 42, tradingAccountId: '7', marketAnalysisId: 'a1', strategyId: '20', strategyVersionId: '21', action: 'hold', side: null, confidence: 80, summary: '等待更好价格', status: 'proposed', staleReason: null, inputSnapshotHash: 'd'.repeat(64), createdAt: '2026-09-03T08:00:02.000Z', revision: 1 } }

const analysisResult = { marketBias: 'bullish' as const, opportunity: 'long_setup' as const, confidence: 76, summary: '结构偏多', marketRegime: 'trend', supportingEvidence: ['H1 多头'], counterEvidence: ['点差扩大'], keyLevels: { support: '3530' }, invalidation: { price: '3520' }, dataGaps: [], analysisBody: '完整分析正文', analyzedAt: '2026-09-03T08:00:00.000Z', validUntil: '2026-09-03T08:03:00.000Z' }
const holdDecision = { action: 'hold' as const, side: null, confidence: 80, summary: '等待更好价格', actions: [], reasoning: '当前价格不在候选区域' }
const analysisSnapshot: AnalysisInputSnapshot = { kind: 'analysis', strategy: { id: '10', versionId: '11', promptHash: 'a'.repeat(64), promptText: '只分析行情' }, market: { symbol: 'XAUUSD', candles_revision: 8 }, macro: { revision: 3 }, capturedAt: '2026-09-03T08:00:00.000Z' }
const frozenAnalysis = { market_bias: 'bullish', confidence: 76 }
const traderSnapshot: TraderInputSnapshot = { kind: 'trader', taskMode: 'entry', strategy: { id: '20', versionId: '21', promptHash: 'b'.repeat(64), promptText: '结合账户给出动作' }, analysis: { id: 'a1', contentHash: contentHash(frozenAnalysis), result: frozenAnalysis }, account: { id: '7' }, positions: [], pendingOrders: [], quote: { bid: '3530' }, contract: { symbol: 'XAUUSD' }, risk: { enabled: true }, analysisRevision: 1, subscriptionRevision: 4, accountRevision: 8, positionsRevision: 0, pendingOrdersRevision: 0, quoteRevision: 9, contractRevision: 3, riskRevision: 5, capturedAt: '2026-09-03T08:00:01.000Z' }

describe('Stage 12A analyst and account-trader pipeline', () => {
  it('queues manual analysis only against an active analysis strategy and applies the 3-minute server cooldown contract', async () => {
    const repository = new MemoryInference(); const service = new InferenceService(repository, new StrategyService(new MemoryStrategies()))
    await expect(service.requestManualAnalysis(42, '10', ' xauusd ', 'manual-request-0001', new Date('2026-09-03T08:00:00.000Z'))).resolves.toMatchObject({ symbol: 'XAUUSD', trigger: 'manual' })
    expect(repository.queueInput).toMatchObject({ strategyVersionId: '11', manualCooldownSeconds: 180, idempotencyKey: 'manual-request-0001' })
    await expect(service.requestManualAnalysis(42, '20', 'XAUUSD', 'manual-request-0002')).rejects.toMatchObject({ code: 'strategy_kind_mismatch' })
  })

  it('hashes explicit frozen input deterministically and rejects provider chat context', async () => {
    expect(snapshotHash(analysisSnapshot)).toBe(snapshotHash({ ...analysisSnapshot, market: { candles_revision: 8, symbol: 'XAUUSD' } }))
    expect(() => snapshotHash({ ...analysisSnapshot, market: { conversation_id: 'provider-thread' } })).toThrowError(expect.objectContaining({ code: 'implicit_model_context_forbidden' }))
    const service = new InferenceService(new MemoryInference(), new StrategyService(new MemoryStrategies()))
    await expect(service.beginTrader(42, 'trader-1', 1, { ...traderSnapshot, analysis: { ...traderSnapshot.analysis, result: { market_bias: 'bearish' } } }, { profileId: null, provider: 'test', model: 'trader' }, 'worker', '2026-09-03T08:01:00.000Z')).rejects.toMatchObject({ code: 'trader_analysis_payload_hash_mismatch' })
  })

  it('keeps the trigger authoritative in persistence instead of accepting a caller-controlled fan-out flag', async () => {
    const repository = new MemoryInference(); const service = new InferenceService(repository, new StrategyService(new MemoryStrategies()))
    await expect(service.completeAnalysis(analysisClaim('run-manual'), analysisResult)).resolves.toMatchObject({ traderRuns: [] })
    await expect(service.completeAnalysis(analysisClaim('run-scheduled'), analysisResult)).resolves.toMatchObject({ traderRuns: [{ tradingAccountId: '7' }] })
    expect(repository.completeAnalysisInput).not.toHaveProperty('fanOutToSubscribers')
  })

  it('requires an explicit current account subscription for a manual trader evaluation', async () => {
    const repository = new MemoryInference(); const service = new InferenceService(repository, new StrategyService(new MemoryStrategies()))
    await service.requestAccountEvaluation(42, { tradingAccountId: '7', marketAnalysisId: 'a1', subscriptionId: '30', subscriptionRevision: 4, strategyId: '20', strategyVersionId: '21' }, 'evaluate-account-0001', new Date('2026-09-03T08:00:01.000Z'))
    expect(repository.traderInput).toMatchObject({ tradingAccountId: '7', marketAnalysisId: 'a1', subscriptionRevision: 4, strategyVersionId: '21' })
    await expect(service.requestAccountEvaluation(42, { tradingAccountId: '7', marketAnalysisId: 'a1', subscriptionId: '30', subscriptionRevision: 4, strategyId: '20', strategyVersionId: 'old' }, 'evaluate-account-0002')).rejects.toMatchObject({ code: 'strategy_version_conflict' })
  })

  it('accepts hold only without actions and never creates execution or Bridge commands', async () => {
    const repository = new MemoryInference(); const service = new InferenceService(repository, new StrategyService(new MemoryStrategies()))
    const claim = { run: { ...traderRun('trader-1'), status: 'running' as const, revision: 2 }, taskId: 'task-1', attemptId: 'attempt-1', attemptNumber: 1, fencingToken: 1 }
    await expect(service.completeTrader(claim, traderSnapshot, holdDecision)).resolves.toMatchObject({ action: 'hold', status: 'proposed' })
    await expect(service.completeTrader(claim, traderSnapshot, { ...holdDecision, action: 'market_order', side: 'buy' })).rejects.toMatchObject({ code: 'trader_actions_required' })
    expect(JSON.stringify(repository.completeTraderInput)).not.toMatch(/bridge|execution_intent/i)
  })

  it('serves normalized HTTP summaries and keeps full payloads on HTTP rather than realtime', async () => {
    const repository = new MemoryInference(); const service = new InferenceService(repository, new StrategyService(new MemoryStrategies()))
    const app = Fastify({ logger: false })
    await app.register(inferenceRoutes, { prefix: '/api/v4', service, strategies: new StrategyService(new MemoryStrategies()), auth: { async authenticate() { return { userId: 42 } }, async assertWrite() { return { userId: 42 } } } })
    const accepted = await app.inject({ method: 'POST', url: '/api/v4/analysis-jobs', headers: { 'idempotency-key': 'manual-request-0001' }, payload: { strategy_id: '10', symbol: 'XAUUSD', mode: 'manual' } })
    expect(accepted.statusCode).toBe(202)
    expect(accepted.json().data).toMatchObject({ strategy_version_id: '11', trigger: 'manual', status: 'queued' })
    expect(JSON.stringify(accepted.json())).not.toContain('auto_execute')
    const rejected = await app.inject({ method: 'POST', url: '/api/v4/analysis-jobs', headers: { 'idempotency-key': 'manual-request-0002' }, payload: { strategy_id: '10', symbol: 'XAUUSD', mode: 'manual', auto_execute: true } })
    expect(rejected.statusCode).toBe(422)
    const detail = await app.inject({ method: 'GET', url: '/api/v4/market-analyses/a1' })
    expect(detail.json().data).toMatchObject({ market_regime: 'trend', analysis_body: '完整分析正文' })
    await app.close()
  })

  it('keeps the migration append-only, UTC, normalized, account-scoped and deletion-free', async () => {
    const sql = await readFile(new URL('../db/migrations/20260903_004_ai_strategy_and_inference_core.sql', import.meta.url), 'utf8')
    expect(sql).toContain('TARGET: empty V4 side-by-side database only')
    expect(sql).toContain("kind ENUM('analysis','trader')")
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS market_analyses')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS trade_decisions')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ai_manual_analysis_cooldowns')
    expect(sql).toContain('active_execution_key')
    expect(sql).toContain("owner_scope='platform'")
    expect(sql.indexOf('UNIQUE KEY uk_strategy_versions_identity (id, strategy_id)')).toBeGreaterThan(sql.indexOf('CREATE TABLE IF NOT EXISTS strategy_versions'))
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i)
  })

  it('removes the mixed signal/execution contract from V4 HTTP and realtime', async () => {
    const openapi = await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8')
    const realtime = await readFile(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8')
    expect(openapi).toContain('/market-analyses')
    expect(openapi).toContain('/trade-decisions')
    expect(openapi).not.toContain('auto_execute')
    expect(openapi).not.toContain('SignalSummary')
    expect(realtime).toContain('market_analysis.created')
    expect(realtime).toContain('trade_decision.created')
    expect(realtime).not.toContain('signal.execution.changed')
  })
})
