import type { PoolConnection } from 'mysql2/promise'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createMysqlOwnedHistoryAccess } from '../modules/trading/composition.js'
import { createMysqlSystemTradeAttribution } from '../modules/trade-history/composition.js'
import { createTransactionSystemTradeSource } from './system-trade-source.js'

/** The worker's transaction owns all locks, lineage reads and attribution writes. */
export function createTransactionSystemTradeAttribution(connection: PoolConnection) {
  const source = createTransactionSystemTradeSource(connection)
  const ownership = createMysqlOwnedHistoryAccess(connection, createActivePrincipalAccess(connection))
  return createMysqlSystemTradeAttribution(connection, {
    source: (route, facts) => source.read(route, facts),
    async authorize(e) {
      const owned = await ownership.read({ userId: e.userId, accountId: e.accountId, platform: e.platform,
        ownershipIntervalId: e.ownershipIntervalId, openedAt: e.openedAt, closedAt: e.closedAt })
      return !!owned && owned.userId === e.userId && owned.accountId === e.accountId && owned.platform === e.platform
        && owned.historicalOwnershipIntervalId === e.ownershipIntervalId
    },
  })
}
