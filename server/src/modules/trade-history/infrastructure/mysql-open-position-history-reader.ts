import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ReadOpenPositionHistory, type OpenPositionHistoryReader } from '../application/open-position-history-reader.js'
import { createMysqlOpenPositionLifecycleReader } from './mysql-open-position-lifecycle-reader.js'
import { createMysqlHistoryWindowCoverageReader } from './mysql-history-window-coverage-reader.js'
import { createMysqlHistoryTaskDealSourceReader } from './mysql-history-task-deal-source-reader.js'

export function createMysqlOpenPositionHistoryReader(connection:Pick<PoolConnection,'execute'>):OpenPositionHistoryReader {
  return new ReadOpenPositionHistory(createMysqlOpenPositionLifecycleReader(connection),{async read(scope){
    const [rows]=await connection.execute<(RowDataPacket & {start_msc:string|null})[]>(`SELECT
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',MIN(occurred_at_utc)) DIV 1000 AS CHAR) start_msc
      FROM terminal_history_deals_v4 WHERE trading_account_id=? AND platform='mt5' AND position_id=? AND occurred_at_utc<=?`,
    [scope.accountId,scope.positionIdentifier,new Date(scope.observedAtUtcMsc)])
    return rows[0]?.start_msc===null || rows[0]?.start_msc===undefined ? null : Number(rows[0].start_msc)
  }},createMysqlHistoryWindowCoverageReader(connection),createMysqlHistoryTaskDealSourceReader(connection))
}
