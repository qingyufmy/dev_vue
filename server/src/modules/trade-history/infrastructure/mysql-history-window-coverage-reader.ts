import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { HistoryWindowCoverageReader } from '../application/history-window-coverage-reader.js'
import type { HistoryTaskCoverageReader } from '../application/history-task-coverage-reader.js'
import { historyTaskRoute } from '../application/history-collection-task.js'
import { createMysqlHistoryTaskCoverageReader } from './mysql-history-task-coverage-reader.js'

/** Caller owns one authorized consistent snapshot for candidate selection and evidence reconstruction. */
export function createMysqlHistoryWindowCoverageReader(connection: Pick<PoolConnection, 'execute'>,
  coverage: HistoryTaskCoverageReader = createMysqlHistoryTaskCoverageReader(connection)): HistoryWindowCoverageReader {
  return { async read(input) {
    const scope = structuredClone(input), identity = historyTaskRoute(scope.route)
    const validTime = (value: number) => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime())
    if (!validTime(scope.rangeStartUtcMsc) || !validTime(scope.rangeEndUtcMsc) || scope.rangeStartUtcMsc >= scope.rangeEndUtcMsc) {
      throw Error('history_window_coverage_scope_invalid')
    }
    const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM history_collection_tasks_v4
      WHERE trading_account_id=? AND status='succeeded' AND route_sha256=? AND range_start_utc<=? AND range_end_utc>=?
      ORDER BY completed_at_utc DESC,id DESC LIMIT 101`,[scope.route.accountId,identity.hash,new Date(scope.rangeStartUtcMsc),new Date(scope.rangeEndUtcMsc)])
    if (rows.length > 100) throw Error('history_window_coverage_limit_exceeded')
    const seen = new Set<string>()
    for (const row of rows) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) || seen.has(row.id)) throw Error('history_window_coverage_candidate_invalid')
      seen.add(row.id)
    }
    for (const row of rows) {
      const result = await coverage.read({taskId:row.id,route:scope.route})
      if (result.status === 'unresolved') {
        if (result.reason === 'coverage_missing') continue
        throw Error('history_window_coverage_candidate_invalid')
      }
      if (result.taskId !== row.id || result.rangeStartUtcMsc > scope.rangeStartUtcMsc || result.rangeEndUtcMsc < scope.rangeEndUtcMsc) {
        throw Error('history_window_coverage_candidate_invalid')
      }
      return structuredClone(result)
    }
    return {status:'unresolved',reason:rows.length ? 'coverage_missing' : 'task_unavailable'}
  } }
}
