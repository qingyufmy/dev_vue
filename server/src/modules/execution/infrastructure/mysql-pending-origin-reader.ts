import type { OrderCreationDecisionOrigin } from '../application/pending-order-origin-reader.js'
import { openingOrderTicket } from '../domain/opening-order-ticket.js'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { PendingDedupOrder } from '../domain/pending-order-dedup.js'
import { executionOutcomeReference } from '../domain/execution-outcome-reference.js'
import { ExecutionError } from '../domain/execution.js'

type CreationOrigin = NonNullable<PendingDedupOrder['verifiedOrigin']> & { decisionOrigin?: OrderCreationDecisionOrigin }

interface OriginRow extends RowDataPacket {
  action_kind: string
  user_id: number; account_id: string; source_type: string; source_id: string
  risk_decision_id: string | null; trade_decision_id: string | null
  result_json: string | Record<string, unknown> | null
  distribution_strategy_id: string | null
}

/** Historical command epochs may precede the current connection; strategy provenance survives reconnects. */
export async function readPendingOrigins(connection: Pick<PoolConnection, 'execute'>, decisions: TradeDecisionOriginReader,
  input: { userId: number; accountId: string; terminalInstanceId: string; brokerServer: string; login: string; connectionEpoch: string; tickets: readonly string[] },
  mode: 'locked' | 'snapshot' = 'locked',
  includeMarketOrders = false,
): Promise<Map<string, CreationOrigin>> {
  const scope = { ...input, tickets: [...input.tickets] }
  const tickets = [...new Set(scope.tickets)]
  if (tickets.some(ticket => typeof ticket !== 'string' || !/^[1-9]\d{0,19}$/.test(ticket))) {
    throw new ExecutionError('execution_dedup_ticket_invalid', 409)
  }
  if (tickets.length > 1000) throw new ExecutionError('execution_dedup_origin_capacity_exceeded', 409)
  if (tickets.length === 0) return new Map()
  const requested = new Set(tickets)
  const placeholders = tickets.map(() => '?').join(',')
  // Exact raw aliases retain compatibility with old outcomes whose indexed ticket was a position ID.
  const aliases = ['pending_ticket', 'order_ticket', 'order', 'ticket'] as const
  const ticketFilter = aliases.map(key => `JSON_UNQUOTE(JSON_EXTRACT(o.result_json,'$.${key}')) IN (${placeholders})`).join(' OR ')
  const [rows] = await connection.execute<OriginRow[]>(`SELECT i.action_kind,i.user_id,CAST(i.trading_account_id AS CHAR) account_id,
    i.source_type,i.source_id,i.risk_decision_id,i.trade_decision_id,o.result_json,
    CAST(d.strategy_id AS CHAR) distribution_strategy_id
    FROM execution_intents i
    INNER JOIN execution_outcomes o ON o.execution_intent_id=i.id AND o.trading_account_id=i.trading_account_id
    INNER JOIN bridge_commands_v4 c ON c.execution_intent_id=i.id AND c.user_id=i.user_id
      AND c.trading_account_id=i.trading_account_id AND c.result_sha256=o.result_sha256
    LEFT JOIN execution_distribution_targets t ON i.source_type='strategy_distribution' AND t.id=i.source_id
      AND t.id=o.distribution_target_id AND t.target_user_id=i.user_id AND t.trading_account_id=i.trading_account_id
      AND t.child_operation_id=i.operation_id
    LEFT JOIN execution_distributions d ON d.id=t.distribution_id AND d.kind='manual_order'
    WHERE i.user_id=? AND i.trading_account_id=? AND ${includeMarketOrders ? "i.action_kind IN ('market_order','pending_order')" : "i.action_kind='pending_order'"}
      AND i.status='succeeded' AND o.status='succeeded' AND c.status='succeeded' AND c.action='order.place'
      AND c.terminal_instance_id=? AND c.connection_epoch<=? AND BINARY c.broker_server=BINARY ? AND BINARY c.account_login=BINARY ?
      AND (${ticketFilter})
    ORDER BY i.id LIMIT 1001${mode === 'locked' ? ' FOR SHARE' : ''}`, [scope.userId, scope.accountId, scope.terminalInstanceId, scope.connectionEpoch,
    scope.brokerServer, scope.login, ...aliases.flatMap(() => tickets)])
  // Bound matching evidence, not total account history. Never truncate ambiguous evidence into an absence.
  if (rows.length > 1000) throw new ExecutionError('execution_dedup_origin_capacity_exceeded', 409)
  const origins = new Map<string, CreationOrigin>()
  const otherSources = new Set<string>()
  const decisionCache = new Map<string, Awaited<ReturnType<TradeDecisionOriginReader['read']>>>()
  for (const row of rows) {
    if (Number(row.user_id) !== scope.userId || row.account_id !== scope.accountId) throw new ExecutionError('execution_dedup_origin_invalid', 409)
    let result: Record<string, unknown> | null
    try { result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json }
    catch { throw new ExecutionError('execution_dedup_origin_invalid', 409) }
    if (result !== null && (typeof result !== 'object' || Array.isArray(result))) throw new ExecutionError('execution_dedup_origin_invalid', 409)
    // Recompute old outcome classifications: stored ticket/resource_kind may have used a position ID.
    const ticket = includeMarketOrders ? openingOrderTicket(row.action_kind, result)
      : executionOutcomeReference('pending_order', 'succeeded', result).ticket
    if (ticket === null || !requested.has(ticket)) continue
    let strategyId: string | null = null
    let decisionOrigin: OrderCreationDecisionOrigin | undefined
    if (row.source_type === 'risk_decision') {
      if (!row.trade_decision_id || !row.risk_decision_id || row.source_id !== row.risk_decision_id) throw new ExecutionError('execution_dedup_origin_invalid', 409)
      const key = JSON.stringify([row.trade_decision_id, row.risk_decision_id])
      if (!decisionCache.has(key)) decisionCache.set(key, await decisions.read({ decisionId: row.trade_decision_id,
        riskDecisionId: row.risk_decision_id, userId: scope.userId, accountId: scope.accountId }))
      const origin = decisionCache.get(key)
      if (!origin || origin.userId !== scope.userId || origin.accountId !== scope.accountId || origin.decisionId !== row.trade_decision_id) {
        throw new ExecutionError('execution_dedup_origin_invalid', 409)
      }
      strategyId = origin.strategyId
      if (includeMarketOrders) {
        if (typeof origin.strategyVersionId !== 'string' || !/^[1-9]\d{0,19}$/.test(origin.strategyVersionId)
          || BigInt(origin.strategyVersionId) > 18446744073709551615n) throw new ExecutionError('execution_dedup_origin_invalid', 409)
        decisionOrigin = { decisionId: origin.decisionId, riskDecisionId: row.risk_decision_id, strategyVersionId: origin.strategyVersionId }
      }
    } else if (row.source_type === 'strategy_distribution') {
      strategyId = row.distribution_strategy_id
      if (!strategyId) throw new ExecutionError('execution_dedup_origin_invalid', 409)
    } else {
      if (origins.has(ticket)) throw new ExecutionError('execution_dedup_origin_ambiguous', 409)
      otherSources.add(ticket)
      continue
    }
    if (!/^[1-9]\d{0,19}$/.test(strategyId)) throw new ExecutionError('execution_dedup_origin_invalid', 409)
    const prior = origins.get(ticket)
    if (otherSources.has(ticket) || (prior && prior.strategyId !== strategyId)) throw new ExecutionError('execution_dedup_origin_ambiguous', 409)
    // Matching strategy IDs do not make two different creation decisions interchangeable.
    if (includeMarketOrders && prior && JSON.stringify(prior.decisionOrigin) !== JSON.stringify(decisionOrigin)) {
      throw new ExecutionError('opening_order_decision_origin_ambiguous', 409)
    }
    origins.set(ticket, { userId: scope.userId, accountId: scope.accountId, strategyId,
      ...(decisionOrigin ? { decisionOrigin } : {}) })
  }
  return origins
}
