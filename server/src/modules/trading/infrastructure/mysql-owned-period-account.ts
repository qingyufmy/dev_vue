import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { OwnedHistoryAccessReader } from '../application/owned-history-access.js'

/** Full historical owner interval bounds, followed by the existing current/historical authorization gate. */
export function createMysqlOwnedPeriodAccount(connection: Pick<PoolConnection,'execute'>, access: OwnedHistoryAccessReader) {
  return { async read(scope: { userId:number;accountId:string;ownershipIntervalId:string }, nowUtcMsc:number) {
    if (!Number.isSafeInteger(nowUtcMsc) || nowUtcMsc <= 0) throw Error('period_account_time_invalid')
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT a.platform,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',hi.started_at_utc) DIV 1000 AS CHAR) start_msc,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',hi.ended_at_utc) DIV 1000 AS CHAR) end_msc
      FROM trading_accounts a JOIN trading_account_ownership_intervals hi ON hi.trading_account_id=a.id
      WHERE a.id=? AND hi.id=? AND hi.user_id=? AND hi.role='owner' AND a.deleted_at_utc IS NULL LIMIT 2 FOR SHARE`,
    [scope.accountId,scope.ownershipIntervalId,scope.userId])
    if (rows.length !== 1 || !['mt4','mt5'].includes(rows[0]!.platform)) return null
    const row = rows[0]!, start = Number(row.start_msc), end = row.end_msc === null ? null : Number(row.end_msc)
    const through = end === null ? nowUtcMsc : Math.min(nowUtcMsc,end-1)
    if (!Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(through) || through < start) return null
    const platform = row.platform as 'mt4' | 'mt5'
    const owned = await access.read({ ...scope,platform,openedAt:new Date(start).toISOString(),closedAt:new Date(through).toISOString() })
    return owned ? { platform,historyStartUtcMsc:start,availableThroughUtcMsc:through,ownershipRevision:owned.currentOwnershipRevision } : null
  } }
}
