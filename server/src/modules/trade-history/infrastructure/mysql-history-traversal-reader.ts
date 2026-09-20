import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { HistoryTraversalReader, HistoryTraversalScope } from '../application/history-traversal-reader.js'
import { historyCollectionReceipt } from '../application/history-collection-receipt.js'
import { canonicalEvidence } from '../domain/terminal-history-projection.js'

type Receipt = ReturnType<typeof historyCollectionReceipt>['evidence']
type Row = RowDataPacket & { id: string; evidence_json: string | Receipt; evidence_sha256: string; start_msc: string; end_msc: string }

export function createMysqlHistoryTraversalReader(connection: Pick<PoolConnection, 'execute'>): HistoryTraversalReader {
  return { async read(input: HistoryTraversalScope) {
    const scope = structuredClone(input), route = scope.route
    if (!Number.isSafeInteger(scope.rangeStartUtcMsc) || scope.rangeStartUtcMsc < 1
      || !Number.isSafeInteger(scope.rangeEndUtcMsc) || scope.rangeEndUtcMsc <= scope.rangeStartUtcMsc
      || !route.ownershipRevision) throw Error('history_traversal_scope_invalid')
    // Reuse the receipt's exact route/window validation without constructing fake persisted evidence.
    const resource = route.platform === 'mt5' ? ['history.orders', 'history.deals'] as const : ['history.trades'] as const
    historyCollectionReceipt(route, scope.rangeEndUtcMsc, resource.map(resource => ({ resource,
      rangeStartUtcMsc: scope.rangeStartUtcMsc, rangeEndUtcMsc: scope.rangeEndUtcMsc,
      source: 'terminal', sourceRevision: 'scope-validation', pageCount: 1, itemCount: 0, pageChainHash: '0'.repeat(64) })))
    const [rows] = await connection.execute<Row[]>(`SELECT id,evidence_json,evidence_sha256,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',range_start_utc) DIV 1000 AS CHAR) start_msc,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',range_end_utc) DIV 1000 AS CHAR) end_msc
      FROM terminal_history_collection_receipts_v4
      WHERE trading_account_id=? AND user_id=? AND platform=? AND terminal_instance_id=?
        AND connection_epoch=? AND ownership_revision=? AND range_start_utc<=? AND range_end_utc>=?
      ORDER BY range_start_utc,range_end_utc,id LIMIT 10001`,
    [route.accountId,route.userId,route.platform,route.terminalInstanceId,route.connectionEpoch,route.ownershipRevision,
      new Date(scope.rangeEndUtcMsc),new Date(scope.rangeStartUtcMsc)])
    if (rows.length > 10000) throw Error('history_traversal_limit_exceeded')
    const intervals: Array<{ id: string; start: number; end: number }> = []
    for (const row of rows) {
      try {
        const raw: Receipt = typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : structuredClone(row.evidence_json)
        if (!raw || canonicalEvidence(raw).hash !== row.evidence_sha256 || raw.version !== 1
          || raw.rangeStartUtcMsc !== Number(row.start_msc) || raw.rangeEndUtcMsc !== Number(row.end_msc)) throw Error('invalid')
        const rebuilt = historyCollectionReceipt(route, raw.rangeEndUtcMsc, raw.resources.map(r => ({ ...r,
          rangeStartUtcMsc: raw.rangeStartUtcMsc, rangeEndUtcMsc: raw.rangeEndUtcMsc })))
        // Includes broker/login/profile/connection and ownership identity, not only SQL filters.
        if (rebuilt.hash !== row.evidence_sha256 || !/^[0-9a-f-]{36}$/.test(row.id)) throw Error('invalid')
        if (raw.resources.every(r => r.source === 'terminal')) intervals.push({ id: row.id, start: raw.rangeStartUtcMsc, end: raw.rangeEndUtcMsc })
      } catch { throw Error('history_traversal_receipt_corrupt') }
    }
    intervals.sort((a,b) => a.start-b.start || b.end-a.end || a.id.localeCompare(b.id))
    let through = scope.rangeStartUtcMsc
    const receiptIds: string[] = []
    for (const item of intervals) {
      if (item.start > through) break
      if (item.end <= through) continue
      receiptIds.push(item.id); through = item.end
      if (through >= scope.rangeEndUtcMsc) return { status: 'traversed', receiptIds, completeHistoryProven: false }
    }
    return { status: 'unresolved', reason: 'traversal_gap' }
  } }
}
