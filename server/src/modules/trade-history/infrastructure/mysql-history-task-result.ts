import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryCollectionClaim } from '../application/history-collection-task.js'
import { restoreHistoryTaskCompletion, type historyTaskCompletion } from '../application/history-task-completion.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

type Connection = Pick<PoolConnection, 'execute'>

/** Caller holds the route-authorized task row lock until the business transaction ends. */
export async function renewHistoryTaskLease(connection: Connection, claim: HistoryCollectionClaim) {
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4
    SET lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 90 SECOND,updated_at_utc=UTC_TIMESTAMP(3)
    WHERE id=? AND trading_account_id=? AND status='running' AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`,
    [claim.taskId, claim.accountId, claim.leaseToken])
  if (result.affectedRows !== 1) throw Error('history_task_lease_lost')
}

export async function finishHistoryTask(connection: Connection, claim: HistoryCollectionClaim, receiptId: string) {
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4 SET status='succeeded',result_receipt_id=?,
    lease_token=NULL,lease_expires_at_utc=NULL,error_code=NULL,completed_at_utc=UTC_TIMESTAMP(3),updated_at_utc=UTC_TIMESTAMP(3)
    WHERE id=? AND trading_account_id=? AND status='completing' AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`,
    [receiptId, claim.taskId, claim.accountId, claim.leaseToken])
  if (result.affectedRows !== 1) throw Error('history_task_lease_lost')
  await connection.execute(`INSERT INTO outbox_events
    (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'trade_history_task',?,'trade.history.task.completed',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [randomUUID(), claim.taskId, JSON.stringify({ task_id: claim.taskId })])
}

export async function failHistoryTask(connection: Connection, claim: HistoryCollectionClaim, code: string) {
  if (!/^[a-z][a-z0-9_]{2,127}$/.test(code)) throw Error('history_task_error_invalid')
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4 SET status='failed',
    lease_token=NULL,lease_expires_at_utc=NULL,error_code=?,completed_at_utc=UTC_TIMESTAMP(3),updated_at_utc=UTC_TIMESTAMP(3)
    WHERE id=? AND trading_account_id=? AND status IN ('running','completing') AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`,
    [code, claim.taskId, claim.accountId, claim.leaseToken])
  if (result.affectedRows !== 1) throw Error('history_task_lease_lost')
}

/** A succeeded task needs evidence confirmation, not a still-live lease. Caller authorizes route first. */
export async function confirmCompletedHistoryTask(connection: Connection, claim: HistoryCollectionClaim, route: BridgeGatewayRoute,
  expected: ReturnType<typeof historyTaskCompletion>) {
  const [rows] = await connection.execute<(RowDataPacket & { status: string; completion_json: unknown; completion_sha256: string; result_receipt_id: string | null })[]>(
    'SELECT status,completion_json,completion_sha256,result_receipt_id FROM history_collection_tasks_v4 WHERE id=? AND trading_account_id=? FOR UPDATE', [claim.taskId, claim.accountId])
  if (rows.length !== 1) throw Error('history_task_lease_lost')
  const row = rows[0]!
  if (row.status !== 'succeeded') return false
  const completion = restoreHistoryTaskCompletion(claim, route, row.completion_json, row.completion_sha256)
  if (completion.hash !== expected.hash || !row.result_receipt_id) throw Error('history_task_completion_conflict')
  const [receipts] = await connection.execute<(RowDataPacket & { evidence_json: unknown; evidence_sha256: string })[]>(
    'SELECT evidence_json,evidence_sha256 FROM terminal_history_collection_receipts_v4 WHERE id=? AND trading_account_id=? LIMIT 2 FOR SHARE', [row.result_receipt_id, claim.accountId])
  try {
    if (receipts.length !== 1 || receipts[0]!.evidence_sha256 !== completion.value.receiptHash) throw Error('invalid')
    const raw: unknown = typeof receipts[0]!.evidence_json === 'string' ? JSON.parse(receipts[0]!.evidence_json as string) : receipts[0]!.evidence_json
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || canonicalEvidence(raw as Record<string, unknown>).hash !== completion.value.receiptHash) throw Error('invalid')
  } catch { throw Error('history_task_result_corrupt') }
  return true
}
