import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'
import { freezeHistoryCollectionClaim, historyTaskRoute, type HistoryCollectionClaim } from '../application/history-collection-task.js'

interface TaskRow extends RowDataPacket {
  session_timezone: string
  status: string
  lease_token: string | null
  lease_live: number
  route_sha256: string | null
  route_json: string | Record<string, unknown> | null
  start_msc: string
  end_msc: string
}

/** Caller owns a UTC transaction and must authorize this route first.
 * The row lock remains held through fact/sync/completion writes and commit. */
export async function lockHistoryCollectionTask(connection: Pick<PoolConnection, 'execute'>,
  input: HistoryCollectionClaim, route: BridgeGatewayRoute, phase: 'page' | 'prepare' | 'complete') {
  const claim = freezeHistoryCollectionClaim(input), identity = historyTaskRoute(route)
  if (claim.accountId !== identity.value.accountId || claim.routeHash !== identity.hash) throw Error('history_task_claim_mismatch')
  const [rows] = await connection.execute<TaskRow[]>(`SELECT @@session.time_zone session_timezone,status,lease_token,
    (lease_expires_at_utc>UTC_TIMESTAMP(3)) lease_live,route_sha256,route_json,
    CAST(UNIX_TIMESTAMP(range_start_utc)*1000 AS CHAR) start_msc,
    CAST(UNIX_TIMESTAMP(range_end_utc)*1000 AS CHAR) end_msc
    FROM history_collection_tasks_v4 WHERE id=? AND trading_account_id=? FOR UPDATE`, [claim.taskId, claim.accountId])
  const row = rows[0]
  if (rows.length !== 1 || !row || row.session_timezone !== '+00:00' || row.lease_token !== claim.leaseToken || Number(row.lease_live) !== 1
    || (phase === 'page' ? row.status !== 'running' : phase === 'prepare' ? !['running', 'completing'].includes(row.status) : row.status !== 'completing')
    || row.route_sha256 !== claim.routeHash || Number(row.start_msc) !== claim.rangeStartUtcMsc || Number(row.end_msc) !== claim.rangeEndUtcMsc) throw Error('history_task_lease_lost')
  let stored: unknown
  try { stored = typeof row.route_json === 'string' ? JSON.parse(row.route_json) : row.route_json } catch { throw Error('history_task_route_corrupt') }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || canonicalEvidence(stored as Record<string, unknown>).hash !== identity.hash) throw Error('history_task_route_corrupt')
  return claim
}
