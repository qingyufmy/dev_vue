import type { OpeningOrderOriginReader } from '../application/opening-order-origin-reader.js'
import type { PoolConnection } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { PendingOrderOriginReader } from '../application/pending-order-origin-reader.js'
import { ExecutionError } from '../domain/execution.js'
import { readPendingOrigins } from './mysql-pending-origin-reader.js'

const positiveId = (value: unknown) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)

export function createMysqlPendingOrderOriginReader(connection: Pick<PoolConnection, 'execute'>, decisions: TradeDecisionOriginReader): PendingOrderOriginReader {
  return originReader(connection, decisions, 'locked')
}

/** Both this connection and the injected decisions reader must use the caller's consistent snapshot. */
export function createMysqlSnapshotPendingOrderOriginReader(connection: Pick<PoolConnection, 'execute'>, decisions: TradeDecisionOriginReader): PendingOrderOriginReader {
  return originReader(connection, decisions, 'snapshot')
}

export function createMysqlSnapshotOpeningOrderOriginReader(connection: Pick<PoolConnection, 'execute'>, decisions: TradeDecisionOriginReader): OpeningOrderOriginReader {
  return originReader(connection, decisions, 'snapshot', true)
}

function originReader(connection: Pick<PoolConnection, 'execute'>, decisions: TradeDecisionOriginReader, mode: 'locked' | 'snapshot', includeMarketOrders = false): PendingOrderOriginReader {
  return { async read(value) {
    const scope = structuredClone(value)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
      || !positiveId(scope.accountId) || !positiveId(scope.connectionEpoch)
      || BigInt(scope.connectionEpoch) > 9007199254740991n
      || !text(scope.terminalInstanceId, 128) || !text(scope.brokerServer, 128) || !text(scope.login, 64)
      || !Array.isArray(scope.tickets) || scope.tickets.length > 1000 || !scope.tickets.every(positiveId)) {
      throw new ExecutionError(includeMarketOrders ? 'opening_order_origin_scope_invalid' : 'pending_order_origin_scope_invalid', 409)
    }
    const tickets = [...new Set(scope.tickets)]
    const origins = await readPendingOrigins(connection, decisions, { ...scope, tickets }, mode, includeMarketOrders)
    return tickets.map(ticket => {
      const origin = origins.get(ticket)
      if (!origin) return { ticket, status: 'unresolved' as const }
      if (origin.userId !== scope.userId || origin.accountId !== scope.accountId || !positiveId(origin.strategyId)) {
        throw new ExecutionError('pending_order_origin_evidence_invalid', 409)
      }
      return { ticket, status: 'strategy' as const, userId: origin.userId, accountId: origin.accountId, strategyId: origin.strategyId,
        ...(includeMarketOrders && origin.decisionOrigin ? { decisionOrigin: structuredClone(origin.decisionOrigin) } : {}) }
    })
  } }
}
