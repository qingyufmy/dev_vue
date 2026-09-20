import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'
import type { historyCollectionReceipt } from '../application/history-collection-receipt.js'

/** Caller holds route authorization and the account sync lock in the completion transaction. */
export async function persistHistoryCollectionReceipt(connection: Pick<PoolConnection, 'execute'>,
  receipt: ReturnType<typeof historyCollectionReceipt>, now: Date, allowCreate = true) {
  const value = structuredClone(receipt), received = new Date(now.getTime())
  const [rows] = await connection.execute<(RowDataPacket & { id: string; evidence_json: string | Record<string, unknown> })[]>(
    `SELECT id,evidence_json FROM terminal_history_collection_receipts_v4 WHERE trading_account_id=? AND evidence_sha256=? LIMIT 2 FOR UPDATE`,
    [value.evidence.accountId, value.hash])
  if (rows.length > 1) throw Error('trade_history_collection_receipt_conflict')
  if (rows.length === 1) {
    const raw = rows[0]!.evidence_json
    if (canonicalEvidence(typeof raw === 'string' ? JSON.parse(raw) : raw).hash !== value.hash) throw Error('trade_history_collection_receipt_conflict')
    return { id: rows[0]!.id, created: false }
  }
  if (!allowCreate) throw Error('trade_history_sync_not_active')
  const id = randomUUID(), e = value.evidence
  const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO terminal_history_collection_receipts_v4
    (id,trading_account_id,user_id,platform,terminal_instance_id,connection_epoch,ownership_revision,range_start_utc,range_end_utc,evidence_sha256,evidence_json,created_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, e.accountId, e.userId, e.platform, e.terminalInstanceId, e.connectionEpoch,
    e.ownershipRevision, new Date(e.rangeStartUtcMsc), new Date(e.rangeEndUtcMsc), value.hash, value.json, received])
  if (result.affectedRows !== 1) throw Error('trade_history_collection_receipt_write_unconfirmed')
  return { id, created: true }
}
