import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute, BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import type { PartialCloseRegistrationTargetReader } from '../modules/execution/index.js'
import type { ExecutionPositionReader } from '../modules/trading/index.js'
import { createMysqlPartialCloseWorkflowWriter, type CapturePartialCloseRegistration } from '../modules/execution/composition.js'
import { createMysqlExecutionPositionReader, createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'

/** route must be captured before the short transaction; its credentials/session are rechecked inside it. */
export function createPartialCloseRegistrationTargetReader(positions: ExecutionPositionReader,
  sourceRoute: BridgeGatewayRoute, maxAgeMs: number): PartialCloseRegistrationTargetReader {
  const route = structuredClone(sourceRoute)
  return { async read(input) {
    const scope = structuredClone(input), target = scope.target
    if (String(route.userId) !== target.userId || route.accountId !== target.accountId
      || route.terminalInstanceId !== target.terminalInstanceId || route.brokerServer !== target.brokerServer
      || route.login !== target.login || route.connectionEpoch !== scope.connectionEpoch) return null
    const position = await positions.read({ route:structuredClone(route),ticket:target.ticket,positionIdentifier:target.positionIdentifier,
      symbol:target.symbol,side:target.side,revision:scope.revision,maxAgeMs })
    if (!position || position.accountId !== target.accountId || position.ticket !== target.ticket
      || position.positionIdentifier !== target.positionIdentifier || position.symbol !== target.symbol
      || position.side !== target.side || position.revision !== scope.revision) return null
    return { target:{...target},revision:position.revision,volume:position.volume }
  } }
}

/** No nested transaction or route lookup. The future command creator must call this before publishing its outbox. */
export function createPartialCloseWorkflowRegistration(connection: PoolConnection, route: BridgeGatewayRoute, maxAgeMs: number) {
  return createMysqlPartialCloseWorkflowWriter(connection,createPartialCloseRegistrationTargetReader(
    createMysqlExecutionPositionReader(connection,createTransactionTerminalFactRouteGuard(connection)),route,maxAgeMs))
}

/** Capture Redis facts before repository.beginTransaction; the returned callback only uses its SQL connection. */
export function createPartialCloseRegistrationCapture(routes: Pick<BridgeGatewayLeaseStore, 'current'>, maxAgeMs: number): CapturePartialCloseRegistration {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60_000) throw new Error('partial_close_projection_age_invalid')
  return async source => {
    const command = structuredClone(source)
    const current = await routes.current(command.accountId)
    const route = current ? structuredClone(current) : null
    return async (connection, plan) => {
      if (!route || route.platform !== 'mt5' || route.userId !== command.userId || route.accountId !== command.accountId
        || route.terminalProfileId !== command.terminalProfileId || route.terminalInstanceId !== command.route.terminalInstanceId
        || route.brokerServer !== command.route.brokerServer || route.login !== command.route.login
        || route.connectionEpoch !== command.route.connectionEpoch) throw new Error('partial_close_registration_route_unavailable')
      await createPartialCloseWorkflowRegistration(connection, route, maxAgeMs).register(plan)
    }
  }
}
