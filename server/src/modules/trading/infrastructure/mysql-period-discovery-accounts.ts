import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

/** Discovery only. Registration and execution separately revalidate ownership and calibration evidence. */
export function createMysqlPeriodDiscoveryAccounts(connection: Pick<PoolConnection,'execute'>) {
  return { async list(afterAccountId:string|null,limit:number) {
    if ((afterAccountId !== null && !/^[1-9]\d{0,19}$/.test(afterAccountId)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('period_discovery_scope_invalid')
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT CAST(a.id AS CHAR) account_id,own.user_id,own.interval_id,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',MIN(c.observed_at_utc)) DIV 1000 AS CHAR) first_clock_msc,
      CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 AS CHAR) now_msc
      FROM trading_accounts a JOIN trading_account_ownerships own ON own.trading_account_id=a.id
        AND own.role='owner' AND own.revoked_at_utc IS NULL AND own.revision=a.ownership_revision
      JOIN terminal_clock_observations_v4 c ON c.trading_account_id=a.id AND c.user_id=own.user_id
        AND c.ownership_interval_id=own.interval_id AND c.reported_status='calibrated' AND c.connection_id IS NOT NULL
      WHERE a.deleted_at_utc IS NULL AND a.platform='mt5' AND (? IS NULL OR a.id>?)
      GROUP BY a.id,own.user_id,own.interval_id ORDER BY a.id LIMIT ?`,[afterAccountId,afterAccountId,limit])
    return rows.map(row=>({userId:Number(row.user_id),accountId:String(row.account_id),ownershipIntervalId:String(row.interval_id),
      firstClockUtcMsc:Number(row.first_clock_msc),nowUtcMsc:Number(row.now_msc)}))
  } }
}
