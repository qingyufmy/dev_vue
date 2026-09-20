import type { PoolConnection } from 'mysql2/promise'
import type { AccountLiveRouteReader } from '../modules/trading/index.js'
import { createTransactionPendingReader, createMysqlInstrumentSnapshotReader } from '../modules/trading/composition.js'
import { createTransactionTradeDecisionOriginReader, createTransactionTradeDecisionAnalysisReader } from '../modules/inference/composition.js'
import { createMysqlPendingPreparationReviewer } from '../modules/execution/composition.js'
export function createPendingPreparationRuntime(routes: AccountLiveRouteReader) {
  return (connection: PoolConnection) => createMysqlPendingPreparationReviewer(connection, { routes,
    pending: createTransactionPendingReader(connection), instruments: createMysqlInstrumentSnapshotReader(connection),
    decisions: createTransactionTradeDecisionOriginReader(connection), analyses: createTransactionTradeDecisionAnalysisReader(connection) })
}
