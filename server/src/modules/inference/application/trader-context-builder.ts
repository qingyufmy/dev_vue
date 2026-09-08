import type { TraderAccountReader } from './trading-read-capabilities.js'
import type { StrategyVersion } from '../../strategies/domain/strategy.js'
import type { SubscriptionExecutionPreferences } from '../../strategies/index.js'
import { parseStrategyEntryMethods, strategyEntryMethods } from '../../strategies/index.js'
import type { InferenceRepository } from './inference-ports.js'
import type { JsonObject, TraderInputSnapshot, TraderRun } from '../domain/inference.js'
import { contentHash, InferenceError } from '../domain/inference.js'

export interface VersionedTraderContext {
  revision: number
  data: JsonObject
}

export interface InstrumentSnapshotReader {
  read(accountId: string, symbol: string): Promise<VersionedTraderContext | null>
}

export interface RiskSummaryReader {
  read(userId: number, accountId: string): Promise<VersionedTraderContext | null>
}

export class TraderContextBuilder {
  constructor(
    private readonly inference: Pick<InferenceRepository, 'getAnalysisDetail'>,
    private readonly trading: TraderAccountReader,
    private readonly instruments: InstrumentSnapshotReader,
    private readonly risks: RiskSummaryReader,
    private readonly preferences?: { read(run: TraderRun): Promise<SubscriptionExecutionPreferences> },
  ) {}

  async build(run: TraderRun, strategy: StrategyVersion, now = new Date()): Promise<TraderInputSnapshot> {
    const analysis = await this.inference.getAnalysisDetail(run.userId, run.marketAnalysisId)
    if (!analysis || Date.parse(analysis.summary.validUntil) <= now.getTime()) throw new InferenceError('trader_analysis_expired', 409)
    const [owned, account, positions, pendingOrders, quote, contract, risk] = await Promise.all([
      this.trading.findOwnedAccount(run.userId, run.tradingAccountId),
      this.trading.getAccountSnapshot(run.tradingAccountId, run.userId),
      this.trading.listPositions(run.tradingAccountId, run.userId),
      this.trading.listPendingOrders(run.tradingAccountId, run.userId),
      this.trading.getQuote(run.tradingAccountId, analysis.summary.symbol),
      this.instruments.read(run.tradingAccountId, analysis.summary.symbol),
      this.risks.read(run.userId, run.tradingAccountId),
    ])
    if (!owned || !account) throw new InferenceError('trader_account_unavailable', 409)
    // Revision zero is an unavailable/unproven collection, not a confirmed
    // empty portfolio. It must never become model input for a trading decision.
    if ([positions.revision, pendingOrders.revision].some(revision => !Number.isSafeInteger(revision) || revision < 1)) {
      throw new InferenceError('trader_context_torn_read', 409)
    }
    if (!quote) throw new InferenceError('trader_quote_unavailable', 409)
    if (!contract) throw new InferenceError('trader_contract_unavailable', 409)
    if (!risk) throw new InferenceError('trader_risk_summary_unavailable', 409)

    const [accountRevision, quoteRevision, positionsRevision, pendingOrdersRevision] = await Promise.all([
      this.trading.latestRevision(run.tradingAccountId, 'account.metrics', 'current'),
      this.trading.latestRevision(run.tradingAccountId, 'market.quote', analysis.summary.symbol),
      this.trading.latestRevision(run.tradingAccountId, 'positions', 'open'),
      this.trading.latestRevision(run.tradingAccountId, 'pending_orders', 'open'),
    ])
    if (account.revision !== accountRevision || quote.revision !== quoteRevision || positions.revision !== positionsRevision || pendingOrders.revision !== pendingOrdersRevision) {
      throw new InferenceError('trader_context_torn_read', 409)
    }
    if (run.positionsRevision !== positionsRevision || run.pendingOrdersRevision !== pendingOrdersRevision) throw new InferenceError('trader_projection_revision_conflict', 409)

    return {
      entryMethods: parseStrategyEntryMethods(strategy.config.entry_methods === undefined ? [...strategyEntryMethods] : strategy.config.entry_methods),
      ...(this.preferences ? { executionPreferences: await this.preferences.read(run) } : {}),
      kind: 'trader', taskMode: run.taskMode,
      strategy: { id: strategy.strategyId, versionId: strategy.id, promptHash: strategy.promptHash, promptText: strategy.promptText },
      analysis: { id: analysis.summary.id, contentHash: contentHash(analysis.result), result: jsonObject(analysis.result) },
      account: jsonObject(account), positions: positions.items.map(jsonObject), pendingOrders: pendingOrders.items.map(jsonObject),
      quote: jsonObject(quote), contract: contract.data, risk: risk.data,
      analysisRevision: analysis.summary.revision, subscriptionRevision: run.subscriptionRevision,
      accountRevision, positionsRevision, pendingOrdersRevision, quoteRevision,
      contractRevision: contract.revision, riskRevision: risk.revision, capturedAt: now.toISOString(),
    }
  }
}

function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}
