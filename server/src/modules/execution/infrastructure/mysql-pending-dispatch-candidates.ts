import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { PendingDedupRoute } from '../application/pending-dedup-guard.js'
import { ExecutionError, sha256Canonical } from '../domain/execution.js'
import type { PendingDedupOrder } from '../domain/pending-order-dedup.js'

interface CandidateRow extends RowDataPacket {
  command_id: string; intent_id: string; user_id: number; account_id: string; status: string
  source_type: string; source_id: string; trade_decision_id: string | null; risk_decision_id: string | null
  action_json: string | Record<string, unknown>; action_sha256: string; result_sha256: string | null
}
export interface PendingDispatchCandidate {
  commandId: string; intentId: string
  status: 'dispatched' | 'accepted' | 'uncertain' | 'reconciling' | 'succeeded'
  sourceType: string; sourceId: string; tradeDecisionId: string | null; riskDecisionId: string | null
  instrumentId: string; type: PendingDedupOrder['type']; price: string; resultHash: string | null
}
const states = new Set(['dispatched', 'accepted', 'uncertain', 'reconciling', 'succeeded'])
const types = new Set(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])
const invalid = (): never => { throw new ExecutionError('execution_dedup_candidate_invalid', 409) }

/** Account lock must already be held. Candidates still require origin and settlement proof;
 * this query deliberately does not release successful commands or expire unknown results. */
export async function readPendingDispatchCandidates(connection: Pick<PoolConnection, 'execute'>,
  input: { userId: number; accountId: string; route: PendingDedupRoute }): Promise<PendingDispatchCandidate[]> {
  const scope = structuredClone(input)
  const [rows] = await connection.execute<CandidateRow[]>(`SELECT c.id command_id,i.id intent_id,i.user_id,
    CAST(i.trading_account_id AS CHAR) account_id,c.status,i.source_type,i.source_id,i.trade_decision_id,i.risk_decision_id,
    p.action_json,p.action_sha256,c.result_sha256
    FROM bridge_commands_v4 c INNER JOIN execution_intents i ON i.id=c.execution_intent_id
      AND i.user_id=c.user_id AND i.trading_account_id=c.trading_account_id
    LEFT JOIN execution_intent_payloads p ON p.execution_intent_id=i.id
    WHERE c.user_id=? AND c.trading_account_id=? AND c.action='order.place' AND i.action_kind='pending_order'
      AND c.status IN ('dispatched','accepted','uncertain','reconciling','succeeded')
      AND c.terminal_instance_id=? AND c.connection_epoch<=?
      AND BINARY c.broker_server=BINARY ? AND BINARY c.account_login=BINARY ?
    ORDER BY c.id LIMIT 1001 FOR SHARE`, [scope.userId, scope.accountId, scope.route.terminalInstanceId,
    scope.route.connectionEpoch, scope.route.brokerServer, scope.route.login])
  if (rows.length > 1000) throw new ExecutionError('execution_dedup_candidate_capacity_exceeded', 409)
  const seen = new Set<string>()
  return rows.map(row => {
    if (!row.command_id || seen.has(row.command_id) || row.user_id !== scope.userId || row.account_id !== scope.accountId
      || !states.has(row.status)) return invalid()
    seen.add(row.command_id)
    let action: Record<string, unknown>
    try { action = typeof row.action_json === 'string' ? JSON.parse(row.action_json) : row.action_json } catch { return invalid() }
    if (!action || typeof action !== 'object' || Array.isArray(action) || sha256Canonical(action) !== row.action_sha256
      || action.kind !== 'pending_order' || !action.parameters || typeof action.parameters !== 'object' || Array.isArray(action.parameters)) return invalid()
    const params = action.parameters as Record<string, unknown>
    if (typeof params.symbol !== 'string' || !params.symbol || typeof params.type !== 'string' || !types.has(params.type)
      || typeof params.price !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(params.price)
      || !/[1-9]/.test(params.price)) return invalid()
    return { commandId: row.command_id, intentId: row.intent_id, status: row.status as PendingDispatchCandidate['status'],
      sourceType: row.source_type, sourceId: row.source_id, tradeDecisionId: row.trade_decision_id, riskDecisionId: row.risk_decision_id,
      instrumentId: params.symbol, type: params.type as PendingDedupOrder['type'], price: params.price, resultHash: row.result_sha256 }
  })
}
