import type { BridgeGatewayLeaseStore, BridgeGatewayRoute } from '../modules/bridge/index.js'
import type { PartialCloseProgressFacts } from '../modules/execution/index.js'
import type { CapturePartialCloseProgressFacts } from '../modules/execution/composition.js'
import type { ExecutionPositionCollectionReader } from '../modules/trading/index.js'
import { createMysqlExecutionPositionCollectionReader, createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'
import { createTransactionPartialCloseHistoryProofReader } from './partial-close-history-proof.js'

/** A complete target projection is derived only after validating the entire account collection. */
export function createPartialCloseProjectionReader(collections: ExecutionPositionCollectionReader, sourceRoute: BridgeGatewayRoute,
  maxAgeMs: number): PartialCloseProgressFacts['projection'] {
  const route = structuredClone(sourceRoute)
  return { async read(source) {
    const plan = structuredClone(source), target = plan.target
    if (route.platform !== 'mt5' || String(route.userId) !== target.userId || route.accountId !== target.accountId
      || route.terminalInstanceId !== target.terminalInstanceId || route.brokerServer !== target.brokerServer || route.login !== target.login) return null
    const snapshot = await collections.read({ route: structuredClone(route), maxAgeMs })
    if (!snapshot || snapshot.accountId !== target.accountId) return null
    const matches = snapshot.positions.filter(position => position.ticket === target.ticket || position.positionIdentifier === target.positionIdentifier)
    // A present position without its stable identity is not proof of absence or identity reuse.
    if (matches.some(position => position.positionIdentifier === null)) return null
    return { route: { userId: String(route.userId), accountId: route.accountId, terminalInstanceId: route.terminalInstanceId,
      brokerServer: route.brokerServer, login: route.login }, complete: true as const, revision: snapshot.revision, observedAt: Date.parse(snapshot.observedAt),
    positions: matches.map(position => ({ target: { ...target, ticket: position.ticket, positionIdentifier: position.positionIdentifier!,
      symbol: position.symbol, side: position.side }, volume: position.volume })) }
  } }
}

/** Redis is read once before SQL begins; both history and current positions retain the caller's transaction locks. */
export function createPartialCloseProgressCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>, maxAgeMs: number): CapturePartialCloseProgressFacts {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) throw new Error('partial_close_projection_age_invalid')
  return async source => {
    const scope = structuredClone(source)
    let current: Awaited<ReturnType<BridgeGatewayLeaseStore['current']>>
    try { current = await routes.current(scope.accountId) }
    catch (error) {
      return () => ({ history: { async read() { throw error } }, projection: { async read() { throw error } } })
    }
    const route = current ? structuredClone(current) : null
    return connection => {
      if (!route || route.platform !== 'mt5' || route.userId !== scope.userId || route.accountId !== scope.accountId) {
        return { history: { async read() { return null } }, projection: { async read() { return null } } }
      }
      return { history: createTransactionPartialCloseHistoryProofReader(connection, route),
        projection: createPartialCloseProjectionReader(createMysqlExecutionPositionCollectionReader(connection,
          createTransactionTerminalFactRouteGuard(connection)), route, maxAgeMs) }
    }
  }
}
