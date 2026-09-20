import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../modules/bridge/index.js'
import { resolveSystemTradeSource, type TerminalDealFact } from '../modules/trade-history/index.js'
import { createMysqlExecutedDealOriginReader } from '../modules/execution/composition.js'
import { createTransactionTradeDecisionOriginReader } from '../modules/inference/composition.js'

/** Short transaction/snapshot only. The caller separately proves current and historical ownership. */
export function createTransactionSystemTradeSource(connection: PoolConnection) {
  const executions = createMysqlExecutedDealOriginReader(connection, createTransactionTradeDecisionOriginReader(connection))
  return { async read(route: BridgeGatewayRoute, facts: TerminalDealFact[]) {
    if (route.platform !== 'mt5' || facts.some(f => !f.orderTicket || !f.positionId)) {
      return { status: 'unresolved' as const, reason: 'system_trade_identity_incomplete' }
    }
    const proofs = await executions.read({ userId: route.userId, accountId: route.accountId, terminalInstanceId: route.terminalInstanceId,
      brokerServer: route.brokerServer, login: route.login, connectionEpoch: route.connectionEpoch,
      deals: facts.map(f => ({ ticket: f.ticket, orderTicket: f.orderTicket!, positionId: f.positionId!, occurredAtUtcMsc: f.occurredAtUtcMsc })) })
    return resolveSystemTradeSource(facts, proofs)
  } }
}
