export { createAccountRiskSummaryReader } from './infrastructure/mysql-account-risk-summary-reader.js'
export { createMysqlAccountRiskProjector } from './infrastructure/mysql-account-risk-projector.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import type { InstrumentSnapshotReader } from '../trading/index.js'
import type { TradeDecisionRiskWriter, ProposedDecisionEvidenceReader } from '../inference/index.js'
import type { FastifyPluginAsync } from 'fastify'
import { RiskService } from './application/risk-service.js'
import { RiskReviewWorker } from './application/risk-review-worker.js'
import { MysqlRiskRepository, effectivePolicyOnConnection, type StrategyBudgetReaderFactories } from './infrastructure/mysql-risk-repository.js'
import { riskRoutes, type RiskRoutesOptions } from './transport/http/risk-routes.js'

export function createRiskService(pool: Pool, writer: (connection: PoolConnection) => TradeDecisionRiskWriter, instruments: InstrumentSnapshotReader) {
  return new RiskService(new MysqlRiskRepository(pool, writer, instruments))
}
export function createRiskReviewWorker(pool: Pool, writer: (connection: PoolConnection) => TradeDecisionRiskWriter, instruments: InstrumentSnapshotReader, sizingEvidence?: ProposedDecisionEvidenceReader, strategyBudget?: StrategyBudgetReaderFactories, instrumentRequests?: import('../trading/index.js').InstrumentCollectionRequester) {
  return new RiskReviewWorker(new MysqlRiskRepository(pool, writer, instruments, sizingEvidence, strategyBudget, instrumentRequests))
}
export function createRiskHttp(service: RiskService, auth: RiskRoutesOptions['auth']): FastifyPluginAsync {
  return async app => { await app.register(riskRoutes, { prefix: '/api/v4', service, auth }) }
}

export function createTransactionRiskPolicyReader(connection: PoolConnection): import('./application/risk-ports.js').RiskDispatchPolicyReader {
  return { getEffectivePolicy: (userId, accountId) => effectivePolicyOnConnection(connection, userId, accountId) }
}

export { createMysqlRiskDecisionExecutionWriter as createTransactionRiskDecisionExecutionWriter } from './infrastructure/mysql-risk-decision-execution-writer.js'

export { createMysqlPositionProtectionSummaryReader } from './infrastructure/mysql-position-protection-summary-reader.js'
export { createMysqlReviewRiskContext } from './infrastructure/mysql-review-risk-context.js'
export { createMysqlPositionProtectionClock } from './infrastructure/mysql-position-protection-clock.js'
