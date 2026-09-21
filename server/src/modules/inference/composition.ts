import { createMysqlEntryEventUsageReader } from './infrastructure/mysql-entry-event-usage-reader.js'
import { createMysqlAnalysisSourceReader } from './infrastructure/mysql-analysis-source-reader.js'
import type { AccountPositionEntryReader } from './application/account-position-entry-evidence.js'
import { MysqlArchivedSignalReader } from './infrastructure/mysql-archived-signal-reader.js'
import { archivedSignalRoutes } from './transport/http/archived-signal-routes.js'
import type { ArchivedSignalReader } from './application/archived-signal-reader.js'
import type { AccountPrincipalReader, ActivePrincipalAccess } from '../auth/index.js'
import type { RuntimeStrategyAccess } from '../strategies/index.js'
import { MarketAnalysisListService } from './application/market-analysis-list.js'
import { MysqlMarketAnalysisListReader } from './infrastructure/mysql-market-analysis-list-reader.js'
import type { AnalysisModelGatewayResolver } from './application/analysis-worker.js'
import type { TradeDecisionOriginReader } from './application/trade-decision-origin-reader.js'
import { createMysqlTradeDecisionOriginReader } from './infrastructure/mysql-trade-decision-origin-reader.js'
import type { TraderModelGatewayResolver } from './application/trader-worker.js'
import type { ReviewModelGatewayResolver } from '../reviews/index.js'
import { HttpJsonObjectModelGateway, type ModelUsageSettlementErrorHandler } from './infrastructure/http-json-model-gateway.js'
import { MysqlAnalysisModelGatewayResolver, MysqlTraderModelGatewayResolver, MysqlRuntimeModelProfileCatalog, type RuntimeModelResolverOptions } from './infrastructure/mysql-model-gateway-resolver.js'
import type { ModelUsageLedger, ModelUsageRecovery } from './application/model-usage-ledger.js'
import { MysqlModelUsageLedger } from './infrastructure/mysql-model-usage-ledger.js'
import type { AnalysisMarketSource, MacroSnapshotReader } from './application/analysis-context-builder.js'
import type { RuntimeStrategyMemoryReader, RuntimeMemoryPreparationWriter } from '../reviews/index.js'
import type { AnalysisTradingReader } from './application/trading-read-capabilities.js'
import { TradingAnalysisMarketSource } from './infrastructure/trading-analysis-market-source.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { AccountClockReader, AccountInventorySummaryReader } from '../trading/index.js'
import type { SubscriptionPreferencesReader, SubscriptionExecutionWindowReader, AnalysisSubscriberReader } from '../strategies/index.js'
import type { InferenceRepository } from './application/inference-ports.js'
import type { TraderAccountReader } from './application/trading-read-capabilities.js'
import type { TraderWindowGuard } from './application/trader-window-guard.js'
import { TraderContextBuilder } from './application/trader-context-builder.js'
import type { RiskSummaryReader, RiskRevisionReader } from './application/trader-context-builder.js'
import type { InstrumentSnapshotReader, InstrumentCollectionRequester } from '../trading/index.js'
import { MysqlTraderPreferencesReader } from './infrastructure/mysql-trader-preferences.js'
import { MysqlTraderWindowGuard } from './infrastructure/mysql-trader-window-guard.js'
import type { SubscriptionWindowClock, AnalysisWindowReader } from '../strategies/index.js'
import type { AnalysisWindowGuard } from './application/analysis-window-guard.js'
import { AnalysisWindowService } from './application/analysis-window-service.js'
import { MysqlMacroSnapshotReader } from './infrastructure/mysql-macro-snapshot-reader.js'
import type { FastifyPluginAsync } from 'fastify'
import { InferenceService } from './application/inference-service.js'
import { MysqlInferenceRepository } from './infrastructure/mysql-inference-repository.js'
import { inferenceRoutes, type InferenceRequestAuthenticator } from './transport/http/inference-routes.js'
import { AnalysisScheduler } from './application/analysis-scheduler.js'
import { ModelTaskRecovery } from './application/model-task-recovery.js'
import type { AnalysisScheduleStore } from '../strategies/index.js'
import { MysqlModelTaskRecoveryRepository } from './infrastructure/mysql-model-task-recovery-repository.js'
import { IndependentTraderScheduler } from './application/independent-trader-scheduler.js'
import { MysqlIndependentTraderScheduleStore } from './infrastructure/mysql-independent-trader-schedule-store.js'

export { loadCredentialKeyring } from './infrastructure/mysql-model-gateway-resolver.js'

export function createTransactionTradeDecisionOriginReader(connection: PoolConnection): TradeDecisionOriginReader {
  return createMysqlTradeDecisionOriginReader(connection)
}

export function createAnalysisScheduler(schedules: AnalysisScheduleStore, service: InferenceService,
  readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>,
  marketSessions?: import('./application/analysis-scheduler.js').AutomaticMarketSessionGuard): Pick<AnalysisScheduler, 'tick'> {
  return new AnalysisScheduler(schedules, service, readClock, marketSessions)
}

export function createIndependentTraderScheduler(pool: Pool, service: InferenceService,
  marketSessions?: import('./application/analysis-scheduler.js').AutomaticMarketSessionGuard): Pick<IndependentTraderScheduler, 'tick'> {
  return new IndependentTraderScheduler(new MysqlIndependentTraderScheduleStore(pool), service, marketSessions)
}

export function createMysqlModelTaskRecovery(pool: Pool, accounts: (connection: PoolConnection) => Pick<AccountInventorySummaryReader, 'lockAccount'>): Pick<ModelTaskRecovery, 'expireOverdue'> {
  return new ModelTaskRecovery(new MysqlModelTaskRecoveryRepository(pool, accounts))
}

export function createMysqlInferenceRepository(pool: Pool, clock: (connection: PoolConnection) => AccountClockReader,
  preferences: (connection: PoolConnection) => SubscriptionPreferencesReader,
  windows: (connection: PoolConnection) => SubscriptionExecutionWindowReader,
  dispatch: { subscribers: (connection: PoolConnection) => AnalysisSubscriberReader; inventory: (connection: PoolConnection) => AccountInventorySummaryReader; risks: (connection: PoolConnection) => RiskRevisionReader },
  memoryPreparation?: (connection: PoolConnection) => RuntimeMemoryPreparationWriter): InferenceRepository {
  return new MysqlInferenceRepository(pool, clock, preferences, windows, dispatch, memoryPreparation)
}

export function createInferenceHttp(service: InferenceService, auth: InferenceRequestAuthenticator, analysisList: Pick<MarketAnalysisListService, 'list'>, archive?: ArchivedSignalReader): FastifyPluginAsync {
  return async app => {
    await app.register(inferenceRoutes, { prefix: '/api/v4', service, auth, analysisList })
    if (archive) await app.register(archivedSignalRoutes, { prefix: '/api/v4', reader: archive, auth })
  }
}

export function createAnalysisWindowGuard(windows: AnalysisWindowReader,
  readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>): AnalysisWindowGuard {
  return new AnalysisWindowService(windows, readClock)
}

export function createMysqlMacroSnapshotReader(pool: Pool): MacroSnapshotReader {
  return new MysqlMacroSnapshotReader(pool)
}

export function createMysqlTraderContext(pool: Pool, inference: Pick<InferenceRepository, 'getAnalysisDetail'>,
  trading: TraderAccountReader, preferences: (connection: PoolConnection) => SubscriptionPreferencesReader,
  instruments: InstrumentSnapshotReader, instrumentRequests: InstrumentCollectionRequester, risks: RiskSummaryReader, memory?: RuntimeStrategyMemoryReader,
  positionEntries?: AccountPositionEntryReader): TraderContextBuilder {
  return new TraderContextBuilder(inference, trading, instruments,
    risks, new MysqlTraderPreferencesReader(pool, preferences), instrumentRequests, memory, positionEntries, createMysqlAnalysisSourceReader(pool), createMysqlEntryEventUsageReader(pool))
}

export function createMysqlTraderWindowGuard(pool: Pool, clock: (connection: PoolConnection) => AccountClockReader,
  windows: (connection: PoolConnection) => SubscriptionExecutionWindowReader): TraderWindowGuard {
  return new MysqlTraderWindowGuard(pool, clock, windows)
}

export function createAnalysisMarketSource(trading: AnalysisTradingReader, sourceAccess?: import('../market/index.js').StrategyMarketSourceAccess,
  publicClock?: () => Promise<{ offset: number; checkedAt: string } | null>,
  confirmedGaps?: ConstructorParameters<typeof TradingAnalysisMarketSource>[3]): AnalysisMarketSource {
  return new TradingAnalysisMarketSource(trading, sourceAccess, publicClock, confirmedGaps)
}

interface RuntimeModelAccessFactories {
  strategies: (connection: Pick<PoolConnection, 'execute'>) => RuntimeStrategyAccess
  principals: (connection: Pick<PoolConnection, 'execute'>) => AccountPrincipalReader
  active: (connection: Pick<PoolConnection, 'execute'>) => ActivePrincipalAccess
}

export function createMysqlModelUsageLedger(pool: Pool, access: Pick<RuntimeModelAccessFactories, 'principals' | 'active'>): ModelUsageLedger & ModelUsageRecovery {
  return new MysqlModelUsageLedger(pool, access.principals, access.active)
}

export function createMysqlAnalysisModelResolver(pool: Pool, keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions, access: RuntimeModelAccessFactories, onUsageSettlementError?: ModelUsageSettlementErrorHandler): AnalysisModelGatewayResolver {
  return new MysqlAnalysisModelGatewayResolver(new MysqlRuntimeModelProfileCatalog(pool, keyring, options, access.strategies(pool), access.principals(pool)),
    createMysqlModelUsageLedger(pool, access), onUsageSettlementError)
}

export function createMysqlTraderModelResolver(pool: Pool, keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions, access: RuntimeModelAccessFactories, onUsageSettlementError?: ModelUsageSettlementErrorHandler): TraderModelGatewayResolver {
  return new MysqlTraderModelGatewayResolver(new MysqlRuntimeModelProfileCatalog(pool, keyring, options, access.strategies(pool), access.principals(pool)),
    createMysqlModelUsageLedger(pool, access), onUsageSettlementError)
}

export function createMysqlReviewModelResolver(pool: Pool, keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions, access: RuntimeModelAccessFactories, onUsageSettlementError?: ModelUsageSettlementErrorHandler): ReviewModelGatewayResolver {
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, keyring, options, access.strategies(pool), access.principals(pool))
  const usage = createMysqlModelUsageLedger(pool, access)
  return {
    resolve: async claim => new HttpJsonObjectModelGateway(
      await profiles.resolveForFrozenReview({ userId: claim.userId, strategyId: claim.strategyId, usage: claim.kind === 'manual' ? 'manual' : 'auto' }),
      usage, fetch, onUsageSettlementError,
    ),
  }
}
export { createMysqlTradeDecisionRiskWriter } from './infrastructure/mysql-trade-decision-risk-writer.js'
export { createMysqlTradeDecisionAnalysisReader as createTransactionTradeDecisionAnalysisReader } from './infrastructure/mysql-trade-decision-analysis-reader.js'
export { createMysqlReviewDecisionContext } from './infrastructure/mysql-review-decision-context.js'
export { createMysqlProposedDecisionEvidenceReader as createTransactionProposedDecisionEvidenceReader } from './infrastructure/mysql-proposed-decision-evidence-reader.js'

export function createMysqlMarketAnalysisList(pool: Pool) { return new MarketAnalysisListService(new MysqlMarketAnalysisListReader(pool)) }
export { createMysqlAnalysisSourceReader } from './infrastructure/mysql-analysis-source-reader.js'
export { createMysqlSnapshotTradeDecisionOriginReader } from './infrastructure/mysql-trade-decision-origin-reader.js'
export { createMysqlStrategyReferenceSourceReader } from './infrastructure/mysql-strategy-reference-source-reader.js'

export { createMysqlTradeDecisionEntryAnalysisReader } from './infrastructure/mysql-trade-decision-entry-analysis-reader.js'
export { createDecisionStrategyEvidenceReader } from './infrastructure/mysql-decision-strategy-evidence-reader.js'

export function createMysqlArchivedSignalReader(pool: Pool): ArchivedSignalReader { return new MysqlArchivedSignalReader(pool) }

export { createModelSelection } from './infrastructure/mysql-model-selection.js'
export { modelSelectionRoutes } from './transport/http/model-selection-routes.js'

export { createModelConfiguration } from './infrastructure/mysql-model-configuration.js'
export { modelConfigurationRoutes } from './transport/http/model-configuration-routes.js'

export { createTradeDecisionReapprovalWriter } from './infrastructure/mysql-trade-decision-reapproval-writer.js'

export { createMysqlRiskReviewSettlement } from './infrastructure/mysql-risk-review-settlement.js'

export { createNotificationSourceReader } from './infrastructure/mysql-notification-source.js'
