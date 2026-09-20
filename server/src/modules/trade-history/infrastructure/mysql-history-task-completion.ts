import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { HistoryResourcePageChain } from '../application/trade-history-collector-ports.js'
import { freezeHistoryCollectionClaim, type HistoryCollectionClaim } from '../application/history-collection-task.js'
import { historyTaskCompletion, restoreHistoryTaskCompletion } from '../application/history-task-completion.js'
import { lockHistoryCollectionTask } from './mysql-history-task-lock.js'

interface CompletionRow extends RowDataPacket { completion_json: string | Record<string, unknown> | null; completion_sha256: string | null }
async function readCompletion(connection: Pick<PoolConnection, 'execute'>, claim: HistoryCollectionClaim) {
  const [rows] = await connection.execute<CompletionRow[]>(`SELECT completion_json,completion_sha256 FROM history_collection_tasks_v4
    WHERE id=? AND trading_account_id=? FOR UPDATE`, [claim.taskId, claim.accountId])
  if (rows.length !== 1) throw Error('history_task_lease_lost')
  return rows[0]!
}

/** Caller authorizes the route and owns the transaction. No independent commit. */
export async function prepareHistoryTaskCompletion(connection: Pick<PoolConnection, 'execute'>,
  input: HistoryCollectionClaim, route: BridgeGatewayRoute, chains: readonly HistoryResourcePageChain[]) {
  const claim = freezeHistoryCollectionClaim(input), frozenRoute = structuredClone(route)
  const completion = historyTaskCompletion(claim, frozenRoute, chains)
  await lockHistoryCollectionTask(connection, claim, frozenRoute, 'prepare')
  const stored = await readCompletion(connection, claim)
  if (stored.completion_json !== null || stored.completion_sha256 !== null) {
    const previous = restoreHistoryTaskCompletion(claim, frozenRoute, stored.completion_json, stored.completion_sha256)
    if (previous.hash !== completion.hash) throw Error('history_task_completion_conflict')
    return previous
  }
  const [result] = await connection.execute<ResultSetHeader>(`UPDATE history_collection_tasks_v4 SET status='completing',
    completion_json=?,completion_sha256=?,updated_at_utc=UTC_TIMESTAMP(3),lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 90 SECOND
    WHERE id=? AND trading_account_id=? AND status='running' AND lease_token=? AND lease_expires_at_utc>UTC_TIMESTAMP(3)`,
    [completion.json, completion.hash, claim.taskId, claim.accountId, claim.leaseToken])
  if (result.affectedRows !== 1) throw Error('history_task_lease_lost')
  return completion
}

export async function loadHistoryTaskCompletion(connection: Pick<PoolConnection, 'execute'>, input: HistoryCollectionClaim, route: BridgeGatewayRoute) {
  const claim = freezeHistoryCollectionClaim(input), frozenRoute = structuredClone(route)
  await lockHistoryCollectionTask(connection, claim, frozenRoute, 'complete')
  const row = await readCompletion(connection, claim)
  return restoreHistoryTaskCompletion(claim, frozenRoute, row.completion_json, row.completion_sha256)
}
