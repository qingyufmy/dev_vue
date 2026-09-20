import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { AccountInventorySummaryReader } from '../../trading/index.js'
import { freezeHistoryCollectionRequest, type HistoryCollectionRequest } from '../application/history-collection-task.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

interface TaskRow extends RowDataPacket { id: string; start_msc: string; end_msc: string }

/** Caller owns the UTC transaction and account eligibility; accounts uses this same connection. */
export async function registerHistoryCollectionTask(connection: Pick<PoolConnection, 'execute'>,
  accounts: Pick<AccountInventorySummaryReader, 'lockAccount'>, input: HistoryCollectionRequest, now: Date) {
  const request = freezeHistoryCollectionRequest(input), received = new Date(now.getTime())
  if (!Number.isFinite(received.getTime()) || received.getTime() < request.rangeEndUtcMsc) throw Error('history_task_request_invalid')
  await accounts.lockAccount(request.accountId)
  const [[session]] = await connection.execute<RowDataPacket[]>('SELECT @@session.time_zone timezone')
  if (session?.timezone !== '+00:00') throw Error('history_task_session_invalid')
  const [same] = await connection.execute<TaskRow[]>(`SELECT id,CAST(UNIX_TIMESTAMP(range_start_utc)*1000 AS CHAR) start_msc,
    CAST(UNIX_TIMESTAMP(range_end_utc)*1000 AS CHAR) end_msc FROM history_collection_tasks_v4 WHERE id=? AND trading_account_id=? FOR UPDATE`,
    [request.taskId, request.accountId])
  if (same.length > 1) throw Error('history_task_registration_conflict')
  if (same[0]) {
    if (Number(same[0].start_msc) !== request.rangeStartUtcMsc || Number(same[0].end_msc) !== request.rangeEndUtcMsc) throw Error('history_task_registration_conflict')
    await verifyRequestedEvent(connection, same[0].id)
    return { taskId: same[0].id, created: false }
  }
  const [active] = await connection.execute<(RowDataPacket & { id: string })[]>(
    'SELECT id FROM history_collection_tasks_v4 WHERE active_account_id=? FOR UPDATE', [request.accountId])
  if (active.length > 1) throw Error('history_task_registration_conflict')
  if (active[0]) {
    await verifyRequestedEvent(connection, active[0].id)
    return { taskId: active[0].id, created: false }
  }
  const [task] = await connection.execute<ResultSetHeader>(`INSERT INTO history_collection_tasks_v4
    (id,trading_account_id,range_start_utc,range_end_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?)`,
    [request.taskId, request.accountId, new Date(request.rangeStartUtcMsc), new Date(request.rangeEndUtcMsc), received, received])
  if (task.affectedRows !== 1) throw Error('history_task_registration_unconfirmed')
  const [event] = await connection.execute<ResultSetHeader>(`INSERT INTO outbox_events
    (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
    VALUES (?,'trade_history_task',?,'trade.history.task.requested',?,'pending',0,?,?)`,
    [request.taskId, request.taskId, JSON.stringify({ task_id: request.taskId }), received, received])
  if (event.affectedRows !== 1) throw Error('history_task_registration_unconfirmed')
  return { taskId: request.taskId, created: true }
}

async function verifyRequestedEvent(connection: Pick<PoolConnection, 'execute'>, taskId: string) {
  const [events] = await connection.execute<(RowDataPacket & { aggregate_type: string; aggregate_id: string; event_type: string; payload_json: string | Record<string, unknown> })[]>(
    'SELECT aggregate_type,aggregate_id,event_type,payload_json FROM outbox_events WHERE event_id=? LIMIT 2 FOR SHARE', [taskId])
  const event = events[0]
  if (events.length !== 1 || !event || event.aggregate_type !== 'trade_history_task' || event.aggregate_id !== taskId
    || event.event_type !== 'trade.history.task.requested') throw Error('history_task_registration_incomplete')
  try {
    const value: unknown = typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalEvidence(value as Record<string, unknown>).hash !== canonicalEvidence({ task_id: taskId }).hash) throw Error('invalid')
  } catch { throw Error('history_task_registration_incomplete') }
}
