import type { PoolConnection } from 'mysql2/promise'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createTransactionReviewTradeReadinessReader } from '../modules/trade-history/composition.js'
import { createMysqlOwnedHistoryAccess } from '../modules/trading/composition.js'
import { createMysqlManualCandidateWriter } from '../modules/reviews/composition.js'
import { ManualCandidateCollector } from '../modules/reviews/index.js'
import { createManualCandidateAuthority } from './manual-candidate-authority.js'

/** Caller owns the transaction and lock order; single-trade scope is determined entirely in UTC. */
export function createTransactionManualCandidateCollector(connection: PoolConnection) {
  return new ManualCandidateCollector(createTransactionReviewTradeReadinessReader(connection),
    createManualCandidateAuthority(createMysqlOwnedHistoryAccess(connection, createActivePrincipalAccess(connection))),
    createMysqlManualCandidateWriter(connection))
}
