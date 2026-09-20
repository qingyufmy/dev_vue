import { readEntryEventCoverage } from './mysql-entry-event-claims.js'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { EntryEventUsageReader } from '../application/entry-event-usage.js'
export function createMysqlEntryEventUsageReader(db: Pick<Pool, 'execute'>): EntryEventUsageReader {
  return { async read(scope) {
    const coverageStartUtc = await readEntryEventCoverage(db)
    if (!scope.eventIds.length) return { coverageStartUtc, items: [] }
    if (scope.eventIds.length > 28) throw Error('entry_event_usage_invalid')
    const [rows] = await db.execute<(RowDataPacket & { event_id: string; state: 'reserved' | 'consumed' })[]>(
      `SELECT event_id,state FROM inference_entry_event_claims_v4 WHERE user_id=? AND trading_account_id=? AND strategy_id=?
        AND active_event_id IN (${scope.eventIds.map(() => '?').join(',')})`,
      [scope.userId, scope.accountId, scope.strategyId, ...scope.eventIds])
    return { coverageStartUtc, items: rows.map(row => ({ eventId: row.event_id, state: row.state })) }
  } }
}
