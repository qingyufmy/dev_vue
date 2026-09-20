import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { TerminalFactRouteGuard } from '../../trading/index.js'
import type { HistoryCollectionTasks, HistoryCollectionTaskClaimResult } from '../application/history-collection-tasks.js'
import { freezeHistoryCollectionClaim, historyTaskRoute, type HistoryCollectionClaim } from '../application/history-collection-task.js'
import { restoreHistoryTaskCompletion } from '../application/history-task-completion.js'
import { historyTransaction } from './history-transaction.js'
import { lockHistoryCollectionTask } from './mysql-history-task-lock.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

interface ClaimRow extends RowDataPacket {
  session_timezone: string; status: string; attempts: number; lease_live: number | null; retry_at: string | null
  start_msc: string; end_msc: string; route_sha256: string | null; route_json: string | Record<string, unknown> | null
  completion_json: string | Record<string, unknown> | null; completion_sha256: string | null
}

export class MysqlHistoryCollectionTasks implements HistoryCollectionTasks {
  constructor(private readonly pool: Pool, private readonly guard: (connection: PoolConnection) => TerminalFactRouteGuard) {}

  async claim(taskId: string, route: BridgeGatewayRoute): Promise<HistoryCollectionTaskClaimResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw Error('history_task_id_invalid')
    route = structuredClone(route)
    const identity = historyTaskRoute(route)
    return historyTransaction(this.pool, async connection => {
      await this.guard(connection).assert(route)
      const [rows] = await connection.execute<ClaimRow[]>(`SELECT @@session.time_zone session_timezone,status,attempts,
        (lease_expires_at_utc>UTC_TIMESTAMP(3)) lease_live,DATE_FORMAT(lease_expires_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') retry_at,
        CAST(UNIX_TIMESTAMP(range_start_utc)*1000 AS CHAR) start_msc,CAST(UNIX_TIMESTAMP(range_end_utc)*1000 AS CHAR) end_msc,
        route_json,route_sha256,completion_json,completion_sha256
        FROM history_collection_tasks_v4 WHERE id=? AND trading_account_id=? FOR UPDATE`, [taskId, route.accountId])
      const row = rows[0]
      if (rows.length !== 1 || !row) throw Error('history_task_not_found')
      if (row.session_timezone !== '+00:00' || !Number.isSafeInteger(Number(row.attempts)) || Number(row.attempts) < 0) throw Error('history_task_state_invalid')
      if (row.status === 'succeeded' || row.status === 'failed') return { state: 'terminal', status: row.status }
      if (!['pending', 'running', 'completing'].includes(row.status)) throw Error('history_task_state_invalid')
      if (row.status !== 'pending' && Number(row.lease_live) === 1) {
        if (!row.retry_at || !Number.isFinite(Date.parse(row.retry_at))) throw Error('history_task_state_invalid')
        return { state: 'busy', retryAt: new Date(row.retry_at).toISOString() }
      }
      if (Number(row.attempts) >= 5) {
        const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4 SET status='failed',
          lease_token=NULL,lease_expires_at_utc=NULL,error_code='history_task_attempts_exhausted',
          completed_at_utc=UTC_TIMESTAMP(3),updated_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND trading_account_id=?`, [taskId, route.accountId])
        if (result.affectedRows !== 1) throw Error('history_task_claim_unconfirmed')
        return { state: 'terminal', status: 'failed' }
      }
      const claim = freezeHistoryCollectionClaim({ taskId, accountId: route.accountId, leaseToken: randomUUID(), routeHash: identity.hash,
        rangeStartUtcMsc: Number(row.start_msc), rangeEndUtcMsc: Number(row.end_msc) })
      let previousRoute: BridgeGatewayRoute | undefined
      if (row.route_json !== null || row.route_sha256 !== null) {
        try {
          previousRoute = (typeof row.route_json === 'string' ? JSON.parse(row.route_json) : row.route_json) as BridgeGatewayRoute
          const previous = historyTaskRoute(previousRoute)
          if (previous.hash !== row.route_sha256 || canonicalEvidence(previousRoute as unknown as Record<string, unknown>).hash !== row.route_sha256
            || previous.value.accountId !== claim.accountId) throw Error('invalid')
        } catch { throw Error('history_task_route_corrupt') }
      } else if (row.status !== 'pending') throw Error('history_task_route_corrupt')
      let completion: ReturnType<typeof restoreHistoryTaskCompletion> | null = null
      if (row.status === 'completing') {
        const previous = restoreHistoryTaskCompletion({ ...claim, routeHash: row.route_sha256! }, previousRoute!, row.completion_json, row.completion_sha256)
        if (row.route_sha256 === identity.hash) completion = previous
      } else if (row.completion_json !== null || row.completion_sha256 !== null) throw Error('history_task_completion_corrupt')
      const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4 SET status=?,attempts=attempts+1,
        lease_token=?,lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 90 SECOND,route_json=?,route_sha256=?,
        completion_json=?,completion_sha256=?,error_code=NULL,updated_at_utc=UTC_TIMESTAMP(3)
        WHERE id=? AND trading_account_id=?`, [completion ? 'completing' : 'running', claim.leaseToken, identity.json, identity.hash,
        completion?.json ?? null, completion?.hash ?? null, taskId, route.accountId])
      if (result.affectedRows !== 1) throw Error('history_task_claim_unconfirmed')
      return completion ? { state: 'completing', claim, completion } : { state: 'collecting', claim }
    })
  }

  async renew(input: HistoryCollectionClaim, route: BridgeGatewayRoute): Promise<void> {
    const claim = freezeHistoryCollectionClaim(input), frozenRoute = structuredClone(route)
    await historyTransaction(this.pool, async connection => {
      await this.guard(connection).assert(frozenRoute)
      await lockHistoryCollectionTask(connection, claim, frozenRoute, 'prepare')
      const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4
        SET lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 90 SECOND,updated_at_utc=UTC_TIMESTAMP(3)
        WHERE id=? AND trading_account_id=? AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`, [claim.taskId, claim.accountId, claim.leaseToken])
      if (result.affectedRows !== 1) throw Error('history_task_lease_lost')
    })
  }
}
