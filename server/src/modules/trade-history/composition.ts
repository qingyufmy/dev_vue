import type { ArchivedExecutionReader } from '../execution/index.js'
export { createMysqlRiskHistoryReader } from './infrastructure/mysql-risk-history-reader.js'
import { ArchivedExecutionDeals } from './application/archived-execution-deals.js'
import { MysqlArchivedExecutionDeals } from './infrastructure/mysql-archived-execution-deals.js'
import { archivedExecutionDealRoutes } from './transport/http/archived-execution-deal-routes.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { TerminalFactRouteGuard } from '../trading/index.js'
import type { FastifyPluginAsync } from 'fastify'
import { TradeHistoryService } from './application/trade-history-service.js'
import { MysqlTradeHistoryRepository } from './infrastructure/mysql-trade-history-repository.js'
import { tradeHistoryRoutes, type TradeHistoryRequestAuthenticator } from './transport/http/trade-history-routes.js'
import type { BridgeHistoryQueryClient } from '../bridge/index.js'
import { HistoryTaskProcessor } from './application/history-task-processor.js'
import { HistoryTaskWorker } from './application/history-task-worker.js'
import { MysqlHistoryTaskLocator } from './infrastructure/mysql-history-task-locator.js'
import { MysqlHistoryTaskRecovery } from './infrastructure/mysql-history-task-recovery.js'
import type { HistoryTaskRecovery } from './application/history-task-recovery.js'
import { MysqlHistoryCollectionTasks } from './infrastructure/mysql-history-collection-tasks.js'
import { TradeHistoryScheduleService } from './application/trade-history-scheduler.js'
import { MysqlTradeHistoryCollectorRepository } from './infrastructure/mysql-trade-history-collector-repository.js'
import { MysqlTradeHistoryScheduleRepository } from './infrastructure/mysql-trade-history-schedule-repository.js'
export { assertMysqlTradeHistorySchemaReady, assertMysqlTradeHistoryCollectorSchemaReady } from './infrastructure/mysql-schema-readiness.js'

export function createMysqlHistoryTaskProcessor(pool: Pool, queries: BridgeHistoryQueryClient, routeGuard: (connection: PoolConnection) => TerminalFactRouteGuard): Pick<HistoryTaskProcessor, 'process'> {
  return new HistoryTaskProcessor(new MysqlHistoryCollectionTasks(pool, routeGuard),
    claim => new MysqlTradeHistoryCollectorRepository(pool, routeGuard, claim), queries)
}

export function createMysqlHistoryTaskWorker(pool: Pool, queries: BridgeHistoryQueryClient,
  routes: ConstructorParameters<typeof HistoryTaskWorker>[1], routeGuard: (connection: PoolConnection) => TerminalFactRouteGuard,
  clocks?: ConstructorParameters<typeof HistoryTaskWorker>[3]): Pick<HistoryTaskWorker, 'run'> {
  return new HistoryTaskWorker(new MysqlHistoryTaskLocator(pool), routes, createMysqlHistoryTaskProcessor(pool, queries, routeGuard), clocks)
}

export function createMysqlTradeHistoryScheduler(pool: Pool, accounts: ConstructorParameters<typeof MysqlTradeHistoryScheduleRepository>[1]): Pick<TradeHistoryScheduleService, 'schedule'> {
  return new TradeHistoryScheduleService(new MysqlTradeHistoryScheduleRepository(pool, accounts))
}

export function createMysqlHistoryTaskRecovery(pool: Pool): HistoryTaskRecovery {
  return new MysqlHistoryTaskRecovery(pool)
}

export function createTradeHistoryHttp(service: TradeHistoryService, auth: TradeHistoryRequestAuthenticator, archive?: Pick<ArchivedExecutionDeals,'list'>): FastifyPluginAsync {
  return async app => {
    await app.register(tradeHistoryRoutes, { prefix: '/api/v4', service, auth })
    if (archive) await app.register(archivedExecutionDealRoutes, { prefix: '/api/v4', reader: archive, auth })
  }
}

export function createMysqlTradeHistoryHttp(pool: Pool, auth: TradeHistoryRequestAuthenticator, executions?: Pick<ArchivedExecutionReader,'get'>): FastifyPluginAsync {
  return createTradeHistoryHttp(new TradeHistoryService(new MysqlTradeHistoryRepository(pool)), auth, executions ? createMysqlArchivedExecutionDeals(pool,executions) : undefined)
}

export { assertMysqlHistoryTaskSchemaReady } from './infrastructure/mysql-history-task-schema-readiness.js'
export { createMysqlOpenPositionLifecycleReader } from './infrastructure/mysql-open-position-lifecycle-reader.js'

export { createMysqlHistoryTraversalReader } from './infrastructure/mysql-history-traversal-reader.js'

export { createMysqlHistoryTaskCoverageReader } from './infrastructure/mysql-history-task-coverage-reader.js'

export { createMysqlHistoryTaskDealSourceReader } from './infrastructure/mysql-history-task-deal-source-reader.js'

export { createMysqlHistoryWindowCoverageReader } from './infrastructure/mysql-history-window-coverage-reader.js'

export { createMysqlOpenPositionHistoryReader } from './infrastructure/mysql-open-position-history-reader.js'

export { createMysqlClosedOrderHistoryReader } from './infrastructure/mysql-closed-order-history-reader.js'
export { createMysqlReviewTradeEvidenceReader as createTransactionReviewTradeEvidenceReader } from './infrastructure/mysql-review-trade-evidence-reader.js'
export { createMysqlHistoryTaskDealInventoryReader } from './infrastructure/mysql-history-task-deal-inventory-reader.js'
import { createReviewTradeReadinessReader } from './application/review-trade-readiness.js'
import { createMysqlReviewTradeEvidenceReader } from './infrastructure/mysql-review-trade-evidence-reader.js'
import { createMysqlHistoryTaskDealInventoryReader } from './infrastructure/mysql-history-task-deal-inventory-reader.js'
export function createTransactionReviewTradeReadinessReader(connection: PoolConnection) {
  return createReviewTradeReadinessReader(createMysqlReviewTradeEvidenceReader(connection), createMysqlHistoryTaskDealInventoryReader(connection))
}
export { createMysqlManualCandidatePageReader } from './infrastructure/mysql-manual-candidate-page-reader.js'

export { createMysqlCompletedHistoryTasks } from './infrastructure/mysql-completed-history-tasks.js'
export { createMysqlSystemTradeAttribution } from './infrastructure/mysql-system-trade-attribution.js'
export { createMysqlSystemReviewPageReader } from './infrastructure/mysql-manual-candidate-page-reader.js'
export { createMysqlPeriodTradeInventory } from './infrastructure/mysql-period-trade-inventory.js'
export { createMysqlHistoryRangeRequester } from './infrastructure/mysql-history-range-requester.js'
export { createMysqlCompletedHistoryRouteReader } from './infrastructure/mysql-completed-history-route-reader.js'
export { createMysqlHistoryTaskDealInventoryPageReader } from './infrastructure/mysql-history-task-deal-inventory-reader.js'

/** Compose exact legacy ownership with this domain's retained outcome/deal facts. */
export function createMysqlArchivedExecutionDeals(pool: Pool, executions: Pick<ArchivedExecutionReader,'get'>) { return new ArchivedExecutionDeals(executions,new MysqlArchivedExecutionDeals(pool)) }

export { accountHistoryMetrics, riskAmount, riskAmountText } from './domain/account-history-metrics.js'
