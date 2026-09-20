import type { PoolConnection } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { ExecutionPendingReader } from '../../trading/index.js'
import type { PendingDedupSnapshotReader } from '../application/pending-dedup-guard.js'
import { createMysqlPendingOrderOriginReader } from './mysql-pending-order-origin-reader.js'

export function createMysqlPendingDedupSnapshotReader(connection: Pick<PoolConnection, 'execute'>,
  pending: ExecutionPendingReader, decisions: TradeDecisionOriginReader): PendingDedupSnapshotReader {
  const originReader = createMysqlPendingOrderOriginReader(connection, decisions)
  return {
    async read(input) {
      const scope = structuredClone(input)
      const snapshot = await pending.read({ userId: scope.userId, accountId: scope.accountId, ...scope.route })
      if (!snapshot) return null
      const records = await originReader.read({
        userId: snapshot.userId, accountId: snapshot.accountId,
        terminalInstanceId: snapshot.terminalInstanceId, connectionEpoch: snapshot.connectionEpoch,
        brokerServer: snapshot.brokerServer, login: snapshot.login,
        tickets: snapshot.items.map(item => item.ticket),
      })
      const origins = new Map(records.flatMap(record => record.status === 'strategy'
        ? [[record.ticket, { userId: record.userId, accountId: record.accountId, strategyId: record.strategyId }] as const] : []))
      return { userId: snapshot.userId, accountId: snapshot.accountId, complete: snapshot.complete,
        route: { terminalInstanceId: snapshot.terminalInstanceId, connectionEpoch: snapshot.connectionEpoch,
          brokerServer: snapshot.brokerServer, login: snapshot.login,
          ownershipRevision: snapshot.ownershipRevision }, observedAt: snapshot.observedAt, revision: snapshot.revision,
        orders: snapshot.items.map(item => ({ ticket: item.ticket, instrumentId: item.symbol, type: item.type,
          price: item.price, verifiedOrigin: origins.get(item.ticket) ?? null })) }
    },
  }
}
