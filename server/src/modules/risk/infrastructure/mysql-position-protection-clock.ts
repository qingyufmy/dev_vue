import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { PositionProtectionReviewClock } from '../application/position-protection-review.js'
import { RiskError } from '../domain/risk.js'

export function createMysqlPositionProtectionClock(connection: Pick<PoolConnection, 'execute'>): PositionProtectionReviewClock {
  return { async now() {
    const [rows] = await connection.execute<RowDataPacket[]>("SELECT @@session.time_zone zone,DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') now_utc")
    const row = rows[0]
    if (rows.length !== 1 || !row || !['+00:00','UTC'].includes(String(row.zone))) throw new RiskError('position_protection_utc_required',409)
    if (typeof row.now_utc !== 'string' || !/\.\d{3}000Z$/.test(row.now_utc)) throw new RiskError('position_protection_clock_invalid',409)
    const iso = row.now_utc.replace(/(\.\d{3})000Z$/, '$1Z'), now = new Date(iso)
    if (!Number.isFinite(now.getTime()) || now.toISOString() !== iso) throw new RiskError('position_protection_clock_invalid',409)
    return now
  } }
}
