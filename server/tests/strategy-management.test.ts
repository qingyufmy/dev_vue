import { createStrategyHttp } from '../src/modules/strategies/composition.js'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  compileStrategy, StrategyService,
  type CreateStrategyInput, type CreateStrategySubscriptionInput, type CreateStrategyVersionInput,
  type PublishStrategyVersionInput, type RetireStrategyInput, type StrategyCatalog, type StrategyCompileResult,
  type StrategyDetail, type StrategyKind, type StrategyManagementRepository, type StrategySubscription,
  type StrategySummary, type StrategyVersion, type UpdateStrategyMetadataInput, type UpdateStrategySubscriptionInput,
} from '../src/modules/strategies/index.js'

const analysisVersion: StrategyVersion = {
  id: 'version-analysis-1', strategyId: 'strategy-analysis-1', kind: 'analysis', version: 1,
  promptText: '只分析市场结构', promptHash: 'a'.repeat(64), config: { timeframes: ['M5'], candle_limit: 300 },
  inputContractVersion: 'market-analysis-input/v1', outputContractVersion: 'market-analysis/v1',
}
const traderVersion: StrategyVersion = {
  id: 'version-trader-1', strategyId: 'strategy-trader-1', kind: 'trader', version: 1,
  promptText: '结合账户决定是否执行', promptHash: 'b'.repeat(64), config: {},
  inputContractVersion: 'account-trader-input/v1', outputContractVersion: 'trade-decision/v1',
}

class MemoryStrategyRepository implements StrategyCatalog, StrategyManagementRepository {
  readonly analysisSummary: StrategySummary = {
    id: analysisVersion.strategyId, kind: 'analysis', scope: 'user', ownerUserId: 42, name: '行情分析',
    description: '分析市场', status: 'active', activeVersionId: analysisVersion.id, revision: 1,
  }
  readonly traderSummary: StrategySummary = {
    id: traderVersion.strategyId, kind: 'trader', scope: 'user', ownerUserId: 42, name: '账户交易',
    description: '账户级判断', status: 'active', activeVersionId: traderVersion.id, revision: 1,
  }
  readonly details = new Map<string, StrategyDetail>([
    [this.analysisSummary.id, { summary: this.analysisSummary, versions: [{ ...analysisVersion, createdByUserId: 42, createdAt: '2026-09-04T04:00:00.000Z' }] }],
    [this.traderSummary.id, { summary: this.traderSummary, versions: [{ ...traderVersion, createdByUserId: 42, createdAt: '2026-09-04T04:00:00.000Z' }] }],
  ])
  subscriptions: StrategySubscription[] = []
  updatedSubscriptionInput: UpdateStrategySubscriptionInput | null = null

  async listAvailable(_userId: number, kind?: StrategyKind) {
    return [this.analysisSummary, this.traderSummary].filter(item => kind === undefined || item.kind === kind)
  }

  async findActiveVersion(userId: number, strategyId: string) {
    if (userId !== 42) return null
    const detail = this.details.get(strategyId)
    if (!detail || detail.summary.status !== 'active' || !detail.summary.activeVersionId) return null
    return detail.versions.find(item => item.id === detail.summary.activeVersionId) ?? null
  }

  async findDetail(userId: number, strategyId: string) {
    const detail = this.details.get(strategyId)
    return userId === 42 ? detail ?? null : null
  }

  async create(input: CreateStrategyInput & { compiled: StrategyCompileResult }) {
    const id = 'strategy-created'
    const version = { id: 'version-created-1', strategyId: id, kind: input.kind, version: 1, promptText: input.promptText, promptHash: input.compiled.promptHash, config: input.compiled.normalizedConfig, inputContractVersion: input.compiled.inputContractVersion, outputContractVersion: input.compiled.outputContractVersion, createdByUserId: input.userId, createdAt: '2026-09-04T04:00:00.000Z' }
    const detail: StrategyDetail = { summary: { id, kind: input.kind, scope: 'user', ownerUserId: input.userId, name: input.name, description: input.description, status: 'draft', activeVersionId: null, revision: 1 }, versions: [version] }
    this.details.set(id, detail)
    return detail
  }

  async updateMetadata(input: UpdateStrategyMetadataInput) {
    const detail = this.details.get(input.strategyId)
    if (!detail) throw new Error('not found')
    const updated: StrategyDetail = { ...detail, summary: { ...detail.summary, name: input.name, description: input.description, revision: input.expectedRevision + 1 } }
    this.details.set(input.strategyId, updated)
    return updated
  }

  async createVersion(input: CreateStrategyVersionInput) { return this.details.get(input.strategyId)! }
  async publishVersion(_input: PublishStrategyVersionInput) { return this.details.get('strategy-analysis-1')! }
  async retire(_input: RetireStrategyInput) { return this.details.get('strategy-analysis-1')! }
  async findSubscription(_userId: number, subscriptionId: string) { return this.subscriptions.find(item => item.id === subscriptionId) ?? null }
  async listSubscriptions(_userId: number, _tradingAccountId?: string) { return this.subscriptions }

  async createSubscription(input: CreateStrategySubscriptionInput) {
    const item: StrategySubscription = {
      id: 'subscription-1', userId: input.userId, tradingAccountId: input.tradingAccountId, standardSymbol: input.standardSymbol,
      analysisStrategyId: input.analysisStrategyId, analysisStrategyVersionId: analysisVersion.id, traderStrategyId: input.traderStrategyId,
      traderStrategyVersionId: input.traderStrategyId ? traderVersion.id : null, analysisEnabled: input.analysisEnabled, traderEnabled: input.traderEnabled,
      tradeSendEnabled: input.tradeSendEnabled, status: input.status, revision: 1, createdAt: '2026-09-04T04:00:00.000Z', updatedAt: '2026-09-04T04:00:00.000Z',
      schedule: { cadenceSeconds: 300, receiveTimezone: 'UTC', receiveWindow: { enabled: false }, nextDueAt: input.nextDueAt, revision: 1 },
    }
    this.subscriptions = [item]
    return item
  }

  async updateSubscription(input: UpdateStrategySubscriptionInput) {
    this.updatedSubscriptionInput = input
    return this.subscriptions[0]!
  }
}

const auth = {
  async authenticate() { return { userId: 42 } },
  async assertWrite() { return { userId: 42 } },
}

describe('Stage 12Q strategy management', () => {
  it('compiles deterministic analysis config and fails closed on unsupported capabilities', () => {
    const valid = compileStrategy('analysis', '  只分析黄金  ', { candle_limit: 500, timeframes: ['M5', 'H1'] })
    expect(valid).toMatchObject({ valid: true, normalizedConfig: { candle_limit: 500, timeframes: ['M5', 'H1'], macro_evidence: { mode: 'off' } }, inputContractVersion: 'market-analysis-input/v1' })
    expect(compileStrategy('analysis', '分析', {}).normalizedConfig).toEqual({ timeframes: ['M5', 'M15', 'H1', 'H4'], candle_limit: 300, macro_evidence: { mode: 'off' } })
    expect(compileStrategy('analysis', '分析', {
      macro_evidence: { mode: 'context', accepted_schema_versions: [1, 2], max_age_seconds: 172800 },
    })).toMatchObject({
      valid: true,
      normalizedConfig: { macro_evidence: { mode: 'context', accepted_schema_versions: [1, 2], max_age_seconds: 172800 } },
    })
    expect(compileStrategy('analysis', '分析', { macro_evidence: { mode: 'required', accepted_schema_versions: [1], max_age_seconds: 172800 } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'macro_evidence_mode_invalid' })]))
    expect(compileStrategy('analysis', '分析', { macro_evidence: { mode: 'context', accepted_schema_versions: [1, 1], max_age_seconds: 10 } }).issues)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'macro_evidence_schema_versions_invalid' }),
        expect.objectContaining({ code: 'macro_evidence_max_age_invalid' }),
      ]))
    const rejected = compileStrategy('trader', '执行判断', { network: { url: 'https://example.test' } })
    expect(rejected.valid).toBe(false)
    expect(rejected.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dangerous_capability_forbidden', path: 'config.network' })]))
    expect(compileStrategy('analysis', '分析', { unsupported: true }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'config_field_unknown' })]))
  })

  it('serves compile, detail and user strategy writes with strict CSRF/CAS boundaries', async () => {
    const repository = new MemoryStrategyRepository()
    const app = Fastify({ logger: false })
    await app.register(createStrategyHttp(new StrategyService(repository), auth))

    const compiled = await app.inject({ method: 'POST', url: '/api/v4/strategies/compile', headers: { 'x-csrf-token': 'csrf-token' }, payload: { kind: 'analysis', prompt_text: '分析', config: {} } })
    expect(compiled.statusCode).toBe(200)
    expect(compiled.json().data).toMatchObject({ valid: true, input_contract_version: 'market-analysis-input/v1' })

    const detail = await app.inject({ method: 'GET', url: '/api/v4/strategies/strategy-analysis-1' })
    expect(detail.statusCode).toBe(200)
    expect(detail.headers.etag).toBe('"1"')
    expect(detail.json().data.versions).toHaveLength(1)

    const missingCas = await app.inject({ method: 'PATCH', url: '/api/v4/strategies/strategy-analysis-1', headers: { 'x-csrf-token': 'csrf-token' }, payload: { name: '新名字', description: '说明' } })
    expect(missingCas.statusCode).toBe(428)

    const created = await app.inject({ method: 'POST', url: '/api/v4/strategies', headers: { 'x-csrf-token': 'csrf-token' }, payload: { kind: 'analysis', name: '新增', description: '', prompt_text: '分析', config: {} } })
    expect(created.statusCode).toBe(201)
    expect(created.json().data.versions[0]).not.toHaveProperty('compiled')
    await app.close()
  })

  it('rejects an executable subscription without a trader strategy', async () => {
    const app = Fastify({ logger: false })
    await app.register(createStrategyHttp(new StrategyService(new MemoryStrategyRepository()), auth))
    const response = await app.inject({ method: 'POST', url: '/api/v4/strategy-subscriptions', headers: { 'x-csrf-token': 'csrf-token' }, payload: { trading_account_id: 'account-1', symbol: 'XAUUSD', analysis_strategy_id: 'strategy-analysis-1', trader_enabled: true } })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'subscription_trader_required' })
    const ended = await app.inject({ method: 'POST', url: '/api/v4/strategy-subscriptions', headers: { 'x-csrf-token': 'csrf-token' }, payload: { trading_account_id: 'account-1', symbol: 'XAUUSD', analysis_strategy_id: 'strategy-analysis-1', status: 'ended' } })
    expect(ended.statusCode).toBe(422)
    await app.close()
  })

  it('keeps pinned versions on ordinary subscription toggles and treats ended as terminal', async () => {
    const repository = new MemoryStrategyRepository()
    repository.subscriptions = [{
      id: 'subscription-1', userId: 42, tradingAccountId: 'account-1', standardSymbol: 'XAUUSD',
      analysisStrategyId: analysisVersion.strategyId, analysisStrategyVersionId: analysisVersion.id,
      traderStrategyId: traderVersion.strategyId, traderStrategyVersionId: traderVersion.id,
      analysisEnabled: true, traderEnabled: true, tradeSendEnabled: false, status: 'active', revision: 4,
      createdAt: '2026-09-04T04:00:00.000Z', updatedAt: '2026-09-04T04:00:00.000Z',
      schedule: { cadenceSeconds: 300, receiveTimezone: 'UTC', receiveWindow: { enabled: false }, nextDueAt: null, revision: 1 },
    }]
    const service = new StrategyService(repository)
    await service.updateSubscription({ userId: 42, subscriptionId: 'subscription-1', expectedRevision: 4, traderEnabled: false })
    expect(repository.updatedSubscriptionInput).toMatchObject({ analysisStrategyId: analysisVersion.strategyId, traderStrategyId: traderVersion.strategyId, traderEnabled: false })
    expect(repository.updatedSubscriptionInput).not.toHaveProperty('analysisStrategyVersionId')
    expect(repository.updatedSubscriptionInput).not.toHaveProperty('traderStrategyVersionId')

    repository.subscriptions[0] = { ...repository.subscriptions[0]!, status: 'active', traderEnabled: false }
    await service.updateSubscription({
      userId: 42, subscriptionId: 'subscription-1', expectedRevision: 4,
      analysisStrategyId: analysisVersion.strategyId, traderStrategyId: traderVersion.strategyId,
    })
    expect(repository.updatedSubscriptionInput).not.toHaveProperty('analysisStrategyVersionId')
    expect(repository.updatedSubscriptionInput).not.toHaveProperty('traderStrategyVersionId')

    repository.subscriptions[0] = { ...repository.subscriptions[0]!, status: 'ended' }
    await expect(service.updateSubscription({ userId: 42, subscriptionId: 'subscription-1', expectedRevision: 4, status: 'active' })).rejects.toMatchObject({ code: 'strategy_subscription_ended', status: 409 })
  })
})
