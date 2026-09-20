import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountInventorySummaryReader } from '../../trading/index.js'
import type { HistoryRangeRequest, HistoryRangeRequester } from '../application/history-range-requester.js'
import { freezeHistoryCollectionRequest } from '../application/history-collection-task.js'
import { registerHistoryCollectionTask } from './mysql-history-task-registration.js'

/** Explicit full-range requests share ordinary history task fencing, recovery and outbox delivery. */
export function createMysqlHistoryRangeRequester(connection: Pick<PoolConnection,'execute'>,
  accounts: Pick<AccountInventorySummaryReader,'lockAccount'>,
  authorize: (input: HistoryRangeRequest) => Promise<{ ownershipRevision: string } | null>): HistoryRangeRequester {
  return { async ensure(input, now) {
    const scope = structuredClone(input), time = new Date(now.getTime())
    freezeHistoryCollectionRequest(scope)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !['mt4','mt5'].includes(scope.platform)
      || !scope.ownershipIntervalId || !Number.isFinite(time.getTime()) || scope.rangeEndUtcMsc > time.getTime()) throw Error('history_range_scope_invalid')
    // Match scheduler lock order: account before authorization and task rows.
    await accounts.lockAccount(scope.accountId)
    const owned = await authorize(scope)
    if (!owned) return { status: 'unavailable', reason: 'history_range_ownership_unavailable' }
    const registered = await registerHistoryCollectionTask(connection, accounts, scope, time)
    if (registered.taskId !== scope.taskId) return { status: 'waiting', taskId: registered.taskId, reason: 'history_account_busy' }
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT status,route_json FROM history_collection_tasks_v4
      WHERE id=? AND trading_account_id=? FOR SHARE`, [scope.taskId,scope.accountId])
    if (rows.length !== 1) throw Error('history_range_task_missing')
    const row = rows[0]!
    if (row.status === 'failed') return { status: 'failed', taskId: scope.taskId }
    if (row.status !== 'succeeded') return { status: 'waiting', taskId: scope.taskId, reason: 'history_collection_pending' }
    const route: unknown = typeof row.route_json === 'string' ? JSON.parse(row.route_json) : row.route_json
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw Error('history_range_route_invalid')
    const identity = route as Record<string,unknown>
    if (identity.userId !== scope.userId || identity.accountId !== scope.accountId || identity.platform !== scope.platform
      || identity.ownershipRevision !== owned.ownershipRevision) return { status: 'unavailable', reason: 'history_range_owner_changed' }
    // The collector separately checks immutable completion/receipt hashes and every page membership.
    return { status: 'completed', taskId: scope.taskId }
  } }
}
