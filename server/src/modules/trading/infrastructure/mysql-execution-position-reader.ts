import type { PoolConnection } from 'mysql2/promise'
import type { ExecutionPositionReader } from '../application/execution-position-reader.js'
import type { TerminalFactRouteGuard } from '../application/terminal-fact-route-guard.js'
import { createMysqlExecutionPositionCollectionReader } from './mysql-execution-position-collection-reader.js'

const positiveId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n

export function createMysqlExecutionPositionReader(connection: PoolConnection, routeGuard: TerminalFactRouteGuard): ExecutionPositionReader {
  const collection = createMysqlExecutionPositionCollectionReader(connection, routeGuard)
  return { async read(input) {
    const scope = structuredClone(input)
    if (!positiveId(scope.ticket) || !positiveId(scope.positionIdentifier) || !Number.isSafeInteger(scope.revision) || scope.revision < 1
      || !/^[A-Za-z0-9._-]{1,64}$/.test(scope.symbol) || !['buy', 'sell'].includes(scope.side)) return null
    const snapshot = await collection.read({ route: scope.route, maxAgeMs: scope.maxAgeMs, revision: scope.revision })
    if (!snapshot) return null
    const matches = snapshot.positions.filter(position => position.ticket === scope.ticket || position.positionIdentifier === scope.positionIdentifier)
    const target = matches[0]
    if (matches.length !== 1 || !target || target.ticket !== scope.ticket || target.positionIdentifier !== scope.positionIdentifier
      || target.symbol !== scope.symbol || target.side !== scope.side) return null
    return { ...target, positionIdentifier: scope.positionIdentifier, revision: snapshot.revision, observedAt: snapshot.observedAt }
  } }
}
