import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { HistoryTaskCoverageReader } from '../application/history-task-coverage-reader.js'
import { historyTaskRoute } from '../application/history-collection-task.js'
import { historyTaskCompletionEvidence } from '../application/history-task-completion.js'
import type { HistoryResourcePageChain } from '../application/trade-history-collector-ports.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

interface Row extends RowDataPacket {
  status: string; route_json: unknown; route_sha256: string; completion_json: unknown; completion_sha256: string;
  result_receipt_id: string | null; start_msc: string; end_msc: string;
  receipt_id: string | null; receipt_json: unknown; receipt_sha256: string | null;
  receipt_account: string | null; receipt_user: number | null; receipt_platform: string | null;
  receipt_terminal: string | null; receipt_epoch: string | null; receipt_ownership: string | null;
  receipt_start: string | null; receipt_end: string | null
}
function object(input: unknown): Record<string, unknown> {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : structuredClone(input)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid')
  return value as Record<string, unknown>
}
export function createMysqlHistoryTaskCoverageReader(connection: Pick<PoolConnection, 'execute'>): HistoryTaskCoverageReader {
  return { async read(input) {
    const scope = structuredClone(input), identity = historyTaskRoute(scope.route)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope.taskId)) throw Error('history_task_coverage_scope_invalid')
    const [rows] = await connection.execute<Row[]>(`SELECT t.status,t.route_json,t.route_sha256,t.completion_json,t.completion_sha256,t.result_receipt_id,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',t.range_start_utc) DIV 1000 AS CHAR) start_msc,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',t.range_end_utc) DIV 1000 AS CHAR) end_msc,
      r.id receipt_id,r.evidence_json receipt_json,r.evidence_sha256 receipt_sha256,
      CAST(r.trading_account_id AS CHAR) receipt_account,r.user_id receipt_user,r.platform receipt_platform,
      r.terminal_instance_id receipt_terminal,CAST(r.connection_epoch AS CHAR) receipt_epoch,CAST(r.ownership_revision AS CHAR) receipt_ownership,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.range_start_utc) DIV 1000 AS CHAR) receipt_start,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.range_end_utc) DIV 1000 AS CHAR) receipt_end
      FROM history_collection_tasks_v4 t LEFT JOIN terminal_history_collection_receipts_v4 r ON r.id=t.result_receipt_id
      WHERE t.id=? AND t.trading_account_id=? LIMIT 2`,[scope.taskId,scope.route.accountId])
    if (rows.length === 0) return { status:'unresolved', reason:'task_unavailable' }
    if (rows.length !== 1) throw Error('history_task_coverage_corrupt')
    const row = rows[0]!
    if (row.status !== 'succeeded') return { status:'unresolved', reason:'task_unavailable' }
    if (row.route_sha256 !== identity.hash) return { status:'unresolved', reason:'route_mismatch' }
    try {
      if (canonicalEvidence(object(row.route_json)).hash !== identity.hash) throw Error('invalid')
      const raw = object(row.completion_json)
      if (!Array.isArray(raw.pageChains)) throw Error('invalid')
      const rebuilt = historyTaskCompletionEvidence({ taskId:scope.taskId,accountId:scope.route.accountId,
        rangeStartUtcMsc:Number(row.start_msc),rangeEndUtcMsc:Number(row.end_msc) },identity.hash,scope.route,raw.pageChains as HistoryResourcePageChain[])
      if (rebuilt.hash !== row.completion_sha256 || canonicalEvidence(raw).hash !== rebuilt.hash
        || !row.receipt_id || row.receipt_id !== row.result_receipt_id
        || row.receipt_sha256 !== rebuilt.value.receiptHash || canonicalEvidence(object(row.receipt_json)).hash !== rebuilt.value.receiptHash
        || row.receipt_account !== scope.route.accountId || Number(row.receipt_user) !== scope.route.userId
        || row.receipt_platform !== scope.route.platform || row.receipt_terminal !== scope.route.terminalInstanceId
        || row.receipt_epoch !== String(scope.route.connectionEpoch) || row.receipt_ownership !== scope.route.ownershipRevision
        || Number(row.receipt_start) !== rebuilt.value.rangeStartUtcMsc || Number(row.receipt_end) !== rebuilt.value.rangeEndUtcMsc) throw Error('invalid')
      if (rebuilt.value.pageChains.some(chain => !chain.historyCoverage)) return { status:'unresolved', reason:'coverage_missing' }
      return { status:'provider_asserted',taskId:scope.taskId,receiptId:row.receipt_id,completionHash:rebuilt.hash,
        rangeStartUtcMsc:rebuilt.value.rangeStartUtcMsc,rangeEndUtcMsc:rebuilt.value.rangeEndUtcMsc,resources:rebuilt.value.pageChains }
    } catch { throw Error('history_task_coverage_corrupt') }
  } }
}
