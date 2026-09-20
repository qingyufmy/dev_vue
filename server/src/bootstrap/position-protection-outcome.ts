import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import type { CapturePositionProtectionOutcomeProjection } from '../modules/execution/composition.js'
import { createMysqlExecutionPositionCollectionReader, createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'

/** Freeze Redis identity before BEGIN. SQL validates ownership, session and the complete current collection. */
export function createPositionProtectionOutcomeProjectionCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>,
  maxAgeMs: number): CapturePositionProtectionOutcomeProjection {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) throw new Error('position_protection_projection_age_invalid')
  return async input => {
    const scope = structuredClone(input)
    let current: Awaited<ReturnType<BridgeGatewayLeaseStore['current']>>
    try { current = await routes.current(scope.accountId) }
    catch (error) { return async () => { throw error } }
    const route = current ? structuredClone(current) : null
    return async (db, child, command) => {
      const target = child.request.target
      if (!route || route.platform !== 'mt5' || route.userId !== scope.userId || route.accountId !== scope.accountId
        || child.request.workflowId !== scope.workflowId || child.request.userId !== scope.userId || child.request.accountId !== scope.accountId
        || route.terminalInstanceId !== target.terminalInstanceId || route.brokerServer !== target.brokerServer || route.login !== target.login
        || !Number.isSafeInteger(route.connectionEpoch) || route.connectionEpoch < command.route.connectionEpoch) return null
      const collection = await createMysqlExecutionPositionCollectionReader(db, createTransactionTerminalFactRouteGuard(db))
        .read({ route: structuredClone(route), maxAgeMs })
      if (!collection || collection.accountId !== scope.accountId) return null
      const matches = collection.positions.filter(p => p.ticket === target.ticket || p.positionIdentifier === target.positionIdentifier)
      if (matches.some(p => p.positionIdentifier === null)) return null
      const identity = { userId: String(scope.userId), accountId: scope.accountId, terminalInstanceId: route.terminalInstanceId,
        brokerServer: route.brokerServer, login: route.login }
      return { route: identity, complete: true, revision: collection.revision, observedAt: Date.parse(collection.observedAt),
        positions: matches.map(p => ({ target: { ...identity, ticket: p.ticket, positionIdentifier: p.positionIdentifier!, symbol: p.symbol, side: p.side },
          volume: p.volume, ...(p.stopLoss === undefined ? {} : { stopLoss: p.stopLoss }), ...(p.takeProfit === undefined ? {} : { takeProfit: p.takeProfit }) })) }
    }
  }
}
