import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { readAccountPositionEntries, unavailableAccountPositionEntries, type AccountPositionEntryReader } from '../modules/inference/index.js'
import { createMysqlTradeDecisionEntryAnalysisReader, createMysqlSnapshotTradeDecisionOriginReader } from '../modules/inference/composition.js'
import { createMysqlSnapshotOpeningOrderOriginReader } from '../modules/execution/composition.js'
import { createMysqlOpenPositionHistoryReader } from '../modules/trade-history/composition.js'
import { createMysqlExecutionPositionCollectionReader, createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'
import { sha256Canonical } from '../shared/canonical-json.js'

/** Local SQL reads only; never selects an observer account or requests terminal history. */
export function createAccountPositionEntryReader(pool: Pool, routes: Pick<BridgeGatewayLeaseStore, 'current'>): AccountPositionEntryReader {
  return { async read(input) {
    const scope = structuredClone(input)
    if (scope.positions.length === 0) return unavailableAccountPositionEntries(scope)
    const current = await routes.current(scope.accountId)
    if (!current || current.accountId !== scope.accountId || current.userId !== scope.userId || current.platform !== 'mt5') {
      return unavailableAccountPositionEntries(scope)
    }
    const route = structuredClone(current), connection = await pool.getConnection()
    let reusable = true
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      // The existing owner/credential guards retain shared locks. No DML is performed.
      await connection.beginTransaction()
      const collection = await createMysqlExecutionPositionCollectionReader(connection, createTransactionTerminalFactRouteGuard(connection))
        .read({ route, revision: scope.positionsRevision, maxAgeMs: 30_000 })
      const history = createMysqlOpenPositionHistoryReader(connection)
      const result = await readAccountPositionEntries(scope, route, collection, {
        history: { read: position => history.read({ ...position, route }) },
        origins: createMysqlSnapshotOpeningOrderOriginReader(connection, createMysqlSnapshotTradeDecisionOriginReader(connection)),
        analyses: createMysqlTradeDecisionEntryAnalysisReader(connection),
      })
      const latest = await routes.current(scope.accountId)
      return latest && sha256Canonical(latest) === sha256Canonical(route) ? result : unavailableAccountPositionEntries(scope)
    } catch (error) {
      // Discard a failed START too: next-transaction settings may still be pending.
      reusable = false
      throw error
    } finally {
      try { await connection.rollback() } catch (error) { reusable = false; throw error }
      finally { if (reusable) connection.release(); else connection.destroy() }
    }
  } }
}
