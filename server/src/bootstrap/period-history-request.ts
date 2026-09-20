import type { PoolConnection } from 'mysql2/promise'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createAccountInventorySummaryReader, createMysqlOwnedHistoryAccess } from '../modules/trading/composition.js'
import { createMysqlHistoryRangeRequester } from '../modules/trade-history/composition.js'

/** A period task supplies its frozen full window, including any required pre-period lifecycle. */
export function createTransactionPeriodHistoryRequester(connection: PoolConnection) {
  const owned = createMysqlOwnedHistoryAccess(connection,createActivePrincipalAccess(connection))
  return createMysqlHistoryRangeRequester(connection,createAccountInventorySummaryReader(connection), async scope => {
    const result = await owned.read({ userId: scope.userId, accountId: scope.accountId, platform: scope.platform,
      ownershipIntervalId: scope.ownershipIntervalId, openedAt: new Date(scope.rangeStartUtcMsc).toISOString(),
      closedAt: new Date(scope.rangeEndUtcMsc).toISOString() })
    return result ? { ownershipRevision: result.currentOwnershipRevision } : null
  })
}
