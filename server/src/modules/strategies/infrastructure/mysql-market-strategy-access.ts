import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { MarketStrategyAccess } from '../../market/index.js'
export class MysqlMarketStrategyAccess implements MarketStrategyAccess {
  constructor(private readonly pool: Pick<Pool, 'execute'>) {}
  async read(userId: number, strategyId: string, versionId: string) {
    if (!Number.isSafeInteger(userId) || userId < 1 || !/^[1-9][0-9]{0,19}$/.test(strategyId) || !/^[1-9][0-9]{0,19}$/.test(versionId)) return null
    const [rows] = await this.pool.execute<(RowDataPacket & { scope: 'platform' | 'user'; owner_user_id: number | null })[]>(
      `SELECT s.scope,s.owner_user_id FROM strategies s
       INNER JOIN strategy_versions v ON v.strategy_id=s.id AND v.id=s.active_version_id
       INNER JOIN users u ON u.id=? AND u.deletion_status='active' AND u.deleted_at IS NULL
       WHERE s.id=? AND v.id=? AND s.status='active' AND s.deleted_at_utc IS NULL
       AND (s.scope='platform' OR (s.scope='user' AND s.owner_user_id=u.id)) LIMIT 1`, [userId, strategyId, versionId])
    const row = rows[0]
    return row ? { scope: row.scope, ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id) } : null
  }
}
