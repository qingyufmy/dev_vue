import type { AnalysisModelGatewayResolver } from './application/analysis-worker.js'
import type { TraderModelGatewayResolver } from './application/trader-worker.js'
import type { ReviewModelGatewayResolver } from '../reviews/index.js'
import { HttpJsonObjectModelGateway, type ModelUsageSettlementErrorHandler } from './infrastructure/http-json-model-gateway.js'
import { MysqlAnalysisModelGatewayResolver, MysqlTraderModelGatewayResolver, MysqlRuntimeModelProfileCatalog, type RuntimeModelResolverOptions } from './infrastructure/mysql-model-gateway-resolver.js'
import type { ModelUsageLedger, ModelUsageRecovery } from './application/model-usage-ledger.js'
import { MysqlModelUsageLedger } from './infrastructure/mysql-model-usage-ledger.js'
import type { AnalysisMarketSource, MacroSnapshotReader } from './application/analysis-context-builder.js'
import type { AnalysisTradingReader } from './application/trading-read-capabilities.js'
import { TradingAnalysisMarketSource } from './infrastructure/trading-analysis-market-source.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { AccountClockReader } from '../trading/index.js'
import type { SubscriptionPreferencesReader } from '../strategies/index.js'
import type { InferenceRepository } from './application/inference-ports.js'
import type { TraderAccountReader } from './application/trading-read-capabilities.js'
import type { TraderWindowGuard } from './application/trader-window-guard.js'
import { TraderContextBuilder } from './application/trader-context-builder.js'
import { MysqlInstrumentSnapshotReader, MysqlRiskSummaryReader } from './infrastructure/mysql-trader-context-readers.js'
import { MysqlTraderPreferencesReader } from './infrastructure/mysql-trader-preferences.js'
import { MysqlTraderWindowGuard } from './infrastructure/mysql-trader-window-guard.js'
import type { SubscriptionWindowClock } from '../strategies/index.js'
import type { AnalysisWindowGuard } from './application/analysis-window-guard.js'
import { MysqlAnalysisWindowGuard } from './infrastructure/mysql-analysis-window-guard.js'
import { MysqlMacroSnapshotReader } from './infrastructure/mysql-macro-snapshot-reader.js'
import type { FastifyPluginAsync } from 'fastify'
import type { StrategyService } from '../strategies/index.js'
import { InferenceService } from './application/inference-service.js'
import { MysqlInferenceRepository } from './infrastructure/mysql-inference-repository.js'
import { inferenceRoutes, type InferenceRequestAuthenticator } from './transport/http/inference-routes.js'
import { AnalysisScheduler } from './application/analysis-scheduler.js'
import { ModelTaskRecovery } from './application/model-task-recovery.js'
import { MysqlAnalysisScheduleRepository } from './infrastructure/mysql-analysis-schedule-repository.js'
import { MysqlModelTaskRecoveryRepository } from './infrastructure/mysql-model-task-recovery-repository.js'

export { loadCredentialKeyring } from './infrastructure/mysql-model-gateway-resolver.js'

export function createMysqlAnalysisScheduler(pool: Pool, service: InferenceService,
  readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>): Pick<AnalysisScheduler, 'tick'> {
  return new AnalysisScheduler(new MysqlAnalysisScheduleRepository(pool), service, readClock)
}

export function createMysqlModelTaskRecovery(pool: Pool): Pick<ModelTaskRecovery, 'expireOverdue'> {
  return new ModelTaskRecovery(new MysqlModelTaskRecoveryRepository(pool))
}

export function createMysqlInferenceRepository(pool: Pool, clock: (connection: PoolConnection) => AccountClockReader,
  preferences: (connection: PoolConnection) => SubscriptionPreferencesReader): InferenceRepository {
  return new MysqlInferenceRepository(pool, clock, preferences)
}

export function createInferenceHttp(service: InferenceService, strategies: StrategyService, auth: InferenceRequestAuthenticator): FastifyPluginAsync {
  return async app => { await app.register(inferenceRoutes, { prefix: '/api/v4', service, strategies, auth }) }
}

export function createMysqlAnalysisWindowGuard(pool: Pool,
  readClock: (accountId: string, userId: number) => Promise<SubscriptionWindowClock | null>): AnalysisWindowGuard {
  return new MysqlAnalysisWindowGuard(pool, readClock)
}

export function createMysqlMacroSnapshotReader(pool: Pool): MacroSnapshotReader {
  return new MysqlMacroSnapshotReader(pool)
}

export function createMysqlTraderContext(pool: Pool, inference: Pick<InferenceRepository, 'getAnalysisDetail'>,
  trading: TraderAccountReader, preferences: (connection: PoolConnection) => SubscriptionPreferencesReader): TraderContextBuilder {
  return new TraderContextBuilder(inference, trading, new MysqlInstrumentSnapshotReader(pool),
    new MysqlRiskSummaryReader(pool), new MysqlTraderPreferencesReader(pool, preferences))
}

export function createMysqlTraderWindowGuard(pool: Pool, clock: (connection: PoolConnection) => AccountClockReader): TraderWindowGuard {
  return new MysqlTraderWindowGuard(pool, clock)
}

export function createAnalysisMarketSource(trading: AnalysisTradingReader): AnalysisMarketSource {
  return new TradingAnalysisMarketSource(trading)
}

export function createMysqlModelUsageLedger(pool: Pool): ModelUsageLedger & ModelUsageRecovery {
  return new MysqlModelUsageLedger(pool)
}

export function createMysqlAnalysisModelResolver(pool: Pool, keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions, onUsageSettlementError?: ModelUsageSettlementErrorHandler): AnalysisModelGatewayResolver {
  return new MysqlAnalysisModelGatewayResolver(new MysqlRuntimeModelProfileCatalog(pool, keyring, options),
    createMysqlModelUsageLedger(pool), onUsageSettlementError)
}

export function createMysqlTraderModelResolver(pool: Pool, keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions, onUsageSettlementError?: ModelUsageSettlementErrorHandler): TraderModelGatewayResolver {
  return new MysqlTraderModelGatewayResolver(new MysqlRuntimeModelProfileCatalog(pool, keyring, options),
    createMysqlModelUsageLedger(pool), onUsageSettlementError)
}

export function createMysqlReviewModelResolver(pool: Pool, keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions, onUsageSettlementError?: ModelUsageSettlementErrorHandler): ReviewModelGatewayResolver {
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, keyring, options)
  const usage = createMysqlModelUsageLedger(pool)
  return {
    resolve: async claim => new HttpJsonObjectModelGateway(
      await profiles.resolveForFrozenReview({ userId: claim.userId, strategyId: claim.strategyId, usage: claim.kind === 'manual' ? 'manual' : 'auto' }),
      usage, fetch, onUsageSettlementError,
    ),
  }
}
