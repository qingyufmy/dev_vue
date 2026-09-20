import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import { historyTaskRoute } from '../application/history-collection-task.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

/** Resolves immutable completed-task routing; callers still verify complete page inventory. */
export function createMysqlCompletedHistoryRouteReader(connection: Pick<PoolConnection,'execute'>) {
  return { async read(taskId:string,scope:{userId:number;accountId:string}) {
    if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw Error('history_route_task_invalid')
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT route_json,route_sha256 FROM history_collection_tasks_v4
      WHERE id=? AND trading_account_id=? AND status='succeeded' LIMIT 2 FOR SHARE`,[taskId,scope.accountId])
    if (!rows.length) return null
    if (rows.length !== 1) throw Error('history_route_task_corrupt')
    const row = rows[0]!, raw: unknown = typeof row.route_json === 'string' ? JSON.parse(row.route_json) : row.route_json
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('history_route_task_corrupt')
    const route = raw as BridgeGatewayRoute, identity = historyTaskRoute(route)
    if (identity.hash !== row.route_sha256 || canonicalEvidence(raw as Record<string,unknown>).hash !== identity.hash) throw Error('history_route_task_corrupt')
    return route.userId === scope.userId && route.accountId === scope.accountId ? route : null
  } }
}
