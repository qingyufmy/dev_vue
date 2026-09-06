import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  InferenceError, InferenceService, ModelInvocationError, TraderContextBuilder, TraderWorker,
  type InferenceRepository, type MarketAnalysisDetail, type TraderDecisionResult, type TraderInputSnapshot, type TraderRun, type TraderWorkClaim,
} from '../src/modules/inference/index.js'
import { StrategyService, type StrategyCatalog, type StrategyVersion } from '../src/modules/strategies/index.js'
import type { TradingReadRepository } from '../src/modules/trading/index.js'

const strategy: StrategyVersion = {
  id: '21', strategyId: '20', kind: 'trader', version: 1, promptText: '账户级决策', promptHash: 'b'.repeat(64), config: {},
  inputContractVersion: 'account-trader-input/v1', outputContractVersion: 'trade-decision/v1',
}
const analysis: MarketAnalysisDetail = {
  summary: { id: 'analysis-1', userId: 42, strategyId: '10', strategyVersionId: '11', symbol: 'XAUUSD', marketBias: 'bullish', opportunity: 'long_setup', confidence: 78, summary: '偏多候选', analyzedAt: '2026-09-03T08:00:00.000Z', validUntil: '2026-09-03T08:05:00.000Z', inputSnapshotHash: 'a'.repeat(64), revision: 2 },
  result: { marketBias: 'bullish', opportunity: 'long_setup', confidence: 78, summary: '偏多候选', marketRegime: 'trend', supportingEvidence: ['结构'], counterEvidence: [], keyLevels: { support: '3520' }, invalidation: { price: '3510' }, dataGaps: [], analysisBody: '正文', analyzedAt: '2026-09-03T08:00:00.000Z', validUntil: '2026-09-03T08:05:00.000Z' },
}

function run(overrides: Partial<TraderRun> = {}): TraderRun {
  return { id: 'trader-1', userId: 42, tradingAccountId: '7', subscriptionId: '30', subscriptionRevision: 4, marketAnalysisId: analysis.summary.id, strategyId: '20', strategyVersionId: '21', taskMode: 'entry', analysisRevision: 2, accountRevision: null, quoteRevision: null, contractRevision: null, riskRevision: null, positionsRevision: 12, pendingOrdersRevision: 13, status: 'queued', inputSnapshotId: null, modelTaskId: null, decisionId: null, createdAt: '2026-09-03T08:00:01.000Z', updatedAt: '2026-09-03T08:00:01.000Z', revision: 1, ...overrides }
}

class Strategies implements StrategyCatalog {
  async listAvailable() { return [] }
  async findActiveVersion(_userId: number, strategyId: string) { return strategyId === '20' ? strategy : null }
}

function inferenceRepository(overrides: Partial<InferenceRepository> = {}): InferenceRepository {
  const unsupported = async () => { throw new Error('unsupported') }
  return {
    queueAnalysis: unsupported, getAnalysisRun: unsupported, getTraderRun: unsupported, beginAnalysis: unsupported,
    completeAnalysis: unsupported, failAnalysisAttempt: unsupported, failQueuedAnalysis: unsupported,
    requestTraderEvaluation: unsupported, beginTrader: unsupported, completeTrader: unsupported,
    failTraderAttempt: unsupported, failQueuedTrader: unsupported, getAnalysis: unsupported, getAnalysisDetail: unsupported,
    listAnalyses: unsupported, getTraderDecision: unsupported, listTraderDecisions: unsupported, ...overrides,
  } as InferenceRepository
}

function tradingRepository(revisions = { account: 8, quote: 9, positions: 12, pending: 13 }): TradingReadRepository {
  return {
    async findOwnedAccount() { return { id: '7', platform: 'mt5', login: '596520', server: 'Demo', currency: 'USD', terminalProfileId: 'p1', terminalInstanceId: 't1', bridgeState: 'online', tradePermission: true, lastSeenAt: '2026-09-03T08:00:01.000Z' } },
    async getAccountSnapshot() { return { ...(await this.findOwnedAccount(42, '7'))!, balance: '10000', equity: '10020', margin: '100', freeMargin: '9920', floatingProfit: '20', leverage: 100, timezoneOffsetMinutes: 180, clockStatus: 'calibrated', observedAt: '2026-09-03T08:00:01.000Z', revision: revisions.account } },
    async getQuote() { return { accountId: '7', symbol: 'XAUUSD', bid: '3530.10', ask: '3530.30', last: null, spread: '0.20', tradeMode: 'full', observedAt: '2026-09-03T08:00:01.000Z', revision: revisions.quote } },
    async listPositions() { return { revision: revisions.positions, items: [] } },
    async listPendingOrders() { return { revision: revisions.pending, items: [] } },
    async latestRevision(_accountId, resource) { return resource === 'account.metrics' ? revisions.account : resource === 'market.quote' ? revisions.quote : resource === 'positions' ? revisions.positions : revisions.pending },
    async getContext() { return null }, async saveContext() { throw new Error('unsupported') }, async listAccounts() { return [] }, async listTerminalProfiles() { return [] }, async listObserverChannels() { return [] }, async findAccount() { return null }, async listSymbols() { return [] }, async listCandles() { return [] },
  }
}

function expected(snapshot: TraderInputSnapshot) {
  return { analysisRevision: snapshot.analysisRevision, subscriptionRevision: snapshot.subscriptionRevision, accountRevision: snapshot.accountRevision, positionsRevision: snapshot.positionsRevision, pendingOrdersRevision: snapshot.pendingOrdersRevision, quoteRevision: snapshot.quoteRevision, contractRevision: snapshot.contractRevision, riskRevision: snapshot.riskRevision }
}

describe('Stage 12C account Trader Worker', () => {
  it('binds every private projection to the queued task user, never an implicit current owner', async () => {
    const repo = inferenceRepository({ async getAnalysisDetail() { return analysis } })
    const trading = tradingRepository()
    const snapshot = vi.spyOn(trading, 'getAccountSnapshot').mockResolvedValue(null)
    const positions = vi.spyOn(trading, 'listPositions')
    const pending = vi.spyOn(trading, 'listPendingOrders')
    const builder = new TraderContextBuilder(repo, trading,
      { async read() { return { revision: 6, data: {} } } }, { async read() { return { revision: 7, data: {} } } })
    await expect(builder.build(run(), strategy, new Date('2026-09-03T08:00:10.000Z'))).rejects.toMatchObject({ code: 'trader_account_unavailable' })
    expect(snapshot).toHaveBeenCalledWith('7', 42)
    expect(positions).toHaveBeenCalledWith('7', 42)
    expect(pending).toHaveBeenCalledWith('7', 42)
  })

  it('freezes one owned account with exact account, exposure, quote, contract and risk revisions', async () => {
    const repo = inferenceRepository({ async getAnalysisDetail() { return analysis } })
    const snapshot = await new TraderContextBuilder(repo, tradingRepository(), { async read() { return { revision: 6, data: { symbol: 'XAUUSD', volume_step: '0.01' } } } }, { async read() { return { revision: 7, data: { status: 'ready', max_risk_percent: '1' } } } }).build(run(), strategy, new Date('2026-09-03T08:00:10.000Z'))
    expect(snapshot).toMatchObject({ kind: 'trader', taskMode: 'entry', analysisRevision: 2, accountRevision: 8, positionsRevision: 12, pendingOrdersRevision: 13, quoteRevision: 9, contractRevision: 6, riskRevision: 7, account: { id: '7' } })
    expect(JSON.stringify(snapshot)).not.toMatch(/conversation_id|previous_response_id|chat_history/)
  })

  it('fails a torn or changed account projection before any model request', async () => {
    const repo = inferenceRepository({ async getAnalysisDetail() { return analysis } })
    const trading = tradingRepository(); trading.latestRevision = async (_id, resource) => resource === 'positions' ? 99 : resource === 'account.metrics' ? 8 : resource === 'market.quote' ? 9 : 13
    const builder = new TraderContextBuilder(repo, trading, { async read() { return { revision: 6, data: {} } } }, { async read() { return { revision: 7, data: {} } } })
    await expect(builder.build(run(), strategy, new Date('2026-09-03T08:00:10.000Z'))).rejects.toMatchObject({ code: 'trader_context_torn_read' })
  })

  it('does not treat missing collection evidence as a confirmed empty portfolio', async () => {
    const repo = inferenceRepository({ async getAnalysisDetail() { return analysis } })
    const trading = tradingRepository({ account: 8, quote: 9, positions: 0, pending: 0 })
    const builder = new TraderContextBuilder(repo, trading,
      { async read() { return { revision: 6, data: {} } } }, { async read() { return { revision: 7, data: {} } } })
    await expect(builder.build(run({ positionsRevision: 0, pendingOrdersRevision: 0 }), strategy,
      new Date('2026-09-03T08:00:10.000Z'))).rejects.toMatchObject({ code: 'trader_context_torn_read' })
  })

  it('retries the same frozen account snapshot and persists a structured decision without Bridge or execution intents', async () => {
    const base = run(); let modelCalls = 0; let completed: Parameters<InferenceRepository['completeTrader']>[0] | null = null
    const repo = inferenceRepository({
      async getTraderRun() { return base }, async getAnalysisDetail() { return analysis },
      async beginTrader(input) { return { run: { ...base, status: 'running', inputSnapshotId: input.snapshotId, modelTaskId: input.taskId, accountRevision: input.snapshot.accountRevision, quoteRevision: input.snapshot.quoteRevision, contractRevision: input.snapshot.contractRevision, riskRevision: input.snapshot.riskRevision, revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 5 } },
      async failTraderAttempt(input) { return { run: { ...base, status: 'running', revision: 2 }, taskId: input.taskId, attemptId: 'attempt-2', attemptNumber: 2, fencingToken: 5 } },
      async completeTrader(input) { completed = input; return { id: input.decisionId, userId: 42, tradingAccountId: '7', marketAnalysisId: analysis.summary.id, strategyId: '20', strategyVersionId: '21', action: input.result.action, side: input.result.side, confidence: input.result.confidence, summary: input.result.summary, status: 'proposed', staleReason: null, inputSnapshotHash: 'c'.repeat(64), createdAt: '2026-09-03T08:00:20.000Z', revision: 1 } },
    })
    const service = new InferenceService(repo, new StrategyService(new Strategies()))
    const contexts = new TraderContextBuilder(repo, tradingRepository(), { async read() { return { revision: 6, data: { symbol: 'XAUUSD' } } } }, { async read() { return { revision: 7, data: { status: 'ready' } } } })
    let frozen: TraderInputSnapshot | null = null
    const worker = new TraderWorker(repo, service, new StrategyService(new Strategies()), contexts, {
      profileId: '3', provider: 'test', model: 'trader-model', timeoutMs: 5_000, maxAttempts: 2,
      async decide(input) {
        modelCalls += 1; frozen = frozen ?? input.snapshot
        expect(input.snapshot).toEqual(frozen)
        if (modelCalls === 1) throw new ModelInvocationError('provider_busy', 'failed', true)
        return { result: { action: 'market_order', side: 'buy', confidence: 82, summary: '账户允许候选买入', reasoning: '资金与敞口允许', actions: [{ actionId: 'action-1', kind: 'market_order', parameters: { symbol: 'XAUUSD', side: 'buy', volume: '0.01' }, expectedState: expected(input.snapshot) }] }, usage: { total_tokens: 80 } }
      },
    }, 'trader-worker-1', { async assertAllowed() { return 'a'.repeat(64) } })
    await expect(worker.process(base.id, new Date('2026-09-03T08:00:10.000Z'))).resolves.toMatchObject({ status: 'succeeded' })
    expect(modelCalls).toBe(2)
    expect(completed).toMatchObject({ attemptId: 'attempt-2', fencingToken: 5 })
    expect(frozen).toMatchObject({ subscriptionWindowHash: 'a'.repeat(64) })
    expect(JSON.stringify(completed)).not.toMatch(/bridge|execution_intent/i)
  })

  it('rejects a model action whose expected state does not match the frozen account', async () => {
    const snapshot = await new TraderContextBuilder(inferenceRepository({ async getAnalysisDetail() { return analysis } }), tradingRepository(), { async read() { return { revision: 6, data: {} } } }, { async read() { return { revision: 7, data: {} } } }).build(run(), strategy, new Date('2026-09-03T08:00:10.000Z'))
    const service = new InferenceService(inferenceRepository(), new StrategyService(new Strategies()))
    const claim: TraderWorkClaim = { run: run({ status: 'running', revision: 2 }), taskId: 'task', attemptId: 'attempt', attemptNumber: 1, fencingToken: 1 }
    const result: TraderDecisionResult = { action: 'market_order', side: 'buy', confidence: 80, summary: '买入', reasoning: '测试', actions: [{ actionId: 'a1', kind: 'market_order', parameters: { symbol: 'XAUUSD', side: 'buy', volume: '0.01' }, expectedState: { ...expected(snapshot), quoteRevision: 999 } }] }
    await expect(service.completeTrader(claim, snapshot, result)).rejects.toMatchObject({ code: 'trader_expected_state_mismatch' })
  })

  it.each([1, 2, 3, 4])('stops a changed window at trader checkpoint %s without completing a decision', async blockedCheck => {
    const base = run(), failures: string[] = []
    let checks = 0, calls = 0, completed = false
    const repo = inferenceRepository({
      async getTraderRun() { return base }, async getAnalysisDetail() { return analysis },
      async failQueuedTrader(_id, code) { failures.push(code) },
      async beginTrader(input) { return { run: { ...base, status: 'running', revision: 2 }, taskId: input.taskId, attemptId: input.attemptId, attemptNumber: 1, fencingToken: 5 } },
      async failTraderAttempt(input) {
        failures.push(input.errorCode)
        return input.retryable ? { run: { ...base, status: 'running', revision: 2 }, taskId: input.taskId, attemptId: 'retry', attemptNumber: 2, fencingToken: 5 } : null
      },
      async completeTrader() { completed = true; throw new Error('must_not_complete') },
    })
    const strategies = new StrategyService(new Strategies())
    const contexts = new TraderContextBuilder(repo, tradingRepository(), { async read() { return { revision: 6, data: {} } } }, { async read() { return { revision: 7, data: {} } } })
    const worker = new TraderWorker(repo, new InferenceService(repo, strategies), strategies, contexts, {
      profileId: null, provider: 'test', model: 'trader', timeoutMs: 1000, maxAttempts: 2,
      async decide() { if (++calls === 1) throw new ModelInvocationError('provider_busy', 'failed', true); return { result: {} as TraderDecisionResult, usage: null } },
    }, 'worker', { async assertAllowed() { if (++checks === blockedCheck) throw new InferenceError('trader_schedule_closed', 409); return 'a'.repeat(64) } })
    expect(await worker.process(base.id, new Date('2026-09-03T08:00:10.000Z'))).toMatchObject({ status: 'failed', code: 'trader_schedule_closed' })
    expect(calls).toBe(Math.max(0, blockedCheck - 2))
    expect(completed).toBe(false)
    expect(failures.at(-1)).toBe('trader_schedule_closed')
  })

  it('defers a second task for the same account without invoking its model', async () => {
    const base = run(); let modelCalls = 0
    const repo = inferenceRepository({
      async getTraderRun() { return base }, async getAnalysisDetail() { return analysis },
      async beginTrader() { throw new InferenceError('trader_account_busy', 409, 2_000) },
    })
    const worker = new TraderWorker(
      repo, new InferenceService(repo, new StrategyService(new Strategies())), new StrategyService(new Strategies()),
      new TraderContextBuilder(repo, tradingRepository(), { async read() { return { revision: 6, data: {} } } }, { async read() { return { revision: 7, data: {} } } }),
      { profileId: null, provider: 'test', model: 'trader', timeoutMs: 5_000, maxAttempts: 1, async decide() { modelCalls += 1; throw new Error('must not run') } },
      'worker-2', { async assertAllowed() { return 'a'.repeat(64) } },
    )
    await expect(worker.process(base.id, new Date('2026-09-03T08:00:10.000Z'))).resolves.toEqual({ status: 'deferred', code: 'trader_account_busy', retryAfterMs: 2_000 })
    expect(modelCalls).toBe(0)
  })

  it('keeps the schema append-only and adds account lease, stale audit and required context projections', async () => {
    const sql = await readFile(new URL('../db/migrations/20260903_006_account_trader_worker.sql', import.meta.url), 'utf8')
    const repository = await readFile(new URL('../src/modules/inference/infrastructure/mysql-inference-repository.ts', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS market_instrument_snapshots')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS account_risk_summaries')
    expect(sql).toContain('idx_ai_model_tasks_account_lease')
    expect(sql).toContain('ADD COLUMN stale_reason')
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i)
    expect(repository).toContain("throw new InferenceError('trader_account_busy'")
    expect(repository).toContain("return 'quote_changed'")
    expect(repository).not.toMatch(/execution_intent|command\.request|Bridge/i)
  })
})
