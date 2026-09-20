import type { StrategyObserverInventory } from '../../trading/index.js'
import { InferenceError } from '../domain/inference.js'

export interface ReferenceCreationDecision {
  decisionId: string
  riskDecisionId: string
  strategyVersionId: string
}

// Consumer-owned structural port prevents an inference -> execution dependency cycle.
export interface ReferencePendingCreationReader {
  read(scope: { userId: number; accountId: string; terminalInstanceId: string; brokerServer: string;
    login: string; connectionEpoch: string; tickets: readonly string[] }): Promise<Array<
      | { ticket: string; status: 'strategy'; userId: number; accountId: string; strategyId: string; decisionOrigin?: ReferenceCreationDecision }
      | { ticket: string; status: 'unresolved' }>>
}

/** Creation evidence remains separate from current lifecycle attribution and model-ready references. */
export async function readReferencePendingCreation(input: StrategyObserverInventory, reader: ReferencePendingCreationReader) {
  return readReferenceOrderCreation(input, input.pendingOrders.items.map(item => item.ticket), reader)
}

/** Shared validation for exact order creation results; caller selects the appropriate order reader. */
export async function readReferenceOrderCreation(input: { route: StrategyObserverInventory['route']; authorization: Pick<StrategyObserverInventory['authorization'], 'operatorUserId'> }, orderTickets: readonly string[], reader: ReferencePendingCreationReader) {
  const inventory = structuredClone(input), tickets = [...orderTickets]
  const fail = (): never => { throw new InferenceError('strategy_reference_pending_creation_invalid', 409) }
  const positiveId = (value: unknown): value is string => typeof value === 'string'
    && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
  if (tickets.length > 1000 || !tickets.every(positiveId) || new Set(tickets).size !== tickets.length) return fail()
  const route = inventory.route
  const result = structuredClone(await reader.read({ userId: inventory.authorization.operatorUserId, accountId: route.accountId,
    terminalInstanceId: route.terminalInstanceId, brokerServer: route.brokerServer, login: route.login,
    connectionEpoch: String(route.connectionEpoch), tickets: [...tickets] }))
  if (!Array.isArray(result) || result.length !== tickets.length) return fail()
  const expected = new Set(tickets), seen = new Set<string>()
  for (const item of result) {
    if (!item || !expected.has(item.ticket) || seen.has(item.ticket)) return fail()
    seen.add(item.ticket)
    if (item.status === 'strategy') {
      if (item.userId !== inventory.authorization.operatorUserId || item.accountId !== route.accountId || !positiveId(item.strategyId)) return fail()
      if (item.decisionOrigin !== undefined) {
        const origin = item.decisionOrigin
        if (!origin || !positiveId(origin.strategyVersionId) || ![origin.decisionId, origin.riskDecisionId].every(id =>
          typeof id === 'string' && /^[A-Za-z0-9_-]{1,191}$/.test(id))) return fail()
      }
    } else if (item.status !== 'unresolved') return fail()
  }
  const byTicket = new Map(result.map(item => [item.ticket, item]))
  return tickets.map(ticket => {
    const item = byTicket.get(ticket)!
    return item.status === 'unresolved' ? { ticket, status: 'unresolved' as const }
      : { ticket, status: 'strategy' as const, userId: item.userId, accountId: item.accountId, strategyId: item.strategyId,
        ...(item.decisionOrigin ? { decisionOrigin: structuredClone(item.decisionOrigin) } : {}) }
  })
}
