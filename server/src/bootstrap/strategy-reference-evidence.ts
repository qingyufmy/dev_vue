import { ReadStrategyReferencePortfolio } from '../modules/inference/index.js'
import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { createReferencePositionEvidenceReader } from './strategy-reference-position-evidence.js'
import type { Pool } from 'mysql2/promise'
import { createMysqlOpenPositionLifecycleReader, createMysqlOpenPositionHistoryReader } from '../modules/trade-history/composition.js'
import type { AccountLiveRouteReader } from '../modules/trading/index.js'
import { createAccountPrincipalReader } from '../modules/auth/composition.js'
import { createTransactionStrategyObserverInventoryReader } from '../modules/trading/composition.js'
import { createMysqlSnapshotPendingOrderOriginReader, createMysqlSnapshotOpeningOrderOriginReader } from '../modules/execution/composition.js'
import { createMysqlTradeDecisionEntryAnalysisReader, createMysqlStrategyReferenceSourceReader, createMysqlSnapshotTradeDecisionOriginReader } from '../modules/inference/composition.js'

/** Internal evidence assembly, not a model-ready portfolio or permission to execute. */
export function createStrategyReferenceEvidenceReader(pool: Pool, routes: AccountLiveRouteReader, historyRoutes?: Pick<BridgeGatewayLeaseStore, 'current'>) {
  return createMysqlStrategyReferenceSourceReader(pool,
    connection => createTransactionStrategyObserverInventoryReader(connection, createAccountPrincipalReader, routes),
    undefined,
    connection => createMysqlSnapshotPendingOrderOriginReader(connection, createMysqlSnapshotTradeDecisionOriginReader(connection)),
    createMysqlOpenPositionLifecycleReader,
    connection => createMysqlSnapshotOpeningOrderOriginReader(connection, createMysqlSnapshotTradeDecisionOriginReader(connection)),
    historyRoutes ? connection => createReferencePositionEvidenceReader(historyRoutes, createMysqlOpenPositionHistoryReader(connection)) : undefined,
    createMysqlTradeDecisionEntryAnalysisReader)
}

/** Ready references remain separate from executable account inventory. */
export function createStrategyReferencePortfolioReader(pool: Pool, routes: Pick<BridgeGatewayLeaseStore, 'current'>) {
  return new ReadStrategyReferencePortfolio(createStrategyReferenceEvidenceReader(pool,routes,routes))
}
