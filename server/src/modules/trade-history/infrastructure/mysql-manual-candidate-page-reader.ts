import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { ManualCandidatePageReader } from '../application/manual-candidate-page-reader.js'
import { historyTaskRoute } from '../application/history-collection-task.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'
import { createMysqlHistoryTaskCoverageReader } from './mysql-history-task-coverage-reader.js'
import { provenHistoryRecordSql } from './trade-history-ownership-sql.js'

export function createMysqlManualCandidatePageReader(connection: PoolConnection): ManualCandidatePageReader {
  return createPageReader(connection, 'manual')
}

export function createMysqlSystemReviewPageReader(connection: PoolConnection): ManualCandidatePageReader {
  return createPageReader(connection, 'system')
}

function createPageReader(connection: PoolConnection, source: 'manual' | 'system'): ManualCandidatePageReader {
  const coverage = createMysqlHistoryTaskCoverageReader(connection)
  return { async read(taskId, afterRecordId, limit) {
    const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
    if (!id.test(taskId) || (afterRecordId !== null && !id.test(afterRecordId))
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('manual_candidate_page_invalid')
    const [tasks] = await connection.execute<(RowDataPacket & { route_json: unknown; route_sha256: string; account_id: string })[]>(
      `SELECT route_json,route_sha256,CAST(trading_account_id AS CHAR) account_id FROM history_collection_tasks_v4
       WHERE id=? AND status='succeeded' LIMIT 1 FOR SHARE`, [taskId])
    if (!tasks[0]) return { status: 'unresolved', reason: 'task_unavailable' }
    const task = tasks[0]
    let route: BridgeGatewayRoute
    try {
      const raw: unknown = typeof task.route_json === 'string' ? JSON.parse(task.route_json) : task.route_json
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid')
      route = raw as BridgeGatewayRoute
      const identity = historyTaskRoute(route)
      if (identity.hash !== task.route_sha256 || canonicalEvidence(raw as Record<string, unknown>).hash !== identity.hash
        || route.accountId !== task.account_id) throw Error('invalid')
    } catch { throw Error('manual_candidate_task_corrupt') }
    const completed = await coverage.read({ taskId, route })
    if (completed.status !== 'provider_asserted') return completed
    const sqlTime = (value: number) => new Date(value).toISOString().slice(0,23).replace('T',' ')
    const [records] = await connection.execute<(RowDataPacket & { id: string; revision: number })[]>(`SELECT r.id,r.revision
      FROM account_trade_records_v4 r WHERE r.user_id=? AND r.trading_account_id=? AND r.platform=?
        AND r.status='closed' AND ${source === 'manual' ? "r.source_classification='manual' AND r.attribution_status='exact'" : "r.source_classification IN ('unknown','system')"}
        AND r.opened_at_utc>=? AND r.closed_at_utc<=? AND ${provenHistoryRecordSql()}
        AND (? IS NULL OR r.id>?) ORDER BY r.id LIMIT ${limit + 1} FOR SHARE`,
    [route.userId,route.accountId,route.platform,sqlTime(completed.rangeStartUtcMsc),sqlTime(completed.rangeEndUtcMsc),afterRecordId,afterRecordId])
    const page = records.slice(0,limit)
    return { status: 'read', route, asOfUtcMsc: completed.rangeEndUtcMsc,
      records: page.map(row => ({ recordId: row.id, revision: Number(row.revision) })),
      nextRecordId: records.length > limit ? page.at(-1)!.id : null }
  } }
}
