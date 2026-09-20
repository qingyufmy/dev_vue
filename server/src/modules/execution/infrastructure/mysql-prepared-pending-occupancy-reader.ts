import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { PreparedPendingOccupancyReader } from '../application/pending-preparation-guard.js'
import type { PendingDedupOrder } from '../domain/pending-order-dedup.js'
import { ExecutionError, sha256Canonical } from '../domain/execution.js'
import { readPendingDispatchOrigin } from './mysql-pending-dispatch-origin.js'

interface Row extends RowDataPacket {
  intent_id: string; user_id: number; account_id: string; source_type: string; source_id: string
  trade_decision_id: string | null; risk_decision_id: string | null
  action_json: string | Record<string, unknown> | null; action_sha256: string | null
}
const invalid = (): never => { throw new ExecutionError('execution_dedup_prepared_invalid', 409) }
const types = new Set(['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'])

/** Caller holds the account lock. A deadline alone does not release an intent's occupancy. */
export function createMysqlPreparedPendingOccupancyReader(connection: Pick<PoolConnection, 'execute'>,
  decisions: TradeDecisionOriginReader): PreparedPendingOccupancyReader {
  return { async read(input) {
    const scope = structuredClone(input)
    const [rows] = await connection.execute<Row[]>(`SELECT i.id intent_id,i.user_id,CAST(i.trading_account_id AS CHAR) account_id,
      i.source_type,i.source_id,i.trade_decision_id,i.risk_decision_id,p.action_json,p.action_sha256
      FROM execution_intents i LEFT JOIN execution_intent_payloads p ON p.execution_intent_id=i.id
      WHERE i.user_id=? AND i.trading_account_id=? AND i.action_kind='pending_order'
        AND (i.status='prepared' OR EXISTS (SELECT 1 FROM bridge_commands_v4 c
          WHERE c.execution_intent_id=i.id AND c.user_id=i.user_id AND c.trading_account_id=i.trading_account_id
            AND c.action='order.place' AND c.status='queued'))
      ORDER BY i.id LIMIT 1001 FOR SHARE`, [scope.userId, scope.accountId])
    if (rows.length > 1000) throw new ExecutionError('execution_dedup_prepared_capacity_exceeded', 409)
    const seen = new Set<string>(), items: Array<{ intentId: string; order: PendingDedupOrder }> = []
    for (const row of rows) {
      if (!row.intent_id || seen.has(row.intent_id) || row.user_id !== scope.userId || row.account_id !== scope.accountId) return invalid()
      seen.add(row.intent_id)
      let action: Record<string, unknown>
      try { action = typeof row.action_json === 'string' ? JSON.parse(row.action_json) : row.action_json! } catch { return invalid() }
      if (!action || typeof action !== 'object' || Array.isArray(action) || sha256Canonical(action) !== row.action_sha256
        || action.kind !== 'pending_order' || !action.parameters || typeof action.parameters !== 'object' || Array.isArray(action.parameters)) return invalid()
      const params = action.parameters as Record<string, unknown>
      if (typeof params.symbol !== 'string' || !params.symbol || typeof params.type !== 'string' || !types.has(params.type)
        || typeof params.price !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(params.price) || !/[1-9]/.test(params.price)) return invalid()
      const origin = await readPendingDispatchOrigin(connection, decisions, { ...scope, candidate: {
        intentId: row.intent_id, sourceType: row.source_type, sourceId: row.source_id,
        tradeDecisionId: row.trade_decision_id, riskDecisionId: row.risk_decision_id,
      } })
      // A manual account command has no strategy lineage; never borrow the requested strategy.
      if (!origin) continue
      items.push({ intentId: row.intent_id, order: { ticket: row.intent_id, instrumentId: params.symbol,
        type: params.type as PendingDedupOrder['type'], price: params.price, verifiedOrigin: origin } })
    }
    return { complete: true, userId: scope.userId, accountId: scope.accountId, items }
  } }
}
