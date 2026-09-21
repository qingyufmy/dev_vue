import { matchesMarketSymbol } from '../../trading/index.js'
import { assertStrategySymbol } from '../../strategies/index.js'
import { freezeEntryEventUsage, type EntryEventUsageReader } from './entry-event-usage.js'
import { parseEntryEventPolicy } from '../../strategies/index.js'
import type { AnalysisSourceReader } from './analysis-source-reader.js'
import { freezeAccountPositionEntries, type AccountPositionEntryReader } from './account-position-entry-evidence.js'
import type { TraderAccountReader } from './trading-read-capabilities.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'
import type { InstrumentSnapshotReader, InstrumentCollectionRequester } from '../../trading/index.js'
import type { StrategyVersion } from '../../strategies/index.js'
import type { SubscriptionExecutionPreferences } from '../../strategies/index.js'
import { parseStrategyEntryMethods, strategyEntryMethods } from '../../strategies/index.js'
import type { InferenceRepository } from './inference-ports.js'
import type { JsonObject, TraderInputSnapshot, TraderRun } from '../domain/inference.js'
import { contentHash, InferenceError, traderTaskMode } from '../domain/inference.js'
import type { RuntimeStrategyMemoryReader } from '../../reviews/index.js'
import { freezeStrategyMemory } from './freeze-strategy-memory.js'
import { capturePriceActionEvidence } from '../../market/index.js'
import { isIndependentRoleConfig, parseStrategyMarketDataPlan } from '../../strategies/index.js'

export interface VersionedTraderContext {
  revision: number
  data: JsonObject
}

export interface RiskSummaryReader {
  read(userId: number, accountId: string): Promise<VersionedTraderContext | null>
}

export interface RiskRevisionReader {
  readRevision(userId: number, accountId: string): Promise<number | null>
}

export class TraderContextBuilder {
  constructor(
    private readonly inference: Pick<InferenceRepository, 'getAnalysisDetail'>,
    private readonly trading: TraderAccountReader,
    private readonly instruments: InstrumentSnapshotReader,
    private readonly risks: RiskSummaryReader,
    private readonly preferences?: { read(run: TraderRun): Promise<SubscriptionExecutionPreferences> },
    private readonly instrumentRequests?: InstrumentCollectionRequester,
    private readonly memory?: RuntimeStrategyMemoryReader,
    private readonly positionEntries?: AccountPositionEntryReader,
    private readonly analysisSources?: AnalysisSourceReader,
    private readonly entryEventUsage?: EntryEventUsageReader,
  ) {}

  async build(run: TraderRun, strategy: StrategyVersion, now = new Date()): Promise<TraderInputSnapshot> {
    const analysis = await this.inference.getAnalysisDetail(run.userId, run.marketAnalysisId)
    if (!analysis) throw new InferenceError('trader_analysis_expired', 409)
    const backgroundValid = Date.parse(analysis.summary.validUntil) > now.getTime()
    const independent = isIndependentRoleConfig(strategy.config)
    if (!backgroundValid && !independent) throw new InferenceError('trader_analysis_expired', 409)
    assertStrategySymbol(strategy.config, analysis.summary.symbol)
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
    if (!contract) {
      if (!this.instrumentRequests) throw new InferenceError('trader_contract_unavailable', 409)
      try {
        await this.instrumentRequests.request({ userId: run.userId, accountId: run.tradingAccountId, symbol: analysis.summary.symbol })
      } catch (error) {
        // A lost registration acknowledgement may already have committed the ID-only outbox request.
        if (!(error instanceof Error) || error.message !== 'instrument_request_commit_unknown') throw error
      }
      throw new InferenceError('trader_contract_pending', 409)
    }
    if (!quote) throw new InferenceError('trader_quote_unavailable', 409)
    if (!risk) throw new InferenceError('trader_risk_summary_unavailable', 409)

    const [accountRevision, quoteRevision, positionsRevision, pendingOrdersRevision] = await Promise.all([
      this.trading.latestRevision(run.tradingAccountId, 'account.metrics', 'current'),
      this.trading.latestRevision(run.tradingAccountId, 'market.quote', quote.symbol),
      this.trading.latestRevision(run.tradingAccountId, 'positions', 'open'),
      this.trading.latestRevision(run.tradingAccountId, 'pending_orders', 'open'),
    ])
    if (account.revision !== accountRevision || quote.revision !== quoteRevision || positions.revision !== positionsRevision || pendingOrders.revision !== pendingOrdersRevision) {
      throw new InferenceError('trader_context_torn_read', 409)
    }
    const hasPositions = positions.items.some(item => matchesMarketSymbol(item.symbol, analysis.summary.symbol))
    const hasPendingOrders = pendingOrders.items.some(item => matchesMarketSymbol(item.symbol, analysis.summary.symbol))
    const taskMode = traderTaskMode(analysis.summary.opportunity, hasPositions, hasPendingOrders, independent, backgroundValid)
    if (!taskMode) throw new InferenceError(backgroundValid ? 'trader_no_actionable_context' : 'trader_analysis_expired', 409)

    const strategyMemory = await freezeStrategyMemory({ userId: run.userId, strategyId: strategy.strategyId, strategyKind: 'trader' }, this.memory)
    // Account management uses owned inventory, never observer attribution or legacy reference requirements.
    const source = this.analysisSources ? await this.analysisSources.read({ userId: run.userId, analysisId: analysis.summary.id,
      analysisStrategyId: analysis.summary.strategyId, symbol: analysis.summary.symbol }) : null
    if (source && (source.analysisId !== analysis.summary.id || source.strategyVersionId !== analysis.summary.strategyVersionId
      || source.snapshotHash !== analysis.summary.inputSnapshotHash)) throw new InferenceError('analysis_source_evidence_invalid', 409)
    const currentEvents = independent && backgroundValid
      ? await this.readCurrentEntryEvents(run, strategy, account, analysis.summary.symbol, now)
      : source?.priceActionEvents
    const entryEventUsage = await freezeEntryEventUsage({ userId: run.userId, accountId: run.tradingAccountId, strategyId: strategy.strategyId },
      currentEvents, this.entryEventUsage)
    const accountPositionEntryEvidence = await freezeAccountPositionEntries({ userId: run.userId, accountId: run.tradingAccountId,
      positionsRevision, positions: positions.items, asOf: now.toISOString() }, this.positionEntries)
    return {
      accountPositionEntryEvidence,
      ...(entryEventUsage === undefined ? {} : { entryEventUsage }),
      ...(strategy.config.entry_event_policy === undefined ? {} : { entryEventPolicy: parseEntryEventPolicy(strategy.config.entry_event_policy)! }),
      ...(currentEvents === undefined ? {} : { marketEntryEvents: independent ? { schemaVersion: 2, source: 'current_market/v2',
        sourceAccountId: run.tradingAccountId, capturedAt: now.toISOString(), timeframes: JSON.parse(JSON.stringify(currentEvents)) as JsonObject }
        : { schemaVersion: 1, analysisId: source!.analysisId, sourceAccountId: source!.sourceAccountId, snapshotHash: source!.snapshotHash,
          timeframes: JSON.parse(JSON.stringify(currentEvents)) as JsonObject } }),
      ...(strategyMemory === undefined ? {} : { strategyMemory }),
      entryMethods: parseStrategyEntryMethods(strategy.config.entry_methods === undefined ? [...strategyEntryMethods] : strategy.config.entry_methods),
      ...(this.preferences ? { executionPreferences: await this.preferences.read(run) } : {}),
      kind: 'trader', taskMode,
      ...(independent ? { responsibilityMode: 'independent_roles_v2' as const } : {}),
      strategyConfigHash: sha256Canonical(strategy.config),
      strategy: { id: strategy.strategyId, versionId: strategy.id, promptHash: strategy.promptHash, promptText: strategy.promptText },
      analysis: { id: analysis.summary.id, contentHash: contentHash(analysis.result), result: jsonObject(analysis.result) },
      account: jsonObject(account), positions: positions.items.map(jsonObject), pendingOrders: pendingOrders.items.map(jsonObject),
      quote: jsonObject(quote), contract: contract.data, risk: risk.data,
      analysisRevision: analysis.summary.revision, subscriptionRevision: run.subscriptionRevision,
      accountRevision, positionsRevision, pendingOrdersRevision, quoteRevision,
      contractRevision: contract.revision, riskRevision: risk.revision, capturedAt: now.toISOString(),
    }
  }

  private async readCurrentEntryEvents(run: TraderRun, strategy: StrategyVersion,
    account: Awaited<ReturnType<TraderAccountReader['getAccountSnapshot']>> & {}, symbol: string, now: Date) {
    const plan = parseStrategyMarketDataPlan(strategy.config.market_data_plan)
    const result: JsonObject = {}
    const steps: Record<string, number> = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 }
    for (const row of plan.timeframes) {
      const items = await this.trading.listCandles(run.tradingAccountId, symbol, row.timeframe as Parameters<TraderAccountReader['listCandles']>[2], Math.max(30, row.kline_count))
      result[row.timeframe] = JSON.parse(JSON.stringify(capturePriceActionEvidence(items, {
        sourceAccountId: run.tradingAccountId, symbol, timeframe: row.timeframe, timeframeMs: steps[row.timeframe]!, referenceTime: now.toISOString(),
        clock: { clockStatus: account.clockStatus, timezoneOffsetMinutes: account.timezoneOffsetMinutes, observedAt: account.observedAt },
      }))) as JsonObject
    }
    return result
  }
}

function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}
