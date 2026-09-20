import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { BridgeGatewayRoute, BridgeQueryResponseEnvelope } from '../../bridge/index.js'
import type { TerminalOrderFact } from '../domain/terminal-history-projection.js'
import { historyOrderProvenance } from '../application/history-order-provenance.js'

/** Caller owns the route-authorized account/sync/fact transaction. No commit or catch-and-ignore here. */
export async function persistHistoryOrderProvenance(connection: Pick<PoolConnection, 'execute'>,
  input: { route: BridgeGatewayRoute; response: BridgeQueryResponseEnvelope; fact: TerminalOrderFact; receivedAt: Date }) {
  const frozen = structuredClone(input)
  const [orders] = await connection.execute<(RowDataPacket & { id: string; evidence_sha256: string })[]>(
    `SELECT id,evidence_sha256 FROM terminal_history_orders_v4
     WHERE trading_account_id=? AND platform=? AND order_ticket=? LIMIT 2 FOR UPDATE`,
    [frozen.route.accountId, frozen.route.platform, frozen.fact.ticket])
  if (orders.length !== 1 || orders[0]!.evidence_sha256 !== frozen.fact.evidenceHash) throw new Error('trade_history_provenance_fact_mismatch')
  const value = historyOrderProvenance({ ...frozen, orderId: orders[0]!.id })
  const [existing] = await connection.execute<(RowDataPacket & { id: string; provenance_sha256: string })[]>(
    `SELECT id,provenance_sha256 FROM terminal_history_order_provenance_v4
     WHERE terminal_history_order_id=? AND response_message_id=? LIMIT 2 FOR UPDATE`, [value.orderId, value.responseMessageId])
  if (existing.length > 1 || (existing.length === 1 && existing[0]!.provenance_sha256 !== value.provenanceHash)) {
    throw new Error('trade_history_provenance_conflict')
  }
  if (existing.length === 1) return { id: existing[0]!.id, created: false }
  const id = randomUUID()
  const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO terminal_history_order_provenance_v4
    (id,terminal_history_order_id,trading_account_id,user_id,platform,terminal_instance_id,terminal_profile_id,
     broker_server,account_login,connection_id,connection_epoch,ownership_revision,request_id,query_message_id,response_message_id,
     source_revision,source_kind,fact_sha256,provenance_sha256,observed_at_utc,received_at_utc,created_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, value.orderId, value.accountId, value.userId, value.platform, value.terminalInstanceId, value.terminalProfileId,
    value.brokerServer, value.login, value.connectionId, value.connectionEpoch, value.ownershipRevision, value.requestId,
    value.queryMessageId, value.responseMessageId, value.sourceRevision, value.sourceKind, value.factHash, value.provenanceHash,
    new Date(value.observedAt), new Date(value.receivedAt), new Date(value.receivedAt)])
  if (result.affectedRows !== 1) throw new Error('trade_history_provenance_write_unconfirmed')
  return { id, created: true }
}
